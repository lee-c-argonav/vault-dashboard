// runs.test.js — the 15-Runs reader and the shared view derivation.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuns } from '../runs.js';
import { runState, isQuiet, eta, quietMs, askOf, unitWindow } from '../public/runs-view.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();

const base = (over = {}) => ({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', started: iso(T0),
  updated: iso(T0), units: [], needsInput: [], blockers: [], ...over,
});

async function vaultWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-runs-'));
  await mkdir(join(root, '15-Runs'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '15-Runs', name), body);
  }
  return root;
}

test('runState passes done and paused through untouched', () => {
  assert.equal(runState(base({ state: 'done' })), 'done');
  assert.equal(runState(base({ state: 'paused', blockers: [{ what: 'x' }] })), 'paused');
});

test('needsInput outranks blockers', () => {
  const r = base({ needsInput: [{ question: 'q' }], blockers: [{ what: 'x' }] });
  assert.equal(runState(r), 'needs-input');
});

test('a failed unit blocks the run', () => {
  assert.equal(runState(base({ units: [{ state: 'failed' }] })), 'blocked');
});

test('quiet is a second axis, not a state', () => {
  const r = base({ needsInput: [{ question: 'q' }] });
  assert.equal(runState(r), 'needs-input');
  assert.equal(isQuiet(r, T0 + min(5)), false);
  assert.equal(isQuiet(r, T0 + min(21)), true);
  assert.equal(quietMs(r, T0 + min(21)), min(21));
});

test('a run with an unparseable updated stamp reads as quiet', () => {
  assert.equal(isQuiet(base({ updated: 'nonsense' }), T0), true);
});

test('eta is suppressed below three completed units', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  assert.equal(eta([d(T0, T0 + min(10)), d(T0, T0 + min(10)), { state: 'todo' }]), null);
});

test('eta is a point when durations are tight', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  const e = eta([d(T0, T0 + min(10)), d(T0, T0 + min(11)), d(T0, T0 + min(12)),
                 { state: 'todo' }, { state: 'todo' }]);
  assert.equal(e.measured, 3);
  assert.equal(e.point, min(11) * 2);
  assert.equal(e.low, undefined);
});

test('a wide spread gives a band centred on the mean, one sd either side', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  // Samples 5m, 10m, 40m. mean = 18m20s, population sd = 15m27.3s, remaining 1.
  const e = eta([d(T0, T0 + min(5)), d(T0, T0 + min(10)), d(T0, T0 + min(40)),
                 { state: 'todo' }]);
  assert.equal(e.measured, 3);
  assert.equal(e.point, undefined);
  const mean = (min(5) + min(10) + min(40)) / 3;
  const sd = Math.sqrt(((min(5) - mean) ** 2 + (min(10) - mean) ** 2 + (min(40) - mean) ** 2) / 3);
  assert.ok(Math.abs(e.low - (mean - sd)) < 1);
  assert.ok(Math.abs(e.high - (mean + sd)) < 1);
});

test('the band never goes negative', () => {
  // Distinct stamps on every unit, deliberately. Two units sharing an exact
  // start and end are one measurement copied, which `eta` now excludes, and the
  // point of this fixture is a wide spread rather than a duplicate pair.
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  const e = eta([d(T0, T0 + min(1)), d(T0 + min(2), T0 + min(3)), d(T0 + min(4), T0 + min(124)),
                 { state: 'todo' }]);
  assert.ok(e.low >= 0);
});

// The bug this replaces: low = min * remaining and high = max * remaining grew
// the band linearly with the work left, so a long run got a wider and wider
// estimate. A sum of k draws concentrates, so relative uncertainty must SHRINK.
test('relative uncertainty shrinks as more units remain', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  const done = [d(T0, T0 + min(5)), d(T0, T0 + min(10)), d(T0, T0 + min(40))];
  const todo = (n) => Array.from({ length: n }, () => ({ state: 'todo' }));
  const width = (n) => {
    const e = eta([...done, ...todo(n)]);
    const mid = e.point ?? (e.low + e.high) / 2;
    return e.point != null ? 0 : (e.high - e.low) / mid;
  };
  assert.ok(width(16) < width(1), 'a 16-unit tail must be relatively tighter than a 1-unit tail');
});

test('eta is null when nothing remains', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  assert.equal(eta([d(T0, T0 + min(9)), d(T0, T0 + min(10)), d(T0, T0 + min(11))]), null);
});

test('readRuns keeps good files and skips junk without throwing', async () => {
  const root = await vaultWith({
    'widget-1.json': JSON.stringify(base()),
    'half-written.json': '{"runId": "sprocket-9"',
    'notes.md': 'ignored',
  });
  const runs = await readRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'widget-1');
  await rm(root, { recursive: true, force: true });
});

test('readRuns survives every malformed field it can be handed', async () => {
  const root = await vaultWith({
    'a.json': JSON.stringify(base({ units: 'nope' })),
    'b.json': JSON.stringify(base({ runId: 'widget-b', needsInput: 'yes' })),
    'c.json': JSON.stringify({ ...base(), runId: 5 }),
    'd.json': JSON.stringify(base({ runId: 'widget-d', state: 'invented' })),
  });
  const runs = await readRuns(root);
  // 'c' has a non-string runId and is dropped; the rest survive, coerced.
  assert.equal(runs.length, 3);
  const a = runs.find((r) => r.runId === 'widget-1');
  assert.deepEqual(a.units, []);
  const b = runs.find((r) => r.runId === 'widget-b');
  assert.deepEqual(b.needsInput, []);
  assert.equal(runState(b), 'running');
  assert.equal(runs.find((r) => r.runId === 'widget-d').state, 'running');
  await rm(root, { recursive: true, force: true });
});

test('readRuns returns empty when the folder is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-runs-'));
  assert.deepEqual(await readRuns(root), []);
  await rm(root, { recursive: true, force: true });
});

test('no derived field in a run changes with the clock', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const a = JSON.stringify(await readRuns(root));
  await new Promise((r) => setTimeout(r, 20));
  const b = JSON.stringify(await readRuns(root));
  assert.equal(a, b);  // State must be stable, or app.js repaints on every tick
  await rm(root, { recursive: true, force: true });
});

// ── `blocked` as a unit state ────────────────────────────────────────────────
//
// runs.js has always admitted `blocked` into UNIT_STATES, and until 2026-08-10
// no reader branched on it: runState escalated on `failed` only, unitWindow
// pivoted on `failed` then `running`, and askOf named failed units only. The
// live consequence was a run whose unit "the visual review, waiting on you" sat
// blocked while the row read RUNNING and the unit itself was hidden behind
// "+31 earlier". Something waiting on the operator was invisible on both
// surfaces. These tests exist so it cannot go quiet again.

test('a blocked unit blocks the run, exactly as a failed one does', () => {
  const r = base({ units: [{ id: '1', label: 'a', state: 'blocked' }] });
  assert.equal(runState(r), 'blocked');
});

test('an explicit blockers entry still outranks a blocked unit as the reason', () => {
  const r = base({
    blockers: [{ what: 'the release gate needs a key', since: iso(T0) }],
    units: [{ id: '1', label: 'a', state: 'blocked' }],
  });
  assert.equal(runState(r), 'blocked');
  assert.match(askOf(r, T0 + min(30)), /release gate needs a key/);
});

test('askOf names the blocked unit when nothing else explains the block', () => {
  const r = base({ units: [{ id: '4', label: 'the visual review', state: 'blocked' }] });
  assert.match(askOf(r, T0), /Unit 4 blocked: the visual review/);
});

test('askOf counts them when several units are blocked', () => {
  const r = base({ units: [
    { id: '4', label: 'a', state: 'blocked' },
    { id: '5', label: 'b', state: 'blocked' },
  ] });
  assert.match(askOf(r, T0), /2 units blocked: 4, 5/);
});

test('a failed unit is still named ahead of a blocked one', () => {
  const r = base({ units: [
    { id: '4', label: 'the visual review', state: 'blocked' },
    { id: '5', label: 'the gate', state: 'failed' },
  ] });
  assert.match(askOf(r, T0), /Unit 5 failed: the gate/);
});

test('the unit window pivots onto a blocked unit rather than hiding it', () => {
  // Twelve units with the blocked one early: without a pivot it falls outside
  // the window and the run states a reason the reader cannot see.
  const units = Array.from({ length: 12 }, (_, i) =>
    ({ id: String(i), label: `u${i}`, state: i === 1 ? 'blocked' : 'done' }));
  const w = unitWindow(units);
  assert.ok(w.visible.some((u) => u.state === 'blocked'),
    'the unit that explains the row must be inside the window');
});

test('a failed unit still outranks a blocked one for the pivot', () => {
  const units = Array.from({ length: 12 }, (_, i) =>
    ({ id: String(i), label: `u${i}`,
       state: i === 1 ? 'blocked' : i === 9 ? 'failed' : 'done' }));
  const w = unitWindow(units);
  assert.ok(w.visible.some((u) => u.state === 'failed'));
});

test('a run file with no account parses exactly as before', async () => {
  // `account` was added to the schema on 2026-08-20 and is purely additive.
  // Nearly every file in the archive predates it, so a reader that does not
  // know the field must be unchanged by its absence.
  const root = await vaultWith({ 'a.json': JSON.stringify(base()) });
  const [r] = await readRuns(root);
  assert.equal(r.account, null);
  assert.equal(r.runId, 'widget-1');
  assert.equal(r.goal, 'Widget goal');
  assert.deepEqual(r.units, []);
  await rm(root, { recursive: true, force: true });
});

test('a malformed account costs the tag, never the row', async () => {
  // The object is JSON an agent pasted into a run file. One bad field must cost
  // this row's tag; the row itself, and the parse, carry on.
  const root = await vaultWith({
    'a.json': JSON.stringify(base({ runId: 'widget-a', account: 'a string' })),
    'b.json': JSON.stringify(base({ runId: 'widget-b', account: [] })),
    'c.json': JSON.stringify(base({ runId: 'widget-c', account: 42 })),
    'd.json': JSON.stringify(base({ runId: 'widget-d', account: { plan: [], tier: {} } })),
  });
  const runs = await readRuns(root);
  assert.equal(runs.length, 4);
  for (const r of runs) assert.equal(r.goal, 'Widget goal');
  assert.equal(runs[0].account, null);
  assert.equal(runs[1].account, null);
  assert.equal(runs[2].account, null);
  assert.equal(runs[3].account.source, 'none', 'an object survives, its bad fields do not');
  await rm(root, { recursive: true, force: true });
});
