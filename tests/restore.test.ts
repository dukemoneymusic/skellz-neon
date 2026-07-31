import assert from "node:assert/strict";
import test from "node:test";
import { isPendingToken, pendingTokenFor, shouldAdoptSnapshot, validateSnapshot } from "../src/server/restore";
import { makeCap } from "../src/game/sim";

/**
 * Rooms live in one process's memory, so a deploy or crash loses them. Clients
 * hand their snapshot back to rebuild the room — which means this validator is
 * the only thing standing between a hostile payload and the game state.
 */

function goodSnapshot() {
  const caps = [
    makeCap("1", "Duke", "#ff3b6b", 0, 0, "#22d3ee"),
    makeCap("2", "CPU 2", "#22d3ee", 1, 1, "#a855f7"),
  ];
  caps[0].step = 7;
  caps[1].stuck = true;
  caps[1].stuckValue = 4;
  return {
    room: {
      code: "AB12",
      status: "playing",
      teamMode: false,
      mode: "pvp",
      level: 3,
      storyScore: 11,
      turnIndex: 1,
      seq: 42,
      winner: null,
    },
    players: [
      { id: 1, name: "Duke", team: 0, slot: 0, color: "#ff3b6b", color2: "#22d3ee", isHost: true, isBot: false },
      { id: 2, name: "CPU 2", team: 1, slot: 1, color: "#22d3ee", color2: "#a855f7", isHost: false, isBot: true },
    ],
    meId: 1,
    state: { caps, log: ["Game on!"] },
  };
}

test("a well-formed snapshot round-trips", () => {
  const snap = validateSnapshot(goodSnapshot(), "AB12");
  assert.ok(snap, "should accept its own output");
  assert.equal(snap.room.seq, 42);
  assert.equal(snap.room.level, 3);
  assert.equal(snap.meId, 1);
  assert.equal(snap.players.length, 2);
  assert.equal(snap.state.caps[0].step, 7);
  // CPU seats have to survive, or the match wedges on their turn.
  assert.equal(snap.players[1].isBot, true);
  assert.equal(snap.state.caps[1].stuckValue, 4);
});

test("the room code is matched case-insensitively but must match", () => {
  assert.ok(validateSnapshot(goodSnapshot(), "ab12"), "case should not matter");
  assert.equal(validateSnapshot(goodSnapshot(), "ZZZZ"), null, "a snapshot cannot be replayed into another room");
});

test("malformed snapshots are rejected rather than thrown on", () => {
  const bad: [string, unknown][] = [
    ["not an object", 42],
    ["null", null],
    ["missing room", { players: [], meId: 1, state: { caps: [], log: [] } }],
    ["missing state", { ...goodSnapshot(), state: undefined }],
    ["no players", { ...goodSnapshot(), players: [] }],
    ["meId not in roster", { ...goodSnapshot(), meId: 99 }],
    ["unknown status", { ...goodSnapshot(), room: { ...goodSnapshot().room, status: "hacked" } }],
    ["unknown mode", { ...goodSnapshot(), room: { ...goodSnapshot().room, mode: "cheat" } }],
    ["negative seq", { ...goodSnapshot(), room: { ...goodSnapshot().room, seq: -1 } }],
    ["NaN level", { ...goodSnapshot(), room: { ...goodSnapshot().room, level: Number.NaN } }],
  ];
  for (const [label, payload] of bad) {
    assert.equal(validateSnapshot(payload, "AB12"), null, `should reject: ${label}`);
  }
});

test("a CPU seat cannot be the one claiming the room", () => {
  // Otherwise anyone could claim a bot's seat and act as it.
  const snap = { ...goodSnapshot(), meId: 2 };
  assert.equal(validateSnapshot(snap, "AB12"), null);
});

test("injected colours and oversized rosters are refused", () => {
  const badColour = goodSnapshot();
  badColour.players[0].color = "javascript:alert(1)";
  assert.equal(validateSnapshot(badColour, "AB12"), null, "colours must be plain hex");

  const tooMany = goodSnapshot();
  tooMany.players = Array.from({ length: 12 }, (_, i) => ({
    ...goodSnapshot().players[0],
    id: i + 1,
    slot: 0,
  }));
  assert.equal(validateSnapshot(tooMany, "AB12"), null, "roster cannot exceed the table");
});

test("the log is trimmed rather than trusted", () => {
  const snap = goodSnapshot();
  snap.state.log = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const out = validateSnapshot(snap, "AB12");
  assert.ok(out);
  assert.ok(out.state.log.length <= 40, `log should be capped, got ${out.state.log.length}`);
});

test("a snapshot only wins when it is genuinely ahead", () => {
  // Never seen this room — anything is better than nothing.
  assert.equal(shouldAdoptSnapshot(null, 0), true);
  // A public room the server just re-conjured at seq 0 is behind by definition.
  assert.equal(shouldAdoptSnapshot(0, 42), true);
  // A live match that has moved on must not be dragged backwards by a stale tab.
  assert.equal(shouldAdoptSnapshot(50, 42), false);
  assert.equal(shouldAdoptSnapshot(42, 42), false, "equal is not ahead — leave the live room alone");
});

test("placeholder tokens are recognisable and distinct per seat", () => {
  assert.ok(isPendingToken(pendingTokenFor(7)));
  assert.notEqual(pendingTokenFor(7), pendingTokenFor(8));
  // A real token must never look claimable.
  assert.equal(isPendingToken("V1StGXR8Z5jdHi6B"), false);
  assert.equal(isPendingToken("bot_abc123"), false);
});
