#!/usr/bin/env node
/**
 * Local-only tool: clip a large, gitignored real trace down to a small,
 * COMMITTED fixture under test/fixtures/. The integration test runs the full
 * analyze pipeline against these fixtures, so they must be self-contained and
 * reproduce a realistic verdict without the multi-MB originals.
 *
 * Two things keep the fixture small without changing what the pipeline sees:
 *
 *  1. Coherent prefix. We take a time-bounded *prefix* of the event stream, so
 *     every CPU-profile sample we keep is backed by the node definitions from
 *     the earlier chunks we also keep. Inspector/source-rundown noise (the bulk
 *     of a real trace) is capped to a handful so the reducer still has
 *     something to drop, without bloating the fixture.
 *
 *  2. Slimming. The analysis reads `args` for only a few event names
 *     (SendBeginMainFrameToCommit, Profile, ProfileChunk). Every other event is
 *     kept for its category/timing alone, so we drop its `args` — that is where
 *     the weight lives (screenshot PNGs, layout/paint payloads). And inside the
 *     CPU profile, attribution only ever looks up the *sampled* (leaf) node, so
 *     node definitions whose id is never sampled are pruned. Neither change can
 *     alter the analysis, only shrink the file.
 *
 * The output is gzipped when the path ends in `.gz` — the streamer reads both,
 * and a gzipped trace keeps the committed fixture small.
 *
 *   node scripts/make-fixture.ts <input.json.gz> <output.trace.json[.gz]> <windowMs>
 */
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { classifyNoise } from '../src/filter.ts';
import { streamTraceEvents } from '../src/stream.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const [input, output, windowArg] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: make-fixture <input> <output.trace.json> [windowMs]\n');
  process.exit(1);
}
const windowMs = Number(windowArg ?? 1500);
const NOISE_CAP: Record<string, number> = {
  inspector: 200,
  metadata: 50,
  'source-rundown': 40,
};

/** Reduce an event to only the fields the analysis pipeline consumes. */
function slim(e: TraceEvent): TraceEvent {
  const out: TraceEvent = { ph: e.ph, ts: e.ts };
  if (e.name !== undefined) out.name = e.name;
  if (e.cat !== undefined) out.cat = e.cat;
  if (typeof e.dur === 'number') out.dur = e.dur;
  if (typeof e.pid === 'number') out.pid = e.pid;
  if (typeof e.tid === 'number') out.tid = e.tid;
  if (e.id !== undefined) out.id = e.id;
  if (e.id2 !== undefined) out.id2 = e.id2;
  if (e.s !== undefined) out.s = e.s;

  // Keep only the args sub-trees the models actually read.
  const args = e.args;
  if (args) {
    if (e.name === 'SendBeginMainFrameToCommit') {
      const bd = args['send_begin_mainframe_to_commit_breakdown'];
      if (bd) out.args = { send_begin_mainframe_to_commit_breakdown: bd };
    } else if (e.name === 'Profile') {
      const data = args['data'] as Record<string, unknown> | undefined;
      if (data) out.args = { data: { startTime: data['startTime'] } };
    } else if (e.name === 'ProfileChunk') {
      const data = args['data'] as Record<string, unknown> | undefined;
      if (data) {
        out.args = {
          data: { cpuProfile: data['cpuProfile'], timeDeltas: data['timeDeltas'] },
        };
      }
    }
  }
  return out;
}

// Pass 1: find the time origin (earliest real timeline timestamp).
let originUs = Infinity;
for await (const e of streamTraceEvents(input)) {
  if (
    typeof e.ts === 'number' &&
    e.ts > 0 &&
    (e.ph === 'X' || e.ph === 'I' || e.ph === 'b')
  ) {
    if (e.ts < originUs) originUs = e.ts;
  }
}
const cutoffUs = originUs + windowMs * 1000;

// Pass 2: collect a coherent prefix slice, slimmed.
const kept: TraceEvent[] = [];
const noiseSeen: Record<string, number> = {};
let keptSignal = 0;
let keptNoise = 0;
for await (const e of streamTraceEvents(input)) {
  const inWindow = typeof e.ts !== 'number' || e.ts <= cutoffUs;
  if (!inWindow) continue;
  const reason = classifyNoise(e);
  if (reason === null) {
    kept.push(slim(e));
    keptSignal++;
  } else {
    const seen = noiseSeen[reason] ?? 0;
    if (seen < (NOISE_CAP[reason] ?? 0)) {
      noiseSeen[reason] = seen + 1;
      kept.push(slim(e));
      keptNoise++;
    }
  }
}

// Prune CPU-profile nodes that are never sampled. Node ids are unique within a
// profile (pid:id), so we gather the sampled-id set per profile, then keep only
// node definitions whose id appears in it.
const sampledByProfile = new Map<string, Set<number>>();
const profileKey = (e: TraceEvent) => `${e.pid ?? '?'}:${String(e.id ?? '?')}`;
type CpuProfile = { nodes?: { id?: number }[]; samples?: number[] };
const cpuProfileOf = (e: TraceEvent) =>
  (e.args?.['data'] as { cpuProfile?: CpuProfile } | undefined)?.cpuProfile;

for (const e of kept) {
  if (e.name !== 'ProfileChunk') continue;
  const samples = cpuProfileOf(e)?.samples;
  if (!Array.isArray(samples)) continue;
  const key = profileKey(e);
  let set = sampledByProfile.get(key);
  if (!set) sampledByProfile.set(key, (set = new Set()));
  for (const s of samples) set.add(s);
}
let nodesBefore = 0;
let nodesAfter = 0;
for (const e of kept) {
  if (e.name !== 'ProfileChunk') continue;
  const cpu = cpuProfileOf(e);
  if (!cpu || !Array.isArray(cpu.nodes)) continue;
  const sampled = sampledByProfile.get(profileKey(e)) ?? new Set<number>();
  nodesBefore += cpu.nodes.length;
  cpu.nodes = cpu.nodes.filter((n) => n.id !== undefined && sampled.has(n.id));
  nodesAfter += cpu.nodes.length;
}

// Write in the DevTools shape the streamer expects: pretty metadata preamble,
// then one compact event per line inside traceEvents.
function* body(): Generator<string> {
  yield '{\n  "metadata": {\n    "source": "DevTools",\n';
  yield `    "dataOrigin": "clip of ${input} — first ${windowMs}ms, noise-capped"\n`;
  yield '  },\n  "traceEvents": [\n';
  for (let i = 0; i < kept.length; i++) {
    yield JSON.stringify(kept[i]) + (i === kept.length - 1 ? '\n' : ',\n');
  }
  yield '  ]\n}\n';
}

const sink = createWriteStream(output);
if (output.endsWith('.gz')) {
  await pipeline(Readable.from(body()), createGzip(), sink);
} else {
  await pipeline(Readable.from(body()), sink);
}

process.stderr.write(
  `wrote ${output}: ${kept.length} events (${keptSignal} signal, ${keptNoise} noise), ` +
    `window ${windowMs}ms, profile nodes ${nodesBefore}→${nodesAfter}, ` +
    `noise=${JSON.stringify(noiseSeen)}\n`,
);
