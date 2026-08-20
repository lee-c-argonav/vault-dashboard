// usage.js — read the Claude subscription usage snapshot the poller writes.
//
// The feature keeps two files in the data directory (never in the repo, never
// in the vault):
//
//   usage-tokens.json   one OAuth bundle per enrolled account. SECRETS, mode
//                       0600. Only usage-poller.js and usage-enroll.js may
//                       read it — this module is not one of them.
//   usage.json          the public-safe snapshot this module reads.
//
// Every field is whitelisted and type-checked rather than spread through, for
// the same reason runs.js does it: the writer is a timer behind a private API
// and this parse feeds the HUD, so one bad field must cost that account,
// never the board. There is deliberately no clock here: State must not carry
// clock-derived fields, or app.js's stringify diff repaints on every tick.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAccount } from './account.js';

/** Where the poller keeps its state unless VAULT_HUD_DATA_DIR overrides it. */
export function usageDataDir() {
  return process.env.VAULT_HUD_DATA_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'vault-hud');
}

const ACCOUNT_STATES = new Set(['ok', 'auth_expired', 'error']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function normaliseWindow(w) {
  if (!isObj(w)) return null;
  const utilization = Number(w.utilization);
  // A window without a usable number conveys nothing; keeping the object with
  // a null inside it would draw a row that looks measured and is not.
  if (!Number.isFinite(utilization)) return null;
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resetsAt: isoOrNull(w.resetsAt),
  };
}

function normaliseAccount(a) {
  // An id is required: a bare {} would otherwise normalise into a real account
  // and draw a row for something that does not exist.
  if (!isObj(a) || typeof a.id !== 'string' || !a.id) return null;
  return {
    id: a.id,
    label: str(a.label) || a.id,
    // The account's stable identity from the profile endpoint. This is the join
    // key: a run file records the account it is spending as a uuid, and this is
    // the only thing that maps one to an enrollment row. Null until the poller's
    // first successful identity backfill, which is a real state and not an
    // error — the row still renders, it just cannot be joined to.
    //
    // Reading it here does not widen what this module opens. The uuid rides
    // usage.json, which carries no secrets by schema; the tokens stay in
    // usage-tokens.json, which this module still never touches.
    uuid: typeof a.uuid === 'string' && a.uuid ? a.uuid : null,
    plan: str(a.plan),
    // An unrecognised state becomes 'error': the view branches on exactly
    // these three values, and passing an invented one through would make the
    // account silently ineligible with nothing saying why.
    state: ACCOUNT_STATES.has(a.state) ? a.state : 'error',
    error: typeof a.error === 'string' && a.error ? a.error : null,
    fetchedAt: isoOrNull(a.fetchedAt),
    fiveHour: normaliseWindow(a.fiveHour),
    sevenDay: normaliseWindow(a.sevenDay),
    sevenDayOpus: normaliseWindow(a.sevenDayOpus),
    sevenDaySonnet: normaliseWindow(a.sevenDaySonnet),
    sevenDayFable: normaliseWindow(a.sevenDayFable),
  };
}

/**
 * Read the snapshot. Three outcomes, and the difference matters:
 *
 *   absent   no file. Normal — a machine with no enrolled accounts has nothing
 *            to show, and the view renders nothing.
 *   broken   a file exists but is not a v1 snapshot. Reported, because
 *            "present but unreadable" wearing the same face as "nothing
 *            enrolled" is how a dead poller would hide.
 *   ok       parsed and normalised.
 *
 * @returns {Promise<{usage: object|null, status: 'ok'|'absent'|'broken'}>}
 */
export async function readUsage(dataDir = usageDataDir()) {
  let text;
  try {
    text = await readFile(path.join(dataDir, 'usage.json'), 'utf8');
  } catch (err) {
    return { usage: null, status: err?.code === 'ENOENT' ? 'absent' : 'broken' };
  }
  let raw;
  try {
    // A leading BOM makes JSON.parse throw forever, not transiently. runs.js
    // strips it for the same reason.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { usage: null, status: 'broken' };
  }
  if (!isObj(raw) || raw.schema !== 1) return { usage: null, status: 'broken' };
  return {
    usage: {
      schema: 1,
      updated: isoOrNull(raw.updated),
      // Which enrolled account the default CLI profile is signed into, matched
      // by account uuid at poll time. Null means "unknown", never "none".
      currentAccountId: typeof raw.currentAccountId === 'string' && raw.currentAccountId
        ? raw.currentAccountId : null,
      accounts: (Array.isArray(raw.accounts) ? raw.accounts : [])
        .map(normaliseAccount)
        .filter(Boolean),
    },
    status: 'ok',
  };
}

/**
 * The snapshot with `currentAccountId` filled in from disk when the poller could
 * not answer.
 *
 * ONE IDENTITY, TWO READERS. The poller is authoritative and asks the profile
 * endpoint, matching by account uuid. It comes back with null more often than it
 * looks: the CLI's token lives in the Keychain, an expired default token is
 * deliberately never refreshed by the poller (rotating the CLI's own credential
 * would log it out), and the endpoint is a network call on a laptop that sleeps.
 * The panel then shows no CURRENT account and the stay-or-switch verdict has
 * nothing to be relative to — on a board whose whole job is answering which
 * account to work in.
 *
 * `account.js` reads the same uuid off local disk for free and it is matched
 * against the same enrollment rows, so this adds a reader and never a second
 * identity. It only ever fills a null: a live reading from the endpoint is
 * closer to the truth than a file, and a disagreement between them means the
 * files were rewritten since the poll, which the next poll settles.
 *
 * Falls back to nothing when the uuid matches no enrolled account. That is the
 * honest answer — the CLI is signed into an account this machine never enrolled,
 * and inventing a row for it would put an account on the panel with no quota
 * behind it.
 *
 * @param {object|null} usage a snapshot from readUsage
 * @param {() => Promise<object>} read injected for tests
 */
export async function withLocalAccount(usage, read = resolveAccount) {
  if (!usage || usage.currentAccountId) return usage;
  let local;
  try {
    local = await read();
  } catch {
    // A resolver that throws must cost the fallback, never the panel.
    return usage;
  }
  const uuid = typeof local?.accountUuid === 'string' && local.accountUuid
    ? local.accountUuid : null;
  if (!uuid) return usage;
  const hit = usage.accounts.find((a) => a.uuid && a.uuid === uuid);
  return hit ? { ...usage, currentAccountId: hit.id } : usage;
}
