"use client";

import { useState } from "react";
import { detectPlatform, promptInstall, useCanInstall, useIsStandalone } from "@/game/pwa";

/**
 * Install-to-home-screen prompt.
 *
 * Android/Chrome hands us a real install event, so we show a one-tap button.
 * iOS has no such API — Safari only installs via its own Share sheet — so
 * there we show the exact steps instead of a button that could not work.
 * Once installed, the card disappears entirely.
 */
export default function InstallCard({ shareUrl }: { shareUrl: string }) {
  const canInstall = useCanInstall();
  const standalone = useIsStandalone();
  const [busy, setBusy] = useState(false);
  const platform = detectPlatform();

  // Already running as an app — nothing to sell.
  if (standalone) return null;

  const install = async () => {
    setBusy(true);
    await promptInstall();
    setBusy(false);
  };

  return (
    <div className="rounded-3xl border border-cyan-400/20 bg-cyan-400/5 p-5 backdrop-blur">
      <span className="text-[10px] font-black uppercase tracking-wider text-cyan-300">Install SKELLZ</span>

      {canInstall ? (
        <>
          <p className="mt-1 text-xs text-white/70">
            Add it to your home screen and it runs fullscreen, with its own icon — no browser bar, no address bar.
          </p>
          <button
            onClick={install}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-cyan-400 py-3 font-black text-black disabled:opacity-50"
          >
            {busy ? "Installing…" : "📲 Install app"}
          </button>
        </>
      ) : platform === "ios" ? (
        <>
          <p className="mt-1 text-xs text-white/70">Get the fullscreen app on your iPhone — two taps:</p>
          <ol className="mt-3 space-y-2 text-xs text-white/80">
            <li className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              {/* iOS share glyph, drawn inline so it renders on every platform */}
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 text-cyan-300">
                <path
                  d="M12 3.5v10M12 3.5 8.5 7M12 3.5 15.5 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M7 10.5H5.75A1.75 1.75 0 0 0 4 12.25v6A1.75 1.75 0 0 0 5.75 20h12.5A1.75 1.75 0 0 0 20 18.25v-6a1.75 1.75 0 0 0-1.75-1.75H17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span>
                Tap <b>Share</b> in the Safari toolbar
              </span>
            </li>
            <li className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="text-base">➕</span>
              <span>
                Choose <b>Add to Home Screen</b>
              </span>
            </li>
          </ol>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-white/70">
            Open this page on your phone, then choose <b>Install app</b> (or <b>Add to Home Screen</b>) from the browser
            menu. Scan to jump straight there:
          </p>
          {shareUrl && (
            <>
              <div className="mx-auto mt-3 w-fit rounded-2xl bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&color=05070d&data=${encodeURIComponent(shareUrl)}`}
                  alt="Scan to open SKELLZ on your phone"
                  className="h-28 w-28 object-contain"
                />
              </div>
              <span className="mt-2 block text-center font-mono text-[10px] text-cyan-300/60">
                SCAN WITH YOUR PHONE CAMERA
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}
