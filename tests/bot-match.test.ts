import assert from "node:assert/strict";
import test from "node:test";
import { computeBotShot } from "../src/game/bot";
import { makeCap, resolveShot, type Cap, type GameState } from "../src/game/sim";

/**
 * Plays a whole match with every seat driven by the CPU, mirroring exactly what
 * the server does per turn (resolve the shot, then hand the turn on, skipping
 * anyone pinned in the middle).
 *
 * This is the regression test for the headline bug: CPU turns used to be run by
 * a browser timer that was cancelled by every poll, so bots never took a single
 * shot and any match containing one simply stopped.
 */
function playBotMatch(opts: {
  players: number;
  levelIdx: number;
  teamMode: boolean;
  isStory: boolean;
  seed: number;
  maxTurns?: number;
}) {
  const { players, levelIdx, teamMode, isStory, seed, maxTurns = 3000 } = opts;
  let s = seed >>> 0 || 1;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const caps: Cap[] = [];
  for (let i = 0; i < players; i++) {
    caps.push(makeCap(String(i), `CPU ${i + 1}`, "#ff3b6b", teamMode ? i % 2 : i, i, "#22d3ee"));
  }
  let state: GameState = { caps, log: [] };
  let turnIndex = 0;
  let turns = 0;
  let finished = false;
  let winner: string | null = null;

  while (turns < maxTurns && !finished) {
    const order = state.caps.map((c) => c.id);
    const currentId = order[turnIndex % order.length];
    const cap = state.caps.find((c) => c.id === currentId);
    if (!cap || !cap.alive || cap.stuck) {
      // The turn-passing rule should already prevent this; if it ever happens,
      // move on rather than spinning forever.
      turnIndex = (turnIndex + 1) % order.length;
      turns++;
      continue;
    }

    const shot = computeBotShot(state, cap, levelIdx, teamMode, rng);
    assert.ok(Number.isFinite(shot.angle) && Number.isFinite(shot.power), "bot produced a broken shot");

    const res = resolveShot(state, teamMode, isStory, levelIdx, currentId, shot);
    state = res.state;
    finished = res.finished;
    winner = res.winner;
    turns++;

    if (!res.extraTurn) {
      const pick = (allowStuck: boolean) => {
        for (let i = 1; i <= order.length; i++) {
          const idx = (turnIndex + i) % order.length;
          const c = state.caps.find((x) => x.id === order[idx]);
          if (c?.alive && (allowStuck || !c.stuck)) return idx;
        }
        return null;
      };
      turnIndex = pick(false) ?? pick(true) ?? turnIndex;
    }
  }

  return { state, finished, winner, turns };
}

test("a CPU-only story level is actually cleared", () => {
  // Several seeds, so this cannot pass by luck.
  for (const seed of [1, 42, 1337, 90210]) {
    const out = playBotMatch({ players: 2, levelIdx: 0, teamMode: false, isStory: true, seed });
    assert.ok(out.finished, `seed ${seed}: level never finished after ${out.turns} turns`);
    assert.equal(out.winner, "Level Cleared");
    assert.ok(
      out.state.caps.some((c) => c.killer),
      `seed ${seed}: nobody ever became a KILLA`,
    );
  }
});

test("CPUs make real progress every match, not just noise", () => {
  const out = playBotMatch({ players: 4, levelIdx: 0, teamMode: false, isStory: true, seed: 5 });
  const best = Math.max(...out.state.caps.map((c) => c.step));
  assert.ok(best >= 27, `best CPU only reached step ${best}`);
  // Somebody has to have scored along the way.
  assert.ok(Math.max(...out.state.caps.map((c) => c.score)) > 0);
});

test("a CPU free-for-all resolves to a single winner", () => {
  for (const seed of [3, 77]) {
    const out = playBotMatch({ players: 3, levelIdx: 0, teamMode: false, isStory: false, seed });
    assert.ok(out.finished, `seed ${seed}: PvP never resolved in ${out.turns} turns`);
    assert.equal(out.state.caps.filter((c) => c.alive).length, 1);
    assert.ok(out.winner && out.winner !== "Nobody");
  }
});

test("CPU co-op teams finish too", () => {
  const out = playBotMatch({ players: 4, levelIdx: 0, teamMode: true, isStory: false, seed: 11 });
  assert.ok(out.finished, `co-op never resolved in ${out.turns} turns`);
  assert.ok(out.winner?.startsWith("Team"));
});

test("bots stay competent on the slick late-campaign boroughs", () => {
  // Level 19 is the slickest surface and also has the sharpest bots.
  const out = playBotMatch({ players: 2, levelIdx: 19, teamMode: false, isStory: true, seed: 2024 });
  assert.ok(out.finished, `Empire State never cleared in ${out.turns} turns`);
});

test("harder boroughs need fewer CPU shots than the starter yard", () => {
  const avg = (levelIdx: number) => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const total = seeds.reduce(
      (sum, seed) => sum + playBotMatch({ players: 2, levelIdx, teamMode: false, isStory: true, seed }).turns,
      0,
    );
    return total / seeds.length;
  };
  // Bot accuracy scales with level, so the last borough's CPUs should clear a
  // board in fewer turns than the first borough's wild flickers.
  assert.ok(avg(19) < avg(0), "late-game bots are not sharper than early-game bots");
});
