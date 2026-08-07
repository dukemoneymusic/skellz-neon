import { NextResponse } from "next/server";
import { getRoom, listPlayers } from "@/server/store";
import { drainSignals, sendSignal, type Signal } from "@/server/signals";

export const dynamic = "force-dynamic";

/** Which player (by id) does this token belong to in this room? */
function playerIdFor(code: string, token: string): number | null {
  const room = getRoom(code);
  if (!room) return null;
  const me = listPlayers(room.id).find((p) => p.token === token);
  return me ? me.id : null;
}

// GET: drain everything waiting for me (WebRTC offers/answers/ICE from peers).
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const me = playerIdFor(code, token);
  if (me === null) return NextResponse.json({ signals: [] });
  return NextResponse.json({ signals: drainSignals(code, me) });
}

type Body = { token?: string; to?: number; kind?: Signal["kind"]; data?: unknown };

// POST: drop a signal into another player's mailbox.
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;
  const me = playerIdFor(code, body.token ?? "");
  if (me === null) return NextResponse.json({ error: "Not in this room" }, { status: 403 });

  const to = typeof body.to === "number" ? body.to : NaN;
  const kind = body.kind;
  if (!Number.isFinite(to) || !kind || !["offer", "answer", "ice", "bye"].includes(kind)) {
    return NextResponse.json({ error: "Bad signal" }, { status: 400 });
  }
  // Only relay to a real player in the same room.
  const room = getRoom(code);
  if (!room || !listPlayers(room.id).some((p) => p.id === to)) {
    return NextResponse.json({ error: "No such peer" }, { status: 404 });
  }

  sendSignal(code, to, { from: me, kind, data: body.data, t: Date.now() });
  return NextResponse.json({ ok: true });
}
