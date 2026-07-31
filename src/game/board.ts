// ---- Skellzs board geometry (classic chalk layout, oversized) ----
// Screen mapping: -z is "up" (top of the board), +z is "down".

export const BOARD_HALF = 36.0; // enormous 72 x 72 square — boxes sit far apart
export const BOX = 4.8; // the 12 numbered boxes
export const CAP_R = 0.6; // milk top radius
export const OUT_LIMIT = BOARD_HALF + 0.4; // outside the chalk square
export const CENTER_HALF = 9.2; // outer square of the skull

/** Most caps a single room can hold — lanes are drawn with this many slots. */
export const MAX_PLAYERS = 8;

// ---- shooting lines -------------------------------------------------------
// Both are set a long way back. START comes straight in from the west, the
// KILLA line sits much further out on a diagonal so killas attack from a
// completely different angle.
export const START_ANGLE = Math.PI; // due west
export const START_DIST = BOARD_HALF + 20;
export const KILLA_ANGLE = Math.PI * 1.25; // north-west diagonal
export const KILLA_DIST = BOARD_HALF + 46;
export const LANE_LEN = 9.6; // long enough to seat all MAX_PLAYERS without overlap

export const START_LINE = {
  x: Math.cos(START_ANGLE) * START_DIST,
  z: Math.sin(START_ANGLE) * START_DIST,
  angle: START_ANGLE,
  len: LANE_LEN,
};
export const KILLA_LINE = {
  x: Math.cos(KILLA_ANGLE) * KILLA_DIST,
  z: Math.sin(KILLA_ANGLE) * KILLA_DIST,
  angle: KILLA_ANGLE,
  len: LANE_LEN,
};

// ---- the lot --------------------------------------------------------------
// A big open asphalt apron ringed by a raised kerb. Missing the board is fine
// — your top just keeps rolling across the lot until the edge stops it.
export const ASPHALT = { xMin: -150.0, xMax: 90.0, zMin: -144.0, zMax: 90.0 };
export const ASPHALT_W = ASPHALT.xMax - ASPHALT.xMin;
export const ASPHALT_H = ASPHALT.zMax - ASPHALT.zMin;
export const ASPHALT_CX = (ASPHALT.xMin + ASPHALT.xMax) / 2;
export const ASPHALT_CZ = (ASPHALT.zMin + ASPHALT.zMax) / 2;

/** The raised kerb that rings the lot. */
export const EDGE_H = 1.6; // how tall the rail stands
export const EDGE_T = 3.0; // how thick the kerb is

/** Inner face of the kerb — tops rebound off this. */
export const RAIL = {
  xMin: ASPHALT.xMin + CAP_R,
  xMax: ASPHALT.xMax - CAP_R,
  zMin: ASPHALT.zMin + CAP_R,
  zMax: ASPHALT.zMax - CAP_R,
};

/** Is this point hard up against the kerb? */
export function atEdge(x: number, z: number): boolean {
  return x <= RAIL.xMin + 0.05 || x >= RAIL.xMax - 0.05 || z <= RAIL.zMin + 0.05 || z >= RAIL.zMax - 0.05;
}

/** Distance from a point to the nearest kerb face. */
export function edgeDistance(x: number, z: number): number {
  return Math.min(x - RAIL.xMin, RAIL.xMax - x, z - RAIL.zMin, RAIL.zMax - z);
}

export const VIEW_SPAN = ASPHALT_W + 14; // wide camera fit

export type Box = { n: number; x: number; z: number };

const E = BOARD_HALF - BOX / 2; // corner / edge lane centre
const P = BOX / 2; // paired boxes share a chalk line (12·10, 5·7, 8·6, 9·11)

export const BOXES: Box[] = [
  { n: 1, x: E, z: -E }, // top-right corner
  { n: 2, x: -E, z: E }, // bottom-left corner
  { n: 3, x: -E, z: -E }, // top-left corner
  { n: 4, x: E, z: E }, // bottom-right corner
  { n: 5, x: -E, z: -P }, // left pair, upper
  { n: 6, x: E, z: P }, // right pair, lower
  { n: 7, x: -E, z: P }, // left pair, lower
  { n: 8, x: E, z: -P }, // right pair, upper
  { n: 9, x: -P, z: E }, // bottom pair, left
  { n: 10, x: P, z: -E }, // top pair, right
  { n: 11, x: P, z: E }, // bottom pair, right
  { n: 12, x: -P, z: -E }, // top pair, left
  { n: 13, x: 0, z: 0 }, // the skull box
];

/** The four skull panels around 13, worth 2 / 4 / 6 / 8 penalty boxes. */
export const PANELS = [
  { v: 2, side: "top" as const },
  { v: 4, side: "right" as const },
  { v: 6, side: "bottom" as const },
  { v: 8, side: "left" as const },
];

export function boxByNumber(n: number): Box | undefined {
  return BOXES.find((b) => b.n === n);
}

export function insideBox(n: number, x: number, z: number): boolean {
  const b = boxByNumber(n);
  if (!b) return false;
  // Strict street rules: the cap must be fully inside the box.
  // It cannot touch the inner edge of the chalk line.
  // The box line is drawn with a width of ~0.11 units, so the inner edge is at BOX/2 - 0.06.
  // We subtract the cap radius so the outer edge of the cap doesn't cross that inner line.
  const h = BOX / 2 - 0.06 - CAP_R;
  return Math.abs(x - b.x) < h && Math.abs(z - b.z) < h;
}

export function inCenterSquare(x: number, z: number): boolean {
  return Math.abs(x) < CENTER_HALF && Math.abs(z) < CENTER_HALF;
}

/** Penalty area: inside the skull but not cleanly in box 13. */
export function inSkullZone(x: number, z: number): boolean {
  return inCenterSquare(x, z) && !insideBox(13, x, z);
}

/** Which numbered middle panel a point sits in: 2 top, 4 right, 6 bottom, 8 left. 0 = none.
 *  Uses strict boundaries: the top must be 100% inside the panel and cannot touch ANY line.
 */
export function panelValueAt(x: number, z: number): number {
  // 1. Must be strictly inside the outer skull square (cannot touch the outer line)
  const outerH = CENTER_HALF - CAP_R - 0.15;
  if (Math.abs(x) >= outerH || Math.abs(z) >= outerH) return 0;

  // 2. Must be strictly outside the inner box 13 (cannot touch the 13 line)
  const innerH = BOX / 2 + CAP_R + 0.1;
  if (Math.abs(x) <= innerH && Math.abs(z) <= innerH) return 0;

  // 3. Must not touch the diagonal lines separating the panels (|x| == |z|)
  // Distance from point (x,z) to line |x| = |z| is ||x| - |z|| / sqrt(2)
  const diagDist = Math.abs(Math.abs(x) - Math.abs(z)) / Math.SQRT2;
  if (diagDist <= CAP_R + 0.15) return 0;

  // If it passes all strict checks, determine which panel it is in:
  if (-z > Math.abs(x)) return 2;
  if (x > Math.abs(z)) return 4;
  if (z > Math.abs(x)) return 6;
  if (-x > Math.abs(z)) return 8;

  return 0;
}

/** Centre point of a panel, for drawing its number. */
export function panelCenter(v: number): [number, number] {
  const r = (BOX / 2 + CENTER_HALF) / 2;
  if (v === 2) return [0, -r];
  if (v === 4) return [r, 0];
  if (v === 6) return [0, r];
  return [-r, 0];
}

/**
 * THE ROUTE
 * START → middle (13) → 1…13 → 13 back down to 1 → middle (13) → KILLA.
 */
export const ROUTE: number[] = [
  13,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  13,
];

export const ROUTE_LEN = ROUTE.length; // reaching this index = KILLA
export const ARMED_STEP = 2; // after making box 1 you may hit other tops

/** Route index at which the backward (13 → 1) leg begins. */
export const BACK_STEP = 14;
/** Route index at which the final flick for the middle begins. */
export const FINAL_STEP = 26;

export function legOf(step: number): "in" | "up" | "back" | "kill" {
  if (step <= 0) return "in";
  if (step <= 13) return "up";
  if (step <= 25) return "back";
  return "kill";
}

/**
 * Where a cap stands on a chalk shooting line. Slots are spread evenly across
 * the lane and staggered front/back so that a full room of MAX_PLAYERS caps
 * never starts overlapping (the old 6-slot spacing wrapped slots 7 and 8 back
 * on top of slots 1 and 2).
 */
function lanePosition(line: { x: number; z: number; angle: number; len: number }, slot: number) {
  const s = ((slot % MAX_PLAYERS) + MAX_PLAYERS) % MAX_PLAYERS;
  const px = -Math.sin(line.angle);
  const pz = Math.cos(line.angle);
  const bx = Math.cos(line.angle);
  const bz = Math.sin(line.angle);
  const t = -line.len / 2 + 0.6 + (s * (line.len - 1.2)) / (MAX_PLAYERS - 1);
  const back = s % 2 === 0 ? 0.55 : -0.55;
  return { x: line.x + px * t + bx * back, z: line.z + pz * t + bz * back };
}

export function startPositionFor(slot: number) {
  return lanePosition(START_LINE, slot);
}

export function killaPositionFor(slot: number) {
  return lanePosition(KILLA_LINE, slot);
}

// ---- NYC Story Levels (20 Boroughs & Landmarks) --------------------------
export const LEVELS = [
  { id: 0, name: "Queens Yard", friction: 2.2, c1: "#6ff2ff", c2: "#ff5c8a", bg: "#8e9bb5" }, // standard
  { id: 1, name: "Brooklyn Roof", friction: 2.8, c1: "#4ade80", c2: "#a855f7", bg: "#5c5c5c" }, // high friction (tar)
  { id: 2, name: "Bronx Streets", friction: 1.6, c1: "#facc15", c2: "#ef4444", bg: "#3a3a40" }, // slick
  { id: 3, name: "Staten Ferry", friction: 2.2, c1: "#fb923c", c2: "#3b82f6", bg: "#7e888a" }, // standard
  { id: 4, name: "Manhattan Neon", friction: 1.2, c1: "#ffffff", c2: "#d946ef", bg: "#1f2937" }, // very slick (ice)
  { id: 5, name: "Coney Island", friction: 2.5, c1: "#f472b6", c2: "#fde047", bg: "#d6d3d1" },
  { id: 6, name: "Times Square", friction: 1.5, c1: "#ef4444", c2: "#3b82f6", bg: "#111827" },
  { id: 7, name: "Central Park", friction: 3.0, c1: "#22c55e", c2: "#eab308", bg: "#4ade80" },
  { id: 8, name: "Harlem Apollo", friction: 2.0, c1: "#a855f7", c2: "#f43f5e", bg: "#27272a" },
  { id: 9, name: "Wall Street", friction: 1.3, c1: "#94a3b8", c2: "#fbbf24", bg: "#0f172a" },
  { id: 10, name: "Washington Sq", friction: 2.3, c1: "#38bdf8", c2: "#c084fc", bg: "#a8a29e" },
  { id: 11, name: "Flushing Meadows", friction: 2.4, c1: "#fb7185", c2: "#818cf8", bg: "#7dd3fc" },
  { id: 12, name: "Astoria Park", friction: 2.1, c1: "#34d399", c2: "#fcd34d", bg: "#6b7280" },
  { id: 13, name: "Yankee Stadium", friction: 1.8, c1: "#ffffff", c2: "#3b82f6", bg: "#1e3a8a" },
  { id: 14, name: "Grand Central", friction: 1.4, c1: "#fcd34d", c2: "#9ca3af", bg: "#451a03" },
  { id: 15, name: "Battery Park", friction: 2.6, c1: "#6ee7b7", c2: "#38bdf8", bg: "#065f46" },
  { id: 16, name: "Chinatown", friction: 1.9, c1: "#ef4444", c2: "#facc15", bg: "#7f1d1d" },
  { id: 17, name: "DUMBO", friction: 2.7, c1: "#d946ef", c2: "#8b5cf6", bg: "#374151" },
  { id: 18, name: "Williamsburg", friction: 2.2, c1: "#f472b6", c2: "#2dd4bf", bg: "#57534e" },
  { id: 19, name: "Empire State", friction: 1.0, c1: "#38bdf8", c2: "#ffffff", bg: "#020617" }, // ultimate slick
];

/** Index of the final story level — the campaign ends after clearing it. */
export const LAST_LEVEL = LEVELS.length - 1;

/** Friction for a level index, clamped so out-of-range levels never crash. */
export function frictionFor(levelIdx: number): number {
  return LEVELS[levelIdx]?.friction ?? LEVELS[0].friction;
}
