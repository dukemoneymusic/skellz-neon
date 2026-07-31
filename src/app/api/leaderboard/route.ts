import { NextResponse } from "next/server";
import { topLeaderboard } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(topLeaderboard(10));
}
