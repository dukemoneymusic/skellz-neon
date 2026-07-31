import type { GameState } from "@/game/sim";

/**
 * In-process game store.
 *
 * The original build talked to Postgres through Drizzle and threw at import
 * time unless DATABASE_URL was set, so the game could not boot at all without
 * a database. Nothing here needs durability — a room is worthless the moment
 * its match ends — so state lives in memory instead. That makes the game a
 * zero-config single-process deploy.
 *
 * Note: this assumes ONE server process. If you ever scale to several
 * instances, room state must move to a shared store (Redis/Postgres) or
 * players will be routed to instances that have never heard of their room.
 */

export type LastShot = {
  seq: number;
  shooterId: string;
  angle: number;
  power: number;
  events: string[];
  before: { id: string; x: number; z: number }[];
};

export type Room = {
  id: number;
  code: string;
  status: "lobby" | "playing" | "finished";
  teamMode: boolean;
  mode: "pvp" | "story";
  level: number;
  storyScore: number;
  hostToken: string;
  turnIndex: number;
  seq: number;
  state: GameState;
  lastShot: LastShot | null;
  winner: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Player = {
  id: number;
  roomId: number;
  token: string;
  name: string;
  team: number;
  slot: number;
  color: string;
  color2: string;
  isHost: boolean;
  isBot: boolean;
  lastSeen: number;
  createdAt: number;
};

export type LeaderboardRow = {
  id: number;
  name: string;
  players: number;
  score: number;
  createdAt: number;
};

type Store = {
  rooms: Map<string, Room>;
  players: Map<number, Player>;
  leaderboard: LeaderboardRow[];
  locks: Map<string, Promise<unknown>>;
  nextRoomId: number;
  nextPlayerId: number;
  nextLeaderboardId: number;
};

/** Rooms nobody has touched for this long are swept away. */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
/** Codes that are re-created on demand and never expire. */
export const GLOBAL_ROOMS: Record<string, "pvp" | "story"> = { PVPX: "pvp", STRY: "story" };

// Survive Next.js dev hot-reloads, which re-evaluate modules on every edit.
const globalForStore = globalThis as typeof globalThis & { __skellzStore?: Store };

const store: Store =
  globalForStore.__skellzStore ??
  (globalForStore.__skellzStore = {
    rooms: new Map(),
    players: new Map(),
    leaderboard: [],
    locks: new Map(),
    nextRoomId: 1,
    nextPlayerId: 1,
    nextLeaderboardId: 1,
  });

function sweep() {
  const now = Date.now();
  for (const [code, room] of store.rooms) {
    if (GLOBAL_ROOMS[code]) continue;
    if (now - room.updatedAt < ROOM_TTL_MS) continue;
    store.rooms.delete(code);
    for (const [id, p] of store.players) {
      if (p.roomId === room.id) store.players.delete(id);
    }
  }
}

/**
 * Serialise everything that touches one room.
 *
 * Two clients can easily fire at the same instant (most obviously when several
 * players all notice a bot's turn at once). Without this, both would read the
 * same `seq`, both would pass their guard, and the bot would shoot twice.
 */
export async function withRoom<T>(code: string, fn: () => Promise<T> | T): Promise<T> {
  const key = code.toUpperCase();
  const prev = store.locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next waiter.
  store.locks.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (store.locks.get(key) === run) store.locks.delete(key);
  }
}

export function getRoom(code: string): Room | undefined {
  return store.rooms.get(code.toUpperCase());
}

export function createRoom(init: {
  code: string;
  hostToken: string;
  teamMode: boolean;
  mode: "pvp" | "story";
}): Room {
  sweep();
  const now = Date.now();
  const room: Room = {
    id: store.nextRoomId++,
    code: init.code.toUpperCase(),
    status: "lobby",
    teamMode: init.teamMode,
    mode: init.mode,
    level: 0,
    storyScore: 0,
    hostToken: init.hostToken,
    turnIndex: 0,
    seq: 0,
    state: { caps: [], log: [] },
    lastShot: null,
    winner: null,
    createdAt: now,
    updatedAt: now,
  };
  store.rooms.set(room.code, room);
  return room;
}

/** Fetch a room, conjuring the permanent public rooms into existence on demand. */
export function getOrCreateRoom(code: string): Room | undefined {
  const upper = code.toUpperCase();
  const existing = store.rooms.get(upper);
  if (existing) return existing;
  const globalMode = GLOBAL_ROOMS[upper];
  if (!globalMode) return undefined;
  return createRoom({ code: upper, hostToken: "global_room", teamMode: false, mode: globalMode });
}

export function updateRoom(room: Room, patch: Partial<Room>): Room {
  Object.assign(room, patch, { updatedAt: Date.now() });
  return room;
}

export function roomExists(code: string): boolean {
  return store.rooms.has(code.toUpperCase()) || Boolean(GLOBAL_ROOMS[code.toUpperCase()]);
}

export function listPlayers(roomId: number): Player[] {
  return [...store.players.values()].filter((p) => p.roomId === roomId).sort((a, b) => a.slot - b.slot);
}

export function addPlayer(init: Omit<Player, "id" | "lastSeen" | "createdAt">): Player {
  const now = Date.now();
  const player: Player = { ...init, id: store.nextPlayerId++, lastSeen: now, createdAt: now };
  store.players.set(player.id, player);
  return player;
}

export function updatePlayer(player: Player, patch: Partial<Player>): Player {
  Object.assign(player, patch);
  return player;
}

export function addLeaderboardRow(row: Omit<LeaderboardRow, "id" | "createdAt">): LeaderboardRow {
  const entry: LeaderboardRow = { ...row, id: store.nextLeaderboardId++, createdAt: Date.now() };
  store.leaderboard.push(entry);
  return entry;
}

/** Fewest shots wins, so the leaderboard sorts ascending. */
export function topLeaderboard(limit = 10): LeaderboardRow[] {
  return [...store.leaderboard].sort((a, b) => a.score - b.score).slice(0, limit);
}

export function stats() {
  return { rooms: store.rooms.size, players: store.players.size, leaderboard: store.leaderboard.length };
}

/**
 * Who is allowed to start a match, add CPUs, and advance levels.
 *
 * The permanent public rooms (PVPX / STRY) are created by the server, so no
 * real player ever holds their host token — without this, nobody could press
 * Start in them and they were permanently stuck in the lobby. There, the
 * longest-standing player in the room acts as host.
 */
export function canControl(room: Room, player: Player, roster: Player[]): boolean {
  if (player.isHost) return true;
  if (!GLOBAL_ROOMS[room.code]) return false;
  const humans = roster.filter((p) => !p.isBot);
  return humans.length > 0 && humans[0].id === player.id;
}
