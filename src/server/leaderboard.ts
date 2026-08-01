import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Global leaderboard, keyed on the name people actually type.
 *
 * A leaderboard is the one thing here that is meant to outlive a match, so it
 * gets what durability the host allows: it is written to a JSON file and read
 * back on boot. On a stable disk (local dev, a VPS, a Render paid disk) it
 * simply persists. On Render's free plan the filesystem is wiped on each
 * deploy — but this service pings itself to stay awake, so in practice the
 * board lasts until the next deploy. If the disk is read-only the writes fail
 * silently and it falls back to in-memory, which still survives every restart
 * that isn't a full process replacement (globalThis, below).
 *
 * Names are not authenticated — two people typing "Duke" share a row. For a
 * street game that is the honest, friction-free model; a real account system is
 * the only way around it and would defeat the "just share a link" point.
 */

export type Entry = {
  name: string; // the display name, in the casing last used
  wins: number; // PvP matches won
  plays: number; // finished games taken part in
  bestScore: number; // best single-match score (PvP points)
  bestStoryShots: number | null; // fewest shots to clear the whole campaign
  updatedAt: number;
};

type Board = Map<string, Entry>; // key = name.trim().toLowerCase()

const FILE = process.env.LEADERBOARD_FILE || join(process.cwd(), ".data", "leaderboard.json");

const g = globalThis as typeof globalThis & { __skellzBoard?: Board };

function load(): Board {
  const board: Board = new Map();
  try {
    if (existsSync(FILE)) {
      const rows = JSON.parse(readFileSync(FILE, "utf8")) as Entry[];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r && typeof r.name === "string") board.set(keyOf(r.name), sanitize(r));
        }
      }
    }
  } catch {
    // Corrupt or unreadable file — start clean rather than crash the server.
  }
  return board;
}

const board: Board = g.__skellzBoard ?? (g.__skellzBoard = load());

function keyOf(name: string): string {
  return name.trim().toLowerCase().slice(0, 24);
}

function sanitize(r: Entry): Entry {
  const n = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo;
  return {
    name: String(r.name).slice(0, 24),
    wins: n(r.wins, 0, 1e7),
    plays: n(r.plays, 0, 1e7),
    bestScore: n(r.bestScore, 0, 1e7),
    bestStoryShots:
      typeof r.bestStoryShots === "number" && Number.isFinite(r.bestStoryShots)
        ? Math.max(0, Math.round(r.bestStoryShots))
        : null,
    updatedAt: n(r.updatedAt, 0, Number.MAX_SAFE_INTEGER),
  };
}

let saveQueued = false;
function persist() {
  // Tests set this so the suite never touches the real disk.
  if (process.env.SKELLZ_NO_PERSIST === "1") return;
  // Coalesce bursts (a finished game touches several rows) into one write on
  // the next tick, so a busy room isn't hammering the disk.
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      const dir = dirname(FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(FILE, JSON.stringify([...board.values()]));
    } catch {
      // Read-only filesystem — keep going from memory. The board still works
      // for the life of this process.
    }
  });
}

function ensure(name: string): Entry {
  const key = keyOf(name);
  let e = board.get(key);
  if (!e) {
    e = { name: name.trim().slice(0, 24) || "Player", wins: 0, plays: 0, bestScore: 0, bestStoryShots: null, updatedAt: 0 };
    board.set(key, e);
  }
  return e;
}

export type GameResult = {
  mode: "pvp" | "story";
  /** Every human who took part, with their final single-match score. */
  players: { name: string; score: number }[];
  /** Names of the winning humans — one for free-for-all, a whole team in co-op. */
  winnerNames?: string[];
  /** Total shots for a fully-cleared story campaign, else null. */
  storyShots?: number | null;
};

/** Fold one finished game into the standings. Bots are never recorded. */
export function recordGame(result: GameResult) {
  const now = Date.now();
  const winners = new Set((result.winnerNames ?? []).map(keyOf));
  for (const p of result.players) {
    const name = p.name?.trim();
    if (!name) continue;
    const e = ensure(name);
    e.name = name.slice(0, 24); // remember their latest casing
    e.plays += 1;
    if (p.score > e.bestScore) e.bestScore = p.score;
    if (winners.has(keyOf(name))) e.wins += 1;
    if (typeof result.storyShots === "number") {
      e.bestStoryShots = e.bestStoryShots === null ? result.storyShots : Math.min(e.bestStoryShots, result.storyShots);
    }
    e.updatedAt = now;
  }
  persist();
}

export type PublicEntry = Entry & { rank: number };

/**
 * The ranked board. Sorted by wins, then best PvP score, then the best story
 * run (fewer shots is better) — so both a PvP brawler and a story speedrunner
 * have a way up the table.
 */
export function top(limit = 25): PublicEntry[] {
  return [...board.values()]
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.bestScore - a.bestScore ||
        (a.bestStoryShots ?? Infinity) - (b.bestStoryShots ?? Infinity) ||
        a.updatedAt - b.updatedAt,
    )
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

export function size() {
  return board.size;
}

/** Test-only: wipe the in-memory board so a suite starts from a clean slate. */
export function resetForTest() {
  board.clear();
}
