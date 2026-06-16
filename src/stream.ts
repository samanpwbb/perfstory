import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { TraceEvent } from './trace-events.ts';

/**
 * Stream the `traceEvents` array of a Chrome trace without ever holding the
 * whole file (or the whole array) in memory.
 *
 * DevTools writes the trace as `{ "metadata": {...}, "traceEvents": [ ... ] }`
 * with the metadata pretty-printed and then one event object per line inside
 * the array. We lean on that one-event-per-line layout for speed, but stay
 * correct if an event ever spans lines: we accumulate until the buffer parses
 * as JSON.
 *
 * Works on both `.json` and gzipped `.json.gz` inputs.
 */
export async function* streamTraceEvents(filePath: string): AsyncGenerator<TraceEvent> {
  const raw = createReadStream(filePath);
  const decoded = filePath.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });

  let inArray = false;
  let pending = '';

  for await (const rawLine of lines) {
    let line = rawLine;

    if (!inArray) {
      // Skip the metadata preamble until the traceEvents array opens.
      const key = line.indexOf('"traceEvents"');
      if (key === -1) continue;
      const open = line.indexOf('[', key);
      if (open === -1) continue;
      inArray = true;
      line = line.slice(open + 1); // keep anything after the '['
    }

    pending += line;
    const trimmed = pending.trim();
    if (trimmed === '') {
      pending = '';
      continue;
    }
    // Closing bracket of the array (possibly followed by the root's `}`).
    if (trimmed[0] === ']') return;

    // Each array element is `{...}` or `{...},`. Drop one trailing comma.
    const candidate = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    try {
      const event = JSON.parse(candidate) as TraceEvent;
      pending = '';
      if (event && typeof event === 'object') yield event;
    } catch {
      // Incomplete — this event spans multiple lines. Keep accumulating.
      pending += '\n';
    }
  }
}
