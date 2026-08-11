"use client";

import { useEffect, useState, type RefObject } from "react";
import type { Cap } from "@/game/sim";

/**
 * PS5 / Xbox controller support.
 *
 * Both the DualSense and the Xbox pad expose the browser "standard" mapping, so
 * one set of indices covers both. The hook polls the pad every frame and drives
 * the exact same actions the touch controls do — nothing about the game logic
 * changes, it's just another way to aim, charge and fire.
 *
 * Layout (Xbox name / PlayStation name):
 *   Left stick     aim the shot (or, in Move mode, slide your top around)
 *   A / Cross      hold to charge the power meter, release to fire
 *   X / Square     Tap (the micro-nudge)
 *   Y / Triangle   toggle Move (free placement), when it's offered
 *   Right stick    orbit the camera (X) and zoom (Y)
 *   LB/RB · L1/R1  spin the view 45° left / right
 *   Menu / Options  open/close the menu
 *   View / Share    open/close standings
 *   D-pad Up        open/close chat
 *   B / Circle      close any open panel
 */

export type GamepadControls = {
  isMyTurn: boolean;
  busy: boolean;
  playback: boolean;
  origin: { x: number; z: number } | null;
  spin: number;
  canPlace: boolean;
  placing: boolean;
  placedFrom: { x: number; z: number } | null;
  placedValid: { x: number; z: number } | null;
  clampPlace: (x: number, z: number) => { x: number; z: number };
  myCap: Cap | undefined;
  targetPointFor: (cap: Cap) => { x: number; z: number } | null;
  powerRef: RefObject<number>;
  setAim: (a: { from: [number, number]; angle: number; power: number } | null) => void;
  startCharging: () => void;
  stopCharging: () => void;
  shoot: (angle: number, power: number, from?: { x: number; z: number } | null) => void;
  handleNudge: () => void;
  setSpin: (f: (s: number) => number) => void;
  setZoom: (f: (z: number) => number) => void;
  setPlacing: (f: (v: boolean) => boolean) => void;
  setPlacedFrom: (p: { x: number; z: number } | null) => void;
  togglePanel: (name: "menu" | "standings" | "chat") => void;
  closePanels: () => void;
};

const DZ = 0.22; // stick dead-zone
const dz = (v: number) => (Math.abs(v) < DZ ? 0 : v);

/** Map a stick push (screen space) into a world direction, accounting for the
 *  camera's current spin so "up" always means "away from the camera". */
function stickWorld(lx: number, ly: number, spin: number, speed: number): [number, number] {
  const up = -ly; // gamepad Y is negative upward
  const fx = -Math.sin(spin);
  const fz = -Math.cos(spin); // forward = into the screen
  const rx = Math.cos(spin);
  const rz = -Math.sin(spin); // right
  return [(lx * rx + up * fx) * speed, (lx * rz + up * fz) * speed];
}

function stickAngle(lx: number, ly: number, spin: number): number {
  const [wx, wz] = stickWorld(lx, ly, spin, 1);
  return Math.atan2(wz, wx);
}

export function useGamepad(controlsRef: RefObject<GamepadControls | null>): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let raf = 0;
    let prev: boolean[] = [];
    let charging = false;
    let aimAngle = 0;
    let lastSet = NaN; // last angle pushed to React, to avoid per-frame re-renders
    let connLocal = false; // mirror of React state, flipped only on change

    const loop = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp: Gamepad | null = null;
      for (const p of pads) {
        if (p && p.connected) {
          gp = p;
          break;
        }
      }
      // Keep the connected flag in sync with reality, only calling setState on
      // an actual change (never synchronously in the effect body).
      if (!!gp !== connLocal) {
        connLocal = !!gp;
        setConnected(connLocal);
      }
      const c = controlsRef.current;
      if (gp && c) {
        const down = (i: number) => !!gp!.buttons[i]?.pressed;
        const hit = (i: number) => down(i) && !prev[i];
        const lx = dz(gp.axes[0] ?? 0);
        const ly = dz(gp.axes[1] ?? 0);
        const rx = dz(gp.axes[2] ?? 0);
        const ry = dz(gp.axes[3] ?? 0);

        // Camera is always live (even during another player's turn / playback).
        if (rx) c.setSpin((s) => s - rx * 0.05);
        if (ry) c.setZoom((z) => Math.max(0.15, Math.min(1.5, z + ry * 0.02)));
        if (hit(4)) c.setSpin((s) => s - Math.PI / 4);
        if (hit(5)) c.setSpin((s) => s + Math.PI / 4);

        // Panels.
        if (hit(9)) c.togglePanel("menu");
        if (hit(8)) c.togglePanel("standings");
        if (hit(12)) c.togglePanel("chat");
        if (hit(1)) c.closePanels();

        if (c.isMyTurn && !c.busy && !c.playback && c.origin) {
          const mag = Math.hypot(lx, ly);
          if (c.placing && c.canPlace) {
            // Move mode: slide the top around its zone with the left stick.
            if (mag > 0) {
              const base = c.placedFrom ?? c.origin;
              const [wx, wz] = stickWorld(lx, ly, c.spin, 0.55);
              c.setPlacedFrom(c.clampPlace(base.x + wx, base.z + wz));
            }
            if (hit(3)) c.setPlacing((v) => !v);
          } else {
            // Aim with the left stick; hold A/Cross to charge, release to fire.
            if (mag > 0.28) {
              aimAngle = stickAngle(lx, ly, c.spin);
              // Only push to React when the angle actually moved, so holding the
              // stick steady doesn't re-render the whole scene every frame.
              if (Number.isNaN(lastSet) || Math.abs(aimAngle - lastSet) > 0.012) {
                c.setAim({ from: [c.origin.x, c.origin.z], angle: aimAngle, power: 0 });
                lastSet = aimAngle;
              }
            }
            if (hit(0)) {
              // A straight press with no aim yet fires at whatever you're chasing.
              if (mag <= 0.28 && c.myCap) {
                const tp = c.targetPointFor(c.myCap);
                if (tp) aimAngle = Math.atan2(tp.z - c.origin.z, tp.x - c.origin.x);
              }
              c.setAim({ from: [c.origin.x, c.origin.z], angle: aimAngle, power: 0 });
              lastSet = aimAngle;
              c.startCharging();
              charging = true;
            }
            if (charging && !down(0)) {
              charging = false;
              const power = c.powerRef.current ?? 0.5;
              c.stopCharging();
              c.shoot(aimAngle, power, c.canPlace ? c.placedValid : null);
              c.setAim(null);
              lastSet = NaN;
            }
            if (hit(2)) c.handleNudge();
            if (hit(3) && c.canPlace) c.setPlacing((v) => !v);
          }
        } else if (charging) {
          // Turn or aim went away mid-charge — bail cleanly.
          charging = false;
          c.stopCharging();
          c.setAim(null);
          lastSet = NaN;
        }

        prev = gp.buttons.map((b) => b.pressed);
      } else {
        prev = [];
        if (charging) charging = false;
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [controlsRef]);

  return { connected };
}
