// time-language.test.js — the one language for time, and the claims behind it.
//
// The board makes seven distinct claims about time: TOOK (a finished span), SO
// FAR (a growing one), LEFT (a forecast), PAST (a forecast the sample stopped
// supporting), SINCE (silence and recency), FAULT (stamps disagreeing with the
// clock) and AT (a clock time). The rule under test: a bare duration always
// states TOOK, every other claim carries its marker (`+`, `left`, `≥`, `PAST`,
// a named word, `HH:MM`), and `+` before a duration means nothing but "still
// growing".
//
// This repository is public, so fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockAt, finishClock, goalEta, goalEtaText, fanoutGantt, sessionActivity,
  askOf, rowSignature, agentEta, groupDuration,
} from '../public/runs-view.js';

const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();
// Local-time anchor, because clockAt renders local clock faces. 14:00 local
// keeps every offset used below inside one calendar day.
const NOW = new Date(2026, 7, 11, 14, 0, 0).getTime();

const run = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop',
  state: 'running', note: '', tty: '', started: iso(NOW - min(75)),
  updated: iso(NOW), wrote: iso(NOW),
  units: [], needsInput: [], blockers: [], session: null, ...over,
});
const done = (id, a, b) => ({ id, label: id, state: 'done', started: iso(a), ended: iso(b), agents: [] });
const todo = (id) => ({ id, label: id, state: 'todo', started: null, ended: null, agents: [] });
const agent = (id, state, startedMin, movedMin = null, over = {}) => ({
  id, label: id, agentType: 'x', depth: 1, parent: '', workflow: '',
  state, started: iso(NOW - min(startedMin)),
  movedAt: movedMin === null ? iso(NOW) : iso(NOW - min(movedMin)),
  ...over,
});

// ── AT: a clock face, never a duration ───────────────────────────────────────

test('clockAt renders today as a bare clock', () => {
  assert.equal(clockAt(NOW - min(120), NOW), '12:00');
});

test('clockAt names the day once the clock alone would lie', () => {
  // Yesterday 17:00 as a bare "17:00" reads as today. 2026-08-10 is a Monday.
  assert.equal(clockAt(NOW - min(21 * 60), NOW), 'MON 17:00');
});

test('clockAt drops to a date when the hour stops mattering', () => {
  assert.match(clockAt(NOW - 10 * 86_400_000, NOW), /^Aug \d+$/);
});

test('clockAt refuses garbage rather than inventing a time', () => {
  assert.equal(clockAt('not a date', NOW), '');
  assert.equal(clockAt(undefined, NOW), '');
});

test('finishClock lands a point estimate on the clock and bounds a range with "by"', () => {
  assert.equal(finishClock({ point: min(40) }, NOW), '14:40');
  assert.equal(finishClock({ low: min(10), high: min(56) }, NOW), 'by 14:56');
  assert.equal(finishClock({ over: min(30), usual: min(7) }, NOW), '',
    'an overrun has no projected finish; PAST is its claim');
  assert.equal(finishClock(null, NOW), '');
});

// ── LEFT on the goal: one slot, never silently blank while work remains ──────

test('three timed units give the goal a real forecast', () => {
  const r = run({ units: [
    done('1', NOW - min(60), NOW - min(50)),
    done('2', NOW - min(50), NOW - min(39)),
    done('3', NOW - min(39), NOW - min(29)),
    todo('4'),
  ] });
  const g = goalEta(r, NOW);
  assert.equal(g.kind, 'estimate');
  assert.match(goalEtaText(g), /left$/);
});

test('a run with no timed units says why there is no estimate', () => {
  // The live case that produced this slot: 0 of 14 done, a fan-out estimating
  // away one line up, and the goal footer silently blank.
  const r = run({ units: [{ ...todo('1.0'), state: 'running', started: iso(NOW - min(75)) },
    ...Array.from({ length: 13 }, (_, i) => todo(`1.${i + 1}`))] });
  const g = goalEta(r, NOW);
  assert.equal(g.kind, 'none');
  assert.equal(goalEtaText(g), 'no estimate · 0 of 14 units timed');
});

test('a live fan-out puts a marked floor under an unmeasured goal', () => {
  const r = run({
    units: [{ ...todo('1.0'), state: 'running', started: iso(NOW - min(75)) }, todo('1.1')],
    session: { pid: 1, agents: [
      agent('a', 'done', 60, 30), agent('b', 'done', 60, 35), agent('c', 'done', 60, 20),
      agent('d', 'running', 5),
    ] },
  });
  const g = goalEta(r, NOW);
  assert.equal(g.kind, 'floor');
  const text = goalEtaText(g);
  assert.match(text, /^≥.* left · 0 of 2 units timed$/,
    '`≥` marks a floor; the tail says why no forecast exists');
  // The floor is the fan-out's optimistic end, which the goal cannot beat.
  const ae = agentEta(r.session.agents, NOW);
  assert.equal(g.low, ae.point ?? ae.low);
});

test('a floor under a minute claims nothing and falls back to the why', () => {
  const r = run({
    units: [todo('1')],
    session: { pid: 1, agents: [
      agent('a', 'done', 60, 30), agent('b', 'done', 60, 35), agent('c', 'done', 60, 20),
      // 29m in against a 25m median and a 40m slowest: under a minute of floor
      // is a statement with nothing in it.
      agent('d', 'running', 29.5),
    ] },
  });
  assert.equal(goalEta(r, NOW).kind, 'none');
});

test('an overrun fan-out gives the goal no floor — the sample stopped predicting', () => {
  const r = run({
    units: [todo('1')],
    session: { pid: 1, agents: [
      agent('a', 'done', 60, 50), agent('b', 'done', 60, 49), agent('c', 'done', 60, 48),
      agent('d', 'running', 55),
    ] },
  });
  assert.equal(goalEta(r, NOW).kind, 'none');
});

test('stamps written in one batch are named as the reason', () => {
  const r = run({ units: [
    done('1', NOW - min(60), NOW - min(50)), done('2', NOW - min(60), NOW - min(50)),
    done('3', NOW - min(60), NOW - min(50)), todo('4'),
  ] });
  assert.equal(goalEtaText(goalEta(r, NOW)), 'no estimate · stamps written in one batch');
});

test('a goal with nothing left, or no units at all, claims nothing', () => {
  assert.equal(goalEta(run({ units: [done('1', NOW - min(9), NOW)] }), NOW), null);
  assert.equal(goalEta(run(), NOW), null);
});

// ── the fan-out Gantt: the batch as it actually happened ─────────────────────

test('a fan-out with no dispatch stamps draws no Gantt', () => {
  assert.equal(fanoutGantt([], NOW), null);
  assert.equal(fanoutGantt(null, NOW), null);
  assert.equal(fanoutGantt([{ state: 'todo' }], NOW), null);
});

test('one agent draws — a wall-clock axis is never invented', () => {
  const g = fanoutGantt([agent('a', 'running', 5)], NOW);
  assert.equal(g.lanes.length, 1);
  assert.equal(g.live, true);
  assert.equal(g.windowMs, min(5));
  const b = g.lanes[0][0];
  assert.equal(b.from, 0);
  assert.equal(b.to, 1);
  assert.equal(b.cls, 'is-live');
});

test('overlapping agents take separate lanes, disjoint agents share one', () => {
  const g = fanoutGantt([
    agent('a', 'done', 60, 40), agent('b', 'done', 55, 35), agent('c', 'done', 30, 10),
  ], NOW);
  assert.equal(g.lanes.length, 2);
  assert.equal(g.live, false);
  // First dispatch to last return, not to now: the batch is history.
  assert.equal(g.windowMs, min(50));
});

test('touching intervals share a lane', () => {
  const g = fanoutGantt([agent('a', 'done', 60, 40), agent('b', 'done', 40, 20)], NOW);
  assert.equal(g.lanes.length, 1);
});

test('stalled and failed agents are bars, frozen at their last movement', () => {
  // The strip this replaced omitted stalled agents entirely, because a duration
  // axis has no honest place for one. A wall clock does.
  const g = fanoutGantt([
    agent('a', 'done', 60, 50),
    { ...agent('z', 'stalled', 55), movedAt: iso(NOW - min(45)) },
    agent('f', 'failed', 30, 25),
  ], NOW);
  const flat = g.lanes.flat();
  assert.equal(flat.length, 3);
  assert.equal(g.live, false);
  assert.equal(flat.find((b) => b.label === 'z').cls, 'is-stalled');
  assert.equal(flat.find((b) => b.label === 'f').cls, 'is-failed');
  assert.equal(g.windowMs, min(35));
});

test('past the lane cap the oldest done bars drop, live bars never do', () => {
  const list = [
    ...Array.from({ length: 195 }, (_, i) => agent(`d${i}`, 'done', 300, 120 + (i % 30))),
    ...Array.from({ length: 5 }, (_, i) => agent(`r${i}`, 'running', 1 + i)),
  ];
  const g = fanoutGantt(list, NOW);
  assert.equal(g.lanes.length, 14);
  // 195 done bars, all concurrent, pack 195 lanes; the 5 live bars then ride
  // the first five of those lanes, since every done bar ended long before they
  // began. 195 − 181 = 14 lanes: the live five share with surviving done bars.
  assert.equal(g.hidden, 181);
  assert.equal(g.lanes.flat().filter((b) => b.live).length, 5);
  // The window was measured before anything dropped: 300m, not the surviving span.
  assert.equal(g.windowMs, min(300));
  for (const b of g.lanes.flat()) {
    assert.ok(b.from >= 0 && b.from <= 1);
    assert.ok(b.to >= b.from && b.to <= 1.0001);
  }
});

test('a stamp in the future is clamped and named, never warping the axis', () => {
  const g = fanoutGantt([
    agent('a', 'done', 60, 40),
    agent('b', 'done', 55, 35),
    // Started 10m from now: corrupt. Unclamped it would extend the axis an
    // hour past now and compress both good bars into the left half.
    { ...agent('x', 'done', -10), movedAt: iso(NOW - min(30)) },
  ], NOW);
  const x = g.lanes.flat().find((b) => b.label === 'x');
  assert.equal(x.fault, true);
  assert.equal(x.to, 1);
  assert.equal(g.windowMs, min(60));
});

test('a live agent stamped in the future draws as a right-edge dot, flagged', () => {
  const g = fanoutGantt([
    agent('a', 'done', 60, 30),
    { ...agent('y', 'running', -5), movedAt: iso(NOW) },
  ], NOW);
  const y = g.lanes.flat().find((b) => b.label === 'y');
  assert.equal(y.fault, true);
  assert.equal(y.cls, 'is-live');
  assert.equal(y.from, 1);
  assert.equal(y.to, 1);
});

test('an end before its start is a zero-width bar at its start, unflagged', () => {
  const g = fanoutGantt([
    agent('a', 'done', 60, 30),
    agent('z', 'done', 45, 50),
  ], NOW);
  const z = g.lanes.flat().find((b) => b.label === 'z');
  assert.equal(z.fault, false);
  assert.equal(z.ms, 0);
  assert.equal(z.from, z.to);
});

test('a blocked sub-agent takes the stalled bar', () => {
  const g = fanoutGantt([agent('a', 'done', 60, 30), agent('b', 'blocked', 20, 10)], NOW);
  assert.equal(g.lanes.flat().find((x) => x.label === 'b').cls, 'is-stalled');
});

test('a whole batch at one instant draws without inventing a window', () => {
  const g = fanoutGantt([
    agent('a', 'done', 10, 10), agent('b', 'done', 10, 10),
  ], NOW);
  assert.equal(g.windowMs, 0);
  for (const b of g.lanes.flat()) {
    assert.equal(b.from, 0);
    assert.equal(b.to, 0);
  }
});

// ── SINCE carries a figure, and SO FAR carries its tense ─────────────────────

test('a stalled session states how long it has been silent', () => {
  const s = { status: 'stalled', movedAt: iso(NOW - min(25)) };
  assert.match(sessionActivity(s, NOW), /^SILENT 25m/);
});

test('a day of silence still renders as a figure, not a saturation', () => {
  const s = { status: 'stalled', movedAt: iso(NOW - 24 * 3_600_000) };
  assert.match(sessionActivity(s, NOW), /^SILENT 24h/);
});

test('silence with no clock or no stamp degrades to the bare word', () => {
  assert.equal(sessionActivity({ status: 'stalled' }, NOW), 'SILENT');
  assert.equal(sessionActivity({ status: 'stalled', movedAt: iso(NOW - min(5)) }), 'SILENT');
});

test('the age of an ask is named, not a bare duration', () => {
  const r = run({ needsInput: [{ question: 'which key?', since: iso(NOW - min(47)) }] });
  assert.equal(askOf(r, NOW), 'which key? · waiting 47m');
});

// ── the signature covers what the row now renders ────────────────────────────

test('an observed agent returning moves the row signature at a fixed clock', () => {
  // The fan-out header, the strip and the goal floor all render from
  // session.agents; before this term a returned agent repainted only when an
  // unrelated minute bucket happened to tick.
  const before = run({ session: { pid: 1, agents: [agent('a', 'running', 10)] } });
  const after = run({ session: { pid: 1, agents: [agent('a', 'done', 10, 0)] } });
  assert.notEqual(rowSignature(before, NOW), rowSignature(after, NOW));
});

test('the signature survives a malformed observed fan-out', () => {
  const r = run({ session: { pid: 1, agents: [null, {}, { id: 'x', state: 'running' }] } });
  assert.doesNotThrow(() => rowSignature(r, NOW));
});

// A count is a claim about NOW; a run file is a claim about when it was written.
// `0 of 14 done` rendered as a plain fact beside a run whose file had not been
// touched for 158 minutes, while the agent behind it had finished five units.
// The operator reported it as a HUD bug; it was not, the board was reporting the
// file faithfully and saying nothing about the file's age where the age mattered.
test('a stale run says how old its count is', async () => {
  const { countAsOf, STALE_MS } = await import('../public/runs-view.js');
  const now = Date.parse('2026-08-11T23:38:00Z');
  const stale = { state: 'running', updated: '2026-08-11T21:00:00Z', wrote: '2026-08-11T21:00:00Z' };
  assert.match(countAsOf(stale, now), /^as of 2h38m ago$/);

  // Fresh says nothing. Every run is a few seconds out of date, and a qualifier
  // that always fires is one the reader stops seeing.
  const fresh = { state: 'running', updated: '2026-08-11T23:37:00Z', wrote: '2026-08-11T23:37:00Z' };
  assert.equal(countAsOf(fresh, now), '');

  // Just inside the threshold, still nothing.
  const edge = { state: 'running', wrote: new Date(now - STALE_MS + 1000).toISOString() };
  assert.equal(countAsOf(edge, now), '');
});

test('a finished run does not apologise for its age', async () => {
  const { countAsOf } = await import('../public/runs-view.js');
  const now = Date.parse('2026-08-11T23:38:00Z');
  // A done run's count is final. "as of 3 days ago" would be true and useless.
  assert.equal(countAsOf({ state: 'done', wrote: '2026-08-08T10:00:00Z' }, now), '');
});

// ── a workflow group states one span for all its members ─────────────────────

test('an all-returned group states its measured span, not a clock still counting', () => {
  // Earliest start to last return: 60m ago to 10m ago. The group branch used to
  // hardcode the running tense, so this read "+50m" and climbed forever.
  const d = groupDuration([agent('a', 'done', 60, 30), agent('b', 'done', 45, 10)], NOW);
  assert.equal(d.text, '50m');
  assert.equal(d.bad, false);
  assert.match(d.cls, /is-done/);
});

test('a mixed group counts up from the earliest start, returned members included', () => {
  // The returned member started longest ago. Reading only the members still out
  // would say +20m; the batch is as old as its oldest member.
  const d = groupDuration([agent('a', 'done', 45, 30), agent('b', 'running', 20)], NOW);
  assert.equal(d.text, '+45m');
  assert.match(d.cls, /is-running/);
});

test('a member with no start is skipped, not sorted first', () => {
  // The old code coalesced a missing stamp to '', and '' sorts before every
  // ISO date, which is how one member that never stamped a start used to
  // blank the whole group's figure.
  const d = groupDuration([
    agent('a', 'running', 10, null, { started: null }),
    agent('b', 'running', 30),
  ], NOW);
  assert.equal(d.text, '+30m');
});

test('a group with no parseable start says so the way a unit does', () => {
  const d = groupDuration([
    agent('a', 'running', 10, null, { started: null }),
    agent('b', 'running', 20, null, { started: null }),
  ], NOW);
  assert.equal(d.text, '—');
  assert.equal(d.bad, true);
  assert.match(d.cls, /is-running/);
});

test('a stalled group stops at its last movement instead of counting up', () => {
  // Earliest start 50m ago, most recent movement 15m ago.
  const d = groupDuration([agent('a', 'stalled', 50, 45), agent('b', 'stalled', 40, 15)], NOW);
  assert.equal(d.text, '35m');
  assert.equal(d.bad, false);
  assert.ok(!d.text.startsWith('+'), 'a group nothing is moving in must not claim to grow');
});

test('a group with no movement stamp has no span to state', () => {
  const d = groupDuration([agent('a', 'stalled', 50, 45, { movedAt: null })], NOW);
  assert.equal(d.text, '—');
  assert.equal(d.bad, true);
});

test('a group of one reads like its member', () => {
  assert.equal(groupDuration([agent('a', 'running', 12)], NOW).text, '+12m');
  assert.equal(groupDuration([agent('a', 'done', 60, 20)], NOW).text, '40m');
});

test('an open member forces the running tense', () => {
  // `open` is an agent that has not stamped a movement yet; it is live work,
  // so the group's clock keeps counting from the earliest start.
  const d = groupDuration([agent('a', 'done', 45, 20), agent('b', 'open', 30)], NOW);
  assert.equal(d.text, '+45m');
  assert.match(d.cls, /is-running/);
});
