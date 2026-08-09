"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Real-time voice chat over WebRTC — "always open".
 *
 * The moment the game is playing, every client quietly joins a listening mesh:
 * it drains its signalling mailbox and answers anyone who starts talking, so you
 * hear the room without pressing anything. Turning your mic on adds your audio
 * to those connections (a one-tap gesture that also grants mic permission), and
 * everyone already listening hears you immediately — no "join" step.
 *
 * Audio is peer-to-peer (a full mesh); only the tiny SDP/ICE handshake is
 * relayed through the HTTP signalling mailbox. STUN + public TURN relays cover
 * the common NATs. Negotiation follows the standard "perfect negotiation"
 * pattern so either side can (re)offer — needed because a listener becomes a
 * talker mid-call when they switch their mic on.
 */

function iceConfig(): RTCConfiguration {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(",").map((u) => u.trim()),
      username: process.env.NEXT_PUBLIC_TURN_USER,
      credential: process.env.NEXT_PUBLIC_TURN_CRED,
    });
  } else {
    // Free public fallback relays (best-effort; may be rate-limited).
    servers.push({
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    });
  }
  return { iceServers: servers };
}

const STUN = iceConfig();

/** While the mesh is up we poll our mailbox faster than the game (handshake speed). */
const SIGNAL_POLL_MS = 700;

type Signal = { from: number; kind: "offer" | "answer" | "ice" | "bye"; data: unknown; t: number };

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  polite: boolean; // glare handling: the higher id yields
  makingOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  iceRetries: number; // bounded ICE-restart attempts on failure
};

export type VoiceState = {
  /** The mesh is up — you can hear anyone who is talking. */
  listening: boolean;
  /** Your mic is live and going out to the room. */
  micOn: boolean;
  /** Acquiring the mic after a tap. */
  connecting: boolean;
  error: string | null;
  /** remote player id -> "connecting" | "live" | "failed" */
  peerStatus: Record<number, string>;
  /** remote player id -> muted locally */
  mutedPeers: Record<number, boolean>;
  toggleMic: () => void;
  togglePeerMute: (id: number) => void;
};

export function useVoiceChat(
  code: string,
  token: string | null,
  myId: number | null,
  peerIds: number[],
  enabled: boolean,
): VoiceState {
  const [listening, setListening] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState<Record<number, string>>({});
  const [mutedPeers, setMutedPeers] = useState<Record<number, boolean>>({});

  const localStream = useRef<MediaStream | null>(null);
  const micOnRef = useRef(false);
  const peers = useRef<Map<number, Peer>>(new Map());
  const mutedPeersRef = useRef<Record<number, boolean>>({});
  // Keep the latest peer id list without making the signalling effect re-run.
  const peerIdsRef = useRef<number[]>(peerIds);
  useEffect(() => {
    peerIdsRef.current = peerIds;
  }, [peerIds]);

  const setStatus = useCallback((id: number, s: string) => {
    setPeerStatus((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }));
  }, []);

  const post = useCallback(
    (to: number, kind: Signal["kind"], data: unknown) => {
      if (!token) return;
      fetch(`/api/rooms/${code}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, to, kind, data }),
      }).catch(() => undefined);
    },
    [code, token],
  );

  const closePeer = useCallback((id: number) => {
    const p = peers.current.get(id);
    if (!p) return;
    try {
      p.pc.ontrack = null;
      p.pc.onicecandidate = null;
      p.pc.onnegotiationneeded = null;
      p.pc.close();
    } catch {
      /* already gone */
    }
    p.audio.srcObject = null;
    p.audio.remove();
    peers.current.delete(id);
    setPeerStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /** Create (or fetch) the peer connection to one remote player. */
  const ensurePeer = useCallback(
    (id: number): Peer | null => {
      if (myId === null) return null;
      let peer = peers.current.get(id);
      if (peer) return peer;

      const pc = new RTCPeerConnection(STUN);
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.muted = !!mutedPeersRef.current[id];
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      document.body.appendChild(audio);

      peer = { pc, audio, polite: myId > id, makingOffer: false, pendingIce: [], remoteSet: false, iceRetries: 0 };
      peers.current.set(id, peer);
      setStatus(id, "connecting");

      // If we're already talking, put our mic on this connection right away.
      if (localStream.current) {
        for (const track of localStream.current.getTracks()) pc.addTrack(track, localStream.current);
      }

      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        void audio.play().catch(() => undefined);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) post(id, "ice", e.candidate.toJSON());
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") setStatus(id, "live");
        else if (st === "failed") {
          setStatus(id, "failed");
          // Don't stay dead: the impolite side restarts ICE (re-runs the whole
          // candidate search, now able to fall back to the TURN relays).
          if (!peer!.polite && peer!.iceRetries < 3) {
            peer!.iceRetries += 1;
            setStatus(id, "connecting");
            (async () => {
              try {
                peer!.makingOffer = true;
                await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
                post(id, "offer", pc.localDescription);
              } catch {
                /* will retry on the next failure */
              } finally {
                peer!.makingOffer = false;
              }
            })();
          }
        } else if (st === "disconnected") setStatus(id, "connecting");
      };
      // Perfect negotiation: whenever there's something to negotiate (we added a
      // mic track), make an offer. Either side may offer; glare is resolved when
      // the offer arrives. A pure listener has no track, so this never fires for
      // it — it just answers whoever starts talking.
      pc.onnegotiationneeded = async () => {
        try {
          peer!.makingOffer = true;
          await pc.setLocalDescription();
          post(id, "offer", pc.localDescription);
        } catch {
          /* renegotiation will retry */
        } finally {
          peer!.makingOffer = false;
        }
      };
      return peer;
    },
    [myId, post, setStatus],
  );

  /** Apply an incoming signal from a peer (perfect-negotiation style). */
  const handleSignal = useCallback(
    async (sig: Signal) => {
      if (myId === null || sig.from === myId) return;
      if (sig.kind === "bye") {
        closePeer(sig.from);
        return;
      }
      const peer = ensurePeer(sig.from);
      if (!peer) return;
      const pc = peer.pc;

      try {
        if (sig.kind === "offer" || sig.kind === "answer") {
          const desc = sig.data as RTCSessionDescriptionInit;
          const offerCollision = desc.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
          // The impolite side ignores a colliding offer; the polite side accepts
          // it (setRemoteDescription implicitly rolls its own offer back).
          if (offerCollision && !peer.polite) return;
          await pc.setRemoteDescription(desc);
          peer.remoteSet = true;
          for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
          if (desc.type === "offer") {
            await pc.setLocalDescription();
            post(sig.from, "answer", pc.localDescription);
          }
        } else if (sig.kind === "ice") {
          const cand = sig.data as RTCIceCandidateInit;
          if (peer.remoteSet) await pc.addIceCandidate(cand).catch(() => undefined);
          else peer.pendingIce.push(cand); // buffer until the description is set
        }
      } catch {
        /* a failed step just means this peer will retry or stay disconnected */
      }
    },
    [myId, ensurePeer, closePeer, post],
  );

  const togglePeerMute = useCallback((id: number) => {
    setMutedPeers((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      mutedPeersRef.current = next;
      const p = peers.current.get(id);
      if (p) p.audio.muted = next[id];
      return next;
    });
  }, []);

  // Turn your own mic on or off. On the first "on" we ask for the mic (the tap
  // is the required user gesture) and add it to every connection, which offers
  // your audio to everyone already listening. "Off" just silences the track —
  // you stay connected so you keep hearing the room.
  const toggleMic = useCallback(async () => {
    if (micOnRef.current) {
      micOnRef.current = false;
      setMicOn(false);
      if (localStream.current) for (const t of localStream.current.getAudioTracks()) t.enabled = false;
      return;
    }
    setError(null);
    if (!localStream.current) {
      setConnecting(true);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localStream.current = stream;
        // Reach every human in the room and put our mic on the wire. New peers
        // are created with the track (they'll offer); existing listen-only peers
        // get the track added, which triggers a fresh offer.
        for (const id of peerIdsRef.current) {
          if (id === myId) continue;
          const existing = peers.current.get(id);
          if (existing) for (const t of stream.getTracks()) existing.pc.addTrack(t, stream);
          else ensurePeer(id);
        }
      } catch {
        setError("Mic blocked — allow microphone access to talk.");
        setConnecting(false);
        return;
      }
      setConnecting(false);
    } else {
      for (const t of localStream.current.getAudioTracks()) t.enabled = true;
    }
    micOnRef.current = true;
    setMicOn(true);
  }, [myId, ensurePeer]);

  // Always-open mesh: while the game is playing, drain our signalling mailbox so
  // we answer anyone who starts talking, and keep connections tidy as players
  // come and go. No mic is taken until you tap the button.
  useEffect(() => {
    if (!enabled || !token || myId === null) return;
    // Stable for the component's life — captured so the cleanup isn't reading a
    // ref that lint thinks may have moved on.
    const peerMap = peers.current;
    let cancelled = false;
    let announced = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      // Flip "listening" on from inside the timer (not synchronously in the
      // effect body, which would trip the set-state-in-effect rule).
      if (!announced) {
        announced = true;
        setListening(true);
      }
      try {
        const res = await fetch(`/api/rooms/${code}/signal?token=${token}`, { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { signals: Signal[] };
          for (const sig of json.signals ?? []) await handleSignal(sig);
        }
      } catch {
        /* transient — next tick retries */
      }
      const ids = new Set(peerIdsRef.current.filter((id) => id !== myId));
      // Only reach out proactively when we're the one talking, so newcomers hear
      // us. Pure listeners connect lazily, when someone offers.
      if (localStream.current) {
        for (const id of ids) if (!peers.current.has(id)) ensurePeer(id);
      }
      for (const id of [...peers.current.keys()]) if (!ids.has(id)) closePeer(id);

      if (!cancelled) timer = setTimeout(tick, SIGNAL_POLL_MS);
    };
    timer = setTimeout(tick, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const id of [...peerMap.keys()]) {
        post(id, "bye", null);
        closePeer(id);
      }
      if (localStream.current) {
        for (const t of localStream.current.getTracks()) t.stop();
        localStream.current = null;
      }
      micOnRef.current = false;
      setListening(false);
      setMicOn(false);
      setPeerStatus({});
    };
  }, [enabled, token, myId, code, handleSignal, ensurePeer, closePeer, post]);

  return {
    listening,
    micOn,
    connecting,
    error,
    peerStatus,
    mutedPeers,
    toggleMic,
    togglePeerMute,
  };
}
