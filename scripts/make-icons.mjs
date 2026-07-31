/**
 * Generates every PWA icon and iOS splash screen from code — no design assets,
 * no image libraries, no native deps. Writes real PNGs by hand (zlib is the
 * only thing needed, and it ships with Node).
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = y * (w * 4 + 1);
    raw[dst] = 0;
    rgba.copy ? rgba.copy(raw, dst + 1, src, src + w * 4) : Buffer.from(rgba.buffer, src, w * 4).copy(raw, dst + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ palette
const BG = [5, 7, 13];
const CHALK = [111, 242, 255];
const CYAN = [34, 211, 238];
const PINK = [255, 59, 107];
const MILK = [242, 245, 247];
const SEAM = [10, 13, 22];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * The mark, in coordinates where the logo box spans -1..1 on both axes.
 * Returns an opaque RGB triple. Pure, so it can be supersampled freely.
 */
function markAt(x, y) {
  const r = Math.hypot(x, y);

  // Neon bloom behind the cap, so the icon still reads at 48px.
  const glowT = Math.max(0, 1 - r / 1.35) ** 2.2;
  const glowColor = x < 0 ? CYAN : PINK;
  let col = mix(BG, glowColor, glowT * 0.3);

  // Chalk square, drawn as two nested outlines like the board itself.
  const box = Math.max(Math.abs(x), Math.abs(y));
  const ring = (half, width) => Math.abs(box - half) < width / 2;
  if (ring(0.94, 0.075)) col = mix(col, CHALK, 0.95);
  else if (ring(0.8, 0.038)) col = mix(col, CHALK, 0.6);

  // The milk top.
  const CAP = 0.5;
  if (r <= CAP) {
    const wax = CAP * 0.76;
    if (r <= wax) {
      // Two-tone melted wax: cyan on the left, pink on the right.
      col = x < 0 ? [...CYAN] : [...PINK];
      // Lift the top edge slightly so the disc reads as domed, not flat.
      col = mix(col, [255, 255, 255], Math.max(0, 0.28 * (1 - (y + 1) / 1.1)));
      if (Math.abs(x) < 0.022) col = [...SEAM]; // the swirl seam
    } else {
      col = [...MILK]; // the cap's metal rim
      if (r > CAP - 0.03) col = mix(col, [140, 160, 175], 0.55);
    }
  }

  return col;
}

/**
 * Rasterise the mark into an RGBA buffer.
 * `scale` shrinks the mark inside the canvas — maskable icons need their
 * content inside the middle 80% or launchers will crop it.
 */
function render(w, h, { scale = 1, bleed = false } = {}) {
  const rgba = Buffer.alloc(w * h * 4);
  const half = Math.min(w, h) / 2;
  const boxR = half * scale;
  const cx = w / 2;
  const cy = h / 2;
  const SS = 3; // 3x3 supersampling for clean edges
  // Everything outside this radius is flat background, so only supersample
  // near the mark — that keeps the big splash screens fast.
  const active = boxR * 1.45;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      const i = (py * w + px) * 4;
      let r, g, b;

      if (Math.hypot(dx, dy) > active) {
        // Flat field with a gentle vignette; smooth, so no AA needed.
        const t = bleed ? 0 : Math.min(1, Math.hypot(dx, dy) / (Math.max(w, h) * 0.75));
        [r, g, b] = mix(BG, [2, 3, 6], t);
      } else {
        let ar = 0;
        let ag = 0;
        let ab = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const ox = dx + (sx + 0.5) / SS - 0.5;
            const oy = dy + (sy + 0.5) / SS - 0.5;
            const c = markAt(ox / boxR, oy / boxR);
            ar += c[0];
            ag += c[1];
            ab += c[2];
          }
        }
        const n = SS * SS;
        r = ar / n;
        g = ag / n;
        b = ab / n;
      }

      rgba[i] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[i + 3] = 255; // always opaque — iOS renders alpha in icons as black
    }
  }
  return rgba;
}

function emit(path, w, h, opts) {
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, encodePng(w, h, render(w, h, opts)));
  console.log(`  ${path.padEnd(42)} ${w}x${h}`);
}

console.log("icons");
emit("icons/icon-192.png", 192, 192, { scale: 0.92 });
emit("icons/icon-512.png", 512, 512, { scale: 0.92 });
// Maskable icons get cropped to a circle/squircle by Android launchers.
emit("icons/maskable-192.png", 192, 192, { scale: 0.62, bleed: true });
emit("icons/maskable-512.png", 512, 512, { scale: 0.62, bleed: true });
// iOS applies its own rounded mask and no padding of its own.
emit("icons/apple-touch-icon.png", 180, 180, { scale: 0.82, bleed: true });
emit("favicon.png", 64, 64, { scale: 0.95 });

console.log("ios splash screens");
// Portrait launch images for the iPhones people actually hold.
const SPLASH = [
  [1290, 2796], // 15/16 Pro Max
  [1179, 2556], // 15/16 Pro
  [1284, 2778], // 12/13/14 Pro Max
  [1170, 2532], // 12/13/14
  [1242, 2688], // XS Max / 11 Pro Max
  [1125, 2436], // X / XS / 11 Pro
  [828, 1792], // XR / 11
  [750, 1334], // SE / 8
];
for (const [w, h] of SPLASH) emit(`splash/${w}x${h}.png`, w, h, { scale: 0.34 });

console.log("done");
