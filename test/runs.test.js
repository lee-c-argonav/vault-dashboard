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
import { runState, isQuiet, eta, quietMs } from '../public/runs-view.js';

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

test('a wide spread gives the observed extremes, not a multiplier band', () => {
  const d = (a, b) => ({ state: 'done', started: iso(a), ended: iso(b) });
  const e = eta([d(T0, T0 + min(5)), d(T0, T0 + min(10)), d(T0, T0 + min(40)),
                 { state: 'todo' }]);
  assert.equal(e.measured, 3);
  assert.equal(e.low, min(5));    // the fastest unit observed, times 1 remaining
  assert.equal(e.high, min(40));  // the slowest. The band contains the data.
  assert.equal(e.point, undefined);
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
