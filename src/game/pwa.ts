"use client";

import { useSyncExternalStore } from "react";

/**
 * Install / standalone state for the PWA.
 *
 * The listeners are attached at module load rather than in an effect because
 * `beforeinstallprompt` fires very early — often before React has mounted, in
 * which case the browser's install offer is lost for the whole session.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "android" | "ios" | "other";

let deferredPrompt: InstallPromptEvent | null = null;
let installed = false;

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Running from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    // iOS Safari's own non-standard flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPadOS 13+ reports itself as a Mac, so check for touch as well.
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep the event so the game can offer its own install button in context.
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });
}

const serverFalse = () => false;

/** True when the browser has offered us an install prompt we can fire. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribe, () => deferredPrompt !== null && !installed, serverFalse);
}

/** True once the game is running as an installed app. */
export function useIsStandalone(): boolean {
  return useSyncExternalStore(subscribe, isStandalone, serverFalse);
}

/** Fire the native install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const prompt = deferredPrompt;
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  // A prompt may only be used once.
  deferredPrompt = null;
  emit();
  return outcome === "accepted";
}
