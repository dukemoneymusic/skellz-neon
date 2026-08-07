"use client";

import type { VoiceState } from "@/game/useVoiceChat";

type Player = { id: string; name: string; color: string; color2: string; isBot: boolean };

/**
 * Voice chat controls. Join to talk, mute your own mic, and mute any other
 * player individually. Bots have nothing to say, so they're left off the list.
 */
export default function VoicePanel({
  voice,
  players,
  myId,
  onClose,
}: {
  voice: VoiceState;
  players: Player[];
  myId: string | null;
  onClose: () => void;
}) {
  const others = players.filter((p) => !p.isBot && p.id !== myId);

  return (
    <div className="pad-safe absolute inset-0 z-50 grid place-items-center bg-black/80" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-3xl border border-cyan-400/25 bg-[#0a0f1c] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black text-cyan-300">🎙️ Voice chat</h3>
          {voice.active && (
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> LIVE
            </span>
          )}
        </div>

        {!voice.active ? (
          <>
            <p className="mt-2 text-sm text-white/60">
              Talk to everyone in the room in real time. Your voice goes straight to the other players — the game
              server never hears it.
            </p>
            <button
              onClick={voice.join}
              disabled={voice.connecting}
              className="mt-5 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-emerald-400 py-3 font-black text-black disabled:opacity-50"
            >
              {voice.connecting ? "Starting…" : "🎙️ Join voice"}
            </button>
            {voice.error && <p className="mt-3 text-center text-sm text-rose-400">{voice.error}</p>}
          </>
        ) : (
          <>
            <button
              onClick={voice.toggleMic}
              className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl border py-3 font-bold ${
                voice.micMuted
                  ? "border-rose-400/50 bg-rose-500/15 text-rose-200"
                  : "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
              }`}
            >
              {voice.micMuted ? "🔇 Your mic is OFF" : "🎤 Your mic is ON"}
            </button>

            <p className="mt-5 text-[10px] font-bold uppercase tracking-widest text-white/40">In the room</p>
            <div className="mt-2 space-y-1.5">
              {others.length === 0 && <p className="text-sm text-white/50">Nobody else here yet.</p>}
              {others.map((p) => {
                const status = voice.peerStatus[Number(p.id)] ?? "connecting";
                const muted = !!voice.mutedPeers[Number(p.id)];
                return (
                  <div key={p.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/30"
                      style={{ background: `linear-gradient(90deg, ${p.color} 50%, ${p.color2} 50%)` }}
                    />
                    <span className="truncate font-semibold">{p.name}</span>
                    <span
                      className={`ml-1 text-[10px] font-bold ${
                        status === "live"
                          ? "text-emerald-400"
                          : status === "failed"
                            ? "text-rose-400"
                            : "text-amber-300/80"
                      }`}
                    >
                      {status === "live" ? "● live" : status === "failed" ? "● can't reach" : "● connecting"}
                    </span>
                    <button
                      onClick={() => voice.togglePeerMute(Number(p.id))}
                      className={`ml-auto rounded-lg border px-2.5 py-1 text-xs font-bold ${
                        muted
                          ? "border-rose-400/50 bg-rose-500/15 text-rose-200"
                          : "border-white/15 bg-white/5 text-white/70"
                      }`}
                    >
                      {muted ? "🔇 Muted" : "🔊 Mute"}
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              onClick={voice.leave}
              className="mt-5 w-full rounded-xl border border-rose-400/40 bg-rose-500/10 py-2.5 text-sm font-bold text-rose-200"
            >
              Leave voice
            </button>
          </>
        )}

        <button onClick={onClose} className="mt-3 w-full rounded-xl bg-white/10 py-2 text-sm font-bold text-white/80">
          Close
        </button>
      </div>
    </div>
  );
}
