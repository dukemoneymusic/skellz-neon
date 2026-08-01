"use client";

import { useEffect, useState } from "react";

type Entry = {
  rank: number;
  name: string;
  wins: number;
  plays: number;
  bestScore: number;
  bestStoryShots: number | null;
};

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}`);

/**
 * The global standings. Rendered as a modal from both the home page and the
 * end-of-match screen. `highlight` bolds the current player's own row(s) so
 * they can find themselves after a game.
 */
export default function Leaderboard({
  onClose,
  highlight = [],
}: {
  onClose: () => void;
  highlight?: string[];
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const mine = new Set(highlight.map((n) => n.trim().toLowerCase()));
  const load = () => setReloadKey((k) => k + 1);

  // Fetch inline in the effect (with a cancel guard) rather than calling a
  // setState-ing helper, which the react-hooks lint rule rejects. The Refresh
  // button just bumps reloadKey to re-run this.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/leaderboard?limit=50", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { entries: Entry[] };
        if (cancelled) return;
        setEntries(json.entries);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="pad-safe absolute inset-0 z-50 grid place-items-center overflow-y-auto bg-black/80" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-3xl border border-cyan-400/25 bg-[#0a0f1c] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black text-cyan-300">🏆 Leaderboard</h3>
          <button onClick={load} className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-white/70">
            ↻ Refresh
          </button>
        </div>
        <p className="mt-1 text-[11px] text-white/45">Ranked by wins, then best match score. Names as typed.</p>

        {error ? (
          <p className="mt-6 text-center text-sm text-rose-400">Couldn&apos;t load the board — try again.</p>
        ) : entries === null ? (
          <p className="mt-6 text-center text-sm text-white/50">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="mt-6 text-center text-sm text-white/50">No games finished yet. Be the first on the board!</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
            <div className="grid grid-cols-[2rem_1fr_2.5rem_2.5rem_3rem] gap-1 border-b border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-white/40">
              <span>#</span>
              <span>Name</span>
              <span className="text-center">Win</span>
              <span className="text-center">Best</span>
              <span className="text-center">Story</span>
            </div>
            {entries.map((e) => {
              const isMine = mine.has(e.name.trim().toLowerCase());
              return (
                <div
                  key={`${e.rank}-${e.name}`}
                  className={`grid grid-cols-[2rem_1fr_2.5rem_2.5rem_3rem] items-center gap-1 px-3 py-2 text-sm ${isMine ? "bg-cyan-400/10 font-bold text-cyan-100" : "text-white/85"} ${e.rank % 2 === 0 ? "" : "bg-white/[0.02]"}`}
                >
                  <span className="text-white/60">{medal(e.rank)}</span>
                  <span className="truncate">{e.name}</span>
                  <span className="text-center font-mono">{e.wins}</span>
                  <span className="text-center font-mono text-white/70">{e.bestScore}</span>
                  <span className="text-center font-mono text-fuchsia-300/80">
                    {e.bestStoryShots === null ? "—" : e.bestStoryShots}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <button onClick={onClose} className="mt-6 w-full rounded-xl bg-cyan-400 py-2 font-bold text-black">
          Close
        </button>
      </div>
    </div>
  );
}
