// honesty.test.js — the board must not say a thing that contradicts what it shows.
//
// Two reports from the operator on 2026-08-10, both correct, both about a row
// stating one thing while the rest of the row said another:
//
//   "Meet Google V2 says blocked, quiet. However, there is an agent/subagent
//    running, so it is not really quiet."
//
//   "this session says not reporting, but it's currently an active session.
//    I worked on it five minutes ago."
//
// The run in question had a unit blocked 31 units back, four sub-agents marked
// running, a writer that had not stamped `updated` in 2h22m, and a live session
// on /dev/ttys002 the whole time. Every one of those is true at once, and the
// row compressed them into "BLOCKED · QUIET 2h22m", which reads as a dead run.
//
// The board could already tell the difference and was not using it: sessions.js
// knows whether the writing session is still alive, which separates "stopped
// reporting" from "stopped".
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runState, stateText, blockedNote, sortRank, partitionRuns, askOf, FINISHED_MAX_AGE_MS }
  from '../public/runs-view.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const day = (n) => n * 86_400_000;
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop', state: 'running',
  note: '', tty: '', started: iso(T0), updated: iso(T0),
  units: [], needsInput: [], blockers: [], ...over,
});
const SESSION = { pid: 501, tty: '/dev/ttys000', project: 'widget', where: 'w', since: iso(T0) };

// ── a run doing work does not read BLOCKED ───────────────────────────────────

test('a blocked unit alongside a running one leaves the run RUNNING', () => {
  const r = base({ units: [
    { id: '4', label: 'the visual review', state: 'blocked', agents: [] },
    { id: 'DR2', label: 'the re-check', state: 'running', agents: [] },
  ] });
  assert.equal(runState(r), 'running',
    'four sub-agents were running under DR2 while the row claimed BLOCKED');
});

test('the block is still stated, not dropped', () => {
  const r = base({ units: [
    { id: '4', label: 'the visual review', state: 'blocked', agents: [] },
    { id: 'DR2', label: 'the re-check', state: 'running', agents: [] },
  ] });
  assert.equal(blockedNote(r), '1 BLOCKED');
  assert.match(stateText(r, T0 + min(1), SESSION), /RUNNING · 1 BLOCKED/);
});

test('a blocked unit with nothing running still blocks the run', () => {
  const r = base({ units: [{ id: '4', label: 'x', state: 'blocked', agents: [] }] });
  assert.equal(runState(r), 'blocked');
  assert.equal(blockedNote(r), '');
});

test('a failed unit blocks the run even while other work runs', () => {
  // A failure is not a thing you work around; it is a thing that is wrong.
  const r = base({ units: [
    { id: '4', label: 'x', state: 'failed', agents: [] },
    { id: '5', label: 'y', state: 'running', agents: [] },
  ] });
  assert.equal(runState(r), 'blocked');
});

test('working-but-blocked sorts above plain running and below blocked', () => {
  const working = base({ runId: 'a', units: [
    { id: '1', state: 'blocked', label: 'x', agents: [] },
    { id: '2', state: 'running', label: 'y', agents: [] }] });
  const plain = base({ runId: 'b', units: [{ id: '1', state: 'running', label: 'y', agents: [] }] });
  const stuck = base({ runId: 'c', units: [{ id: '1', state: 'blocked', label: 'x', agents: [] }] });
  assert.ok(sortRank(stuck) < sortRank(working), 'a run that cannot proceed outranks one that can');
  assert.ok(sortRank(working) < sortRank(plain), 'but a block still lifts it above ordinary work');
});

// ── quiet means we cannot see it, not merely that it is silent ────────────────

test('a live session turns QUIET into NO UPDATE', () => {
  const r = base({ updated: iso(T0) });
  const text = stateText(r, T0 + min(142), SESSION);
  assert.match(text, /NO UPDATE 2h22m/);
  assert.doesNotMatch(text, /QUIET/,
    'the session was observably alive; calling it quiet reads as dead');
});

test('no visible session keeps QUIET, which is the honest word for unknown', () => {
  const r = base({ updated: iso(T0) });
  assert.match(stateText(r, T0 + min(142), null), /QUIET 2h22m/);
});

test('a recently stamped run says neither', () => {
  const r = base({ updated: iso(T0) });
  assert.equal(stateText(r, T0 + min(2), null), 'RUNNING');
});

test('a missing stamp is still a writer bug and still says so', () => {
  const r = base({ updated: 'not a date' });
  assert.match(stateText(r, T0, SESSION), /NO STAMP/);
});

// ── history expires ──────────────────────────────────────────────────────────

test('finished runs older than the window are dropped', () => {
  const { finished } = partitionRuns([
    base({ runId: 'fresh', state: 'done', updated: iso(T0 - day(1)) }),
    base({ runId: 'stale', state: 'done', updated: iso(T0 - day(9)) }),
  ], [], T0);
  assert.deepEqual(finished.map((r) => r.runId), ['fresh']);
});

test('the window is five days', () => {
  assert.equal(FINISHED_MAX_AGE_MS, day(5));
  const { finished } = partitionRuns([
    base({ runId: 'just-in', state: 'done', updated: iso(T0 - day(5) + min(1)) }),
    base({ runId: 'just-out', state: 'done', updated: iso(T0 - day(5) - min(1)) }),
  ], [], T0);
  assert.deepEqual(finished.map((r) => r.runId), ['just-in']);
});

test('finished runs come back newest first', () => {
  const { finished } = partitionRuns([
    base({ runId: 'old', state: 'done', updated: iso(T0 - day(3)) }),
    base({ runId: 'new', state: 'done', updated: iso(T0 - min(5)) }),
    base({ runId: 'mid', state: 'done', updated: iso(T0 - day(1)) }),
  ], [], T0);
  assert.deepEqual(finished.map((r) => r.runId), ['new', 'mid', 'old']);
});

test('a finished run with no usable stamp is dropped rather than pinned forever', () => {
  // It cannot be aged out and it cannot be ordered, so keeping it means a row
  // that sits at the bottom of the history for good.
  const { finished } = partitionRuns([
    base({ runId: 'nostamp', state: 'done', updated: 'not a date' }),
    base({ runId: 'good', state: 'done', updated: iso(T0) }),
  ], [], T0);
  assert.deepEqual(finished.map((r) => r.runId), ['good']);
});

test('expiry never touches live runs, however old their last stamp', () => {
  const { active } = partitionRuns([
    base({ runId: 'ancient', state: 'running', updated: iso(T0 - day(40)) }),
  ], [], T0);
  assert.equal(active.length, 1, 'an abandoned live run must stay visible, not vanish');
});

test('omitting the clock keeps every finished run, so callers cannot silently expire', () => {
  const { finished } = partitionRuns([
    base({ runId: 'ancient', state: 'done', updated: iso(T0 - day(40)) }),
  ]);
  assert.equal(finished.length, 1);
});

// ── the count must name what it is counting ──────────────────────────────────

test('a working run still names which unit is blocked', () => {
  // "1 BLOCKED" alone is not actionable. This line was live and correct, then
  // disappeared the moment runState stopped calling such a run blocked, because
  // askOf was gated on that state.
  const r = base({ units: [
    { id: 'R4', label: 'the visual review, shot and waiting on you', state: 'blocked', agents: [] },
    { id: 'DR2', label: 'the re-check', state: 'running', agents: [] },
  ] });
  assert.equal(runState(r), 'running');
  assert.match(askOf(r, T0), /Unit R4 blocked: the visual review, shot and waiting on you/);
});

test('a run with nothing wrong says nothing', () => {
  const r = base({ units: [{ id: '1', label: 'x', state: 'running', agents: [] }] });
  assert.equal(askOf(r, T0), '');
});

test('an explicit blocker still outranks the unit fallback on a working run', () => {
  const r = base({
    blockers: [{ what: 'the release gate needs a key', since: iso(T0) }],
    units: [
      { id: 'R4', label: 'x', state: 'blocked', agents: [] },
      { id: 'DR2', label: 'y', state: 'running', agents: [] },
    ],
  });
  assert.match(askOf(r, T0 + min(30)), /release gate needs a key/);
});
