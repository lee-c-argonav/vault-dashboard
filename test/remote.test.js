// remote.test.js — which account a remote machine's CLI is on, and the three
// states that must never be confused: answered, asked-and-failed, never-asked.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRemoteAccounts, resetRemoteAccounts, remoteHosts } from '../remote.js';
import { usageView, remoteSignersFor, REMOTE_STALE_MS } from '../public/usage-view.js';

const UUID = 'abcd1234-0000-4000-8000-00000000beef';
const OTHER = 'ef567890-0000-4000-8000-00000000cafe';
const T0 = Date.parse('2026-08-20T12:00:00.000Z');

const acct = (uuid) => ({
  accountUuid: uuid, email: 'agent@widget.example', handle: 'agent',
  plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
});

/**
 * Wait for the background refresh readRemoteAccounts kicks off.
 *
 * Polled rather than a fixed number of microtask turns. The refresh is an async
 * chain whose length is an implementation detail, and a test that counts turns
 * fails the next time a step is added — which is exactly what happened when the
 * resolver's file read still lived in refresh().
 */
async function settle(read, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (read().length) return;
    await new Promise((r) => setImmediate(r));
  }
}

/* ── configuration ──────────────────────────────────────────────────────── */

test('no configured host means the feature is off and costs nothing', async () => {
  resetRemoteAccounts();
  let asked = 0;
  const out = readRemoteAccounts({ hosts: [], ask: async () => { asked += 1; } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, []);
  assert.equal(asked, 0, 'an unconfigured feature must not spawn ssh');
});

test('hosts come from the environment, comma separated, blanks dropped', () => {
  assert.deepEqual(remoteHosts({ VAULT_HUD_REMOTE_HOSTS: 'sprocket, widget ,,' }),
    ['sprocket', 'widget']);
  assert.deepEqual(remoteHosts({ VAULT_HUD_REMOTE_HOSTS: 'box-2, user@h.example, a_b.c' }),
    ['box-2', 'user@h.example', 'a_b.c']);
  assert.deepEqual(remoteHosts({}), []);
  assert.deepEqual(remoteHosts({ VAULT_HUD_REMOTE_HOSTS: '   ' }), []);
});

test('a host that is really an ssh option is dropped, and said out loud', () => {
  // ssh takes options positionally, so an entry beginning with `-` is read as
  // one: `-oProxyCommand=…` would run an arbitrary command on THIS machine every
  // two minutes. The value comes from .env rather than from anything remote, so
  // this is a guard and not a live hole, but it costs one regex.
  const lines = [];
  const log = (l) => lines.push(l);
  assert.deepEqual(
    remoteHosts({ VAULT_HUD_REMOTE_HOSTS: '-oProxyCommand=touch /tmp/x,spark' }, log),
    ['spark'], 'the good host survives beside the bad one');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ignoring/);
  for (const bad of ['-F/dev/null', '$(id)', 'a b', '`id`', '--', '-', 'a;b', 'a|b']) {
    assert.deepEqual(remoteHosts({ VAULT_HUD_REMOTE_HOSTS: bad }), [], JSON.stringify(bad));
  }
});

test('the guard holds when hosts are passed directly, not only from the env', async () => {
  // A guard that runs on one path only is a guard that will be walked around.
  resetRemoteAccounts();
  let asked = 0;
  const out = readRemoteAccounts({ hosts: ['-oProxyCommand=touch /tmp/x'], ask: async () => { asked += 1; } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, []);
  assert.equal(asked, 0, 'ssh is never spawned for a host that is really an option');
});

/* ── the three states ───────────────────────────────────────────────────── */

test('the first call returns nothing and does not block; the next one has the answer', async () => {
  // The parse runs every ten seconds and an ssh round trip is about a second.
  // Awaiting one here would put a network call on the critical path of every
  // board update, and a sleeping host would stall the whole parse until timeout.
  resetRemoteAccounts();
  const ask = async () => ({ ok: true, account: acct(UUID) });
  assert.deepEqual(readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 }), [],
    'cold read says "not yet" rather than waiting');
  await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 }));
  const [r] = readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 });
  assert.equal(r.reachable, true);
  assert.equal(r.account.accountUuid, UUID);
  assert.equal(r.at, new Date(T0).toISOString());
});

test('a failed check keeps the last good reading and says the check failed', async () => {
  // An unreachable machine is NOT a machine with no account. Collapsing the two
  // is the 2026-08-10 rule: an empty result and an unreachable source must never
  // be the same value in anything that publishes.
  resetRemoteAccounts();
  let fail = false;
  const ask = async () => (fail
    ? { ok: false, error: 'ssh: connect to host sprocket port 22: Host is down' }
    : { ok: true, account: acct(UUID) });
  readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 });
  await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 }));
  fail = true;
  readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 + 10 * 60_000, refreshMs: 1 });
  await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 })
    .filter((r) => r.reachable === false));
  const [r] = readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 + 10 * 60_000, refreshMs: 1e9 });
  assert.equal(r.reachable, false);
  assert.equal(r.account.accountUuid, UUID, 'the last good account survives');
  assert.equal(r.at, new Date(T0).toISOString(), 'and is aged from when it was true');
  assert.match(r.error, /Host is down/);
});

test('a host that has never answered carries no account rather than a guess', async () => {
  resetRemoteAccounts();
  const ask = async () => ({ ok: false, error: 'Permission denied (publickey)' });
  readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 });
  await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 }));
  const [r] = readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 });
  assert.equal(r.reachable, false);
  assert.equal(r.account, null);
  assert.equal(r.at, null);
});

test('unreadable output from the remote is a failure, not an account', async () => {
  resetRemoteAccounts();
  for (const bad of [null, 'a string', 42, []]) {
    resetRemoteAccounts();
    const a = async () => ({ ok: true, account: bad });
    readRemoteAccounts({ hosts: ['sprocket'], ask: a, now: () => T0 });
    await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask: a, now: () => T0, refreshMs: 1e9 }));
    const [r] = readRemoteAccounts({ hosts: ['sprocket'], ask: async () => {}, now: () => T0, refreshMs: 1e9 });
    // A non-object account is passed through by remote.js and rejected at the
    // view, where every other hostile shape is rejected. Either way it must not
    // become a chip.
    assert.deepEqual(remoteSignersFor(UUID, [r], T0), [], JSON.stringify(bad));
  }
});

test('the cache is not re-asked inside the refresh interval', async () => {
  resetRemoteAccounts();
  let asked = 0;
  const ask = async () => { asked += 1; return { ok: true, account: acct(UUID) }; };
  readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 });
  await settle(() => readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0, refreshMs: 1e9 }));
  for (let i = 0; i < 5; i += 1) readRemoteAccounts({ hosts: ['sprocket'], ask, now: () => T0 + 1000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1, 'five board updates, one ssh');
});

/* ── the join, and what it refuses to guess ─────────────────────────────── */

test('a remote is matched to an account by uuid, never by label or id', () => {
  // The remote resolves its own account from its own disk and knows nothing
  // about this machine's enrollment table, so the uuid is the only key both
  // sides hold. It is also what the poller matches on, which is what stops a
  // remote chip and the CURRENT chip naming one account two ways.
  const remotes = [{ host: 'sprocket', account: acct(UUID), at: new Date(T0).toISOString(), reachable: true }];
  assert.deepEqual(remoteSignersFor(UUID, remotes, T0).map((r) => r.host), ['sprocket']);
  assert.deepEqual(remoteSignersFor(OTHER, remotes, T0), []);
  assert.deepEqual(remoteSignersFor(null, remotes, T0), []);
  assert.deepEqual(remoteSignersFor(UUID, null, T0), []);
});

test('a reading older than twice the refresh interval is marked unsure, not dropped', () => {
  const at = new Date(T0).toISOString();
  const remotes = [{ host: 'sprocket', account: acct(UUID), at, reachable: true }];
  assert.equal(remoteSignersFor(UUID, remotes, T0)[0].stale, false);
  assert.equal(remoteSignersFor(UUID, remotes, T0 + REMOTE_STALE_MS - 1)[0].stale, false);
  const old = remoteSignersFor(UUID, remotes, T0 + REMOTE_STALE_MS + 1)[0];
  assert.equal(old.stale, true);
  assert.equal(old.host, 'sprocket', 'still named: the account it reports may still be right');
});

test('an unreachable machine keeps its chip on the account it was last seen on', () => {
  // Found by a planted regression: dropping the signer when the last check
  // failed passed every other test here. It is wrong for the same reason the
  // last good reading is kept at all — the account it names may well still be
  // right, and it is the confidence that lapsed, not the fact. Dropping it makes
  // an unreachable machine and a machine signed into nothing draw one picture.
  const remotes = [{
    host: 'sprocket', account: acct(UUID),
    at: new Date(T0).toISOString(), reachable: false, error: 'Host is down',
  }];
  const [r] = remoteSignersFor(UUID, remotes, T0 + 1000);
  assert.equal(r.host, 'sprocket', 'still on the account it was last seen on');
  assert.equal(r.stale, true, 'and marked, even though the reading itself is fresh');
  assert.match(r.error, /Host is down/);

  // And it reaches the strip the same way, on the right cell.
  const v = usageView(usage, T0 + 1000, remotes);
  assert.deepEqual(v.accounts.find((a) => a.id === 'acctA').remotes.map((x) => x.host), ['sprocket']);
  assert.deepEqual(v.unmatchedRemotes, [], 'it matched a cell, so it is not also listed below');
});

test('remoteSignersFor never throws on a hostile remote list', () => {
  const hostile = [null, undefined, 'x', 42, [], {}, { host: 5 }, { account: 'x' },
    { host: 'a', account: { accountUuid: 7 } }, { host: 'a', account: acct(UUID), at: 'not a date' }];
  const out = remoteSignersFor(UUID, hostile, T0);
  assert.ok(Array.isArray(out));
  for (const r of out) assert.equal(typeof r.host, 'string');
});

/* ── the strip ──────────────────────────────────────────────────────────── */

const usage = {
  updated: new Date(T0).toISOString(),
  currentAccountId: 'acctA',
  accounts: [
    { id: 'acctA', label: 'widget-a', uuid: UUID, plan: 'max', state: 'ok',
      fiveHour: { utilization: 10 }, sevenDay: { utilization: 10 } },
    { id: 'acctB', label: 'widget-b', uuid: OTHER, plan: 'max', state: 'ok',
      fiveHour: { utilization: 10 }, sevenDay: { utilization: 10 } },
  ],
};

test('the strip puts the machine on the account it is actually signed into', () => {
  const remotes = [{ host: 'sprocket', account: acct(OTHER), at: new Date(T0).toISOString(), reachable: true }];
  const v = usageView(usage, T0, remotes);
  assert.deepEqual(v.accounts.find((a) => a.id === 'acctA').remotes, []);
  assert.deepEqual(v.accounts.find((a) => a.id === 'acctB').remotes.map((r) => r.host), ['sprocket']);
  assert.deepEqual(v.unmatchedRemotes, [], 'it matched, so it is not also listed as unmatched');
});

test('a remote on an account this machine never enrolled is listed, not dropped', () => {
  // Dropping it would answer "no remote machine is signed in anywhere" to a
  // question the strip did not actually answer.
  const remotes = [{ host: 'sprocket', account: acct('99999999-0000-4000-8000-000000000000'),
    at: new Date(T0).toISOString(), reachable: true }];
  const v = usageView(usage, T0, remotes);
  assert.equal(v.unmatchedRemotes.length, 1);
  assert.deepEqual(v.unmatchedRemotes[0],
    { host: 'sprocket', uuid8: '99999999', plan: 'max', tier: '20x', reachable: true, error: null });
});

test('a remote that has never answered is listed as unreachable, with the reason', () => {
  const remotes = [{ host: 'sprocket', account: null, at: null, reachable: false,
    error: 'Permission denied (publickey)' }];
  const v = usageView(usage, T0, remotes);
  assert.equal(v.unmatchedRemotes[0].reachable, false);
  assert.equal(v.unmatchedRemotes[0].uuid8, null);
  assert.match(v.unmatchedRemotes[0].error, /publickey/);
});

test('the view is unchanged when no remote is configured', () => {
  const a = usageView(usage, T0);
  const b = usageView(usage, T0, []);
  assert.deepEqual(a.unmatchedRemotes, []);
  for (const acc of a.accounts) assert.deepEqual(acc.remotes, []);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});

test('usageView never throws on a hostile remotes argument', () => {
  for (const r of [null, undefined, 'x', 42, {}, [null], ['x'], [{}]]) {
    const v = usageView(usage, T0, r);
    assert.ok(v && Array.isArray(v.unmatchedRemotes), JSON.stringify(r));
  }
});
