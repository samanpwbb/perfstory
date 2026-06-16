import type { TraceEvent } from './trace-events.ts';

/**
 * Why an event is dropped before analysis. Tracking the reason lets `analyze`
 * report exactly where the size collapse comes from.
 */
export type DropReason = 'inspector' | 'metadata' | 'source-rundown';

/**
 * Classify an event as analysis noise, or return null to keep it.
 *
 * The dominant cost in DevTools traces recorded with the console/debugger
 * attached is `disabled-by-default-v8.inspector` async-task bookkeeping
 * (AsyncTaskRun/Scheduled/Canceled, V8Console::runTask) — empirically ~85–90%
 * of events in real traces. It tells us nothing about rendering or animation
 * performance. We also drop process/thread metadata and the V8 source-rundown
 * dictionary, neither of which informs frame timing.
 *
 * Everything else — timeline, frame lifecycle, CPU profiler, user timing, GC —
 * is kept for the modeling steps.
 */
export function classifyNoise(event: TraceEvent): DropReason | null {
  const cat = event.cat ?? '';

  if (cat === '__metadata') return 'metadata';
  if (cat.includes('disabled-by-default-v8.inspector')) return 'inspector';
  if (cat.includes('v8-source-rundown')) return 'source-rundown';

  return null;
}

/** True when an event carries signal worth keeping for analysis. */
export function isSignal(event: TraceEvent): boolean {
  return classifyNoise(event) === null;
}
