// load.test.js — the ATTN census. The file keeps its name because it covers the
// same instrument slot the LOAD gauge occupied; the instrument in it changed.
//
// Two gauges preceded this model and these tests keep both replacements
// settled. The first was one tick per open todo — 78 of them — a queue nobody
// worked from; todos stay out in any form. The second was a weighted sum
// against an unmeasured capacity of 8: on the live board of 2026-08-11 it read
// 70 for three sessions all working with nothing waiting, and 100 for the same
// three sessions all stalled. The healthiest and the worst board both pushed
// the number up, so the sum died. What these tests pin instead is the property
// that replaced it: DEMAND (stopped on a human) and FLIGHT (moving on its own)
// are separate populations and are never added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionModel, attentionCaption, DEMAND_KINDS } from '../public/runs-view.js';

const session = (over = {}) => ({ status: 'running', project: 'p', agents: [], ...over });
const run = (over = {}) => ({
  runId: 'r', project: 'p', goal: 'g', state: 'running', units: [],
  needsInput: [], blockers: [], session: null, ...over,
});
const agents = (n, state = 'running') => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, state }));

test('an empty board is zero demand, zero flight, and says nothing', () => {
  const m = attentionModel({ runs: [], sessions: [] });
  assert.equal(m.demandCount, 0);
  assert.deepEqual(m.demand, []);
  assert.equal(m.flight.sessions, 0);
  assert.equal(m.flight.agentsOut, 0);
  assert.equal(attentionCaption(m), '');
});

test('the todo system contributes nothing', () => {
  // Overdue and due-today were terms in the first gauge and came out: the todo
  // system is not in use, so counting it manufactured load nobody was carrying.
  const withTodos = attentionModel({
    runs: [], sessions: [],
    stats: { open: 78, stale: 18, overdue: 6, dueToday: 4, doneToday: 0 },
  });
  assert.equal(withTodos.demandCount, 0, 'a todo count moved the census');
  assert.equal(withTodos.flight.sessions, 0);
});

test('three working and three stalled sessions are opposite boards, and read as opposites', () => {
  // The regression the old sum could not survive: both boards scored high
  // (70 and 100 on the live data of 2026-08-11), differing only in caption.
  // Working sessions are flight; stalled ones are demand; neither leaks into
  // the other's count.
  const spread = ['a', 'b', 'c'];
  const working = attentionModel({ runs: [], sessions: spread.map((p) => session({ project: p })) });
  const stalled = attentionModel({
    runs: [], sessions: spread.map((p) => session({ project: p, status: 'stalled' })),
  });
  assert.equal(working.demandCount, 0);
  assert.equal(working.flight.sessions, 3);
  assert.equal(stalled.demandCount, 3);
  assert.equal(stalled.flight.sessions, 0);
  assert.match(attentionCaption(working), /^3 SESSIONS/);
  assert.match(attentionCaption(stalled), /^3 STALLED/);
  // A stalled session still occupies its repo, so it holds a context.
  assert.equal(stalled.flight.contexts, 3);
});

test('demand orders by severity rank, never by count', () => {
  // The ordering was always the defensible part of the old weights: needsYou
  // means only you can restart the work, blocked may not be yours to clear,
  // stalled needs a look first. Five stalled sessions must not outrank one
  // question waiting on the operator.
  assert.deepEqual(DEMAND_KINDS.map(([k]) => k), ['needsYou', 'blocked', 'stalled']);
  const m = attentionModel({
    runs: [run({ needsInput: [{ question: 'which?' }] })],
    sessions: ['a', 'b', 'c', 'd', 'e'].map((p) => session({ project: p, status: 'stalled' })),
  });
  assert.equal(m.demand[0].key, 'needsYou');
  assert.match(attentionCaption(m), /^1 NEEDS YOU · 5 STALLED/);
});

test('needsInput counts questions, not runs', () => {
  // One run asking three questions is three things to answer.
  const m = attentionModel({
    runs: [run({ needsInput: [{ question: 'a' }, { question: 'b' }, { question: 'c' }] })],
    sessions: [],
  });
  assert.equal(m.demandCount, 3);
  assert.equal(m.demand[0].count, 3);
});

test('the caption leads with what to act on, then what is merely running', () => {
  const m = attentionModel({
    runs: [run({ needsInput: [{ question: 'q' }] })],
    sessions: [session({ project: 'a', agents: agents(1) }), session({ project: 'b' })],
  });
  assert.match(attentionCaption(m),
    /^1 NEEDS YOU · 2 SESSIONS · 2 CONTEXTS · 1 AGENT RUNNING$/);
});

test('a session attached to a run still counts as a live thread', () => {
  const m = attentionModel({ runs: [run({ session: session({ agents: agents(4) }) })], sessions: [] });
  assert.equal(m.flight.sessions, 1);
  assert.equal(m.flight.agentsOut, 4);
});

test('agents running is the raw count, in either shape the surfaces hold', () => {
  // The sqrt died with the sum: it existed so one 44-agent fan-out could not
  // drown the other terms, and with no sum there is nothing to drown. 44 out
  // is reported as 44.
  const desktop = attentionModel({ runs: [], sessions: [session({ agents: agents(44) })] });
  assert.equal(desktop.flight.agentsOut, 44);
  // The phone hands the projection, which strips the agents array (labels are
  // private) and keeps counts. The model must read that shape too, or the
  // published census would zero every fan-out.
  const phone = attentionModel({
    runs: [], sessions: [{ status: 'running', agentsOut: 5, agentsTotal: 9 }],
  });
  assert.equal(phone.flight.agentsOut, 5);
});

test('a returned sub-agent is not in flight', () => {
  const m = attentionModel({ runs: [], sessions: [session({ agents: agents(4, 'done') })] });
  assert.equal(m.flight.agentsOut, 0);
  assert.doesNotMatch(attentionCaption(m), /AGENT/);
});

test('an idle session is neither demand nor flight', () => {
  const m = attentionModel({ runs: [], sessions: [session({ status: 'idle' })] });
  assert.equal(m.demandCount, 0);
  assert.equal(m.flight.sessions, 0);
  assert.equal(attentionCaption(m), '');
});

test('contexts are stated only where every busy session names its project', () => {
  // The projection strips `project` — a relative path is still a path — so on
  // the phone the context count is a floor, not a fact, and the caption must
  // refuse to publish "1 CONTEXT" about any actual spread.
  const desktop = attentionModel({
    runs: [], sessions: [session({ project: 'a' }), session({ project: 'a' })],
  });
  assert.equal(desktop.flight.contexts, 1, 'two sessions in one repo are one context');
  assert.match(attentionCaption(desktop), /1 CONTEXT\b/);
  const phone = attentionModel({
    runs: [], sessions: [{ status: 'running', agentsOut: 0, agentsTotal: 0 }],
  });
  assert.equal(phone.flight.contextsExact, false);
  assert.doesNotMatch(attentionCaption(phone), /CONTEXT/);
});

test('the caption pluralises honestly', () => {
  // The old caption printed "1 AGENTS OUT" on the live board — wrong plural
  // and jargon in four words.
  const one = attentionModel({ runs: [], sessions: [session({ agents: agents(1) })] });
  assert.match(attentionCaption(one), /1 SESSION · 1 CONTEXT · 1 AGENT RUNNING$/);
  const two = attentionModel({
    runs: [], sessions: [session({ agents: agents(2) }), session({ project: 'b' })],
  });
  assert.match(attentionCaption(two), /2 SESSIONS · 2 CONTEXTS · 2 AGENTS RUNNING$/);
});

test('every demand term is self-describing', () => {
  const m = attentionModel({
    runs: [run({ needsInput: [{ question: 'q' }] })],
    sessions: [session({ status: 'stalled' })],
  });
  for (const t of m.demand) {
    assert.ok(t.label && t.count > 0 && t.cls, `${t.key} is not self-describing`);
  }
});

test('the census carries no scalar and no clock', () => {
  // The scalar is what was removed; a future term must arrive as a count with
  // a kind, not as arithmetic against a denominator nobody measured. And with
  // no time input, the same board always renders the same census — nothing
  // here can freeze stale between pushes.
  const m = attentionModel({ runs: [run()], sessions: [session()] });
  for (const dead of ['score', 'pct', 'capacity', 'over']) {
    assert.ok(!(dead in m), `${dead} crept back into the model`);
  }
  assert.equal(attentionModel.length, 1, 'the model takes state and nothing else');
});

test('a malformed board does not throw', () => {
  for (const bad of [{}, null, undefined, { runs: null, sessions: null }, { runs: [{}], sessions: [{}] }]) {
    assert.doesNotThrow(() => attentionModel(bad), JSON.stringify(bad) ?? 'undefined');
  }
});
