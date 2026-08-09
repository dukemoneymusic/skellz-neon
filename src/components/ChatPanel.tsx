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
      // Fully see-through backdrop so the whole game stays visible behind chat.
      className="pad-safe absolute inset-0 z-50 grid place-items-end bg-transparent sm:place-items-center"
      onClick={() => {
        if (Date.now() - openedAt.current > 450) onClose();
      }}
    >
      <div
        // Small, completely transparent panel — no fill, no blur — so you can
        // still watch the game right through it. Text carries its own shadow so
        // it stays readable over anything on the board.
        className="flex h-[38vh] w-full max-w-sm flex-col rounded-2xl border border-cyan-400/20 bg-transparent p-3 [text-shadow:0_1px_4px_rgba(0,0,0,0.95)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-black text-cyan-300">💬 Chat</h3>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/20 bg-black/30 px-3 py-1 text-xs text-white/80"
          >
            Close
          </button>
        </div>

        <div ref={listRef} className="mt-2 flex-1 space-y-1 overflow-y-auto pr-1">
          {messages.length === 0 && <p className="text-sm text-white/70">No messages yet — say hi 👋</p>}
          {messages.map((m) => (
            <div key={m.id} className="text-sm leading-snug">
              <span className="font-black" style={{ color: m.color }}>
                {m.name}:
              </span>{" "}
              <span className="font-semibold text-white">{m.text}</span>
            </div>
          ))}
        </div>

        <div className="mt-2 flex gap-2 [text-shadow:none]">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            maxLength={160}
            placeholder="Message…"
            className="min-w-0 flex-1 rounded-xl border border-white/20 bg-black/50 px-3 py-2 text-sm outline-none focus:border-cyan-400"
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
