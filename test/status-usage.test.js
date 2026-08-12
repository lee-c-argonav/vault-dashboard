// status-usage.test.js — Claude subscription usage on the phone page.
//
// The page is deployed to an UNAUTHENTICATED URL, so the usage section goes
// through the same projection as everything else: percentages rounded,
// timestamps bucketed, per-account poll stamps dropped, and nothing the
// poller wrote outside the public schema may survive. The cases here seed
// values that WOULD leak or churn under the naive behaviour, in the register
// of projection.test.js.
//
// Every fixture is synthetic: invented labels, invented stamps, token-shaped
// strings that were never issued. This repository is public.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPublicBoard, readBoard, build, boardDigest } from '../status-page/build.js';

const NOW = Date.parse('2026-08-12T18:00:00Z');

/** Two enrolled accounts: one usable, one whose refresh token died. */
function usageFixture() {
  return {
    schema: 1,
    updated: '2026-08-12T17:58:21Z',
    currentAccountId: null,
    accounts: [
      {
        id: 'alpha', label: 'account-alpha', plan: 'max', state: 'ok', error: null,
        fetchedAt: '2026-08-12T17:58:20Z',
        fiveHour: { utilization: 42.4, resetsAt: '2026-08-12T19:57:11Z' },
        sevenDay: { utilization: 18.6, resetsAt: '2026-08-19T17:00:44Z' },
        sevenDayOpus: { utilization: 9.2, resetsAt: '2026-08-19T17:00:44Z' },
        sevenDaySonnet: null,
        sevenDayFable: { utilization: 4.1, resetsAt: '2026-08-14T01:00:00Z' },
      },
      {
        id: 'beta', label: 'account-beta', plan: 'pro', state: 'auth_expired',
        error: 'refresh token rejected',
        fetchedAt: '2026-08-12T17:58:23Z',
        fiveHour: { utilization: 100, resetsAt: '2026-08-12T18:02:38Z' },
        sevenDay: { utilization: 97.5, resetsAt: '2026-08-18T07:12:03Z' },
        sevenDayOpus: null,
        sevenDaySonnet: null,
        sevenDayFable: null,
      },
    ],
  };
}

/** A board carrying usage, with no runs and no sessions to muddy the digest. */
function usageBoard(usage = usageFixture()) {
  return { active: [], finished: [], unpublished: [], skipped: 0, usage };
}

/** An empty but readable vault: zero runs is a true statement, not an error. */
async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'vh-usage-vault-'));
  await mkdir(join(root, '15-Runs'), { recursive: true });
  return root;
}

/** A data directory with usage.json written into it, plus env set/restored. */
async function withUsageFile(body, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vh-usage-data-'));
  if (body !== null) {
    await writeFile(join(dataDir, 'usage.json'),
      typeof body === 'string' ? body : JSON.stringify(body));
  }
  const saved = process.env.VAULT_HUD_DATA_DIR;
  process.env.VAULT_HUD_DATA_DIR = dataDir;
  try {
    return await fn(dataDir);
  } finally {
    if (saved === undefined) delete process.env.VAULT_HUD_DATA_DIR;
    else process.env.VAULT_HUD_DATA_DIR = saved;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('readBoard carries usage.json from VAULT_HUD_DATA_DIR', async () => {
  const vault = await makeVault();
  try {
    await withUsageFile(usageFixture(), async () => {
      const board = await readBoard(vault, [], NOW);
      assert.equal(board.usage.accounts.length, 2);
      assert.equal(board.usage.accounts[0].label, 'account-alpha');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('the projection rounds, buckets and drops, exactly like the other public fields', () => {
  const u = toPublicBoard(usageBoard(), NOW).usage;
  const [a, b] = u.accounts;
  assert.equal(a.fiveHour.utilization, 42, '42.4 must publish as 42');
  assert.equal(a.sevenDay.utilization, 19, '18.6 must publish as 19');
  assert.equal(a.fiveHour.resetsAt, '2026-08-12T19:55:00.000Z',
    'resets-at floored to its five-minute bucket');
  assert.equal(u.updated, '2026-08-12T17:55:00.000Z', 'board stamp bucketed the same way');
  assert.equal(a.fetchedAt, undefined,
    'the per-account poll stamp moves every poll and says nothing the board stamp does not');
  assert.equal(a.label, undefined,
    'the operator-chosen label never publishes: the first real ones were email addresses');
  assert.equal(b.state, 'auth_expired', 'state survives: the chip renders it');
  assert.equal(b.error, 'refresh token rejected', 'the poller-authored reason survives');
  assert.equal(a.sevenDaySonnet, null, 'an absent window stays absent, not NaN');
  assert.equal(a.sevenDayFable.utilization, 4, 'the Fable window rounds like the others');
  assert.equal(a.sevenDayFable.resetsAt, '2026-08-14T01:00:00.000Z', 'Fable reset bucketed');
  assert.equal(u.currentAccountId, null, 'no current account in the fixture stays null');
});

test('the usage projection is idempotent', () => {
  const once = toPublicBoard(usageBoard(), NOW);
  const twice = toPublicBoard(once, NOW);
  assert.deepEqual(twice.usage, once.usage,
    'a second pass over an already-projected board changed the usage section');
});

test('the digest ignores movement too small to act on', () => {
  const a = usageBoard();
  const b = usageBoard();
  b.usage.accounts[0].fiveHour.utilization = 42.44;          // rounds to the same 42
  b.usage.accounts[0].fetchedAt = '2026-08-12T17:59:59Z';    // dropped entirely
  b.usage.accounts[0].fiveHour.resetsAt = '2026-08-12T19:58:44Z'; // same bucket
  assert.equal(boardDigest(a, NOW), boardDigest(b, NOW),
    'sub-rounding drift fired a deploy that would change nothing');
});

test('the digest moves when a published quota or state changes', () => {
  const a = usageBoard();
  const moved = usageBoard();
  moved.usage.accounts[0].fiveHour.utilization = 55.6;
  assert.notEqual(boardDigest(a, NOW), boardDigest(moved, NOW),
    'a 13-point swing in the 5h window did not fire a deploy');
  const expired = usageBoard();
  expired.usage.accounts[0].state = 'auth_expired';
  assert.notEqual(boardDigest(a, NOW), boardDigest(expired, NOW),
    'an account losing its auth did not fire a deploy');
});

test('the digest moves when the poll stamp crosses the stale threshold', () => {
  // The file is frozen — a dead poller writes nothing, so the projected stamp
  // can never move again. The clock term is the only way the phone learns the
  // data went stale; without it the last page would read fresh forever.
  const board = usageBoard();
  const fresh = boardDigest(board, NOW);
  const later = boardDigest(board, NOW + 20 * 60_000);
  assert.notEqual(fresh, later, 'the data aged past the stale threshold and no deploy fired');
  const stillStale = boardDigest(board, NOW + 40 * 60_000);
  assert.equal(later, stillStale,
    'staleness is a floor claim; a finer bucket would deploy to change nothing');
});

test('nothing outside the public schema reaches the projection or the page', async () => {
  // usage.json holds no tokens BY SCHEMA — they live in usage-tokens.json. A
  // hand-edited or corrupted file could carry one, and the page cannot be
  // allowed to publish it. The whitelist, not the schema's good intentions, is
  // the boundary.
  const hostile = usageFixture();
  hostile.accounts[0].accessToken = 'FAKE-ACCESS-TOKEN-DO-NOT-USE';
  hostile.accounts[0].refreshToken = 'FAKE-REFRESH-TOKEN-DO-NOT-USE';
  hostile.accounts[0].scopes = 'user:inference';
  const json = JSON.stringify(toPublicBoard(usageBoard(hostile), NOW));
  for (const bad of ['FAKE-ACCESS-TOKEN', 'FAKE-REFRESH-TOKEN', 'user:inference']) {
    assert.ok(!json.includes(bad), `"${bad}" survived the projection`);
  }
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(hostile, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      for (const bad of ['FAKE-ACCESS-TOKEN', 'FAKE-REFRESH-TOKEN', 'user:inference']) {
        assert.ok(!html.includes(bad), `"${bad}" reached the rendered page`);
      }
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('the rendered section leads with the verdict, then one row per account', async () => {
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(usageFixture(), async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      // No current account is known, so the verdict is the best-headroom one,
      // and the only eligible account is alpha (beta's auth is expired). It is
      // named by enrollment id, never by label: labels are operator free text
      // and stay on the loopback desktop.
      assert.ok(html.includes('Best headroom: <b>alpha</b>'), 'no verdict line');
      assert.ok(!html.includes('account-alpha'), 'a label reached the published page');
      assert.ok(!html.includes('account-beta'), 'a label reached the published page');
      assert.ok(
        html.indexOf('class="qrec"') < html.indexOf('class="qrow"'),
        'the account rows rendered above the verdict',
      );
      // Rounded by the projection before the view ever saw it.
      assert.ok(html.includes('5h 42%'), 'the 5h quota did not render rounded');
      assert.ok(html.includes('7d 19% ↻ Aug 19'), 'the 7d quota lost its reset date');
      assert.ok(/fab 4% ↻ Aug 1[34]/.test(html), 'the Fable window lost its reset date');
      assert.ok(html.includes('↻'), 'no reset time rendered');
      assert.ok(html.includes('AUTH EXPIRED'), 'a non-ok account carried no state chip');
      assert.ok(!html.includes('17:58:2'), 'a per-account poll stamp reached the page');
      // The section sits above the board: the answer is wanted before it.
      assert.ok(
        html.indexOf('class="quota"') < html.indexOf('No run is publishing'),
        'the usage section rendered below the runs',
      );
      assert.ok(!html.includes('STALE'), 'fresh data was marked stale');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('a current account with headroom reads as fine, with no action word', async () => {
  const calm = usageFixture();
  calm.currentAccountId = 'alpha';
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(calm, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(html.includes('<b>alpha</b> is fine · 5h 42% · 7d 19%'), 'no stay verdict');
      assert.ok(!html.includes('Switch to'), 'a calm board asked for a switch');
      assert.ok(html.includes('CURRENT'), 'the current account is not marked');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('a current account over the line is told where to switch and why', async () => {
  const hot = usageFixture();
  hot.currentAccountId = 'alpha';
  hot.accounts[0].fiveHour = { utilization: 93.2, resetsAt: '2026-08-12T19:57:11Z' };
  hot.accounts[1] = {
    ...hot.accounts[1],
    state: 'ok', error: null,
    fiveHour: { utilization: 12, resetsAt: '2026-08-12T22:02:00Z' },
    sevenDay: { utilization: 30, resetsAt: '2026-08-18T07:12:03Z' },
  };
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(hot, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      // 93.2 rounds to 93 by the projection before the view reads it.
      assert.ok(html.includes('Switch to <b>beta</b> · alpha at 93% session'), 'no switch verdict');
      assert.ok(!html.includes('is fine'), 'a hot current was called fine');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('the section is hidden when usage.json is absent, broken, or empty', async () => {
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    // Absent: the normal state of a machine that never enrolled. Not an error.
    await withUsageFile(null, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(!html.includes('class="quota"'), 'an absent file rendered a section');
      assert.ok(html.includes('No run is publishing'), 'the board itself failed to render');
    });
    // Broken: present but unparseable. Same absence, never a build failure.
    await withUsageFile('{ not json', async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(!html.includes('class="quota"'), 'a broken file rendered a section');
    });
    // Enrolled to zero accounts.
    await withUsageFile({ schema: 1, updated: '2026-08-12T17:58:21Z', accounts: [] }, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(!html.includes('class="quota"'), 'zero accounts rendered a section');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('stale data says so, as a floor claim rather than a freezing counter', async () => {
  const stale = usageFixture();
  stale.updated = '2026-08-12T17:12:00Z'; // 48 minutes before NOW
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(stale, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(html.includes('STALE ≥15m'), 'old data was not marked stale');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('an all-spent board says when an account frees instead of recommending one', async () => {
  const spent = usageFixture();
  spent.accounts[0].fiveHour = { utilization: 100, resetsAt: '2026-08-12T21:03:00Z' };
  spent.accounts[1] = {
    ...spent.accounts[1],
    state: 'ok', error: null,
    fiveHour: { utilization: 100, resetsAt: '2026-08-12T20:02:00Z' },
  };
  const vault = await makeVault();
  const out = await mkdtemp(join(tmpdir(), 'vh-usage-out-'));
  try {
    await withUsageFile(spent, async () => {
      const html = await readFile(await build({ vault, outDir: out, now: NOW, sessions: [] }), 'utf8');
      assert.ok(html.includes('All accounts spent'), 'no all-spent verdict');
      assert.ok(!html.includes('Use <b>'), 'a recommendation was made with nothing eligible');
      // The earliest future 5h reset is beta's, so beta is what frees first —
      // named by enrollment id, never by label.
      assert.ok(html.includes('beta frees'), 'the next account to free was not named');
      assert.ok(!html.includes('account-beta'), 'a label reached the published page');
    });
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
