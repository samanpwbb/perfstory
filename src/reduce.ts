import { classifyNoise, type DropReason } from './filter.ts';
import { streamTraceEvents } from './stream.ts';

/** Deterministic summary of a single streaming pass over a trace. */
export interface ReductionStats {
  /** Total events seen in the traceEvents array. */
  total: number;
  /** Events kept as signal. */
  kept: number;
  /** Events dropped as noise. */
  dropped: number;
  /** Drop counts by reason. */
  droppedByReason: Record<DropReason, number>;
  /** Kept-event counts by category, highest first. */
  keptByCategory: { cat: string; count: number }[];
  /** Wall-clock span of kept timeline events, in milliseconds. */
  timeSpanMs: number | null;
}

/**
 * Stream a trace once, applying the noise filter, and report what was kept vs
 * dropped. This is the foundation the modeling steps build on, and on its own
 * it demonstrates the size collapse on large traces.
 */
export async function scanTrace(
  filePath: string,
  topCategories = 25,
): Promise<ReductionStats> {
  let total = 0;
  let kept = 0;
  const droppedByReason: Record<DropReason, number> = {
    inspector: 0,
    metadata: 0,
    'source-rundown': 0,
  };
  const keptCats = new Map<string, number>();
  let tsMin = Infinity;
  let tsMax = -Infinity;

  for await (const event of streamTraceEvents(filePath)) {
    total++;
    const reason = classifyNoise(event);
    if (reason !== null) {
      droppedByReason[reason]++;
      continue;
    }
    kept++;

    const cat = event.cat ?? '';
    keptCats.set(cat, (keptCats.get(cat) ?? 0) + 1);

    const { ts, ph } = event;
    if (typeof ts === 'number' && (ph === 'X' || ph === 'B' || ph === 'I')) {
      if (ts < tsMin) tsMin = ts;
      if (ts > tsMax) tsMax = ts;
    }
  }

  const keptByCategory = [...keptCats.entries()]
    .map(([cat, count]) => ({ cat, count }))
    // count desc, then category asc — fully deterministic ordering
    .sort((a, b) => b.count - a.count || (a.cat < b.cat ? -1 : 1))
    .slice(0, topCategories);

  return {
    total,
    kept,
    dropped: total - kept,
    droppedByReason,
    keptByCategory,
    timeSpanMs: tsMin <= tsMax ? (tsMax - tsMin) / 1000 : null,
  };
}
