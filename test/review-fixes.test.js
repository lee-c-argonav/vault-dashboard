// review-fixes.test.js — defects found reviewing the 2026-08-10 changes.
//
// Each of these was a way the board could state something false while every
// other test passed. Grouped here rather than scattered so the reasoning stays
// next to the case that motivated it.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard, boardDigest } from '../status-page/build.js';
import { partitionRuns, linkSessions, sessionContext, STALE_MS } from '../public/runs-view.js';
import { readFinishedRunsDetailed } from '../runs.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', started: iso(T0),
  updated: iso(T0), tty: '', units: [], needsInput: [], blockers: [], ...over,
});
/**
 * Liveness is read from file mtime, not from the `updated` stamp, so a fixture
 * that wants a run to LOOK silent has to age the file rather than only the
 * field. See test/liveness.test.js for why the reader works this way.
 */
async function ageRun(root, name, at) {
  const when = new Date(at);
  await utimes(join(root, '15-Runs', name), when, when);
}

async function vaultWith(live = {}, archived = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-rev-'));
  await mkdir(join(root, '15-Runs'));
  for (const [n, b] of Object.entries(live)) await writeFile(join(root, '15-Runs', n), b);
  if (Object.keys(archived).length) {
    await mkdir(join(root, '99-Archive', 'runs'), { recursive: true });
    for (const [n, b] of Object.entries(archived)) {
      await writeFile(join(root, '99-Archive', 'runs', n), b);
    }
  }
  return root;
}

// ── 1. the skip check must be able to see a run go quiet ─────────────────────

test('a run falling silent moves the digest, or the phone never reaches QUIET', async () => {
  // boardDigest deliberately hashes no clock-derived value, and QUIET is derived
  // from the clock. Taken literally that froze the phone page: a run that simply
  // stopped writing produced an identical digest forever, so no deploy ever
  // fired and the page kept rendering the run as healthy. Surfacing a stalled
  // run is the single thing this instrument exists for.
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({ updated: iso(T0) })) });
  await ageRun(root, 'widget-1.json', T0);
  const fresh = boardDigest(await readBoard(root, [], T0 + min(1)), T0 + min(1));
  const stale = boardDigest(await readBoard(root, [], T0 + STALE_MS + min(1)), T0 + STALE_MS + min(1));
  assert.notEqual(fresh, stale);
  await rm(root, { recursive: true, force: true });
});

test('but ordinary ticking does not, so the timer is not a deploy loop', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({ updated: iso(T0) })) });
  await ageRun(root, 'widget-1.json', T0);
  const a = boardDigest(await readBoard(root, [], T0 + min(1)), T0 + min(1));
  const b = boardDigest(await readBoard(root, [], T0 + min(4)), T0 + min(4));
  assert.equal(a, b, 'three minutes inside the fresh band is not a change');
  await rm(root, { recursive: true, force: true });
});

test('a long-quiet run redeploys on a coarse bucket, not every minute', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({ updated: iso(T0) })) });
  await ageRun(root, 'widget-1.json', T0);
  const h2 = boardDigest(await readBoard(root, [], T0 + min(120)), T0 + min(120));
  const h2b = boardDigest(await readBoard(root, [], T0 + min(125)), T0 + min(125));
  const h3 = boardDigest(await readBoard(root, [], T0 + min(150)), T0 + min(150));
  assert.equal(h2, h2b, 'five minutes later inside the same bucket is not a redeploy');
  assert.notEqual(h2, h3, 'but the counter must not sit frozen for hours either');
  await rm(root, { recursive: true, force: true });
});

test('an unreadable run file reaches the digest, so the warning can reach the page', async () => {
  const clean = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const dirty = await vaultWith({
    'widget-1.json': JSON.stringify(base()), 'broken.json': '{ not json',
  });
  assert.notEqual(
    boardDigest(await readBoard(clean, [], T0), T0),
    boardDigest(await readBoard(dirty, [], T0), T0),
  );
  await rm(clean, { recursive: true, force: true });
  await rm(dirty, { recursive: true, force: true });
});

// ── 4. a session that archived its run still has context ─────────────────────

test('context survives the archive move, which is when it is most wanted', async () => {
  const root = await vaultWith({}, {
    'widget-9.json': JSON.stringify(base({ runId: 'widget-9', state: 'done',
      goal: 'The archived work', tty: '/dev/ttys000', updated: iso(T0) })),
  });
  const board = await readBoard(root, [{ pid: 501, tty: '/dev/ttys000', project: 'widget',
    where: 'w', since: iso(T0 - min(60)) }], T0 + min(5));
  assert.match(board.unpublished[0].context, /The archived work/,
    'moving the file to the archive is step 9 of /close, not a reason to forget');
  await rm(root, { recursive: true, force: true });
});

// ── 5. one rule for who owns a run ───────────────────────────────────────────

test('a session younger than a run is never credited with it', () => {
  // linkSessions refuses the pairing on `session.since <= run.started`, so the
  // run keeps `session: null` — and sessionContext's guard is exactly that null,
  // so a mismatched second rule let the credit through the back door.
  const run = { ...base({ runId: 'old', goal: 'Older work', tty: '', project: 'widget',
    started: iso(T0 - min(600)), updated: iso(T0) }) };
  const session = { pid: 501, tty: '/dev/ttys009', project: 'widget',
    where: 'w', since: iso(T0 - min(60)) };
  const linked = linkSessions([run], [session]);
  assert.equal(linked.runs[0].session, null, 'linkSessions refuses it');
  assert.equal(sessionContext(linked.unpublished[0], linked.runs, T0), '',
    'and so must the context, on the same rule');
});

// ── 7. a run cannot be live and finished at once ─────────────────────────────

test('a run left in 15-Runs after being archived shows once, not twice', () => {
  const live = base({ runId: 'dup', state: 'running' });
  const archived = base({ runId: 'dup', state: 'done' });
  const { active, finished } = partitionRuns([live], [archived], T0);
  assert.deepEqual(active.map((r) => r.runId), [],
    'the archive is the later word; a stale copy left behind is not a live run');
  assert.deepEqual(finished.map((r) => r.runId), ['dup']);
});

// ── 8. an unreadable archive is not an empty history ─────────────────────────

test('readFinishedRunsDetailed distinguishes absent from unreadable', async () => {
  const none = await mkdtemp(join(tmpdir(), 'vhud-rev-'));
  const d1 = await readFinishedRunsDetailed(none);
  assert.deepEqual(d1.runs, []);
  assert.equal(d1.unreadable, true, 'nothing there to read');

  const some = await vaultWith({}, { 'widget-9.json': JSON.stringify(base({ runId: 'w9' })) });
  const d2 = await readFinishedRunsDetailed(some);
  assert.equal(d2.runs.length, 1);
  assert.equal(d2.unreadable, false);
  await rm(none, { recursive: true, force: true });
  await rm(some, { recursive: true, force: true });
});
