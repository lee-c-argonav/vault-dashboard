// history.test.js — active runs versus finished ones.
//
// Written against a run that sat on both boards for two days. `/close` step 9
// has two actions, set `state: "done"` and move the file to `99-Archive/runs/`.
// On 2026-08-08 the first ran and the second did not, so a finished run stayed
// on the desktop and the phone until someone noticed by eye.
//
// The fix is to stop letting a manual `mv` decide what the operator sees.
// `state: "done"` is the fact; the move is tidying. partitionRuns is shared so
// the two surfaces cannot disagree about which runs are still live.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFinishedRuns } from '../runs.js';
import { partitionRuns } from '../public/runs-view.js';

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', started: iso(T0),
  updated: iso(T0), units: [], needsInput: [], blockers: [], ...over,
});

test('a done run leaves the live board without anyone moving a file', () => {
  const { active, finished } = partitionRuns([
    base({ runId: 'a', state: 'running' }),
    base({ runId: 'b', state: 'done' }),
  ]);
  assert.deepEqual(active.map((r) => r.runId), ['a']);
  assert.deepEqual(finished.map((r) => r.runId), ['b']);
});

test('paused and blocked runs stay live, because they are not finished', () => {
  const { active, finished } = partitionRuns([
    base({ runId: 'a', state: 'paused' }),
    base({ runId: 'b', blockers: [{ what: 'x', since: iso(T0) }] }),
  ]);
  assert.equal(active.length, 2);
  assert.equal(finished.length, 0);
});

test('finished runs come back newest first, so history reads as history', () => {
  const { finished } = partitionRuns([
    base({ runId: 'old', state: 'done', updated: iso(T0) }),
    base({ runId: 'new', state: 'done', updated: iso(T0 + 86_400_000) }),
    base({ runId: 'mid', state: 'done', updated: iso(T0 + 3_600_000) }),
  ]);
  assert.deepEqual(finished.map((r) => r.runId), ['new', 'mid', 'old']);
});

test('a finished run with no updated stamp sorts last rather than throwing', () => {
  const { finished } = partitionRuns([
    base({ runId: 'nostamp', state: 'done', updated: 'not a date' }),
    base({ runId: 'good', state: 'done', updated: iso(T0) }),
  ]);
  assert.deepEqual(finished.map((r) => r.runId), ['good', 'nostamp']);
});

test('readFinishedRuns reads the archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-hist-'));
  await mkdir(join(root, '99-Archive', 'runs'), { recursive: true });
  await writeFile(join(root, '99-Archive', 'runs', 'widget-9.json'),
    JSON.stringify(base({ runId: 'widget-9', state: 'done' })));
  const runs = await readFinishedRuns(root);
  assert.deepEqual(runs.map((r) => r.runId), ['widget-9']);
  await rm(root, { recursive: true, force: true });
});

test('an absent archive is not an error, it is an empty history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-hist-'));
  assert.deepEqual(await readFinishedRuns(root), []);
  await rm(root, { recursive: true, force: true });
});

test('an archived run still marked running is reported as finished anyway', async () => {
  // Being in the archive is the stronger statement: someone closed it out. A
  // run left `running` in there is a writer that died, not live work.
  const root = await mkdtemp(join(tmpdir(), 'vhud-hist-'));
  await mkdir(join(root, '99-Archive', 'runs'), { recursive: true });
  await writeFile(join(root, '99-Archive', 'runs', 'widget-8.json'),
    JSON.stringify(base({ runId: 'widget-8', state: 'running' })));
  const runs = await readFinishedRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'done');
  await rm(root, { recursive: true, force: true });
});

test('a run in both places is counted once, and the archived copy wins', async () => {
  const { finished } = partitionRuns([
    base({ runId: 'dup', state: 'done', note: 'live copy' }),
  ], [
    base({ runId: 'dup', state: 'done', note: 'archived copy' }),
  ]);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].note, 'archived copy');
});
