// usage-view.js — the stay-or-switch verdict and every figure the surfaces draw.
//
// No DOM, no fs, no clock of its own: the desktop (app.js) and the phone build
// (status-page/build.js) both import this, so the two surfaces cannot disagree
// about which account to use right now. Same approach as runs-view.js, for the
// same reason — two readers that reimplement a rule eventually disagree.
//
// The clock arrives as nowMs from the caller. State carries the raw readings
// only, because a clock-derived field in State would look changed to app.js's
// stringify diff on every push; deriving here keeps one derivation for both
// surfaces and leaves the countdowns free to recompute per render.

// The poller rewrites usage.json every 300s, so a file older than three passes
// is figures nobody has re-measured. The strip says so rather than presenting
// them as live.
export const USAGE_STALE_MS = 15 * 60 * 1000;

const FIVE_H_MS = 5 * 3600_000;

// A burn-rate projection needs a window old enough that one burst cannot own
// it: 40% gone two minutes into a window projects an instant cap that says
// nothing. Under thirty minutes the reading shows with no projection.
const CAP_MIN_ELAPSED_MS = 30 * 60_000;

const STATES = new Set(['ok', 'auth_expired', 'error']);

// Clamping to 0–100 is the normalizer's job (usage.js); the view only refuses
// non-numbers, so a normalizer bug surfaces as an impossible figure rather than
// being silently repainted as a plausible one.
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * When the five-hour window caps at the current burn rate, as an ISO stamp.
 *
 * A projection, stated only while it is honest: the window must be at least
 * thirty minutes old (younger, and one burst owns the rate), the reset must be
 * ahead of us, and the pace must actually reach 100 inside the window. Null
 * otherwise, and null when the reading is missing — never a date built on
 * nothing. The division is guarded by the pace check above it: burn*5h >= 100
 * can only hold when burn > 0, so the zero-burn case never reaches it.
 */
function capAtFor(fiveHourPct, fiveHourResetsAt, nowMs) {
  if (fiveHourPct == null) return null;
  const resetsMs = Date.parse(fiveHourResetsAt ?? '');
  if (!Number.isFinite(resetsMs) || resetsMs <= nowMs) return null;
  const elapsed = FIVE_H_MS - (resetsMs - nowMs);
  if (elapsed < CAP_MIN_ELAPSED_MS || elapsed > FIVE_H_MS) return null;
  if (fiveHourPct >= 100) return null; // already there; spent5h carries that
  const burn = fiveHourPct / elapsed;
  if (burn * FIVE_H_MS < 100) return null;
  return new Date(nowMs + (100 - fiveHourPct) / burn).toISOString();
}

/**
 * One account as the surfaces draw it. Whitelisted field by field rather than
 * spread through: this object is the whole contract between the poller and two
 * renderers, and a field the contract does not name must not leak into a
 * surface by accident.
 */
function accountView(a, nowMs) {
  // An unknown state becomes 'error', never 'ok': a state this old build does
  // not understand cannot be vouched for, and the error chip is the safe thing
  // to draw in place of bars.
  const state = STATES.has(a?.state) ? a.state : 'error';
  const fiveHourPct = pct(a?.fiveHour?.utilization);
  const fiveHourResetsAt = isoOrNull(a?.fiveHour?.resetsAt);
  const sevenDayPct = pct(a?.sevenDay?.utilization);
  return {
    id: str(a?.id),
    label: str(a?.label),
    // The poller's join key, carried through so a machine that reports its
    // account as a uuid can be matched to this row. Null on the phone, where
    // the projection drops it: the uuid is spent resolving ids before publish.
    uuid: str(a?.uuid),
    plan: str(a?.plan),
    state,
    error: typeof a?.error === 'string' ? a.error : null,
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt: isoOrNull(a?.sevenDay?.resetsAt),
    opusPct: pct(a?.sevenDayOpus?.utilization),
    sonnetPct: pct(a?.sevenDaySonnet?.utilization),
    fablePct: pct(a?.sevenDayFable?.utilization),
    fableResetsAt: isoOrNull(a?.sevenDayFable?.resetsAt),
    spent5h: fiveHourPct != null && fiveHourPct >= 100,
    // Out in practice, either bucket: at 98% the remainder is minutes.
    out: (fiveHourPct != null && fiveHourPct >= OUT_PCT)
      || (sevenDayPct != null && sevenDayPct >= OUT_PCT),
    capAt: capAtFor(fiveHourPct, fiveHourResetsAt, nowMs),
  };
}

/**
 * The verdict: whether the account in use is fine, or which one to switch to.
 *
 * The model is the operator's, stated 2026-08-12: a switch instruction is
 * noise while the current account has headroom, so one is only shown past
 * SWITCH_SESSION_PCT on the session or SWITCH_WEEK_PCT on the week. The kinds:
 *
 *   stay    the current account is under both thresholds. currentHot marks the
 *           edge where it is OVER one but still the best available — every
 *           alternative is worse, so staying is the advice, said plainly.
 *   switch  the current account is hot (or not reporting) and a better one
 *           exists. The target always has both buckets available.
 *   best    which account is current is unknown (the CLI profile could not be
 *           matched), so the strongest account is named without a stay/switch
 *           framing.
 *   spent   no account has both buckets available; nextFree says when one
 *           frees.
 *
 * Available means: reporting ok, a MEASURED session under OUT_PCT, and a week
 * either unread or under OUT_PCT — a null session reading is never eligible,
 * and `null < 100` passing silently is exactly the kind of accident this
 * function exists to prevent. Ranking: cool accounts (under both switch
 * thresholds) before hot ones, then the lightest session, then the lightest
 * week (a missing week loses to any measured one), then the label so both
 * surfaces name the same account.
 */
export const SWITCH_SESSION_PCT = 80;
export const SWITCH_WEEK_PCT = 90;
// At 98% an account is out in practice: the remaining headroom is minutes,
// so it drops out of switch targets and its cell carries the ✕ OUT mark.
// (Operator call, 2026-08-12: at this reading the account "is not usable".)
export const OUT_PCT = 98;

const available = (a) => a.state === 'ok'
  && a.fiveHourPct != null && a.fiveHourPct < OUT_PCT
  && (a.sevenDayPct == null || a.sevenDayPct < OUT_PCT);
const hot = (a) => (a.fiveHourPct != null && a.fiveHourPct >= SWITCH_SESSION_PCT)
  || (a.sevenDayPct != null && a.sevenDayPct >= SWITCH_WEEK_PCT);

function verdictFor(accounts, currentId, nextFree) {
  const pub = (a) => ({ id: a.id, label: a.label, state: a.state,
    fiveHourPct: a.fiveHourPct, sevenDayPct: a.sevenDayPct });
  const current = accounts.find((a) => a.id === currentId) ?? null;

  if (current && current.state === 'ok' && !hot(current)) {
    return { kind: 'stay', current: pub(current), currentHot: false, target: null, nextFree };
  }
  const candidates = accounts.filter(available);
  const weekOf = (a) => (a.sevenDayPct == null ? Infinity : a.sevenDayPct);
  candidates.sort((x, y) => Number(hot(x)) - Number(hot(y))
    || x.fiveHourPct - y.fiveHourPct
    || weekOf(x) - weekOf(y)
    || x.label.localeCompare(y.label));
  const best = candidates[0] ?? null;

  if (!best) {
    return { kind: 'spent', current: current ? pub(current) : null,
      currentHot: current ? hot(current) : false, target: null, nextFree };
  }
  if (current && best.id === current.id) {
    return { kind: 'stay', current: pub(current), currentHot: true, target: null, nextFree };
  }
  if (current) {
    return { kind: 'switch', current: pub(current), currentHot: true,
      target: pub(best), nextFree };
  }
  return { kind: 'best', current: null, currentHot: false, target: pub(best), nextFree };
}

/**
 * The whole panel, derived. Null when there is no usage State at all — the
 * surfaces hide the strip then, because an unenrolled machine has nothing to
 * show and an absent file is normal, not an error.
 */

/**
 * How old a remote reading is allowed to be before the row stops presenting it
 * as current.
 *
 * DERIVED FROM `REFRESH_MS` in `remote.js`, which is 120s: this is two full
 * refreshes plus a minute of slack, so one missed pass is not an alarm and two
 * are. The two constants live in different files because one belongs to the
 * reader and one to the renderer, and nothing in the language couples them —
 * changing the refresh interval without changing this makes a chip claim a
 * freshness it does not have. Named in both places for that reason.
 */
export const REMOTE_STALE_MS = 300_000;

/**
 * Which remote machines are signed into one account, matched by uuid.
 *
 * BY UUID, never by label or id: the remote resolves its own account from its
 * own disk and knows nothing about this machine's enrollment table, so the uuid
 * is the only thing both sides hold. It is the same key the poller matches on,
 * which is what keeps a remote chip and the CURRENT chip from naming one account
 * two ways.
 *
 * A reading whose last successful check has aged past REMOTE_STALE_MS, or whose
 * last check failed, is marked `stale` rather than dropped. Dropping it would
 * make an unreachable machine and a machine signed into nothing look identical,
 * which is the 2026-08-10 rule: an empty result and an unreachable source must
 * never be the same value.
 */
export function remoteSignersFor(uuid, remotes, nowMs) {
  if (!uuid || !Array.isArray(remotes)) return [];
  const out = [];
  for (const r of remotes) {
    if (!r || typeof r !== 'object') continue;
    const ruuid = typeof r.account?.accountUuid === 'string' ? r.account.accountUuid : null;
    if (!ruuid || ruuid !== uuid) continue;
    const at = Date.parse(typeof r.at === 'string' ? r.at : '');
    const aged = Number.isFinite(at) ? nowMs - at : null;
    out.push({
      host: typeof r.host === 'string' ? r.host : '',
      stale: r.reachable === false || aged === null || aged > REMOTE_STALE_MS,
      ageMs: aged,
      error: typeof r.error === 'string' ? r.error : null,
    });
  }
  // Fixed order, so a chip row cannot swap sides between renders and read as a
  // change. Sorted rather than left in the order the reader happened to return,
  // which is the configured host order and would reshuffle on an edit to .env.
  return out.sort((a, b) => a.host.localeCompare(b.host));
}

export function usageView(usage, nowMs, remotes = []) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const accounts = (Array.isArray(usage.accounts) ? usage.accounts : [])
    .map((a) => accountView(a, nowMs));

  const updatedMs = Date.parse(typeof usage.updated === 'string' ? usage.updated : '');
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : null;

  // When the first account comes back. Per ok account the freeing time is the
  // LATEST of the resets its out-reading binds to: a spent session frees at
  // the session reset, a spent week frees at the weekly reset, and an account
  // out on both is back only when the later of the two passes — the first
  // version named the 5h reset even when the week was the binding constraint,
  // so "frees in 2h" was false (review, 2026-08-12). An account whose binding
  // reset is missing cannot be timed and is skipped rather than guessed at.
  let nextFree = null;
  for (const a of accounts) {
    if (a.state !== 'ok') continue;
    const binding = [];
    if (a.fiveHourPct != null && a.fiveHourPct >= OUT_PCT && a.fiveHourResetsAt != null)
      binding.push(Date.parse(a.fiveHourResetsAt));
    if (a.sevenDayPct != null && a.sevenDayPct >= OUT_PCT && a.sevenDayResetsAt != null)
      binding.push(Date.parse(a.sevenDayResetsAt));
    const frees = binding.length ? Math.max(...binding) : null;
    if (frees === null || frees <= nowMs) continue;
    if (!nextFree || frees < Date.parse(nextFree.at)) {
      nextFree = { id: a.id, label: a.label, at: new Date(frees).toISOString() };
    }
  }

  // A current id naming no enrolled account is unknown, not absent: the
  // poller matches by uuid, so this only happens mid-enrollment.
  const rawCurrent = typeof usage.currentAccountId === 'string' ? usage.currentAccountId : null;
  const currentId = accounts.some((a) => a.id === rawCurrent) ? rawCurrent : null;
  // Remote machines, matched onto the account each is signed into. Done here
  // rather than in the renderer for the same reason signedIn is: an assertion on
  // rendered output tests the renderer and not the logic.
  const list = Array.isArray(remotes) ? remotes.filter((r) => r && typeof r === 'object') : [];
  for (const a of accounts) a.remotes = remoteSignersFor(a.uuid, list, nowMs);
  // A machine whose account matched no enrolled row still has to be visible, or
  // the strip silently answers "no remote machine is signed in anywhere" to a
  // question it did not actually answer. Three ways in: the account is real and
  // not enrolled here, the host has never been reached, or it resolved nothing.
  const matched = new Set(accounts.flatMap((a) => a.remotes.map((r) => r.host)));
  const unmatchedRemotes = list
    .filter((r) => typeof r.host === 'string' && r.host && !matched.has(r.host))
    .map((r) => ({
      host: r.host,
      uuid8: typeof r.account?.accountUuid === 'string'
        ? r.account.accountUuid.slice(0, 8) : null,
      plan: typeof r.account?.plan === 'string' ? r.account.plan : null,
      tier: typeof r.account?.tier === 'string' ? r.account.tier : null,
      reachable: r.reachable === true,
      error: typeof r.error === 'string' ? r.error : null,
    }))
    .sort((a, b) => a.host.localeCompare(b.host));

  return {
    updated: isoOrNull(usage.updated),
    isStale: ageMs === null || ageMs > USAGE_STALE_MS,
    staleMinutes: ageMs === null ? null : Math.floor(ageMs / 60_000),
    currentId,
    accounts,
    unmatchedRemotes,
    verdict: verdictFor(accounts, currentId, nextFree, nowMs),
  };
}
