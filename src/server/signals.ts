/**
 * WebRTC signaling relay for voice chat.
 *
 * The game already syncs over plain HTTP polling, so voice signalling rides the
 * same way: each player has a little mailbox per room, other players drop SDP
 * offers/answers and ICE candidates into it, and the owner drains it on a short
 * poll. The actual audio is peer-to-peer (never touches this server) — only the
 * tiny setup handshake passes through here.
 *
 * Deliberately NOT behind the room lock: these are high-frequency, independent
 * of game state, and simple map ops on a single-threaded runtime.
 */

export type Signal = { from: number; kind: "offer" | "answer" | "ice" | "bye"; data: unknown; t: number };

type RoomMailboxes = Map<number, Signal[]>; // recipient player id -> queued signals

const g = globalThis as typeof globalThis & { __skellzSignals?: Map<string, RoomMailboxes> };
const rooms: Map<string, RoomMailboxes> = g.__skellzSignals ?? (g.__skellzSignals = new Map());

const MAX_PER_MAILBOX = 64; // plenty for a handshake; drop oldest beyond this
const SIGNAL_TTL_MS = 40_000; // stale handshake fragments are useless

function mailboxes(code: string): RoomMailboxes {
  const key = code.toUpperCase();
  let m = rooms.get(key);
  if (!m) {
    m = new Map();
    rooms.set(key, m);
  }
  return m;
}

/** Drop one signal into a recipient's mailbox. */
export function sendSignal(code: string, to: number, sig: Signal) {
  const m = mailboxes(code);
  const box = m.get(to) ?? [];
  box.push(sig);
  // Keep it bounded and fresh.
  const now = Date.now();
  const trimmed = box.filter((s) => now - s.t < SIGNAL_TTL_MS).slice(-MAX_PER_MAILBOX);
  m.set(to, trimmed);
}

/** Take and clear everything waiting for one recipient. */
export function drainSignals(code: string, recipient: number): Signal[] {
  const m = rooms.get(code.toUpperCase());
  if (!m) return [];
  const box = m.get(recipient);
  if (!box || box.length === 0) return [];
  m.set(recipient, []);
  const now = Date.now();
  return box.filter((s) => now - s.t < SIGNAL_TTL_MS);
}

/** Forget a room's mailboxes entirely (e.g. when it's swept). */
export function clearRoomSignals(code: string) {
  rooms.delete(code.toUpperCase());
}
