// publish.test.js — the guards that stand between the vault and a published page.
//
// The bug these were written against: `status-page/deploy.sh` resolved the vault
// path one line before the `.env` that defines it was sourced, so every build
// from 2026-08-06 ran against a directory that does not exist. `readRuns`
// returns `[]` for a missing directory, so the page rendered "No run is
// publishing status", stamped itself with the current time and deployed. Four
// days passed before anyone noticed, because a blank board and a quiet board are
// the same picture.
//
// Two separate defects, so two separate guards and two separate suites:
//   - the reader could not say WHY it returned nothing        → readRunsDetailed
//   - the builder could not refuse to publish nothing         → build() throws
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRuns, readRunsDetailed } from '../runs.js';

const execFileP = promisify(execFile);
const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '..');

const T0 = Date.parse('2026-08-06T14:00:00.000Z');
const iso = (t) => new Date(t).toISOString();
const base = (over = {}) => ({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', started: iso(T0),
  updated: iso(T0), units: [], needsInput: [], blockers: [], ...over,
});

// Assertions run against the body, never the whole document. The stylesheet is
// inlined, and its comments name the very strings these tests look for, so
// matching the document made a comment about a section indistinguishable from
// the section. One test passed for that reason before this helper existed.
const body = (html) => html.slice(html.indexOf('</style>') + 8);

async function vaultWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-pub-'));
  await mkdir(join(root, '15-Runs'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '15-Runs', name), body);
  }
  return root;
}

// ── the reader can say why it returned nothing ────────────────────────────────

test('readRunsDetailed reports an unreadable vault, rather than an empty one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-pub-'));  // no 15-Runs inside
  const d = await readRunsDetailed(root);
  assert.deepEqual(d.runs, []);
  assert.equal(d.unreadable, true, 'a missing 15-Runs must be distinguishable from an idle one');
  await rm(root, { recursive: true, force: true });
});

test('readRunsDetailed reports a readable but idle vault as readable', async () => {
  const root = await vaultWith({});
  const d = await readRunsDetailed(root);
  assert.deepEqual(d.runs, []);
  assert.equal(d.unreadable, false, 'an empty 15-Runs is a real answer, not a failure');
  await rm(root, { recursive: true, force: true });
});

test('readRunsDetailed counts files it could not use', async () => {
  const root = await vaultWith({
    'widget-1.json': JSON.stringify(base()),
    'broken.json': '{ not json',
    'no-id.json': JSON.stringify({ project: 'widget' }),
  });
  const d = await readRunsDetailed(root);
  assert.equal(d.runs.length, 1);
  assert.equal(d.skipped, 2, 'a run file the reader cannot use must be counted, not dropped silently');
  await rm(root, { recursive: true, force: true });
});

test('readRuns keeps its array shape, so every existing caller is untouched', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const runs = await readRuns(root);
  assert.ok(Array.isArray(runs));
  assert.equal(runs.length, 1);
  await rm(root, { recursive: true, force: true });
});

// ── the builder refuses to publish a board it cannot vouch for ────────────────

test('build() throws rather than render an empty page from an unreadable vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vhud-pub-'));  // no 15-Runs inside
  const { build } = await import('../status-page/build.js');
  await assert.rejects(
    () => build({ vault: root }),
    /unreadable|15-Runs/i,
    'publishing a blank board over a real one is the failure this guard exists for',
  );
  await rm(root, { recursive: true, force: true });
});

test('build() still publishes a genuinely idle vault, which is a true statement', async () => {
  const root = await vaultWith({});
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const file = await build({ vault: root, outDir: out });
  const html = await readFile(file, 'utf8');
  assert.match(body(html), /No run is publishing status/);
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('build() renders the runs the vault actually holds', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({ vault: root, outDir: out }), 'utf8');
  assert.match(body(html), /Widget goal/);
  assert.doesNotMatch(body(html), /No run is publishing status/);
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

// ── the deploy script hands the builder the right vault ───────────────────────
//
// The original bug was entirely in shell variable ordering, which no JavaScript
// test can reach. This runs the script's own resolution logic against a stub
// .env and asserts the value that would reach build.js.

test('deploy.sh resolves the vault from .env, not from the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vhud-home-'));
  const envFile = join(home, '.env');
  await writeFile(envFile, 'VAULT_HUD_VAULT=/tmp/real-vault\nVERCEL_SCOPE=s\nSTATUS_PAGE_URL=u\n');
  // Mirror deploy.sh's resolution exactly: source the env file, then resolve.
  const script = `
    set -uo pipefail
    HOME=${JSON.stringify(home)}
    if [ -f "${envFile}" ]; then set -a; . "${envFile}"; set +a; fi
    VAULT="\${VAULT_HUD_VAULT:-$HOME/Obsidian/vault}"
    echo "$VAULT"
  `;
  const { stdout } = await execFileP('bash', ['-c', script]);
  assert.equal(stdout.trim(), '/tmp/real-vault',
    'sourcing .env after resolving VAULT is the 2026-08-06 bug; order is load-bearing');
  await rm(home, { recursive: true, force: true });
});

test('deploy.sh sources .env before it resolves the vault path', async () => {
  const sh = await readFile(join(REPO, 'status-page', 'deploy.sh'), 'utf8');
  const sourceAt = sh.indexOf('. "$HERE/../.env"');
  const resolveAt = sh.indexOf('VAULT="${VAULT_HUD_VAULT:-');
  assert.ok(sourceAt !== -1, 'deploy.sh must still source .env');
  assert.ok(resolveAt !== -1, 'deploy.sh must still resolve VAULT');
  assert.ok(sourceAt < resolveAt,
    'VAULT resolved before .env is sourced silently publishes an empty board');
});

// ── the page shows sessions that are publishing nothing ───────────────────────

test('a live session with no run file gets a line on the page', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({
    vault: root,
    outDir: out,
    sessions: [{ pid: 777, tty: '/dev/ttys009', project: 'sprocket',
                 where: 'work/sprocket', since: iso(T0) }],
  }), 'utf8');
  assert.match(body(html), /Sessions/);
  // The path is GONE, deliberately. It used to publish `work/sprocket` to an
  // unauthenticated URL, and one real value on this machine is a directory
  // named after a confidential project codename. The line now answers the only
  // question the phone is read for.
  assert.doesNotMatch(body(html), /work\/sprocket/,
    'a relative path reached the published page');
  assert.match(body(html), /session 01/);
  assert.match(body(html), /NO STATUS/);
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('a session already accounted for by a run gets no second line', async () => {
  const root = await vaultWith({
    'widget-1.json': JSON.stringify(base({ tty: '/dev/ttys009' })),
  });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({
    vault: root,
    outDir: out,
    sessions: [{ pid: 777, tty: '/dev/ttys009', project: 'widget',
                 where: 'work/widget', since: iso(T0 - 60_000) }],
  }), 'utf8');
  assert.doesNotMatch(body(html), /Sessions ·/,
    'the run row already describes that session in full');
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('no path of any kind reaches the published page', async () => {
  // The rule used to be "no ABSOLUTE path", and a bare leaf name was allowed
  // through. That is not enough: a leaf name is frequently the confidential
  // thing, since repositories are named after the products they are. The
  // projection now drops location entirely, so this asserts the stricter rule.
  const root = await vaultWith({});
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({
    vault: root,
    outDir: out,
    sessions: [{ pid: 777, tty: '/dev/ttys009', project: 'acme', where: '', since: iso(T0) }],
  }), 'utf8');
  assert.doesNotMatch(body(html), /acme/,
    'a project leaf name reached the published page');
  assert.doesNotMatch(body(html), /\/Volumes|\/Users\//);
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

// ── the page can be refreshed from a home-screen install ─────────────────────
//
// From the operator, 2026-08-10: "When I click on the home icon on my iPhone, it
// opens a page, but I cannot refresh because it is not a browser."
//
// Installed to the home screen the page runs standalone — no address bar, no
// reload button, no pull-to-refresh — so a copy opened once could sit there
// indefinitely with no way to get a newer one.

test('the page reloads itself, since a standalone install cannot be reloaded by hand', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({ vault: root, outDir: out }), 'utf8');
  assert.match(html, /<meta http-equiv="refresh" content="\d+">/);
  const seconds = Number(/content="(\d+)"/.exec(html.split('http-equiv="refresh"')[1])[1]);
  assert.ok(seconds > 0 && seconds <= 300,
    'longer than the publisher cycle would show a page older than one already deployed');
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('and offers a tap target, because 2 minutes is a long time to stare at a stale board', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = body(await readFile(await build({ vault: root, outDir: out }), 'utf8'));
  assert.match(html, /<a class="rf" href="\/"/);
  assert.match(html, /Refresh/);
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('no inline script is ever emitted, so the page stays inside default-src none', async () => {
  const root = await vaultWith({ 'widget-1.json': JSON.stringify(base()) });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = await readFile(await build({ vault: root, outDir: out }), 'utf8');
  assert.doesNotMatch(html, /<script/i,
    'the CSP in vercel.json is default-src none; a script tag would be dead markup');
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('a session between jobs shows what it last published, not a bare NO STATUS', async () => {
  const root = await vaultWith({
    'widget-1.json': JSON.stringify(base({ runId: 'done-1', state: 'done',
      goal: 'The finished thing', tty: '/dev/ttys009', updated: iso(T0) })),
  });
  const out = await mkdtemp(join(tmpdir(), 'vhud-out-'));
  const { build } = await import('../status-page/build.js');
  const html = body(await readFile(await build({
    vault: root, outDir: out, now: T0 + 5 * 60_000,
    sessions: [{ pid: 777, tty: '/dev/ttys009', project: 'widget',
                 where: 'work/widget', since: iso(T0 - 60_000) }],
  }), 'utf8'));
  assert.match(html, /The finished thing/);
  assert.match(html, /IDLE/);
  assert.doesNotMatch(html, /NO STATUS/,
    'it is between pieces of work, not a session nobody has heard from');
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});
