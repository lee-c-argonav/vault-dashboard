// usage-wiring.test.js — the parse must surface usage.json, or say why not.
//
// usage.js's own tests cover the normalization. What is pinned here is the
// SEAM, the same way untested-half.test.js aims at callers rather than logic:
// parseVault reads the data dir through readUsage, puts the NORMALIZED object
// on State (a rogue field must not survive the trip), turns 'broken' into a
// warnings entry, and treats 'absent' as ordinary. The failure this guards is
// the repo's standing one — an empty usage panel reading as "no subscriptions
// enrolled" is a false statement (see runs.js on the unreadable 15-Runs).
//
// Every test exercises the VAULT_HUD_DATA_DIR knob by setting it; the default
// path is never touched. This repository is public, so fixtures are synthetic:
// accounts are account-a / account-b and every path is a temp dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import parseVault from '../parse.js';
import { makeVault } from './fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const made = [];
const savedDataDir = process.env.VAULT_HUD_DATA_DIR;
const savedClaudeHome = process.env.VAULT_HUD_CLAUDE_HOME;

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

after(async () => {
  // Hand the process back exactly as found: env restored, temp dirs gone.
  if (savedDataDir === undefined) delete process.env.VAULT_HUD_DATA_DIR;
  else process.env.VAULT_HUD_DATA_DIR = savedDataDir;
  if (savedClaudeHome === undefined) delete process.env.VAULT_HUD_CLAUDE_HOME;
  else process.env.VAULT_HUD_CLAUDE_HOME = savedClaudeHome;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * A vault plus an isolated transcript home, so the parse reads nothing real.
 * VAULT_HUD_CLAUDE_HOME is read lazily at call time (transcripts.js), so
 * setting it per setup is enough.
 */
async function setup() {
  const vault = await makeVault();
  made.push(vault);
  process.env.VAULT_HUD_CLAUDE_HOME = await tempDir('vhud-claude-');
  const dataDir = await tempDir('vhud-data-');
  process.env.VAULT_HUD_DATA_DIR = dataDir;
  return { vault, dataDir };
}

const USAGE = {
  schema: 1,
  updated: '2026-08-12T15:04:00.000Z',
  accounts: [
    {
      id: 'a1', label: 'account-a', plan: 'max', state: 'ok', error: null,
      fetchedAt: '2026-08-12T15:03:58.000Z',
      fiveHour: { utilization: 42, resetsAt: '2026-08-12T19:00:00.000Z' },
      sevenDay: { utilization: 18, resetsAt: '2026-08-19T00:00:00.000Z' },
      sevenDayOpus: null, sevenDaySonnet: null,
      // Not in the contract. If State ever carries this, parse.js is serving a
      // raw read rather than usage.js's normalized object.
      rogue: 'must never reach State',
    },
    {
      id: 'b2', label: 'account-b', plan: 'pro', state: 'auth_expired',
      error: 'refresh token rejected', fetchedAt: '2026-08-12T14:58:01.000Z',
      fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null,
    },
  ],
};

test('absent usage.json is ordinary: usage null, and no warning about it', async () => {
  const { vault } = await setup();
  const state = await parseVault(vault);
  assert.equal(state.usage, null);
  assert.ok(!state.warnings.some((w) => /usage/i.test(w)),
    `absent usage.json produced a warning: ${state.warnings.join(' | ')}`);
});

test('a good usage.json reaches State normalized, not raw', async () => {
  const { vault, dataDir } = await setup();
  await writeFile(join(dataDir, 'usage.json'), JSON.stringify(USAGE));
  const state = await parseVault(vault);
  assert.ok(state.usage, 'usage.json was written but State carries none');
  assert.equal(state.usage.updated, USAGE.updated);
  assert.equal(state.usage.accounts.length, 2);
  const a = state.usage.accounts[0];
  assert.equal(a.label, 'account-a');
  assert.equal(a.fiveHour.utilization, 42);
  assert.equal(a.rogue, undefined, 'a non-contract field survived normalization');
  // An error-state account is data, not a parse failure: still no warning.
  assert.ok(!state.warnings.some((w) => /usage/i.test(w)));
});

test('a broken usage.json costs the usage panel, never the parse', async () => {
  const { vault, dataDir } = await setup();
  // Truncated mid-file, as a kill during the poller's write would leave it.
  await writeFile(join(dataDir, 'usage.json'), '{"schema": 1, "accounts": [{"id"');
  const state = await parseVault(vault);
  assert.equal(state.usage, null);
  assert.ok(state.warnings.some((w) => w.includes('usage.json')),
    `a present-but-unparseable usage.json must say so: ${state.warnings.join(' | ')}`);
  assert.ok(state.health.notes > 0, 'the vault parse died with the usage read');
});

test('usage on State carries no clock-derived field', async () => {
  const { vault, dataDir } = await setup();
  await writeFile(join(dataDir, 'usage.json'), JSON.stringify(USAGE));
  const a = JSON.stringify((await parseVault(vault)).usage);
  await new Promise((r) => setTimeout(r, 20));
  const b = JSON.stringify((await parseVault(vault)).usage);
  // app.js guards renders with a JSON.stringify diff; a clock value here makes
  // every timed broadcast look changed. Staleness lives in public/usage-view.js.
  assert.equal(a, b);
});

// ── server.js — the poller starts only once the port is genuinely held ──
//
// server.js is never booted in a test (untested-half.test.js explains why), so
// these read the source, the same pattern its seam tests use.

const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');

test('the usage poller is started inside the listen callback, not at boot', () => {
  assert.match(SERVER, /import \{ startUsagePoller \} from '\.\/usage-poller\.js'/);
  const listen = SERVER.match(/server\.listen\(PORT, HOST, \(\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  assert.ok(listen.includes('startUsagePoller('),
    'the poller starts before the port is held, so a duplicate daemon losing the '
    + 'race would keep polling for nobody — the case the listen-callback guard exists for');
  // startUsagePoller takes an options object. A bare log function would be
  // destructured into nothing and silently replaced by the console.error
  // default — a tested callee with a misusing caller, the defect class
  // untested-half.test.js exists for. Caught here once, pinned forever.
  assert.match(listen, /startUsagePoller\(\{[^}]*\blog:/,
    'startUsagePoller is called with a bare argument; it takes { log, … }');
});

test('shutdown stops the poller like every other timer', () => {
  const shutdown = SERVER.match(/function shutdown\(signal\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(shutdown, /usagePoller\?\.stop\(\)/,
    'the poller is armed at boot and never stopped; shutdown must stop it too');
});

test('no watcher is added for usage.json', () => {
  // It changes every 300s at most and the 10s safety re-parse picks each write
  // up. A watch would buy sub-second freshness nothing needs.
  assert.ok(!/watch\([^)]*usage/i.test(SERVER),
    'server.js watches the usage file; the safety re-parse already covers it');
});

test('the boot state carries usage: null, so the shape never changes', () => {
  const boot = SERVER.match(/function bootState\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(/usage:\s*null/.test(boot),
    'bootState lost usage: null — app.js would read undefined before the first parse');
});
