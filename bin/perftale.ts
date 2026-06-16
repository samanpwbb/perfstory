#!/usr/bin/env node
/**
 * perftale CLI.
 *
 * Step 1: `analyze <trace.json[.gz]>` streams the trace, applies the noise
 * filter, and reports the size collapse. The frame model, JS attribution, and
 * full summary land in later steps.
 */
import { scanTrace, type ReductionStats } from '../src/reduce.ts';

const USAGE = `perftale — Chrome trace → actionable insights

Usage:
  perftale analyze <trace.json[.gz]>
`;

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function report(file: string, stats: ReductionStats, elapsedMs: number): string {
  const lines: string[] = [];
  lines.push(`perftale analyze — ${file}`);
  if (stats.timeSpanMs !== null) {
    lines.push(`  trace window:  ${(stats.timeSpanMs / 1000).toFixed(1)}s`);
  }
  lines.push(
    `  events:        ${stats.total.toLocaleString()} total → ` +
      `${stats.kept.toLocaleString()} kept (${pct(stats.kept, stats.total)}), ` +
      `${stats.dropped.toLocaleString()} dropped (${pct(stats.dropped, stats.total)})`,
  );

  lines.push('  dropped as noise:');
  for (const [reason, count] of Object.entries(stats.droppedByReason)) {
    if (count > 0) lines.push(`    ${count.toLocaleString().padStart(10)}  ${reason}`);
  }

  lines.push('  kept, by category:');
  for (const { cat, count } of stats.keptByCategory) {
    lines.push(`    ${count.toLocaleString().padStart(10)}  ${cat || '(none)'}`);
  }

  lines.push(`  scanned in ${(elapsedMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

const [command, file] = process.argv.slice(2);

if (command !== 'analyze') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!file) {
  process.stderr.write('usage: perftale analyze <trace.json[.gz]>\n');
  process.exit(1);
}

const start = performance.now();
const stats = await scanTrace(file);
const elapsed = performance.now() - start;
process.stdout.write(report(file, stats, elapsed) + '\n');
