// account.js — which Claude account this machine's Claude Code is signed in as,
// right now, read from disk.
//
// PORTED, NOT IMPORTED. The original lives in the vault at
// `70-Memory/scripts/claude-account.mjs`. This repo treats the vault as
// read-only data, so importing a module out of it would have the daemon execute
// vault content at startup. The cost is two implementations; they are held
// together by `test/account.test.js`, which asserts the same tag strings from
// the same fixtures the vault copy asserts.
//
// WHAT THIS IS FOR, on a machine that has a poller. `usage-poller.js` is
// authoritative for "which account is the CLI on": it asks the profile endpoint
// and matches by account uuid. But it can come back with nothing — the CLI's
// token lives in the Keychain, an expired default token is deliberately not
// refreshed here (rotating the CLI's own credential would log it out), and the
// endpoint is a network call. This reads the same answer off local disk for
// free. It is the fallback for `currentAccountId`, never a second identity: the
// uuid it returns is the poller's own join key and resolves to the same
// enrollment row.
//
// On a machine with no poller at all it is the only answer, which is the case
// the vault copy was written for.
//
// Zero dependencies, no network, and it never reads or prints a token. The
// credentials file is opened for exactly two non-secret fields.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
};

// Both files are written by another program and can hold anything.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

// "default_claude_max_20x" -> "20x". No multiplier means no tier, so this
// returns null rather than falling back to the rest of the string:
// "default_claude_pro" would otherwise yield "pro", which is the plan, and
// render as "PRO pro".
const tierOf = (raw) => {
  const m = str(raw)?.match(/(\d+x)$/);
  return m ? m[1] : null;
};

// "claude_max" -> "max".
const planOf = (raw) => str(raw)?.replace(/^claude_/, '') || null;

/**
 * The signed-in account, resolved fresh on every call.
 *
 * Resolved per call, not at module load. The daemon that imports this stays up
 * for days, and a value captured once at import is the same staleness this
 * whole field exists to avoid — the account was observed changing inside one
 * session on 2026-08-20.
 *
 * @returns {Promise<{accountUuid: string|null, email: string|null,
 *   handle: string|null, plan: string|null, tier: string|null,
 *   apiKeyVar: string|null, source: 'oauth'|'partial'|'none'}>}
 */
export async function resolveAccount({ env = process.env } = {}) {
  // Claude Code honours CLAUDE_CONFIG_DIR; reading $HOME unconditionally
  // reports the wrong account whenever it is set. Per user, not per session:
  // two sessions on one machine on different accounts cannot be told apart
  // unless one of them sets this.
  const configDir = env.CLAUDE_CONFIG_DIR || homedir();

  const [config, creds] = await Promise.all([
    readJson(join(configDir, '.claude.json')),
    readJson(join(configDir, '.claude', '.credentials.json')),
  ]);
  const oauth = isObj(config?.oauthAccount) ? config.oauthAccount : null;
  const bundle = isObj(creds?.claudeAiOauth) ? creds.claudeAiOauth : null;

  // Plan and tier come from ONE file, never half from each. The premise of this
  // field is that the account changes under a running session, and Claude Code
  // rewrites these two files independently — so a field-by-field fallback can
  // pair the new account's uuid with the previous account's plan during exactly
  // the switch the field exists to track.
  const from = oauth
    ? { plan: planOf(oauth.organizationType), tier: tierOf(oauth.organizationRateLimitTier) }
    : { plan: planOf(bundle?.subscriptionType), tier: tierOf(bundle?.rateLimitTier) };

  const uuid = str(oauth?.accountUuid);
  const email = str(oauth?.emailAddress);

  // An API key in the environment MAY be paying instead of the subscription,
  // and from disk alone that cannot be settled: in an interactive session the
  // key has to be approved once, and a rejected key leaves the subscription
  // paying. So this is reported as a flag beside the account, never as a
  // replacement for it. The variable's name is recorded; its value is never
  // read. ANTHROPIC_AUTH_TOKEN is checked first because it outranks the key.
  const apiKeyVar = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
    .find((v) => (env[v] || '').trim() !== '') || null;

  // `source` describes what actually resolved, so a reader can never infer more
  // detail than is present. "oauth" promises a uuid; anything less says so.
  const source = uuid ? 'oauth' : (from.plan || from.tier) ? 'partial' : 'none';

  return {
    accountUuid: uuid,
    email,
    handle: email ? email.split('@')[0] : null,
    plan: from.plan,
    tier: from.tier,
    apiKeyVar,
    source,
  };
}
