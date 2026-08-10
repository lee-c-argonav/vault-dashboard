// stamps.test.js — durations the board must not present as measurements.
//
// From the operator, 2026-08-10, looking at a five-unit run:
//
//   "how can everything be 7 minutes? It's not clear unless it's already done,
//    but then why does it say running?"
//
// Two separate defects in one row.
//
// The first is a writer defect the reader was passing on silently. All five
// units carried the same `started` and the same `ended`, because the session
// wrote them in one batch at the end instead of at each unit boundary, so every
// duration cell read 7m. Those are not measurements, they are one measurement
// copied five times, and `eta` was treating them as five samples — which is
// exactly the input the estimate is least able to survive, since its whole
// premise is spread across independent units.
//
// The second is that "5 of 5 done" sat next to "RUNNING". Both were true of the
// file and they cannot both be true of the world; the run had finished its units
// and had not said so.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationOf, eta, stateText, batchStamped } from '../public/runs-view.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop', state: 'running',
  note: '', tty: '', started: iso(T0), updated: iso(T0),
  units: [], needsInput: [], blockers: [], ...over,
});
const done = (id, a, b) => ({ id, label: id, state: 'done', started: iso(a), ended: iso(b), agents: [] });

// ── stamps written in one batch are not five measurements ────────────────────

test('units sharing one start and one end are identified as batch stamped', () => {
  const units = [
    done('1', T0, T0 + min(7)),
    done('2', T0, T0 + min(7)),
    done('3', T0, T0 + min(7)),
  ];
  assert.deepEqual([...batchStamped(units)].map((u) => u.id).sort(), ['1', '2', '3']);
});

test('units genuinely measured are not flagged', () => {
  const units = [
    done('1', T0, T0 + min(7)),
    done('2', T0 + min(7), T0 + min(20)),
    done('3', T0 + min(20), T0 + min(24)),
  ];
  assert.equal(batchStamped(units).size, 0);
});

test('two units that really did run concurrently are still flagged, and should be', () => {
  // Indistinguishable from batch stamping in the file, and the consequence is
  // the same either way: they are one sample, not two, so the estimate must not
  // count them twice.
  const units = [done('1', T0, T0 + min(7)), done('2', T0, T0 + min(7))];
  assert.equal(batchStamped(units).size, 2);
});

test('the duration cell says why it is not a measurement', () => {
  const units = [done('1', T0, T0 + min(7)), done('2', T0, T0 + min(7))];
  const cell = durationOf(units[0], T0 + min(30), batchStamped(units));
  assert.equal(cell.bad, true);
  assert.match(cell.why, /same start and end/i);
  assert.equal(cell.text, '7m', 'the number is still shown; it is the confidence that changes');
});

test('an unflagged unit is unaffected', () => {
  const units = [done('1', T0, T0 + min(7)), done('2', T0 + min(7), T0 + min(21))];
  const cell = durationOf(units[0], T0 + min(30), batchStamped(units));
  assert.equal(cell.bad, false);
  assert.equal(cell.text, '7m');
});

test('durationOf still works when no batch set is passed', () => {
  assert.equal(durationOf(done('1', T0, T0 + min(7)), T0).text, '7m');
});

// ── the estimate refuses copied stamps ───────────────────────────────────────

test('eta ignores batch-stamped units, so five copies are not five samples', () => {
  const units = [
    done('1', T0, T0 + min(7)), done('2', T0, T0 + min(7)),
    done('3', T0, T0 + min(7)), done('4', T0, T0 + min(7)),
    { id: '5', label: 'x', state: 'todo', agents: [] },
  ];
  assert.equal(eta(units), null,
    'one measurement copied four times is one sample, which is below the floor');
});

test('eta still works on genuinely measured units', () => {
  const units = [
    done('1', T0, T0 + min(10)),
    done('2', T0 + min(10), T0 + min(21)),
    done('3', T0 + min(21), T0 + min(31)),
    { id: '4', label: 'x', state: 'todo', agents: [] },
  ];
  assert.ok(eta(units), 'three independent samples is the documented floor');
});

// ── a run that has finished its units says so ────────────────────────────────

test('every unit done while the run still claims to be running is stated', () => {
  const r = base({ units: [done('1', T0, T0 + min(7)), done('2', T0 + min(7), T0 + min(9))] });
  assert.match(stateText(r, T0 + min(10), null), /ALL UNITS DONE/);
});

test('a run with work left says nothing of the sort', () => {
  const r = base({ units: [done('1', T0, T0 + min(7)), { id: '2', label: 'x', state: 'todo', agents: [] }] });
  assert.doesNotMatch(stateText(r, T0 + min(10), null), /ALL UNITS DONE/);
});

test('a run with no units at all is not "all done"', () => {
  assert.doesNotMatch(stateText(base(), T0 + min(10), null), /ALL UNITS DONE/);
});

test('a finished run does not need telling', () => {
  const r = base({ state: 'done', units: [done('1', T0, T0 + min(7))] });
  assert.doesNotMatch(stateText(r, T0 + min(10), null), /ALL UNITS DONE/);
});
