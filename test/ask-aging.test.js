// ask-aging.test.js — a quiet run's asks and blockers stop being demand past ASK_LIVE_MS.
//
// The rule (operator report 2026-08-17): a run whose FILE has been quiet past
// six hours cannot be answered — its needsInput/blockers entries age out of
// every count and state label, and the row keeps them only as residue ("ASKS
// UNANSWERED"). The file, not the process: a live session that is still
// writing keeps its quiet time low anyway, and an inert one is a zombie for
// this purpose, pid alive or not. Calls without a clock get the legacy
// reading (every ask counts), which the older suites pin.
//
// This repository is public: fixtures are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAsks, liveBlockers, runState, attentionModel, stateText, askOf, ASK_LIVE_MS } from '../public/runs-view.js';

const T0 = Date.parse('2026-08-17T12:00:00.000Z');
const H = 3600_000;
const iso = (t) => new Date(t).toISOString();

const run = (over = {}) => ({
  runId: 'r-1', project: 'p', goal: 'g', state: 'running',
  started: iso(T0 - 10 * H), updated: iso(T0 - 10 * H), wrote: iso(T0 - 10 * H),
  units: [],
  needsInput: [{ question: 'ship or drop the widget?', since: iso(T0 - 10 * H) }],
  blockers: [],
  session: null,
  ...over,
});

test('a dead run past the horizon: asks leave the state, the census, and the demand', () => {
  const r = run();
  assert.deepEqual(liveAsks(r, T0), []);
  assert.equal(runState(r, T0), 'running', 'an aged-out ask must not read NEEDS YOU');
  assert.equal(attentionModel({ runs: [r], sessions: [] }, T0).counts.needsYou, 0);
  assert.match(stateText(r, T0, null), /1 ASK UNANSWERED/,
    'the residue note is missing: the ask was never answered');
});

test('a dead run INSIDE the horizon is still asking', () => {
  const r = run({ updated: iso(T0 - 2 * H), wrote: iso(T0 - 2 * H) });
  assert.equal(liveAsks(r, T0).length, 1);
  assert.equal(runState(r, T0), 'needs-input');
  assert.equal(attentionModel({ runs: [r], sessions: [] }, T0).counts.needsYou, 1);
});

test('a live session with a FRESH file keeps its asks; an inert one loses them', () => {
  // The file is the signal, not the process: a session writing recently may
  // be genuinely waiting; one that has not written in days is a zombie for
  // this purpose, pid alive or not (measured live, 2026-08-17).
  const fresh = run({ session: { pid: 1 }, updated: iso(T0 - 2 * H), wrote: iso(T0 - 2 * H) });
  assert.equal(liveAsks(fresh, T0).length, 1);
  assert.equal(runState(fresh, T0), 'needs-input');
  const zombie = run({ session: { pid: 1 } });   // file quiet 10h, pid alive
  assert.deepEqual(liveAsks(zombie, T0), []);
  assert.equal(runState(zombie, T0), 'running');
  assert.match(stateText(zombie, T0, zombie.session), /NO UPDATE .*1 ASK UNANSWERED/);
});

test('the horizon boundary: at exactly ASK_LIVE_MS the ask is still live', () => {
  const at = run({ updated: iso(T0 - ASK_LIVE_MS), wrote: iso(T0 - ASK_LIVE_MS) });
  assert.equal(liveAsks(at, T0).length, 1);
  const past = run({ updated: iso(T0 - ASK_LIVE_MS - 1), wrote: iso(T0 - ASK_LIVE_MS - 1) });
  assert.equal(liveAsks(past, T0).length, 0);
});

test('no clock is the legacy reading: every ask counts', () => {
  const r = run();
  assert.equal(liveAsks(r).length, 1);
  assert.equal(runState(r), 'needs-input');
  assert.equal(attentionModel({ runs: [r], sessions: [] }).counts.needsYou, 1);
});

test('blockers age out on the same rule as asks', () => {
  const blocked = run({ needsInput: [], blockers: [{ what: 'a gate needs a key', since: iso(T0 - 10 * H) }] });
  assert.deepEqual(liveBlockers(blocked, T0), []);
  assert.equal(runState(blocked, T0), 'running', 'a four-day-quiet run is stopped, not blocked');
  assert.equal(attentionModel({ runs: [blocked], sessions: [] }, T0).counts.blocked, 0);
  const fresh = run({ needsInput: [], blockers: [{ what: 'a gate needs a key', since: iso(T0 - H) }],
    updated: iso(T0 - H), wrote: iso(T0 - H) });
  assert.equal(runState(fresh, T0), 'blocked');
  assert.equal(attentionModel({ runs: [fresh], sessions: [] }, T0).counts.blocked, 1);
});

test('a run that never reported cannot age out: a missing stamp is not silence', () => {
  const r = run({ updated: null, wrote: null });
  assert.equal(liveAsks(r, T0).length, 1);
});

test('a done or paused run keeps its own state; aging is moot there', () => {
  assert.equal(runState(run({ state: 'done' }), T0), 'done');
  assert.equal(runState(run({ state: 'paused' }), T0), 'paused');
});

test('the plural residue names the count', () => {
  const r = run({
    needsInput: [
      { question: 'one?', since: iso(T0 - 10 * H) },
      { question: 'two?', since: iso(T0 - 10 * H) },
      { question: 'three?', since: iso(T0 - 10 * H) },
    ],
  });
  assert.match(stateText(r, T0, null), /3 ASKS UNANSWERED/);
});

test('an aged blocker is not named as the live reason when a failed unit is why', () => {
  const r = run({
    needsInput: [],
    blockers: [{ what: 'a gate needs a key', since: iso(T0 - 10 * H) }],
    units: [{ id: '7', label: 'the upload path', state: 'failed', agents: [] }],
  });
  // The blockers list aged out; the failed unit still makes the run blocked,
  // and the reason line must name the unit, not the residue blocker.
  assert.equal(runState(r, T0), 'blocked');
  const ask = askOf(r, T0);
  assert.ok(ask.includes('the upload path'), `named the residue instead of the unit: ${ask}`);
  assert.ok(!ask.includes('a gate needs a key'), 'the aged-out blocker was named as live');
});

test('the phone digest flips once when the demand ages out', async () => {
  const { boardDigest } = await import('../status-page/build.js');
  const board = (r) => ({ active: [r], finished: [], unpublished: [], skipped: 0, usage: null });
  // Quiet 6h00m vs 6h20m vs 6h29m: straddles the horizon while sharing one
  // silence bucket, so only the flip term can move the digest.
  const r = run({ updated: iso(T0 - 6 * H), wrote: iso(T0 - 6 * H) });
  const live = boardDigest(board(r), T0);
  const aged = boardDigest(board(r), T0 + 20 * 60_000);
  assert.notEqual(live, aged, 'the aging flip fired no deploy');
  assert.equal(aged, boardDigest(board(r), T0 + 29 * 60_000),
    'the flip moved twice inside one silence bucket');
});
