import { describe, expect, it } from 'vitest';
import { classifyNoise, isSignal } from '../src/filter.ts';
import type { TraceEvent } from '../src/trace-events.ts';

const ev = (cat: string, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  ph: 'X',
  ts: 0,
  cat,
  ...extra,
});

describe('classifyNoise', () => {
  it('drops v8 inspector bookkeeping (the bulk of real traces)', () => {
    expect(classifyNoise(ev('disabled-by-default-v8.inspector'))).toBe('inspector');
    // category lists that merely include the inspector token also drop
    expect(
      classifyNoise(
        ev('disabled-by-default-v8.inspector,disabled-by-default-v8.stack_trace'),
      ),
    ).toBe('inspector');
  });

  it('drops process/thread metadata and source-rundown dictionaries', () => {
    expect(classifyNoise(ev('__metadata'))).toBe('metadata');
    expect(classifyNoise(ev('disabled-by-default-devtools.v8-source-rundown'))).toBe(
      'source-rundown',
    );
  });

  it('keeps the signal categories', () => {
    expect(classifyNoise(ev('devtools.timeline'))).toBeNull();
    expect(classifyNoise(ev('disabled-by-default-v8.cpu_profiler'))).toBeNull();
    expect(classifyNoise(ev('blink.user_timing'))).toBeNull();
    expect(
      classifyNoise(ev('cc,benchmark,disabled-by-default-devtools.timeline.frame')),
    ).toBeNull();
    expect(isSignal(ev('devtools.timeline'))).toBe(true);
    expect(isSignal(ev('disabled-by-default-v8.inspector'))).toBe(false);
  });
});
