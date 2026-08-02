import {
  ARMED_STEP,
  BACK_STEP,
  CAP_R,
  FINAL_STEP,
  OUT_LIMIT,
  RAIL,
  ROUTE,
  ROUTE_LEN,
  boxByNumber,
  frictionFor,
  killaPositionFor,
  legOf,
  panelValueAt,
  insideBox,
  startPositionFor,
} from "./board";

export { startPositionFor };

export type Cap = {
  id: string;
  name: string;
  color: string; // primary melted wax colour (player editable)
  color2: string; // second wax colour swirled into the same cap
  team: number;
  x: number;
  z: number;
  step: number; // index into ROUTE; ROUTE_LEN === killa
  killer: boolean;
  stuck: boolean;
  stuckValue: number; // 2 / 4 / 6 / 8 — what a rescuer collects
  triedBreak: boolean; // has this cap already missed at least one break shot?
  missedTarget: boolean; // missed at least one shot at the CURRENT target box
  alive: boolean;
  onBoard: boolean;
  kills: number;
  damage: Record<string, number>;
  score: number;
};

export type GameState = { caps: Cap[]; log: string[] };
export type Frame = { p: [number, number][] };
export type ShotInput = { angle: number; power: number };
export type SoundEvent = { frame: number; type: "hit" | "wall" };

export type ShotResult = {
  frames: Frame[];
  state: GameState;
  extraTurn: boolean;
  events: string[];
  finished: boolean;
  winner: string | null;
  soundEvents: SoundEvent[];
};

const DT = 1 / 240;
const FRAME_EVERY = 4;
export const PLAYBACK_FPS = 240 / FRAME_EVERY;
const MAX_STEPS = 8200;
const MIN_SPEED = 0.02;
export const MAX_LAUNCH = 214;
const STUCK_POWER = 0.3;

export function makeCap(
  id: string,
  name: string,
  color: string,
  team: number,
  slot: number,
  color2: string = color,
): Cap {
  const p = startPositionFor(slot);
  return {
    id,
    name,
    color,
    color2,
    team,
    x: p.x,
    z: p.z,
    step: 0,
    killer: false,
    stuck: false,
    stuckValue: 0,
    triedBreak: false,
    missedTarget: false,
    alive: true,
    onBoard: false,
    kills: 0,
    damage: {},
    score: 0,
  };
}

export function routeTarget(cap: Cap): number | null {
  if (cap.killer || cap.step >= ROUTE_LEN) return null;
  return ROUTE[cap.step];
}

/** Has this cap made box 1 yet? Only then may it legally strike other tops. */
export function isArmed(cap: Cap): boolean {
  return cap.killer || cap.step >= ARMED_STEP;
}

export function targetLabel(cap: Cap): string {
  if (cap.killer) return "KILLA";
  const t = routeTarget(cap);
  if (t === null) return "KILLA";
  const leg = legOf(cap.step);
  if (leg === "in") return "→ 13";
  if (leg === "kill") return "13 ☠";
  return `${t}${leg === "back" ? "▼" : "▲"}`;
}

export function progressPct(cap: Cap): number {
  return cap.killer ? 100 : Math.round((cap.step / ROUTE_LEN) * 100);
}

function normalize(state: GameState): GameState {
  const s = JSON.parse(JSON.stringify(state)) as GameState;
  s.caps = (s.caps ?? []).map((c) => ({
    ...c,
    step: c.step ?? 0,
    stuckValue: c.stuckValue ?? 0,
    triedBreak: c.triedBreak ?? false,
    missedTarget: c.missedTarget ?? false,
    onBoard: c.onBoard ?? true,
    damage: c.damage ?? {},
    score: c.score ?? 0,
    kills: c.kills ?? 0,
    color2: c.color2 ?? c.color,
  }));
  s.log = s.log ?? [];
  return s;
}

function slotOf(state: GameState, cap: Cap) {
  const i = state.caps.findIndex((c) => c.id === cap.id);
  return i < 0 ? 0 : i;
}

/** Killas break from the far chalk line, everyone else from START. */
function sendHome(state: GameState, cap: Cap) {
  const p = cap.killer ? killaPositionFor(slotOf(state, cap)) : startPositionFor(slotOf(state, cap));
  cap.x = p.x;
  cap.z = p.z;
  cap.onBoard = false;
  cap.stuck = false;
  cap.stuckValue = 0;
}

function becomeKilla(state: GameState, cap: Cap, events: string[]) {
  cap.killer = true;
  cap.step = ROUTE_LEN;
  cap.stuck = false;
  cap.stuckValue = 0;
  cap.missedTarget = false;
  const p = killaPositionFor(slotOf(state, cap));
  cap.x = p.x;
  cap.z = p.z;
  cap.onBoard = false;
  events.push(`☠️ ${cap.name} IS A KILLA — breaking in from the killa line!`);
}

/**
 * Move a cap forward N steps along its route (respecting whichever direction
 * — ascending or descending — it currently happens to be running) and drop
 * it on the box it lands on. Promotes to killa if it reaches the end.
 */
function advanceBoxes(
  state: GameState,
  cap: Cap,
  n: number,
  events: string[],
  label?: (landed: number, next: number, gained: number) => string,
) {
  if (cap.killer || n <= 0) return;
  const before = cap.step;
  cap.step = Math.min(ROUTE_LEN, cap.step + n);
  const gained = cap.step - before;
  cap.score += gained * 5;
  cap.missedTarget = false; // fresh target — this move wasn't a shot at it
  if (cap.step >= ROUTE_LEN) {
    events.push(label ? label(13, 13, gained) : `⏩ ${cap.name} advances ${gained} boxes — all the way home!`);
    becomeKilla(state, cap, events);
    return;
  }
  const landed = ROUTE[cap.step - 1];
  const box = boxByNumber(landed);
  if (box) {
    cap.x = box.x;
    cap.z = box.z;
    cap.onBoard = true;
    cap.stuck = false;
    cap.stuckValue = 0;
  }
  const next = ROUTE[cap.step];
  events.push(
    label ? label(landed, next, gained) : `⏩ ${cap.name} advances ${gained} boxes → now on ${landed}, next is ${next}`,
  );
}

/**
 * Deterministic physics + rules. Runs identically on the authoritative server
 * and on every client, so all players watch the same 3D replay.
 */
export function resolveShot(
  prev: GameState,
  teamMode: boolean,
  isStory: boolean,
  levelIdx: number,
  shooterId: string,
  input: ShotInput,
): ShotResult {
  const state = normalize(prev);
  const caps = state.caps.filter((c) => c.alive);
  const shooter = caps.find((c) => c.id === shooterId);
  const frames: Frame[] = [];
  const events: string[] = [];
  const soundEvents: SoundEvent[] = [];

  if (!shooter) {
    return {
      frames,
      state,
      extraTurn: false,
      events: ["invalid shooter"],
      finished: false,
      winner: null,
      soundEvents: [],
    };
  }

  let power = Math.max(0.01, Math.min(1, input.power));
  if (shooter.stuck) power = Math.min(power, STUCK_POWER);

  const vel = caps.map((c) => ({ vx: 0, vz: 0, id: c.id }));
  const sv = vel.find((v) => v.id === shooterId)!;
  sv.vx = Math.cos(input.angle) * power * MAX_LAUNCH;
  sv.vz = Math.sin(input.angle) * power * MAX_LAUNCH;

  const hitOrder: string[] = [];
  const friction = frictionFor(levelIdx);
  const decay = Math.exp(-friction * DT);
  const wx0 = RAIL.xMin;
  const wx1 = RAIL.xMax;
  const wz0 = RAIL.zMin;
  const wz1 = RAIL.zMax;
  const railed = new Set<string>();
  const R = CAP_R * 2; // combined radius — any overlap of this counts as a real touch
  const inPlay = (c: Cap) => c.onBoard || c.id === shooterId;

  /**
   * Find the earliest moment (0..budget) within this time slice at which any
   * two in-play caps' circles first touch, given they're travelling in
   * straight lines at their current velocities. This is exact continuous
   * (swept) collision detection — it catches every real contact, including
   * a very soft, slow-closing tap that would otherwise decelerate to a stop
   * a hair's breadth short of the target under simple discrete stepping.
   */
  function earliestContact(budget: number): { t: number; i: number; j: number } | null {
    let bestT = budget;
    let bestI = -1;
    let bestJ = -1;
    for (let i = 0; i < caps.length; i++) {
      for (let j = i + 1; j < caps.length; j++) {
        const a = caps[i];
        const b = caps[j];
        if (!inPlay(a) || !inPlay(b)) continue;
        const px = a.x - b.x;
        const pz = a.z - b.z;
        const d0 = Math.hypot(px, pz);
        if (d0 <= R) {
          // already touching right now — the softest possible "hit"
          if (0 < bestT) {
            bestT = 0;
            bestI = i;
            bestJ = j;
          }
          continue;
        }
        const va = vel[i];
        const vb = vel[j];
        const vx = va.vx - vb.vx;
        const vz = va.vz - vb.vz;
        const A = vx * vx + vz * vz;
        if (A < 1e-9) continue; // no relative motion — can't newly touch this slice
        const B = 2 * (px * vx + pz * vz);
        const C = px * px + pz * pz - R * R;
        const disc = B * B - 4 * A * C;
        if (disc < 0) continue;
        const sqrtDisc = Math.sqrt(disc);
        const t = (-B - sqrtDisc) / (2 * A);
        if (t > 1e-7 && t <= bestT) {
          bestT = t;
          bestI = i;
          bestJ = j;
        }
      }
    }
    return bestI >= 0 ? { t: bestT, i: bestI, j: bestJ } : null;
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    let moving = false;
    for (let i = 0; i < caps.length; i++) {
      const v = vel[i];
      if (Math.hypot(v.vx, v.vz) < MIN_SPEED) {
        v.vx = 0;
        v.vz = 0;
      } else {
        moving = true;
        v.vx *= decay;
        v.vz *= decay;
      }
    }

    // Advance this whole DT slice using continuous collision detection, so
    // ANY real contact — however gentle or glancing — is caught exactly when
    // it happens, instead of only being sampled at the end of the step.
    let elapsed = 0;
    let guard = 0;
    while (elapsed < DT && guard < 12) {
      guard++;
      const budget = DT - elapsed;
      const hit = moving ? earliestContact(budget) : null;
      const dt = hit ? hit.t : budget;

      for (let i = 0; i < caps.length; i++) {
        caps[i].x += vel[i].vx * dt;
        caps[i].z += vel[i].vz * dt;
      }
      elapsed += dt;

      if (!hit) break;

      const a = caps[hit.i];
      const b = caps[hit.j];
      const va = vel[hit.i];
      const vb = vel[hit.j];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-6) {
        d = 1e-6;
        dx = R;
        dz = 0;
      }
      const nx = dx / d;
      const nz = dz / d;

      // ANY genuine contact registers as a hit for game rules — a soft tap
      // still counts as striking a cap, it doesn't need to be a hard bounce.
      if (a.id === shooterId && !hitOrder.includes(b.id)) {
        hitOrder.push(b.id);
        soundEvents.push({ frame: Math.floor(step / FRAME_EVERY), type: "hit" });
      }
      if (b.id === shooterId && !hitOrder.includes(a.id)) {
        hitOrder.push(a.id);
        soundEvents.push({ frame: Math.floor(step / FRAME_EVERY), type: "hit" });
      }

      const rel = (vb.vx - va.vx) * nx + (vb.vz - va.vz) * nz;
      if (rel < 0) {
        // physically correct elastic-ish impulse along the contact normal
        const imp = -rel * 0.94;
        va.vx -= imp * nx;
        va.vz -= imp * nz;
        vb.vx += imp * nx;
        vb.vz += imp * nz;
      }
      // nudge apart by a hair so the pair doesn't immediately re-trigger
      // t=0 contact again on the very next sweep this frame
      const sep = Math.max(0, R - d) * 0.5 + 1e-4;
      a.x -= nx * sep;
      a.z -= nz * sep;
      b.x += nx * sep;
      b.z += nz * sep;
    }

    // kerb bounce — checked once per full time slice, after motion & any
    // cap-vs-cap contacts this step have been resolved
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i];
      const v = vel[i];
      if (c.x < wx0 || c.x > wx1) {
        c.x = Math.max(wx0, Math.min(wx1, c.x));
        v.vx *= -0.55;
        v.vz *= 0.9;
        railed.add(c.id);
        if (c.id === shooterId) soundEvents.push({ frame: Math.floor(step / FRAME_EVERY), type: "wall" });
      }
      if (c.z < wz0 || c.z > wz1) {
        c.z = Math.max(wz0, Math.min(wz1, c.z));
        v.vz *= -0.55;
        v.vx *= 0.9;
        railed.add(c.id);
        if (c.id === shooterId) soundEvents.push({ frame: Math.floor(step / FRAME_EVERY), type: "wall" });
      }
    }

    if (step % FRAME_EVERY === 0) frames.push({ p: caps.map((c) => [round(c.x), round(c.z)]) });
    if (!moving && step > 6) break;
  }
  frames.push({ p: caps.map((c) => [round(c.x), round(c.z)]) });

  // ------------------------- rules -------------------------
  const outside = (c: Cap) => Math.abs(c.x) > OUT_LIMIT || Math.abs(c.z) > OUT_LIMIT;
  const armed = isArmed(shooter);
  const liveHits = hitOrder.filter((id) => caps.find((c) => c.id === id)?.onBoard);
  let extraTurn = false;
  let resolvedMove = false;
  let rescueBonus = 0;
  let boxesFromHits = 0; // one box per opponent top struck this shot
  let didLegalHit = false; // did any legal contact happen? (grants another shot)

  // ILLEGAL STRIKE: you must make box 1 before you may hit ANYBODY'S top — hit
  // one early and you start all over. Killas are always armed, so this never
  // catches them.
  if (liveHits.length > 0 && !armed) {
    shooter.step = 0;
    shooter.missedTarget = false;
    shooter.triedBreak = false;
    sendHome(state, shooter);
    shooter.score = Math.max(0, shooter.score - 5);
    events.push(`🚫 ${shooter.name} hit a top before making 1 — START ALL OVER!`);
    resolvedMove = true;
  }

  for (const id of liveHits) {
    const victim = caps.find((c) => c.id === id);
    if (!victim) continue;
    if (!armed) continue; // an illegal strike is void — it frees nobody
    const friendly = teamMode && victim.team === shooter.team;

    // Knocking a stuck top out of the middle pays the panel value, and doesn't
    // also count as a plain box-scoring strike.
    if (victim.stuck) {
      const worth = victim.stuckValue || 2;
      victim.stuck = false;
      victim.stuckValue = 0;
      if (friendly) {
        // Freeing a teammate helps them, but touching your own team is never
        // a hit — you don't earn another shot for it, the turn passes.
        shooter.score += 10;
        events.push(`🛟 ${shooter.name} freed teammate ${victim.name} out of the ${worth} (+10) — turn passes.`);
      } else {
        shooter.score += 15;
        rescueBonus += worth;
        didLegalHit = true;
        events.push(`🛟 ${shooter.name} knocked ${victim.name} out of the ${worth} — collect ${worth} boxes!`);
      }
      continue;
    }

    if (friendly) {
      // Tapping your own team is NOT a hit: no boxes, and no extra shot. The
      // turn passes exactly as if you'd missed.
      events.push(`🤝 ${shooter.name} tapped teammate ${victim.name} — no shot again.`);
      continue;
    }

    if (shooter.killer) {
      didLegalHit = true;
      if (victim.onBoard && railed.has(victim.id)) {
        victim.alive = false;
        shooter.kills += 1;
        shooter.score += 60;
        events.push(`🧱☠️ ${shooter.name} pinned ${victim.name} against the edge — KILLED!`);
      } else {
        const need = victim.killer ? 1 : 3;
        victim.damage[shooter.id] = (victim.damage[shooter.id] ?? 0) + 1;
        if (victim.damage[shooter.id] >= need) {
          victim.alive = false;
          shooter.kills += 1;
          shooter.score += 50;
          events.push(`☠️ ${shooter.name} killed ${victim.name}!`);
        } else {
          events.push(`${shooter.name} tagged ${victim.name} (${victim.damage[shooter.id]}/${need})`);
        }
      }
      continue;
    }

    // A regular shooter striking an opponent top (normal OR killa) advances one
    // box PER top hit this shot: hit two tops, move two boxes, and so on.
    shooter.score += 15;
    boxesFromHits += 1;
    didLegalHit = true;
  }

  // Cash in the box(es) earned by striking tops this shot.
  if (!shooter.killer && boxesFromHits > 0) {
    advanceBoxes(
      state,
      shooter,
      boxesFromHits,
      events,
      (landed, next, gained) =>
        gained === 1
          ? `💥 ${shooter.name} struck a top — advances 1 box to ${landed}! (Next: ${next})`
          : `💥 ${shooter.name} struck ${gained} tops in one shot — advances ${gained} boxes to ${landed}! (Next: ${next})`,
    );
    resolvedMove = true;
  }

  // You only get to shoot again if you either landed your box or hit somebody.
  // The make-box branches below OR in their own extra turn on a clean landing.
  extraTurn = didLegalHit;

  // The lot is wide open — missing the chalk square, or even bouncing off the
  // kerb, just leaves your top out on the asphalt, still in play. Nothing here
  // sends you home any more; only the rules below relocate a cap.
  for (const c of caps) {
    if (!c.alive) continue;
    c.onBoard = true;
    if (c.id === shooter.id && railed.has(c.id) && !resolvedMove) {
      events.push(`🧱 ${shooter.name} caught the kerb — still live out on the lot.`);
    } else if (c.id === shooter.id && !resolvedMove && outside(c)) {
      events.push(`🛞 ${shooter.name} rolled off the chalk — still live out on the lot.`);
    }
  }

  // KNOCKED INTO THE MIDDLE
  // Get struck into one of the 2·4·6·8 panels — cleanly inside, not on a line,
  // and not the 13 — and you are pinned exactly as if you had landed there off
  // your own flick. Whoever knocks you back out collects that many boxes.
  //
  // Only a legal strike can do this: if the shooter hadn't made box 1 the whole
  // contact is void, so it can't trap anybody either.
  if (armed) {
    for (const c of caps) {
      if (!c.alive || c.id === shooter.id) continue;
      // Killas have finished the route — the middle has nothing left to take
      // from them. Anyone already pinned stays pinned at their own value.
      if (c.killer || c.stuck || !c.onBoard) continue;
      const panel = panelValueAt(c.x, c.z);
      if (panel > 0) {
        c.stuck = true;
        c.stuckValue = panel;
        events.push(
          `💀 ${shooter.name} knocked ${c.name} into the ${panel} — STUCK until somebody knocks them out (worth ${panel} boxes).`,
        );
      }
    }
  }

  // did the shooter make its box? (skipped when a rescue is relocating them)
  if (shooter.alive && !resolvedMove && !shooter.killer && rescueBonus === 0) {
    const target = ROUTE[shooter.step];
    const stepBefore = shooter.step;

    if (shooter.step === 0) {
      // ---------------- THE BREAK SHOT (from START, target is 13) ----------------
      if (insideBox(13, shooter.x, shooter.z)) {
        if (!shooter.triedBreak) {
          // Dead centre on the FIRST break skips the whole forward run AND
          // blazes 3 boxes into the backward run: box 13 is made, then 12·11·10
          // as the free 3 — so you land on box 10 and shoot down toward 9.
          shooter.step = BACK_STEP + 3; // target 9 (ROUTE[17]); box 10 made
          const box = boxByNumber(10);
          if (box) {
            shooter.x = box.x;
            shooter.z = box.z;
          }
          shooter.onBoard = true;
          shooter.stuck = false;
          shooter.stuckValue = 0;
          shooter.missedTarget = false;
          shooter.score += 25;
          events.push(
            `🔄 ${shooter.name} drills the middle on the break — skips ahead 3, now running box 10 → 9!`,
          );
          extraTurn = true;
        } else {
          // If you already missed the first shot from start, 13 is nothing until you get there going forward.
          events.push(`${shooter.name} landed in 13, but already missed the first break! 13 is nothing right now.`);
        }
      } else {
        const panel = panelValueAt(shooter.x, shooter.z);
        if (panel > 0) {
          if (!shooter.triedBreak) {
            // First break attempt: landing in ANY middle number (2·4·6·8)
            // starts your run from box 3, moving forward from there.
            // (step 4 means "box 3 is made, next target is box 4".)
            const box = boxByNumber(3);
            shooter.step = 4;
            if (box) {
              shooter.x = box.x;
              shooter.z = box.z;
            }
            shooter.onBoard = true;
            shooter.stuck = false;
            shooter.stuckValue = 0;
            shooter.missedTarget = false;
            shooter.score += 15;
            events.push(
              `🎯 ${shooter.name} breaks into the ${panel} — starts the run from box 3, moving FORWARD (next: ${ROUTE[shooter.step]})!`,
            );
          } else {
            // Already missed the break once — now ANY middle number just
            // moves you forward to box 1, no matter which one you land in.
            const box1 = boxByNumber(1);
            shooter.step = ARMED_STEP;
            if (box1) {
              shooter.x = box1.x;
              shooter.z = box1.z;
            }
            shooter.onBoard = true;
            shooter.stuck = false;
            shooter.stuckValue = 0;
            shooter.missedTarget = false;
            shooter.score += 15;
            events.push(`🎯 ${shooter.name} lands in the ${panel} — moves forward to box 1, tops are LIVE now!`);
          }
          extraTurn = true;
        } else if (!shooter.triedBreak) {
          // First break attempt missed everything — from now on, landing in
          // ANY middle number (not just a specific one) is enough.
          shooter.triedBreak = true;
          events.push(
            `${shooter.name} missed the break — next time, land in ANY middle box (2·4·6·8) to move forward to box 1!`,
          );
        }
        // otherwise: already knew the rule and missed again — turn just passes.
      }
    } else if (shooter.step === FINAL_STEP) {
      // ---------------- THE FINAL MIDDLE — become a KILLA ----------------
      // After the backward run has brought you to box 1, hitting the middle at
      // all finishes it: dead-centre 13 OR any of the 2·4·6·8 panels makes you
      // a killa. (Only here does a panel help — everywhere else it traps you.)
      if (insideBox(13, shooter.x, shooter.z) || panelValueAt(shooter.x, shooter.z) > 0) {
        shooter.score += 40;
        events.push(`🏆 ${shooter.name} hits the middle after the run — "I'M A KILLA!"`);
        becomeKilla(state, shooter, events);
        extraTurn = true;
      }
      // otherwise you missed the middle entirely — the turn just passes.
    } else if (insideBox(target, shooter.x, shooter.z) && target === 13) {
      // ---------------- TOPPING OUT AT 13 (ascending run complete) ----------------
      shooter.step += 1;
      shooter.stuck = false;
      shooter.stuckValue = 0;
      shooter.missedTarget = false;
      shooter.score += 15;
      events.push(`🎯 ${shooter.name} topped out at 13 — now back down 12 → 1!`);
      extraTurn = true;
    } else if (insideBox(target, shooter.x, shooter.z)) {
      // ---------------- CLEAN LANDING ON YOUR OWN TARGET (not 13) ----------------
      // Bonus: blaze forward 3 boxes — but ONLY if you land it on your very
      // first attempt at this target (shooting from wherever you last came to
      // rest). Miss once, and a later hit on the SAME target only advances
      // you the normal 1 box, no bonus.
      const before = shooter.step;
      const freshAttempt = !shooter.missedTarget;
      // First try: make the box (+1) AND blaze 3 more, landing you ON the box
      // three ahead — e.g. make box 4 from box 3 and you end up on box 7. Miss
      // once and a later hit on this target only advances the normal 1 box.
      const gain = freshAttempt ? 4 : 1;
      shooter.step = Math.min(ROUTE_LEN, shooter.step + gain);
      shooter.stuck = false;
      shooter.stuckValue = 0;
      shooter.missedTarget = false;
      shooter.score += freshAttempt ? 20 : 10;
      if (shooter.step >= ROUTE_LEN) {
        events.push(
          freshAttempt
            ? `🏆 ${shooter.name} makes box ${target}, blazes forward 3 — all the way home, "I'M A KILLA!"`
            : `🏆 ${shooter.name} makes box ${target} — all the way home, "I'M A KILLA!"`,
        );
        becomeKilla(state, shooter, events);
      } else {
        shooter.onBoard = true;
        const landedBox = ROUTE[shooter.step - 1];
        // On the blaze bonus you SKIP forward, so carry the top onto the box it
        // skipped to — your next shot is taken from that new box. A normal
        // (non-bonus) make leaves you exactly where you came to rest.
        if (freshAttempt) {
          const box = boxByNumber(landedBox);
          if (box) {
            shooter.x = box.x;
            shooter.z = box.z;
          }
        }
        const nextBox = ROUTE[shooter.step];
        const crossedFinal = before < FINAL_STEP && shooter.step >= FINAL_STEP;
        const crossedBack = before < BACK_STEP && shooter.step >= BACK_STEP;
        const crossedArmed = before < ARMED_STEP && shooter.step >= ARMED_STEP;
        const tag = freshAttempt ? `, blazes forward 3` : ``;
        if (crossedFinal) {
          events.push(`🎯 ${shooter.name} makes box ${target}${tag} — one last flick for the middle!`);
        } else if (crossedBack) {
          events.push(`🎯 ${shooter.name} makes box ${target}${tag} — now heading back to ${nextBox}!`);
        } else if (crossedArmed) {
          events.push(`🎯 ${shooter.name} makes box ${target}${tag} — box 1 made, tops are LIVE now!`);
        } else {
          events.push(`🎯 ${shooter.name} makes box ${target}${tag} — next is ${nextBox}!`);
        }
      }
      extraTurn = true;
    } else {
      const panel = panelValueAt(shooter.x, shooter.z);
      if (panel > 0) {
        if (armed) {
          // past box 1 — landing in the middle numbers (2/4/6/8) pins you
          // there until someone knocks you out.
          shooter.stuck = true;
          shooter.stuckValue = panel;
          extraTurn = false;
          events.push(
            `💀 ${shooter.name} landed in the ${panel} — STUCK until somebody knocks them out (worth ${panel} boxes).`,
          );
        } else {
          events.push(`${shooter.name} skimmed the ${panel} panel — missed the middle.`);
        }
      }
    }

    // If nothing moved this cap off its current target, this attempt was a
    // miss — so the NEXT successful hit on this same target won't get the
    // forward-3 bonus.
    if (shooter.step === stepBefore && !shooter.killer) {
      shooter.missedTarget = true;
    }
  }

  // the rescuer collects the panel number they knocked the victim out of
  if (rescueBonus > 0 && shooter.alive && !shooter.killer) {
    advanceBoxes(state, shooter, rescueBonus, events);
    extraTurn = true;
  }

  // Team synchronization: when a teammate advances, the whole team advances
  // with them — and gathers at the front so nobody has to grind up from behind.
  if (teamMode) {
    const teams = [...new Set(state.caps.map((c) => c.team))];
    for (const t of teams) {
      const teamCaps = state.caps.filter((c) => c.team === t && c.alive);
      if (teamCaps.length === 0) continue;

      // Find the furthest-along member of the team. Capture the leader BEFORE
      // syncing steps — once everyone shares maxStep, step can't tell them apart
      // and the leader (who is actually at the front) would be lost.
      const isKiller = teamCaps.some((c) => c.killer);
      const maxStep = Math.max(...teamCaps.map((c) => c.step));
      const leader = teamCaps.reduce((a, b) => (b.step > a.step ? b : a), teamCaps[0]);

      let synced = false;
      teamCaps.forEach((c) => {
        if (isKiller && !c.killer) {
          becomeKilla(state, c, events);
          events.push(`🤝 ${c.name} becomes a KILLA alongside their team!`);
        } else if (!c.killer && c.step < maxStep) {
          c.step = maxStep;
          c.stuck = false;
          c.stuckValue = 0;
          c.missedTarget = false;
          synced = true;
          events.push(`🤝 ${c.name} rides up with their team!`);
        }
      });

      // When the team just moved up, gather everyone around the leader —
      // but SPREAD OUT in a ring so no two tops sit on the same spot. Stacked
      // teammates used to collide the instant one of them tried to shoot.
      if (synced && !isKiller) {
        const board = teamCaps.filter((c) => !c.killer && c.alive);
        if (board.length > 1) {
          // The leader keeps exactly where it came to rest; the rest ring around.
          const followers = board.filter((c) => c.id !== leader.id);
          // Radius large enough that neighbours on the ring never overlap
          // (a cap is 2·CAP_R across), and it grows with the crowd.
          const gap = CAP_R * 2 + 0.5;
          const radius = Math.max(gap, (followers.length * gap) / (2 * Math.PI));
          followers.forEach((c, i) => {
            const ang = (i / followers.length) * Math.PI * 2 + 0.3;
            c.x = leader.x + Math.cos(ang) * radius;
            c.z = leader.z + Math.sin(ang) * radius;
            c.onBoard = true;
          });
        }
      }
    }
  }

  const alive = state.caps.filter((c) => c.alive);

  // deadlock guard: if every top left is pinned in the middle, the skull spits
  // them all back out to their chalk lines
  if (alive.length > 0 && alive.every((c) => c.stuck)) {
    for (const c of alive) sendHome(state, c);
    events.push("🌀 Every top was stuck — the skull spits them all back to the lines!");
  }

  let finished = false;
  let winner: string | null = null;
  if (isStory) {
    // In story mode, the goal is for ANY cap to become a KILLA.
    if (alive.some((c) => c.killer)) {
      finished = true;
      winner = "Level Cleared";
    } else if (alive.length === 0) {
      finished = true;
      winner = "Nobody";
    }
  } else if (teamMode) {
    const teams = new Set(alive.map((c) => c.team));
    if (teams.size <= 1 && state.caps.length > 1) {
      finished = true;
      winner = teams.size === 1 ? `Team ${[...teams][0] + 1}` : "Nobody";
    }
  } else if (alive.length <= 1 && state.caps.length > 1) {
    finished = true;
    winner = alive[0]?.name ?? "Nobody";
  }

  state.log = [...events, ...state.log].slice(0, 40);
  return { frames, state, extraTurn: extraTurn && !finished, events, finished, winner, soundEvents };
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
