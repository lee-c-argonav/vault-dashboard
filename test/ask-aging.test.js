// ask-aging.test.js — a dead run's asks stop being demand past ASK_LIVE_MS.
//
// The rule (operator report 2026-08-17): a run with no live session and a
// file quiet past six hours cannot be answered, so its needsInput entries age
// out of every count and state label, and the row keeps them only as residue
// ("ASKS UNANSWERED"). A run with a live session never ages out: alive and
// unanswered is a fact, and "settled" is the writer's to say by removing the
// entry. Calls without a clock get the legacy reading (every ask counts),
// which the older suites pin.
//
// This repository is public: fixtures are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAsks, runState, attentionModel, stateText, ASK_LIVE_MS } from '../public/runs-view.js';

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

test('a run with a live session never ages its asks out, however quiet the file', () => {
  const r = run({ session: { pid: 1 } });
  assert.equal(liveAsks(r, T0).length, 1);
  assert.equal(runState(r, T0), 'needs-input');
  assert.equal(attentionModel({ runs: [r], sessions: [] }, T0).counts.needsYou, 1);
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

test('a run that never reported cannot age out: a missing stamp is not silence', () => {
  const r = run({ updated: null, wrote: null });
  assert.equal(liveAsks(r, T0).length, 1);
});
