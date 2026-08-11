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
  clockAt, finishClock, goalEta, goalEtaText, fanoutStrip, sessionActivity,
  askOf, rowSignature, agentEta,
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
const agent = (id, state, startedMin, movedMin = null) => ({
  id, label: id, agentType: 'x', depth: 1, parent: '', workflow: '',
  state, started: iso(NOW - min(startedMin)),
  movedAt: movedMin === null ? iso(NOW) : iso(NOW - min(movedMin)),
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

// ── the fan-out strip: progress and spread as marks on one axis ──────────────

test('a fan-out of one draws no strip — the axis would be invented', () => {
  assert.equal(fanoutStrip([agent('a', 'running', 5)], NOW), null);
  assert.equal(fanoutStrip([], NOW), null);
  assert.equal(fanoutStrip(null, NOW), null);
});

test('the axis is the slowest returned span and every tick sits inside it', () => {
  const s = fanoutStrip([
    agent('a', 'done', 60, 50), agent('b', 'done', 60, 35), agent('c', 'done', 60, 20),
    agent('d', 'running', 12),
  ], NOW);
  assert.equal(s.axis, min(40), 'agent b took 25m, c took 40m — the axis is 40m');
  for (const f of s.done) assert.ok(f > 0 && f <= 1);
  assert.equal(s.live.length, 1);
  assert.ok(Math.abs(s.live[0].frac - 12 / 40) < 1e-9);
  assert.equal(s.live[0].over, false);
});

test('a 200-agent fan-out stays bounded', () => {
  const list = [
    ...Array.from({ length: 150 }, (_, i) => agent(`d${i}`, 'done', 120, 120 - (5 + (i % 30)))),
    ...Array.from({ length: 50 }, (_, i) => agent(`r${i}`, 'running', 1 + (i % 20))),
  ];
  const s = fanoutStrip(list, NOW);
  assert.equal(s.done.length, 150);
  assert.equal(s.live.length, 50);
  for (const f of s.done) assert.ok(f >= 0 && f <= 1);
  for (const l of s.live) assert.ok(l.frac >= 0 && l.frac <= 1);
});

test('an agent past every sample clamps at the end and says so', () => {
  const s = fanoutStrip([
    agent('a', 'done', 60, 50), agent('b', 'done', 60, 49), agent('c', 'done', 60, 48),
    agent('d', 'running', 55),
  ], NOW);
  assert.equal(s.live[0].frac, 1);
  assert.equal(s.live[0].over, true);
});

test('stalled agents appear nowhere on the strip', () => {
  // Plotting one as live claims motion, as returned claims a measurement.
  const s = fanoutStrip([
    agent('a', 'done', 60, 50), agent('b', 'done', 60, 45), agent('c', 'done', 60, 40),
    { ...agent('z', 'stalled', 90), movedAt: iso(NOW - min(80)) },
  ], NOW);
  assert.equal(s.done.length, 3);
  assert.equal(s.live.length, 0);
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
