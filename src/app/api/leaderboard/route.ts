import { NextResponse } from "next/server";
import { top } from "@/server/leaderboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit")) || 25;
  return NextResponse.json({ entries: top(limit) });
}
