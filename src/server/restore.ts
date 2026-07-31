import type { Cap, GameState } from "../game/sim";
// Relative rather than the "@/" alias: this module is covered by the test
// build, which compiles to CommonJS and does not rewrite path aliases.
import { MAX_PLAYERS } from "../game/board";

/**
 * Self-healing rooms.
 *
 * Room state lives in one process's memory, so a deploy, crash or cold start
 * wipes every match in progress. Rather than take on a database — Render's free
 * Postgres expires after 30 days, and polling every 1.2s would burn through any
 * free request quota — the clients rebuild the room themselves.
 *
 * Every client is already sent the complete authoritative state on every poll,
 * so each one holds a usable snapshot. When a client notices its room has
 * vanished (or come back with a lower seq than it last saw), it offers its
 * snapshot back. The server accepts it only if it is genuinely newer, and each
 * player restores their own seat, so the roster reassembles as people reconnect.
 *
 * This is deliberately trusting: a 4-character room code is not a security
 * boundary, and the worst a bad snapshot can do is corrupt one throwaway game.
 * The seq check below is what stops a stale client from dragging a live match
 * backwards, which is the failure that would actually be noticed.
 */

export type SnapshotRoom = {
  code: string;
  status: "lobby" | "playing" | "finished";
  teamMode: boolean;
  mode: "pvp" | "story";
  level: number;
  storyScore: number;
  turnIndex: number;
  seq: number;
  winner: string | null;
};

export type SnapshotSeat = {
  id: number;
  name: string;
  team: number;
  slot: number;
  color: string;
  color2: string;
  isHost: boolean;
  isBot: boolean;
};

/**
 * The whole roster travels, not just the caller. Cap ids in the game state are
 * player ids, and CPU seats have no client of their own to restore them — miss
 * them out and the match wedges the moment it reaches a bot's turn.
 */
export type RoomSnapshot = { room: SnapshotRoom; players: SnapshotSeat[]; meId: number; state: GameState };

/**
 * Seats are rebuilt holding this instead of a real token. The first client to
 * present a genuine token claims the seat; after that it cannot be re-claimed,
 * so a restore can never be used to take over a seat somebody is playing.
 */
export const PENDING_TOKEN_PREFIX = "restore_pending_";

export const pendingTokenFor = (id: number) => `${PENDING_TOKEN_PREFIX}${id}`;
export const isPendingToken = (token: string) => token.startsWith(PENDING_TOKEN_PREFIX);

const HEX = /^#[0-9a-fA-F]{6}$/;
const STATUSES = ["lobby", "playing", "finished"] as const;
const MODES = ["pvp", "story"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** A cap we are willing to take back, with every field pinned to a sane range. */
function cleanCap(raw: unknown): Cap | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 24);
  const name = str(raw.name, 24);
  const color = str(raw.color, 9);
  const color2 = str(raw.color2, 9);
  const x = num(raw.x, -1e5, 1e5);
  const z = num(raw.z, -1e5, 1e5);
  const step = num(raw.step, 0, 64);
  const team = num(raw.team, 0, 32);
  if (id === null || name === null || x === null || z === null || step === null || team === null) return null;
  if (color === null || color2 === null || !HEX.test(color) || !HEX.test(color2)) return null;

  const damage: Record<string, number> = {};
  if (isObj(raw.damage)) {
    for (const [k, v] of Object.entries(raw.damage)) {
      const d = num(v, 0, 999);
      if (k.length <= 24 && d !== null) damage[k] = d;
    }
  }

  return {
    id,
    name,
    color,
    color2,
    team,
    x,
    z,
    step,
    killer: Boolean(raw.killer),
    stuck: Boolean(raw.stuck),
    stuckValue: num(raw.stuckValue, 0, 8) ?? 0,
    triedBreak: Boolean(raw.triedBreak),
    missedTarget: Boolean(raw.missedTarget),
    alive: Boolean(raw.alive),
    onBoard: Boolean(raw.onBoard),
    kills: num(raw.kills, 0, 999) ?? 0,
    damage,
    score: num(raw.score, -1e6, 1e6) ?? 0,
  };
}

/**
 * Parse an offered snapshot, rejecting anything malformed. Returns null rather
 * than throwing so a broken client can never take the server down with it.
 */
export function validateSnapshot(raw: unknown, code: string): RoomSnapshot | null {
  if (!isObj(raw) || !isObj(raw.room) || !isObj(raw.state)) return null;

  const r = raw.room;
  const roomCode = str(r.code, 8);
  if (roomCode === null || roomCode.toUpperCase() !== code.toUpperCase()) return null;

  const status = STATUSES.find((s) => s === r.status);
  const mode = MODES.find((m) => m === r.mode);
  const level = num(r.level, 0, 64);
  const storyScore = num(r.storyScore, 0, 1e6);
  const turnIndex = num(r.turnIndex, 0, 1e6);
  const seq = num(r.seq, 0, 1e9);
  if (!status || !mode || level === null || storyScore === null || turnIndex === null || seq === null) return null;

  const meId = num(raw.meId, 1, 1e9);
  const rawSeats = Array.isArray(raw.players) ? raw.players : null;
  if (meId === null || !rawSeats || rawSeats.length === 0 || rawSeats.length > MAX_PLAYERS) return null;

  const players: SnapshotSeat[] = [];
  for (const s of rawSeats) {
    if (!isObj(s)) return null;
    const id = num(s.id, 1, 1e9);
    const name = str(s.name, 24);
    const team = num(s.team, 0, 32);
    const slot = num(s.slot, 0, MAX_PLAYERS - 1);
    const color = str(s.color, 9);
    const color2 = str(s.color2, 9);
    if (id === null || name === null || team === null || slot === null) return null;
    if (color === null || color2 === null || !HEX.test(color) || !HEX.test(color2)) return null;
    players.push({ id, name, team, slot, color, color2, isHost: Boolean(s.isHost), isBot: Boolean(s.isBot) });
  }
  // The caller has to actually be one of the seats they are handing back.
  const me = players.find((p) => p.id === meId);
  if (!me || me.isBot) return null;

  const rawCaps = Array.isArray(raw.state.caps) ? raw.state.caps : null;
  if (!rawCaps || rawCaps.length > MAX_PLAYERS) return null;
  const caps: Cap[] = [];
  for (const c of rawCaps) {
    const cap = cleanCap(c);
    if (!cap) return null;
    caps.push(cap);
  }

  const log = Array.isArray(raw.state.log)
    ? raw.state.log.filter((l): l is string => typeof l === "string" && l.length <= 300).slice(0, 40)
    : [];

  return {
    room: {
      code: roomCode.toUpperCase(),
      status,
      teamMode: Boolean(r.teamMode),
      mode,
      level,
      storyScore,
      turnIndex,
      seq,
      winner: typeof r.winner === "string" ? r.winner.slice(0, 60) : null,
    },
    players,
    meId,
    state: { caps, log },
  };
}

/**
 * Only take a snapshot that is ahead of what we already have. A room we have
 * never seen (or a public room the server just re-conjured at seq 0) is behind
 * by definition; a live match that has moved on is not, and must win.
 */
export function shouldAdoptSnapshot(existingSeq: number | null, snapshotSeq: number): boolean {
  if (existingSeq === null) return true;
  return snapshotSeq > existingSeq;
}
