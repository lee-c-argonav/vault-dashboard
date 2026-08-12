// usage-poller.js — keep usage.json fresh for every enrolled Claude account.
//
// WHAT THIS READS AND WRITES. usage-tokens.json holds one OAuth bundle per
// enrolled account (SECRETS, mode 0600; written by usage-enroll.js, rotated
// here). usage.json is the public-safe snapshot the HUD renders. Both live in
// the data directory — never in the repo, never in the vault.
//
// THE ENDPOINT IS PRIVATE. api.anthropic.com/api/oauth/usage is undocumented
// and is read with the subscription's own OAuth token, the same mechanism
// claude-meter uses. Two quirks are load-bearing:
//   - The User-Agent matters: without the claude-code string the endpoint
//     429s aggressively. A 429 is answered once, after the wait the
//     Retry-After header asks for (capped, so a pathological value cannot
//     stall the accounts queued behind the rate-limited one).
//   - Refresh tokens ROTATE on every refresh. A rotated bundle is persisted
//     the moment it arrives, before the next account is touched: a process
//     that died between refresh and write would otherwise strand the account
//     on a dead refresh token until re-enrollment.
//
// NEVER THROWS. This runs from a timer with no caller to catch it, and taking
// the HUD down because an endpoint had a bad minute would cost the whole
// board. One account's failure lands in that account's `error` field and the
// poll moves on.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { usageDataDir } from './usage.js';

const execFileP = promisify(execFile);

const TOKEN_FILE = 'usage-tokens.json';
const USAGE_FILE = 'usage.json';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Answers "which account is this token": one stable uuid per account, used to
// name the profile the default CLI is signed into right now.
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const REFRESH_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  // Fallback when the primary host 404s: the endpoint lived here first.
  'https://console.anthropic.com/v1/oauth/token',
];
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
// Without this User-Agent the usage endpoint 429s aggressively.
const USER_AGENT = 'claude-code/2.1.228';

/** A token expiring within this window is refreshed BEFORE the usage call. */
const REFRESH_WITHIN_MS = 60_000;
/** Accounts are polled sequentially, this far apart, never in a burst. */
const BETWEEN_ACCOUNTS_MS = 2_000;
/** Retry-After is honoured up to this cap. */
const RETRY_AFTER_CAP_MS = 120_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── the token store ────────────────────────────────────────────────────── */

function normaliseTokenAccount(a) {
  // An id is required; a bundle without one cannot be polled, listed or
  // removed, so keeping it would only grow a row nothing can act on.
  if (!isObj(a) || typeof a.id !== 'string' || !a.id) return null;
  return {
    id: a.id,
    label: str(a.label) || a.id,
    plan: str(a.plan),
    accessToken: str(a.accessToken),
    refreshToken: str(a.refreshToken),
    expiresAt: isoOrNull(a.expiresAt),
    scopes: (Array.isArray(a.scopes) ? a.scopes : []).filter((s) => typeof s === 'string'),
    // The account's stable identity, backfilled from the profile endpoint on
    // the first poll that finds it missing. This, not any token string, is
    // how "which account is the CLI on" is matched: tokens rotate, the uuid
    // does not.
    uuid: typeof a.uuid === 'string' && a.uuid ? a.uuid : null,
    email: typeof a.email === 'string' && a.email ? a.email : null,
  };
}

/**
 * Read usage-tokens.json. Absent → null (never enrolled). Present but not a
 * v1 store → throw: the file holds secrets, and a reader that guessed at its
 * shape could mangle it on the next write.
 */
export async function readTokenStore(dataDir) {
  let text;
  try {
    text = await readFile(join(dataDir, TOKEN_FILE), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!isObj(raw) || raw.schema !== 1 || !Array.isArray(raw.accounts)) {
    throw new Error('usage-tokens.json is not a v1 token store');
  }
  return { schema: 1, accounts: raw.accounts.map(normaliseTokenAccount).filter(Boolean) };
}

/**
 * Write the store atomically with mode 0600. The tmp file is created fresh
 * every time, which is what guarantees the mode: writeFile applies it at
 * creation and rename keeps it.
 */
export async function writeTokenStore(dataDir, store) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(dataDir, TOKEN_FILE), JSON.stringify(store, null, 2) + '\n', 0o600);
}

/** Tmp file + rename in the same directory: a reader never sees a half file. */
async function writeJsonAtomic(file, text, mode) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, mode ? { mode } : undefined);
  await rename(tmp, file);
}

/* ── refresh ────────────────────────────────────────────────────────────── */

/**
 * One OAuth refresh. Never throws; the outcome is reported and the caller
 * maps it onto the account state (`authExpired` ⇔ the refresh attempt
 * returned 400/401). The refresh token ROTATES on success, so the caller
 * persists the returned bundle before anything else happens with it.
 *
 * @returns {Promise<{ok: true, account: object} | {ok: false, authExpired: boolean, error: string}>}
 */
export async function refreshAccount(account, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const post = (url) => fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  let res;
  try {
    res = await post(REFRESH_URLS[0]);
    // A 404 from the primary host means the endpoint moved, not that the
    // grant is dead — try the historical host before believing a status.
    if (res.status === 404) res = await post(REFRESH_URLS[1]);
  } catch (err) {
    return { ok: false, authExpired: false, error: `refresh unreachable: ${err.message}` };
  }
  if (res.status === 400 || res.status === 401) {
    return { ok: false, authExpired: true, error: `refresh rejected: HTTP ${res.status}${await oauthDetail(res)}` };
  }
  if (!res.ok) {
    return { ok: false, authExpired: false, error: `refresh failed: HTTP ${res.status}` };
  }
  let bundle;
  try {
    bundle = await res.json();
  } catch {
    return { ok: false, authExpired: false, error: 'refresh returned unreadable JSON' };
  }
  if (typeof bundle?.access_token !== 'string' || !bundle.access_token) {
    return { ok: false, authExpired: false, error: 'refresh returned no access token' };
  }
  return {
    ok: true,
    account: {
      ...account,
      accessToken: bundle.access_token,
      // Rotation is the normal case; a response without one keeps the old.
      refreshToken: typeof bundle.refresh_token === 'string' && bundle.refresh_token
        ? bundle.refresh_token
        : account.refreshToken,
      expiresAt: Number.isFinite(bundle.expires_in)
        ? new Date(now() + bundle.expires_in * 1000).toISOString()
        : account.expiresAt,
    },
  };
}

/**
 * The one safe scrap of an OAuth error body: the machine-readable reason.
 * Token values never appear in these responses, and the slice caps anything
 * unexpected.
 */
async function oauthDetail(res) {
  try {
    const body = await res.json();
    const reason = str(body?.error_description) || str(body?.error);
    return reason ? ` (${reason.slice(0, 120)})` : '';
  } catch {
    return '';
  }
}

/* ── the usage call ─────────────────────────────────────────────────────── */

/** GET the usage windows; one 429 is answered after the Retry-After wait. */
async function fetchUsage(account, { fetchImpl, sleep, log }) {
  const call = () => fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'anthropic-beta': OAUTH_BETA,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
  });
  let res = await call();
  if (res.status === 429) {
    const waitMs = retryAfterMs(res.headers?.get?.('retry-after'));
    log(`[vault-hud] usage: ${account.id} rate-limited; waiting ${Math.round(waitMs / 1000)}s\n`);
    await sleep(waitMs);
    res = await call();
  }
  return res;
}

function retryAfterMs(header) {
  const seconds = Number.parseInt(header ?? '', 10);
  if (!Number.isFinite(seconds) || seconds < 0) return 5_000;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

/** Translate the API's snake_case window. Display-side validation happens on
 *  read (usage.js); this only refuses to write a window with no real number. */
function windowFromApi(w) {
  if (!isObj(w)) return null;
  const utilization = Number(w.utilization);
  if (!Number.isFinite(utilization)) return null;
  return { utilization, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null };
}

/**
 * The Fable window. It is NOT one of the top-level seven_day_* fields — those
 * codename keys (nimbus_quill, cinder_cove, …) come and go. The stable handle
 * is the limits[] array's model-scoped entry, observed live 2026-08-12:
 *   {"kind":"weekly_scoped","percent":2,"scope":{"model":{"display_name":"Fable"}}}
 */
function fableFromApi(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  const hit = limits.find((l) => isObj(l) && l?.scope?.model?.display_name === 'Fable');
  if (!hit) return null;
  const utilization = Number(hit.percent);
  if (!Number.isFinite(utilization)) return null;
  return { utilization, resetsAt: isoOrNull(hit.resets_at) };
}

/* ── which account the CLI is on ────────────────────────────────────────── */

// The default profile's credential, resolved per poll but mapped to an account
// uuid only when the token string changes — the CLI rotates it on every
// refresh, so without the cache each five-minute tick would buy a profile call.
const uuidByToken = new Map();

/** The access token in the default profile's Keychain entry, or null. */
async function defaultProfileToken(execImpl) {
  try {
    const { stdout } = await execImpl('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    const oauth = JSON.parse(stdout.trim())?.claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null;
  } catch {
    // No entry, a denied prompt, an unparsable payload: all read as "unknown",
    // never as a poll failure — the quotas matter more than the marker.
    return null;
  }
}

/** The account uuid behind a token, or null. Never throws, never prints it. */
async function uuidForToken(accessToken, fetchImpl) {
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const uuid = body?.account?.uuid;
    return typeof uuid === 'string' && uuid ? uuid : null;
  } catch {
    return null;
  }
}

/**
 * The enrolled account the default ~/.claude profile is signed into, matched
 * by account uuid — never by token string, because the CLI and this poller
 * refresh their own copies and the strings diverge within hours. Null when
 * any step cannot answer: an expired default token is NOT refreshed here
 * (rotating the CLI's own credential would log it out — the contention
 * claude-meter documents), so the marker just waits for the CLI's next use.
 *
 * Enrolled bundles gain their uuid on the first poll that lacks it, persisted
 * back to the token store; the store write is reported through `dirty`.
 */
async function resolveCurrentAccount(store, { fetchImpl, execImpl, log }) {
  try {
    const token = await defaultProfileToken(execImpl);
    if (!token) return { id: null, dirty: false };
    let uuid = uuidByToken.get(token);
    if (!uuid) {
      uuid = await uuidForToken(token, fetchImpl);
      if (!uuid) return { id: null, dirty: false };
      uuidByToken.set(token, uuid);
    }
    let dirty = false;
    for (const acc of store.accounts) {
      if (acc.uuid || !acc.accessToken) continue;
      const u = await uuidForToken(acc.accessToken, fetchImpl);
      if (u) { acc.uuid = u; dirty = true; }
    }
    const hit = store.accounts.find((a) => a.uuid === uuid);
    if (!hit) {
      log('[vault-hud] usage: the default CLI profile is not an enrolled account\n');
    }
    return { id: hit?.id ?? null, dirty };
  } catch (err) {
    log(`[vault-hud] usage: current-account detection failed: ${err.message}\n`);
    return { id: null, dirty: false };
  }
}

/* ── polling ────────────────────────────────────────────────────────────── */

function failureEntry(account, state, error, at) {
  return {
    id: account.id, label: account.label, plan: account.plan,
    state, error, fetchedAt: at,
    fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null,
    sevenDayFable: null,
  };
}

/**
 * Poll one account. Returns the usage.json entry, plus the rotated bundle
 * when a refresh happened so the caller can persist it immediately.
 */
async function pollAccount(account, deps) {
  const { fetchImpl, now } = deps;
  const at = new Date(now()).toISOString();
  try {
    let acc = account;
    let rotated = null;

    const refresh = async () => {
      const r = await refreshAccount(acc, { fetchImpl, now });
      if (!r.ok) return { ok: false, state: r.authExpired ? 'auth_expired' : 'error', error: r.error };
      acc = r.account;
      rotated = acc;
      return { ok: true };
    };

    // Refresh BEFORE the usage call when the token is nearly up. A missing
    // expiresAt counts as expiring: it means enrolment could not tell, and
    // the refresh that follows writes a real one.
    const expiresIn = Date.parse(acc.expiresAt ?? '') - now();
    if (!Number.isFinite(expiresIn) || expiresIn <= REFRESH_WITHIN_MS) {
      const r = await refresh();
      if (!r.ok) return { entry: failureEntry(acc, r.state, r.error, at), rotated };
    }

    let res;
    try {
      res = await fetchUsage(acc, deps);
    } catch (err) {
      return { entry: failureEntry(acc, 'error', `usage unreachable: ${err.message}`, at), rotated };
    }

    // A 401 with a token this poll did not just refresh means the stored
    // expiresAt lied (clock skew, revocation). One refresh, one retry.
    if (res.status === 401 && !rotated) {
      const r = await refresh();
      if (!r.ok) return { entry: failureEntry(acc, r.state, r.error, at), rotated };
      try {
        res = await fetchUsage(acc, deps);
      } catch (err) {
        return { entry: failureEntry(acc, 'error', `usage unreachable: ${err.message}`, at), rotated };
      }
    }

    if (!res.ok) {
      return { entry: failureEntry(acc, 'error', `usage endpoint: HTTP ${res.status}`, at), rotated };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { entry: failureEntry(acc, 'error', 'usage endpoint returned unreadable JSON', at), rotated };
    }
    return {
      entry: {
        id: acc.id, label: acc.label, plan: acc.plan,
        state: 'ok', error: null, fetchedAt: at,
        fiveHour: windowFromApi(body?.five_hour),
        sevenDay: windowFromApi(body?.seven_day),
        sevenDayOpus: windowFromApi(body?.seven_day_opus),
        sevenDaySonnet: windowFromApi(body?.seven_day_sonnet),
        sevenDayFable: fableFromApi(body),
      },
      rotated,
    };
  } catch (err) {
    // The belt-and-braces catch: one account's surprise must not kill the poll.
    return { entry: failureEntry(account, 'error', String(err?.message || err), at), rotated: null };
  }
}

/**
 * One full pass over every enrolled account, sequentially, ~2s apart. Writes
 * usage.json atomically. Returns a small summary for tests and the --once
 * CLI; never throws.
 */
export async function pollOnce({
  dataDir = usageDataDir(),
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = () => {},
  exec: execImpl = execFileP,
} = {}) {
  let store;
  try {
    store = await readTokenStore(dataDir);
  } catch (err) {
    log(`[vault-hud] usage: cannot read usage-tokens.json: ${err.message}\n`);
    return { wrote: false, reason: 'unreadable', accounts: 0 };
  }
  if (!store || store.accounts.length === 0) {
    log('[vault-hud] usage: no accounts enrolled; nothing to poll (node usage-enroll.js add …)\n');
    return { wrote: false, reason: 'no-accounts', accounts: 0 };
  }
  const deps = { fetchImpl, now, sleep, log };
  const entries = [];
  for (const [i, account] of store.accounts.entries()) {
    if (i > 0) await sleep(BETWEEN_ACCOUNTS_MS);
    const { entry, rotated } = await pollAccount(account, deps);
    if (entry.state !== 'ok') {
      log(`[vault-hud] usage: ${entry.id}: ${entry.state} — ${entry.error}\n`);
    }
    entries.push(entry);
    if (rotated) {
      // The old refresh token is already dead; this write is the only copy of
      // the live one, so it happens before the next account is touched.
      store.accounts[i] = rotated;
      try {
        await writeTokenStore(dataDir, store);
      } catch (err) {
        log(`[vault-hud] usage: could not persist rotated tokens for ${entry.id}: ${err.message}\n`);
      }
    }
  }
  const current = await resolveCurrentAccount(store, { fetchImpl, execImpl, log });
  if (current.dirty) {
    try {
      await writeTokenStore(dataDir, store);
    } catch (err) {
      log(`[vault-hud] usage: could not persist account uuids: ${err.message}\n`);
    }
  }
  const snapshot = { schema: 1, updated: new Date(now()).toISOString(),
    currentAccountId: current.id, accounts: entries };
  try {
    await writeJsonAtomic(join(dataDir, USAGE_FILE), JSON.stringify(snapshot, null, 2) + '\n');
  } catch (err) {
    log(`[vault-hud] usage: could not write usage.json: ${err.message}\n`);
    return { wrote: false, reason: 'unwritable', accounts: entries.length };
  }
  return { wrote: true, accounts: entries.length, states: entries.map((e) => e.state) };
}

/**
 * The timer. Checks enrolment ONCE: with no token file (or an empty one) it
 * logs a single line and the handle is a no-op, rather than warning every
 * five minutes forever. A first enrolment therefore takes effect at the next
 * server start.
 *
 * The handle carries `ready` — the first poll's promise — so tests can await
 * real work instead of racing the timer.
 */
export function startUsagePoller({
  dataDir = usageDataDir(),
  intervalMs = 300_000,
  log = console.error,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  exec: execImpl = execFileP,
} = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = false;
  const tick = async () => {
    // A slow poll must not stack up behind the next tick.
    if (inFlight) return;
    inFlight = true;
    try {
      await pollOnce({ dataDir, fetch: fetchImpl, now, sleep, log, exec: execImpl });
    } finally {
      inFlight = false;
    }
  };
  const ready = (async () => {
    let store = null;
    try {
      store = await readTokenStore(dataDir);
    } catch (err) {
      log(`[vault-hud] usage: cannot read usage-tokens.json: ${err.message}; poller off\n`);
      return;
    }
    if (!store || store.accounts.length === 0) {
      log('[vault-hud] usage: no accounts enrolled; poller off (node usage-enroll.js add …)\n');
      return;
    }
    await tick();
    if (!stopped) {
      timer = setInterval(tick, intervalMs);
      timer.unref();
    }
  })();
  return {
    ready,
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

/* ── standalone ─────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes('--once')) {
    process.stderr.write('usage: node usage-poller.js --once\n');
    process.exit(2);
  }
  const result = await pollOnce({ log: console.error });
  if (result.wrote) {
    const ok = result.states.filter((s) => s === 'ok').length;
    process.stderr.write(`[vault-hud] usage: polled ${result.accounts} account(s), ${ok} ok\n`);
  }
  process.exit(result.reason === 'unreadable' ? 1 : 0);
}
