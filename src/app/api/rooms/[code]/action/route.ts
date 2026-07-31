import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { LAST_LEVEL, MAX_PLAYERS } from "@/game/board";
import { computeBotShot } from "@/game/bot";
import { COLORS, COLORS2 } from "@/game/colors";
import { makeCap, resolveShot, type Cap, type ShotInput } from "@/game/sim";
import {
  addLeaderboardRow,
  addPlayer,
  canControl,
  getOrCreateRoom,
  listPlayers,
  updatePlayer,
  updateRoom,
  withRoom,
  type Player,
  type Room,
} from "@/server/store";

export const dynamic = "force-dynamic";

type Body = {
  action: "join" | "start" | "shot" | "bot_shot" | "team" | "rematch" | "color" | "next_level" | "add_bot";
  name?: string;
  token?: string;
  team?: number;
  color?: string;
  color2?: string;
  angle?: number;
  power?: number;
  seq?: number;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Whose turn it is, as a cap id. */
function currentCapId(room: Room): string | null {
  const order = room.state.caps.map((c) => c.id);
  if (order.length === 0) return null;
  return order[room.turnIndex % order.length];
}

/**
 * Resolve one shot and commit it.
 *
 * Shared by human and CPU turns so both write an identical record. Crucially
 * `lastShot.shooterId` is the id of the cap that actually shot — the original
 * always wrote the *requesting player's* id, which meant every other client
 * replayed a bot's turn as though the host had taken it, and the 3D replay
 * diverged from the real board the moment a CPU joined.
 */
function applyShot(room: Room, roster: Player[], shooterId: string, input: ShotInput) {
  const before = room.state;
  const order = before.caps.map((c) => c.id);
  const result = resolveShot(before, room.teamMode, room.mode === "story", room.level, shooterId, input);

  // pass the turn, skipping anyone pinned in the middle
  let nextIndex = room.turnIndex;
  if (!result.extraTurn) {
    const pick = (allowStuck: boolean) => {
      for (let i = 1; i <= order.length; i++) {
        const idx = (room.turnIndex + i) % order.length;
        const cap = result.state.caps.find((c) => c.id === order[idx]);
        if (cap?.alive && (allowStuck || !cap.stuck)) return idx;
      }
      return null;
    };
    nextIndex = pick(false) ?? pick(true) ?? room.turnIndex;
  }

  const seq = room.seq + 1;
  const storyScore = room.mode === "story" ? room.storyScore + 1 : room.storyScore;

  updateRoom(room, {
    state: result.state,
    turnIndex: nextIndex,
    seq,
    status: result.finished ? "finished" : "playing",
    winner: result.winner,
    storyScore,
    lastShot: {
      seq,
      shooterId,
      angle: input.angle,
      power: input.power,
      events: result.events,
      before: before.caps.filter((c) => c.alive).map((c) => ({ id: c.id, x: c.x, z: c.z })),
    },
  });

  if (result.finished && room.mode === "story" && room.level >= LAST_LEVEL) {
    addLeaderboardRow({
      name: roster
        .filter((r) => !r.isBot)
        .map((r) => r.name)
        .join(", ")
        .slice(0, 50) || "CPU run",
      players: roster.length,
      score: storyScore,
    });
  }

  return { result, seq };
}

/** Build a fresh set of caps for every player currently in the room. */
function freshCaps(room: Room, roster: Player[]): Cap[] {
  return roster.map((p, i) => makeCap(String(p.id), p.name, p.color, room.teamMode ? p.team : i, i, p.color2));
}

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;

  // Everything that mutates a room runs one-at-a-time. Several clients notice
  // a CPU's turn simultaneously and all fire `bot_shot`; without this they
  // would each read the same seq, each pass the guard, and the bot would take
  // several turns in a row.
  return withRoom(code, () => {
    const room = getOrCreateRoom(code);
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

    const roster = listPlayers(room.id);

    if (body.action === "join") {
      const existing = roster.find((p) => p.token === body.token);
      if (existing) return NextResponse.json({ token: existing.token, code: room.code });
      if (roster.length >= MAX_PLAYERS)
        return NextResponse.json({ error: `Room is full (${MAX_PLAYERS} max)` }, { status: 400 });
      const token = nanoid(16);
      const slot = roster.length;
      addPlayer({
        roomId: room.id,
        token,
        name: (body.name || `Player ${slot + 1}`).slice(0, 14),
        slot,
        // First human into a public room becomes its host, so Start is never
        // greyed out for everybody at once.
        isHost: roster.length === 0 && room.hostToken === "global_room",
        isBot: false,
        team: room.teamMode ? slot % 2 : 0,
        color: COLORS[slot % COLORS.length],
        color2: COLORS2[slot % COLORS2.length],
      });
      // Joining mid-match is allowed — you watch the current round and are
      // dealt in automatically on the next one. The original rejected this
      // outright, which permanently locked newcomers out of the public rooms
      // once a match had started there.
      return NextResponse.json({ token, code: room.code, spectating: room.status !== "lobby" });
    }

    const me = roster.find((p) => p.token === body.token);
    if (!me) return NextResponse.json({ error: "Not in this room" }, { status: 403 });
    const isController = canControl(room, me, roster);

    if (body.action === "color") {
      const updates: { color?: string; color2?: string } = {};
      if (body.color !== undefined) {
        if (!HEX.test(body.color)) return NextResponse.json({ error: "Bad colour" }, { status: 400 });
        updates.color = body.color;
      }
      if (body.color2 !== undefined) {
        if (!HEX.test(body.color2)) return NextResponse.json({ error: "Bad second colour" }, { status: 400 });
        updates.color2 = body.color2;
      }
      if (Object.keys(updates).length === 0)
        return NextResponse.json({ error: "No colour given" }, { status: 400 });
      updatePlayer(me, updates);
      // live-update the wax colours of the cap already on the board
      const state = room.state;
      if (state?.caps?.length) {
        const caps = state.caps.map((c) => (c.id === String(me.id) ? { ...c, ...updates } : c));
        updateRoom(room, { state: { ...state, caps }, seq: room.seq + 1 });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "add_bot") {
      if (!isController) return NextResponse.json({ error: "Only the host can add bots" }, { status: 403 });
      if (roster.length >= MAX_PLAYERS)
        return NextResponse.json({ error: `Room is full (${MAX_PLAYERS} max)` }, { status: 400 });
      const slot = roster.length;
      // Drop the CPU into whichever team is short-handed rather than always
      // team 2, which used to make every co-op match lopsided.
      let team = 0;
      if (room.teamMode) {
        const counts = [0, 1].map((t) => roster.filter((p) => p.team === t).length);
        team = counts[0] <= counts[1] ? 0 : 1;
      }
      addPlayer({
        roomId: room.id,
        token: `bot_${nanoid(12)}`,
        name: `CPU ${slot + 1}`,
        slot,
        isHost: false,
        isBot: true,
        team,
        color: COLORS[slot % COLORS.length],
        color2: COLORS2[slot % COLORS2.length],
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "team") {
      updatePlayer(me, { team: Math.max(0, Math.min(7, body.team || 0)) });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "start" || body.action === "rematch") {
      if (!isController) return NextResponse.json({ error: "Only the host can start" }, { status: 403 });
      if (roster.length < 1) return NextResponse.json({ error: "Need players" }, { status: 400 });
      updateRoom(room, {
        status: "playing",
        state: { caps: freshCaps(room, roster), log: ["Game on! Flick from START for box 1."] },
        turnIndex: 0,
        seq: room.seq + 1,
        lastShot: null,
        winner: null,
        storyScore: 0,
        level: 0,
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "next_level") {
      if (!isController) return NextResponse.json({ error: "Only the host can start" }, { status: 403 });
      if (room.status !== "finished" || room.mode !== "story")
        return NextResponse.json({ error: "Not ready for next level" }, { status: 400 });
      if (room.level >= LAST_LEVEL)
        return NextResponse.json({ error: "Campaign already complete" }, { status: 400 });
      updateRoom(room, {
        status: "playing",
        state: { caps: freshCaps(room, roster), log: ["Next borough! Flick from START."] },
        turnIndex: 0,
        seq: room.seq + 1,
        lastShot: null,
        winner: null,
        level: room.level + 1,
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "shot" || body.action === "bot_shot") {
      if (room.status !== "playing") return NextResponse.json({ error: "Game is not running" }, { status: 400 });

      const currentId = currentCapId(room);
      if (!currentId) return NextResponse.json({ error: "No caps on the board" }, { status: 400 });
      const currentPlayer = roster.find((p) => String(p.id) === currentId);
      const cap = room.state.caps.find((c) => c.id === currentId);
      if (!cap?.alive) return NextResponse.json({ error: "That top is out" }, { status: 400 });

      if (body.action === "bot_shot") {
        // Any human in the room may drive the CPUs. The original ran bot AI
        // only inside the host's browser, on a 1500 ms timer that was torn
        // down and restarted by every 1200 ms poll — so the timer never fired
        // and CPUs simply never took a turn.
        if (!currentPlayer?.isBot) return NextResponse.json({ error: "Not a CPU turn" }, { status: 400 });
        // Stale trigger: somebody already played this turn.
        if (typeof body.seq === "number" && body.seq !== room.seq)
          return NextResponse.json({ error: "Stale turn" }, { status: 409 });
        if (cap.stuck) {
          // Defensive: a pinned CPU can't shoot, so hand the turn on rather
          // than wedging the match.
          const order = room.state.caps.map((c) => c.id);
          for (let i = 1; i <= order.length; i++) {
            const idx = (room.turnIndex + i) % order.length;
            const next = room.state.caps.find((c) => c.id === order[idx]);
            if (next?.alive && !next.stuck) {
              updateRoom(room, { turnIndex: idx, seq: room.seq + 1 });
              break;
            }
          }
          return NextResponse.json({ ok: true, skipped: true, seq: room.seq });
        }

        const shot = computeBotShot(room.state, cap, room.level, room.teamMode);
        const { result, seq } = applyShot(room, roster, currentId, { angle: shot.angle, power: shot.power });
        return NextResponse.json({
          ok: true,
          bot: true,
          why: shot.why,
          events: result.events,
          seq,
          soundEvents: result.soundEvents,
        });
      }

      if (currentId !== String(me.id)) return NextResponse.json({ error: "Not your turn" }, { status: 400 });
      if (currentPlayer?.isBot) return NextResponse.json({ error: "That is a CPU turn" }, { status: 400 });
      if (cap.stuck)
        return NextResponse.json(
          { error: `Stuck in the ${cap.stuckValue} — wait to be knocked out` },
          { status: 400 },
        );

      const angle = typeof body.angle === "number" && Number.isFinite(body.angle) ? body.angle : 0;
      const rawPower = typeof body.power === "number" && Number.isFinite(body.power) ? body.power : 0.5;
      const power = Math.max(0.01, Math.min(1, rawPower));

      const { result, seq } = applyShot(room, roster, currentId, { angle, power });
      return NextResponse.json({ ok: true, events: result.events, seq, soundEvents: result.soundEvents });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  });
}
