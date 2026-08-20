// projection.test.js — nothing confidential may reach the published page.
//
// The page is deployed to an UNAUTHENTICATED URL. Until toPublicBoard existed
// there was no seam at all: build() rendered from the same objects the desktop
// uses, and what got published was whatever a hand-written template happened to
// interpolate.
//
// The test this replaces could not fail. It injected a session with `where: ''`
// and asserted the output contained no home-directory prefix — a fixture with no
// path producing no path. So every case here is seeded with a value that IS
// confidential and would be rendered under the old behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPublicBoard, build, boardDigest } from '../status-page/build.js';

const NOW = Date.parse('2026-08-11T18:00:00Z');

/** A board carrying every kind of value that must not be published. */
function hostileBoard() {
  const session = {
    pid: 4242,
    tty: '/dev/ttys009',
    since: '2026-08-11T14:00:00Z',
    project: 'projectcodename',
    where: 'Desktop/repos/projectcodename',
    name: 'projectcodename-4e',
    status: 'running',
    lastTool: 'mcp__playwright__browser_close',
    branch: 'feature/SECRET-1234-rename',
    movedAt: '2026-08-11T17:40:00Z',
    agentsCapped: 3,
    agents: [
      { id: 'aaaaaaaa', label: 'Fix the delete path in lib/auth/scope.ts', state: 'running' },
      { id: 'bbbbbbbb', label: 'Review what Dana said about the pricing model', state: 'done' },
    ],
    context: '',
  };
  const run = {
    runId: 'r-1', project: 'p', goal: 'g', machine: 'laptop', state: 'running',
    note: '', tty: '', started: '2026-08-11T14:00:00Z', updated: '2026-08-11T17:00:00Z',
    wrote: '2026-08-11T17:00:00Z', units: [], needsInput: [], blockers: [],
    // Which Claude account the run is spending. The address and the handle are
    // loopback-only, the same rule the usage section's label already follows.
    account: {
      accountUuid: 'abcd1234-0000-4000-8000-00000000beef',
      email: 'sprocketeer@firmname.example', handle: 'sprocketeer',
      plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
    },
    session: { ...session },
  };
  // The enrollment table the uuid joins through. Its labels are operator free
  // text and the first real ones were email addresses, which is why the usage
  // projection drops them.
  const usage = {
    updated: '2026-08-11T17:55:00Z',
    currentAccountId: null,
    accounts: [{
      id: 'acctA', label: 'sprocketeer@firmname', uuid: 'abcd1234-0000-4000-8000-00000000beef',
      plan: 'max', state: 'ok', error: null, fetchedAt: '2026-08-11T17:55:00Z',
      fiveHour: { utilization: 12.4, resetsAt: '2026-08-11T20:00:00Z' },
      sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, sevenDayFable: null,
    }],
  };
  return { active: [run], finished: [], unpublished: [session], usage, skipped: 0 };
}

/** Every substring that must not survive the projection. */
// The session NAME is deliberately absent from this list as of 2026-08-11: it is
// published by the operator's decision. Everything else here stays forbidden, and
// the name being publishable does not make the path, the branch or a sub-agent
// label publishable — those are the fields this list exists for.
const FORBIDDEN = [
  'Desktop/repos/projectcodename',
  'mcp__playwright__browser_close',
  'browser_close',
  'feature/SECRET-1234-rename',
  'SECRET-1234',
  'lib/auth/scope.ts',
  'Dana',
  '/dev/ttys009',
  // The account's identity. The enrollment id is publishable and these are not:
  // the publish gate blocked this page once over email-address labels on the
  // usage panel, and the same rule binds a run row.
  'sprocketeer@firmname.example',
  'sprocketeer@firmname',
  'sprocketeer',
  // The uuid is spent inside the projection, resolving the enrollment id, and
  // dropped. Publishing it would put the key on the page with nothing left for
  // it to unlock.
  'abcd1234-0000-4000-8000-00000000beef',
  'abcd1234',
];

test('the projection drops every confidential field', () => {
  const json = JSON.stringify(toPublicBoard(hostileBoard(), NOW));
  for (const bad of FORBIDDEN) {
    assert.ok(!json.includes(bad), `"${bad}" survived the projection`);
  }
});

test('the session name is published, and nothing else identifying rides with it', () => {
  const out = toPublicBoard(hostileBoard(), NOW);
  const s = out.unpublished[0];
  assert.equal(s.name, 'projectcodename-4e', 'the name did not reach the page');
  // The reason the name is allowed is that run goals already print the same
  // codename in full. That is not a licence for the fields around it.
  assert.equal(s.where, undefined);
  assert.equal(s.branch, undefined);
  assert.equal(s.lastTool, undefined);
  assert.equal(s.title, undefined);
  assert.equal(s.pid, undefined);
  assert.equal(s.agents, undefined);
});

test('a renamed session reaches the phone, because the digest sees the name', () => {
  const a = hostileBoard();
  const b = hostileBoard();
  b.unpublished[0].name = 'projectcodename-9z';
  assert.notEqual(boardDigest(a, NOW), boardDigest(b, NOW),
    'a rename fired no deploy, so the phone would show the old name forever');
});

test('the projection keeps what the phone is actually read for', () => {
  const out = toPublicBoard(hostileBoard(), NOW);
  const s = out.unpublished[0];
  assert.equal(s.status, 'running');
  assert.equal(s.agentsOut, 1, 'one agent still running');
  assert.equal(s.agentsTotal, 2);
  assert.equal(s.agentsCapped, 3, 'a hidden excess must stay visible as a number');
  // Capped at 2. Uncapped it advanced once per five minutes forever, so idle
  // sessions alone kept the digest moving and pinned the deploy rate.
  assert.equal(s.silentBucket, 2, '20 minutes silent, bucketed at five and capped');
  assert.equal(out.active[0].goal, 'g', 'the goal is declared and is meant to publish');
  assert.equal(out.active[0].session.status, 'running');
});

test('a run row keeps no session identity either', () => {
  const json = JSON.stringify(toPublicBoard(hostileBoard(), NOW).active[0]);
  assert.ok(!json.includes('4242'), 'the pid reached a run row');
  assert.ok(!json.includes('ttys009'));
});

test('the rendered page contains none of the forbidden values', async () => {
  // This RENDERS. The version it replaces passed `board` and `dryRun` options
  // that `build()` does not accept, so `vault: null` fell through to the default
  // vault, build threw, `.catch(() => null)` swallowed it, and the assertion
  // re-ran the previous test's check on a JSON string. It could not fail, and on
  // a shell exporting VAULT_HUD_VAULT it would have built from the real vault
  // and overwritten status-page/status.html, because outDir defaults to the repo.
  const vault = await mkdtemp(join(tmpdir(), 'vh-proj-'));
  const out = await mkdtemp(join(tmpdir(), 'vh-proj-out-'));
  await mkdir(join(vault, '15-Runs'), { recursive: true });
  const b = hostileBoard();
  // A run file carrying the session that must not be published.
  await writeFile(join(vault, '15-Runs', 'r-1.json'), JSON.stringify({
    schema: 1, runId: 'r-1', project: 'p', goal: 'g', machine: 'laptop',
    state: 'running', note: '', started: '2026-08-11T14:00:00Z',
    updated: '2026-08-11T17:00:00Z', needsInput: [], blockers: [], units: [],
  }));
  try {
    const html = await readFile(await build({
      vault, outDir: out, now: NOW, sessions: [b.unpublished[0]],
    }), 'utf8');
    for (const bad of FORBIDDEN) {
      assert.ok(!html.includes(bad), `"${bad}" reached the rendered page`);
    }
    // And the render actually happened, so the assertions above meant something.
    assert.match(html, /<article class="run/, 'nothing was rendered');
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('the digest cannot move on a field the page may not publish', () => {
  const a = hostileBoard();
  const b = hostileBoard();
  b.unpublished[0].branch = 'a-totally-different-branch';
  b.unpublished[0].lastTool = 'Bash';
  b.unpublished[0].where = 'Desktop/repos/somewhere-else';
  assert.equal(boardDigest(a, NOW), boardDigest(b, NOW),
    'an unpublishable field moved the digest, so it would fire a deploy that changes nothing');
});

test('the digest does move when a published field changes', () => {
  const a = hostileBoard();
  const b = hostileBoard();
  b.unpublished[0].status = 'stalled';
  assert.notEqual(boardDigest(a, NOW), boardDigest(b, NOW),
    'a state change did not fire a deploy, so the phone would show it wrong indefinitely');
});

test('silence is bucketed, so it neither freezes nor churns', () => {
  const near = hostileBoard();
  const same = hostileBoard();
  // Two minutes apart, inside one five-minute bucket.
  same.unpublished[0].movedAt = '2026-08-11T17:38:00Z';
  assert.equal(boardDigest(near, NOW), boardDigest(same, NOW), 'churned inside a bucket');

  const fresh = hostileBoard();
  fresh.unpublished[0].movedAt = '2026-08-11T17:59:00Z';   // one minute silent
  assert.notEqual(boardDigest(near, NOW), boardDigest(fresh, NOW),
    'a session going quiet did not move the digest');
});

// The cap is the thing that stops an idle machine deploying all night.
test('silence stops moving the digest once it is long', () => {
  const twenty = hostileBoard();
  const anHour = hostileBoard();
  anHour.unpublished[0].movedAt = '2026-08-11T17:00:00Z';
  const aDay = hostileBoard();
  aDay.unpublished[0].movedAt = '2026-08-10T18:00:00Z';
  assert.equal(boardDigest(twenty, NOW), boardDigest(anHour, NOW));
  assert.equal(boardDigest(twenty, NOW), boardDigest(aDay, NOW),
    'a terminal left open overnight kept firing deploys');
});

/** A fan-out with enough returned agents for the estimator to have samples. */
function fanoutBoard(outCount = 1, doneCount = 6) {
  const b = hostileBoard();
  const mins = (n) => new Date(NOW - n * 60_000).toISOString();
  b.unpublished[0].agents = [
    // Each returned agent took ten minutes.
    ...Array.from({ length: doneCount }, (_, i) => ({
      id: `d${i}`, state: 'done', label: 'a returned agent',
      started: mins(60), movedAt: mins(50),
    })),
    ...Array.from({ length: outCount }, (_, i) => ({
      id: `o${i}`, state: 'running', label: 'an agent still out', started: mins(2),
    })),
  ];
  return b;
}

test('a fan-out publishes how long it has left, bucketed', () => {
  const s = toPublicBoard(fanoutBoard(), NOW).unpublished[0];
  // Ten-minute mean, two minutes elapsed on the one still out.
  assert.equal(s.etaMins, 10, 'the estimate did not reach the page');
  assert.equal(s.agentsOut, 1);
});

test('a fan-out with nothing out publishes no estimate', () => {
  const s = toPublicBoard(fanoutBoard(0, 6), NOW).unpublished[0];
  assert.equal(s.etaMins, null, 'estimated time left for work that has finished');
});

test('the estimate never carries an agent label to the page', () => {
  const json = JSON.stringify(toPublicBoard(fanoutBoard(), NOW));
  assert.ok(!json.includes('an agent still out'), 'an agent label rode in on the estimate');
  assert.ok(!json.includes('a returned agent'));
});

test('the estimate moves the digest, so the phone cannot show it wrong forever', () => {
  const near = fanoutBoard(1, 6);
  const far = fanoutBoard(1, 6);
  // Same shape, but each returned agent took an hour rather than ten minutes.
  far.unpublished[0].agents = far.unpublished[0].agents.map((a) => (a.state === 'done'
    ? { ...a, started: new Date(NOW - 120 * 60_000).toISOString() } : a));
  assert.notEqual(boardDigest(near, NOW), boardDigest(far, NOW));
});

test('the estimate is snapped to a step, so it does not fire a deploy every tick', () => {
  // Two long fan-outs a few minutes apart. A fixed five-minute bucket moved the
  // digest here; the widening scale does not, because up at the hour mark the
  // steps are fifteen minutes wide and nothing that far out is a decision.
  const long = (elapsedMins) => {
    const b = fanoutBoard(1, 6);
    b.unpublished[0].agents = b.unpublished[0].agents.map((a) => (a.state === 'done'
      ? { ...a, started: new Date(NOW - 120 * 60_000).toISOString(),
        movedAt: new Date(NOW - 60 * 60_000).toISOString() }
      : { ...a, started: new Date(NOW - elapsedMins * 60_000).toISOString() }));
    return b;
  };
  assert.equal(boardDigest(long(2), NOW), boardDigest(long(5), NOW),
    'three minutes of drift fired a deploy');
});

test('the scale is finest where it changes what you do', () => {
  // Near the end the steps are five minutes wide; an hour out they are fifteen.
  const at = (leftMins) => {
    const b = fanoutBoard(1, 6);
    b.unpublished[0].agents = b.unpublished[0].agents.map((a) => (a.state === 'done'
      ? { ...a, started: new Date(NOW - leftMins * 60_000).toISOString(), movedAt: new Date(NOW).toISOString() }
      : { ...a, started: new Date(NOW).toISOString() }));
    return toPublicBoard(b, NOW).unpublished[0].etaMins;
  };
  assert.equal(at(4), 5, 'four minutes left should read as five, not rounded away');
  assert.equal(at(12), 15);
  assert.equal(at(200), 120, 'anything beyond the top step reads as the top step');
});

test('projecting an already-projected board keeps the estimate', () => {
  const once = toPublicBoard(fanoutBoard(), NOW);
  const twice = toPublicBoard(once, NOW);
  assert.equal(twice.unpublished[0].etaMins, once.unpublished[0].etaMins);
});

// The operator caught "<1m–<1m left" beside an agent showing +19m. The estimator
// clamped a negative remainder to zero, so the one case where it knows least is
// the one it sounded most certain about.
test('an agent past every sample reports an overrun, not a countdown', () => {
  const b = fanoutBoard();
  // Six returned at ten minutes each; the one still out has been going an hour.
  b.unpublished[0].agents = b.unpublished[0].agents.map((a) => (a.state === 'running'
    ? { ...a, started: new Date(NOW - 60 * 60_000).toISOString() } : a));
  const s = toPublicBoard(b, NOW).unpublished[0];
  assert.equal(s.etaOver, true, 'an overrun was not reported');
  assert.equal(s.etaMins, null, 'an overrun still published a countdown');
});

test('an overrun moves the digest, so the phone learns about it', () => {
  const normal = fanoutBoard();
  const overrun = fanoutBoard();
  overrun.unpublished[0].agents = overrun.unpublished[0].agents.map((a) => (a.state === 'running'
    ? { ...a, started: new Date(NOW - 60 * 60_000).toISOString() } : a));
  assert.notEqual(boardDigest(normal, NOW), boardDigest(overrun, NOW));
});

// The operator reported never seeing a time estimate. Cause: agent runtimes are
// heavy-tailed (64 returned agents, mean 8m, max 34m), and the old estimator used
// mean+sd, which an agent passes early — so the row flipped to "past the usual"
// while ordinary runway remained, on almost every real fan-out.
test('a heavy tail still yields a forward estimate, not an overrun', () => {
  const b = fanoutBoard();
  const mins = (n) => new Date(NOW - n * 60_000).toISOString();
  // Mostly quick, one long: mean well below the slowest, as on the real machine.
  const spans = [5, 5, 6, 6, 7, 34];
  b.unpublished[0].agents = [
    ...spans.map((d, i) => ({
      id: `d${i}`, state: 'done', label: 'x',
      started: mins(90), movedAt: mins(90 - d),
    })),
    // Twenty minutes in: past the mean, nowhere near the slowest that returned.
    { id: 'o', state: 'running', label: 'x', started: mins(20) },
  ];
  const s = toPublicBoard(b, NOW).unpublished[0];
  assert.equal(s.etaOver, false, 'called an ordinary agent an overrun');
  assert.ok(s.etaMins > 0, 'no forward estimate was published');
});

/* ── the account tag on a published run row ─────────────────────────────── */

test('the run account is projected to an enrollment id and nothing else', () => {
  const p = toPublicBoard(hostileBoard(), NOW);
  assert.deepEqual(p.active[0].account, {
    id: 'acctA', plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
  });
  // Named individually as well as through FORBIDDEN, so the reason each one is
  // gone survives a future edit to that list.
  assert.equal(p.active[0].account.email, undefined);
  assert.equal(p.active[0].account.handle, undefined);
  assert.equal(p.active[0].account.accountUuid, undefined);
  assert.equal(p.usage.accounts[0].uuid, undefined, 'the key does not ride to the page');
  assert.equal(p.usage.accounts[0].label, undefined);
});

test('projecting an already-projected board keeps the account', () => {
  // boardDigest hashes the projection and documents itself as doing so, which
  // invites a second pass. Without idempotency the second pass finds no uuid to
  // resolve from and would blank the id, so the digest could never move on the
  // account again. Same requirement as agentsOut.
  const once = toPublicBoard(hostileBoard(), NOW);
  const twice = toPublicBoard(once, NOW);
  assert.deepEqual(twice.active[0].account, once.active[0].account);
});

test('the digest moves when the account does, and not otherwise', () => {
  const a = hostileBoard();
  const b = hostileBoard();
  b.active[0].account = { ...b.active[0].account, accountUuid: 'ffffffff-0000-4000-8000-00000000feed' };
  assert.notEqual(boardDigest(a, NOW), boardDigest(b, NOW),
    'a run that switched account must reach the phone');
  const c = hostileBoard();
  c.active[0].account = { ...c.active[0].account, email: 'someone-else@firmname.example' };
  assert.equal(boardDigest(a, NOW), boardDigest(c, NOW),
    'a field the page may not publish must not fire a deploy');
});

test('a run whose file predates the field publishes no account and renders no tag', () => {
  const b = hostileBoard();
  delete b.active[0].account;
  delete b.usage;
  assert.equal(toPublicBoard(b, NOW).active[0].account, null);
});

test('the account never reaches the rendered page as anything but an id', async () => {
  // RENDERS, with its own enrollment table, so this cannot pass by reading a
  // machine that happens to have no accounts enrolled. The data dir is
  // redirected for the same reason the vault is: a test that reads the real one
  // asserts something different on every machine.
  const vault = await mkdtemp(join(tmpdir(), 'vh-acct-'));
  const out = await mkdtemp(join(tmpdir(), 'vh-acct-out-'));
  const data = await mkdtemp(join(tmpdir(), 'vh-acct-data-'));
  await mkdir(join(vault, '15-Runs'), { recursive: true });
  await writeFile(join(vault, '15-Runs', 'r-1.json'), JSON.stringify({
    schema: 1, runId: 'r-1', project: 'p', goal: 'g', machine: 'laptop',
    state: 'running', note: '', started: '2026-08-11T14:00:00Z',
    updated: '2026-08-11T17:00:00Z', needsInput: [], blockers: [], units: [],
    account: {
      accountUuid: 'abcd1234-0000-4000-8000-00000000beef',
      email: 'sprocketeer@firmname.example', handle: 'sprocketeer',
      plan: 'max', tier: '20x', apiKeyVar: null, source: 'oauth',
    },
  }));
  await writeFile(join(data, 'usage.json'), JSON.stringify({
    schema: 1, updated: '2026-08-11T17:55:00Z', currentAccountId: null,
    accounts: [{
      id: 'acctA', label: 'sprocketeer@firmname', uuid: 'abcd1234-0000-4000-8000-00000000beef',
      plan: 'max', state: 'ok', error: null, fetchedAt: '2026-08-11T17:55:00Z',
      fiveHour: { utilization: 12.4, resetsAt: '2026-08-11T20:00:00Z' },
    }],
  }));
  const prevData = process.env.VAULT_HUD_DATA_DIR;
  process.env.VAULT_HUD_DATA_DIR = data;
  try {
    const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
    for (const bad of ['sprocketeer@firmname.example', 'sprocketeer@firmname',
      'sprocketeer', 'abcd1234-0000-4000-8000-00000000beef', 'abcd1234']) {
      assert.ok(!html.includes(bad), `"${bad}" reached the rendered page`);
    }
    // And the tag was actually drawn, so the assertions above meant something.
    // The literal string, not what the eye sees: .acct uppercases in CSS, and
    // asserting the rendered case would pass against a tag that lost its
    // identity and kept its styling.
    assert.match(html, /class="acct">acctA · MAX 20x</,
      'the enrollment id and the subscription shape are what the page shows');
  } finally {
    if (prevData === undefined) delete process.env.VAULT_HUD_DATA_DIR;
    else process.env.VAULT_HUD_DATA_DIR = prevData;
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
