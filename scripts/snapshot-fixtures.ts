#!/usr/bin/env node
/**
 * Regenerate the golden summaries for the committed test fixtures.
 *
 * This reads only the small `test/fixtures/*.trace.json.gz` that ARE committed,
 * so it runs anywhere — no need for the huge, gitignored real traces. Run it
 * after a model change to refresh the goldens, then review the diff — that diff
 * is the human-readable record of how the change moved the numbers.
 * `test/integration.test.ts` asserts the pipeline reproduces them.
 *
 *   node scripts/snapshot-fixtures.ts
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeTrace } from '../src/analyze.ts';
import { buildSummary, serializeSummary } from '../src/summary.ts';

const dir = 'test/fixtures';
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.trace.json.gz'));
if (fixtures.length === 0) {
  process.stderr.write('no fixtures in test/fixtures — nothing to do\n');
  process.exit(1);
}

for (const trace of fixtures) {
  const summary = serializeSummary(
    buildSummary(trace, await analyzeTrace(join(dir, trace))),
  );
  const out = join(dir, trace.replace(/\.trace\.json\.gz$/, '.summary.json'));
  writeFileSync(out, summary);
  process.stdout.write(`wrote ${out}\n`);
}
