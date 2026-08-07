import { LEVELS, PANELS, boxByNumber, frictionFor, panelCenter } from "./board";
import { MAX_LAUNCH, isArmed, routeTarget, type Cap, type GameState, type ShotInput } from "./sim";

/**
 * CPU opponents.
 *
 * The bot is resolved on the SERVER and the resulting {angle, power} is stored
 * in `lastShot`, so every connected client replays the identical deterministic
 * physics — nobody has to be "the host running the AI" for CPUs to take their
 * turn, and no two clients can ever disagree about what a bot did.
 */

/**
 * How far a top slides for a given launch speed.
 *
 * The sim decays velocity by e^(-friction·dt) every tick, so the path is a
 * decaying exponential and the total distance converges to v0 / friction.
 * Inverting that gives the launch speed needed to stop on a chosen spot.
 */
function powerForDistance(dist: number, friction: number): number {
  const v0 = dist * friction;
  return clamp(v0 / MAX_LAUNCH, 0.012, 1);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Squared distance — fine for comparisons, avoids the sqrt. */
function dist2(ax: number, az: number, bx: number, bz: number) {
  return (ax - bx) ** 2 + (az - bz) ** 2;
}

type Aim = { x: number; z: number; why: string };

/**
 * Pick the spot this bot wants its top to come to rest on.
 *
 * Priority:
 *  1. KILLA — hunt the closest living enemy top.
 *  2. An enemy pinned in the middle — knocking them out is worth 2/4/6/8
 *     boxes of instant progress, far more than a normal box.
 *  3. Otherwise run your own route: the middle, or your next numbered box.
 */
function chooseAim(state: GameState, cap: Cap, teamMode: boolean): Aim {
  const enemies = state.caps.filter(
    (c) => c.alive && c.id !== cap.id && !(teamMode && c.team === cap.team),
  );

  if (cap.killer) {
    let best: Cap | null = null;
    let bestD = Infinity;
    for (const e of enemies) {
      const d = dist2(cap.x, cap.z, e.x, e.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    // No enemy left to hunt (solo story run) — sit on the middle.
    if (best) return { x: best.x, z: best.z, why: `hunting ${best.name}` };
    return { x: 0, z: 0, why: "holding the middle" };
  }

  // Freeing a stuck enemy pays 2–8 boxes, so it beats a single box outright —
  // but only once this bot is armed (before box 1, touching a top is a foul).
  if (isArmed(cap)) {
    let bestStuck: Cap | null = null;
    let bestValue = 0;
    for (const e of enemies) {
      if (!e.stuck) continue;
      const worth = e.stuckValue || 2;
      if (worth > bestValue) {
        bestValue = worth;
        bestStuck = e;
      }
    }
    if (bestStuck) return { x: bestStuck.x, z: bestStuck.z, why: `knocking ${bestStuck.name} out of the ${bestValue}` };
  }

  const target = routeTarget(cap);
  if (target === null) return { x: 0, z: 0, why: "holding the middle" };

  // On the break from START, bots aim for a middle PANEL (2/4/6/8), never
  // dead-centre 13 — landing in a panel starts their run from box 3, and a
  // panel is a far bigger, more forgiving target than the tiny 13 box. Pick the
  // panel whose centre is closest to the bot's line in.
  if (cap.step === 0) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    let bestV = 0;
    for (const p of PANELS) {
      const [px, pz] = panelCenter(p.v);
      const d = dist2(cap.x, cap.z, px, pz);
      if (d < bestD) {
        bestD = d;
        best = [px, pz];
        bestV = p.v;
      }
    }
    if (best) return { x: best[0], z: best[1], why: `breaking for the ${bestV}` };
  }

  if (target === 13) return { x: 0, z: 0, why: "going for the middle" };
  const box = boxByNumber(target);
  if (!box) return { x: 0, z: 0, why: "going for the middle" };
  return { x: box.x, z: box.z, why: `going for box ${target}` };
}

/**
 * How sloppy a CPU is. Level 0 bots spray wildly; by the last borough they
 * are nearly surgical, which is what makes the campaign ramp up.
 */
export function botSpread(levelIdx: number): number {
  const last = Math.max(1, LEVELS.length - 1);
  const easiness = clamp(1 - levelIdx / last, 0, 1);
  return 0.1 + 4.0 * easiness;
}

export type BotShot = ShotInput & { why: string };

/**
 * Work out the shot a CPU takes this turn. Pure apart from the deliberate
 * aiming error, which is drawn from `rng` (injectable so tests can pin it).
 */
export function computeBotShot(
  state: GameState,
  cap: Cap,
  levelIdx: number,
  teamMode: boolean,
  rng: () => number = Math.random,
): BotShot {
  const aim = chooseAim(state, cap, teamMode);
  const spread = botSpread(levelIdx);

  // Aiming error: the bot picks a spot near — not exactly on — its target.
  const jitterX = (rng() - 0.5) * spread;
  const jitterZ = (rng() - 0.5) * spread;

  const dx = aim.x - cap.x + jitterX;
  const dz = aim.z - cap.z + jitterZ;
  const dist = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);

  const friction = frictionFor(levelIdx);
  // Aim to stop dead on the target, then add a little judgement error to the
  // strength as well, so bots also over- and under-hit rather than only
  // mis-aiming. When going for a top, lean slightly long so contact is made.
  const chasingTop = aim.why.startsWith("hunting") || aim.why.startsWith("knocking");
  const strengthError = 1 + (rng() - 0.5) * 0.12 * (spread / 4.1) + (chasingTop ? 0.14 : 0);
  const power = clamp(powerForDistance(dist, friction) * strengthError, 0.012, 1);

  // A pinned top may only tap out of the middle — the sim clamps this too, but
  // matching it here keeps the bot's own intent honest.
  return { angle, power: cap.stuck ? Math.min(power, 0.3) : power, why: aim.why };
}

/** Where this cap's own route wants it to go: the middle, a break panel, or a box. */
function routeAim(cap: Cap): Aim {
  const target = routeTarget(cap);
  if (target === null) return { x: 0, z: 0, why: "the middle" };
  if (cap.step === 0) {
    // On the break, go for the nearest 2·4·6·8 panel (starts the run from box 3).
    let best: [number, number] | null = null;
    let bestD = Infinity;
    let bestV = 0;
    for (const p of PANELS) {
      const [px, pz] = panelCenter(p.v);
      const d = dist2(cap.x, cap.z, px, pz);
      if (d < bestD) {
        bestD = d;
        best = [px, pz];
        bestV = p.v;
      }
    }
    if (best) return { x: best[0], z: best[1], why: `the ${bestV}` };
  }
  if (target === 13) return { x: 0, z: 0, why: "the middle" };
  const box = boxByNumber(target);
  return box ? { x: box.x, z: box.z, why: `box ${target}` } : { x: 0, z: 0, why: "the middle" };
}

/**
 * The shot taken when a real player's 45s clock runs out. Deliberately NOT
 * surgical — it's a coin flip between going for your own box and taking a swing
 * at an opponent, and either one carries enough scatter that it lands roughly
 * half the time. So a timeout can whiff the box, or aim at a rival top and miss.
 *
 * Guardrails: before you've made box 1 a top-hit is an illegal strike, so an
 * un-armed cap only ever goes for the box; a killa (whose whole job is hunting)
 * always swings at a top. The randomness is drawn once on the server and stored
 * in lastShot, so every client replays the same deterministic result.
 */
export function computeAutoShot(
  state: GameState,
  cap: Cap,
  levelIdx: number,
  teamMode: boolean,
  rng: () => number = Math.random,
): BotShot {
  const armed = isArmed(cap);
  let opp: Cap | null = null;
  let bestD = Infinity;
  for (const e of state.caps) {
    if (!e.alive || !e.onBoard || e.id === cap.id) continue;
    if (teamMode && e.team === cap.team) continue;
    const d = dist2(cap.x, cap.z, e.x, e.z);
    if (d < bestD) {
      bestD = d;
      opp = e;
    }
  }

  // Coin flip: box vs. opponent (with the guardrails above).
  const goForTop = armed && !!opp && (cap.killer || rng() < 0.5);
  let aim: Aim;
  if (goForTop && opp) {
    aim = { x: opp.x, z: opp.z, why: `auto-shot at ${opp.name}` };
  } else {
    const r = routeAim(cap);
    aim = { x: r.x, z: r.z, why: `auto-shot for ${r.why}` };
  }

  // Enough scatter that it genuinely misses about half the time.
  const err = 2.4;
  const dx = aim.x - cap.x + (rng() * 2 - 1) * err;
  const dz = aim.z - cap.z + (rng() * 2 - 1) * err;
  const dist = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);

  const friction = frictionFor(levelIdx);
  // Swinging at a top: lean a little long so it can actually make contact.
  // Going for a box: aim to stop on it. Plus a dash of strength scatter.
  const reach = goForTop ? 1.12 : 1.0;
  const strengthError = 1 + (rng() * 2 - 1) * 0.16;
  const power = clamp(powerForDistance(dist, friction) * reach * strengthError, 0.05, 1);

  return { angle, power: cap.stuck ? Math.min(power, 0.3) : power, why: aim.why };
}
