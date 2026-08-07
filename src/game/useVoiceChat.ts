"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Real-time voice chat over WebRTC.
 *
 * Audio is peer-to-peer (a full mesh — each player connects directly to each
 * other), so voice never touches the game server; only the tiny SDP/ICE
 * handshake is relayed through the HTTP signalling mailbox. STUN handles the
 * common NAT cases. There's no TURN server, so a minority of players behind
 * strict/symmetric NATs may fail to connect — that's the one honest limit of a
 * zero-infrastructure setup.
 *
 * Controls: mute your own mic, and mute any other player locally.
 */

/**
 * ICE servers.
 *
 * STUN alone only connects when at least one peer has a permissive NAT. On many
 * mobile/carrier networks (symmetric NAT) the audio can't find a direct path
 * and the call silently fails — so we also list TURN relays, which bounce the
 * audio through a server when a direct path is impossible.
 *
 * The TURN entries default to Metered's free public "OpenRelay" servers (no
 * account needed) and can be overridden at build time for a private, reliable
 * relay by setting NEXT_PUBLIC_TURN_URL / _USER / _CRED. Dead servers just get
 * skipped during ICE, so listing extras never hurts.
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

/** While voice is on we poll our mailbox faster than the game (handshake speed). */
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
  active: boolean;
  connecting: boolean;
  micMuted: boolean;
  error: string | null;
  /** remote player id -> "connecting" | "live" | "failed" */
  peerStatus: Record<number, string>;
  /** remote player id -> muted locally */
  mutedPeers: Record<number, boolean>;
  join: () => void;
  leave: () => void;
  toggleMic: () => void;
  togglePeerMute: (id: number) => void;
};

export function useVoiceChat(code: string, token: string | null, myId: number | null, peerIds: number[]): VoiceState {
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState<Record<number, string>>({});
  const [mutedPeers, setMutedPeers] = useState<Record<number, boolean>>({});

  const localStream = useRef<MediaStream | null>(null);
  const peers = useRef<Map<number, Peer>>(new Map());
  const activeRef = useRef(false);
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
      // Muted state is applied per-peer from mutedPeersRef.
      audio.muted = !!mutedPeersRef.current[id];
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      document.body.appendChild(audio);

      peer = { pc, audio, polite: myId > id, makingOffer: false, pendingIce: [], remoteSet: false, iceRetries: 0 };
      peers.current.set(id, peer);
      setStatus(id, "connecting");

      // Send our mic up the line.
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
          // Don't stay dead: the offerer restarts ICE (re-runs the whole
          // candidate search, now able to fall back to the TURN relays), which
          // rescues most transient or NAT-change failures.
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
      // The initiator (lower id) kicks off the offer.
      pc.onnegotiationneeded = async () => {
        if (peer!.polite) return; // the impolite/lower id offers
        try {
          peer!.makingOffer = true;
          await pc.setLocalDescription(await pc.createOffer());
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

  /** Apply an incoming signal from a peer. */
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
        if (sig.kind === "offer") {
          const offer = sig.data as RTCSessionDescriptionInit;
          const collision = peer.makingOffer || pc.signalingState !== "stable";
          if (collision && !peer.polite) return; // impolite side ignores a colliding offer
          await pc.setRemoteDescription(offer);
          peer.remoteSet = true;
          for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
          await pc.setLocalDescription(await pc.createAnswer());
          post(sig.from, "answer", pc.localDescription);
        } else if (sig.kind === "answer") {
          await pc.setRemoteDescription(sig.data as RTCSessionDescriptionInit);
          peer.remoteSet = true;
          for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
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

  const leave = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setConnecting(false);
    for (const id of [...peers.current.keys()]) {
      post(id, "bye", null);
      closePeer(id);
    }
    if (localStream.current) {
      for (const t of localStream.current.getTracks()) t.stop();
      localStream.current = null;
    }
    setPeerStatus({});
  }, [post, closePeer]);

  const join = useCallback(async () => {
    if (activeRef.current || myId === null || !token) return;
    setError(null);
    setConnecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      for (const t of stream.getAudioTracks()) t.enabled = !micMuted;
      activeRef.current = true;
      setActive(true);
      // Reach out to everyone already here; the lower id in each pair offers.
      for (const id of peerIdsRef.current) if (id !== myId) ensurePeer(id);
    } catch {
      setError("Mic blocked — allow microphone access to talk.");
    } finally {
      setConnecting(false);
    }
  }, [myId, token, micMuted, ensurePeer]);

  const toggleMic = useCallback(() => {
    setMicMuted((m) => {
      const next = !m;
      if (localStream.current) for (const t of localStream.current.getAudioTracks()) t.enabled = !next;
      return next;
    });
  }, []);

  const togglePeerMute = useCallback((id: number) => {
    setMutedPeers((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      mutedPeersRef.current = next;
      const p = peers.current.get(id);
      if (p) p.audio.muted = next[id];
      return next;
    });
  }, []);

  // While active: drain our signalling mailbox on a fast poll, and keep the
  // mesh in sync with the room's player list (connect to newcomers, drop
  // leavers).
  useEffect(() => {
    if (!active || !token || myId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch(`/api/rooms/${code}/signal?token=${token}`, { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { signals: Signal[] };
          for (const sig of json.signals ?? []) await handleSignal(sig);
        }
      } catch {
        /* transient — next tick retries */
      }
      // Reconcile the mesh with who's actually in the room now.
      const ids = new Set(peerIdsRef.current.filter((id) => id !== myId));
      for (const id of ids) if (!peers.current.has(id)) ensurePeer(id);
      for (const id of [...peers.current.keys()]) if (!ids.has(id)) closePeer(id);

      if (!cancelled) timer = setTimeout(tick, SIGNAL_POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, token, myId, code, handleSignal, ensurePeer, closePeer]);

  // Tidy up if the component unmounts while talking.
  useEffect(() => {
    return () => {
      if (activeRef.current) leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    active,
    connecting,
    micMuted,
    error,
    peerStatus,
    mutedPeers,
    join,
    leave,
    toggleMic,
    togglePeerMute,
  };
}
