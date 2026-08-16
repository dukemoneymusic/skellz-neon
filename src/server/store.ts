import { turnOrder, type GameState } from "@/game/sim";
import { size as leaderboardSize } from "@/server/leaderboard";

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

export type ChatMsg = { id: number; name: string; color: string; text: string; t: number };

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
  /** When the current player's turn began — drives the 45s auto-shoot timer. */
  turnStartedAt: number;
  /** Co-op only: has the team on turn made a box / hit a top somewhere in the
   *  current round? A round is one shot each; if anyone scored, the whole team
   *  shoots again, otherwise the turn passes to the other team. */
  teamRoundAdvanced: boolean;
  /** Recent game chat, newest last; bumped chatSeq lets clients notice new lines. */
  chat: ChatMsg[];
  chatSeq: number;
  nextChatId: number;
  /** Tokens the host has kicked, so their own client can be told and sent home. */
  kicked: Set<string>;
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

type Store = {
  rooms: Map<string, Room>;
  players: Map<number, Player>;
  locks: Map<string, Promise<unknown>>;
  nextRoomId: number;
  nextPlayerId: number;
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
    locks: new Map(),
    nextRoomId: 1,
    nextPlayerId: 1,
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
    turnStartedAt: now,
    teamRoundAdvanced: false,
    chat: [],
    chatSeq: 0,
    nextChatId: 1,
    kicked: new Set(),
  };
  store.rooms.set(room.code, room);
  return room;
}

/** Append a chat line and let clients notice it via the bumped chatSeq. */
export function addChat(room: Room, name: string, color: string, text: string) {
  const msg: ChatMsg = { id: room.nextChatId++, name: name.slice(0, 14), color, text: text.slice(0, 160), t: Date.now() };
  room.chat = [...room.chat, msg].slice(-40);
  room.chatSeq += 1;
  room.updatedAt = Date.now();
  return msg;
}

/**
 * Remove a player from a live room (host kick, or self-quit). Their cap is
 * taken off the board so the remaining players' game carries on, the turn is
 * nudged along if it was theirs, and the player row is deleted.
 */
export function removePlayer(room: Room, roster: Player[], targetId: number, kicked: boolean) {
  const target = roster.find((p) => p.id === targetId);
  if (!target) return;
  if (kicked) room.kicked.add(target.token);

  // Take their cap out of play (kept in the array so turn indices stay stable).
  const caps = room.state.caps.map((c) => (c.id === String(targetId) ? { ...c, alive: false } : c));
  room.state = { ...room.state, caps };

  // Delete the player row.
  for (const [id, p] of store.players) if (p.id === targetId) store.players.delete(id);

  // If it was their turn, hand it to the next living, un-stuck cap — following
  // the same team-grouped order the turn normally cycles through.
  const order = turnOrder(room.state.caps, room.teamMode);
  if (order.length > 0 && order[room.turnIndex % order.length] === String(targetId)) {
    for (let i = 1; i <= order.length; i++) {
      const idx = (room.turnIndex + i) % order.length;
      const cap = room.state.caps.find((c) => c.id === order[idx]);
      if (cap?.alive && !cap.stuck) {
        room.turnIndex = idx;
        break;
      }
    }
    room.turnStartedAt = Date.now();
  }

  // Losing a player can end the match (last one standing / last team standing).
  if (room.status === "playing") {
    const alive = room.state.caps.filter((c) => c.alive);
    if (room.mode === "story") {
      if (alive.length === 0) {
        room.status = "finished";
        room.winner = "Nobody";
      }
    } else if (room.teamMode) {
      const teams = new Set(alive.map((c) => c.team));
      if (teams.size <= 1 && room.state.caps.length > 1) {
        room.status = "finished";
        room.winner = teams.size === 1 ? `Team ${[...teams][0] + 1}` : "Nobody";
      }
    } else if (alive.length <= 1 && room.state.caps.length > 1) {
      room.status = "finished";
      room.winner = alive[0]?.name ?? "Nobody";
    }
  }

  room.seq += 1;
  room.updatedAt = Date.now();
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

/**
 * Add a player. An explicit `id` may be supplied when rebuilding a room from a
 * client snapshot — cap ids in the game state are player ids, so a restored
 * seat has to keep the number it had or it no longer owns its cap.
 */
export function addPlayer(init: Omit<Player, "id" | "lastSeen" | "createdAt"> & { id?: number }): Player {
  const now = Date.now();
  const id = init.id ?? store.nextPlayerId++;
  if (id >= store.nextPlayerId) store.nextPlayerId = id + 1;
  const player: Player = { ...init, id, lastSeen: now, createdAt: now };
  store.players.set(player.id, player);
  return player;
}

/** Insert a fully-formed room, used when adopting a snapshot. */
export function putRoom(room: Room): Room {
  if (room.id >= store.nextRoomId) store.nextRoomId = room.id + 1;
  store.rooms.set(room.code, room);
  return room;
}

/** Next free room id, for rooms being rebuilt rather than created fresh. */
export function reserveRoomId(): number {
  return store.nextRoomId++;
}

export function updatePlayer(player: Player, patch: Partial<Player>): Player {
  Object.assign(player, patch);
  return player;
}

export function stats() {
  return { rooms: store.rooms.size, players: store.players.size, leaderboard: leaderboardSize() };
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
