import { describe, expect, it } from 'vitest';
import { buildFrameModel, computeFreezes, isFrameEvent } from '../src/frames.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const FRAME_CAT = 'disabled-by-default-devtools.timeline.frame';

function instant(name: string, ts: number): TraceEvent {
  return { name, ph: 'I', ts, cat: FRAME_CAT, s: 't' };
}

function mainFrame(ts: number, breakdown: Record<string, number>): TraceEvent {
  return {
    name: 'SendBeginMainFrameToCommit',
    ph: 'b',
    ts,
    cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame',
    id2: { local: '0x1' },
    args: { send_begin_mainframe_to_commit_breakdown: breakdown },
  };
}

// 60Hz cadence; 4 presented frames with a freeze (2 dropped frames) in the middle.
const BUDGET = 16667; // µs ≈ 1/60s
function scene(): TraceEvent[] {
  return [
    instant('BeginFrame', 0),
    instant('BeginFrame', BUDGET),
    instant('BeginFrame', BUDGET * 2),
    instant('BeginFrame', BUDGET * 3),
    instant('BeginFrame', BUDGET * 4),
    instant('DrawFrame', 0),
    instant('DrawFrame', BUDGET),
    instant('DrawFrame', BUDGET * 2),
    instant('DrawFrame', 100_000), // after the freeze
    instant('DroppedFrame', BUDGET * 3),
    instant('DroppedFrame', BUDGET * 4),
    mainFrame(BUDGET, {
      paint_us: 2000,
      layout_update_us: 1000,
      animate_us: 500,
      accessibility_update_us: 0, // dropped: not > 0
      begin_main_sent_to_started_us: 1.8e19, // dropped: sentinel
    }),
  ];
}

describe('isFrameEvent', () => {
  it('selects only the frame-relevant event names', () => {
    expect(isFrameEvent(instant('DrawFrame', 0))).toBe(true);
    expect(isFrameEvent(instant('PipelineReporter', 0))).toBe(true);
    expect(isFrameEvent({ name: 'FunctionCall', ph: 'X', ts: 0 })).toBe(false);
  });
});

describe('buildFrameModel', () => {
  it('detects 60Hz from BeginFrame cadence', () => {
    const m = buildFrameModel(scene());
    expect(m.refresh.hz).toBe(60);
    expect(m.refresh.source).toBe('detected');
    expect(m.refresh.confidence).toBe(1);
    expect(m.refresh.intervalMs).toBeCloseTo(16.667, 2);
  });

  it('honours an explicit fps override', () => {
    const m = buildFrameModel(scene(), { fps: 120 });
    expect(m.refresh.hz).toBe(120);
    expect(m.refresh.source).toBe('override');
    expect(m.refresh.intervalMs).toBeCloseTo(8.333, 2);
  });

  it('counts presented vs dropped frames', () => {
    const m = buildFrameModel(scene());
    expect(m.presented).toBe(4);
    expect(m.dropped).toBe(2);
    expect(m.droppedPct).toBeCloseTo((2 / 6) * 100, 5);
  });

  it('measures the freeze span around a dropped-frame cluster', () => {
    const m = buildFrameModel(scene());
    // last DrawFrame before the cluster is at 2*BUDGET; first after is at 100_000µs
    expect(m.worstFreezeMs).toBeCloseTo((100_000 - BUDGET * 2) / 1000, 3);
    expect(m.worstFreezeAtMs).toBeCloseTo((BUDGET * 2) / 1000, 3);
    expect(m.jankGapCount).toBe(1);
    expect(m.droppedClusters).toHaveLength(1);
    expect(m.droppedClusters[0]?.count).toBe(2);
  });

  it('breaks down main-thread frame time, filtering zeros and sentinels', () => {
    const m = buildFrameModel(scene());
    expect(m.mainThread.map((p) => p.key)).toEqual([
      'paint_us',
      'layout_update_us',
      'animate_us',
    ]);
    const paint = m.mainThread[0];
    expect(paint?.label).toBe('paint');
    expect(paint?.totalMs).toBeCloseTo(2, 5);
    expect(paint?.sharePct).toBeCloseTo((2000 / 3500) * 100, 3);
  });

  it('excludes profiling-overhead warmup from jank analysis', () => {
    // Cut off just after both dropped frames (at 3*BUDGET and 4*BUDGET).
    const m = buildFrameModel(scene(), { warmupEndUs: BUDGET * 4 + 1 });
    expect(m.warmupMs).toBeCloseTo((BUDGET * 4 + 1) / 1000, 3);
    expect(m.dropped).toBe(0);
    expect(m.droppedClusters).toHaveLength(0);
    expect(m.worstFreezeMs).toBe(0);
    // only the post-warmup DrawFrame (at 100_000µs) survives
    expect(m.presented).toBe(1);
  });

  it('is deterministic across runs', () => {
    expect(JSON.stringify(buildFrameModel(scene()))).toBe(
      JSON.stringify(buildFrameModel(scene())),
    );
  });
});

describe('computeFreezes', () => {
  // Two separate freezes (clusters >100ms apart), each bracketed by presented frames.
  function twoFreezeScene(): TraceEvent[] {
    return [
      instant('DrawFrame', 0),
      instant('DrawFrame', BUDGET),
      instant('DrawFrame', BUDGET * 2),
      instant('DrawFrame', 100_000),
      instant('DrawFrame', 150_000),
      instant('DrawFrame', 300_000),
      instant('DroppedFrame', BUDGET * 3),
      instant('DroppedFrame', BUDGET * 4),
      instant('DroppedFrame', 200_000),
    ];
  }

  it('returns one freeze per dropped-frame cluster, with windows and members', () => {
    const freezes = computeFreezes(twoFreezeScene());
    expect(freezes).toHaveLength(2);

    const [first, second] = freezes;
    // Freeze 1: last draw before the cluster (2*BUDGET) → first after (100_000µs).
    expect(first?.startUs).toBe(BUDGET * 2);
    expect(first?.endUs).toBe(100_000);
    expect(first?.durMs).toBeCloseTo((100_000 - BUDGET * 2) / 1000, 3);
    expect(first?.count).toBe(2);
    expect(first?.dropAtMs).toEqual([(BUDGET * 3) / 1000, (BUDGET * 4) / 1000]);

    // Freeze 2: a single drop bracketed by 150_000µs and 300_000µs.
    expect(second?.startUs).toBe(150_000);
    expect(second?.endUs).toBe(300_000);
    expect(second?.count).toBe(1);
    expect(second?.dropAtMs).toEqual([200]);
  });

  it('excludes freezes whose drops fall in the profiling warmup', () => {
    // Cut off after the first cluster; only the 200_000µs drop survives.
    const freezes = computeFreezes(twoFreezeScene(), { warmupEndUs: 100_000 });
    expect(freezes).toHaveLength(1);
    expect(freezes[0]?.dropAtMs).toEqual([200]);
  });
});
