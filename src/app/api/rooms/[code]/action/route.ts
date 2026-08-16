import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { LAST_LEVEL, MAX_PLAYERS, ROUTE, boxByNumber, clampAroundBox, clampBehindStart } from "@/game/board";
import { computeAutoShot, computeBotShot } from "@/game/bot";
import { COLORS, COLORS2 } from "@/game/colors";
import { makeCap, resolveShot, turnOrder, type Cap, type ShotInput } from "@/game/sim";
import { recordGame } from "@/server/leaderboard";
import { isPendingToken, pendingTokenFor, shouldAdoptSnapshot, validateSnapshot } from "@/server/restore";
import {
  addChat,
  addPlayer,
  canControl,
  getOrCreateRoom,
  getRoom,
  listPlayers,
  putRoom,
  removePlayer,
  reserveRoomId,
  updatePlayer,
  updateRoom,
  withRoom,
  type Player,
  type Room,
} from "@/server/store";

export const dynamic = "force-dynamic";

type Body = {
  action:
    | "join"
    | "start"
    | "shot"
    | "bot_shot"
    | "team"
    | "rematch"
    | "color"
    | "next_level"
    | "add_bot"
    | "restore"
    | "chat"
    | "kick"
    | "leave"
    | "auto_shot";
  name?: string;
  token?: string;
  team?: number;
  playerId?: number;
  color?: string;
  color2?: string;
  angle?: number;
  power?: number;
  seq?: number;
  snapshot?: unknown;
  from?: { x?: number; z?: number };
  text?: string;
};

/** A human turn auto-shoots to the target box after this long. */
const AUTO_SHOOT_MS = 45_000;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Whose turn it is, as a cap id. */
function currentCapId(room: Room): string | null {
  const order = turnOrder(room.state.caps, room.teamMode);
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
  // Team-mates play as a block, so the turn cycles through this grouped order.
  const order = turnOrder(before.caps, room.teamMode);
  const result = resolveShot(before, room.teamMode, room.mode === "story", room.level, shooterId, input);

  // Pass the turn. Walk the grouped order from the current seat and take the
  // first cap that matches — preferring un-stuck caps, then allowing stuck ones
  // only if nobody else can go, so a pinned top never wedges the match.
  const pick = (match: (c: Cap) => boolean): number | null => {
    for (const allowStuck of [false, true]) {
      for (let i = 1; i <= order.length; i++) {
        const idx = (room.turnIndex + i) % order.length;
        const cap = result.state.caps.find((c) => c.id === order[idx]);
        if (cap?.alive && (allowStuck || !cap.stuck) && match(cap)) return idx;
      }
    }
    return null;
  };

  let nextIndex = room.turnIndex;
  // Both modes: make the box you're going for OR hit a top and you shoot AGAIN
  // (index unchanged). Otherwise the turn passes to the next player — and in
  // co-op the order is grouped by team, so it goes to your team-mate, then the
  // other team. When a team-mate advances, the sim's auto-carry brings the whole
  // team up onto the box, so they follow.
  if (!result.extraTurn) {
    nextIndex = pick(() => true) ?? room.turnIndex;
  }

  const seq = room.seq + 1;
  const storyScore = room.mode === "story" ? room.storyScore + 1 : room.storyScore;

  updateRoom(room, {
    state: result.state,
    turnIndex: nextIndex,
    seq,
    // Every shot restarts the current player's 45s clock — whether the turn
    // passed on or the shooter earned another go.
    turnStartedAt: Date.now(),
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

  if (result.finished) {
    // Record every finished game on the global, name-keyed leaderboard.
    // Bots never count. A player's cap carries their id, so their final score
    // is looked up by matching roster ids to caps.
    const capById = new Map(result.state.caps.map((c) => [c.id, c]));
    const humans = roster.filter((r) => !r.isBot);
    const players = humans.map((r) => ({ name: r.name, score: capById.get(String(r.id))?.score ?? 0 }));

    // Winners: the surviving team in co-op (every human on it), or the single
    // surviving cap's owner in free-for-all. Story wins credit nobody — the
    // achievement there is the clear itself, captured by storyShots.
    let winnerNames: string[] = [];
    // A tie credits nobody a win (everyone was pinned in the middle at once).
    if (room.mode === "pvp" && result.winner !== "Tie") {
      const survivors = result.state.caps.filter((c) => c.alive);
      if (room.teamMode && survivors.length > 0) {
        const winTeam = survivors[0].team;
        winnerNames = humans
          .filter((r) => capById.get(String(r.id))?.team === winTeam)
          .map((r) => r.name);
      } else if (survivors.length === 1) {
        const owner = humans.find((r) => String(r.id) === survivors[0].id);
        if (owner) winnerNames = [owner.name];
      }
    }

    const storyDone = room.mode === "story" && room.level >= LAST_LEVEL;
    if (players.length > 0) {
      recordGame({
        mode: room.mode,
        players,
        winnerNames,
        storyShots: storyDone ? storyScore : null,
      });
    }
  }

  return { result, seq };
}

/**
 * Rebuild a room from a client's snapshot after the server lost it.
 *
 * Two independent halves: adopting the game state (only if the snapshot is
 * genuinely ahead of whatever we hold) and re-seating the caller (always, so a
 * player can get their seat back even when somebody else already restored the
 * room a moment earlier).
 */
function restoreRoom(code: string, body: Body) {
  const token = typeof body.token === "string" && body.token.length > 0 ? body.token : null;
  const snap = validateSnapshot(body.snapshot, code);
  if (!token || !snap) return NextResponse.json({ error: "Bad snapshot" }, { status: 400 });

  let room = getRoom(code);
  const adopt = shouldAdoptSnapshot(room ? room.seq : null, snap.room.seq);
  const fields = {
    status: snap.room.status,
    teamMode: snap.room.teamMode,
    mode: snap.room.mode,
    level: snap.room.level,
    storyScore: snap.room.storyScore,
    turnIndex: snap.room.turnIndex,
    seq: snap.room.seq,
    state: snap.state,
    // Deliberately dropped: lastShot drives the 3D replay, and replaying the
    // turn that was in flight when the server died would desync the board.
    lastShot: null,
    winner: snap.room.winner,
  };

  if (!room) {
    const host = snap.players.find((p) => p.isHost);
    room = putRoom({
      id: reserveRoomId(),
      code: snap.room.code,
      hostToken: host && host.id === snap.meId ? token : pendingTokenFor(host?.id ?? 0),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnStartedAt: Date.now(),
      chat: [],
      chatSeq: 0,
      nextChatId: 1,
      kicked: new Set<string>(),
      ...fields,
    });
  } else if (adopt) {
    updateRoom(room, fields);
  }

  // Re-create every seat, CPUs included — they have no client to speak for them.
  const roster = listPlayers(room.id);
  for (const seat of snap.players) {
    if (roster.some((p) => p.id === seat.id)) continue;
    addPlayer({
      id: seat.id,
      roomId: room.id,
      token: seat.isBot ? `bot_${nanoid(12)}` : pendingTokenFor(seat.id),
      name: seat.name,
      team: seat.team,
      slot: seat.slot,
      color: seat.color,
      color2: seat.color2,
      isHost: seat.isHost,
      isBot: seat.isBot,
    });
  }

  // Claim our own seat. Only a seat still holding its placeholder can be
  // claimed, so this can never take a seat somebody is actively playing.
  const mine = listPlayers(room.id).find((p) => p.id === snap.meId);
  if (mine && !mine.isBot && isPendingToken(mine.token)) {
    updatePlayer(mine, { token, lastSeen: Date.now() });
    if (mine.isHost) updateRoom(room, { hostToken: token });
  }

  return NextResponse.json({ ok: true, adopted: adopt, seq: room.seq });
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
    // Handled first: the entire point is that the room may no longer exist.
    if (body.action === "restore") return restoreRoom(code, body);

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
      // In team mode the host can name the CPU's team (used by the per-team
      // "Add bot" buttons); otherwise drop it on whichever side is
      // short-handed, so a plain "Add CPU" never makes a lopsided match.
      let team = 0;
      if (room.teamMode) {
        if (typeof body.team === "number") {
          team = Math.max(0, Math.min(7, body.team));
        } else {
          const counts = [0, 1].map((t) => roster.filter((p) => p.team === t).length);
          team = counts[0] <= counts[1] ? 0 : 1;
        }
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
      const team = Math.max(0, Math.min(7, body.team || 0));
      // You always set your own team. The host can also reassign anyone else —
      // including CPUs, which have no client of their own — by passing that
      // player's id, so a bot can be moved onto whichever team you want.
      if (typeof body.playerId === "number" && body.playerId !== me.id) {
        if (!isController) return NextResponse.json({ error: "Only the host can move others" }, { status: 403 });
        const target = roster.find((p) => p.id === body.playerId);
        if (!target) return NextResponse.json({ error: "No such player" }, { status: 404 });
        updatePlayer(target, { team });
      } else {
        updatePlayer(me, { team });
      }
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
        turnStartedAt: Date.now(),
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
        turnStartedAt: Date.now(),
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
          const order = turnOrder(room.state.caps, room.teamMode);
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

      // Free placement. Two cases, and we trust nothing the client sends —
      // whatever position arrives is clamped into the only legal zone for it:
      //   • on the break (step 0): anywhere behind the START line.
      //   • in a team game, on a box: anywhere in/around that one box, so
      //     team-mates sharing the box can spread out and not collide.
      const from = body.from;
      const fx = from?.x;
      const fz = from?.z;
      if (typeof fx === "number" && typeof fz === "number" && Number.isFinite(fx) && Number.isFinite(fz)) {
        let placed: { x: number; z: number } | null = null;
        if (cap.step === 0) {
          placed = clampBehindStart(fx, fz);
        } else if (room.teamMode && cap.onBoard && !cap.killer && !cap.stuck && cap.step > 0) {
          // Free reposition, anchored on where the top landed (matches the
          // client): slide it around, don't snap it back to the box centre.
          placed = clampAroundBox(fx, fz, cap.x, cap.z);
        }
        if (placed) {
          const caps = room.state.caps.map((c) => (c.id === currentId ? { ...c, x: placed.x, z: placed.z } : c));
          updateRoom(room, { state: { ...room.state, caps } });
        }
      }

      const { result, seq } = applyShot(room, roster, currentId, { angle, power });
      return NextResponse.json({ ok: true, events: result.events, seq, soundEvents: result.soundEvents });
    }

    // -------- game chat --------
    if (body.action === "chat") {
      const text = (body.text ?? "").trim();
      if (!text) return NextResponse.json({ error: "Empty message" }, { status: 400 });
      addChat(room, me.name, me.color, text);
      return NextResponse.json({ ok: true, chatSeq: room.chatSeq });
    }

    // -------- host kicks a player; the game carries on --------
    if (body.action === "kick") {
      if (!isController) return NextResponse.json({ error: "Only the host can kick" }, { status: 403 });
      if (typeof body.playerId !== "number") return NextResponse.json({ error: "No player" }, { status: 400 });
      if (body.playerId === me.id) return NextResponse.json({ error: "You can't kick yourself" }, { status: 400 });
      const target = roster.find((p) => p.id === body.playerId);
      if (!target) return NextResponse.json({ error: "No such player" }, { status: 404 });
      addChat(room, "SKELLZ", "#ff5c8a", `${target.name} was removed by the host.`);
      removePlayer(room, roster, body.playerId, true);
      return NextResponse.json({ ok: true });
    }

    // -------- a player quits back to the menu --------
    if (body.action === "leave") {
      if (room.status !== "lobby") {
        addChat(room, "SKELLZ", "#6ff2ff", `${me.name} left the game.`);
        removePlayer(room, roster, me.id, false);
      } else {
        // In the lobby there's no cap yet — just drop the seat.
        removePlayer(room, roster, me.id, false);
      }
      return NextResponse.json({ ok: true });
    }

    // -------- 45s ran out on a human turn: auto-shoot to the target box --------
    if (body.action === "auto_shot") {
      if (room.status !== "playing") return NextResponse.json({ error: "Game is not running" }, { status: 400 });
      if (typeof body.seq === "number" && body.seq !== room.seq)
        return NextResponse.json({ error: "Stale turn" }, { status: 409 });
      // Enforce the clock server-side so no client can auto-fire early.
      if (Date.now() - room.turnStartedAt < AUTO_SHOOT_MS)
        return NextResponse.json({ error: "Not idle yet" }, { status: 409 });
      const currentId = currentCapId(room);
      if (!currentId) return NextResponse.json({ error: "No caps" }, { status: 400 });
      const currentPlayer = roster.find((p) => String(p.id) === currentId);
      if (currentPlayer?.isBot) return NextResponse.json({ error: "That is a CPU turn" }, { status: 400 });
      const cap = room.state.caps.find((c) => c.id === currentId);
      if (!cap?.alive || cap.stuck) return NextResponse.json({ error: "Nothing to auto-shoot" }, { status: 400 });

      // A fallible auto-shot: coin flip between going for the box and swinging
      // at an opponent, with enough scatter to miss either — it is NOT a free
      // guaranteed box.
      const shot = computeAutoShot(room.state, cap, room.level, room.teamMode);
      addChat(room, "SKELLZ", "#facc15", `${currentPlayer?.name ?? "A player"} ran out of time — auto-shot!`);
      const { result, seq } = applyShot(room, roster, currentId, { angle: shot.angle, power: shot.power });
      return NextResponse.json({ ok: true, auto: true, events: result.events, seq, soundEvents: result.soundEvents });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  });
}
