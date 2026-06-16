import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { streamTraceEvents } from '../src/stream.ts';
import { scanTrace } from '../src/reduce.ts';

// A miniature DevTools-shaped trace: pretty-printed metadata preamble, then
// one event per line — plus one event deliberately split across two lines to
// exercise the multi-line accumulation path.
const TRACE = `{"metadata": {
  "source": "DevTools",
  "startTime": "2026-06-16T00:00:00.000Z"
},
"traceEvents": [
{"cat":"__metadata","name":"process_name","ph":"M","ts":0,"pid":1,"tid":1},
{"cat":"devtools.timeline","name":"RunTask","ph":"X","ts":1000,"dur":5000},
{"cat":"disabled-by-default-v8.inspector","name":"V8Console::runTask","ph":"X","ts":1500,"dur":10},
{"cat":"devtools.timeline","name":"FunctionCall",
"ph":"X","ts":3000,"dur":2000},
{"cat":"blink.user_timing","name":"measure:render","ph":"X","ts":9000,"dur":100}
]}
`;

let dir: string;
async function fixture(name: string, bytes: Buffer | string): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'perftale-'));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

afterAll(() => {
  // temp dir is left for the OS to reap; nothing to assert on cleanup
});

describe('streamTraceEvents', () => {
  it('parses every event, including one that spans lines', async () => {
    const path = await fixture('trace.json', TRACE);
    const names: string[] = [];
    for await (const e of streamTraceEvents(path)) names.push(e.name ?? '');
    expect(names).toEqual([
      'process_name',
      'RunTask',
      'V8Console::runTask',
      'FunctionCall',
      'measure:render',
    ]);
  });

  it('reads gzipped traces identically', async () => {
    const path = await fixture('trace.json.gz', gzipSync(Buffer.from(TRACE)));
    const names: string[] = [];
    for await (const e of streamTraceEvents(path)) names.push(e.name ?? '');
    expect(names).toContain('FunctionCall');
    expect(names).toHaveLength(5);
  });
});

describe('scanTrace', () => {
  it('drops noise and keeps signal, with a deterministic report', async () => {
    const path = await fixture('scan.json', TRACE);
    const stats = await scanTrace(path);

    expect(stats.total).toBe(5);
    expect(stats.kept).toBe(3); // RunTask, FunctionCall, measure:render
    expect(stats.dropped).toBe(2); // __metadata + inspector
    expect(stats.droppedByReason).toEqual({
      inspector: 1,
      metadata: 1,
      'source-rundown': 0,
    });
    expect(stats.keptByCategory).toEqual([
      { cat: 'devtools.timeline', count: 2 },
      { cat: 'blink.user_timing', count: 1 },
    ]);
    // kept timeline span: ts 1000 → 9000 microseconds = 8ms
    expect(stats.timeSpanMs).toBe(8);
  });

  it('produces byte-identical stats across runs (determinism guard)', async () => {
    const path = await fixture('determinism.json', TRACE);
    const a = JSON.stringify(await scanTrace(path));
    const b = JSON.stringify(await scanTrace(path));
    expect(a).toBe(b);
  });
});
