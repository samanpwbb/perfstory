import type { Freeze } from './frames.ts';
import type { GcModel } from './gc.ts';
import { attributeWindows, type HotFunction, type RawProfile } from './profile.ts';
import type { ReflowModel } from './reflow.ts';
import type {
  LongTask,
  LongTaskCategories,
  LongTaskHotFunction,
  TaskModel,
} from './tasks.ts';

/**
 * Frame-drop attribution — "where the work went during each freeze".
 *
 * Every other model is a *vertical* slice of the trace (all the GC, all the long
 * tasks, all the forced layout). They each carry timestamps, but answering "was
 * there a GC at the same time as this frame drop?" means joining those slices on
 * the time axis by hand. This model does that join: it anchors on each freeze
 * (one dropped-frame cluster, from `computeFreezes`) and gathers everything that
 * overlaps its window — the blocking long task, GC pauses, forced reflows, and
 * the CPU-profile work charged to exactly that span — then states a one-line
 * cause. It's a pure correlation layer over the already-built models, computed
 * after them like the verdict; it introduces no new event buffering.
 *
 * The trace-level `coincidence` block answers the negative the per-freeze
 * dossiers can't: "GC fired 40× but none of it landed on a drop → not your jank
 * source." Absence is stated explicitly (`cleared` / `n/a`) rather than implied
 * by omission, which is what an agent reading this needs.
 *
 * `null` when the trace dropped no frames — there is nothing to attribute, and
 * the FRAMES section already reports the clean result.
 */

/** CPU-profile self-time charged to a single freeze window. */
export interface FrameDropWork {
  /** JS self-time inside the freeze (ms). */
  jsMs: number;
  /** Engine/native self-time inside the freeze (ms). */
  nativeMs: number;
  /** GC self-time sampled inside the freeze (ms). */
  gcMs: number;
  /** Hottest JS functions during the freeze, biggest self-time first. */
  top: HotFunction[];
}

/** The long task that blocked the main thread across a freeze. */
export interface FrameDropTask {
  startMs: number;
  durMs: number;
  trigger: string;
  categories: LongTaskCategories;
  hotFunction: LongTaskHotFunction | null;
  /** How much of the freeze the task covered (ms). */
  overlapMs: number;
}

/** GC pauses overlapping a freeze. */
export interface FrameDropGc {
  count: number;
  totalMs: number;
  scavenge: number;
  markCompact: number;
}

/** Forced synchronous layout overlapping a freeze. */
export interface FrameDropReflow {
  count: number;
  forcedMs: number;
  /** The run-up culprit is a DevTools extension → a capture artifact, not jank. */
  captureArtifact: boolean;
}

/** The dominant cause of a freeze, picked from the overlapping evidence. */
export type FrameDropCause = 'long-task' | 'gc' | 'forced-reflow' | 'script' | 'unknown';

/** One freeze, with everything that coincided with it and a cause. */
export interface FrameDrop {
  /** Stable 1-based id, so an agent can reference "drop 2". */
  id: number;
  /** Freeze start (last presented frame before the drop), ms from origin. */
  startMs: number;
  /** Freeze span, ms. */
  durMs: number;
  droppedFrames: number;
  /** Each dropped-frame timestamp in the freeze, ms from origin. */
  dropAtMs: number[];
  /** The long task that blocked the main thread across the freeze, if any. */
  blockingTask: FrameDropTask | null;
  /** CPU-profile work charged to the freeze window. */
  work: FrameDropWork;
  /** GC pauses overlapping the freeze; `null` when the trace has no GC data. */
  gc: FrameDropGc | null;
  /** Forced reflows overlapping the freeze; `null` when none was forced. */
  reflow: FrameDropReflow | null;
  cause: FrameDropCause;
  /** One-line explanation of the cause. */
  note: string;
}

export type CoincidenceVerdict =
  | 'implicated'
  | 'coincided'
  | 'cleared'
  | 'n/a'
  | 'capture-artifact';

/**
 * Did a phenomenon cause frame drops, across the whole trace? The verdict is
 * about *causal role*, not mere temporal overlap: `implicated` = it was the
 * assigned cause of at least one freeze; `coincided` = it overlapped a freeze
 * but never drove one (present, but not the culprit — the "GC fired near a drop
 * but wasn't what stalled the frame" case); `cleared` = it never overlapped a
 * freeze; `n/a` = no such events; `capture-artifact` = a DevTools-extension
 * effect to ignore.
 */
export interface CoincidenceRow {
  /** Events of this kind in the trace. */
  total: number;
  /** Freezes this phenomenon overlapped. */
  freezesNear: number;
  /** Freezes where this phenomenon was the assigned cause. */
  freezesCaused: number;
  verdict: CoincidenceVerdict;
}

export interface FrameDropsModel {
  /** Number of freezes (dropped-frame clusters). */
  count: number;
  /** Total dropped frames across all freezes. */
  droppedFrames: number;
  /** One dossier per freeze, in time order. */
  drops: FrameDrop[];
  /** Whole-trace coincidence verdict per phenomenon — the "is X my problem" table. */
  coincidence: {
    longTask: CoincidenceRow;
    gc: CoincidenceRow;
    reflow: CoincidenceRow;
  };
}

export interface FrameDropsOptions {
  /** CPU profiles, to charge self-time to each freeze window. */
  profiles?: RawProfile[];
  /** Renderer process id (from the frame events) — selects the app's profile. */
  mainPid?: number;
}

/** Overlap (ms) of two [start, end) intervals; negative when disjoint. */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

const ms0 = (n: number): string => `${n.toFixed(0)}ms`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pick the dominant cause and write its one-line note from the overlapping evidence. */
function classify(
  freeze: number,
  task: FrameDropTask | null,
  gc: FrameDropGc | null,
  reflow: FrameDropReflow | null,
  work: FrameDropWork,
): { cause: FrameDropCause; note: string } {
  // A long task that covers most of the freeze monopolized the main thread.
  if (task && task.overlapMs >= 0.5 * freeze) {
    return {
      cause: 'long-task',
      note: `a ${ms0(task.durMs)} ${task.trigger} task blocked the main thread`,
    };
  }
  // GC pauses that account for half the freeze.
  if (gc && gc.count > 0 && gc.totalMs >= 0.5 * freeze) {
    return {
      cause: 'gc',
      note: `${plural(gc.count, 'GC pause')} (${ms0(gc.totalMs)}) stalled the main thread`,
    };
  }
  // Forced synchronous layout — but never blame a DevTools-extension artifact.
  if (
    reflow &&
    !reflow.captureArtifact &&
    reflow.count > 0 &&
    reflow.forcedMs >= 0.25 * freeze
  ) {
    return {
      cause: 'forced-reflow',
      note: `${plural(reflow.count, 'forced layout')} (${ms0(reflow.forcedMs)}) flushed synchronously in script`,
    };
  }
  // Otherwise, lean on the CPU profile: JS-heavy → script; else unknown.
  if (work.jsMs > 0 && work.jsMs >= work.nativeMs) {
    const top = work.top[0];
    return {
      cause: 'script',
      note: `JS execution filled the freeze${top ? `; hottest ${top.functionName}` : ''}`,
    };
  }
  return {
    cause: 'unknown',
    note: 'no single main-thread cause stood out — likely paint/composite or off-main-thread (GPU/raster) work',
  };
}

/** Coincidence verdict from a phenomenon's causal role across the freezes. */
function coincide(
  total: number,
  freezesNear: number,
  freezesCaused: number,
  artifact = false,
): CoincidenceRow {
  let verdict: CoincidenceVerdict;
  if (total === 0) verdict = 'n/a';
  else if (artifact) verdict = 'capture-artifact';
  else if (freezesCaused > 0) verdict = 'implicated';
  else if (freezesNear > 0) verdict = 'coincided';
  else verdict = 'cleared';
  return { total, freezesNear, freezesCaused, verdict };
}

export function buildFrameDropsModel(
  freezes: Freeze[],
  tasks: TaskModel,
  gc: GcModel | null,
  reflow: ReflowModel | null,
  options: FrameDropsOptions = {},
): FrameDropsModel | null {
  if (freezes.length === 0) return null;

  const profiles = options.profiles ?? [];
  const work = attributeWindows(
    profiles,
    freezes.map((f) => ({ startUs: f.startUs, endUs: f.endUs })),
    { ...(options.mainPid !== undefined ? { mainPid: options.mainPid } : {}), top: 3 },
  );

  // The reflow run-up culprit being a browser-extension script means the forced
  // flush is a capture artifact (DevTools measuring components), not app jank —
  // the same call the verdict layer makes. One check for the whole trace.
  const reflowArtifact =
    !!reflow && /-extension:\/\//.test(reflow.culprits[0]?.url ?? '');

  const drops: FrameDrop[] = freezes.map((f, i) => {
    const fEnd = f.startMs + f.durMs;

    // The long task that most overlaps the freeze (the full task, for its split).
    let blockingTask: FrameDropTask | null = null;
    let bestOverlap = 0;
    for (const t of tasks.longTasks) {
      const ov = overlapMs(f.startMs, fEnd, t.startMs, t.startMs + t.durMs);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        blockingTask = taskOf(t, ov);
      }
    }

    // GC pauses overlapping the freeze.
    let gcModel: FrameDropGc | null = null;
    if (gc) {
      let count = 0;
      let totalMs = 0;
      let scavenge = 0;
      let markCompact = 0;
      for (const p of gc.pauses) {
        if (overlapMs(f.startMs, fEnd, p.startMs, p.startMs + p.durMs) > 0) {
          count++;
          totalMs += p.durMs;
          if (p.kind === 'scavenge') scavenge++;
          else markCompact++;
        }
      }
      gcModel = { count, totalMs, scavenge, markCompact };
    }

    // Forced reflows overlapping the freeze.
    let reflowModel: FrameDropReflow | null = null;
    if (reflow) {
      let count = 0;
      let forcedMs = 0;
      for (const o of reflow.occurrences) {
        if (overlapMs(f.startMs, fEnd, o.startMs, o.startMs + o.durMs) > 0) {
          count++;
          forcedMs += o.durMs;
        }
      }
      reflowModel = { count, forcedMs, captureArtifact: reflowArtifact };
    }

    const w = work[i];
    const workModel: FrameDropWork = {
      jsMs: w?.jsMs ?? 0,
      nativeMs: w?.nativeMs ?? 0,
      gcMs: w?.gcMs ?? 0,
      top: w?.top ?? [],
    };

    const { cause, note } = classify(
      f.durMs,
      blockingTask,
      gcModel,
      reflowModel,
      workModel,
    );
    return {
      id: i + 1,
      startMs: f.startMs,
      durMs: f.durMs,
      droppedFrames: f.count,
      dropAtMs: f.dropAtMs,
      blockingTask,
      work: workModel,
      gc: gcModel,
      reflow: reflowModel,
      cause,
      note,
    };
  });

  // Trace-level coincidence: for each phenomenon, how many freezes it overlapped
  // vs how many it actually *caused* (its dominant role, from the per-drop
  // classification above). `total` is the full trace count from the model
  // aggregates; the freeze counts come from the dossiers we just built, so the
  // verdict distinguishes "drove a freeze" (implicated) from "was merely present"
  // (coincided) — e.g. a GC pause that fired during a freeze the long task owned.
  const causedBy = (cause: FrameDropCause): number =>
    drops.filter((d) => d.cause === cause).length;

  const longTask = coincide(
    tasks.longTaskCount,
    drops.filter((d) => d.blockingTask !== null).length,
    causedBy('long-task'),
  );
  const gcRow = coincide(
    gc ? gc.scavengeCount + gc.markCompactCount : 0,
    drops.filter((d) => d.gc !== null && d.gc.count > 0).length,
    causedBy('gc'),
  );
  const reflowRow = coincide(
    reflow ? reflow.forcedLayoutCount + reflow.forcedStyleCount : 0,
    drops.filter((d) => d.reflow !== null && d.reflow.count > 0).length,
    causedBy('forced-reflow'),
    reflowArtifact,
  );

  return {
    count: freezes.length,
    droppedFrames: freezes.reduce((s, f) => s + f.count, 0),
    drops,
    coincidence: { longTask, gc: gcRow, reflow: reflowRow },
  };
}

function taskOf(t: LongTask, overlap: number): FrameDropTask {
  return {
    startMs: t.startMs,
    durMs: t.durMs,
    trigger: t.trigger,
    categories: t.categories,
    hotFunction: t.hotFunction,
    overlapMs: overlap,
  };
}
