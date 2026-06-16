import { describe, expect, it } from 'vitest';
import { PERFTALE, frameBudgetMs } from '../src/index.ts';

describe('perftale scaffold', () => {
  it('exposes its name', () => {
    expect(PERFTALE).toBe('perftale');
  });

  it('computes frame budgets for common refresh rates', () => {
    expect(frameBudgetMs(60)).toBeCloseTo(16.667, 3);
    expect(frameBudgetMs(120)).toBeCloseTo(8.333, 3);
  });

  it('rejects nonsensical refresh rates', () => {
    expect(() => frameBudgetMs(0)).toThrow(RangeError);
    expect(() => frameBudgetMs(-30)).toThrow(RangeError);
    expect(() => frameBudgetMs(Number.NaN)).toThrow(RangeError);
  });

  // Demonstrates the golden/snapshot loop the reducer will lean on.
  it('matches the snapshot of common budgets', () => {
    const budgets = [30, 60, 90, 120].map((fps) => ({
      fps,
      budgetMs: Number(frameBudgetMs(fps).toFixed(3)),
    }));
    expect(budgets).toMatchSnapshot();
  });
});
