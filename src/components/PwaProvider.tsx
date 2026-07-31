"use client";

import { useEffect } from "react";

/**
 * App-wide PWA wiring: registers the service worker and keeps the screen awake
 * while the game is open. Renders nothing.
 */
export default function PwaProvider() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // The dev server rebuilds constantly; a worker sitting in front of it only
    // ever serves confusion.
    if (process.env.NODE_ENV !== "production") return;

    let cancelled = false;
    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (cancelled) return;
        // If a newer build is already waiting, let it take over now rather
        // than leaving this tab on an older bundle.
        if (reg.waiting) reg.waiting.postMessage("skip-waiting");
        reg.addEventListener("updatefound", () => {
          reg.installing?.addEventListener("statechange", function onState() {
            if (this.state === "installed" && navigator.serviceWorker.controller) {
              this.postMessage("skip-waiting");
            }
          });
        });
      } catch {
        // No service worker just means no offline shell — the game still runs.
      }
    };
    void register();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Hold a screen wake lock so a phone doesn't dim mid-match while another
   * player is taking their shot. The lock is dropped by the browser whenever
   * the tab is hidden, so it has to be re-taken on the way back.
   */
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== "visible") return;
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        // Denied (often on low battery) — nothing to do.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  return null;
}
