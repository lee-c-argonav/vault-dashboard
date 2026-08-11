// digest.test.js — the check that decides whether an upload is worth doing.
//
// The publisher runs every five minutes. Uploading unconditionally is 288
// deploys a day, nearly all of them repeating the last, so it hashes the board
// and skips when nothing moved.
//
// The first attempt hashed the rendered HTML and was wrong. Elapsed times, quiet
// counters, the ETA band, the build stamp and a duration cell's explanatory
// `title` are all derived from the clock, and stripping them by pattern missed
// the tooltip: two reads forty minutes apart hashed differently with an
// unchanged board, which would have deployed on every tick anyway. Hashing the
// run data instead is stable by construction, because State carries no
// clock-derived field by design. These tests hold that line.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard, boardDigest } from '../status-page/build.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', started: iso(T0),
  updated: iso(T0), tty: '', units: [], needsInput: [], blockers: [], ...over,
});
const RUNNING_UNIT = [{ id: '1', label: 'a', state: 'running', started: iso(T0) }];

async function vaultWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-dig-'));
  await mkdir(join(root, '15-Runs'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '15-Runs', name), body);
  }
  return root;
}
const SESSION = [{ pid: 501, tty: '/dev/ttys000', project: 'sprocket',
                   where: 'work/sprocket', since: iso(T0) }];
const RUN = { runId: 'r', project: 'p', goal: 'g', machine: 'm', state: 'running', note: '',
  tty: '', started: iso(T0), updated: iso(T0), units: [], needsInput: [], blockers: [] };

test('the digest does not move while only the clock does', async () => {
  // A running unit is the case that broke the HTML-hashing attempt: its elapsed
  // time is re-derived on every render.
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({ units: RUNNING_UNIT })) });
  const a = boardDigest(await readBoard(root, SESSION));
  const b = boardDigest(await readBoard(root, SESSION));
  assert.equal(a, b);
  await rm(root, { recursive: true, force: true });
});

test('a changed unit state moves the digest', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({ units: RUNNING_UNIT })) });
  const before = boardDigest(await readBoard(root, SESSION));
  await writeFile(join(root, '15-Runs', 'widget-1.json'), JSON.stringify(base({
    units: [{ id: '1', label: 'a', state: 'done', started: iso(T0), ended: iso(T0 + 60_000) }],
  })));
  assert.notEqual(boardDigest(await readBoard(root, SESSION)), before);
  await rm(root, { recursive: true, force: true });
});

test('a changed note moves the digest, because the phone renders it', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const before = boardDigest(await readBoard(root, SESSION));
  await writeFile(join(root, '15-Runs', 'widget-1.json'),
    JSON.stringify(base({ note: 'something else entirely' })));
  assert.notEqual(boardDigest(await readBoard(root, SESSION)), before);
  await rm(root, { recursive: true, force: true });
});

test('a new question waiting on the operator moves the digest', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const before = boardDigest(await readBoard(root, SESSION));
  await writeFile(join(root, '15-Runs', 'widget-1.json'), JSON.stringify(base({
    needsInput: [{ question: 'Should audit rows carry titles?', since: iso(T0) }],
  })));
  assert.notEqual(boardDigest(await readBoard(root, SESSION)), before,
    'the loudest thing on the board must never be held back by the skip check');
  await rm(root, { recursive: true, force: true });
});

test('a run finishing moves the digest', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const before = boardDigest(await readBoard(root, SESSION));
  await writeFile(join(root, '15-Runs', 'widget-1.json'),
    JSON.stringify(base({ state: 'done' })));
  assert.notEqual(boardDigest(await readBoard(root, SESSION)), before);
  await rm(root, { recursive: true, force: true });
});

test('a new session with no run file moves the digest', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const before = boardDigest(await readBoard(root, SESSION));
  const after = boardDigest(await readBoard(root, [...SESSION,
    { pid: 502, tty: '/dev/ttys001', project: 'gadget', where: 'work/gadget', since: iso(T0) }]));
  assert.notEqual(after, before);
  await rm(root, { recursive: true, force: true });
});

test('a session merely getting older does not move the digest', async () => {
  // `since` is the process start time and is fixed for the life of a session.
  // Uptime is derived from it at render time, so it must not be hashed.
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const a = boardDigest(await readBoard(root, SESSION));
  const b = boardDigest(await readBoard(root, SESSION));
  assert.equal(a, b);
  await rm(root, { recursive: true, force: true });
});

test('readBoard still refuses an unreadable vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-dig-'));
  await assert.rejects(() => readBoard(root, SESSION), /15-Runs/);
  await rm(root, { recursive: true, force: true });
});

// ── things that change the page must change the digest ───────────────────────
//
// The skip check decides whether the phone page is uploaded at all, so anything
// it cannot see is something the page can be permanently wrong about. Both of
// these were found by asking, of each rendered fact, "would the digest move?"

test('a session dying moves the digest, because the row stops saying NO UPDATE', () => {
  // stateText renders QUIET or NO UPDATE depending on whether the writing
  // session is visible. That session is claimed by the run, so it never appears
  // in `unpublished`, and hashing only the unpublished list made its death
  // invisible: the phone would have said NO UPDATE for a dead run forever.
  const alive = { active: [{ ...RUN, session: { pid: 501 } }], finished: [], unpublished: [] };
  const dead = { active: [{ ...RUN, session: null }], finished: [], unpublished: [] };
  assert.notEqual(boardDigest(alive), boardDigest(dead));
});

test('a finished run ageing out of the window moves the digest', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({
    runId: 'old', state: 'done', updated: iso(T0),
  })) });
  const inside = boardDigest(await readBoard(root, SESSION, T0 + 86_400_000));
  const outside = boardDigest(await readBoard(root, SESSION, T0 + 6 * 86_400_000));
  assert.notEqual(inside, outside,
    'the run leaves the page at five days; a digest blind to that never redeploys');
  await rm(root, { recursive: true, force: true });
});

test('the digest still ignores the clock inside the window', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base({
    runId: 'live', units: [{ id: '1', label: 'a', state: 'running', started: iso(T0) }],
  })) });
  const a = boardDigest(await readBoard(root, SESSION, T0 + 60_000));
  const b = boardDigest(await readBoard(root, SESSION, T0 + 90 * 60_000));
  assert.equal(a, b, 'ninety minutes of elapsed time is not a change to the board');
  await rm(root, { recursive: true, force: true });
});

// The caller, not just the function. boardDigest's silence bucket was correct
// and tested; the publisher called it with one argument, so the bucket returned
// 0 for every board and a run going quiet could never fire a deploy. The
// function's own tests all passed throughout, because they pass the clock.
//
// A source assertion rather than a spy: this repo has no mocking library and
// wants none, and the same idiom already guards the CSS encoding. It is narrow
// and it would have caught the defect that shipped.
test('the publisher passes the clock to boardDigest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');
  const src = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'publish.js'), 'utf8',
  );
  const call = src.match(/boardDigest\([^;]*\)/s);
  assert.ok(call, 'publish.js no longer calls boardDigest — update this test');
  assert.match(call[0], /,\s*now\s*\)/,
    'boardDigest is called without the clock, so silence cannot move the digest');
});
