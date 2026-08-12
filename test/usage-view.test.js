// usage-view.test.js — the stay-or-switch verdict, the pace projection, and
// the staleness rule, pinned so the desktop strip and the phone page keep
// agreeing.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageView, USAGE_STALE_MS } from '../public/usage-view.js';

const T0 = Date.parse('2026-08-12T14:00:00.000Z');
const H = 3600_000;
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();

const acct = (over = {}) => ({
  id: 'widget', label: 'widget', plan: 'max', state: 'ok', error: null,
  fetchedAt: iso(T0),
  fiveHour: { utilization: 40, resetsAt: iso(T0 + 3 * H) },
  sevenDay: { utilization: 30, resetsAt: iso(T0 + 4 * 24 * H) },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  sevenDayFable: null,
  ...over,
});

const board = (accounts, over = {}) =>
  ({ schema: 1, updated: iso(T0), accounts, ...over });

// ── the view itself ──────────────────────────────────────────────────────────

test('no usage State is no panel, and never a throw', () => {
  assert.equal(usageView(null, T0), null);
  assert.equal(usageView(undefined, T0), null);
  assert.equal(usageView([], T0), null);
  assert.equal(usageView('usage', T0), null);
});

test('staleness is measured against the poll cadence, not the render', () => {
  assert.equal(USAGE_STALE_MS, 15 * 60 * 1000);
  assert.equal(usageView(board([]), T0 + min(14)).isStale, false);
  const v = usageView(board([]), T0 + min(16));
  assert.equal(v.isStale, true);
  assert.equal(v.staleMinutes, 16);
});

test('an unreadable updated stamp is stale with no minute count to invent', () => {
  const v = usageView(board([], { updated: 'not a date' }), T0);
  assert.equal(v.updated, null);
  assert.equal(v.isStale, true);
  assert.equal(v.staleMinutes, null);
});

test('a stamp ahead of the clock reads fresh, not negative', () => {
  const v = usageView(board([], { updated: iso(T0 + min(5)) }), T0);
  assert.equal(v.isStale, false);
  assert.equal(v.staleMinutes, 0);
});

// ── account mapping ──────────────────────────────────────────────────────────

test('accounts map field by field, with the model windows optional', () => {
  const v = usageView(board([acct({
    sevenDayOpus: { utilization: 12, resetsAt: iso(T0 + 4 * 24 * H) },
    sevenDaySonnet: { utilization: 55, resetsAt: iso(T0 + 4 * 24 * H) },
    sevenDayFable: { utilization: 2, resetsAt: iso(T0 + 24 * H) },
  })]), T0);
  const a = v.accounts[0];
  assert.equal(a.id, 'widget');
  assert.equal(a.label, 'widget');
  assert.equal(a.plan, 'max');
  assert.equal(a.state, 'ok');
  assert.equal(a.error, null);
  assert.equal(a.fiveHourPct, 40);
  assert.equal(a.fiveHourResetsAt, iso(T0 + 3 * H));
  assert.equal(a.sevenDayPct, 30);
  assert.equal(a.sevenDayResetsAt, iso(T0 + 4 * 24 * H));
  assert.equal(a.opusPct, 12);
  assert.equal(a.sonnetPct, 55);
  assert.equal(a.fablePct, 2);
  assert.equal(a.fableResetsAt, iso(T0 + 24 * H));
  assert.equal(a.spent5h, false);
});

test('a missing reading maps to nulls, not zeros', () => {
  const a = usageView(board([acct({ fiveHour: null, sevenDay: null })]), T0).accounts[0];
  assert.equal(a.fiveHourPct, null);
  assert.equal(a.fiveHourResetsAt, null);
  assert.equal(a.sevenDayPct, null);
  assert.equal(a.opusPct, null);
  assert.equal(a.spent5h, false);
  assert.equal(a.capAt, null);
});

test('a state outside the contract renders as error, never as ok', () => {
  const a = usageView(board([acct({ state: 'rate_limited' })]), T0).accounts[0];
  assert.equal(a.state, 'error');
});

test('a bare object cannot crash the strip', () => {
  const a = usageView(board([{}]), T0).accounts[0];
  assert.equal(a.id, '');
  assert.equal(a.state, 'error');
  assert.equal(a.fiveHourPct, null);
});

// ── the verdict ──────────────────────────────────────────────────────────────

test('a current account under both thresholds is stay, with no target', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget' }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 10, resetsAt: iso(T0 + 3 * H) } }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.currentId, 'widget');
  assert.equal(v.verdict.kind, 'stay');
  assert.equal(v.verdict.current.id, 'widget');
  assert.equal(v.verdict.currentHot, false);
  assert.equal(v.verdict.target, null);
});

test('past 80% of the session the verdict is switch, to a both-buckets-available account', () => {
  // The first-live-data shape, 2026-08-12: a fresh session on a 99% week must
  // not win over a lightly used session on a 3% week. Cool accounts outrank
  // hot ones, so the 0%-session/99%-week account loses to 15%/3%.
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget',
      fiveHour: { utilization: 99, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 59, resetsAt: iso(T0 + 4 * 24 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket',
      fiveHour: { utilization: 0, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 99, resetsAt: iso(T0 + 24 * H) } }),
    acct({ id: 'laptop', label: 'laptop',
      fiveHour: { utilization: 15, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 3, resetsAt: iso(T0 + 4 * 24 * H) } }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'switch');
  assert.equal(v.verdict.current.id, 'widget');
  assert.equal(v.verdict.target.id, 'laptop');
  assert.equal(v.verdict.currentHot, true);
});

test('past 90% of the week alone is enough for switch', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget',
      fiveHour: { utilization: 40, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 91, resetsAt: iso(T0 + 24 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket' }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'switch');
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('at the threshold exactly, the account counts as over the line', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 80, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 20, resetsAt: iso(T0 + 3 * H) } }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'switch');
  const w = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 79, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 20, resetsAt: iso(T0 + 3 * H) } }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(w.verdict.kind, 'stay');
});

test('a hot current that is still the best available says stay, hot', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 99, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 100, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'laptop', label: 'laptop', state: 'auth_expired', fiveHour: null, sevenDay: null }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'stay');
  assert.equal(v.verdict.currentHot, true);
  assert.equal(v.verdict.target, null);
});

test('a current that is not reporting is switched away from', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', state: 'auth_expired', fiveHour: null, sevenDay: null }),
    acct({ id: 'sprocket', label: 'sprocket' }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'switch');
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('unknown current names the strongest account, with no stay/switch framing', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 62, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 20, resetsAt: iso(T0 + 3 * H) } }),
  ]), T0);
  assert.equal(v.currentId, null);
  assert.equal(v.verdict.kind, 'best');
  assert.equal(v.verdict.current, null);
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('a current id naming no enrolled account reads as unknown', () => {
  const v = usageView(board([acct()], { currentAccountId: 'ghost' }), T0);
  assert.equal(v.currentId, null);
  assert.equal(v.verdict.kind, 'best');
  assert.equal(v.verdict.target.id, 'widget');
});

test('a full session is never the target, however light its week', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 100, resetsAt: iso(T0 + 3 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 80, resetsAt: iso(T0 + 3 * H) } }),
  ]), T0);
  assert.equal(v.accounts[0].spent5h, true);
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('a full week knocks a target out with session headroom to spare', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget',
      fiveHour: { utilization: 10, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 100, resetsAt: iso(T0 + 4 * 24 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 60, resetsAt: iso(T0 + 3 * H) } }),
  ]), T0);
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('an unread week does not disqualify a target; an unread session does', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: null }),
    acct({ id: 'sprocket', label: 'sprocket',
      fiveHour: { utilization: 10, resetsAt: iso(T0 + 3 * H) }, sevenDay: null }),
  ]), T0);
  assert.equal(v.verdict.target.id, 'sprocket');
});

test('the lighter session wins among cool accounts; weeks break the exact tie', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget',
      fiveHour: { utilization: 40, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 10, resetsAt: iso(T0 + 4 * 24 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket',
      fiveHour: { utilization: 40, resetsAt: iso(T0 + 3 * H) },
      sevenDay: { utilization: 20, resetsAt: iso(T0 + 4 * 24 * H) } }),
  ]), T0);
  assert.equal(v.verdict.target.id, 'widget');
});

// ── spent and nextFree ───────────────────────────────────────────────────────

test('every account unusable is spent, with the earliest reset named', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 100, resetsAt: iso(T0 + 2 * H) } }),
    acct({ id: 'sprocket', label: 'sprocket', fiveHour: { utilization: 100, resetsAt: iso(T0 + min(41)) } }),
    acct({ id: 'laptop', label: 'laptop', state: 'auth_expired', fiveHour: null, sevenDay: null }),
  ], { currentAccountId: 'widget' }), T0);
  assert.equal(v.verdict.kind, 'spent');
  assert.equal(v.verdict.target, null);
  assert.deepEqual(v.verdict.nextFree, { id: 'sprocket', label: 'sprocket', at: iso(T0 + min(41)) });
});

test('nothing reporting at all is spent with no reset to name', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', state: 'error', error: 'HTTP 500' }),
    acct({ id: 'sprocket', label: 'sprocket', state: 'auth_expired' }),
  ]), T0);
  assert.equal(v.verdict.kind, 'spent');
  assert.equal(v.verdict.nextFree, null);
});

test('an ok account with no session reading leaves the board spent', () => {
  const v = usageView(board([acct({ fiveHour: null })]), T0);
  assert.equal(v.verdict.kind, 'spent');
});

test('nextFree ignores past resets and unhealthy accounts', () => {
  const v = usageView(board([
    acct({ id: 'widget', label: 'widget', fiveHour: { utilization: 100, resetsAt: iso(T0 - H) } }),
    acct({ id: 'sprocket', label: 'sprocket', state: 'auth_expired',
      fiveHour: { utilization: 100, resetsAt: iso(T0 + min(5)) } }),
  ]), T0);
  assert.equal(v.verdict.nextFree, null);
});

// ── the pace projection ──────────────────────────────────────────────────────

test('on pace to cap, the projection lands inside the window', () => {
  // 50% used with 3h to reset: 2h elapsed, burn 25 pts/h, caps 2h from now.
  const a = usageView(board([acct({
    fiveHour: { utilization: 50, resetsAt: iso(T0 + 3 * H) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, iso(T0 + 2 * H));
});

test('a window younger than thirty minutes projects nothing', () => {
  const a = usageView(board([acct({
    fiveHour: { utilization: 90, resetsAt: iso(T0 + 4.5 * H + min(1)) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, null);
});

test('the thirty-minute boundary itself projects', () => {
  // Elapsed exactly 30m, 25% used: pace 5x the window, caps 1h30m from now.
  const a = usageView(board([acct({
    fiveHour: { utilization: 25, resetsAt: iso(T0 + 4.5 * H) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, iso(T0 + 1.5 * H));
});

test('a reset already past is history, not a projection', () => {
  const a = usageView(board([acct({
    fiveHour: { utilization: 80, resetsAt: iso(T0 - min(5)) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, null);
});

test('a slow enough pace never caps', () => {
  // 10% used with 3h to reset: the window ends at 25%, no cap.
  const a = usageView(board([acct({
    fiveHour: { utilization: 10, resetsAt: iso(T0 + 3 * H) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, null);
});

test('zero usage cannot divide by zero into an Invalid Date', () => {
  const a = usageView(board([acct({
    fiveHour: { utilization: 0, resetsAt: iso(T0 + 3 * H) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, null);
});

test('an account already at the cap has no projection, only the spent flag', () => {
  const a = usageView(board([acct({
    fiveHour: { utilization: 100, resetsAt: iso(T0 + 3 * H) },
  })]), T0).accounts[0];
  assert.equal(a.capAt, null);
  assert.equal(a.spent5h, true);
});
