// usage-poller.test.js — the poller, the reader, and the store between them.
//
// This repository is public, so no test may touch the real Keychain, the real
// network or real credentials. Every token below is an invented string, every
// account a widget/sprocket, and fetch is a mock routed by URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage } from '../usage.js';
import { pollOnce, startUsagePoller } from '../usage-poller.js';

const T0 = Date.parse('2026-08-12T12:00:00.000Z');
const hour = 3_600_000;
const iso = (t) => new Date(t).toISOString();
const now = () => T0;

const account = (over = {}) => ({
  id: 'widget', label: 'Widget', plan: 'max',
  accessToken: 'syn-access-1', refreshToken: 'syn-refresh-1',
  expiresAt: iso(T0 + hour), scopes: ['user:profile'], ...over,
});

const usagePayload = (over = {}) => ({
  five_hour: { utilization: 42, resets_at: iso(T0 + 2 * hour) },
  seven_day: { utilization: 10, resets_at: iso(T0 + 100 * hour) },
  seven_day_opus: { utilization: 0, resets_at: iso(T0 + 100 * hour) },
  seven_day_sonnet: { utilization: 5, resets_at: iso(T0 + 100 * hour) },
  ...over,
});

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A fetch routed by "METHOD url". Unrouted calls throw, so a test that
 *  triggers an unexpected request fails loudly instead of hanging. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[`${init.method ?? 'GET'} ${url}`];
    if (!handler) throw new Error(`unexpected fetch: ${init.method ?? 'GET'} ${url}`);
    return handler();
  };
  fn.calls = calls;
  return fn;
}

const USAGE = 'GET https://api.anthropic.com/api/oauth/usage';
const REFRESH_PLATFORM = 'POST https://platform.claude.com/v1/oauth/token';
const REFRESH_CONSOLE = 'POST https://console.anthropic.com/v1/oauth/token';

async function dataDirWith(store) {
  const dir = await mkdtemp(join(tmpdir(), 'vhud-usage-'));
  if (store) {
    await writeFile(join(dir, 'usage-tokens.json'), JSON.stringify(store));
  }
  return dir;
}
const storeOf = (...accounts) => ({ schema: 1, accounts });
const cleanup = (dir) => rm(dir, { recursive: true, force: true });
const silent = () => {};
// Tests never touch the real Keychain: a GUI prompt from a background suite
// would hang the run. With this exec, current-account detection reads as
// "unknown", which is exactly what the snapshots below assert.
const noKeychain = async () => { throw new Error('no keychain in tests'); };

/* ── pollOnce: the happy path ───────────────────────────────────────────── */

test('two healthy accounts are polled in order, 2s apart, with the right headers', async () => {
  const dir = await dataDirWith(storeOf(
    account(),
    account({ id: 'sprocket', label: 'Sprocket', accessToken: 'syn-access-2', refreshToken: 'syn-refresh-2' }),
  ));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload()) });
  const sleeps = [];
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: async (ms) => sleeps.push(ms), log: silent, exec: noKeychain });

  assert.deepEqual(result, { wrote: true, accounts: 2, states: ['ok', 'ok'] });
  assert.deepEqual(sleeps, [2_000], 'exactly one inter-account pause');
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer syn-access-1');
  assert.equal(fetch.calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(fetch.calls[0].init.headers['User-Agent'], 'claude-code/2.1.228');
  assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');

  const snap = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.equal(snap.schema, 1);
  assert.equal(snap.updated, iso(T0));
  assert.deepEqual(snap.accounts.map((a) => a.id), ['widget', 'sprocket']);
  assert.deepEqual(snap.accounts[0].fiveHour, { utilization: 42, resetsAt: iso(T0 + 2 * hour) });
  assert.deepEqual(snap.accounts[0].sevenDaySonnet, { utilization: 5, resetsAt: iso(T0 + 100 * hour) });
  assert.equal(snap.accounts[0].error, null);

  // Atomic write: the rename target exists and no tmp file is left behind.
  assert.deepEqual((await readdir(dir)).sort(), ['usage-tokens.json', 'usage.json']);
  await cleanup(dir);
});

/* ── refresh before polling ─────────────────────────────────────────────── */

test('a token expiring within 60s is refreshed BEFORE the usage call, and the rotation is persisted', async () => {
  const dir = await dataDirWith(storeOf(account({ expiresAt: iso(T0 + 30_000) })));
  const fetch = mockFetch({
    [REFRESH_PLATFORM]: () => jsonResponse({ access_token: 'syn-access-2', refresh_token: 'syn-refresh-2', expires_in: 3600 }),
    [USAGE]: () => jsonResponse(usagePayload()),
  });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['ok']);

  // The usage call ran with the NEW access token.
  const [refreshCall, usageCall] = fetch.calls;
  assert.equal(usageCall.init.headers.Authorization, 'Bearer syn-access-2');
  const sent = JSON.parse(refreshCall.init.body);
  assert.equal(sent.grant_type, 'refresh_token');
  assert.equal(sent.refresh_token, 'syn-refresh-1');
  assert.equal(sent.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');

  // The rotated bundle is on disk, mode 0600.
  const file = join(dir, 'usage-tokens.json');
  const store = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(store.accounts[0].accessToken, 'syn-access-2');
  assert.equal(store.accounts[0].refreshToken, 'syn-refresh-2');
  assert.equal(store.accounts[0].expiresAt, iso(T0 + hour));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await cleanup(dir);
});

test('a refresh response without a new refresh token keeps the old one', async () => {
  const dir = await dataDirWith(storeOf(account({ expiresAt: iso(T0 + 30_000) })));
  const fetch = mockFetch({
    [REFRESH_PLATFORM]: () => jsonResponse({ access_token: 'syn-access-2', expires_in: 3600 }),
    [USAGE]: () => jsonResponse(usagePayload()),
  });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  const store = JSON.parse(await readFile(join(dir, 'usage-tokens.json'), 'utf8'));
  assert.equal(store.accounts[0].refreshToken, 'syn-refresh-1');
  await cleanup(dir);
});

test('a 404 from the primary refresh host falls back to the console host', async () => {
  const dir = await dataDirWith(storeOf(account({ expiresAt: iso(T0 + 30_000) })));
  const fetch = mockFetch({
    [REFRESH_PLATFORM]: () => jsonResponse({}, 404),
    [REFRESH_CONSOLE]: () => jsonResponse({ access_token: 'syn-access-2', refresh_token: 'syn-refresh-2', expires_in: 3600 }),
    [USAGE]: () => jsonResponse(usagePayload()),
  });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['ok']);
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'https://platform.claude.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token',
    'https://api.anthropic.com/api/oauth/usage',
  ]);
  await cleanup(dir);
});

/* ── failure states ─────────────────────────────────────────────────────── */

test('a 400 refresh marks the account auth_expired, skips the usage call, keeps the stored bundle', async () => {
  const dir = await dataDirWith(storeOf(account({ expiresAt: iso(T0 + 30_000) })));
  const fetch = mockFetch({ [REFRESH_PLATFORM]: () => jsonResponse({ error: 'invalid_grant' }, 400) });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });

  assert.deepEqual(result.states, ['auth_expired']);
  assert.equal(fetch.calls.length, 1, 'the usage endpoint is never called');
  const snap = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.equal(snap.accounts[0].state, 'auth_expired');
  assert.match(snap.accounts[0].error, /400/);
  assert.match(snap.accounts[0].error, /invalid_grant/);
  assert.equal(snap.accounts[0].fiveHour, null);

  const store = JSON.parse(await readFile(join(dir, 'usage-tokens.json'), 'utf8'));
  assert.equal(store.accounts[0].refreshToken, 'syn-refresh-1', 'a rejected refresh must not clobber the store');
  await cleanup(dir);
});

test('a 401 from the usage endpoint earns one refresh and one retry', async () => {
  const dir = await dataDirWith(storeOf(account()));
  let usageCalls = 0;
  const fetch = mockFetch({
    [USAGE]: () => (++usageCalls === 1 ? jsonResponse({}, 401) : jsonResponse(usagePayload())),
    [REFRESH_PLATFORM]: () => jsonResponse({ access_token: 'syn-access-2', refresh_token: 'syn-refresh-2', expires_in: 3600 }),
  });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['ok']);
  assert.equal(usageCalls, 2);
  assert.equal(fetch.calls[2].init.headers.Authorization, 'Bearer syn-access-2');
  await cleanup(dir);
});

test('a 401 whose retry refresh is rejected lands on auth_expired', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({
    [USAGE]: () => jsonResponse({}, 401),
    [REFRESH_PLATFORM]: () => jsonResponse({}, 401),
  });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['auth_expired']);
  await cleanup(dir);
});

test('a 429 honours Retry-After, waits, and retries once', async () => {
  const dir = await dataDirWith(storeOf(account()));
  let n = 0;
  const fetch = mockFetch({
    [USAGE]: () => (++n === 1 ? jsonResponse({}, 429, { 'retry-after': '7' }) : jsonResponse(usagePayload())),
  });
  const sleeps = [];
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: async (ms) => sleeps.push(ms), log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['ok']);
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [7_000]);
  await cleanup(dir);
});

test('a second 429 becomes an error state, not another wait', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse({}, 429, { 'retry-after': '1' }) });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['error']);
  const snap = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.match(snap.accounts[0].error, /429/);
  await cleanup(dir);
});

test('a network throw is an error state carrying the message', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => { throw new Error('socket hang up'); } });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['error']);
  const snap = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.match(snap.accounts[0].error, /socket hang up/);
  await cleanup(dir);
});

test('one failing account does not stop the next one from polling', async () => {
  const dir = await dataDirWith(storeOf(
    account({ id: 'widget', accessToken: 'syn-bad' }),
    account({ id: 'sprocket', accessToken: 'syn-good' }),
  ));
  const fetch = mockFetch({
    [USAGE]: (url, init) => jsonResponse(usagePayload()),
  });
  // Route on the bearer token instead: first account 500s, second succeeds.
  const routed = async (url, init = {}) => {
    if (init.headers?.Authorization === 'Bearer syn-bad') return jsonResponse({}, 500);
    return fetch(url, init);
  };
  const result = await pollOnce({ dataDir: dir, fetch: routed, now, sleep: silent, log: silent, exec: noKeychain });
  assert.deepEqual(result.states, ['error', 'ok']);
  await cleanup(dir);
});

/* ── no accounts ────────────────────────────────────────────────────────── */

test('an absent token file is a no-op, not a crash', async () => {
  const dir = await dataDirWith(null);
  const lines = [];
  const result = await pollOnce({ dataDir: dir, fetch: mockFetch({}), now, sleep: silent, log: (m) => lines.push(m), exec: noKeychain });
  assert.deepEqual(result, { wrote: false, reason: 'no-accounts', accounts: 0 });
  assert.equal(lines.length, 1);
  assert.deepEqual(await readdir(dir), []);
  await cleanup(dir);
});

test('an empty accounts array is the same no-op', async () => {
  const dir = await dataDirWith(storeOf());
  const result = await pollOnce({ dataDir: dir, fetch: mockFetch({}), now, sleep: silent, log: silent, exec: noKeychain });
  assert.equal(result.wrote, false);
  assert.equal(result.reason, 'no-accounts');
  await cleanup(dir);
});

/* ── startUsagePoller ───────────────────────────────────────────────────── */

test('startUsagePoller with nothing enrolled logs ONE line and returns a no-op handle', async () => {
  const dir = await dataDirWith(null);
  const lines = [];
  const handle = startUsagePoller({
    dataDir: dir, intervalMs: 60_000, log: (m) => lines.push(m),
    fetch: mockFetch({}), now, sleep: silent, exec: noKeychain,
  });
  await handle.ready;
  handle.stop();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no accounts enrolled/);
  assert.deepEqual(await readdir(dir), []);
  await cleanup(dir);
});

test('startUsagePoller polls once immediately on start', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload()) });
  const handle = startUsagePoller({ dataDir: dir, intervalMs: 60_000, log: silent, fetch, now, sleep: silent, exec: noKeychain });
  await handle.ready;
  handle.stop();
  assert.equal(fetch.calls.length, 1);
  const { usage, status } = await readUsage(dir);
  assert.equal(status, 'ok');
  assert.equal(usage.accounts[0].state, 'ok');
  await cleanup(dir);
});

/* ── readUsage ──────────────────────────────────────────────────────────── */

test('readUsage: absent, broken and wrong-schema are three different answers', async () => {
  const dir = await dataDirWith(null);
  assert.deepEqual(await readUsage(dir), { usage: null, status: 'absent' });

  await writeFile(join(dir, 'usage.json'), '{"schema": 1, "accounts":');
  assert.deepEqual(await readUsage(dir), { usage: null, status: 'broken' });

  await writeFile(join(dir, 'usage.json'), JSON.stringify({ schema: 2, accounts: [] }));
  assert.deepEqual(await readUsage(dir), { usage: null, status: 'broken' });
  await cleanup(dir);
});

test('readUsage normalises: clamps utilization, validates ISO, whitelists state', async () => {
  const dir = await dataDirWith(null);
  await writeFile(join(dir, 'usage.json'), JSON.stringify({
    schema: 1, updated: iso(T0),
    accounts: [
      {
        id: 'widget', label: 'Widget', plan: 'max', state: 'ok', error: null,
        fetchedAt: iso(T0),
        fiveHour: { utilization: 150, resetsAt: iso(T0 + hour) },
        sevenDay: { utilization: -5, resetsAt: 'nonsense' },
        sevenDayOpus: { utilization: 'high', resetsAt: iso(T0) },
        sevenDaySonnet: null,
        unexpectedField: 'dropped',
      },
      { label: 'no id at all' },
      { id: 'sprocket', state: 'invented', error: '', extra: 1 },
    ],
  }));
  const { usage, status } = await readUsage(dir);
  assert.equal(status, 'ok');
  assert.equal(usage.accounts.length, 2, 'the id-less entry is dropped');

  const w = usage.accounts[0];
  assert.equal(w.fiveHour.utilization, 100);
  assert.equal(w.sevenDay.utilization, 0);
  assert.equal(w.sevenDay.resetsAt, null, 'an invalid ISO string becomes null');
  assert.equal(w.sevenDayOpus, null, 'a non-numeric utilization costs the window');
  assert.equal(w.sevenDaySonnet, null);
  assert.equal(w.unexpectedField, undefined);

  const s = usage.accounts[1];
  assert.equal(s.state, 'error', 'an unrecognised state is coerced, not passed through');
  assert.equal(s.error, null);
  assert.equal(s.label, 'sprocket', 'label falls back to id');
  await cleanup(dir);
});

test('readUsage tolerates a BOM, and a poll round-trips through it', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({
    [USAGE]: () => jsonResponse(usagePayload({ five_hour: { utilization: 250, resets_at: iso(T0 + hour) } })),
  });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  const file = join(dir, 'usage.json');
  await writeFile(file, '\ufeff' + await readFile(file, 'utf8'));
  const { usage, status } = await readUsage(dir);
  assert.equal(status, 'ok');
  assert.equal(usage.accounts[0].fiveHour.utilization, 100, 'the writer\'s 250 is clamped on read');
  await cleanup(dir);
});

test('no clock-derived field appears in what readUsage returns', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload()) });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  const a = JSON.stringify((await readUsage(dir)).usage);
  await new Promise((r) => setTimeout(r, 20));
  const b = JSON.stringify((await readUsage(dir)).usage);
  assert.equal(a, b, 'State must be stable, or app.js repaints on every tick');
  await cleanup(dir);
});

/* ── the Fable window ───────────────────────────────────────────────────── */

test('the Fable window comes from limits[], not a top-level field', async () => {
  const dir = await dataDirWith(storeOf(account()));
  // The live shape, observed 2026-08-12: a weekly-scoped limits entry naming
  // the model. The codename top-level fields come and go; this is the handle.
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload({
    limits: [
      { kind: 'session', group: 'session', percent: 42,
        resets_at: iso(T0 + 2 * hour), scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 7,
        resets_at: iso(T0 + 30 * hour),
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false },
    ],
  })) });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  const { usage } = await readUsage(dir);
  assert.deepEqual(usage.accounts[0].sevenDayFable,
    { utilization: 7, resetsAt: iso(T0 + 30 * hour) });
  await cleanup(dir);
});

test('no Fable entry in limits[] is a null window, not an error', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload({ limits: [] })) });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  const { usage } = await readUsage(dir);
  assert.equal(usage.accounts[0].sevenDayFable, null);
  assert.equal(usage.accounts[0].state, 'ok');
  await cleanup(dir);
});

/* ── which account the CLI is on ────────────────────────────────────────── */

// The token→uuid cache is module-level by design (the CLI's token rotates
// rarely), so every test below uses its own token strings: reusing one would
// read another test's cached answer.

test('the current account is matched by profile uuid, never by token string', async () => {
  const dir = await dataDirWith(storeOf(
    account({ id: 'widget', accessToken: 'syn-access-a' }),
    account({ id: 'sprocket', accessToken: 'syn-access-b' }),
  ));
  const uuidByAuth = {
    'Bearer syn-access-a': 'uuid-widget',
    'Bearer syn-access-b': 'uuid-sprocket',
    'Bearer syn-cli-token-a': 'uuid-sprocket',
  };
  const fetch = async (url, init = {}) => {
    if (url === 'https://api.anthropic.com/api/oauth/usage') return jsonResponse(usagePayload());
    if (url === 'https://api.anthropic.com/api/oauth/profile') {
      const uuid = uuidByAuth[init.headers?.Authorization];
      return uuid ? jsonResponse({ account: { uuid } }) : jsonResponse({}, 404);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const exec = async () => ({
    stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'syn-cli-token-a' } }),
  });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec });
  assert.equal(result.wrote, true);
  const { usage } = await readUsage(dir);
  assert.equal(usage.currentAccountId, 'sprocket',
    'the CLI token and the stored bundle are different strings; the uuid is the match');
  // The backfilled uuids were persisted, so the next poll skips those calls.
  const store = JSON.parse(await readFile(join(dir, 'usage-tokens.json'), 'utf8'));
  assert.equal(store.accounts[0].uuid, 'uuid-widget');
  assert.equal(store.accounts[1].uuid, 'uuid-sprocket');
  await cleanup(dir);
});

test('a default profile on an unenrolled account reads as unknown', async () => {
  const dir = await dataDirWith(storeOf(account({ id: 'widget', accessToken: 'syn-access-c' })));
  const fetch = async (url, init = {}) => {
    if (url === 'https://api.anthropic.com/api/oauth/usage') return jsonResponse(usagePayload());
    if (url === 'https://api.anthropic.com/api/oauth/profile') {
      const auth = init.headers?.Authorization;
      return jsonResponse({ account: { uuid: auth === 'Bearer syn-access-c' ? 'uuid-widget' : 'uuid-stranger' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const exec = async () => ({
    stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'syn-cli-token-b' } }),
  });
  await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec });
  const { usage } = await readUsage(dir);
  assert.equal(usage.currentAccountId, null);
  await cleanup(dir);
});

test('a keychain read failure leaves the current account unknown, the poll fine', async () => {
  const dir = await dataDirWith(storeOf(account()));
  const fetch = mockFetch({ [USAGE]: () => jsonResponse(usagePayload()) });
  const result = await pollOnce({ dataDir: dir, fetch, now, sleep: silent, log: silent, exec: noKeychain });
  assert.equal(result.wrote, true);
  const { usage } = await readUsage(dir);
  assert.equal(usage.currentAccountId, null);
  assert.equal(usage.accounts[0].state, 'ok');
  await cleanup(dir);
});
