// Renders media/icon.png (256x256) from scratch: a tap ripple that is
// "writing" script lines. No image dependencies, just raw pixels + zlib.
// Regenerate with: node scripts/make-icon.js
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;

// ---- tiny signed-distance helpers ------------------------------------------

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function sdRing(px, py, cx, cy, r, thickness) {
  return Math.abs(sdCircle(px, py, cx, cy, r)) - thickness / 2;
}

// Coverage in [0,1] with ~1px anti-aliasing.
function fill(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

function blend(dst, src, alpha) {
  return src * alpha + dst * (1 - alpha);
}

// ---- compose the image ------------------------------------------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4);

const TEAL = [78, 205, 196];
const INK = [234, 237, 243];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    // Background: rounded square, vertical gradient.
    const bg = fill(sdRoundedRect(x, y, 128, 128, 120, 120, 52));
    if (bg > 0) {
      const t = y / SIZE;
      r = 35 + (18 - 35) * t;
      g = 41 + (22 - 41) * t;
      b = 70 + (41 - 70) * t;
      a = bg;

      // Script lines, top right: three rounded bars of varying width.
      const bars = [
        { y: 70, x1: 128, x2: 204 },
        { y: 102, x1: 128, x2: 180 },
        { y: 134, x1: 128, x2: 194 },
      ];
      for (const bar of bars) {
        const cx = (bar.x1 + bar.x2) / 2;
        const hw = (bar.x2 - bar.x1) / 2;
        const c = fill(sdRoundedRect(x, y, cx, bar.y, hw, 7, 7));
        if (c > 0) {
          r = blend(r, INK[0], c * 0.92);
          g = blend(g, INK[1], c * 0.92);
          b = blend(b, INK[2], c * 0.92);
        }
      }

      // Tap ripple, lower left: solid dot plus two fading rings.
      const dotX = 92;
      const dotY = 170;
      const shapes = [
        { d: sdCircle(x, y, dotX, dotY, 22), alpha: 1 },
        { d: sdRing(x, y, dotX, dotY, 44, 9), alpha: 0.65 },
        { d: sdRing(x, y, dotX, dotY, 66, 8), alpha: 0.35 },
      ];
      for (const shape of shapes) {
        const c = fill(shape.d) * shape.alpha;
        if (c > 0) {
          r = blend(r, TEAL[0], c);
          g = blend(g, TEAL[1], c);
          b = blend(b, TEAL[2], c);
        }
      }
    }

    const i = (y * SIZE + x) * 4;
    pixels[i] = Math.round(r);
    pixels[i + 1] = Math.round(g);
    pixels[i + 2] = Math.round(b);
    pixels[i + 3] = Math.round(a * 255);
  }
}

// ---- minimal PNG writer -----------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA

// Filter byte 0 in front of every scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = path.join(__dirname, "..", "media", "icon.png");
fs.writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);
