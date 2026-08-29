// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusFromTitle, cleanTitle, gridLayout, cascadeLayout } = require('../src/main/util');

const glyphs = { idle: ['✳'], working: ['◐', '◓', '◑', '◒'] };

test('statusFromTitle recognises Claude Code title glyphs', () => {
  assert.equal(statusFromTitle('✳ Defect analysis review', glyphs), 'idle');
  assert.equal(statusFromTitle('◑ Shell window manager utility', glyphs), 'working');
  assert.equal(statusFromTitle('◐ x', glyphs), 'working');
  assert.equal(statusFromTitle('✶ unlisted spinner frame', glyphs), 'working');
  assert.equal(statusFromTitle('MINGW64:/p/Projects', glyphs), 'unknown');
  assert.equal(statusFromTitle('~ - bash', glyphs), 'unknown');
  assert.equal(statusFromTitle('', glyphs), 'unknown');
  assert.equal(statusFromTitle('Ärger', glyphs), 'unknown');
});

test('cleanTitle strips the status glyph only', () => {
  assert.equal(cleanTitle('✳ Defect analysis review', glyphs), 'Defect analysis review');
  assert.equal(cleanTitle('◑ Shell window manager utility', glyphs), 'Shell window manager utility');
  assert.equal(cleanTitle('MINGW64:/p/Projects', glyphs), 'MINGW64:/p/Projects');
});

test('gridLayout covers the area without overlap', () => {
  const area = { x: 100, y: 50, width: 1000, height: 600 };
  const rects = gridLayout(5, area);
  assert.equal(rects.length, 5);
  for (const r of rects) {
    assert.ok(r.x >= area.x && r.x + r.width <= area.x + area.width);
    assert.ok(r.y >= area.y && r.y + r.height <= area.y + area.height);
  }
  assert.deepEqual(gridLayout(1, area)[0], { x: 100, y: 50, width: 1000, height: 600 });
  assert.deepEqual(gridLayout(0, area), []);
  const two = gridLayout(2, area);
  assert.equal(two[0].width + two[1].width, 1000);
});

test('cascadeLayout offsets each window', () => {
  const rects = cascadeLayout(3, { x: 0, y: 0, width: 1000, height: 600 });
  assert.equal(rects[1].x - rects[0].x, 36);
  assert.equal(rects[2].y - rects[1].y, 36);
});
