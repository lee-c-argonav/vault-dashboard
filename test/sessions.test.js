// sessions.test.js — observing live sessions instead of waiting to be told.
//
// The gap this closes: four agent sessions were running on the machine and one
// appeared on the board, because appearing required writing a run file and
// writing one is opt-in. The other three were invisible, which reads as a broken
// instrument.
//
// Nothing here shells out. parsePs, parseLsof, describeCwd and linkSessions are
// pure, and readSessions takes its runner as a parameter, so the whole module is
// tested against captured output rather than against whatever is running.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, parseLsof, describeCwd, readSessions, resetSessions, CACHE_MS }
  from '../sessions.js';
import { linkSessions, sessionContext } from '../public/runs-view.js';

const PS = [
  '  501 ttys000  Sun Aug  9 15:33:40 2026     claude',
  '  502 ttys001  Mon Aug 10 13:29:48 2026     claude',
  '  503 ??       Mon Aug 10 12:39:34 2026     Claude',        // no tty: a desktop app helper
  '  504 ttys002  Thu Aug  6 09:27:22 2026     node',          // not an agent
  '  505 ttys003  Thu Aug  6 10:12:36 2026     /usr/local/bin/claude',
  '',
].join('\n');

test('parsePs keeps agent sessions that own a terminal', () => {
  const got = parsePs(PS);
  assert.deepEqual(got.map((p) => p.pid), [501, 502, 505]);
  assert.deepEqual(got.map((p) => p.tty), ['/dev/ttys000', '/dev/ttys001', '/dev/ttys003']);
});

test('parsePs drops a process with no controlling terminal', () => {
  assert.equal(parsePs(PS).some((p) => p.pid === 503), false);
});

test('parsePs drops anything that is not the agent binary', () => {
  assert.equal(parsePs(PS).some((p) => p.pid === 504), false);
});

test('parsePs reads an absolute command path as its basename', () => {
  assert.ok(parsePs(PS).some((p) => p.pid === 505));
});

test('parsePs reads the start time, which is what uptime is measured from', () => {
  const p = parsePs(PS).find((x) => x.pid === 502);
  assert.equal(new Date(p.since).getMinutes(), 29);
});

test('parsePs survives a truncated or empty table without throwing', () => {
  assert.deepEqual(parsePs(''), []);
  assert.deepEqual(parsePs('garbage\n123\n'), []);
  assert.deepEqual(parsePs('  501 ttys000  Sun Aug'), []);
});

test('parseLsof groups each cwd under its own pid', () => {
  const m = parseLsof('p501\nfcwd\nn/home/u/work/widget\np502\nfcwd\nn/home/u/vault\n');
  assert.equal(m.get(501), '/home/u/work/widget');
  assert.equal(m.get(502), '/home/u/vault');
});

test('parseLsof skips a process whose cwd could not be read', () => {
  // 502 emits no `n` line at all; 503 must not inherit 502's directory.
  const m = parseLsof('p501\nfcwd\nn/home/u/a\np502\np503\nfcwd\nn/home/u/c\n');
  assert.equal(m.get(501), '/home/u/a');
  assert.equal(m.has(502), false);
  assert.equal(m.get(503), '/home/u/c');
});

test('describeCwd reports a path inside home as relative to it', () => {
  assert.deepEqual(describeCwd('/home/u/work/widget', '/home/u'),
    { project: 'widget', where: 'work/widget' });
});

test('describeCwd never emits a path outside home', () => {
  // The phone page is served to an unauthenticated GET. A directory outside
  // $HOME may name a client or a mounted volume, so only the leaf survives.
  assert.deepEqual(describeCwd('/Volumes/acme/sprocket', '/home/u'),
    { project: 'sprocket', where: '' });
});

test('describeCwd handles an unreadable cwd', () => {
  assert.deepEqual(describeCwd('', '/home/u'), { project: '', where: '' });
});

test('readSessions makes exactly two child calls and caches the result', async () => {
  resetSessions();
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    return cmd === 'ps' ? PS : 'p501\nfcwd\nn/home/u/work/widget\n';
  };
  const a = await readSessions({ run, now: 1000 });
  assert.deepEqual(calls, ['ps', 'lsof'], 'one table read, one batched cwd read');
  const b = await readSessions({ run, now: 1000 + CACHE_MS - 1 });
  assert.deepEqual(calls, ['ps', 'lsof'], 'a cached sample must not respawn processes');
  assert.equal(a, b);
  await readSessions({ run, now: 1000 + CACHE_MS + 1 });
  assert.deepEqual(calls, ['ps', 'lsof', 'ps', 'lsof'], 'and must refresh once it is stale');
  resetSessions();
});

test('readSessions degrades to empty rather than throwing when the tools are gone', async () => {
  resetSessions();
  const run = async () => { throw new Error('command not found'); };
  await assert.doesNotReject(() => readSessions({ run, now: 5000 }).catch(() => { throw new Error('rejected'); }));
  resetSessions();
});

// ── matching sessions to runs ────────────────────────────────────────────────

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();
const run_ = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop', state: 'running',
  note: '', tty: '', started: iso(T0), updated: iso(T0),
  units: [], needsInput: [], blockers: [], ...over,
});
const sess = (over = {}) => ({
  pid: 501, tty: '/dev/ttys000', project: 'widget', where: 'work/widget',
  since: iso(T0 - 3_600_000), ...over,
});

test('a recorded tty claims its session outright', () => {
  const { unpublished } = linkSessions(
    [run_({ tty: '/dev/ttys000' })],
    [sess(), sess({ pid: 502, tty: '/dev/ttys001', project: 'sprocket' })],
  );
  assert.deepEqual(unpublished.map((s) => s.pid), [502]);
});

test('a run with no tty still claims the session sitting in its project', () => {
  const { unpublished } = linkSessions([run_({ tty: '' })], [sess()]);
  assert.deepEqual(unpublished, []);
});

test('a session that started after the run cannot be the one that wrote it', () => {
  const { unpublished } = linkSessions(
    [run_({ tty: '' })],
    [sess({ since: iso(T0 + 3_600_000) })],
  );
  assert.deepEqual(unpublished.map((s) => s.pid), [501],
    'a session younger than the run it would claim is a different session');
});

test('two sessions in one project, only one is claimed', () => {
  const { unpublished } = linkSessions(
    [run_({ tty: '' })],
    [sess({ pid: 501, since: iso(T0 - 3_600_000) }),
     sess({ pid: 502, tty: '/dev/ttys001', since: iso(T0 - 7_200_000) })],
  );
  assert.equal(unpublished.length, 1, 'one run cannot account for two sessions');
});

test('a finished run does not keep claiming a live session', () => {
  const { unpublished } = linkSessions([run_({ state: 'done', tty: '/dev/ttys000' })], [sess()]);
  assert.deepEqual(unpublished.map((s) => s.pid), [501],
    'the session outlived the run it published; it is now reporting nothing');
});

test('every session is unpublished when nothing is publishing', () => {
  const { unpublished } = linkSessions([], [sess(), sess({ pid: 502 })]);
  assert.equal(unpublished.length, 2);
});

test('runs are annotated with the session that owns them', () => {
  const { runs } = linkSessions([run_({ tty: '/dev/ttys000' })], [sess()]);
  assert.equal(runs[0].session.pid, 501);
});

// ── what a not-reporting session can still tell you ──────────────────────────
//
// From the operator, 2026-08-10: "this session says not reporting, but it's
// currently an active session. I worked on it five minutes ago."
//
// He was looking at the session that had just published a complete run and
// marked it done. Finishing the run released the session from `linkSessions`,
// which only lets a LIVE run claim one, so a session that had been fully
// described sixty seconds earlier dropped to a bare NO STATUS line. The run it
// published is right there and is the obvious thing to say.

const fin = (over = {}) => run_({ state: 'done', ...over });

test('a session that just finished a run says so, instead of nothing', () => {
  const s = sess({ tty: '/dev/ttys000' });
  const ctx = sessionContext(s, [fin({ runId: 'r1', goal: 'Fix the board', tty: '/dev/ttys000',
    updated: iso(T0) })], T0 + min(5));
  assert.match(ctx, /Fix the board/);
  assert.match(ctx, /5m/, 'how long ago is what makes it useful');
});

test('the most recent run wins when a session published several', () => {
  const s = sess({ tty: '/dev/ttys000' });
  const ctx = sessionContext(s, [
    fin({ runId: 'old', goal: 'The old one', tty: '/dev/ttys000', updated: iso(T0 - min(300)) }),
    fin({ runId: 'new', goal: 'The recent one', tty: '/dev/ttys000', updated: iso(T0 - min(5)) }),
  ], T0);
  assert.match(ctx, /The recent one/);
  assert.doesNotMatch(ctx, /The old one/);
});

test('a session matches its run by project when no tty was recorded', () => {
  const s = sess({ tty: '/dev/ttys009', project: 'widget', since: iso(T0 - min(600)) });
  const ctx = sessionContext(s, [fin({ goal: 'Widget work', tty: '', project: 'widget',
    updated: iso(T0) })], T0 + min(5));
  assert.match(ctx, /Widget work/);
});

test('a run from a different project is not claimed as context', () => {
  const s = sess({ tty: '/dev/ttys009', project: 'sprocket' });
  assert.equal(sessionContext(s, [fin({ goal: 'Widget work', tty: '', project: 'widget' })], T0), '');
});

test('a session that never published anything says nothing rather than guessing', () => {
  assert.equal(sessionContext(sess(), [], T0), '');
});

test('a run that predates the session is work from an earlier one', () => {
  const s = sess({ tty: '/dev/ttys009', project: 'widget', since: iso(T0) });
  const ctx = sessionContext(s, [fin({ goal: 'Older', tty: '', project: 'widget',
    updated: iso(T0 - min(600)), started: iso(T0 - min(700)) })], T0);
  assert.equal(ctx, '', 'the run finished before this session existed');
});

test('a recorded tty beats the project rule, even for an older run', () => {
  const s = sess({ tty: '/dev/ttys000', project: 'widget', since: iso(T0 - min(600)) });
  const ctx = sessionContext(s, [
    fin({ runId: 'byTty', goal: 'By terminal', tty: '/dev/ttys000', updated: iso(T0 - min(200)) }),
    fin({ runId: 'byProj', goal: 'By project', tty: '', project: 'widget', updated: iso(T0 - min(5)) }),
  ], T0);
  assert.match(ctx, /By terminal/);
});

test('a run already claimed by another session is not offered as this one’s context', () => {
  // Two sessions in one project, one run between them. linkSessions gives the
  // run to one of them; without this the other would be told it wrote it too,
  // which is a false attribution rather than missing information.
  const a = sess({ pid: 501, tty: '/dev/ttys000', project: 'widget', since: iso(T0 - min(600)) });
  const b = sess({ pid: 502, tty: '/dev/ttys001', project: 'widget', since: iso(T0 - min(500)) });
  const r = run_({ runId: 'only', goal: 'The one run', tty: '', project: 'widget', updated: iso(T0) });
  const linked = linkSessions([r], [a, b]);
  assert.equal(linked.unpublished.length, 1);
  const orphan = linked.unpublished[0];
  const owner = linked.runs[0].session;
  assert.notEqual(orphan.pid, owner.pid);
  assert.equal(sessionContext(orphan, linked.runs, T0), '',
    'the run belongs to the other session; this one has published nothing');
});

test('a finished run is still offered, since no live run can claim it', () => {
  const s = sess({ tty: '/dev/ttys000' });
  const done = run_({ state: 'done', goal: 'Finished work', tty: '/dev/ttys000', updated: iso(T0) });
  const linked = linkSessions([done], [s]);
  assert.match(sessionContext(linked.unpublished[0], linked.runs, T0 + min(3)), /Finished work/);
});
