import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTrace } from '../src/analyze.ts';
import { renderReport } from '../src/report.ts';

// Lock the human-facing text report against the committed fixtures. Rendered
// with color:false so the snapshot is plain text (no ANSI), and with the bare
// filename so the header line is machine-independent. If the format changes on
// purpose, `vitest -u` and review the diff — that diff is the format review.

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.trace.json.gz'));

/** A bare ANSI SGR start sequence (ESC + '['), built without a literal escape. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

describe('renderReport', () => {
  for (const trace of fixtures) {
    it(`${trace} renders a stable default report`, async () => {
      const analysis = await analyzeTrace(join(FIXTURE_DIR, trace));
      expect(renderReport(trace, analysis, { color: false })).toMatchSnapshot();
    });

    it(`${trace} renders a stable --debug report`, async () => {
      const analysis = await analyzeTrace(join(FIXTURE_DIR, trace));
      expect(
        renderReport(trace, analysis, { color: false, debug: true, elapsedMs: 0 }),
      ).toMatchSnapshot();
    });
  }

  it('emits ANSI only when color is enabled', async () => {
    const trace = fixtures[0];
    if (!trace) throw new Error('no fixtures');
    const analysis = await analyzeTrace(join(FIXTURE_DIR, trace));
    expect(ANSI.test(renderReport(trace, analysis, { color: false }))).toBe(false);
    expect(ANSI.test(renderReport(trace, analysis, { color: true }))).toBe(true);
  });
});
