// robustness.test.js — hostile and degenerate input against every reader.
//
// Run files are written by agents under time pressure, mid-save, on two
// machines, and occasionally by a session whose clock is wrong. The readers must
// cost that row and never the parse. These exist to find the cases nobody
// thought to write a fixture for.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuns, readRunsDetailed } from '../runs.js';
import {
  runState, stateText, askOf, eta, durationOf, unitWindow, counts, partitionRuns,
  linkSessions, sessionContext, sessionText, blockedNote, sortRank, batchStamped,
  rowSignature, quietMs, stampLagMs, elapsedText, expandSet,
} from '../public/runs-view.js';
import { parsePs, parseLsof, describeCwd } from '../sessions.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const iso = (t) => new Date(t).toISOString();

async function vaultWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-rob-'));
  await mkdir(join(root, '15-Runs'));
  for (const [n, b] of Object.entries(files)) await writeFile(join(root, '15-Runs', n), b);
  return root;
}

/** Every derivation both surfaces call, over one run. None may throw. */
function renderEverything(run, now, session = null) {
  const out = [];
  out.push(runState(run), stateText(run, now, session), askOf(run, now));
  out.push(blockedNote(run), sortRank(run), JSON.stringify(eta(run.units)));
  out.push(JSON.stringify(counts(run.units)), elapsedText(run, now));
  out.push(quietMs(run, now), stampLagMs(run), rowSignature(run, now));
  const batched = batchStamped(run.units);
  const w = unitWindow(run.units);
  for (const u of [...w.visible, ...w.tail]) {
    out.push(JSON.stringify(durationOf(u, now, batched)));
    for (const a of u.agents) out.push(JSON.stringify(durationOf(a, now, null)));
  }
  out.push(JSON.stringify(partitionRuns([run], [], now)));
  return out;
}

// Control characters are built from escapes, never typed literally: a literal
// NUL in a source file makes it "binary" to grep and every other line-based
// tool while still parsing, which cost real time on 2026-08-10 and is what
// test/sources.test.js now guards against.
const NUL = '\u0000';
const RTL_OVERRIDE = '\u202E';

const HOSTILE = {
  'empty.json': '',
  'null.json': 'null',
  'array.json': '[1,2,3]',
  'string.json': '"just a string"',
  'number.json': '42',
  'truncated.json': '{"runId":"widget-t","units":[{"id":"1"',
  'bom.json': '﻿' + JSON.stringify({ runId: 'widget-bom', units: [] }),
  'wrongtypes.json': JSON.stringify({
    runId: 'widget-wt', project: 42, goal: [], machine: {}, state: 'invented',
    note: null, tty: 7, started: {}, updated: [], units: 'not an array',
    needsInput: 'nope', blockers: 5,
  }),
  'nullunits.json': JSON.stringify({ runId: 'widget-nu', units: [null, 3, 'x', {}, { id: '' }] }),
  'nullagents.json': JSON.stringify({
    runId: 'widget-na',
    units: [{ id: '1', agents: [null, 'x', {}, { label: '' }, { label: 'ok' }] }],
  }),
  'unicode.json': JSON.stringify({
    runId: 'widget-uni',
    goal: 'fire <script>alert(1)</script> & "quotes" ' + NUL + ' embedded',
    note: 'accented ' + RTL_OVERRIDE + ' direction override',
    units: [],
  }),
  'huge-id.json': JSON.stringify({ runId: 'w'.repeat(5000), units: [] }),
  'negative.json': JSON.stringify({
    runId: 'widget-neg',
    units: [{ id: '1', state: 'done', started: iso(T0), ended: iso(T0 - 60_000) }],
  }),
  'future.json': JSON.stringify({
    runId: 'widget-fut', started: iso(T0 + 86_400_000), updated: iso(T0 + 86_400_000),
    units: [{ id: '1', state: 'running', started: iso(T0 + 86_400_000) }],
  }),
  'dupeid-a.json': JSON.stringify({ runId: 'widget-dupe', updated: iso(T0), units: [] }),
  'dupeid-b.json': JSON.stringify({ runId: 'widget-dupe', updated: iso(T0 + 1000), units: [] }),
};

test('every hostile run file is survived, and the usable ones still come through', async () => {
  const root = await vaultWith(HOSTILE);
  const d = await readRunsDetailed(root);
  assert.ok(d.runs.length > 0, 'the usable files must still parse');
  assert.ok(d.skipped > 0, 'and the unusable ones must be counted, not hidden');
  assert.equal(d.unreadable, false);
  // No field may reach a renderer as the wrong type. That contract is the whole
  // reason runs.js whitelists rather than spreading the parsed object through.
  for (const r of d.runs) {
    for (const k of ['runId', 'project', 'goal', 'machine', 'note', 'tty']) {
      assert.equal(typeof r[k], 'string', `${r.runId}.${k}`);
    }
    assert.ok(['running', 'paused', 'done'].includes(r.state));
    assert.ok(Array.isArray(r.units) && Array.isArray(r.needsInput) && Array.isArray(r.blockers));
    for (const u of r.units) {
      assert.equal(typeof u.id, 'string');
      assert.ok(u.id.length > 0, 'a unit with no id would draw a tick for nothing');
      assert.ok(Array.isArray(u.agents));
      for (const a of u.agents) assert.ok(typeof a.label === 'string' && a.label);
    }
  }
  await rm(root, { recursive: true, force: true });
});

test('every derivation survives every hostile run, at several clocks', async () => {
  const root = await vaultWith(HOSTILE);
  const runs = await readRuns(root);
  const session = { pid: 1, tty: '/dev/ttys000', project: 'widget', where: 'w', since: iso(T0) };
  for (const r of runs) {
    for (const now of [0, T0, T0 + 86_400_000 * 400, Date.now()]) {
      assert.doesNotThrow(() => renderEverything(r, now, null), `${r.runId} at ${now}`);
      assert.doesNotThrow(() => renderEverything(r, now, session), `${r.runId} at ${now} + session`);
    }
  }
  await rm(root, { recursive: true, force: true });
});

test('two files claiming one runId collapse to the later writer', async () => {
  const root = await vaultWith(HOSTILE);
  const runs = await readRuns(root);
  assert.equal(runs.filter((r) => r.runId === 'widget-dupe').length, 1);
  await rm(root, { recursive: true, force: true });
});

test('a control character in vault text breaks no derivation', async () => {
  const root = await vaultWith(HOSTILE);
  const uni = (await readRuns(root)).find((r) => r.runId === 'widget-uni');
  assert.ok(uni.goal.includes(NUL), 'carried verbatim; the reader does not rewrite vault content');
  assert.doesNotThrow(() => renderEverything(uni, Date.now()));
  await rm(root, { recursive: true, force: true });
});

// ── degenerate shapes handed straight to the view layer ──────────────────────

const EMPTY_RUN = {
  runId: '', project: '', goal: '', machine: '', state: 'running', note: '', tty: '',
  started: null, updated: null, wrote: null, units: [], needsInput: [], blockers: [],
};

test('a run with every field empty renders without throwing', () => {
  assert.doesNotThrow(() => renderEverything(EMPTY_RUN, Date.now()));
  assert.equal(counts(EMPTY_RUN.units).total, 0);
  assert.equal(eta(EMPTY_RUN.units), null);
});

test('unitWindow is safe on zero units and on one', () => {
  for (const units of [[], [{ id: '1', label: 'x', state: 'todo', agents: [] }]]) {
    const w = unitWindow(units);
    assert.ok(Array.isArray(w.visible) && Array.isArray(w.tail));
    assert.ok(w.earlier >= 0 && w.gap >= 0);
  }
});

test('unitWindow never drops or duplicates a unit across the fold', () => {
  for (const n of [1, 4, 5, 6, 7, 30, 200]) {
    const units = Array.from({ length: n }, (_, i) =>
      ({ id: String(i), label: `u${i}`, state: i === n - 3 ? 'running' : 'done', agents: [] }));
    const w = unitWindow(units);
    const shown = [...w.visible, ...w.tail].map((u) => u.id);
    assert.equal(new Set(shown).size, shown.length, `duplicate unit at n=${n}`);
    assert.equal(w.earlier + w.visible.length + w.gap + w.tail.length, n,
      `the hidden counts must account for every unit at n=${n}`);
  }
});

test('expandSet is stable and never exceeds the limit', () => {
  const runs = Array.from({ length: 40 }, (_, i) =>
    ({ ...EMPTY_RUN, runId: `r${i}`, state: i % 3 === 0 ? 'done' : 'running' }));
  const a = expandSet(runs);
  assert.equal(a.size <= 5, true);
  assert.deepEqual([...a], [...expandSet(runs)], 'same input, same expansion');
});

// ── session inputs ───────────────────────────────────────────────────────────

test('the process-table parsers survive garbage', () => {
  for (const junk of ['', '\n\n\n', 'not a table', '  ', 'a b c d e f g h',
    '999999999999999999 ttys000 X X X X X claude']) {
    assert.doesNotThrow(() => parsePs(junk));
    assert.ok(Array.isArray(parsePs(junk)));
  }
  for (const junk of ['', 'p', 'n', 'pX\nfcwd\nn/x', ' ']) {
    assert.doesNotThrow(() => parseLsof(junk));
  }
});

test('parsePs rejects a non-positive pid', () => {
  assert.equal(parsePs('-1 ttys000  Mon Aug 10 13:29:48 2026     claude').length, 0);
  assert.equal(parsePs('0 ttys000  Mon Aug 10 13:29:48 2026     claude').length, 0);
});

test('describeCwd never returns a path outside home, for any input', () => {
  for (const cwd of ['/', '/Volumes/x/y', '/etc', '/home/u/../../root',
    '/home/u', '/home/u/a/b', '']) {
    const { where, project } = describeCwd(cwd, '/home/u');
    assert.equal(where.startsWith('/'), false, `absolute path leaked for ${cwd}`);
    assert.equal(where.includes('..'), false, `traversal leaked for ${cwd}`);
    assert.equal(typeof project, 'string');
  }
});

test('sessionText and sessionContext survive a malformed session', () => {
  const bad = [
    { pid: 0, tty: '', project: '', where: '', since: null },
    { pid: NaN, tty: null, project: undefined, where: undefined, since: 'not a date' },
    {},
  ];
  for (const s of bad) {
    assert.doesNotThrow(() => sessionText(s, Date.now()));
    assert.doesNotThrow(() => sessionContext(s, [EMPTY_RUN], Date.now()));
  }
});

test('linkSessions is safe with empty arrays either side', () => {
  assert.doesNotThrow(() => linkSessions([], []));
  assert.deepEqual(linkSessions([], []).unpublished, []);
  assert.deepEqual(linkSessions([EMPTY_RUN], []).unpublished, []);
});

test('one session is never claimed by two runs', () => {
  const s = { pid: 1, tty: '/dev/ttys000', project: 'widget', where: 'w', since: iso(T0 - 1000) };
  const a = { ...EMPTY_RUN, runId: 'a', tty: '/dev/ttys000', project: 'widget', started: iso(T0) };
  const b = { ...EMPTY_RUN, runId: 'b', tty: '/dev/ttys000', project: 'widget', started: iso(T0) };
  const { runs } = linkSessions([a, b], [s]);
  assert.equal(runs.filter((r) => r.session).length, 1);
});
