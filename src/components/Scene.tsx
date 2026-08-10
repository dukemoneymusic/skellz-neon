"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  ASPHALT,
  ASPHALT_CX,
  ASPHALT_CZ,
  ASPHALT_H,
  ASPHALT_W,
  BOARD_HALF,
  BOX,
  BOXES,
  CAP_R,
  CENTER_HALF,
  KILLA_LINE,
  LANE_LEN,
  LEVELS,
  MAX_PLAYERS,
  PANELS,
  EDGE_H,
  EDGE_T,
  START_LINE,
  VIEW_SPAN,
  panelCenter,
} from "@/game/board";
import { PLAYBACK_FPS, isArmed, targetLabel, type Cap, type SoundEvent } from "@/game/sim";
import { playHitSound, playWallSound } from "@/game/audio";

export type Playback = { ids: string[]; frames: [number, number][][]; sounds?: SoundEvent[] };

type Mode = "base" | "glow";
type Pen = { g: CanvasRenderingContext2D; u: number; X: (v: number) => number; Z: (v: number) => number };

/**
 * Deterministic jitter for the hand-drawn chalk wobble.
 *
 * Each decal is rasterised twice — once for the diffuse map and once for the
 * emissive glow map. With Math.random() the two passes wobbled differently, so
 * every chalk line rendered as a faint double image with the glow offset from
 * the line it was meant to light. Seeding per pass keeps them in register.
 */
let seed = 1;
function resetSeed(s: number) {
  seed = s >>> 0 || 1;
}
function srand() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

/** Builds a transparent chalk decal (colour + emissive) for a patch of ground. */
function makeDecal(worldW: number, worldH: number, ppu: number, draw: (p: Pen, mode: Mode) => void) {
  const w = Math.round(worldW * ppu);
  const h = Math.round(worldH * ppu);
  const make = (mode: Mode) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    const pen: Pen = {
      g,
      u: ppu,
      X: (v) => (v + worldW / 2) * ppu,
      Z: (v) => (v + worldH / 2) * ppu,
    };
    g.textAlign = "center";
    g.textBaseline = "middle";
    resetSeed(0x5ce112);
    draw(pen, mode);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { base: make("base"), glow: make("glow") };
}

function chalk(p: Pen, mode: Mode, color: string, width: number, glow: number) {
  p.g.strokeStyle = mode === "glow" ? color : "rgba(240,253,255,0.94)";
  p.g.fillStyle = mode === "glow" ? color : "rgba(240,253,255,0.94)";
  p.g.lineWidth = Math.max(2, width * p.u);
  p.g.lineCap = "round";
  p.g.lineJoin = "round";
  p.g.shadowColor = color;
  p.g.shadowBlur = (mode === "glow" ? glow : glow * 0.45) * p.u;
}

const font = (p: Pen, size: number) =>
  `700 ${Math.round(size * p.u)}px "Trebuchet MS", ui-sans-serif, system-ui`;

function roughRect(p: Pen, cx: number, cz: number, size: number) {
  const h = (size * p.u) / 2;
  const x = p.X(cx);
  const y = p.Z(cz);
  const j = () => (srand() - 0.5) * 0.05 * p.u;
  p.g.beginPath();
  p.g.moveTo(x - h + j(), y - h + j());
  p.g.lineTo(x + h + j(), y - h + j());
  p.g.lineTo(x + h + j(), y + h + j());
  p.g.lineTo(x - h + j(), y + h + j());
  p.g.closePath();
  p.g.stroke();
}

// ---------------------------------------------------------------- board chalk
const BOARD_DECAL = BOARD_HALF * 2 + 16;

function drawBoard(p: Pen, mode: Mode, levelIdx: number) {
  const { g } = p;
  const level = LEVELS[levelIdx] || LEVELS[0];
  const cyan = level.c1;
  const pink = level.c2;

  chalk(p, mode, cyan, 0.14, 0.5);
  roughRect(p, 0, 0, BOARD_HALF * 2);
  chalk(p, mode, cyan, 0.07, 0.24);
  roughRect(p, 0, 0, BOARD_HALF * 2 - 0.16);

  for (const b of BOXES) {
    if (b.n === 13) continue;
    chalk(p, mode, cyan, 0.11, 0.38);
    roughRect(p, b.x, b.z, BOX);
    if (mode === "glow") {
      g.shadowBlur = 0;
      g.fillStyle = "rgba(56,220,255,0.12)";
      g.fillRect(p.X(b.x) - (BOX * p.u) / 2, p.Z(b.z) - (BOX * p.u) / 2, BOX * p.u, BOX * p.u);
    }
    chalk(p, mode, cyan, 0.08, 0.42);
    g.font = font(p, BOX * 0.54);
    g.fillText(String(b.n), p.X(b.x), p.Z(b.z) + p.u * 0.05);
  }

  chalk(p, mode, pink, 0.13, 0.5);
  roughRect(p, 0, 0, CENTER_HALF * 2);
  const inner = BOX / 2;
  chalk(p, mode, pink, 0.085, 0.34);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as Array<[number, number]>) {
    g.beginPath();
    g.moveTo(p.X(sx * inner), p.Z(sz * inner));
    g.lineTo(p.X(sx * CENTER_HALF), p.Z(sz * CENTER_HALF));
    g.stroke();
  }
  if (mode === "glow") {
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,77,125,0.10)";
    g.fillRect(p.X(-CENTER_HALF), p.Z(-CENTER_HALF), CENTER_HALF * 2 * p.u, CENTER_HALF * 2 * p.u);
  }
  for (const panel of PANELS) {
    const [cx, cz] = panelCenter(panel.v);
    chalk(p, mode, pink, 0.075, 0.42);
    g.font = font(p, BOX * 0.5);
    g.fillText(String(panel.v), p.X(cx), p.Z(cz));
  }
  chalk(p, mode, pink, 0.115, 0.42);
  roughRect(p, 0, 0, BOX);
  chalk(p, mode, pink, 0.075, 0.44);
  g.font = font(p, BOX * 0.5);
  g.fillText("13", p.X(0), p.Z(0) + p.u * 0.05);

  g.save();
  g.translate(p.X(-BOARD_HALF + 3.4), p.Z(-BOARD_HALF - 1.9));
  g.rotate(-0.05);
  chalk(p, mode, "#ffffff", 0.06, 0.44);
  g.font = `800 ${Math.round(1.9 * p.u)}px "Trebuchet MS", ui-sans-serif, system-ui`;
  g.fillText(`SKELLZ - ${level.name.toUpperCase()}`, 0, 0);
  g.restore();
  g.shadowBlur = 0;
}

// ------------------------------------------------------------- shooting lines
const LANE_DECAL_W = 12.0;
const LANE_DECAL_H = LANE_LEN + 5.0;

function drawLane(label: string, pick: (level: (typeof LEVELS)[number]) => string) {
  return (p: Pen, mode: Mode, levelIdx: number) => {
    const level = LEVELS[levelIdx] || LEVELS[0];
    const color = pick(level);

    const { g } = p;
    chalk(p, mode, color, 0.16, 0.5);
    g.beginPath();
    g.moveTo(p.X(0), p.Z(-LANE_LEN / 2));
    g.lineTo(p.X(0), p.Z(LANE_LEN / 2));
    g.stroke();
    chalk(p, mode, color, 0.08, 0.3);
    // one notch per player slot, matching lanePosition() in board.ts
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const z = -LANE_LEN / 2 + 0.6 + (i * (LANE_LEN - 1.2)) / (MAX_PLAYERS - 1);
      g.beginPath();
      g.moveTo(p.X(-0.42), p.Z(z));
      g.lineTo(p.X(0.42), p.Z(z));
      g.stroke();
    }
    g.save();
    g.translate(p.X(-1.5), p.Z(0));
    g.rotate(-Math.PI / 2);
    chalk(p, mode, color, 0.06, 0.4);
    g.font = font(p, 1.1);
    g.fillText(label, 0, 0);
    g.restore();
    // aiming notch pointing at the board
    chalk(p, mode, color, 0.07, 0.34);
    g.beginPath();
    g.moveTo(p.X(0.9), p.Z(-0.7));
    g.lineTo(p.X(2.2), p.Z(0));
    g.lineTo(p.X(0.9), p.Z(0.7));
    g.stroke();
    g.shadowBlur = 0;
  };
}

function ChalkPatch({
  w,
  h,
  ppu,
  draw,
  position,
  rotation = 0,
  order = 1,
  levelIdx = 0,
}: {
  w: number;
  h: number;
  ppu: number;
  draw: (p: Pen, mode: Mode, levelIdx: number) => void;
  position: [number, number];
  rotation?: number;
  order?: number;
  levelIdx?: number;
}) {
  const tex = useMemo(
    () => makeDecal(w, h, ppu, (p, mode) => draw(p, mode, levelIdx || 0)),
    [w, h, ppu, draw, levelIdx],
  );
  // Each level swaps in freshly rasterised decals; without this the old pair of
  // multi-megabyte canvas textures stayed resident on the GPU for the whole
  // 20-level campaign.
  useEffect(
    () => () => {
      tex.base.dispose();
      tex.glow.dispose();
    },
    [tex],
  );
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, -rotation]}
      position={[position[0], 0.012 + order * 0.004, position[1]]}
      renderOrder={order}
    >
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial
        map={tex.base}
        emissiveMap={tex.glow}
        emissive="#ffffff"
        emissiveIntensity={1.25}
        transparent
        depthWrite={false}
        roughness={0.85}
        polygonOffset
        polygonOffsetFactor={-2}
      />
    </mesh>
  );
}

// ------------------------------------------------------------------- asphalt
function makeAsphaltTexture() {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#141a29";
  g.fillRect(0, 0, S, S);
  resetSeed(0xa5f4);
  for (let i = 0; i < 42000; i++) {
    const r = srand();
    g.fillStyle = r > 0.5 ? `rgba(255,255,255,${srand() * 0.05})` : `rgba(0,0,0,${srand() * 0.4})`;
    g.fillRect(srand() * S, srand() * S, 1 + srand() * 4, 1 + srand() * 4);
  }
  // a few cracks
  g.strokeStyle = "rgba(0,0,0,0.35)";
  for (let i = 0; i < 26; i++) {
    g.lineWidth = 1 + srand() * 2;
    g.beginPath();
    let x = srand() * S;
    let y = srand() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (srand() - 0.5) * 120;
      y += (srand() - 0.5) * 120;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ASPHALT_W / 26, ASPHALT_H / 26);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Asphalt({ levelIdx }: { levelIdx: number }) {
  // The grain itself never changes, so it is built once and re-tinted per
  // level. Each borough's `bg` colour was defined but never actually used —
  // every level rendered on identical grey asphalt.
  const tex = useMemo(() => makeAsphaltTexture(), []);
  useEffect(() => () => tex.dispose(), [tex]);
  const tint = (LEVELS[levelIdx] || LEVELS[0]).bg;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ASPHALT_CX, 0, ASPHALT_CZ]} receiveShadow>
      <planeGeometry args={[ASPHALT_W, ASPHALT_H]} />
      <meshStandardMaterial map={tex} roughness={0.95} metalness={0.04} color={tint} />
    </mesh>
  );
}

// ------------------------------------------------------------------ the edge
/** A raised concrete kerb ringing the lot, capped with a neon rail. */
function Edge() {
  const rail = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (!rail.current) return;
    const pulse = 0.55 + Math.sin(s.clock.elapsedTime * 2.1) * 0.18;
    rail.current.children.forEach((child) => {
      const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (m?.emissiveIntensity !== undefined) m.emissiveIntensity = pulse;
    });
  });

  const W = ASPHALT_W;
  const H = ASPHALT_H;
  const T = EDGE_T;
  const sides: Array<{ pos: [number, number, number]; size: [number, number, number] }> = [
    { pos: [ASPHALT_CX, EDGE_H / 2, ASPHALT.zMin - T / 2], size: [W + T * 2, EDGE_H, T] },
    { pos: [ASPHALT_CX, EDGE_H / 2, ASPHALT.zMax + T / 2], size: [W + T * 2, EDGE_H, T] },
    { pos: [ASPHALT.xMin - T / 2, EDGE_H / 2, ASPHALT_CZ], size: [T, EDGE_H, H] },
    { pos: [ASPHALT.xMax + T / 2, EDGE_H / 2, ASPHALT_CZ], size: [T, EDGE_H, H] },
  ];

  return (
    <group>
      {/* concrete kerb blocks */}
      {sides.map((s, i) => (
        <mesh key={i} position={s.pos} castShadow receiveShadow>
          <boxGeometry args={s.size} />
          <meshStandardMaterial color="#39415c" roughness={0.92} metalness={0.05} />
        </mesh>
      ))}
      {/* glowing rail along the top of the kerb */}
      <group ref={rail}>
        {sides.map((s, i) => (
          <mesh key={i} position={[s.pos[0], EDGE_H + 0.06, s.pos[2]]}>
            <boxGeometry args={[s.size[0], 0.13, s.size[2]]} />
            <meshStandardMaterial color="#38f5ff" emissive="#38f5ff" emissiveIntensity={0.6} />
          </mesh>
        ))}
      </group>
      {/* hazard stripe painted on the asphalt just inside the kerb */}
      {[
        { pos: [ASPHALT_CX, 0.01, ASPHALT.zMin + 0.7], size: [W, 1.4] as [number, number] },
        { pos: [ASPHALT_CX, 0.01, ASPHALT.zMax - 0.7], size: [W, 1.4] as [number, number] },
        { pos: [ASPHALT.xMin + 0.7, 0.01, ASPHALT_CZ], size: [1.4, H] as [number, number] },
        { pos: [ASPHALT.xMax - 0.7, 0.01, ASPHALT_CZ], size: [1.4, H] as [number, number] },
      ].map((s, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={s.pos as [number, number, number]}>
          <planeGeometry args={s.size} />
          <meshStandardMaterial
            color="#f9c23c"
            emissive="#f9c23c"
            emissiveIntensity={0.35}
            transparent
            opacity={0.32}
            depthWrite={false}
          />
        </mesh>
      ))}
      {/* dark ground beyond the kerb so the lot reads as an island of light */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ASPHALT_CX, -0.12, ASPHALT_CZ]}>
        <planeGeometry args={[W + 400, H + 400]} />
        <meshStandardMaterial color="#070a12" roughness={1} />
      </mesh>
    </group>
  );
}

// ----------------------------------------------- NYC project towers (backdrop)
// Stylised brick-and-window slab towers ringing the lot, so the game reads as a
// skelly match chalked into the middle of a housing-project courtyard. Built
// from geometry + procedural facades (NOT any real photo).

/** Stable per-window hash so the diffuse and emissive passes light the SAME
 *  windows (a sequential RNG would disagree between the two canvases). */
function winHash(a: number, b: number, c: number) {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2246822519)) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const BRICKS = ["#7d4a3b", "#8a5140", "#6f4436", "#95584a", "#5e3b30", "#814d3d"];

/** One tower facade: `cols` × `rows` windows on a brick wall. Returns a diffuse
 *  map and an emissive map (only the lit windows glow). */
function makeTowerFace(cols: number, rows: number, brick: string, seedV: number) {
  const cell = 22; // px per window cell
  const W = Math.max(1, cols) * cell;
  const H = Math.max(1, rows) * cell;
  const build = (mode: "base" | "emis") => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    if (mode === "base") {
      g.fillStyle = brick;
      g.fillRect(0, 0, W, H);
      // brick courses + grime
      g.fillStyle = "rgba(0,0,0,0.16)";
      for (let y = 0; y < H; y += 5) g.fillRect(0, y, W, 1);
      resetSeed(seedV ^ 0x9e37);
      for (let i = 0; i < (W * H) / 90; i++) {
        g.fillStyle = `rgba(0,0,0,${srand() * 0.14})`;
        g.fillRect(srand() * W, srand() * H, 2, 2);
      }
    } else {
      g.fillStyle = "#000000";
      g.fillRect(0, 0, W, H);
    }
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const lit = winHash(seedV, r, col) < 0.34;
        const warm = winHash(seedV + 1, r, col) < 0.6;
        const x = col * cell;
        const y = r * cell;
        const wx = x + cell * 0.2;
        const wy = y + cell * 0.16;
        const ww = cell * 0.6;
        const wh = cell * 0.66;
        if (mode === "base") {
          g.fillStyle = "#161d29"; // concrete window frame
          g.fillRect(x + cell * 0.12, y + cell * 0.1, cell * 0.76, cell * 0.8);
          g.fillStyle = lit ? (warm ? "#ffd489" : "#bfe6ff") : "#0e1622";
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = "rgba(0,0,0,0.5)"; // mullions
          g.fillRect(wx + ww / 2 - 0.5, wy, 1, wh);
          g.fillRect(wx, wy + wh / 2 - 0.5, ww, 1);
        } else if (lit) {
          g.fillStyle = warm ? "#ffcf6e" : "#8fd7ff";
          g.fillRect(wx, wy, ww, wh);
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { base: build("base"), emissive: build("emis") };
}

function Tower({
  x,
  z,
  w,
  d,
  h,
  brick,
  seedV,
}: {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  brick: string;
  seedV: number;
}) {
  const spacing = 3.2; // world units per window
  const cols = Math.max(2, Math.round(w / spacing));
  const colsD = Math.max(2, Math.round(d / spacing));
  const rows = Math.max(4, Math.round(h / spacing));
  const rotation = Math.atan2(-x, -z); // front (+z face) looks at the courtyard

  const { materials, dispose } = useMemo(() => {
    const faceW = makeTowerFace(cols, rows, brick, seedV);
    const faceD = makeTowerFace(colsD, rows, brick, seedV + 7);
    const wall = (f: { base: THREE.CanvasTexture; emissive: THREE.CanvasTexture }) =>
      new THREE.MeshStandardMaterial({
        map: f.base,
        emissiveMap: f.emissive,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 1.15,
        roughness: 0.92,
        metalness: 0.02,
      });
    const roof = new THREE.MeshStandardMaterial({ color: "#2b3040", roughness: 0.96 });
    const base = new THREE.MeshStandardMaterial({ color: "#141824", roughness: 1 });
    // Box face order: +x, -x, +y, -y, +z, -z. The x-faces span depth, the
    // z-faces span width.
    const mats = [wall(faceD), wall(faceD), roof, base, wall(faceW), wall(faceW)];
    return {
      materials: mats,
      dispose: () => {
        [faceW, faceD].forEach((f) => {
          f.base.dispose();
          f.emissive.dispose();
        });
        mats.forEach((m) => m.dispose());
      },
    };
  }, [cols, colsD, rows, brick, seedV]);

  useEffect(() => dispose, [dispose]);

  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* concrete pad so the tower sits cleanly on asphalt or dark ground alike */}
      <mesh position={[0, 0.15, 0]}>
        <boxGeometry args={[w + 4, 0.4, d + 4]} />
        <meshStandardMaterial color="#10131c" roughness={1} />
      </mesh>
      <mesh position={[0, h / 2, 0]} material={materials}>
        <boxGeometry args={[w, h, d]} />
      </mesh>
      {/* parapet cap + a rooftop water tank for silhouette */}
      <mesh position={[0, h + 0.4, 0]}>
        <boxGeometry args={[w + 0.7, 0.9, d + 0.7]} />
        <meshStandardMaterial color="#1e222d" roughness={0.95} />
      </mesh>
      <mesh position={[w * 0.22, h + 2.1, d * 0.1]}>
        <cylinderGeometry args={[1.7, 1.7, 3.4, 12]} />
        <meshStandardMaterial color="#3a2f28" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Projects() {
  const towers = useMemo(() => {
    const items: Array<{ x: number; z: number; w: number; d: number; h: number; brick: string; seedV: number }> = [];
    resetSeed(0xb0a12);
    const count = 15;
    for (let i = 0; i < count; i++) {
      // Leave a couple of gaps in the ring so it frames the court, not walls it.
      if (i === 4 || i === 11) continue;
      const a = (i / count) * Math.PI * 2 + 0.2;
      // Pushed well back from the 72-wide board so the towers ring the court
      // and frame it rather than looming over the play area.
      const r = 104 + srand() * 46;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const tall = srand() < 0.42;
      const h = tall ? 60 + srand() * 26 : 30 + srand() * 20;
      const w = tall ? 24 + srand() * 12 : 34 + srand() * 16;
      const d = 13 + srand() * 6;
      const brick = BRICKS[Math.floor(srand() * BRICKS.length)];
      items.push({ x, z, w, d, h, brick, seedV: 1013 + i * 17 });
    }
    return items;
  }, []);

  return (
    <group>
      {towers.map((t, i) => (
        <Tower key={i} {...t} />
      ))}
    </group>
  );
}

// ----------------------------------------------------------------- milk tops
function CapMesh({
  cap,
  hideLabel,
  refCb,
}: {
  cap: Cap;
  hideLabel: boolean;
  refCb: (g: THREE.Group | null) => void;
}) {
  const H = 0.1;
  const waxH = 0.045;
  return (
    <group ref={refCb} position={[cap.x, H / 2 + 0.005, cap.z]}>
      <mesh castShadow>
        <cylinderGeometry args={[CAP_R, CAP_R * 0.97, H, 40]} />
        <meshStandardMaterial color="#f2f5f7" metalness={0.05} roughness={0.45} />
      </mesh>
      <mesh position={[0, H / 2 - 0.006, 0]}>
        <torusGeometry args={[CAP_R * 0.99, 0.016, 8, 40]} />
        <meshStandardMaterial color="#dde5ea" metalness={0.1} roughness={0.4} />
      </mesh>
      {/* two-tone melted wax fill — half colour 1, half colour 2 */}
      <mesh position={[0, H / 2 + 0.004, 0]}>
        <cylinderGeometry args={[CAP_R * 0.78, CAP_R * 0.78, waxH, 32, 1, false, 0, Math.PI]} />
        <meshStandardMaterial
          color={cap.color}
          metalness={0.15}
          roughness={0.3}
          emissive={cap.color}
          emissiveIntensity={cap.killer ? 1.0 : 0.35}
        />
      </mesh>
      <mesh position={[0, H / 2 + 0.004, 0]}>
        <cylinderGeometry args={[CAP_R * 0.78, CAP_R * 0.78, waxH, 32, 1, false, Math.PI, Math.PI]} />
        <meshStandardMaterial
          color={cap.color2}
          metalness={0.15}
          roughness={0.3}
          emissive={cap.color2}
          emissiveIntensity={cap.killer ? 1.0 : 0.35}
        />
      </mesh>
      {/* thin seam marking the swirl split */}
      <mesh position={[0, H / 2 + waxH + 0.002, 0]}>
        <boxGeometry args={[CAP_R * 1.56, 0.006, 0.01]} />
        <meshStandardMaterial color="#0a0d16" />
      </mesh>
      {cap.stuck && (
        <mesh position={[0.6, 0.5, 0]}>
          <octahedronGeometry args={[0.24, 0]} />
          <meshStandardMaterial color="#ff4d7d" emissive="#ff4d7d" emissiveIntensity={1.4} />
        </mesh>
      )}

      {!hideLabel && (
        <>
          <mesh position={[0, 1.0, 0]}>
            <cylinderGeometry args={[0.014, 0.014, 1.7, 5]} />
            <meshBasicMaterial color={cap.color} transparent opacity={0.3} />
          </mesh>
          <Html center position={[0, 2.15, 0]} distanceFactor={68} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <div
              className="pointer-events-none -translate-y-1/2 select-none whitespace-nowrap rounded-full px-1.5 py-px text-[8px] font-bold leading-tight shadow-lg"
              style={{
                background: "rgba(6,10,20,0.6)",
                color: cap.color,
                border: `1px solid ${cap.color}`,
                opacity: 0.85,
              }}
            >
              {cap.killer ? "☠ " : isArmed(cap) ? "" : "🔒 "}
              {cap.name}
              <span className="opacity-70"> · {targetLabel(cap)}</span>
            </div>
          </Html>
        </>
      )}
    </group>
  );
}

function AimArrow({ from, angle, power }: { from: [number, number]; angle: number; power: number }) {
  // Arrow is completely fixed length and does not change size with power.
  const len = 1.6;
  const tint = power > 0.75 ? "#ff4d7d" : power > 0.45 ? "#facc15" : "#38f5ff";
  return (
    <group position={[from[0], 0.2, from[1]]} rotation={[0, -angle, 0]}>
      {/* Short, VERY THICK solid pointer */}
      <mesh position={[len / 2 + 0.45, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.22, 0.22, len, 16]} />
        <meshBasicMaterial color={tint} transparent opacity={0.65} />
      </mesh>
      {/* Larger, thicker arrowhead */}
      <mesh position={[len + 0.55, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.5, 0.7, 16]} />
        <meshBasicMaterial color={tint} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function Rig({
  target,
  spin,
  zoom,
  followRef,
  isPlaying,
}: {
  target: [number, number];
  spin: number;
  zoom: number;
  followRef: React.RefObject<{ x: number; z: number }>;
  isPlaying: boolean;
}) {
  const { camera, size } = useThree();
  const look = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const k = Math.min(1, dt * 3.4);

    const aspect = size.width / size.height;
    const span = VIEW_SPAN * zoom;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dH = span / 2 / (tan * Math.max(0.35, aspect));
    const dV = (span / 2 / tan) * 0.72;
    const dist = Math.min(1000, Math.max(dH, dV));
    const pitch = THREE.MathUtils.degToRad(aspect < 0.85 ? 62 : 52);
    const follow = THREE.MathUtils.clamp(1 - zoom, 0, 1);

    const liveX = isPlaying ? followRef.current.x : target[0];
    const liveZ = isPlaying ? followRef.current.z : target[1];
    const cx = THREE.MathUtils.lerp(ASPHALT_CX * 0.6, liveX, follow);
    const cz = THREE.MathUtils.lerp(ASPHALT_CZ * 0.6, liveZ, follow);
    const wanted = new THREE.Vector3(
      cx + Math.sin(spin) * Math.cos(pitch) * dist,
      Math.sin(pitch) * dist,
      cz + Math.cos(spin) * Math.cos(pitch) * dist,
    );
    camera.position.lerp(wanted, k);
    look.current.lerp(new THREE.Vector3(cx, 0, cz), k);
    camera.lookAt(look.current);
  });
  return null;
}

function Caps({
  caps,
  playback,
  followRef,
  labelsHidden,
  onPlaybackEnd,
}: {
  caps: Cap[];
  playback: Playback | null;
  followRef: React.RefObject<{ x: number; z: number }>;
  labelsHidden: boolean;
  onPlaybackEnd: () => void;
}) {
  const refs = useRef<Record<string, THREE.Group | null>>({});
  const idx = useRef(0);
  const done = useRef(false);
  const followIdx = useRef(0);
  const pendingSounds = useRef<SoundEvent[]>([]);

  useEffect(() => {
    idx.current = 0;
    done.current = !playback;
    if (!playback) return;
    // Copy rather than consuming the caller's array in place.
    pendingSounds.current = playback.sounds ? [...playback.sounds] : [];
    const frames = playback.frames;
    let chosen = 0;
    search: for (let f = 1; f < frames.length; f++) {
      for (let k = 0; k < playback.ids.length; k++) {
        const a = frames[f][k];
        const b = frames[0][k];
        if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) {
          chosen = k;
          break search;
        }
      }
    }
    followIdx.current = chosen;
    const start = frames[0]?.[chosen];
    if (start) followRef.current = { x: start[0], z: start[1] };
  }, [playback, followRef]);

  useFrame((_, dt) => {
    if (playback && !done.current) {
      idx.current += dt * PLAYBACK_FPS;
      const exactI = Math.min(idx.current, playback.frames.length - 1);
      const iFloor = Math.floor(exactI);
      const iCeil = Math.min(iFloor + 1, playback.frames.length - 1);
      const alpha = exactI - iFloor;

      while (pendingSounds.current.length > 0 && pendingSounds.current[0].frame <= iFloor) {
        const snd = pendingSounds.current.shift();
        if (snd?.type === "hit") playHitSound();
        if (snd?.type === "wall") playWallSound();
      }

      const frameA = playback.frames[iFloor];
      const frameB = playback.frames[iCeil];

      const STOP_EPS = 0.0009;
      const speedAt = (k: number) => {
        const p = frameB?.[k];
        const pp = frameA?.[k];
        return p && pp ? Math.hypot(p[0] - pp[0], p[1] - pp[1]) : 0;
      };
      if (speedAt(followIdx.current) <= STOP_EPS) {
        let bestK = -1;
        let bestD = STOP_EPS;
        playback.ids.forEach((_id, k) => {
          const d = speedAt(k);
          if (d > bestD) {
            bestD = d;
            bestK = k;
          }
        });
        if (bestK >= 0) followIdx.current = bestK;
      }

      const followedA = frameA?.[followIdx.current];
      const followedB = frameB?.[followIdx.current];
      if (followedA && followedB) {
        followRef.current = {
          x: followedA[0] + (followedB[0] - followedA[0]) * alpha,
          z: followedA[1] + (followedB[1] - followedA[1]) * alpha,
        };
      }

      playback.ids.forEach((id, k) => {
        const g = refs.current[id];
        const pA = frameA?.[k];
        const pB = frameB?.[k];
        if (g && pA && pB) {
          const px = pA[0] + (pB[0] - pA[0]) * alpha;
          const pz = pA[1] + (pB[1] - pA[1]) * alpha;
          const dx = px - g.position.x;
          const dz = pz - g.position.z;
          g.position.x = px;
          g.position.z = pz;
          g.rotation.y += (dx + dz) * 1.4;
          g.rotation.z = THREE.MathUtils.clamp(dx * 1.1, -0.3, 0.3);
          g.rotation.x = THREE.MathUtils.clamp(dz * 1.1, -0.3, 0.3);
          g.position.y = 0.04;
        }
      });
      if (exactI >= playback.frames.length - 1) {
        done.current = true;
        onPlaybackEnd();
      }
      return;
    }
    for (const cap of caps) {
      const g = refs.current[cap.id];
      if (!g) continue;
      g.position.x += (cap.x - g.position.x) * Math.min(1, dt * 8);
      g.position.z += (cap.z - g.position.z) * Math.min(1, dt * 8);
      g.rotation.z *= 0.9;
      g.rotation.x *= 0.9;
      g.position.y = 0.04 + (cap.stuck ? Math.sin(performance.now() / 300) * 0.02 : 0);
    }
  });

  return (
    <>
      {caps
        .filter((c) => c.alive)
        .map((cap) => (
          <CapMesh
            key={cap.id}
            cap={cap}
            hideLabel={labelsHidden}
            refCb={(g) => {
              refs.current[cap.id] = g;
            }}
          />
        ))}
    </>
  );
}

const drawStart = drawLane("S T A R T", (level) => level.c1);
const drawKilla = drawLane("K I L L A", (level) => level.c2);

export default function Scene({
  caps,
  playback,
  turnId,
  aim,
  spin,
  zoom,
  levelIdx,
  onPlaybackEnd,
}: {
  caps: Cap[];
  playback: Playback | null;
  turnId: string | null;
  aim: { from: [number, number]; angle: number; power: number } | null;
  spin: number;
  zoom: number;
  levelIdx: number;
  onPlaybackEnd: () => void;
}) {
  const focus = caps.find((c) => c.id === turnId);
  const followRef = useRef<{ x: number; z: number }>({ x: focus?.x ?? 0, z: focus?.z ?? 0 });
  return (
    <Canvas
      shadows
      // Cap the pixel ratio at 1.5: a 3x retina phone rendering this whole lot
      // at native resolution was the main source of jank, and at this camera
      // distance 1.5x is indistinguishable. A 1024 shadow map is likewise
      // plenty for a top-down board and a quarter the fill cost of 2048.
      dpr={[1, 1.5]}
      camera={{ position: [ASPHALT_CX, 230, 260], fov: 45, near: 0.4, far: 5000 }}
      gl={{ powerPreference: "high-performance", antialias: true }}
    >
      <color attach="background" args={["#04060c"]} />
      <fog attach="fog" args={["#04060c", 380, 1000]} />
      <ambientLight intensity={0.95} />
      <directionalLight position={[66, 210, 66]} intensity={1.85} castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[0, 42, 0]} intensity={16000} color="#ff4d7d" distance={220} />
      <pointLight position={[-66, 45, -66]} intensity={28000} color="#38f5ff" distance={380} />
      <pointLight position={[69, 45, 69]} intensity={21000} color="#a855f7" distance={380} />
      <pointLight position={[START_LINE.x, 33, START_LINE.z]} intensity={14000} color="#ffd45c" distance={220} />
      <pointLight position={[KILLA_LINE.x, 35, KILLA_LINE.z]} intensity={18000} color="#c084fc" distance={260} />
      <Asphalt levelIdx={levelIdx} />
      <Edge />
      <Projects />
      <ChalkPatch levelIdx={levelIdx} w={BOARD_DECAL} h={BOARD_DECAL} ppu={28} draw={drawBoard} position={[0, 0]} order={1} />
      <ChalkPatch
        levelIdx={levelIdx}
        w={LANE_DECAL_W}
        h={LANE_DECAL_H}
        ppu={56}
        draw={drawStart}
        position={[START_LINE.x, START_LINE.z]}
        rotation={START_LINE.angle - Math.PI}
        order={2}
      />
      <ChalkPatch
        levelIdx={levelIdx}
        w={LANE_DECAL_W}
        h={LANE_DECAL_H}
        ppu={56}
        draw={drawKilla}
        position={[KILLA_LINE.x, KILLA_LINE.z]}
        rotation={KILLA_LINE.angle - Math.PI}
        order={3}
      />
      <Caps
        caps={caps}
        playback={playback}
        followRef={followRef}
        labelsHidden={!!playback || !!aim}
        onPlaybackEnd={onPlaybackEnd}
      />
      {aim && !playback && <AimArrow from={aim.from} angle={aim.angle} power={aim.power} />}
      <Rig target={[focus?.x ?? 0, focus?.z ?? 0]} spin={spin} zoom={zoom} followRef={followRef} isPlaying={!!playback} />
    </Canvas>
  );
}
