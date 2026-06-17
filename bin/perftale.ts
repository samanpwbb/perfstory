#!/usr/bin/env node
/**
 * perftale CLI.
 *
 * `analyze <trace.json[.gz]> [--fps <n>] [--debug] [--out <path>|--json]`
 * streams the trace once and prints the frame + JS models. The default report
 * is consumer-facing (smoothness verdict + where the budget goes); `--debug`
 * adds the pipeline's own diagnostics. `--out`/`--json` also persist the
 * structured summary for an agent (or a later run) to read back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pc from 'picocolors';
import { analyzeTrace } from '../src/analyze.ts';
import { renderReport } from '../src/report.ts';
import { buildSummary, serializeSummary } from '../src/summary.ts';

const USAGE = `perftale — Chrome trace → actionable insights

Usage:
  perftale analyze <trace.json[.gz]> [--fps <n>] [--debug] [--out <path>|--json]

  --fps <n>     override the detected refresh rate
  --debug       include pipeline diagnostics (noise reduction, latency, clusters)
  --out <path>  write the structured summary JSON to <path>
  --json        write the summary JSON to .perftale/<trace>.summary.json
`;

/** Default artifact path for --json: .perftale/<trace-basename>.summary.json */
function defaultOutPath(file: string): string {
  const stem = basename(file).replace(/\.json(\.gz)?$/i, '');
  return join('.perftale', `${stem}.summary.json`);
}

interface Args {
  file?: string;
  fps?: number;
  debug: boolean;
  out?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { debug: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fps') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) result.fps = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (value) result.out = value;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--debug') {
      result.debug = true;
    } else if (arg && !arg.startsWith('-') && result.file === undefined) {
      result.file = arg;
    }
  }
  return result;
}

const [command, ...rest] = process.argv.slice(2);

if (command !== 'analyze') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { file, fps, debug, out, json } = parseArgs(rest);
if (!file) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const start = performance.now();
const analysis = await analyzeTrace(file, { ...(fps ? { fps } : {}) });
const elapsed = performance.now() - start;
process.stdout.write(
  renderReport(file, analysis, {
    debug,
    elapsedMs: elapsed,
    color: pc.isColorSupported,
  }) + '\n',
);

const outPath = out ?? (json ? defaultOutPath(file) : undefined);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeSummary(buildSummary(basename(file), analysis)));
  process.stderr.write(`summary written to ${outPath}\n`);
}
