// account.test.js — the account resolver and the tag both surfaces render.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. The vault's verification table was recorded against
// live accounts; the same cases are reproduced here on synthetic ones, because
// the contract between the two implementations is the tag's FORM, not the
// identities it was first measured on. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccount } from '../account.js';
import { accountTag, accountFor, rowSignature } from '../public/runs-view.js';
import { readRuns } from '../runs.js';
import { withLocalAccount } from '../usage.js';

const UUID = 'abcd1234-0000-4000-8000-00000000beef';
const OTHER = 'ef567890-0000-4000-8000-00000000cafe';

/** A config dir holding whichever of the two files a case needs. */
async function configDir({ claude, creds }) {
  const dir = await mkdtemp(join(tmpdir(), 'vhud-acct-'));
  if (claude !== undefined) await writeFile(join(dir, '.claude.json'), claude);
  if (creds !== undefined) {
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', '.credentials.json'), creds);
  }
  return dir;
}

const oauthFile = (over = {}) => JSON.stringify({
  oauthAccount: {
    accountUuid: UUID, emailAddress: 'agent@widget.example',
    organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x',
    ...over,
  },
});
const credsFile = (over = {}) => JSON.stringify({
  claudeAiOauth: {
    subscriptionType: 'claude_max', rateLimitTier: 'default_claude_max_20x',
    accessToken: 'THIS-MUST-NEVER-BE-READ', refreshToken: 'NOR-THIS', ...over,
  },
});

/* ── the resolver ───────────────────────────────────────────────────────── */

test('a live config resolves the uuid, the plan and the tier', async () => {
  const dir = await configDir({ claude: oauthFile(), creds: credsFile() });
  const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.deepEqual(a, {
    accountUuid: UUID, email: 'agent@widget.example', handle: 'agent',
    plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
  });
  assert.equal(accountTag(a), 'abcd1234 · MAX 20x');
  assert.equal(accountTag(a, { label: true }), 'agent@widget · MAX 20x');
  await rm(dir, { recursive: true, force: true });
});

test('credentials alone give the subscription shape and no identity', async () => {
  const dir = await configDir({ creds: credsFile() });
  const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(a.accountUuid, null);
  assert.equal(a.source, 'partial');
  assert.equal(accountTag(a), 'MAX 20x');
  await rm(dir, { recursive: true, force: true });
});

test('a tier is the multiplier or it is nothing: Pro yields no tier', async () => {
  // The first version fell back to the rest of the string, so
  // `default_claude_pro` rendered as `PRO pro` — the plan printed twice, once
  // wearing the tier's slot.
  const dir = await configDir({
    claude: JSON.stringify({ oauthAccount: { organizationType: 'claude_pro',
      organizationRateLimitTier: 'default_claude_pro' } }),
  });
  const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(a.tier, null);
  assert.equal(a.plan, 'pro');
  assert.equal(accountTag(a), 'PRO');
  await rm(dir, { recursive: true, force: true });
});

test('plan and tier come from ONE file, never half from each', async () => {
  // The premise of this field is that the account changes under a running
  // session, and Claude Code rewrites the two files independently. A
  // field-by-field fallback would pair the new account's uuid with the previous
  // account's plan during exactly the switch the field exists to track.
  const dir = await configDir({
    claude: oauthFile({ organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_pro' }),
    creds: credsFile({ subscriptionType: 'claude_max', rateLimitTier: 'default_claude_max_20x' }),
  });
  const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(a.plan, 'pro', 'the config file owns the account, so it owns the plan');
  assert.equal(a.tier, null, 'and the tier, even when the credentials file has a better one');
  await rm(dir, { recursive: true, force: true });
});

test('malformed JSON, a non-object oauthAccount and nothing readable all read as no account', async () => {
  const cases = [
    { claude: '{not json' },
    { claude: JSON.stringify({ oauthAccount: 'a string' }) },
    { claude: JSON.stringify({ oauthAccount: ['an', 'array'] }) },
    {},
  ];
  for (const c of cases) {
    const dir = await configDir(c);
    const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(a.source, 'none', JSON.stringify(c));
    assert.equal(accountTag(a), 'NO ACCOUNT');
    await rm(dir, { recursive: true, force: true });
  }
});

test('an API key in the environment is a flag beside the account, never the payer', async () => {
  // Disk cannot settle who is paying: an interactive session has to approve the
  // key once, and a rejected key leaves the subscription paying. The first
  // version reported `API · api-key` and named the wrong payer on every write.
  const dir = await configDir({ claude: oauthFile() });
  for (const v of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir, [v]: 'sk-not-a-real-key' } });
    assert.equal(a.apiKeyVar, v);
    assert.equal(a.accountUuid, UUID, 'the account still resolves');
    assert.equal(accountTag(a), 'abcd1234 · MAX 20x +KEY');
  }
  // AUTH_TOKEN outranks API_KEY and is checked first.
  const both = await resolveAccount({ env: {
    CLAUDE_CONFIG_DIR: dir, ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b' } });
  assert.equal(both.apiKeyVar, 'ANTHROPIC_AUTH_TOKEN');
  // Whitespace is not a value.
  const blank = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: '   ' } });
  assert.equal(blank.apiKeyVar, null);
  await rm(dir, { recursive: true, force: true });
});

test('the resolver never returns a token, on any branch', async () => {
  // .credentials.json holds live tokens and is opened for exactly two
  // non-secret fields. This asserts the whole returned object, so a field added
  // later that widens the read fails here rather than at a push.
  const dir = await configDir({ claude: oauthFile(), creds: credsFile() });
  const a = await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } });
  const flat = JSON.stringify(a);
  assert.ok(!flat.includes('MUST-NEVER-BE-READ'), flat);
  assert.ok(!flat.includes('NOR-THIS'), flat);
  assert.deepEqual(Object.keys(a).sort(),
    ['accountUuid', 'apiKeyVar', 'email', 'handle', 'plan', 'source', 'tier']);
  await rm(dir, { recursive: true, force: true });
});

test('a second call sees a switched account, because nothing is captured at import', async () => {
  // The daemon that imports this stays up for days. A value captured once is the
  // same staleness the whole field exists to avoid: the signed-in account was
  // observed changing inside one session.
  const dir = await configDir({ claude: oauthFile() });
  assert.equal((await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } })).accountUuid, UUID);
  await writeFile(join(dir, '.claude.json'), oauthFile({ accountUuid: OTHER }));
  assert.equal((await resolveAccount({ env: { CLAUDE_CONFIG_DIR: dir } })).accountUuid, OTHER);
  await rm(dir, { recursive: true, force: true });
});

/* ── the tag: hostile input ─────────────────────────────────────────────── */

test('accountTag never throws, whatever it is handed', () => {
  // runs.js drops a malformed account to null and the object is JSON a language
  // model pasted into a run file, so this is handed garbage by design.
  const hostile = [
    null, undefined, 'a string', 42, 0, true, [], [1, 2], {},
    { source: 'none' },
    { plan: 42, tier: [], email: {}, accountUuid: 7, handle: null, source: 'oauth' },
    { plan: '', tier: '', accountUuid: '', email: '', source: 'oauth' },
    { accountUuid: UUID, apiKeyVar: 99 },
    { email: 'no-at-sign', source: 'oauth' },
    { get plan() { throw new Error('a getter that throws'); } },
  ];
  for (const h of hostile) {
    let out;
    if (h && typeof h === 'object' && 'plan' in h) {
      // The throwing getter is the one case allowed to be caught by the caller;
      // every other input must render.
      try { out = accountTag(h); } catch { out = null; }
      if (out === null) continue;
    } else {
      out = accountTag(h);
    }
    assert.equal(typeof out, 'string', JSON.stringify(h));
    assert.ok(out.length > 0, JSON.stringify(h));
    for (const k of [{ label: true }, { label: false }, {}]) {
      assert.equal(typeof accountTag(h, k), 'string');
    }
  }
});

test('an account that resolved something but renders to nothing says so', () => {
  // A blank slot is how this defect would hide. UNKNOWN ACCOUNT is a state
  // nobody should ever see, which is the point of naming it.
  assert.equal(accountTag({ source: 'oauth' }), 'UNKNOWN ACCOUNT');
  assert.equal(accountTag({ source: 'partial', plan: null, tier: null }), 'UNKNOWN ACCOUNT');
});

test('a malformed address never becomes a label with no account in it', () => {
  // Two defects, both in the label branch, both from the same wrong instinct:
  // repair the address rather than refuse it. Guarding only on `@` being
  // present threw on a string without one; guarding only on the domain rendered
  // `@gmail` for `@gmail.com`, which reads like an identity and names nobody.
  // The rule is that BOTH halves must be there or the address is not used.
  for (const email of ['no-at-sign', '@gmail.com', 'agent@', '@', '', 'a@.com']) {
    const bare = accountTag({ email, source: 'oauth' }, { label: true });
    assert.equal(bare, 'NO ACCOUNT' === bare ? bare : 'UNKNOWN ACCOUNT',
      `${JSON.stringify(email)} rendered ${JSON.stringify(bare)}`);
    // With a real identity beside it the row still names the account, from the
    // uuid: the address is the part that is unusable, not the account.
    assert.equal(
      accountTag({ accountUuid: UUID, email, plan: 'max', tier: '20x', source: 'oauth' }, { label: true }),
      'abcd1234 · MAX 20x', JSON.stringify(email));
  }
  // A real address still resolves, and so does one with extra dots.
  assert.equal(accountTag({ email: 'agent@widget.example', source: 'oauth' }, { label: true }), 'agent@widget');
  assert.equal(accountTag({ email: 'agent@a.b.c', source: 'oauth' }, { label: true }), 'agent@a');
});

/* ── runs.js: the field on a run file ───────────────────────────────────── */

const runFile = (over = {}) => JSON.stringify({
  schema: 1, runId: 'widget-1', project: 'widget', goal: 'Widget goal',
  machine: 'laptop', state: 'running', note: 'n', units: [], ...over,
});

async function vaultWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'vhud-acctrun-'));
  await mkdir(join(root, '15-Runs'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '15-Runs', name), body);
  }
  return root;
}

test('a run file with no account parses exactly as before, and carries null', async () => {
  // Purely additive. Nearly every file in the archive predates the field, and a
  // reader that does not know it must be unchanged by it.
  const root = await vaultWith({ 'a.json': runFile() });
  const [r] = await readRuns(root);
  assert.equal(r.account, null);
  assert.equal(r.runId, 'widget-1');
  assert.equal(r.goal, 'Widget goal');
  await rm(root, { recursive: true, force: true });
});

test('a malformed account costs the tag, never the row and never the parse', async () => {
  const bad = ['"a string"', '42', '[]', 'null', 'true'];
  const root = await vaultWith(Object.fromEntries(
    bad.map((v, i) => [`b${i}.json`, runFile({ runId: `widget-${i}`, account: JSON.parse(v) })]),
  ));
  const runs = await readRuns(root);
  assert.equal(runs.length, bad.length, 'every row survives');
  for (const r of runs) {
    assert.equal(r.account, null);
    assert.equal(r.goal, 'Widget goal', 'the rest of the row is untouched');
  }
  await rm(root, { recursive: true, force: true });
});

test('every account field is checked to a string or null', async () => {
  const root = await vaultWith({
    'a.json': runFile({ account: {
      accountUuid: 42, email: [], handle: {}, plan: true, tier: 0, apiKeyVar: null,
      source: 'oauth', accessToken: 'MUST-NOT-SURVIVE',
    } }),
  });
  const [r] = await readRuns(root);
  assert.deepEqual(r.account, {
    accountUuid: null, email: null, handle: null, plan: null, tier: null,
    apiKeyVar: null, source: 'none',
  });
  assert.ok(!JSON.stringify(r.account).includes('MUST-NOT-SURVIVE'),
    'the whitelist drops anything the schema does not name');
  assert.equal(accountTag(r.account), 'NO ACCOUNT');
  await rm(root, { recursive: true, force: true });
});

test('source is derived from what landed, never trusted from the file', async () => {
  // A writer pastes `source` beside the fields it describes, so the two can
  // arrive contradicting each other. `source: "oauth"` over a uuid that did not
  // survive the type check reads as a promise of an identity that is not there.
  const root = await vaultWith({
    'a.json': runFile({ runId: 'widget-a', account: { source: 'oauth', accountUuid: 42, plan: 'max' } }),
    'b.json': runFile({ runId: 'widget-b', account: { source: 'none', accountUuid: UUID, plan: 'max', tier: '20x' } }),
  });
  const [a, b] = await readRuns(root);
  assert.equal(a.account.source, 'partial', 'no uuid survived, but a plan did');
  assert.equal(b.account.source, 'oauth', 'a uuid is there whatever the file claimed');
  assert.equal(accountTag(b.account), 'abcd1234 · MAX 20x');
  await rm(root, { recursive: true, force: true });
});

test('an absent account and one that resolved nothing are different values', async () => {
  // Null is a run file written before the field existed. `source: "none"` is a
  // writer that looked and found nothing, which the row is entitled to say.
  const root = await vaultWith({
    'a.json': runFile({ runId: 'widget-a' }),
    'b.json': runFile({ runId: 'widget-b', account: { source: 'none' } }),
  });
  const [a, b] = await readRuns(root);
  assert.equal(a.account, null);
  assert.equal(b.account.source, 'none');
  assert.equal(accountTag(b.account), 'NO ACCOUNT');
  await rm(root, { recursive: true, force: true });
});

test('a handle is derived from the address when the writer pasted only the address', async () => {
  const root = await vaultWith({ 'a.json': runFile({ account: {
    accountUuid: UUID, email: 'agent@widget.example', plan: 'max', tier: '20x' } }) });
  const [r] = await readRuns(root);
  assert.equal(r.account.handle, 'agent');
  assert.equal(accountTag(r.account, { label: true }), 'agent@widget · MAX 20x');
  await rm(root, { recursive: true, force: true });
});

/* ── accountFor: the join, and who wins ─────────────────────────────────── */

const usageWith = (over = {}) => ({
  currentAccountId: 'acctA',
  accounts: [
    { id: 'acctA', label: 'widget-a', uuid: UUID, plan: 'max' },
    { id: 'acctB', label: 'widget-b', uuid: OTHER, plan: 'max' },
  ],
  ...over,
});
const fileAcct = (uuid) => ({
  accountUuid: uuid, email: 'agent@widget.example', handle: 'agent',
  plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
});

test('a run file uuid resolves to the enrollment row the usage strip shows', () => {
  const out = accountFor({ account: fileAcct(OTHER) }, usageWith());
  assert.equal(out.id, 'acctB');
  assert.equal(out.label, 'widget-b');
  assert.equal(accountTag(out), 'acctB · MAX 20x', 'the phone form is the enrollment id');
  assert.equal(accountTag(out, { label: true }), 'widget-b · MAX 20x', 'the desktop form is the label');
});

test('an unenrolled account degrades to its own tag rather than breaking', () => {
  const out = accountFor({ account: fileAcct('00000000-dead-4000-8000-000000000000') }, usageWith());
  assert.equal(out.id, undefined);
  assert.equal(accountTag(out), '00000000 · MAX 20x');
});

test('the poller wins on a run with a session on this machine', () => {
  // The run file names acctB; the poller says the CLI is on acctA right now.
  // The file was stamped before a mid-session switch.
  const out = accountFor({ account: fileAcct(OTHER), session: { pid: 1 } }, usageWith());
  assert.equal(out.id, 'acctA');
  assert.equal(out.accountUuid, UUID);
});

test('nothing is carried across from the account the poller overrode', () => {
  // The plan and tier in the file describe the account the file names. Pairing
  // them with a different account's id produces a row wrong in a way no field
  // admits to.
  const out = accountFor({ account: fileAcct(OTHER), session: { pid: 1 } }, usageWith());
  assert.equal(out.tier, null, 'the enrollment row has no tier, so the row shows none');
  assert.equal(out.email, null);
  assert.equal(out.handle, null);
});

test('the poller does NOT win on a run from another machine', () => {
  // The poller observes the CLI on the machine the daemon runs on. A run with no
  // linked session is not running here, and stamping this machine's account onto
  // it is exactly the error the field exists to prevent.
  const out = accountFor({ machine: 'sprocket', account: fileAcct(OTHER) }, usageWith());
  assert.equal(out.id, 'acctB', 'its own account, resolved');
  assert.equal(out.tier, '20x', 'and its own shape, untouched');
});

test('a local run whose file carries no account still gets one, from the poller', () => {
  // Every run on this machine gains the tag without any agent writing the field.
  const out = accountFor({ session: { pid: 1 } }, usageWith());
  assert.equal(out.id, 'acctA');
  assert.equal(accountTag(out), 'acctA · MAX');
});

test('a run with neither an account nor a poller answer renders no tag at all', () => {
  assert.equal(accountFor({ machine: 'sprocket' }, usageWith()), null);
  assert.equal(accountFor({ session: { pid: 1 } }, { accounts: [], currentAccountId: null }), null);
  assert.equal(accountFor(null, null), null);
  assert.equal(accountFor({ account: fileAcct(UUID) }, null).id, undefined,
    'no poller at all: the file is the only source');
});

test('accountFor never throws on a hostile run or a hostile usage snapshot', () => {
  const runs = [null, undefined, {}, { account: 'a string' }, { account: [] },
    { account: { accountUuid: 42 }, session: {} }];
  const usages = [null, undefined, {}, { accounts: 'not an array' },
    { accounts: [null, 'x'], currentAccountId: 'acctA' },
    { accounts: [{}], currentAccountId: 'acctA' }];
  for (const r of runs) {
    for (const u of usages) {
      const out = accountFor(r, u);
      assert.ok(out === null || typeof out === 'object');
      assert.equal(typeof accountTag(out), 'string');
    }
  }
});

/* ── the disk fallback for currentAccountId ─────────────────────────────── */

test('withLocalAccount fills a null currentAccountId from disk', async () => {
  const u = usageWith({ currentAccountId: null });
  const out = await withLocalAccount(u, async () => ({ accountUuid: OTHER }));
  assert.equal(out.currentAccountId, 'acctB');
});

test('withLocalAccount never overrides a live answer', async () => {
  const out = await withLocalAccount(usageWith(), async () => ({ accountUuid: OTHER }));
  assert.equal(out.currentAccountId, 'acctA', 'the endpoint reading is closer to the truth');
});

test('a disk account matching no enrollment leaves the panel saying nothing', async () => {
  // Inventing a row would put an account on the panel with no quota behind it.
  const u = usageWith({ currentAccountId: null });
  const out = await withLocalAccount(u, async () => ({ accountUuid: 'unenrolled-uuid' }));
  assert.equal(out.currentAccountId, null);
});

test('a resolver that throws or returns nothing costs the fallback, never the panel', async () => {
  const u = usageWith({ currentAccountId: null });
  for (const read of [
    async () => { throw new Error('keychain locked'); },
    async () => null,
    async () => ({ accountUuid: null }),
    async () => ({}),
  ]) {
    const out = await withLocalAccount(u, read);
    assert.equal(out.currentAccountId, null);
    assert.equal(out.accounts.length, 2, 'the accounts survive');
  }
  assert.equal(await withLocalAccount(null, async () => ({ accountUuid: UUID })), null);
});

/* ── the desktop row repaints when the account moves ────────────────────── */

const sigRun = (over = {}) => ({
  runId: 'widget-1', project: 'widget', goal: 'g', machine: 'laptop', note: '',
  state: 'running', started: '2026-08-20T14:00:00.000Z',
  updated: '2026-08-20T14:00:00.000Z', wrote: '2026-08-20T14:00:00.000Z',
  units: [], needsInput: [], blockers: [], ...over,
});
const SIG_NOW = Date.parse('2026-08-20T14:05:00.000Z');

test('the row signature moves when the account the row shows moves', () => {
  // app.js rebuilds a row only when its signature changes. Every clock-derived
  // or resolved string the row renders has to appear there, or the row freezes
  // showing it — a unit timer read "running 5m" for nineteen minutes on exactly
  // this defect.
  const a = sigRun({ account: fileAcct(UUID) });
  const b = sigRun({ account: fileAcct(OTHER) });
  assert.notEqual(rowSignature(a, SIG_NOW), rowSignature(b, SIG_NOW));
});

test('the row signature moves when the POLLER moves under an unchanged run file', () => {
  // The case the raw field would miss entirely: the run file is byte-identical
  // and the account it is spending changed, because the operator switched
  // accounts mid-session and the poller saw it.
  const r = sigRun({ account: fileAcct(UUID), session: { pid: 1 } });
  const before = rowSignature(r, SIG_NOW, usageWith({ currentAccountId: 'acctA' }));
  const after = rowSignature(r, SIG_NOW, usageWith({ currentAccountId: 'acctB' }));
  assert.notEqual(before, after);
});

test('a caller that passes no usage still gets a signature, and no throw', () => {
  // Optional, so no existing caller loses rows by not knowing about it.
  assert.equal(typeof rowSignature(sigRun(), SIG_NOW), 'string');
  assert.equal(typeof rowSignature(sigRun({ account: fileAcct(UUID) }), SIG_NOW), 'string');
});
