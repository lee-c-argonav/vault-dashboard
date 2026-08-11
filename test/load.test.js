// load.test.js — the LOAD gauge measures attention, and its arithmetic is checkable.
//
// The gauge it replaced was one tick per open todo, 78 of them on this machine.
// That measured a queue: it did not move when five agents started working, did
// not move when a run stopped and waited for an answer, and could not tell a
// quiet day with a long backlog from a saturated one.
//
// A weighted sum is a judgment, so the weights are exported and these tests pin
// the properties that make the judgment defensible — the ordering of the terms,
// the sublinear fan-out, the clamp, and the absence of any todo input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModel, loadCaption, LOAD_WEIGHTS, LOAD_CAPACITY } from '../public/runs-view.js';

const session = (over = {}) => ({ status: 'working', project: 'p', agents: [], ...over });
const run = (over = {}) => ({
  runId: 'r', project: 'p', goal: 'g', state: 'running', units: [],
  needsInput: [], blockers: [], session: null, ...over,
});
const agents = (n, state = 'running') => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, state }));

test('an empty board is zero load and says so', () => {
  const m = loadModel({ runs: [], sessions: [] });
  assert.equal(m.score, 0);
  assert.equal(m.pct, 0);
  assert.deepEqual(m.terms, []);
  assert.equal(loadCaption(m), '');
});

test('the todo system contributes nothing', () => {
  // Overdue and due-today were terms in the first version and came out: the todo
  // system is not in use, so counting it manufactured load nobody was carrying.
  const withTodos = loadModel({
    runs: [], sessions: [],
    stats: { open: 78, stale: 18, overdue: 6, dueToday: 4, doneToday: 0 },
  });
  assert.equal(withTodos.score, 0, 'a todo count moved the gauge');
  assert.equal(withTodos.terms.length, 0);
});

test('a run waiting on the operator outweighs everything else one for one', () => {
  const ask = loadModel({ runs: [run({ needsInput: [{ question: 'which?' }] })], sessions: [] });
  const work = loadModel({ runs: [], sessions: [session()] });
  assert.ok(ask.score > work.score);
  assert.equal(ask.terms[0].key, 'needsYou');
  // The ordering is the defensible part of the weighting, so it is asserted.
  assert.ok(LOAD_WEIGHTS.needsYou > LOAD_WEIGHTS.blocked);
  assert.ok(LOAD_WEIGHTS.blocked >= LOAD_WEIGHTS.stalled);
  assert.ok(LOAD_WEIGHTS.stalled > LOAD_WEIGHTS.context);
  assert.ok(LOAD_WEIGHTS.context > LOAD_WEIGHTS.session);
});

test('fan-out is sublinear, because supervision is', () => {
  const one = loadModel({ runs: [], sessions: [session({ agents: agents(1) })] });
  const many = loadModel({ runs: [], sessions: [session({ agents: agents(36) })] });
  const fan = (m) => m.terms.find((t) => t.key === 'fanout').points;
  assert.equal(fan(one), LOAD_WEIGHTS.fanout);
  assert.equal(fan(many), LOAD_WEIGHTS.fanout * 6, '36 agents is six units, not thirty-six');
  // Without the root a single fan-out drowns every other term on the board.
  assert.ok(fan(many) < 36 * LOAD_WEIGHTS.fanout);
});

test('a returned sub-agent is not load', () => {
  const out = loadModel({ runs: [], sessions: [session({ agents: agents(4, 'running') })] });
  const back = loadModel({ runs: [], sessions: [session({ agents: agents(4, 'done') })] });
  assert.ok(out.score > back.score);
  assert.equal(back.terms.find((t) => t.key === 'fanout'), undefined);
});

test('the same work spread over more projects is heavier', () => {
  const oneRepo = loadModel({ runs: [], sessions: [session({ project: 'a' }), session({ project: 'a' })] });
  const twoRepos = loadModel({ runs: [], sessions: [session({ project: 'a' }), session({ project: 'b' })] });
  assert.ok(twoRepos.score > oneRepo.score, 'context switching is not free');
});

test('a session attached to a run still counts as a live thread', () => {
  const m = loadModel({ runs: [run({ session: session({ agents: agents(4) }) })], sessions: [] });
  assert.equal(m.terms.find((t) => t.key === 'session').count, 1);
  assert.equal(m.terms.find((t) => t.key === 'fanout').count, 4);
});

test('an idle session is not load', () => {
  const m = loadModel({ runs: [], sessions: [session({ status: 'idle' })] });
  assert.equal(m.score, 0);
});

test('the gauge pegs rather than growing without bound', () => {
  const m = loadModel({
    runs: [run({ needsInput: Array.from({ length: 20 }, () => ({ question: 'q' })) })],
    sessions: [],
  });
  assert.equal(m.pct, 100);
  assert.ok(m.over);
  assert.ok(m.score > LOAD_CAPACITY);
});

test('terms are ordered heaviest first, so the caption names what to look at', () => {
  const m = loadModel({
    runs: [run({ needsInput: [{ question: 'q' }] })],
    sessions: [session({ project: 'a', agents: agents(1) }), session({ project: 'b' })],
  });
  const points = m.terms.map((t) => t.points);
  assert.deepEqual(points, [...points].sort((a, b) => b - a));
  assert.match(loadCaption(m), /^1 NEEDS YOU/);
});

test('every term reports the arithmetic that produced it', () => {
  const m = loadModel({ runs: [], sessions: [session({ project: 'a' }), session({ project: 'b' })] });
  for (const t of m.terms) {
    assert.ok(t.label && t.count > 0 && t.weight > 0, `${t.key} is not self-describing`);
    if (t.key !== 'fanout') assert.equal(t.points, t.count * t.weight);
  }
});

test('a malformed board does not throw', () => {
  for (const bad of [{}, { runs: null, sessions: null }, { runs: [{}], sessions: [{}] }]) {
    assert.doesNotThrow(() => loadModel(bad), JSON.stringify(bad));
  }
});
