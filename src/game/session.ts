"use client";

import { useSyncExternalStore } from "react";

/**
 * localStorage-backed session bits (your name, and your token per room).
 *
 * Read through `useSyncExternalStore` rather than "useState + read it in an
 * effect": the effect version renders once with a blank value, then
 * immediately sets state, which is both a cascading render and the reason a
 * freshly opened tab flashed an empty name field. This also keeps two tabs of
 * the same game in sync via the `storage` event.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Private browsing and blocked-storage modes throw on access. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do — the session just won't be remembered.
  }
  emit();
}

const NAME_KEY = "skellz:name";
const tokenKey = (code: string) => `skellz:${code}`;

const emptyString = () => "";
const nullToken = () => null;

/** The player's remembered display name, plus a setter that persists it. */
export function useStoredName(): [string, (name: string) => void] {
  const stored = useSyncExternalStore(subscribe, () => safeGet(NAME_KEY) ?? "", emptyString);
  return [stored, (name: string) => safeSet(NAME_KEY, name)];
}

/** This browser's seat token for one room. */
export function useRoomToken(code: string): [string | null, (token: string) => void] {
  const token = useSyncExternalStore(subscribe, () => safeGet(tokenKey(code)), nullToken);
  return [token, (next: string) => safeSet(tokenKey(code), next)];
}

/** Current page URL, safe to read during SSR (returns "" on the server). */
export function usePageUrl(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href,
    emptyString,
  );
}
