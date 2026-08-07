"use client";

import { useEffect, useRef, useState } from "react";

type ChatMsg = { id: number; name: string; color: string; text: string; t: number };

/**
 * Game chat. Shows recent lines and sends new ones. Messages arrive via the
 * normal room poll (chatSeq in the payload signature), so no extra polling.
 */
export default function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  messages: ChatMsg[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // The tap that opened this panel can fire a delayed "ghost click" ~300ms
  // later that lands on the backdrop and closes it instantly. Ignore backdrop
  // taps until the panel has been up long enough for that to have passed. Set
  // in an effect (not during render, which must stay pure).
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  // Keep the newest line in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t.slice(0, 160));
    setText("");
  };

  return (
    <div
      className="pad-safe absolute inset-0 z-50 grid place-items-end bg-black/70 sm:place-items-center"
      onClick={() => {
        if (Date.now() - openedAt.current > 450) onClose();
      }}
    >
      <div
        className="flex h-[70vh] w-full max-w-md flex-col rounded-3xl border border-cyan-400/25 bg-[#0a0f1c] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black text-cyan-300">💬 Chat</h3>
          <button onClick={onClose} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
            Close
          </button>
        </div>

        <div ref={listRef} className="mt-3 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {messages.length === 0 && <p className="text-sm text-white/40">No messages yet — say hi 👋</p>}
          {messages.map((m) => (
            <div key={m.id} className="text-sm leading-snug">
              <span className="font-bold" style={{ color: m.color }}>
                {m.name}:
              </span>{" "}
              <span className="text-white/85">{m.text}</span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            maxLength={160}
            placeholder="Message…"
            className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/40 px-3 py-2.5 text-sm outline-none focus:border-cyan-400"
          />
          <button
            onClick={send}
            disabled={!text.trim()}
            className="rounded-xl bg-cyan-400 px-4 font-black text-black disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
