import assert from "node:assert/strict";
import test from "node:test";
import {
  BOXES,
  BOX_PLACE_R,
  CAP_R,
  FINAL_STEP,
  LEVELS,
  RAIL,
  ROUTE,
  START_BACK_DEPTH,
  START_BAND_HALF,
  START_LINE,
  boxByNumber,
  clampAroundBox,
  clampBehindStart,
  insideBox,
  panelValueAt,
} from "../src/game/board";
import { computeAutoShot, computeBotShot } from "../src/game/bot";
import { MIN_CHARGE, POWER_CYCLE_MS, powerAt } from "../src/game/power";
import {
  clusterTeamInBox,
  makeCap,
  resolveShot,
  startPositionFor,
  turnOrder,
  type Cap,
  type GameState,
} from "../src/game/sim";

/** Deterministic RNG so a failing test can always be reproduced. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function newState(n: number): GameState {
  const caps: Cap[] = [];
  for (let i = 0; i < n; i++) caps.push(makeCap(String(i), `P${i + 1}`, "#ff3b6b", i, i, "#22d3ee"));
  return { caps, log: [] };
}

test("physics are deterministic — server and every client agree", () => {
  const start = newState(3);
  const a = resolveShot(start, false, false, 0, "0", { angle: 0.31, power: 0.62 });
  const b = resolveShot(start, false, false, 0, "0", { angle: 0.31, power: 0.62 });
  assert.deepEqual(a.state, b.state);
  assert.equal(a.frames.length, b.frames.length);
  assert.deepEqual(a.frames.at(-1), b.frames.at(-1));
  assert.deepEqual(a.events, b.events);
});

test("resolveShot never mutates the state it was given", () => {
  const start = newState(2);
  const snapshot = JSON.stringify(start);
  resolveShot(start, false, false, 0, "0", { angle: 1.1, power: 0.9 });
  assert.equal(JSON.stringify(start), snapshot);
});

test("bot aim lands on the box it was aiming at", () => {
  // With the noise dialled out, the bot's distance model should put the cap
  // essentially dead on its target — this is what makes CPUs competent.
  for (const levelIdx of [0, 1, 2, 4, 19]) {
    const state = newState(1);
    const cap = state.caps[0];
    cap.step = 2; // next target is box 2
    const target = boxByNumber(ROUTE[cap.step])!;

    const shot = computeBotShot(state, cap, levelIdx, false, () => 0.5);
    assert.ok(Number.isFinite(shot.angle), "angle must be finite");
    assert.ok(shot.power > 0 && shot.power <= 1, "power must be a sane fraction");

    const res = resolveShot(state, false, false, levelIdx, cap.id, shot);
    // Check where the physics actually brought the cap to rest. The post-rule
    // position is no good here: making your box moves you on down the route.
    const [restX, restZ] = res.frames.at(-1)!.p[0];
    const miss = Math.hypot(restX - target.x, restZ - target.z);
    assert.ok(
      miss < 1.0,
      `level ${levelIdx} (${LEVELS[levelIdx].name}): bot stopped ${miss.toFixed(2)} units from box ${target.n}`,
    );
    // ...and that landing must be good enough to count as making the box.
    assert.ok(
      res.state.caps[0].step > cap.step,
      `level ${levelIdx}: bot landed on box ${target.n} but the rules did not credit it`,
    );
  }
});

test("bot output is always finite, whatever the board looks like", () => {
  const rng = seeded(7);
  for (let i = 0; i < 300; i++) {
    const state = newState(4);
    for (const c of state.caps) {
      c.step = Math.floor(rng() * 27);
      c.killer = rng() < 0.2;
      c.stuck = rng() < 0.2;
      c.stuckValue = c.stuck ? 4 : 0;
      c.x = (rng() - 0.5) * 200;
      c.z = (rng() - 0.5) * 200;
    }
    const shot = computeBotShot(state, state.caps[0], Math.floor(rng() * LEVELS.length), false, rng);
    assert.ok(Number.isFinite(shot.angle) && Number.isFinite(shot.power));
    assert.ok(shot.power >= 0.012 && shot.power <= 1);
  }
});

test("breaking into any middle panel starts your run from box 3", () => {
  // Whichever of the 2·4·6·8 you break into, you come out sitting on box 3
  // with box 4 as your next target.
  const box3 = boxByNumber(3)!;
  for (const [x, z, panel] of [
    [0, -5.8, 2],
    [5.8, 0, 4],
    [0, 5.8, 6],
    [-5.8, 0, 8],
  ] as Array<[number, number, number]>) {
    const state = newState(2);
    const cap = state.caps[0];
    cap.x = x;
    cap.z = z;
    cap.onBoard = true;
    state.caps[1].x = -120;
    state.caps[1].z = -120;
    assert.equal(panelValueAt(cap.x, cap.z), panel, `fixture must sit in the ${panel} panel`);

    // A dead-still "flick" (angle away from the board, ~zero power) leaves the
    // cap where it is, so the break rule reads the panel it's parked in.
    const res = resolveShot(state, false, false, 0, cap.id, { angle: Math.atan2(z, x), power: 0.01 });
    const after = res.state.caps[0];

    assert.equal(after.step, 4, `${panel}: step should be 4 — box 3 made, box 4 next`);
    assert.equal(ROUTE[after.step], 4);
    assert.equal(after.x, box3.x);
    assert.equal(after.z, box3.z);
  }
});

test("drilling 13 on the break turns you around — box 13 made, next 12", () => {
  const state = newState(2);
  const cap = state.caps[0];
  cap.x = 0; // dead centre in box 13
  cap.z = 0;
  cap.onBoard = true;
  state.caps[1].x = -120;
  state.caps[1].z = -120;
  assert.ok(insideBox(13, cap.x, cap.z), "fixture must sit in box 13");

  // A dead-still flick so the break rule reads the 13 it's parked in.
  const res = resolveShot(state, false, false, 0, cap.id, { angle: Math.PI, power: 0.01 });
  const after = res.state.caps[0];
  const box13 = boxByNumber(13)!;

  assert.equal(after.step, 14, "step 14 — box 13 made, now on the backward run");
  assert.equal(ROUTE[after.step], 12, "next target is 12 (heading backwards)");
  assert.equal(after.x, box13.x, "sits on box 13");
  assert.equal(after.z, box13.z);
});

test("on the break, bots aim for a middle panel, never box 13", () => {
  for (let slot = 0; slot < 4; slot++) {
    const state = newState(slot + 1);
    const cap = state.caps[slot]; // still at START, step 0
    const shot = computeBotShot(state, cap, 0, false, () => 0.5);
    assert.ok(shot.why.startsWith("breaking for"), `slot ${slot}: bot should break for a panel, got "${shot.why}"`);
  }
});

test("a timeout auto-shot before box 1 never swings at a top (would foul)", () => {
  // Un-armed cap (step 0) with an opponent nearby: it must always go for the
  // box/panel, never a top — hitting a top before box 1 is an illegal strike.
  for (let seed = 0; seed < 200; seed++) {
    const rng = seeded(seed + 1);
    const state = newState(2);
    const cap = state.caps[0]; // step 0, at START, un-armed
    const opp = state.caps[1];
    opp.onBoard = true;
    opp.x = cap.x + 5;
    opp.z = cap.z;
    const shot = computeAutoShot(state, cap, 0, false, rng);
    assert.ok(!shot.why.includes("auto-shot at"), `seed ${seed}: un-armed auto-shot must not target a top (${shot.why})`);
  }
});

test("a killa's timeout auto-shot always swings at a top", () => {
  for (let seed = 0; seed < 100; seed++) {
    const rng = seeded(seed + 1);
    const state = newState(2);
    const cap = state.caps[0];
    cap.killer = true;
    cap.onBoard = true;
    cap.x = 0;
    cap.z = 0;
    const opp = state.caps[1];
    opp.onBoard = true;
    opp.x = 6;
    opp.z = 0;
    const shot = computeAutoShot(state, cap, 0, false, rng);
    assert.ok(shot.why.includes("auto-shot at"), `seed ${seed}: killa auto-shot should hunt a top (${shot.why})`);
  }
});

test("the timeout auto-shot genuinely misses about half the time", () => {
  // Armed cap going for box 5: measure how often it actually lands in the box.
  // It must be fallible — neither near-perfect nor hopeless.
  const box5 = boxByNumber(5)!;
  let attempts = 0;
  let hits = 0;
  for (let seed = 0; seed < 800; seed++) {
    const rng = seeded(seed + 1);
    const state = newState(2);
    const cap = state.caps[0];
    cap.step = 5;
    cap.onBoard = true;
    cap.x = box5.x - 4;
    cap.z = box5.z;
    state.caps[1].onBoard = true;
    state.caps[1].x = -140; // opponent out of the way
    state.caps[1].z = -140;
    const shot = computeAutoShot(state, cap, 0, false, rng);
    if (shot.why.includes("auto-shot at")) continue; // this one swung at the top
    attempts += 1;
    const res = resolveShot(state, false, false, 0, "0", shot);
    const [rx, rz] = res.frames.at(-1)!.p[0];
    if (insideBox(5, rx, rz)) hits += 1;
  }
  const rate = hits / attempts;
  assert.ok(rate > 0.25 && rate < 0.75, `box-hit rate should be roughly 50/50, was ${(rate * 100).toFixed(0)}%`);
});

test("you cannot strike a top before making box 1", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const victim = state.caps[1];
  victim.onBoard = true;
  // Sit the victim just ahead of the shooter's lane so the flick must hit it.
  victim.x = shooter.x + 6;
  victim.z = shooter.z;

  const res = resolveShot(state, false, false, 0, shooter.id, { angle: 0, power: 0.35 });
  assert.equal(res.state.caps[0].step, 0);
  assert.ok(
    res.events.some((e) => e.includes("START ALL OVER")),
    `expected a foul, got: ${res.events.join(" | ")}`,
  );
});

test("an armed shooter that clips a not-yet-in top starts all over (both modes)", () => {
  // Even fully armed, touching an opponent that hasn't made box 1 is a foul.
  for (const teamMode of [false, true]) {
    const state = newState(2);
    const shooter = state.caps[0];
    const victim = state.caps[1];
    shooter.step = 5; // armed
    shooter.onBoard = true;
    shooter.team = 0;
    shooter.x = -6;
    shooter.z = 0;
    victim.team = 1; // opponent
    victim.onBoard = true;
    victim.step = 0; // has NOT made box 1
    victim.x = 0;
    victim.z = 0; // dead ahead on the shot line

    const res = resolveShot(state, teamMode, false, 19, shooter.id, { angle: 0, power: 0.9 });
    const after = res.state.caps.find((c) => c.id === shooter.id)!;
    assert.equal(after.step, 0, `mode=${teamMode}: the shooter is sent back to START`);
    assert.ok(
      res.events.some((e) => e.includes("START ALL OVER")),
      `mode=${teamMode}: expected a foul; events: ${res.events.join(" | ")}`,
    );
    assert.equal(res.extraTurn, false, `mode=${teamMode}: a foul is no free extra shot`);
  }
});

test("tapping a not-yet-in team-mate is harmless, not a foul", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const mate = state.caps[1];
  shooter.step = 5;
  shooter.onBoard = true;
  shooter.team = 0;
  shooter.x = -6;
  shooter.z = 0;
  mate.team = 0; // same team
  mate.onBoard = true;
  mate.step = 0; // hasn't made box 1
  mate.x = 0;
  mate.z = 0;

  const res = resolveShot(state, true, false, 19, shooter.id, { angle: 0, power: 0.9 });
  assert.ok(
    !res.events.some((e) => e.includes("START ALL OVER")),
    `tapping your own not-yet-in team-mate must not foul; events: ${res.events.join(" | ")}`,
  );
});

/** An armed shooter that ploughs through a cluster of `n` opponent tops. */
function multiHit(n: number) {
  const state = newState(n + 1);
  const shooter = state.caps[0];
  shooter.step = 5; // armed, mid-route (not near the end so the count isn't clamped)
  shooter.missedTarget = true; // so a stray box landing can't add its own advance
  shooter.x = -6;
  shooter.z = 0;
  shooter.onBoard = true;

  // A tight cluster on the shot line: a symmetric pair the flick splits (their
  // opposite deflections cancel, keeping it centred) followed by a top dead
  // ahead for it to plough straight into. Tests run this on the slick borough
  // so the top keeps enough speed to reach the third after splitting the pair.
  const spots: [number, number][] = [
    [0, 0.9],
    [0, -0.9],
    [1.4, 0],
    [2.6, 0],
  ];
  for (let i = 0; i < n; i++) {
    const v = state.caps[i + 1];
    v.step = 5;
    v.onBoard = true;
    v.team = i + 1; // everyone on their own team → all opponents
    [v.x, v.z] = spots[i];
  }
  shooter.team = 0;
  return { state, shooter };
}

test("hitting two tops in one shot advances two boxes", () => {
  const { state, shooter } = multiHit(2);
  const before = shooter.step;
  const res = resolveShot(state, false, false, 19, shooter.id, { angle: 0, power: 0.95 });
  const after = res.state.caps[0];
  assert.equal(after.step - before, 2, `two tops struck should be two boxes; events: ${res.events.join(" | ")}`);
  assert.ok(res.events.some((e) => e.includes("struck 2 tops")), "there is a two-tops event");
});

test("hitting three tops in one shot advances three boxes", () => {
  const { state, shooter } = multiHit(3);
  const before = shooter.step;
  const res = resolveShot(state, false, false, 19, shooter.id, { angle: 0, power: 0.95 });
  const after = res.state.caps[0];
  assert.equal(after.step - before, 3, `three tops struck should be three boxes; events: ${res.events.join(" | ")}`);
});

test("you only shoot again after making your box or hitting somebody", () => {
  // A clean miss — no box, no contact — passes the turn.
  const miss = newState(2);
  miss.caps[0].step = 5;
  miss.caps[0].onBoard = true;
  miss.caps[0].missedTarget = true;
  miss.caps[1].x = 200; // far away, unreachable
  miss.caps[1].z = 200;
  const missRes = resolveShot(miss, false, false, 0, "0", { angle: Math.PI, power: 0.05 });
  assert.equal(missRes.extraTurn, false, "a nothing shot does not grant another turn");

  // A hit grants another turn.
  const hit = multiHit(1);
  const hitRes = resolveShot(hit.state, false, false, 0, hit.shooter.id, { angle: 0, power: 0.55 });
  assert.equal(hitRes.extraTurn, true, "striking a top grants another turn");
});

test("after the backward run, landing in any middle panel makes you a killa", () => {
  const state = newState(2);
  const cap = state.caps[0];
  cap.step = FINAL_STEP; // reached box 1 on the way back; the last flick is for the middle
  cap.onBoard = true;
  cap.x = 5.8; // sitting in the 4 panel
  cap.z = 0;
  state.caps[1].x = -120;
  state.caps[1].z = -120;
  assert.equal(panelValueAt(cap.x, cap.z), 4, "fixture must sit in the 4 panel");

  // A whisper of a tap that keeps it inside the panel.
  const res = resolveShot(state, false, false, 0, cap.id, { angle: Math.PI / 2, power: 0.008 });
  const after = res.state.caps[0];
  assert.equal(after.killer, true, `a panel finish should crown a killa; events: ${res.events.join(" | ")}`);
  assert.equal(after.stuck, false, "and it must NOT be treated as getting stuck");
});

test("dead-centre 13 after the run still makes you a killa", () => {
  const state = newState(2);
  const cap = state.caps[0];
  cap.step = FINAL_STEP;
  cap.onBoard = true;
  cap.x = -1.4; // just short of centre so a nudge lands in 13
  cap.z = 0;
  state.caps[1].x = -120;
  state.caps[1].z = -120;

  const res = resolveShot(state, false, false, 0, cap.id, { angle: 0, power: 0.02 });
  assert.equal(res.state.caps[0].killer, true, `13 finish should crown a killa; events: ${res.events.join(" | ")}`);
});

test("team-mates pass through each other — no collision, no hit", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const mate = state.caps[1];
  // Same team, both armed and mid-route.
  shooter.team = 0;
  mate.team = 0;
  shooter.step = 5;
  mate.step = 5;
  shooter.onBoard = true;
  mate.onBoard = true;
  shooter.missedTarget = true;
  shooter.x = -3;
  shooter.z = 0;
  mate.x = 0.5;
  mate.z = 0; // dead in the shot line
  const before = shooter.step;
  const mateBefore = { x: mate.x, z: mate.z };

  const res = resolveShot(state, /* teamMode */ true, false, 0, shooter.id, { angle: 0, power: 0.6 });
  const afterShooter = res.state.caps.find((c) => c.id === shooter.id)!;
  const afterMate = res.state.caps.find((c) => c.id === mate.id)!;
  // The team-mate is untouched, and the shooter sails straight through it.
  assert.ok(
    Math.hypot(afterMate.x - mateBefore.x, afterMate.z - mateBefore.z) < 0.05,
    "a team-mate is never knocked",
  );
  assert.ok(afterShooter.x > mate.x + 0.5, "the shooter passes through the team-mate");
  assert.equal(res.extraTurn, false, "passing a team-mate is not a hit");
  assert.equal(afterShooter.step, before, "and earns no boxes");
});

test("landing your target first try blazes 3 boxes, after a miss only 1", () => {
  const box2 = boxByNumber(2)!;
  const build = (missed: boolean) => {
    const state = newState(2);
    const cap = state.caps[0];
    cap.step = 2; // target is box 2
    cap.missedTarget = missed;
    cap.onBoard = true;
    // Start just short of box 2 and tap straight into it.
    cap.x = box2.x - 3;
    cap.z = box2.z;
    state.caps[1].x = -140;
    state.caps[1].z = -140;
    return state;
  };

  const fresh = resolveShot(build(false), false, false, 0, "0", { angle: 0, power: 0.032 });
  const stale = resolveShot(build(true), false, false, 0, "0", { angle: 0, power: 0.032 });

  // Fresh: make box 2 (+1) and blaze 3 more → step 6, sitting on box 5.
  assert.equal(fresh.state.caps[0].step, 6, "first-try landing makes the box + blazes 3 (net 4)");
  const box5 = boxByNumber(5)!;
  assert.ok(
    Math.abs(fresh.state.caps[0].x - box5.x) < 0.001 && Math.abs(fresh.state.caps[0].z - box5.z) < 0.001,
    "and the top is carried onto the box it blazed to",
  );
  assert.equal(stale.state.caps[0].step, 3, "a repeat landing only moves 1");
});

test("the blaze bonus example: from box 3 make box 4, end up on box 7", () => {
  // Targeting box 4 (step 4). Land box 4 first try → make it + blaze 3 → sit
  // on box 7, next target box 8. (Boxes needn't be physically adjacent; only
  // the target and the landing matter.)
  const box4 = boxByNumber(4)!;
  const box7 = boxByNumber(7)!;
  const state = newState(2);
  const cap = state.caps[0];
  cap.step = 4; // ROUTE[4] === 4, so target is box 4
  cap.onBoard = true;
  cap.x = box4.x - 3; // just short of box 4
  cap.z = box4.z;
  state.caps[1].x = -140;
  state.caps[1].z = -140;

  // Tap straight into box 4.
  const res = resolveShot(state, false, false, 0, "0", { angle: 0, power: 0.032 });
  const after = res.state.caps[0];
  assert.equal(after.step, 8, "step 8 — box 7 made, box 8 next");
  assert.equal(ROUTE[after.step], 8, "next target is box 8");
  assert.ok(
    Math.abs(after.x - box7.x) < 0.001 && Math.abs(after.z - box7.z) < 0.001,
    `top should sit on box 7; was (${after.x.toFixed(1)}, ${after.z.toFixed(1)})`,
  );
});

test("a repeat (non-bonus) landing leaves the cap where it stopped, not snapped to the box centre", () => {
  const box2 = boxByNumber(2)!;
  const state = newState(2);
  const cap = state.caps[0];
  cap.step = 2; // target is box 2
  cap.missedTarget = true; // already missed once → no blaze, no reposition
  cap.onBoard = true;
  // Start off-centre inside box 2's approach so the cap comes to rest off-centre
  // but still cleanly inside the box.
  cap.x = box2.x - 2.4;
  cap.z = box2.z + 0.5;
  state.caps[1].x = -140;
  state.caps[1].z = -140;

  const res = resolveShot(state, false, false, 0, "0", { angle: 0, power: 0.02 });
  const after = res.state.caps[0];
  const [restX, restZ] = res.frames.at(-1)!.p[0];

  assert.ok(after.step > 2, "it should have made box 2");
  // The cap is left where the physics stopped it (matching the final frame,
  // give or take frame rounding) — NOT teleported to the box centre.
  assert.ok(Math.abs(after.x - restX) < 0.01 && Math.abs(after.z - restZ) < 0.01, "position is the resting spot");
  assert.ok(insideBox(2, after.x, after.z), "and it is genuinely inside box 2");
  assert.ok(
    Math.hypot(after.x - box2.x, after.z - box2.z) > 0.05,
    `cap should not be snapped to box-2 centre; was (${after.x.toFixed(2)}, ${after.z.toFixed(2)})`,
  );
});

test("getting knocked into a middle panel pins you there", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const victim = state.caps[1];

  // Both are past box 1, so the strike is legal and the middle is live.
  shooter.step = 4;
  victim.step = 4;
  shooter.onBoard = true;
  victim.onBoard = true;

  // Park the victim just short of the 4 panel and shove it straight in.
  victim.x = 3.0;
  victim.z = 0;
  shooter.x = victim.x - 3;
  shooter.z = 0;

  const res = resolveShot(state, false, false, 0, shooter.id, { angle: 0, power: 0.06 });
  const after = res.state.caps[1];

  assert.equal(after.stuck, true, `victim should be pinned; events: ${res.events.join(" | ")}`);
  assert.equal(after.stuckValue, 4, "should be pinned in the 4");
  assert.equal(panelValueAt(after.x, after.z), 4, "and physically sitting in the 4");
});

test("knocking a pinned top out pays the opponent that many boxes", () => {
  const state = newState(2);
  const rescuer = state.caps[0];
  const pinned = state.caps[1];

  rescuer.step = 4; // armed, next target is box 4
  rescuer.onBoard = true;
  pinned.step = 4;
  pinned.onBoard = true;
  pinned.stuck = true;
  pinned.stuckValue = 6;
  pinned.x = 0;
  pinned.z = 5.8; // the 6 panel
  rescuer.x = 0;
  rescuer.z = pinned.z - 3;

  const before = rescuer.step;
  const res = resolveShot(state, false, false, 0, rescuer.id, { angle: Math.PI / 2, power: 0.06 });
  const after = res.state.caps[0];

  assert.equal(res.state.caps[1].stuck, false, "the pinned top is freed");
  assert.equal(after.step, before + 6, `rescuer should advance 6 boxes, went ${before} → ${after.step}`);
  assert.ok(
    res.events.some((e) => e.includes("collect 6 boxes")),
    `expected the collect event; got: ${res.events.join(" | ")}`,
  );
});

test("an illegal strike cannot pin anybody", () => {
  // The shooter hasn't made box 1, so the whole contact is void.
  const state = newState(2);
  const shooter = state.caps[0];
  const victim = state.caps[1];
  victim.step = 4;
  victim.onBoard = true;
  victim.x = 3.0;
  victim.z = 0;
  shooter.x = victim.x - 3;
  shooter.z = 0;
  shooter.onBoard = true;

  const res = resolveShot(state, false, false, 0, shooter.id, { angle: 0, power: 0.06 });
  assert.equal(res.state.caps[1].stuck, false, "a void strike must not trap the victim");
  assert.ok(res.events.some((e) => e.includes("START ALL OVER")));
});

test("killas are immune to being knocked into the middle", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const victim = state.caps[1];
  shooter.step = 4;
  shooter.onBoard = true;
  victim.killer = true;
  victim.onBoard = true;
  victim.x = 3.0;
  victim.z = 0;
  shooter.x = victim.x - 3;
  shooter.z = 0;

  const res = resolveShot(state, false, false, 0, shooter.id, { angle: 0, power: 0.06 });
  assert.equal(res.state.caps[1].stuck, false, "a killa has finished the route — the middle can't hold it");
});

test("the power meter swings up and back down while held", () => {
  const H = POWER_CYCLE_MS / 2;

  // Bottom of the swing at the start, top at the halfway point, bottom again
  // at the end — that is the whole point of releasing on time.
  assert.ok(Math.abs(powerAt(0) - MIN_CHARGE) < 1e-9, "starts at the floor");
  assert.ok(Math.abs(powerAt(H) - 1) < 1e-9, "reaches full power halfway");
  assert.ok(Math.abs(powerAt(POWER_CYCLE_MS) - MIN_CHARGE) < 1e-9, "returns to the floor");

  // Strictly rising up to the peak, strictly falling after it. Step so we
  // never straddle the peak, whatever the cycle length is.
  const step = H / 20;
  for (let t = 0; t + step <= H; t += step) assert.ok(powerAt(t + step) > powerAt(t), `should be rising at ${t}ms`);
  for (let t = H; t + step <= POWER_CYCLE_MS; t += step)
    assert.ok(powerAt(t + step) < powerAt(t), `should be falling at ${t}ms`);

  // Keeps swinging for as long as you hold, and never leaves a usable range.
  for (let t = 0; t < POWER_CYCLE_MS * 4; t += 17) {
    const p = powerAt(t);
    assert.ok(p >= MIN_CHARGE && p <= 1, `power ${p} out of range at ${t}ms`);
    assert.ok(Math.abs(p - powerAt(t + POWER_CYCLE_MS)) < 1e-9, "cycle should repeat exactly");
  }
});

test("the opening borough is Da Commons", () => {
  assert.equal(LEVELS[0].name, "Da Commons");
  // This is the string the chalk decal paints along the edge of the board.
  assert.equal(`SKELLZ - ${LEVELS[0].name.toUpperCase()}`, "SKELLZ - DA COMMONS");
});

test("hitting the outer wall no longer sends you back to START", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  shooter.step = 4;
  shooter.onBoard = true;
  // Sit just inside the left kerb and fire hard into it.
  shooter.x = RAIL.xMin + 2;
  shooter.z = 0;
  state.caps[1].x = 80;
  state.caps[1].z = 80;

  const startX = startPositionFor(0).x;
  const res = resolveShot(state, false, false, 0, shooter.id, { angle: Math.PI, power: 1 });
  const after = res.state.caps[0];

  // It bounced off the kerb but is still out on the lot, not parked back on the
  // START line, and it kept its progress.
  assert.equal(after.step, 4, "progress is preserved");
  assert.equal(after.onBoard, true, "still live on the board");
  assert.ok(Math.abs(after.x - startX) > 5, `should NOT be back at START (x=${after.x.toFixed(1)})`);
  assert.ok(
    !res.events.some((e) => e.includes("back to START")),
    `no send-home event; got: ${res.events.join(" | ")}`,
  );
});

test("in team mode a teammate is carried up to the leader's box", () => {
  const state = newState(2);
  const a = state.caps[0];
  const b = state.caps[1];
  a.team = 0;
  b.team = 0; // same team

  // A is parked way back near START; B is the one who just made a box.
  a.step = 2;
  a.onBoard = true;
  a.x = startPositionFor(0).x;
  a.z = startPositionFor(0).z;

  // Put B just short of box 5 and tap it in, so B advances and drags A along.
  b.step = 5; // targeting box 5
  b.onBoard = true;
  const box5 = boxByNumber(5)!;
  b.x = box5.x - 3;
  b.z = box5.z;

  const res = resolveShot(state, true, false, 0, b.id, { angle: 0, power: 0.032 });
  const afterA = res.state.caps.find((c) => c.id === a.id)!;
  const afterB = res.state.caps.find((c) => c.id === b.id)!;

  assert.equal(afterA.step, afterB.step, "the whole team shares the leader's step");
  // A rides up to the FRONT next to the leader B — but not on top of it.
  assert.ok(Math.abs(afterA.x - startPositionFor(0).x) > 5, "A is no longer back at START");
  const gap = Math.hypot(afterA.x - afterB.x, afterA.z - afterB.z);
  assert.ok(gap > CAP_R * 2, `A must not overlap the leader (gap ${gap.toFixed(2)})`);
  assert.ok(gap < 4, `A should gather near the leader (gap ${gap.toFixed(2)})`);
});

test("a whole synced team spreads out — no two tops overlap", () => {
  // Team of four: three sit back, one makes a box and drags the rest up.
  const state = newState(4);
  for (const c of state.caps) c.team = 0;
  const leader = state.caps[0];
  const box5 = boxByNumber(5)!;
  leader.step = 5;
  leader.onBoard = true;
  leader.x = box5.x - 3;
  leader.z = box5.z;
  for (let i = 1; i < 4; i++) {
    state.caps[i].step = 2;
    state.caps[i].onBoard = true;
    state.caps[i].x = startPositionFor(i).x;
    state.caps[i].z = startPositionFor(i).z;
  }

  const res = resolveShot(state, true, false, 0, leader.id, { angle: 0, power: 0.032 });
  const caps = res.state.caps;

  // Everyone shares the step, and no pair sits within a cap's width.
  const steps = new Set(caps.map((c) => c.step));
  assert.equal(steps.size, 1, "the whole team shares one step");
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      const d = Math.hypot(caps[i].x - caps[j].x, caps[i].z - caps[j].z);
      assert.ok(d > CAP_R * 2, `caps ${i} and ${j} overlap (gap ${d.toFixed(2)})`);
    }
  }
});

test("a carried team gathers INSIDE the one box, not in a ring outside it", () => {
  const state = newState(4);
  for (const c of state.caps) c.team = 0;
  const leader = state.caps[0];
  const box5 = boxByNumber(5)!;
  leader.step = 5;
  leader.onBoard = true;
  leader.x = box5.x - 3;
  leader.z = box5.z;
  for (let i = 1; i < 4; i++) {
    state.caps[i].step = 2;
    state.caps[i].onBoard = true;
    state.caps[i].x = startPositionFor(i).x;
    state.caps[i].z = startPositionFor(i).z;
  }

  const res = resolveShot(state, true, false, 0, leader.id, { angle: 0, power: 0.032 });
  // The team shares one step; the box they now sit on is ROUTE[step-1].
  const step = Math.max(...res.state.caps.map((c) => c.step));
  const boxN = ROUTE[step - 1];
  // Every team-mate — leader included — is fully inside that one box by street
  // rules, so they all shoot from it. (The old ring put them ~3.8 units out.)
  for (const c of res.state.caps) {
    assert.ok(insideBox(boxN, c.x, c.z), `${c.id} should be inside box ${boxN} (at ${c.x.toFixed(2)}, ${c.z.toFixed(2)})`);
  }
});

test("clusterTeamInBox fits four tops inside a box without overlapping", () => {
  const box = boxByNumber(7)!;
  const caps = [0, 1, 2, 3].map((i) => makeCap("c" + i, "C" + i, "#111", 0, i));
  clusterTeamInBox(caps, box);
  for (const c of caps) assert.ok(insideBox(7, c.x, c.z), `${c.id} inside the box`);
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      const d = Math.hypot(caps[i].x - caps[j].x, caps[i].z - caps[j].z);
      assert.ok(d > CAP_R * 2, `tops ${i} and ${j} overlap (gap ${d.toFixed(2)})`);
    }
  }
});

test("placement is clamped to the zone behind the START line", () => {
  // Right on the line stays put (within the tiny forward margin).
  const onLine = clampBehindStart(START_LINE.x, START_LINE.z);
  assert.ok(Math.hypot(onLine.x - START_LINE.x, onLine.z - START_LINE.z) < 1, "on-line point stays on the line");

  // A point way toward the board is pulled back to (just on) the line — you
  // can never place in front of it. START faces due west, so "toward board"
  // is +x and the clamp caps the forward component at ~0.5.
  const front = clampBehindStart(0, START_LINE.z);
  assert.ok(front.x <= START_LINE.x + 0.6, "cannot place in front of the line");

  // Way behind and far along the line clamps to the depth/width limits.
  const far = clampBehindStart(START_LINE.x - 200, START_LINE.z + 200);
  assert.ok(Math.abs(far.x - START_LINE.x) <= START_BACK_DEPTH + 0.001, "depth is capped");
  assert.ok(Math.abs(far.z - START_LINE.z) <= START_BAND_HALF + 0.001, "width along the line is capped");
  // And it's still a real spot, not off in space.
  assert.ok(Number.isFinite(far.x) && Number.isFinite(far.z));
});

test("in a team game team-mates take their turns back-to-back", () => {
  // Seats interleave the sides (team = slot % 2): A0, B0, A1, B1.
  const caps = [
    makeCap("a0", "A0", "#111", 0, 0),
    makeCap("b0", "B0", "#222", 1, 1),
    makeCap("a1", "A1", "#333", 0, 2),
    makeCap("b1", "B1", "#444", 1, 3),
  ];
  // Free-for-all just follows the seats.
  assert.deepEqual(turnOrder(caps, false), ["a0", "b0", "a1", "b1"], "ffa keeps seat order");
  // Teams play as blocks: both of team 0, then both of team 1, seat order kept
  // within each — so after A0 shoots, teammate A1 is next (not an opponent).
  assert.deepEqual(turnOrder(caps, true), ["a0", "a1", "b0", "b1"], "team-mates are consecutive");
});

test("team box placement is clamped to a disc around the box, and lets tops sit apart", () => {
  const box = boxByNumber(5)!;
  // A spot already inside the box is left untouched.
  const near = clampAroundBox(box.x + 1, box.z - 0.5, box.x, box.z);
  assert.equal(near.x, box.x + 1, "an in-zone spot is not moved");
  assert.equal(near.z, box.z - 0.5, "an in-zone spot is not moved");

  // A spot flung far away is pulled back onto the disc's rim — never further
  // than BOX_PLACE_R from the box centre, so you can only place on/around it.
  const far = clampAroundBox(box.x + 100, box.z + 100, box.x, box.z);
  const d = Math.hypot(far.x - box.x, far.z - box.z);
  assert.ok(d <= BOX_PLACE_R + 1e-9, "cannot place beyond the box zone");
  assert.ok(d > BOX_PLACE_R - 1e-6, "a far throw lands on the rim");

  // The disc is wide enough for two team-mates to stand clear of each other:
  // opposite rims are 2·BOX_PLACE_R apart, comfortably past a cap diameter.
  assert.ok(2 * BOX_PLACE_R > CAP_R * 2 + 1, "room for tops not to collide");
});

test("everyone pinned in the middle at once is a TIE", () => {
  const state = newState(2);
  const shooter = state.caps[0];
  const other = state.caps[1];
  shooter.step = 5; // armed
  shooter.onBoard = true;
  shooter.team = 0;
  shooter.x = 5.8; // the 4 panel
  shooter.z = 0;
  other.step = 5;
  other.onBoard = true;
  other.team = 1;
  other.stuck = true; // already pinned
  other.stuckValue = 8;
  other.x = -5.8; // the 8 panel
  other.z = 0;
  assert.equal(panelValueAt(shooter.x, shooter.z), 4, "shooter fixture sits in the 4");

  // A whisper of a tap keeps the shooter in the panel → it gets stuck too, so
  // now every top is stuck at once.
  const res = resolveShot(state, false, false, 0, shooter.id, { angle: Math.PI / 2, power: 0.006 });
  assert.equal(res.finished, true, `game should end; events: ${res.events.join(" | ")}`);
  assert.equal(res.winner, "Tie");
  assert.ok(res.events.some((e) => e.includes("TIE")));
});

test("a lone stuck top is spat back out, not called a tie", () => {
  // Solo (one cap): no opponent to free it, so keep the game moving.
  const state = newState(1);
  const cap = state.caps[0];
  cap.step = 5;
  cap.onBoard = true;
  cap.x = 5.8;
  cap.z = 0;
  const res = resolveShot(state, false, false, 0, cap.id, { angle: Math.PI / 2, power: 0.006 });
  assert.equal(res.finished, false, "a solo deadlock never ties");
  assert.equal(res.state.caps[0].stuck, false, "the lone top is spat back to the line");
});

test("every numbered box is reachable and unique", () => {
  const seen = new Set<string>();
  for (const b of BOXES) {
    const key = `${b.x},${b.z}`;
    assert.ok(!seen.has(key), `box ${b.n} overlaps another box`);
    seen.add(key);
  }
  assert.equal(BOXES.length, 13);
});
