import { describe, expect, it } from 'vitest';
import { buildFrameDropsModel } from '../src/framedrops.ts';
import type { Freeze } from '../src/frames.ts';
import type { GcModel, GcPause } from '../src/gc.ts';
import type { RawProfile } from '../src/profile.ts';
import type { ForcedLayout, ReflowModel } from '../src/reflow.ts';
import type { LongTask, TaskModel } from '../src/tasks.ts';

// All times here are ms-from-origin (the space every model shares); `startUs`
// mirrors it ×1000 so windowed CPU attribution lines up.
function freeze(startMs: number, durMs: number, dropAtMs = [startMs]): Freeze {
  return {
    startMs,
    durMs,
    startUs: startMs * 1000,
    endUs: (startMs + durMs) * 1000,
    dropStartMs: dropAtMs[0] ?? startMs,
    dropEndMs: dropAtMs[dropAtMs.length - 1] ?? startMs,
    dropAtMs,
    count: dropAtMs.length,
  };
}

function task(startMs: number, durMs: number, trigger = 'input event'): LongTask {
  return {
    startMs,
    durMs,
    trigger,
    categories: { scripting: durMs, rendering: 0, painting: 0, gc: 0, other: 0 },
    hotFunction: null,
  };
}

function tasks(longTasks: LongTask[]): TaskModel {
  return {
    mainTid: 1,
    longTaskMs: 50,
    longTasks,
    longTaskCount: longTasks.length,
    totalLongTaskMs: longTasks.reduce((s, t) => s + t.durMs, 0),
  };
}

function pause(
  startMs: number,
  durMs: number,
  kind: GcPause['kind'] = 'scavenge',
): GcPause {
  return { kind, startMs, durMs, freedBytes: 0 };
}

function gcModel(pauses: GcPause[]): GcModel {
  return {
    mainTid: 1,
    scavengeCount: pauses.filter((p) => p.kind === 'scavenge').length,
    scavengeMs: 0,
    markCompactCount: pauses.filter((p) => p.kind === 'mark-compact').length,
    markCompactMs: 0,
    totalGcMs: pauses.reduce((s, p) => s + p.durMs, 0),
    youngFreedBytes: 0,
    scavengeHz: 0,
    pauses,
    suspectedAllocators: [],
  };
}

function occ(
  startMs: number,
  durMs: number,
  kind: ForcedLayout['kind'] = 'layout',
): ForcedLayout {
  return { kind, startMs, durMs };
}

function reflowModel(occurrences: ForcedLayout[], culpritUrl?: string): ReflowModel {
  return {
    mainTid: 1,
    forcedLayoutCount: occurrences.filter((o) => o.kind === 'layout').length,
    forcedStyleCount: occurrences.filter((o) => o.kind === 'style').length,
    forcedMs: occurrences.reduce((s, o) => s + o.durMs, 0),
    worstMs: 0,
    worstBurstCount: 0,
    occurrences,
    culprits: culpritUrl
      ? [
          {
            functionName: 'reader',
            url: culpritUrl,
            line: 1,
            selfMs: 1,
            sharePct: 1,
            app: false,
          },
        ]
      : [],
  };
}

/** A CPU profile that charges 20ms of JS self-time to `doWork` in [100, 120]ms. */
function jsProfile(): RawProfile {
  return {
    id: '1',
    pid: 1,
    tid: 1,
    startUs: 100_000,
    frames: new Map([
      [1, { functionName: '(root)' }],
      [
        2,
        {
          functionName: 'doWork',
          url: 'http://localhost/app.ts',
          lineNumber: 9,
          columnNumber: 0,
          codeType: 'JS',
        },
      ],
    ]),
    parents: new Map([[2, 1]]),
    samples: [2, 2, 2],
    deltas: [0, 10_000, 10_000],
  };
}

describe('buildFrameDropsModel', () => {
  it('returns null when nothing was dropped', () => {
    expect(buildFrameDropsModel([], tasks([]), null, null)).toBeNull();
  });

  it('attributes a freeze to the long task that blocked across it', () => {
    const m = buildFrameDropsModel([freeze(100, 50)], tasks([task(95, 80)]), null, null)!;
    expect(m.count).toBe(1);
    expect(m.droppedFrames).toBe(1);
    const d = m.drops[0]!;
    expect(d.id).toBe(1);
    expect(d.cause).toBe('long-task');
    expect(d.blockingTask?.durMs).toBe(80);
    expect(d.blockingTask?.overlapMs).toBeCloseTo(50, 5); // [100,150] ∩ [95,175]
    expect(m.coincidence.longTask).toEqual({
      total: 1,
      freezesNear: 1,
      freezesCaused: 1,
      verdict: 'implicated',
    });
    // No GC/reflow data → those rows are explicitly n/a, not silently absent.
    expect(m.coincidence.gc.verdict).toBe('n/a');
    expect(m.coincidence.reflow.verdict).toBe('n/a');
    expect(d.gc).toBeNull();
    expect(d.reflow).toBeNull();
  });

  it('blames GC when overlapping pauses dominate the freeze', () => {
    const m = buildFrameDropsModel(
      [freeze(100, 50)],
      tasks([]),
      gcModel([pause(110, 30)]),
      null,
    )!;
    const d = m.drops[0]!;
    expect(d.cause).toBe('gc');
    expect(d.gc).toEqual({ count: 1, totalMs: 30, scavenge: 1, markCompact: 0 });
    expect(m.coincidence.gc.verdict).toBe('implicated');
  });

  it('clears GC when its pauses never land on a drop', () => {
    const m = buildFrameDropsModel(
      [freeze(100, 50)],
      tasks([]),
      gcModel([pause(500, 5)]),
      null,
    )!;
    expect(m.drops[0]!.gc).toEqual({ count: 0, totalMs: 0, scavenge: 0, markCompact: 0 });
    expect(m.drops[0]!.cause).toBe('unknown');
    expect(m.coincidence.gc).toEqual({
      total: 1,
      freezesNear: 0,
      freezesCaused: 0,
      verdict: 'cleared',
    });
  });

  it('marks GC as coincided (not implicated) when it overlaps but never drives a freeze', () => {
    // A long task owns the freeze; a small GC pause happens inside it but isn't
    // what stalled the frame → GC is "near" but not the cause.
    const m = buildFrameDropsModel(
      [freeze(100, 50)],
      tasks([task(95, 80)]),
      gcModel([pause(110, 5)]),
      null,
    )!;
    expect(m.drops[0]!.cause).toBe('long-task');
    expect(m.drops[0]!.gc?.count).toBe(1);
    expect(m.coincidence.longTask.verdict).toBe('implicated');
    expect(m.coincidence.gc).toEqual({
      total: 1,
      freezesNear: 1,
      freezesCaused: 0,
      verdict: 'coincided',
    });
  });

  it('blames forced reflow when it accounts for a chunk of the freeze', () => {
    const m = buildFrameDropsModel(
      [freeze(100, 50)],
      tasks([]),
      null,
      reflowModel([occ(105, 20), occ(120, 5, 'style')]),
    )!;
    const d = m.drops[0]!;
    expect(d.cause).toBe('forced-reflow');
    expect(d.reflow).toEqual({ count: 2, forcedMs: 25, captureArtifact: false });
    expect(m.coincidence.reflow.verdict).toBe('implicated');
  });

  it('treats an extension run-up culprit as a capture artifact, not a cause', () => {
    const m = buildFrameDropsModel(
      [freeze(100, 50)],
      tasks([]),
      null,
      reflowModel([occ(105, 30)], 'chrome-extension://abc/installHook.js'),
    )!;
    const d = m.drops[0]!;
    expect(d.reflow?.captureArtifact).toBe(true);
    expect(d.cause).not.toBe('forced-reflow'); // never blame the artifact
    expect(m.coincidence.reflow.verdict).toBe('capture-artifact');
  });

  it('falls back to script when the CPU profile shows JS filled the freeze', () => {
    const m = buildFrameDropsModel([freeze(100, 50)], tasks([]), null, null, {
      profiles: [jsProfile()],
      mainPid: 1,
    })!;
    const d = m.drops[0]!;
    expect(d.work.jsMs).toBeCloseTo(20, 5);
    expect(d.cause).toBe('script');
    expect(d.work.top[0]?.functionName).toBe('doWork');
    expect(d.note).toContain('doWork');
  });

  it('carries the individual dropped-frame timestamps and counts', () => {
    const m = buildFrameDropsModel(
      [freeze(100, 50, [110, 126, 142])],
      tasks([]),
      null,
      null,
    )!;
    expect(m.drops[0]!.dropAtMs).toEqual([110, 126, 142]);
    expect(m.drops[0]!.droppedFrames).toBe(3);
    expect(m.droppedFrames).toBe(3);
  });

  it('counts coincidence across multiple freezes by causal role', () => {
    // Freeze 1 is owned by a long task; a small GC pause overlaps freeze 2 but is
    // too small to be its cause. A third task overlaps neither. So long tasks are
    // implicated (caused 1), while GC only coincided (near 1, caused 0).
    const m = buildFrameDropsModel(
      [freeze(100, 50), freeze(400, 50)],
      tasks([task(95, 60), task(800, 60)]),
      gcModel([pause(420, 10)]),
      null,
    )!;
    expect(m.count).toBe(2);
    expect(m.coincidence.longTask).toEqual({
      total: 2,
      freezesNear: 1,
      freezesCaused: 1,
      verdict: 'implicated',
    });
    expect(m.coincidence.gc).toEqual({
      total: 1,
      freezesNear: 1,
      freezesCaused: 0,
      verdict: 'coincided',
    });
  });
});
