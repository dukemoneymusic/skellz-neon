import assert from "node:assert/strict";
import test from "node:test";
import { BOXES, LEVELS, ROUTE, boxByNumber, panelValueAt } from "../src/game/board";
import { computeBotShot } from "../src/game/bot";
import { makeCap, resolveShot, type Cap, type GameState } from "../src/game/sim";

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

test("breaking into a middle panel starts your run from that very number", () => {
  // Park a cap in the 4 panel and give it the gentlest possible flick sideways
  // so it stays inside the panel. It should come out of the break sitting on
  // box 4 with box 5 as its next target.
  const state = newState(2);
  const cap = state.caps[0];
  cap.x = 5.8;
  cap.z = 0;
  cap.onBoard = true;
  state.caps[1].x = -120;
  state.caps[1].z = -120;
  assert.equal(panelValueAt(cap.x, cap.z), 4, "fixture must actually sit in the 4 panel");

  const res = resolveShot(state, false, false, 0, cap.id, { angle: Math.PI / 2, power: 0.01 });
  const after = res.state.caps[0];
  const box4 = boxByNumber(4)!;

  assert.equal(after.step, 5, "step should be 5 — box 4 made, box 5 next");
  assert.equal(ROUTE[after.step], 5);
  assert.equal(after.x, box4.x);
  assert.equal(after.z, box4.z);
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

  assert.equal(fresh.state.caps[0].step, 5, "first-try landing should jump 3 boxes");
  assert.equal(stale.state.caps[0].step, 3, "a repeat landing should only move 1");
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
