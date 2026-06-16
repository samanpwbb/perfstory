/**
 * perftale — turn a Chrome performance trace into actionable insights for
 * animation- and interaction-heavy apps.
 *
 * Step 0 placeholder: just enough real surface to prove the toolchain + tests.
 * The streaming reducer, frame model, JS attribution, and summary land in
 * later steps.
 */

export const PERFTALE = 'perftale';

/**
 * Per-frame time budget in milliseconds for a given refresh rate.
 * 60fps → 16.67ms, 120fps → 8.33ms. A frame whose work exceeds this is jank.
 */
export function frameBudgetMs(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`fps must be a positive finite number, got ${fps}`);
  }
  return 1000 / fps;
}
