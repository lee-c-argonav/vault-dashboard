// context-meter.test.js — the context-window fill derivation behind the row meter.
//
// This repository is public, so fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextOf } from '../public/runs-view.js';
import { attachContext, resetContextHistory } from '../parse.js';

const M = 1_000_000;
const ctx = (used, series = []) => ({ used, max: M, series });

test('no reading, no meter', () => {
  assert.equal(contextOf(null), null);
  assert.equal(contextOf(undefined), null);
  assert.equal(contextOf({}), null);
  assert.equal(contextOf({ used: NaN, max: M }), null);
  assert.equal(contextOf({ used: 10, max: 0 }), null);
  assert.equal(contextOf({ used: 10, max: -5 }), null);
});

test('the percentage is the fill of the window, and 80% is the warning line', () => {
  assert.equal(contextOf(ctx(500_000)).pct, 50);
  assert.equal(contextOf(ctx(950_000)).pct, 95);
  // The flag follows the DISPLAYED figure, so the two can never disagree:
  // 79.49% renders 79 and stays quiet, 79.5% renders 80 and warns.
  assert.equal(contextOf(ctx(794_999)).hot, false);
  assert.equal(contextOf(ctx(795_000)).hot, true);
});

test('a reading past the believed window reports over 100, not a clamp', () => {
  // The window is an assumption (parse.js); a session past it means the
  // assumption is wrong, and the figure is where that surfaces.
  assert.equal(contextOf(ctx(1_200_000)).pct, 120);
});

test('bars are fractions of the window, clamped to the track', () => {
  const c = contextOf(ctx(0, [{ v: 100_000 }, { v: 1_500_000 }, { v: 500_000 }]));
  assert.deepEqual(c.points.map((p) => p.f), [0.1, 1, 0.5]);
});

test('history downsamples to the bar budget and always keeps the latest point', () => {
  const series = Array.from({ length: 240 }, (_, i) => ({ v: (i + 1) * 1000 }));
  const c = contextOf(ctx(240_000, series));
  assert.ok(c.points.length <= 37);
  assert.equal(c.points.at(-1).f, 0.24);
});

test('garbage points are dropped, not drawn', () => {
  const c = contextOf(ctx(100_000, [{ v: NaN }, { nope: 1 }, { v: 100_000 }]));
  assert.deepEqual(c.points.map((p) => p.f), [0.1]);
});

test('a hole in the sample record is a gap slot, not a seamless climb', () => {
  const t0 = 1_000_000;
  const at = (s, v) => ({ t: t0 + s * 1000, v });
  const c = contextOf(ctx(300_000, [
    at(0, 100_000), at(30, 150_000), at(60, 200_000),
    // ten minutes missing — a closed lid, a stalled parse
    at(660, 300_000),
  ]));
  assert.deepEqual(
    c.points.map((p) => [p.f, p.gap]),
    [[0.1, false], [0.15, false], [0.2, false], [0.3, true]],
  );
});

test('a gap survives the downsampling that drops the point it opened at', () => {
  const t0 = 1_000_000;
  const series = Array.from({ length: 240 }, (_, i) => ({
    t: t0 + i * 30_000, v: 100_000 + i * 1000,
  }));
  // A 20-minute hole opening at index 101, off every kept index (step is 7).
  for (let i = 101; i < 240; i++) series[i].t += 20 * 60_000;
  const c = contextOf(ctx(340_000, series));
  assert.equal(c.points.filter((p) => p.gap).length, 1);
  assert.equal(c.points.at(-1).gap, false);
});

// ── the daemon's sample history ──────────────────────────────────────────────

const sess = (pid, used, over = {}) => ({ pid, since: 'boot', ctxUsed: used, ...over });

test('readings inside the 30s floor refresh the open slot rather than appending', () => {
  resetContextHistory();
  attachContext([sess(42, 100_000)], 1_000_000);
  const b = sess(42, 120_000);
  attachContext([b], 1_010_000);          // 10s on: same slot, new value
  assert.equal(b.ctx.series.length, 1);
  assert.equal(b.ctx.series[0].v, 120_000);
  const c = sess(42, 130_000);
  attachContext([c], 1_031_000);          // past the floor: appends
  assert.equal(c.ctx.series.length, 2);
  assert.equal(c.ctx.series[1].v, 130_000);
});

test('a session with no reading keeps its history; a gone session loses it', () => {
  resetContextHistory();
  attachContext([sess(7, 100_000)], 1_000_000);
  attachContext([sess(7, 200_000)], 1_031_000);
  // One pass with no reading: history must survive (membership, not freshness).
  attachContext([{ pid: 7, since: 'boot' }], 1_062_000);
  const back = sess(7, 250_000);
  attachContext([back], 1_093_000);
  assert.equal(back.ctx.series.length, 3);
  // Now the session leaves the board entirely.
  attachContext([], 1_124_000);
  const gone = sess(7, 300_000);
  attachContext([gone], 1_155_000);
  assert.equal(gone.ctx.series.length, 1, 'evicted with the row; the meter starts over');
});

test('the buffer caps at two hours of floor-cadence points', () => {
  resetContextHistory();
  let s = null;
  for (let i = 0; i < 300; i++) {
    s = sess(9, 100_000 + i);
    attachContext([s], i * 30_000);
  }
  assert.equal(s.ctx.series.length, 240);
  assert.equal(s.ctx.series.at(-1).v, 100_299);
});
