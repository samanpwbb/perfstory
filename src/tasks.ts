import { attributeWindows, type HotFunction, type RawProfile } from './profile.ts';
import type { TraceEvent } from './trace-events.ts';

/**
 * Main-thread long tasks.
 *
 * A presentation gap with no dropped frames is ambiguous: the app might have
 * been idle (nothing to draw) or the main thread might have been blocked. Long
 * `RunTask` events resolve that — if a long task overlaps the gap, the main
 * thread was blocked; otherwise it was genuine idle. Long tasks are also
 * directly actionable on their own (a 480ms task is the thing to fix).
 *
 * A bare start/duration isn't enough to act on, so each long task is attributed
 * two ways: its `trigger` and per-category split come from the timeline child
 * events nested inside it (`EventDispatch`, `Layout`, `Paint`, …), and its
 * `hotFunction` comes from the CPU-profile samples that land in the task window
 * (the same attribution the JS section uses). The timeline split needs only
 * event names/timing, so it survives traces recorded without detailed `args`.
 */

/** Self-time inside a task, split by what kind of work it was (ms). */
export interface LongTaskCategories {
  /** Script execution: FunctionCall, EvaluateScript, EventDispatch, timers, … */
  scripting: number;
  /** Style/layout: Layout, UpdateLayoutTree, recalc styles, hit-testing. */
  rendering: number;
  /** Paint/raster/composite: Paint, PrePaint, Commit, … */
  painting: number;
  /** Garbage collection pauses (MinorGC/MajorGC) that ran inside the task. */
  gc: number;
  /** Anything else (parsing, uncategorised timeline work). */
  other: number;
}

/** The hottest JS function sampled during a task. */
export interface LongTaskHotFunction {
  functionName: string;
  url: string;
  /** 1-based line for display. */
  line: number;
  selfMs: number;
  /** True when the source is app code rather than a dependency. */
  app: boolean;
}

export interface LongTask {
  /** Start, ms from trace origin (same reference as the frame model). */
  startMs: number;
  durMs: number;
  /** What the task mostly was, e.g. `input event`, `timer`, `script eval`. */
  trigger: string;
  /** Self-time by category, from the task's top-level child events. */
  categories: LongTaskCategories;
  /** Hottest JS function sampled during the task; null without a CPU profile. */
  hotFunction: LongTaskHotFunction | null;
}

export interface TaskModel {
  mainTid: number | undefined;
  /** Threshold (ms) above which a RunTask counts as "long". */
  longTaskMs: number;
  /** Long tasks, longest first. */
  longTasks: LongTask[];
  longTaskCount: number;
  totalLongTaskMs: number;
}

export interface TaskModelOptions {
  /** Trace-origin timestamp (µs) — must match the frame model's reference. */
  originUs: number;
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' tasks. */
  mainPid?: number;
  longTaskMs?: number;
  topTasks?: number;
  /**
   * Timeline child events (`isTaskChildEvent`) used to attribute each task's
   * trigger and category split. Omit and tasks carry an empty split.
   */
  childEvents?: TraceEvent[];
  /** CPU profiles, used to name each task's hottest JS function. */
  profiles?: RawProfile[];
}

/** True for top-level main-thread task events. */
export function isTaskEvent(event: TraceEvent): boolean {
  return event.name === 'RunTask' && event.ph === 'X';
}

/**
 * True for the nested timeline events used to attribute a task (FunctionCall,
 * EventDispatch, Layout, Paint, …). `RunTask` shares the same category, so it's
 * excluded here — it's captured by `isTaskEvent` instead.
 */
export function isTaskChildEvent(event: TraceEvent): boolean {
  return (
    event.ph === 'X' &&
    typeof event.dur === 'number' &&
    event.name !== 'RunTask' &&
    (event.cat ?? '').includes('devtools.timeline')
  );
}

type Category = keyof LongTaskCategories;

// Timeline event names → the category their time belongs to. Names not listed
// fall back by keyword (GC) or to `other`. Kept small and explicit: these are
// the events that actually show up as a task's top-level children.
const SCRIPTING = new Set([
  'EvaluateScript',
  'FunctionCall',
  'EventDispatch',
  'TimerFire',
  'FireAnimationFrame',
  'RunMicrotasks',
  'XHRReadyStateChange',
  'XHRLoad',
  'CompileScript',
  'V8.Execute',
]);
const RENDERING = new Set([
  'Layout',
  'UpdateLayoutTree',
  'RecalculateStyles',
  'ScheduleStyleRecalculation',
  'InvalidateLayout',
  'UpdateLayerTree',
  'HitTest',
]);
const PAINTING = new Set([
  'Paint',
  'PrePaint',
  'Commit',
  'CompositeLayers',
  'PaintImage',
  'RasterTask',
  'DecodeImage',
  'Layerize',
]);

function categoryOf(name: string): Category {
  if (SCRIPTING.has(name)) return 'scripting';
  if (RENDERING.has(name)) return 'rendering';
  if (PAINTING.has(name)) return 'painting';
  if (name.includes('GC')) return 'gc';
  return 'other';
}

// The dominant child's event name → a human label for the task's trigger.
const TRIGGER_LABELS: Record<string, string> = {
  EventDispatch: 'input event',
  TimerFire: 'timer',
  FireAnimationFrame: 'animation frame',
  EvaluateScript: 'script eval',
  CompileScript: 'script compile',
  FunctionCall: 'script',
  RunMicrotasks: 'microtasks',
  XHRReadyStateChange: 'network',
  XHRLoad: 'network',
  ParseHTML: 'parse HTML',
  MajorGC: 'major GC',
  MinorGC: 'minor GC',
  Layout: 'layout',
  UpdateLayoutTree: 'layout',
  Paint: 'paint',
  PrePaint: 'paint',
  Commit: 'paint',
};

function triggerLabel(name: string | null): string {
  if (!name) return 'task';
  return TRIGGER_LABELS[name] ?? name;
}

/**
 * Summarise one task window from its timeline child events: the depth-1 children
 * partition the task's time, so summing each one's duration by category gives a
 * double-count-free split, and the largest names the trigger. `children` must be
 * sorted by `(ts asc, dur desc)` so each top-level child is seen before anything
 * nested inside it.
 */
function summarizeWindow(
  children: TraceEvent[],
  startUs: number,
  endUs: number,
): { trigger: string; categories: LongTaskCategories } {
  const categories: LongTaskCategories = {
    scripting: 0,
    rendering: 0,
    painting: 0,
    gc: 0,
    other: 0,
  };
  let coveredUntil = -Infinity;
  let triggerName: string | null = null;
  let triggerDur = -1;

  for (const e of children) {
    if (e.ts < startUs) continue;
    if (e.ts >= endUs) break; // sorted by ts — nothing later can start in-window
    if (e.ts < coveredUntil) continue; // nested inside a top-level child already counted
    const dur = e.dur ?? 0;
    coveredUntil = e.ts + dur;
    const name = e.name ?? '';
    categories[categoryOf(name)] += dur / 1000;
    if (dur > triggerDur) {
      triggerDur = dur;
      triggerName = name;
    }
  }
  return { trigger: triggerLabel(triggerName), categories };
}

export function buildTaskModel(
  events: TraceEvent[],
  options: TaskModelOptions,
): TaskModel {
  const longTaskMs = options.longTaskMs ?? 50;
  const warmupEndUs = Math.max(options.warmupEndUs ?? 0, 0);
  const { mainPid, originUs } = options;
  const inProcess = (e: TraceEvent) => mainPid === undefined || e.pid === mainPid;

  // Main thread = the thread with the most total RunTask time in the process.
  const byThread = new Map<number, number>();
  for (const e of events) {
    if (e.name !== 'RunTask' || !inProcess(e)) continue;
    if (typeof e.tid !== 'number' || typeof e.dur !== 'number') continue;
    byThread.set(e.tid, (byThread.get(e.tid) ?? 0) + e.dur);
  }
  let mainTid: number | undefined;
  let best = -1;
  for (const [tid, sum] of byThread) {
    if (sum > best) {
      best = sum;
      mainTid = tid;
    }
  }

  // The long RunTasks themselves, longest first.
  const rawLong: TraceEvent[] = [];
  for (const e of events) {
    if (e.name !== 'RunTask' || !inProcess(e) || e.tid !== mainTid) continue;
    if (typeof e.dur !== 'number' || e.ts < warmupEndUs) continue;
    if (e.dur < longTaskMs * 1000) continue;
    rawLong.push(e);
  }
  rawLong.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0) || a.ts - b.ts);

  // Main-thread timeline children, sorted so summarizeWindow sees parents first.
  const children = (options.childEvents ?? [])
    .filter((e) => inProcess(e) && e.tid === mainTid && typeof e.dur === 'number')
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));

  // Hottest JS function per task, from the CPU profile windows.
  const windows = rawLong.map((e) => ({ startUs: e.ts, endUs: e.ts + (e.dur ?? 0) }));
  const attribution = attributeWindows(options.profiles ?? [], windows, {
    ...(mainPid !== undefined ? { mainPid } : {}),
    top: 1,
  });

  const toHotFunction = (f: HotFunction | undefined): LongTaskHotFunction | null =>
    f
      ? {
          functionName: f.functionName,
          url: f.url,
          line: f.line,
          selfMs: f.selfMs,
          app: f.app,
        }
      : null;

  const longTasks: LongTask[] = rawLong.map((e, i) => {
    const endUs = e.ts + (e.dur ?? 0);
    const { trigger, categories } = summarizeWindow(children, e.ts, endUs);
    return {
      startMs: (e.ts - originUs) / 1000,
      durMs: (e.dur ?? 0) / 1000,
      trigger,
      categories,
      hotFunction: toHotFunction(attribution[i]?.top[0]),
    };
  });

  return {
    mainTid,
    longTaskMs,
    longTasks: longTasks.slice(0, options.topTasks ?? 25),
    longTaskCount: longTasks.length,
    totalLongTaskMs: longTasks.reduce((s, t) => s + t.durMs, 0),
  };
}

/**
 * The long task that most overlaps a [startMs, endMs) window, or null if none.
 * Any frame-blocking task is itself long, so checking `longTasks` is enough to
 * tell a blocked gap from an idle one.
 */
export function blockingTask(
  longTasks: ReadonlyArray<{ startMs: number; durMs: number }>,
  startMs: number,
  endMs: number,
): { startMs: number; durMs: number } | null {
  let best: { startMs: number; durMs: number } | null = null;
  let bestOverlap = 0;
  for (const t of longTasks) {
    const overlap = Math.min(t.startMs + t.durMs, endMs) - Math.max(t.startMs, startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t;
    }
  }
  return best;
}
