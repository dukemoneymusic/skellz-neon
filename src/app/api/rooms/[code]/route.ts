import { NextResponse } from "next/server";
import { canControl, getOrCreateRoom, listPlayers, updatePlayer, withRoom } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const token = new URL(req.url).searchParams.get("token") ?? "";

  return withRoom(code, () => {
    const room = getOrCreateRoom(code);
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

    const roster = listPlayers(room.id);
    const me = roster.find((p) => p.token === token) ?? null;
    if (me) updatePlayer(me, { lastSeen: Date.now() });

    return NextResponse.json({
      room: {
        code: room.code,
        status: room.status,
        teamMode: room.teamMode,
        mode: room.mode,
        level: room.level,
        storyScore: room.storyScore,
        turnIndex: room.turnIndex,
        seq: room.seq,
        winner: room.winner,
      },
      players: roster.map((p) => ({
        id: String(p.id),
        name: p.name,
        team: p.team,
        slot: p.slot,
        color: p.color,
        color2: p.color2,
        isHost: p.isHost,
        isBot: p.isBot,
      })),
      state: room.state,
      lastShot: room.lastShot,
      me: me
        ? {
            id: String(me.id),
            name: me.name,
            team: me.team,
            isHost: me.isHost,
            // In the permanent public rooms nobody owns the host token, so the
            // longest-standing player gets the host controls instead.
            canControl: canControl(room, me, roster),
            color: me.color,
            color2: me.color2,
          }
        : null,
    });
  });
}
