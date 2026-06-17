import { describe, expect, it } from 'vitest';
import { buildMemoryModel, isCounterEvent } from '../src/memory.ts';
import { ProfileCollector } from '../src/profile.ts';
import type { TraceEvent } from '../src/trace-events.ts';

/** Per-sample counter values; omitted counters default to a flat baseline. */
interface Vals {
  heap?: number;
  listeners?: number;
  nodes?: number;
  documents?: number;
}

/**
 * A synthetic `UpdateCounters` stream: `N` samples `dtMs` apart, with each
 * counter's value produced from the sample index and elapsed seconds. Mirrors
 * the real DevTools events (instant, `disabled-by-default-devtools.timeline`).
 */
function counters(
  shape: (i: number, tSec: number) => Vals,
  opts: { n?: number; dtMs?: number; startUs?: number; pid?: number; tid?: number } = {},
): TraceEvent[] {
  const { n = 200, dtMs = 50, startUs = 1_000_000, pid = 1, tid = 1 } = opts;
  const out: TraceEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ts = startUs + i * dtMs * 1000;
    const v = shape(i, (i * dtMs) / 1000);
    out.push({
      name: 'UpdateCounters',
      ph: 'I',
      s: 't',
      ts,
      pid,
      tid,
      cat: 'disabled-by-default-devtools.timeline',
      args: {
        data: {
          jsHeapSizeUsed: v.heap ?? 50_000_000,
          jsEventListeners: v.listeners ?? 100,
          nodes: v.nodes ?? 500,
          documents: v.documents ?? 1,
        },
      },
    });
  }
  return out;
}

/** A GC sawtooth: a per-bucket floor with a fast allocate→collect ripple on top. */
const sawtooth = (floorBytes: number, i: number) => floorBytes + (i % 5) * 2_000_000;

/** A profile whose only JS leaf (allocHot) runs across the whole window. */
function profileEvents(pid = 1): TraceEvent[] {
  const PROF_CAT = 'disabled-by-default-v8.cpu_profiler';
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', codeType: 'other' } },
    {
      id: 2,
      parent: 1,
      callFrame: {
        functionName: 'allocHot',
        url: 'http://localhost/src/loop.ts',
        lineNumber: 41,
        columnNumber: 0,
        codeType: 'JS',
      },
    },
  ];
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (let t = 1_000_000; t <= 11_000_000; t += 50_000) {
    samples.push(2);
    timeDeltas.push(50_000);
  }
  return [
    {
      name: 'Profile',
      ph: 'P',
      ts: 1_000_000,
      id: '0x1',
      pid,
      tid: 1,
      cat: PROF_CAT,
      args: { data: { startTime: 1_000_000 } },
    },
    {
      name: 'ProfileChunk',
      ph: 'P',
      ts: 1_000_000,
      id: '0x1',
      pid,
      cat: PROF_CAT,
      args: { data: { cpuProfile: { nodes, samples }, timeDeltas } },
    },
  ];
}

describe('isCounterEvent', () => {
  it('matches UpdateCounters instant events only', () => {
    expect(isCounterEvent({ name: 'UpdateCounters', ph: 'I', ts: 0 })).toBe(true);
    expect(isCounterEvent({ name: 'UpdateCounters', ph: 'X', ts: 0 })).toBe(false);
    expect(isCounterEvent({ name: 'UpdateMemoryCounters', ph: 'I', ts: 0 })).toBe(false);
  });
});

describe('buildMemoryModel', () => {
  it('returns null without usable counter data', () => {
    // The Memory box was off: UpdateCounters carry no `data` (the fixtures' case).
    const empty: TraceEvent[] = [
      { name: 'UpdateCounters', ph: 'I', ts: 1_000_000, pid: 1, tid: 1 },
    ];
    expect(buildMemoryModel(empty, [], { mainPid: 1 })).toBeNull();
    expect(buildMemoryModel([], [], { mainPid: 1 })).toBeNull();
    // Fewer than a handful of samples: nothing to model.
    expect(
      buildMemoryModel(
        counters(() => ({}), { n: 3 }),
        [],
        { mainPid: 1 },
      ),
    ).toBeNull();
  });

  it('flags a rising post-GC heap floor as growth despite the GC sawtooth', () => {
    const events = counters((i, t) => ({
      heap: sawtooth(50_000_000 + 5_000_000 * t, i), // floor +5MB/s
      listeners: 100, // flat
    }));
    const m = buildMemoryModel(events, [], { mainPid: 1 })!;
    expect(m).not.toBeNull();
    expect(m.heap.growing).toBe(true);
    expect(m.heap.slopePerSec / 1e6).toBeCloseTo(5, 0); // ~5 MB/s
    expect(m.heap.r2).toBeGreaterThan(0.9);
    expect(m.listeners.growing).toBe(false);
    expect(m.growing).toBe(true);
  });

  it('does NOT flag a sawtooth with a flat floor (allocation churn, no leak)', () => {
    const m = buildMemoryModel(
      counters((i) => ({ heap: sawtooth(50_000_000, i) })),
      [],
      { mainPid: 1 },
    )!;
    expect(m.heap.growing).toBe(false);
    expect(m.growing).toBe(false);
  });

  it('does NOT flag a heap that is being reclaimed (falling floor)', () => {
    // The pile-up-poker shape: heap trends down. A from-trough regression would
    // mistake a later rebound for growth; the full-floor slope stays negative.
    const m = buildMemoryModel(
      counters((i, t) => ({ heap: sawtooth(100_000_000 - 4_000_000 * t, i) })),
      [],
      { mainPid: 1 },
    )!;
    expect(m.heap.slopePerSec).toBeLessThan(0);
    expect(m.heap.growing).toBe(false);
    expect(m.growing).toBe(false);
  });

  it('sees through a leading cleanup transient (high start, drop, then climb)', () => {
    // Recording started mid-activity (one huge sample), then settled and leaked.
    const events = counters((i, t) => ({
      heap: i === 0 ? 130_000_000 : sawtooth(50_000_000 + 4_000_000 * t, i),
      listeners: i === 0 ? 9000 : 100 + 20 * i, // leftover, cleanup, then climb
    }));
    const m = buildMemoryModel(events, [], { mainPid: 1 })!;
    expect(m.heap.growing).toBe(true);
    expect(m.heap.slopePerSec).toBeGreaterThan(0);
    expect(m.listeners.growing).toBe(true);
    // Climb is measured from the post-cleanup low, not the leftover first sample.
    expect(m.listeners.first).toBe(9000);
    expect(m.listeners.min).toBe(120); // first post-cleanup sample (100 + 20·1)
    expect(m.listeners.growth).toBe(m.listeners.last - m.listeners.min);
  });

  it('flags an egregious listener climb even when the heap is flat', () => {
    const m = buildMemoryModel(
      counters((i) => ({ heap: 50_000_000, listeners: 100 + 25 * i })), // 100 → ~5075
      [],
      { mainPid: 1 },
    )!;
    expect(m.heap.growing).toBe(false);
    expect(m.listeners.growing).toBe(true);
    expect(m.growing).toBe(true);
    expect(m.nodes.growing).toBe(false);
  });

  it('picks the busiest counter thread and ignores other processes', () => {
    const main = counters((i, t) => ({ heap: sawtooth(50_000_000 + 5_000_000 * t, i) }), {
      tid: 7,
    });
    const sparse = counters(() => ({ heap: 9_000_000 }), { n: 6, tid: 9 });
    const otherProc = counters((i, t) => ({ heap: sawtooth(1_000_000_000 * t, i) }), {
      pid: 2,
      tid: 1,
    });
    const m = buildMemoryModel([...sparse, ...main, ...otherProc], [], { mainPid: 1 })!;
    expect(m.tid).toBe(7);
    expect(m.sampleCount).toBe(200);
  });

  it('attributes the JS running while memory grew as a suspected source', () => {
    const events = counters((i, t) => ({
      heap: sawtooth(50_000_000 + 5_000_000 * t, i),
    }));
    const collector = new ProfileCollector();
    for (const e of profileEvents()) collector.add(e);
    const m = buildMemoryModel(events, collector.list(), { mainPid: 1 })!;
    expect(m.growing).toBe(true);
    expect(m.suspects[0]?.functionName).toBe('allocHot');
    expect(m.suspects[0]?.app).toBe(true);
    expect(m.suspects[0]?.selfMs).toBeGreaterThan(0);
  });

  it('excludes counters recorded during warmup', () => {
    // All growth happens before warmupEndUs → nothing left to model.
    const events = counters((i, t) => ({
      heap: sawtooth(50_000_000 + 5_000_000 * t, i),
    }));
    expect(
      buildMemoryModel(events, [], { mainPid: 1, warmupEndUs: 20_000_000 }),
    ).toBeNull();
  });
});
