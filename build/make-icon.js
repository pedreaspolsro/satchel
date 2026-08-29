// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Generates the app icons without any dependencies:
 *   build/icon.png            256x256 - dark rounded tile, blue ">" chevron, green underscore
 *   build/icon.ico            the same as a PNG-in-ICO (Vista+), used for the exe
 *   build/icon-attention.png  the same with an orange badge, used by the tray when a session needs you
 * Run: node build/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const BG = [0x1f, 0x24, 0x30], BLUE = [0x4f, 0x9c, 0xff], GREEN = [0x59, 0xc3, 0x7a], ORANGE = [0xff, 0xb0, 0x20];

// ---- signed distance helpers ------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}
function sdSegment(px, py, ax, ay, bx, by, thickness) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(wx - t * vx, wy - t * vy) - thickness / 2;
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
const coverage = (d) => clamp(0.5 - d, 0, 1); // 1px anti-aliased edge

// ---- raster -----------------------------------------------------------------------------
function render({ badge = false } = {}) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5, py = y + 0.5;
      let color = [0, 0, 0], alpha = 0;
      const blend = (c, a) => { if (a <= 0) return; const na = alpha + a * (1 - alpha); color = color.map((v, i) => (v * alpha * (1 - a) + c[i] * a) / (na || 1)); alpha = na; };
      blend(BG, coverage(sdRoundRect(px, py, 128, 128, 116, 116, 44)));
      const chevron = Math.min(sdSegment(px, py, 76, 78, 138, 128, 30), sdSegment(px, py, 138, 128, 76, 178, 30));
      blend(BLUE, coverage(chevron));
      blend(GREEN, coverage(sdRoundRect(px, py, 178, 186, 30, 12, 8)));
      if (badge) {
        blend(BG, coverage(sdCircle(px, py, 196, 60, 50)));      // dark ring for contrast
        blend(ORANGE, coverage(sdCircle(px, py, 196, 60, 40)));
      }
      const o = (y * SIZE + x) * 4;
      rgba[o] = Math.round(color[0]); rgba[o + 1] = Math.round(color[1]); rgba[o + 2] = Math.round(color[2]); rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ---- PNG encoder ------------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) { raw[y * (SIZE * 4 + 1)] = 0; rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container (Vista+ accepts a PNG payload for the 256px image) -------------------
function encodeIco(png) {
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0; // 256x256, no palette
  ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  return Buffer.concat([ico, png]);
}

const png = encodePng(render());
const badged = encodePng(render({ badge: true }));
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), encodeIco(png));
fs.writeFileSync(path.join(__dirname, 'icon-attention.png'), badged);
console.log(`wrote build/icon.png (${png.length} bytes), build/icon.ico, build/icon-attention.png (${badged.length} bytes)`);
