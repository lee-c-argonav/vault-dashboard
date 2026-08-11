// liveness.test.js — how long since a run actually reported.
//
// The board derived that from `updated`, a stamp the writing agent generates. On
// 2026-08-10 a live run's file was last written at 19:07:10Z while claiming
// `updated: 17:21:00Z`, so the board said the run had been silent for 2h46m when
// the true figure was under 40 minutes. `60-Standards/run-status.md` documents
// this failure and warns writers about it, which is the tell: a mistake the spec
// has to warn about is one the reader should stop depending on.
//
// The filesystem already knows. mtime is a direct measurement of when the writer
// last touched the file and cannot be skewed by that writer's clock, so liveness
// comes from it and `updated` becomes a claim that can be checked against it.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuns } from '../runs.js';
import { quietMs, stampLagMs, stampAheadMs, stateText, STALE_MS } from '../public/runs-view.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop', state: 'running',
  note: '', tty: '', started: iso(T0), updated: iso(T0), wrote: null,
  units: [], needsInput: [], blockers: [], ...over,
});

test('quiet is measured from when the file was written, not from the claim', () => {
  // The 2026-08-10 case exactly: written recently, claiming to be much older.
  const r = base({ updated: iso(T0), wrote: iso(T0 + min(106)) });
  assert.equal(quietMs(r, T0 + min(120)), min(14),
    'the run reported 14 minutes ago; the stamp merely says otherwise');
});

test('a run with no file stamp still works from its own claim', () => {
  const r = base({ updated: iso(T0), wrote: null });
  assert.equal(quietMs(r, T0 + min(30)), min(30));
});

test('the disagreement between the two is reported', () => {
  const r = base({ updated: iso(T0), wrote: iso(T0 + min(106)) });
  assert.equal(stampLagMs(r), min(106));
});

test('a writer whose stamps match its writes is not flagged', () => {
  const r = base({ updated: iso(T0), wrote: iso(T0 + 4_000) });
  assert.equal(stampLagMs(r), 0, 'a few seconds between stamping and saving is normal');
});

test('a run whose stamps lag its writes says so on the row', () => {
  const r = base({ updated: iso(T0), wrote: iso(T0 + min(106)) });
  assert.match(stateText(r, T0 + min(120), null), /STAMPS 1h46m BEHIND/);
});

test('and the run is not called quiet on the strength of a bad stamp', () => {
  const r = base({ updated: iso(T0), wrote: iso(T0 + min(106)) });
  const text = stateText(r, T0 + min(110), null);
  assert.doesNotMatch(text, /QUIET/,
    'it reported four minutes ago; QUIET would be the same false claim in words');
});

test('a genuinely silent run is still called quiet', () => {
  const r = base({ updated: iso(T0), wrote: iso(T0) });
  assert.match(stateText(r, T0 + STALE_MS + min(5), null), /QUIET/);
});

test('readRuns reports when each file was last written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-live-'));
  await mkdir(join(root, '15-Runs'));
  const f = join(root, '15-Runs', 'widget-1.json');
  await writeFile(f, JSON.stringify(base()));
  const when = new Date(T0 + min(106));
  await utimes(f, when, when);
  const [run] = await readRuns(root);
  assert.equal(run.wrote, when.toISOString());
  await rm(root, { recursive: true, force: true });
});

// A stamp claiming a time the clock has not reached. The live case that
// prompted this read `updated` 120 minutes into the future and climbing, while
// stampLagMs measured the opposite sign and reported zero.
test('a stamp ahead of the clock is detected and named', () => {
  const now = Date.parse('2026-08-11T15:11:00Z');
  const r = base({
    updated: '2026-08-11T17:12:00Z',
    wrote: '2026-08-11T14:31:00Z',
    state: 'running',
  });
  assert.equal(stampLagMs(r), 0, 'the old check cannot see a future stamp');
  assert.ok(stampAheadMs(r, now) > 0);
  assert.match(stateText(r, now), /STAMPS .* AHEAD/);
  assert.doesNotMatch(stateText(r, now), /BEHIND/, 'both directions on one chip');
});

test('a stamp a few seconds ahead is normal and is not reported', () => {
  const now = Date.parse('2026-08-11T15:11:00Z');
  const r = base({ updated: '2026-08-11T15:11:05Z', wrote: '2026-08-11T15:11:00Z' });
  assert.equal(stampAheadMs(r, now), 0);
});
