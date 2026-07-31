"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Playback } from "@/components/Scene";
import { PLAYBACK_FPS, resolveShot, routeTarget, type Cap, type GameState } from "@/game/sim";
import { LAST_LEVEL, LEVELS, MAX_PLAYERS, boxByNumber, legOf } from "@/game/board";
import { isMuted, playShootSound, setMuted, unlockAudio } from "@/game/audio";
import { MIN_CHARGE, powerAt } from "@/game/power";
import { useRoomToken, useStoredName } from "@/game/session";

const SWATCHES = [
  "#ff3b6b",
  "#22d3ee",
  "#facc15",
  "#a855f7",
  "#4ade80",
  "#fb923c",
  "#f472b6",
  "#38bdf8",
  "#ffffff",
  "#111827",
];

function legText(cap?: Cap): string {
  if (!cap) return "";
  const t = routeTarget(cap);
  if (t === null) return "KILLA";
  const leg = legOf(cap.step);
  if (leg === "in") return "hit the MIDDLE (13)";
  if (leg === "kill") return "MIDDLE (13) → KILLA";
  const dir = leg === "back" ? "back" : "up";
  return `box ${t} (${dir})${cap.step >= 2 ? "" : " · locked"}`;
}

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });

type PlayerInfo = {
  id: string;
  name: string;
  team: number;
  slot: number;
  color: string;
  color2: string;
  isHost: boolean;
  isBot: boolean;
};
type RoomInfo = {
  code: string;
  status: string;
  teamMode: boolean;
  mode: string;
  level: number;
  storyScore: number;
  turnIndex: number;
  seq: number;
  winner: string | null;
};
type MeInfo = { id: string; name: string; team: number; isHost: boolean; canControl: boolean; color: string; color2: string };
type LastShot = { seq: number; shooterId: string; angle: number; power: number; events: string[] };
type Payload = { room: RoomInfo; players: PlayerInfo[]; state: GameState; lastShot: LastShot | null; me: MeInfo | null };

const EMPTY: GameState = { caps: [], log: [] };
const POLL_MS = 1200;
/** How long a CPU "thinks" before flicking, so its turn is readable. */
const BOT_THINK_MS = 1100;

export default function GameClient({ code }: { code: string }) {
  const [token, saveToken] = useRoomToken(code);
  const [storedName, saveName] = useStoredName();
  const [draftName, setDraftName] = useState<string | null>(null);
  const name = draftName ?? storedName;
  const [data, setData] = useState<Payload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<GameState>(EMPTY);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [toast, setToast] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showStandings, setShowStandings] = useState(false);
  const [quiet, setQuiet] = useState(false);

  const [spin, setSpin] = useState(0);
  const [zoom, setZoom] = useState(0.5);

  const [aim, setAim] = useState<{ from: [number, number]; angle: number; power: number } | null>(null);

  const prevRef = useRef<GameState | null>(null);
  const pendingRef = useRef<GameState | null>(null);
  const appliedSeq = useRef(-1);
  const botFiredSeq = useRef(-1);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; midX: number } | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${code}?token=${token ?? ""}`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      setNotFound(false);
      setData((await res.json()) as Payload);
    } catch {
      // transient network blip — the next tick will catch up
    }
  }, [code, token]);

  // Self-scheduling poll loop rather than setInterval, so a slow response can
  // never stack up overlapping requests against the room.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await poll();
      if (!cancelled) timer = setTimeout(loop, POLL_MS);
    };
    timer = setTimeout(loop, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll]);

  // Replay any shot we did not make ourselves (opponents and CPUs).
  useEffect(() => {
    if (!data) return;
    if (data.room.seq === appliedSeq.current) return;
    const shot = data.lastShot;
    const prev = prevRef.current;
    if (
      shot &&
      shot.seq === data.room.seq &&
      prev &&
      prev.caps.length === data.state.caps.length &&
      prev.caps.filter((c) => c.alive).length > 0
    ) {
      const sim = resolveShot(prev, data.room.teamMode, data.room.mode === "story", data.room.level, shot.shooterId, {
        angle: shot.angle,
        power: shot.power,
      });
      setView(prev);
      pendingRef.current = data.state;
      setPlayback({
        ids: prev.caps.filter((c) => c.alive).map((c) => c.id),
        frames: sim.frames.map((f) => f.p),
        // Opponent and CPU shots used to replay in total silence — only your
        // own flick carried sound events into the scene.
        sounds: sim.soundEvents,
      });
    } else {
      setView(data.state);
      prevRef.current = data.state;
    }
    if (shot?.events?.length) setToast(shot.events);
    appliedSeq.current = data.room.seq;
  }, [data]);

  const onPlaybackEnd = useCallback(() => {
    if (pendingRef.current) {
      setView(pendingRef.current);
      prevRef.current = pendingRef.current;
      pendingRef.current = null;
    }
    setPlayback(null);
  }, []);

  /**
   * Watchdog for the replay.
   *
   * The 3D scene signals the end of a flick from its render loop, but
   * requestAnimationFrame is paused outright while a tab is hidden — so a
   * player who switches apps mid-shot leaves the replay permanently "in
   * progress". That blocks their own controls and, if they are the one driving
   * the CPUs, freezes the match for everybody else. Timers keep running when
   * rAF does not, so this closes the shot out regardless.
   */
  useEffect(() => {
    if (!playback) return;
    const expected = (playback.frames.length / PLAYBACK_FPS) * 1000;
    const t = setTimeout(onPlaybackEnd, expected + 2500);
    return () => clearTimeout(t);
  }, [playback, onPlaybackEnd]);

  useEffect(() => {
    if (!toast.length) return;
    const t = setTimeout(() => setToast([]), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const act = useCallback(
    async (body: Record<string, unknown>, opts: { silent?: boolean } = {}) => {
      try {
        const res = await fetch(`/api/rooms/${code}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, token }),
        });
        const json = await res.json();
        if (!res.ok) {
          if (!opts.silent) {
            setError(json.error ?? "Something went wrong");
            setTimeout(() => setError(null), 2500);
          }
          return null;
        }
        return json;
      } catch {
        if (!opts.silent) {
          setError("Connection lost");
          setTimeout(() => setError(null), 2500);
        }
        return null;
      }
    },
    [code, token],
  );

  const join = async () => {
    setJoining(true);
    const res = await fetch(`/api/rooms/${code}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", name: name || "Player" }),
    });
    const json = await res.json();
    setJoining(false);
    if (!res.ok) {
      setError(json.error ?? "Could not join");
      return;
    }
    saveName(name || "Player");
    saveToken(json.token);
  };

  const caps = view.caps;
  const order = useMemo(() => caps.map((c) => c.id), [caps]);
  const turnId = data && data.room.status === "playing" ? order[data.room.turnIndex % Math.max(1, order.length)] : null;
  const myId = data?.me?.id ?? null;
  const myCap = caps.find((c) => c.id === myId);
  const busy = !!playback || sending;
  const isMyTurn = !!turnId && turnId === myId && !busy && !myCap?.stuck;

  const activePlayer = data?.players.find((p) => String(p.id) === turnId);
  const isBotTurn = !!activePlayer?.isBot;
  const roomSeq = data?.room.seq ?? -1;
  const roomStatus = data?.room.status ?? "";

  /**
   * Drive the CPU turns.
   *
   * The original ran the AI inside the host's browser on a 1500 ms timer, in an
   * effect that depended on `data.room` — a brand new object on every 1200 ms
   * poll. Each poll tore the timer down and started it again, so it never
   * reached 1500 ms and CPUs literally never took a shot. Every dependency
   * here is a primitive, so the timer survives polling; the shot itself is
   * resolved server-side and guarded by `seq`, so it fires exactly once even
   * when several players are watching the same CPU turn.
   */
  useEffect(() => {
    if (roomStatus !== "playing" || !isBotTurn || busy) return;
    if (botFiredSeq.current === roomSeq) return;
    const t = setTimeout(async () => {
      botFiredSeq.current = roomSeq;
      const res = await act({ action: "bot_shot", seq: roomSeq }, { silent: true });
      // Pull the result straight away so the flick animates now rather than on
      // the next poll tick.
      if (res) poll();
    }, BOT_THINK_MS);
    return () => clearTimeout(t);
  }, [roomStatus, isBotTurn, busy, roomSeq, act, poll]);

  const worldFromDrag = (dx: number, dy: number) => {
    // Exact mapping so screen-drag perfectly opposes aim arrow regardless of camera spin
    const worldX = -dx * Math.cos(spin) - dy * Math.sin(spin);
    const worldZ = dx * Math.sin(spin) - dy * Math.cos(spin);
    return Math.atan2(worldZ, worldX);
  };

  /** The spot this cap is chasing — used to pre-aim, and by the 🤏 tap button. */
  const targetPointFor = (cap: Cap): { x: number; z: number } | null => {
    if (cap.killer) {
      let nearest: Cap | null = null;
      let minDist = Infinity;
      for (const c of caps) {
        if (c.id === cap.id || !c.alive) continue;
        if (data?.room.teamMode && c.team === cap.team) continue;
        const d = Math.hypot(c.x - cap.x, c.z - cap.z);
        if (d < minDist) {
          minDist = d;
          nearest = c;
        }
      }
      return nearest ? { x: nearest.x, z: nearest.z } : null;
    }
    const t = routeTarget(cap);
    if (t === null) return null;
    if (t === 13) return { x: 0, z: 0 };
    const b = boxByNumber(t);
    return b ? { x: b.x, z: b.z } : null;
  };

  /**
   * Power is a swinging meter, not a pull-back.
   *
   * Hold anywhere and the bar sweeps up and down on its own; let go and the cap
   * flies at whatever it read at that instant. Drag while holding to steer.
   *
   * The value lives in a ref and the bar's height is written straight to the
   * DOM each frame. Putting it in React state would re-render this component
   * and the whole 3D scene sixty times a second while you were aiming.
   */
  const powerRef = useRef(MIN_CHARGE);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const chargeRaf = useRef<number | null>(null);

  const stopCharging = useCallback(() => {
    if (chargeRaf.current !== null) {
      cancelAnimationFrame(chargeRaf.current);
      chargeRaf.current = null;
    }
  }, []);

  const startCharging = useCallback(() => {
    if (chargeRaf.current !== null) return;
    powerRef.current = MIN_CHARGE;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = powerAt(now - t0);
      powerRef.current = p;
      if (meterRef.current) meterRef.current.style.height = `${(p * 100).toFixed(1)}%`;
      chargeRaf.current = requestAnimationFrame(tick);
    };
    chargeRaf.current = requestAnimationFrame(tick);
  }, []);

  // Never leave the loop running if the component goes away mid-aim.
  useEffect(() => stopCharging, [stopCharging]);

  /** Fire a shot and play it back locally without waiting for the next poll. */
  const shoot = async (angle: number, power: number) => {
    if (!data || !myId) return;
    setSending(true);
    unlockAudio();
    playShootSound();
    const prev = prevRef.current ?? view;
    const res = await act({ action: "shot", angle, power });
    setSending(false);
    if (!res) return;
    const sim = resolveShot(prev, data.room.teamMode, data.room.mode === "story", data.room.level, myId, {
      angle,
      power,
    });
    appliedSeq.current = res.seq;
    setView(prev);
    pendingRef.current = sim.state;
    setPlayback({
      ids: prev.caps.filter((c) => c.alive).map((c) => c.id),
      frames: sim.frames.map((f) => f.p),
      sounds: sim.soundEvents,
    });
    setToast(sim.events);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Browsers only allow audio to start from a real gesture.
    unlockAudio();
    if (showMenu) setShowMenu(false);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      pinchRef.current = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        midX: (pts[0].x + pts[1].x) / 2,
      };
      dragRef.current = null;
      stopCharging();
      setAim(null);
      return;
    }

    if (pointersRef.current.size === 1) {
      if (!isMyTurn || !myCap) return;
      dragRef.current = { x: e.clientX, y: e.clientY };
      // Start pointed at whatever you're chasing, so a straight hold-and-release
      // is already a sensible shot and dragging is only for steering.
      const tp = targetPointFor(myCap);
      const angle = tp ? Math.atan2(tp.z - myCap.z, tp.x - myCap.x) : 0;
      setAim({ from: [myCap.x, myCap.z], angle, power: 0 });
      startCharging();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      if (pinchRef.current) {
        const deltaDist = dist - pinchRef.current.dist;
        const deltaX = midX - pinchRef.current.midX;
        setZoom((z) => Math.max(0.15, Math.min(1.5, z - deltaDist * 0.003)));
        setSpin((s) => s - deltaX * 0.006);
      }
      pinchRef.current = { dist, midX };
      return;
    }

    if (pointersRef.current.size === 1) {
      if (!dragRef.current || !myCap || !isMyTurn) return;
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      // Drag only steers now — how far you drag no longer affects power.
      if (Math.hypot(dx, dy) < 6) return;
      const angle = worldFromDrag(dx, dy);
      setAim((a) => (a ? { ...a, angle } : a));
    }
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size !== 0) return;

    const a = aim;
    // Whatever the meter read at the moment you let go — that's the shot.
    const power = powerRef.current;
    stopCharging();
    dragRef.current = null;
    setAim(null);
    if (!a || !isMyTurn) return;
    await shoot(a.angle, power);
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    dragRef.current = null;
    pinchRef.current = null;
    stopCharging();
    setAim(null);
  };

  /** The micro-tap: a 1.5% flick straight at whatever you are chasing. */
  const handleNudge = async () => {
    if (!isMyTurn || !myCap || !data) return;
    const tp = targetPointFor(myCap);
    if (!tp) return;
    await shoot(Math.atan2(tp.z - myCap.z, tp.x - myCap.x), 0.015);
  };

  const standings = useMemo(
    () => [...caps].sort((a, b) => Number(b.alive) - Number(a.alive) || b.score - a.score),
    [caps],
  );

  if (notFound) {
    return (
      <div className="grid h-dvh place-items-center bg-[#05070d] px-6 text-center text-white">
        <div>
          <h1 className="text-3xl font-black text-rose-400">No room {code}</h1>
          <p className="mt-2 text-sm text-white/60">That code has expired or never existed.</p>
          <Link href="/" className="mt-5 inline-block rounded-xl bg-cyan-400 px-6 py-3 font-black text-black">
            Back to the lot
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return <div className="grid h-dvh place-items-center bg-[#05070d] text-cyan-200">Loading board…</div>;

  if (!data.me) {
    return (
      <div className="grid h-dvh place-items-center bg-[#05070d] px-6 text-white">
        <div className="w-full max-w-sm rounded-3xl border border-cyan-400/30 bg-white/5 p-6 backdrop-blur">
          <h1 className="text-2xl font-black tracking-tight text-cyan-300">Join room {code}</h1>
          <p className="mt-1 text-sm text-white/60">Skellzs · up to {MAX_PLAYERS} caps on the board</p>
          {data.room.status !== "lobby" && (
            <p className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              A match is already running — you&apos;ll watch this round and be dealt in on the next one.
            </p>
          )}
          <input
            value={name}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Your name"
            className="mt-4 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 outline-none focus:border-cyan-400"
          />
          <button
            onClick={join}
            disabled={joining}
            className="mt-3 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 py-3 font-bold text-black disabled:opacity-50"
          >
            {joining ? "Joining…" : "Enter the board"}
          </button>
          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        </div>
      </div>
    );
  }

  const inLobby = data.room.status === "lobby";
  const canControl = data.me.canControl;
  const isStory = data.room.mode === "story";
  const levelName = LEVELS[data.room.level]?.name ?? LEVELS[0].name;
  const spectating = data.room.status !== "lobby" && !myCap;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#05070d] text-white select-none">
      <div
        className="absolute inset-0 touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <Scene
          caps={caps}
          playback={playback}
          turnId={turnId}
          aim={aim}
          spin={spin}
          zoom={zoom}
          levelIdx={data.room.level || 0}
          onPlaybackEnd={onPlaybackEnd}
        />
      </div>

      <div className="inset-safe-top pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 pb-2.5">
        <div className="pointer-events-auto flex items-center gap-1.5">
          <div className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 backdrop-blur">
            <span className="font-mono text-sm font-black tracking-[0.25em] text-cyan-300">{data.room.code}</span>
          </div>
          {isStory && (
            <div className="rounded-full border border-fuchsia-400/30 bg-black/55 px-3 py-1.5 backdrop-blur">
              <span className="text-xs font-bold text-fuchsia-300">Shots: {data.room.storyScore}</span>
            </div>
          )}
          <button
            onClick={() => setShowStandings((v) => !v)}
            className={`rounded-full border px-2.5 py-1.5 text-xs backdrop-blur ${showStandings ? "border-cyan-300 bg-cyan-400/25 text-cyan-100" : "border-white/15 bg-black/55"}`}
          >
            📊
          </button>
        </div>

        <div className="pointer-events-auto relative">
          <button
            onClick={() => setShowMenu((v) => !v)}
            className={`h-9 w-9 rounded-full border text-base backdrop-blur ${showMenu ? "border-cyan-300 bg-cyan-400/25" : "border-white/15 bg-black/55"}`}
          >
            ☰
          </button>
          {showMenu && (
            <div className="absolute right-0 top-11 z-20 flex w-44 flex-col gap-1.5 rounded-2xl border border-white/10 bg-black/80 p-2 backdrop-blur">
              <button
                onClick={() => setSpin((s) => s + Math.PI / 4)}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-left text-xs"
              >
                ⟳ Rotate view
              </button>
              <button
                onClick={() => setZoom((z) => (z > 0.8 ? 0.5 : z > 0.3 ? 0.21 : 1))}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-left text-xs"
              >
                {zoom > 0.8 ? "🔍 Zoom: Board" : zoom > 0.3 ? "🔍 Zoom: Close" : "🔎 Zoom: Wide"}
              </button>
              <button
                onClick={() => {
                  const next = !isMuted();
                  setMuted(next);
                  setQuiet(next);
                }}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-left text-xs"
              >
                {quiet ? "🔇 Sound: off" : "🔊 Sound: on"}
              </button>
              <button
                onClick={() => {
                  setShowColors(true);
                  setShowMenu(false);
                }}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-left text-xs"
              >
                🎨 Top colour
              </button>
              <button
                onClick={() => {
                  setShowRules(true);
                  setShowMenu(false);
                }}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-left text-xs"
              >
                ❓ Rules
              </button>
            </div>
          )}
        </div>
      </div>

      {showStandings && (
        <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center px-2.5">
          <div className="pointer-events-auto w-full max-w-xs rounded-2xl border border-white/10 bg-black/70 p-2 text-[11px] backdrop-blur">
            {standings.map((c) => (
              <div key={c.id} className="py-[3px]">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/40"
                    style={{ background: `linear-gradient(90deg, ${c.color} 50%, ${c.color2} 50%)` }}
                  />
                  <span className={c.alive ? "" : "line-through opacity-40"}>{c.name}</span>
                  {data.room.teamMode && <span className="opacity-50">T{c.team + 1}</span>}
                  {c.stuck && <span className="text-rose-400">💀{c.stuckValue}</span>}
                  <span className="ml-auto font-mono opacity-70">{legText(c)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.room.status === "playing" && (myCap?.stuck || !isMyTurn) && (
        <div className="bottom-safe-sm pointer-events-none absolute inset-x-0 flex justify-center px-3">
          <div className="max-w-[92vw] truncate rounded-full border border-white/10 bg-black/60 px-4 py-1.5 text-xs font-bold backdrop-blur sm:text-sm">
            {myCap?.stuck ? (
              <span className="text-rose-300">💀 STUCK in the {myCap.stuckValue} — wait to be knocked out</span>
            ) : spectating ? (
              <span className="text-amber-300/80">👀 Watching — you&apos;re in on the next match</span>
            ) : (
              <span className="text-white/70">
                {caps.find((c) => c.id === turnId)?.name ?? "…"} is {isBotTurn ? "thinking" : "shooting"}
              </span>
            )}
          </div>
        </div>
      )}

      {toast.length > 0 && (
        <div className="bottom-safe-toast pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-4">
          {toast.slice(0, 2).map((e, i) => (
            <div
              key={i}
              className="max-w-[92vw] truncate rounded-full border border-cyan-400/30 bg-black/70 px-4 py-1 text-center text-xs backdrop-blur sm:text-sm"
              style={{ opacity: i === 0 ? 1 : 0.75 }}
            >
              {e}
            </div>
          ))}
        </div>
      )}

      {/* Power meter — swings on its own while you hold; release to fire. */}
      {aim && !playback && (
        <div className="pointer-events-none absolute left-6 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-2">
          <div className="flex h-48 w-3 flex-col items-center justify-end overflow-hidden rounded-full border border-white/30 bg-black/50 shadow-lg">
            <div
              ref={meterRef}
              className="w-full bg-gradient-to-t from-cyan-400 via-yellow-400 to-rose-500"
              style={{ height: `${MIN_CHARGE * 100}%` }}
            />
          </div>
          <span className="whitespace-nowrap rounded-full border border-white/15 bg-black/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-white/70 backdrop-blur">
            Release
          </span>
        </div>
      )}

      {isMyTurn && !playback && (
        <button
          onClick={handleNudge}
          disabled={sending}
          className="bottom-safe left-safe pointer-events-auto absolute z-20 flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-fuchsia-400 bg-black/80 text-fuchsia-300 shadow-[0_0_20px_rgba(232,121,249,0.35)] active:bg-fuchsia-400/30 disabled:opacity-50"
        >
          <span className="text-xl">🤏</span>
          <span className="mt-0.5 text-[9px] font-black uppercase leading-tight">Tap</span>
        </button>
      )}

      {error && (
        <div className="absolute inset-x-0 top-1/2 flex justify-center">
          <div className="rounded-full bg-rose-600 px-4 py-2 text-sm font-bold">{error}</div>
        </div>
      )}

      {inLobby && (
        <div className="pad-safe absolute inset-0 z-40 grid place-items-center overflow-y-auto bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-cyan-400/25 bg-[#0a0f1c]/90 p-6">
            <h2 className="text-2xl font-black text-cyan-300">Lobby</h2>
            {isStory ? (
              <p className="mt-1 text-sm text-fuchsia-300">
                Story Mode · {LEVELS.length} boroughs, starting in {LEVELS[0].name}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-white/60">
              Share code <span className="font-mono tracking-widest text-white">{data.room.code}</span> ·{" "}
              {data.players.length}/{MAX_PLAYERS} players
            </p>
            <div className="mt-4 space-y-2">
              {data.players.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/30"
                    style={{ background: `linear-gradient(90deg, ${p.color} 50%, ${p.color2} 50%)` }}
                  />
                  <span className="font-semibold">{p.name}</span>
                  {p.isBot && <span className="rounded bg-white/10 px-2 text-[10px] text-white/70">CPU</span>}
                  {p.isHost && <span className="rounded bg-cyan-400/20 px-2 text-[10px] text-cyan-300">HOST</span>}
                  {data.room.teamMode && <span className="ml-auto text-[10px] text-white/50">Team {p.team + 1}</span>}
                </div>
              ))}
            </div>
            {data.room.teamMode && (
              <div className="mt-4 flex flex-wrap gap-2">
                {[0, 1, 2, 3].map((t) => (
                  <button
                    key={t}
                    onClick={() => act({ action: "team", team: t })}
                    className={`min-w-[30%] flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${data.me?.team === t ? "border-cyan-400 bg-cyan-400/20" : "border-white/15"}`}
                  >
                    Team {t + 1}
                  </button>
                ))}
              </div>
            )}
            {canControl && data.players.length < MAX_PLAYERS && (
              <button
                onClick={() => act({ action: "add_bot" })}
                className="mt-4 w-full rounded-xl border border-white/20 bg-white/5 py-2 text-sm font-bold text-white/80"
              >
                🤖 Add CPU Bot
              </button>
            )}
            {canControl ? (
              <button
                onClick={() => act({ action: "start" })}
                className="mt-4 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 py-3 font-black text-black"
              >
                Start match
              </button>
            ) : (
              <p className="mt-3 text-center text-sm text-white/50">Waiting for the host…</p>
            )}
          </div>
        </div>
      )}

      {data.room.status === "finished" && (
        <div className="pad-safe absolute inset-0 z-40 grid place-items-center overflow-y-auto bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-fuchsia-400/30 bg-[#0a0f1c]/90 p-6 text-center">
            <div className="text-5xl">🏆</div>
            <h2 className="mt-2 text-3xl font-black text-fuchsia-300">
              {isStory
                ? data.room.level >= LAST_LEVEL
                  ? "Campaign Complete!"
                  : `${levelName} cleared!`
                : `${data.room.winner} wins!`}
            </h2>
            {isStory ? (
              <p className="mt-2 text-sm text-white/70">
                Level {data.room.level + 1}/{LEVELS.length} · Total shots: {data.room.storyScore}
              </p>
            ) : (
              <div className="mt-4 space-y-1 text-sm">
                {standings.map((c) => (
                  <div key={c.id} className="flex justify-between rounded-lg bg-white/5 px-3 py-1">
                    <span style={{ color: c.color }}>{c.name}</span>
                    <span className="font-mono">{c.score} pts</span>
                  </div>
                ))}
              </div>
            )}
            {canControl ? (
              <button
                onClick={() => act({ action: isStory && data.room.level < LAST_LEVEL ? "next_level" : "rematch" })}
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 py-3 font-black text-black"
              >
                {isStory && data.room.level < LAST_LEVEL
                  ? `Next borough: ${LEVELS[data.room.level + 1].name} 🚕`
                  : isStory
                    ? "Run it back"
                    : "Rematch"}
              </button>
            ) : (
              <p className="mt-4 text-sm text-white/50">Waiting for the host…</p>
            )}
          </div>
        </div>
      )}

      {showColors && data.me && (
        <div className="pad-safe absolute inset-0 z-50 grid place-items-center overflow-y-auto bg-black/80" onClick={() => setShowColors(false)}>
          <div
            className="w-full max-w-sm rounded-3xl border border-cyan-400/25 bg-[#0a0f1c] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-black text-cyan-300">Customise</h3>
            <div className="mt-4 flex items-center gap-3">
              <div
                className="h-12 w-12 shrink-0 rounded-full border-2 border-white/30 shadow-inner"
                style={{ background: `linear-gradient(90deg, ${data.me.color} 50%, ${data.me.color2} 50%)` }}
              />
            </div>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-white/50">Colour 1</p>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => act({ action: "color", color: c })}
                  className={`aspect-square rounded-xl border-2 ${data.me?.color === c ? "border-white" : "border-white/15"}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-white/50">Colour 2</p>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => act({ action: "color", color2: c })}
                  className={`aspect-square rounded-xl border-2 ${data.me?.color2 === c ? "border-white" : "border-white/15"}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <button onClick={() => setShowColors(false)} className="mt-6 w-full rounded-xl bg-cyan-400 py-2 font-bold text-black">
              Done
            </button>
          </div>
        </div>
      )}

      {showRules && (
        <div className="pad-safe absolute inset-0 z-50 grid place-items-center overflow-y-auto bg-black/80" onClick={() => setShowRules(false)}>
          <div
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-3xl border border-cyan-400/25 bg-[#0a0f1c] p-6 text-sm leading-relaxed text-white/80"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-black text-cyan-300">SKELLZ — house rules</h3>
            <p className="mt-1 text-xs text-white/50">Street game of NYC.</p>
            <p className="mt-3 text-[11px] font-bold uppercase tracking-widest text-cyan-300/70">Controls</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                <b>Hold anywhere</b> and the power meter on the left starts swinging up and down on its own.{" "}
                <b>Let go</b> at the strength you want — that&apos;s your shot.
              </li>
              <li>
                You start aimed at whatever box you&apos;re chasing, so a straight hold-and-release already goes the
                right way. <b>Drag while holding</b> to steer it somewhere else.
              </li>
              <li>
                <b>🤏 Tap</b> plays a 1.5% micro-nudge straight at your current target — for when you only need a hair.
              </li>
              <li>Pinch to zoom, and drag two fingers sideways to spin the camera.</li>
            </ul>
            <p className="mt-4 text-[11px] font-bold uppercase tracking-widest text-cyan-300/70">The route</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                Break from START into the MIDDLE (13), run <b>1 → 13</b>, run it back <b>13 → 1</b>, then the middle once
                more and you&apos;re a <b className="text-fuchsia-300">KILLA ☠</b>.
              </li>
              <li>
                A cap must be <b>fully inside the box</b> to count. Touch the chalk and it is a miss.
              </li>
              <li>
                Make a box on your <b>first try</b> at it and you blaze <b>forward 3</b>. Miss once and a later hit only
                moves you 1.
              </li>
              <li>
                Nobody may strike another top until they have made <b>box 1</b> — do it early and you start all over.
              </li>
              <li className="text-rose-300">
                End up in the 2 · 4 · 6 · 8 panels instead of 13 and you are STUCK until somebody knocks you out — and
                they collect that many boxes for doing it. That counts whether you flicked yourself in{" "}
                <b>or somebody knocked you in</b>: get struck cleanly into a panel — inside it, not touching a line — and
                you&apos;re pinned there too.
              </li>
              <li>Slam the kerb and you are picked up and sent back to your line.</li>
            </ul>
            <button onClick={() => setShowRules(false)} className="mt-5 w-full rounded-xl bg-cyan-400 py-2 font-bold text-black">
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
