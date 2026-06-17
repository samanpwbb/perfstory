import {
  attributeWindowedSelfTime,
  type RawProfile,
  type WindowedSuspect,
} from './profile.ts';
import type { TraceEvent } from './trace-events.ts';

/**
 * Memory growth from the DevTools "Memory" counters.
 *
 * With the Memory checkbox on, DevTools emits `UpdateCounters` instant events
 * (`disabled-by-default-devtools.timeline`) carrying the renderer's live
 * `jsHeapSizeUsed`, `nodes` (DOM), `jsEventListeners`, and `documents`. Sampled
 * many times a second, they trace how the page's retained memory moves over the
 * recording — the only growth signal a runtime trace carries (a CPU profile
 * shows where time *goes*, not what is *retained*).
 *
 * A leak shows up as a steadily rising **post-GC floor**: the live set the
 * collector can't reclaim climbs even though scavenges keep running. We isolate
 * that floor from the GC sawtooth by taking per-bucket minima, then linear-fit
 * the *whole* floor. Two robustness properties fall out: a recording that starts
 * mid-activity and then settles (a one-off cleanup drop) folds that drop into the
 * first bucket's minimum rather than the trend; and fitting the whole floor — not
 * just from its global minimum — keeps a mid-series dip with a later rebound from
 * reading as growth (the slope sign is what gates). Listeners/nodes/documents
 * don't sawtooth; the same floor handles their leading cleanup drop, and a
 * monotonic, never-reclaimed rise is itself the signature.
 *
 * Growth is reported **structurally** here. Whether it's a leak or a
 * legitimately growing working set is interpreted in the verdict, which has the
 * activity context: memory climbing while the app is idle is the strong signal,
 * memory climbing under load may just be the working set filling up.
 */

/** One counter's trajectory over the analyzed span, measured on its floor. */
export interface CounterTrend {
  /** First and last sampled values (raw units — bytes for the heap). */
  first: number;
  last: number;
  /** Observed raw range. `min` is the floor's low point — the leak baseline. */
  min: number;
  max: number;
  /** Slope of the floor (lower-envelope) regression, units per second. */
  slopePerSec: number;
  /** R² of that fit — how linear/sustained the climb is (0..1). */
  r2: number;
  /** Observed climb (`last − min`) — the amount that was never reclaimed. */
  growth: number;
  /** True when the floor rises materially and steadily (not a transient or noise). */
  growing: boolean;
}

export interface MemoryModel {
  /** Counter-emitting thread (the renderer's main document/main thread). */
  tid: number | undefined;
  /** Counter span analyzed, ms. */
  spanMs: number;
  /** Counter samples on that thread. */
  sampleCount: number;
  /** JS heap used — trend measured on the post-GC floor (bytes). */
  heap: CounterTrend;
  /** Registered DOM event listeners — a monotonic climb is the classic leak. */
  listeners: CounterTrend;
  /** DOM node count — rises when detached nodes accumulate. */
  nodes: CounterTrend;
  /** Document count — rises when detached documents / iframes are retained. */
  documents: CounterTrend;
  /** True when any tracked counter is growing. */
  growing: boolean;
  /**
   * JS hottest across the counter span while memory grew: a lead on where the
   * retained allocations / listener registrations come from. A correlation, not
   * proof — confirm with a heap snapshot. Empty without a CPU profile or growth.
   */
  suspects: WindowedSuspect[];
}

export interface MemoryModelOptions {
  warmupEndUs?: number;
  /** Renderer process id, to ignore other processes' counters. */
  mainPid?: number;
  topSuspects?: number;
}

/** True for the DevTools memory-counter instant events. */
export function isCounterEvent(event: TraceEvent): boolean {
  return event.name === 'UpdateCounters' && event.ph === 'I';
}

/** The counters we surface, in report order. */
const COUNTERS = ['jsHeapSizeUsed', 'jsEventListeners', 'nodes', 'documents'] as const;
type CounterKey = (typeof COUNTERS)[number];

/** Floor is sampled in this many time buckets to isolate it from the GC sawtooth. */
const FLOOR_BUCKETS = 16;
/** Below this floor span we don't have enough time to call a trend (s). */
const MIN_SPAN_S = 3;

interface Sample {
  ts: number;
  value: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Simple linear regression of value-over-time: slope (per µs) and R². */
function regress(pts: Sample[]): { slopePerUs: number; r2: number } {
  const n = pts.length;
  if (n < 2) return { slopePerUs: 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.ts;
    sy += p.value;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  let sst = 0;
  for (const p of pts) {
    const dx = p.ts - mx;
    const dy = p.value - my;
    num += dx * dy;
    den += dx * dx;
    sst += dy * dy;
  }
  const slopePerUs = den > 0 ? num / den : 0;
  const r2 = den > 0 && sst > 0 ? (num * num) / (den * sst) : 0;
  return { slopePerUs, r2 };
}

/**
 * The lower envelope of a sawtoothing series: split the span into buckets and
 * keep each bucket's minimum. For the heap this is the post-GC floor — the live
 * set the collector couldn't reclaim — with the allocate-then-collect sawtooth
 * removed. For monotonic counters it collapses to (near) the raw series.
 */
function floorPoints(samples: Sample[]): Sample[] {
  const n = samples.length;
  if (n === 0) return [];
  const t0 = samples[0]!.ts;
  const span = samples[n - 1]!.ts - t0;
  if (span <= 0) return samples.slice();
  const mins: Sample[] = [];
  let bucket = 0;
  let mn = Infinity;
  let mnTs = t0;
  for (const s of samples) {
    // Which bucket does this sample fall in? (last bucket is closed on the right)
    const b = Math.min(
      FLOOR_BUCKETS - 1,
      Math.floor(((s.ts - t0) / span) * FLOOR_BUCKETS),
    );
    if (b !== bucket) {
      if (mn !== Infinity) mins.push({ ts: mnTs, value: mn });
      bucket = b;
      mn = Infinity;
    }
    if (s.value < mn) {
      mn = s.value;
      mnTs = s.ts;
    }
  }
  if (mn !== Infinity) mins.push({ ts: mnTs, value: mn });
  return mins;
}

/**
 * Does this counter's floor rise clear the "this is real, not noise" bar?
 *
 * `slopePerSec > 0` and a decent `r2` come first, so a *decreasing* or noisy
 * series can never flag (the discriminator that keeps a heap being reclaimed —
 * pile-up-poker — from reading as a leak). The heap is the primary signal;
 * listeners/nodes only flag on an egregious climb so ordinary per-frame churn in
 * a short capture doesn't masquerade as a leak.
 */
function isGrowing(
  counter: string,
  growth: number,
  base: number,
  slopePerSec: number,
  r2: number,
  spanS: number,
): boolean {
  if (spanS < MIN_SPAN_S || growth <= 0 || slopePerSec <= 0) return false;
  if (counter === 'jsHeapSizeUsed') {
    const mbPerMin = (slopePerSec * 60) / 1e6;
    const grewMB = growth / 1e6;
    // Climbed a real amount (≥5MB and ≥10% over the floor), steadily (R²≥0.5),
    // fast enough to matter (≥6MB/min) — well under all three traces' real rates.
    return grewMB >= 5 && growth >= base * 0.1 && mbPerMin >= 6 && r2 >= 0.5;
  }
  if (counter === 'documents') {
    // Documents rarely move; a sustained climb of even a couple is a retained-iframe leak.
    return growth >= 2 && r2 >= 0.5;
  }
  // listeners / nodes: only an egregious, steady climb — a large absolute rise
  // that also ≈quadruples the floor — flags on its own. (When the heap is also
  // growing, these still surface as the more diagnostic "kind" in the verdict.)
  return r2 >= 0.6 && growth >= 2000 && growth >= base * 3;
}

function buildTrend(counter: CounterKey, samples: Sample[]): CounterTrend {
  const first = samples[0]?.value ?? 0;
  const last = samples[samples.length - 1]?.value ?? 0;
  let min = first;
  let max = first;
  for (const s of samples) {
    if (s.value < min) min = s.value;
    if (s.value > max) max = s.value;
  }

  // Work on the floor (lower envelope) for every counter: for the heap it strips
  // the GC sawtooth, and for any counter the per-bucket minimum absorbs a leading
  // cleanup drop (recording started mid-activity) into the first bucket. Then
  // regress the WHOLE floor — robust to both a leading transient and a mid-series
  // dip, where regressing only from the global minimum would read a later rebound
  // as growth.
  const floor = floorPoints(samples);
  const { slopePerUs, r2 } = regress(floor);
  const slopePerSec = slopePerUs * 1e6;
  // Observed climb from the low point — internally consistent with `min → last`.
  const growth = last - min;
  const spanS = ((floor[floor.length - 1]?.ts ?? 0) - (floor[0]?.ts ?? 0) || 0) / 1e6;

  return {
    first,
    last,
    min,
    max,
    slopePerSec,
    r2,
    growth,
    growing: isGrowing(counter, growth, min, slopePerSec, r2, spanS),
  };
}

export function buildMemoryModel(
  events: TraceEvent[],
  profiles: RawProfile[],
  options: MemoryModelOptions,
): MemoryModel | null {
  const { mainPid } = options;
  const warmupEndUs = Math.max(options.warmupEndUs ?? 0, 0);
  const inProcess = (e: TraceEvent) => mainPid === undefined || e.pid === mainPid;

  // Counters are emitted per isolate/document; bucket valid samples by thread so
  // we analyze one coherent series, then pick the busiest (the main document).
  const byTid = new Map<number, Map<CounterKey, Sample[]>>();
  for (const e of events) {
    if (!inProcess(e) || typeof e.tid !== 'number' || e.ts < warmupEndUs) continue;
    const data = asRecord(asRecord(e.args)?.['data']);
    if (!data || typeof data['jsHeapSizeUsed'] !== 'number') continue;
    let series = byTid.get(e.tid);
    if (!series) byTid.set(e.tid, (series = new Map<CounterKey, Sample[]>()));
    for (const c of COUNTERS) {
      const v = data[c];
      if (typeof v !== 'number') continue;
      let arr = series.get(c);
      if (!arr) series.set(c, (arr = [] as Sample[]));
      arr.push({ ts: e.ts, value: v });
    }
  }

  let mainTid: number | undefined;
  let best = -1;
  for (const [tid, series] of byTid) {
    const n = series.get('jsHeapSizeUsed')?.length ?? 0;
    if (n > best) {
      best = n;
      mainTid = tid;
    }
  }
  const series = mainTid !== undefined ? byTid.get(mainTid) : undefined;
  const heapSamples = series?.get('jsHeapSizeUsed');
  // Need a handful of samples to say anything; fewer means the Memory box was off
  // (the counters carry no `data`) or the window is too short to model.
  if (!heapSamples || heapSamples.length < 4) return null;
  for (const s of series!.values()) s.sort((a, b) => a.ts - b.ts);

  const trend = (c: CounterKey) => buildTrend(c, series!.get(c) ?? []);
  const heap = trend('jsHeapSizeUsed');
  const listeners = trend('jsEventListeners');
  const nodes = trend('nodes');
  const documents = trend('documents');
  const growing = [heap, listeners, nodes, documents].some((t) => t.growing);

  const firstTs = heapSamples[0]!.ts;
  const lastTs = heapSamples[heapSamples.length - 1]!.ts;

  // Lead attribution: what JS was running across the (growing) counter span.
  // Reuse the windowed-self-time engine the GC/reflow models use.
  let suspects: WindowedSuspect[] = [];
  if (growing) {
    suspects = attributeWindowedSelfTime(
      profiles,
      [{ startUs: Math.max(firstTs, warmupEndUs), endUs: lastTs }],
      {
        ...(options.warmupEndUs !== undefined
          ? { warmupEndUs: options.warmupEndUs }
          : {}),
        ...(mainPid !== undefined ? { mainPid } : {}),
        top: options.topSuspects ?? 10,
      },
    );
  }
  return {
    tid: mainTid,
    spanMs: (lastTs - firstTs) / 1000,
    sampleCount: heapSamples.length,
    heap,
    listeners,
    nodes,
    documents,
    growing,
    suspects,
  };
}
