"use client";

/**
 * Tiny WebAudio SFX kit.
 *
 * The original exported `initAudio()` but nothing ever called it, so
 * `audioCtx` stayed null and every play* function hit its early return — the
 * game was completely silent. Now the context is created lazily on first use
 * and `unlockAudio()` is wired to the first pointer press, which is what
 * browsers require before audio is allowed to start.
 */

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
    } catch {
      return null; // audio blocked outright — the game still plays fine silently
    }
    master = audioCtx.createGain();
    master.gain.value = 0.5;
    master.connect(audioCtx.destination);
  }
  return audioCtx;
}

/** Call from a real user gesture (first tap) so the context is allowed to run. */
export function unlockAudio() {
  const ctx = ensure();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/** Kept for API compatibility with the original module. */
export const initAudio = unlockAudio;

export function setMuted(next: boolean) {
  muted = next;
  if (master) master.gain.value = next ? 0 : 0.5;
}

export function isMuted() {
  return muted;
}

type Blip = {
  type: OscillatorType;
  from: number;
  to: number;
  peak: number;
  attack: number;
  release: number;
};

function blip({ type, from, to, peak, attack, release }: Blip) {
  const ctx = ensure();
  if (!ctx || !master || muted) return;
  // A tab that lost focus suspends the context; resume so the next shot is heard.
  if (ctx.state === "suspended") void ctx.resume();

  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + release);

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.01, t + release);

  osc.connect(gain);
  gain.connect(master);

  osc.start(t);
  osc.stop(t + release + 0.05);
  // Let the graph be collected once the note has rung out.
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/** The flick itself. */
export function playShootSound() {
  blip({ type: "triangle", from: 300, to: 100, peak: 0.3, attack: 0.02, release: 0.15 });
}

/** Sharp "clack" of two milk tops meeting. */
export function playHitSound() {
  blip({ type: "square", from: 800, to: 200, peak: 0.5, attack: 0.01, release: 0.1 });
}

/** Dull thud of the kerb. */
export function playWallSound() {
  blip({ type: "sine", from: 150, to: 50, peak: 0.6, attack: 0.01, release: 0.15 });
}
