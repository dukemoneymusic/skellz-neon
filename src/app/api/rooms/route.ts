import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { COLORS, COLORS2 } from "@/game/colors";
import { addPlayer, createRoom, getRoom, GLOBAL_ROOMS } from "@/server/store";

export const dynamic = "force-dynamic";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let out = "";
  for (let i = 0; i < 4; i++) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return out;
}

/** A fresh code that isn't already taken and can't collide with a public room. */
function uniqueCode() {
  for (let i = 0; i < 60; i++) {
    const code = makeCode();
    if (!getRoom(code) && !GLOBAL_ROOMS[code]) return code;
  }
  return null;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; teamMode?: boolean; mode?: string };
  const name = (body.name || "Player").slice(0, 14);
  // Co-op (team mode) is disabled for now, pending a rework — force every new
  // room to free-for-all regardless of what the client sends. Flip this back to
  // `Boolean(body.teamMode)` and re-add the lobby toggle to bring co-op back.
  const teamMode = false;
  const mode = body.mode === "story" ? "story" : "pvp";
  const token = nanoid(16);

  const code = uniqueCode();
  if (!code) return NextResponse.json({ error: "Could not allocate a room code" }, { status: 503 });

  const room = createRoom({ code, hostToken: token, teamMode, mode });

  addPlayer({
    roomId: room.id,
    token,
    name,
    slot: 0,
    team: 0,
    color: COLORS[0],
    color2: COLORS2[0],
    isHost: true,
    isBot: false,
  });

  return NextResponse.json({ code: room.code, token });
}
