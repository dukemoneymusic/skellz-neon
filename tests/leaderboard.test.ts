process.env.SKELLZ_NO_PERSIST = "1"; // never touch the disk from the test suite

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { recordGame, resetForTest, top } from "../src/server/leaderboard";

beforeEach(() => resetForTest());

test("a PvP win credits the winner and records everyone's play", () => {
  recordGame({
    mode: "pvp",
    players: [
      { name: "Duke", score: 120 },
      { name: "Ada", score: 80 },
    ],
    winnerNames: ["Duke"],
  });

  const board = top();
  assert.equal(board.length, 2);
  const duke = board.find((e) => e.name === "Duke")!;
  const ada = board.find((e) => e.name === "Ada")!;
  assert.equal(duke.wins, 1);
  assert.equal(duke.plays, 1);
  assert.equal(duke.bestScore, 120);
  assert.equal(ada.wins, 0);
  assert.equal(ada.plays, 1);
  // Ranked by wins — the winner sits on top.
  assert.equal(board[0].name, "Duke");
  assert.equal(board[0].rank, 1);
});

test("names are merged case-insensitively but keep their latest casing", () => {
  recordGame({ mode: "pvp", players: [{ name: "duke", score: 50 }], winnerNames: [] });
  recordGame({ mode: "pvp", players: [{ name: "DUKE", score: 90 }], winnerNames: ["DUKE"] });

  const board = top();
  assert.equal(board.length, 1, "the two spellings are the same player");
  assert.equal(board[0].name, "DUKE", "shows the most recent casing");
  assert.equal(board[0].plays, 2);
  assert.equal(board[0].wins, 1);
  assert.equal(board[0].bestScore, 90, "keeps the higher score");
});

test("a whole winning team is credited in co-op", () => {
  recordGame({
    mode: "pvp",
    players: [
      { name: "A", score: 10 },
      { name: "B", score: 20 },
      { name: "C", score: 30 },
    ],
    winnerNames: ["A", "B"], // A and B were the surviving team
  });
  const board = top();
  assert.equal(board.find((e) => e.name === "A")!.wins, 1);
  assert.equal(board.find((e) => e.name === "B")!.wins, 1);
  assert.equal(board.find((e) => e.name === "C")!.wins, 0);
});

test("story runs record the best (fewest) shots, and ties break by it", () => {
  recordGame({ mode: "story", players: [{ name: "Duke", score: 0 }], storyShots: 140 });
  recordGame({ mode: "story", players: [{ name: "Duke", score: 0 }], storyShots: 95 });
  recordGame({ mode: "story", players: [{ name: "Ada", score: 0 }], storyShots: 110 });

  const board = top();
  const duke = board.find((e) => e.name === "Duke")!;
  assert.equal(duke.bestStoryShots, 95, "keeps the fewest shots");

  // Nobody has a win, so ranking falls through to best story run: Duke (95)
  // ahead of Ada (110).
  assert.equal(board[0].name, "Duke");
  assert.equal(board[1].name, "Ada");
});

test("empty and whitespace names are ignored, bots never reach the board", () => {
  recordGame({ mode: "pvp", players: [{ name: "   ", score: 5 }], winnerNames: [] });
  recordGame({ mode: "pvp", players: [{ name: "", score: 5 }], winnerNames: [] });
  assert.equal(top().length, 0, "blank names don't create rows");
});

test("the board is capped and ranked", () => {
  for (let i = 0; i < 60; i++) {
    recordGame({ mode: "pvp", players: [{ name: `P${i}`, score: i }], winnerNames: i % 2 ? [`P${i}`] : [] });
  }
  const board = top(25);
  assert.equal(board.length, 25, "limit is honoured");
  // Ranks are contiguous from 1, and wins are non-increasing down the list.
  for (let i = 1; i < board.length; i++) {
    assert.equal(board[i].rank, i + 1);
    assert.ok(board[i - 1].wins >= board[i].wins, "sorted by wins descending");
  }
});
