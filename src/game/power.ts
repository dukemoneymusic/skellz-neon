/**
 * The swinging power meter.
 *
 * Holding down starts the bar sweeping up and down on its own; letting go fires
 * at whatever it reads at that instant. Kept as a pure function of elapsed time
 * so the behaviour can be tested without a browser.
 */

/** One full up-and-down sweep. Slow enough to catch the level you want. */
export const POWER_CYCLE_MS = 2600;

/** The bottom of the swing — a light touch, never a dead shot. */
export const MIN_CHARGE = 0.04;

/**
 * Meter reading after `elapsed` ms of holding: a triangle wave that climbs
 * from MIN_CHARGE to full over the first half of the cycle and falls back over
 * the second.
 */
export function powerAt(elapsedMs: number): number {
  const phase = ((elapsedMs % POWER_CYCLE_MS) + POWER_CYCLE_MS) % POWER_CYCLE_MS;
  const t = phase / POWER_CYCLE_MS;
  const swing = t < 0.5 ? t * 2 : 2 - t * 2;
  return MIN_CHARGE + (1 - MIN_CHARGE) * swing;
}
