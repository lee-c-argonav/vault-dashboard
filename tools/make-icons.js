#!/usr/bin/env node
// make-icons.js — generates the vault-hud app icons. Pure Node: raw pixels ->
// zlib deflate -> hand-assembled PNG chunks. No dependencies, no canvas.
//
// The mark is one Bauhaus figure: a black disc with a single orange dot at its
// centre, and a hairline rim so the disc still reads against a dark dock or a
// dark tab strip. Nothing else is in it. This has to survive being scaled to
// 16px in a browser tab and sitting in the macOS dock, and at those sizes a
// second element turns to mush.
//
// Geometry is expressed as fractions of the tile rather than on a coarse unit
// grid, so every size is computed exactly instead of being quantised to a grid
// that only divides cleanly at some sizes.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [0x08, 0x09, 0x0a];     // page black, used for the maskable full bleed
const DISC = [0x0a, 0x0b, 0x0d];   // the disc
const RIM = [0x2a, 0x2d, 0x33];    // hairline defining the disc edge
const DOT = [0xff, 0x5d, 0x1f];    // the accent

const SS = 4; // supersamples per axis, so 16 samples per pixel

// ── raster ───────────────────────────────────────────────────────────────────

const inCircle = (dx, dy, r) => dx * dx + dy * dy <= r * r;

/** src over dst, both [r, g, b, a] with a in 0..1, straight (un-premultiplied). */
function over(dst, src) {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i) => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

/**
 * @param {number} size   edge length in pixels
 * @param {boolean} bleed maskable variant: opaque background, mark pulled into
 *                        the 80% safe zone so platform masking cannot clip it
 */
function render(size, bleed) {
  const c = size / 2;
  const discR = size * (bleed ? 0.34 : 0.482);
  const rimW = Math.max(1, size * 0.0115);
  const dotR = discR * 0.27;

  const out = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const half = step / 2;
  const samples = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + sx * step + half - c;
          const py = y + sy * step + half - c;

          let s = bleed ? [...BG, 1] : [0, 0, 0, 0];
          if (inCircle(px, py, discR)) {
            s = over(s, [...DISC, 1]);
            if (!inCircle(px, py, discR - rimW)) s = over(s, [...RIM, 1]);
          }
          if (inCircle(px, py, dotR)) s = over(s, [...DOT, 1]);

          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }

      const i = (y * size + x) * 4;
      // Un-premultiply the averaged colour, or partially covered edge pixels
      // darken toward black instead of keeping their hue.
      out[i] = a > 0 ? Math.round(r / a) : 0;
      out[i + 1] = a > 0 ? Math.round(g / a) : 0;
      out[i + 2] = a > 0 ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

// ── PNG container ────────────────────────────────────────────────────────────

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── output ───────────────────────────────────────────────────────────────────

const TARGETS = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // Apple composites on white, so no transparency
  ['favicon-32.png', 32, false],
];

for (const [name, size, bleed] of TARGETS) {
  writeFileSync(join(PUBLIC, name), png(size, render(size, bleed)));
  console.log(`${name.padEnd(24)} ${size}x${size}${bleed ? '  maskable/opaque' : ''}`);
}
