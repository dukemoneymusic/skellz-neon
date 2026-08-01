"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import InstallCard from "@/components/InstallCard";
import Leaderboard from "@/components/Leaderboard";
import { LEVELS, MAX_PLAYERS } from "@/game/board";
import { usePageUrl, useStoredName } from "@/game/session";

export default function Home() {
  const router = useRouter();
  const [storedName, saveName] = useStoredName();
  const [draftName, setDraftName] = useState<string | null>(null);
  const name = draftName ?? storedName;
  const [code, setCode] = useState("");
  const [teamMode, setTeamMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  // Read through an external store rather than during render — reading
  // `window` inline made the server and client emit different QR images and
  // tripped a hydration mismatch.
  const shareUrl = usePageUrl();

  const create = async (mode: "pvp" | "story", team: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || "Host", teamMode: team, mode }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed");
        return;
      }
      localStorage.setItem(`skellz:${json.code}`, json.token);
      saveName(name || "Host");
      router.push(`/play/${json.code}`);
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#05070d] text-white">
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-cyan-500/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-fuchsia-600/25 blur-3xl" />
      <div className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-cyan-300/80">Street game · reborn</p>
          <h1 className="mt-2 bg-gradient-to-r from-cyan-300 via-white to-fuchsia-400 bg-clip-text text-7xl font-black leading-none text-transparent">
            SKELLZ
          </h1>
          <p className="mt-3 text-sm text-white/60">
            The NYC milk-top street classic — 3D, on your phone, up to {MAX_PLAYERS} players online.
          </p>
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-[12px] leading-relaxed text-white/70">
            <b className="text-cyan-300">The route:</b> break from START → hit the MIDDLE → run 1 to 13 → run it
            backwards 13 to 1 → back to the MIDDLE and you&apos;re a <b className="text-fuchsia-300">KILLA ☠</b>. Land
            in any middle number (2·4·6·8) on your first break and you start your run from box 3; miss and next time any
            middle number just moves you forward to box 1. Land dead-center on 13 and you skip straight to the backward
            pass.
            <br />
            <b className="text-cyan-300">Clean landings blaze forward 3:</b> hit your own target box on your{" "}
            <b>first try</b> and you jump 3 boxes ahead automatically — but miss it once and a later hit only moves you
            the normal 1 box.
            <br />
            <b className="text-cyan-300">Tops are locked:</b> everybody has to make box 1 before they can hit another
            top — hit one early and you start all over.
            <br />
            <b className="text-rose-300">The middle bites:</b> end up cleanly inside the 2 · 4 · 6 · 8 panels instead of
            13 — not touching a line — and you&apos;re stuck. That goes for getting <b>knocked</b> in by somebody else
            just as much as flicking yourself in. Whoever knocks you back out advances that many boxes, and in co-op the
            whole team moves up with them.
            <br />
            <b className="text-fuchsia-300">Killas:</b> hitting a killa (while you aren&apos;t one) pushes you 1 box —
            it doesn&apos;t make you a killa. A killa needs 3 hits to take down a regular top.
            <br />
            <b className="text-cyan-300">Co-op:</b> pick your team in the lobby and add CPUs to either side. When one
            teammate advances, the whole team rides up to that box with them.
            <br />
            <b className="text-cyan-300">No walls send you home:</b> miss the chalk or bounce off the kerb and your top
            just stays out on the lot, still live.
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <input
            value={name}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 outline-none focus:border-cyan-400"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setTeamMode(false)}
              className={`flex-1 rounded-xl border py-2 text-sm font-bold ${!teamMode ? "border-cyan-400 bg-cyan-400/20" : "border-white/15"}`}
            >
              Free for all
            </button>
            <button
              onClick={() => setTeamMode(true)}
              className={`flex-1 rounded-xl border py-2 text-sm font-bold ${teamMode ? "border-fuchsia-400 bg-fuchsia-400/20" : "border-white/15"}`}
            >
              Co-op teams
            </button>
          </div>
          <div className="mt-4 flex gap-2">
            {/* The mode buttons used to silently reset your Free-for-all / Co-op
                choice back to Free-for-all, so Co-op teams could never start. */}
            <button
              onClick={() => create("pvp", teamMode)}
              disabled={busy}
              className="flex-1 rounded-xl bg-cyan-400 py-3 font-black text-black disabled:opacity-50"
            >
              Play PvP
            </button>
            <button
              onClick={() => create("story", teamMode)}
              disabled={busy}
              className="flex-1 rounded-xl bg-fuchsia-500 py-3 font-black text-black disabled:opacity-50"
            >
              Story Mode
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-white/40">
            Story mode runs {LEVELS.length} boroughs, from {LEVELS[0].name} to {LEVELS[LEVELS.length - 1].name}. Add CPU
            bots in the lobby.
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <label className="text-xs uppercase tracking-widest text-white/50">Join with code</label>
          <div className="mt-2 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="ABCD"
              className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-center font-mono text-xl tracking-[0.4em] outline-none focus:border-fuchsia-400"
            />
            <button
              onClick={() => {
                if (code.length === 4) router.push(`/play/${code}`);
              }}
              disabled={code.length !== 4}
              className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-cyan-400 px-5 font-black text-black disabled:opacity-50"
            >
              Play / Share
            </button>
          </div>
        </div>

        <button
          onClick={() => setShowBoard(true)}
          className="rounded-2xl border border-fuchsia-400/25 bg-fuchsia-400/5 py-3 text-sm font-black uppercase tracking-wider text-fuchsia-300"
        >
          🏆 Leaderboard
        </button>

        {/* Global persistent links */}
        <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <label className="text-xs uppercase tracking-widest text-white/50">Global Matchmaking</label>
          <p className="mt-1 mb-3 text-xs text-white/60">
            Share these permanent links to drop straight into the same lobby anytime.
          </p>
          <div className="space-y-2">
            <button
              onClick={() => router.push(`/play/PVPX`)}
              className="w-full rounded-xl border border-cyan-400/30 bg-cyan-400/10 py-3 text-sm font-bold text-cyan-300"
            >
              Public PvP Room
            </button>
            <button
              onClick={() => router.push(`/play/STRY`)}
              className="w-full rounded-xl border border-fuchsia-400/30 bg-fuchsia-400/10 py-3 text-sm font-bold text-fuchsia-300"
            >
              Public Story Room
            </button>
          </div>
        </div>

        <InstallCard shareUrl={shareUrl} />

        {error && <p className="text-center text-sm text-rose-400">{error}</p>}
        <p className="text-center text-[11px] text-white/35">
          Based on Skellz (skelly / scully / caps) — played on NYC streets since the 1950s.
        </p>
        <p className="text-center text-[11px] font-bold tracking-widest text-white/25">
          A game made by <span className="text-cyan-300/60">DUKE$</span>
        </p>
      </div>
      {showBoard && <Leaderboard onClose={() => setShowBoard(false)} highlight={name ? [name] : []} />}
    </main>
  );
}
