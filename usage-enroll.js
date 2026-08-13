// usage-enroll.js — enrol Claude subscription credentials for the usage poller.
//
// WHERE THE CREDENTIAL COMES FROM. The Claude CLI stores its OAuth bundle in
// the macOS Keychain as a generic password named `Claude Code-credentials`
// (a custom CLAUDE_CONFIG_DIR profile gets a per-path suffix). `add` reads
// that entry — or takes the same JSON on --stdin — and stores a copy in
// usage-tokens.json (mode 0600, in the data directory: never in the repo,
// never in the vault).
//
// THE ONE REFRESH. Refresh tokens rotate on every use, and two holders of the
// same refresh token cannot both survive a rotation. So `add` performs ONE
// deliberate refresh before writing anything: the CLI's copy goes stale and
// this copy is the live one. That Claude profile will ask for one re-login
// the next time its access token expires — the documented tradeoff, the same
// one claude-meter makes. After that the poller refreshes on its own and
// nothing asks again.
//
// TOKENS ARE NEVER PRINTED. Output names ids, labels, plans and expiry times
// only. This tool's stdout is the kind of thing that ends up in a scrollback
// buffer or a pasted screenshot.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { usageDataDir } from './usage.js';
import { readTokenStore, refreshAccount, updateTokenStore } from './usage-poller.js';

const execFileP = promisify(execFile);

const USAGE = `usage:
  node usage-enroll.js add <id> <label> [--config-dir <path>] [--plan <plan>] [--stdin]
  node usage-enroll.js list
  node usage-enroll.js remove <id>
`;

class UsageError extends Error {}

/* ── where the credential comes from ────────────────────────────────────── */

/**
 * The Keychain service names to try for a CLI profile. The default ~/.claude
 * profile is plain `Claude Code-credentials`; a custom CLAUDE_CONFIG_DIR gets
 * the first 8 hex of sha256 of the value THE CLI SEES appended. The installed
 * CLI NFC-normalizes the raw env string and does no path resolution, so the
 * raw spelling is tried first and the resolved absolute spelling second —
 * they differ for a trailing slash, a relative path, or `..`/`.` segments,
 * and only the raw one is guaranteed to match.
 */
function keychainServices(configDir) {
  if (!configDir) return ['Claude Code-credentials'];
  const hash = (s) => `Claude Code-credentials-${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;
  const raw = configDir.normalize('NFC');
  const resolved = resolve(configDir.replace(/^~(?=$|\/)/, homedir())).normalize('NFC');
  return [...new Set([hash(raw), hash(resolved)])];
}

/** The raw credential JSON for a profile, from the Keychain or from stdin. */
async function readCredential({ configDir, useStdin }) {
  if (useStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  const services = keychainServices(configDir);
  let lastErr = null;
  for (const service of services) {
    try {
      const { stdout } = await execFileP('security', ['find-generic-password', '-s', service, '-w']);
      return stdout.trim();
    } catch (err) {
      lastErr = err;
    }
  }
  // The failure's stderr is safe to name: a failed find carries no payload,
  // and "User interaction is not allowed" (an SSH session) is not "missing".
  const why = String(lastErr?.stderr || lastErr?.message || 'unknown error').trim().slice(0, 120);
  throw new Error(
    `no Keychain entry named "${services[0]}" (${why}).\n` +
    (configDir
      ? `Is that profile logged in? Create it with:\n  CLAUDE_CONFIG_DIR=${configDir} claude\nlog in inside it, then re-run with --config-dir ${configDir}.`
      : 'Is Claude Code installed and logged in? Or paste the credential JSON with --stdin.'),
  );
}

/**
 * Pull the OAuth bundle out of the credential payload. Throws on anything
 * missing — storing a half bundle would only fail later, inside the poller,
 * where nobody is watching. The error never includes the payload.
 */
function parseBundle(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('the credential is not valid JSON');
  }
  const oauth = payload?.claudeAiOauth;
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken
      || typeof oauth?.refreshToken !== 'string' || !oauth.refreshToken) {
    throw new Error('the credential JSON has no claudeAiOauth access/refresh token pair');
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    // The CLI stores ms since epoch; the store keeps ISO like everything else.
    expiresAt: Number.isFinite(oauth.expiresAt)
      ? new Date(oauth.expiresAt).toISOString()
      : (typeof oauth.expiresAt === 'string' && Number.isFinite(Date.parse(oauth.expiresAt))
        ? oauth.expiresAt
        : null),
    scopes: (Array.isArray(oauth.scopes) ? oauth.scopes : []).filter((s) => typeof s === 'string'),
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : '',
  };
}

/* ── the three commands ─────────────────────────────────────────────────── */

async function addAccount({ id, label, plan, configDir, useStdin }) {
  const dataDir = usageDataDir();
  // The id is what the phone page prints, verbatim, on an unauthenticated
  // URL. Letters, digits and dash only: an email-shaped id would quietly
  // defeat the label-stripping that keeps addresses off that page.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error('the id prints on the public phone page; use lowercase letters, digits and dashes only (e.g. acct2).');
  }
  let existing;
  try {
    existing = await readTokenStore(dataDir);
  } catch (err) {
    throw new Error(`usage-tokens.json exists but is unreadable (${err.message}). Fix or remove it by hand; it will not be overwritten.`);
  }
  // Before the credential read and its side-effecting refresh, not after.
  if (existing?.accounts.some((a) => a.id === id)) {
    throw new Error(`"${id}" is already enrolled — remove it first if you mean to replace it.`);
  }
  const bundle = parseBundle(await readCredential({ configDir, useStdin }));
  const candidate = {
    id,
    label,
    plan: plan ?? bundle.subscriptionType,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    scopes: bundle.scopes,
  };
  // THE decoupling refresh, done BEFORE the first write: on failure nothing
  // is stored, and on success only the rotated bundle is ever persisted, so
  // the store never holds the same live refresh token as the CLI.
  const r = await refreshAccount(candidate);
  if (!r.ok) {
    throw new Error(`the decoupling refresh failed: ${r.error}. Nothing was stored; the CLI profile is untouched.`);
  }
  // The persist merges against a fresh read: the poller may have rotated
  // another account's bundle while this enrollment was refreshing.
  try {
    await updateTokenStore(dataDir, (fresh) => {
      if (fresh.accounts.some((a) => a.id === id)) {
        throw new Error(`"${id}" is already enrolled — remove it first if you mean to replace it.`);
      }
      fresh.accounts.push(r.account);
      return fresh;
    });
  } catch (err) {
    if (err.message.includes('already enrolled')) throw err;
    throw new Error(
      `the enrollment write failed (${err.message}) AFTER the decoupling refresh succeeded. `
      + 'Nothing was stored, but the CLI profile\'s refresh token is already rotated: '
      + 'that profile will need one re-login, and this account needs enrolling again.');
  }
  return r.account;
}

async function listAccounts() {
  const store = await readTokenStore(usageDataDir());
  if (!store || store.accounts.length === 0) {
    process.stdout.write('No accounts enrolled.\n');
    return;
  }
  for (const a of store.accounts) {
    process.stdout.write(`${a.id}\t${a.label}\tplan: ${a.plan || '?'}\ttoken expires: ${a.expiresAt ?? 'unknown'}\n`);
  }
}

async function removeAccount(id) {
  const dataDir = usageDataDir();
  await updateTokenStore(dataDir, (fresh) => {
    if (!fresh.accounts.some((a) => a.id === id)) {
      throw new Error(`no enrolled account with id "${id}".`);
    }
    fresh.accounts = fresh.accounts.filter((a) => a.id !== id);
    return fresh;
  });
  process.stdout.write(`Removed "${id}".\n`);
}

/* ── argument parsing ───────────────────────────────────────────────────── */

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list' && rest.length === 0) return { cmd };
  if (cmd === 'remove' && rest.length === 1) return { cmd, id: rest[0] };
  if (cmd === 'add') {
    const positional = [];
    const opts = { plan: undefined, configDir: undefined, useStdin: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--stdin') opts.useStdin = true;
      else if (a === '--plan' || a === '--config-dir') {
        const v = rest[++i];
        // A missing or flag-shaped value means the option was left dangling;
        // accepting it would silently enroll the DEFAULT profile instead of
        // the intended one, and its decoupling refresh would orphan any
        // previously enrolled copy of that profile.
        if (v === undefined || v.startsWith('--')) throw new UsageError();
        if (a === '--plan') opts.plan = v; else opts.configDir = v;
      }
      else if (a.startsWith('--')) throw new UsageError();
      else positional.push(a);
    }
    if (positional.length !== 2) throw new UsageError();
    if ((opts.plan !== undefined && !opts.plan) || (opts.configDir !== undefined && !opts.configDir)) {
      throw new UsageError();
    }
    return { cmd, id: positional[0], label: positional[1], ...opts };
  }
  throw new UsageError();
}

/* ── standalone ─────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.cmd === 'add') {
      const account = await addAccount(args);
      process.stdout.write(`Enrolled "${account.label}" (id: ${account.id}, plan: ${account.plan || 'unknown'}).\n`);
      process.stdout.write(`Token expires ${account.expiresAt ?? 'at an unknown time'}; the poller refreshes it from here.\n`);
      process.stdout.write('\nNOTE: one deliberate refresh was just performed to decouple this copy from the\n');
      process.stdout.write("Claude CLI's own credentials. The CLI's stored refresh token is now stale, so THAT\n");
      process.stdout.write('Claude profile will ask for ONE re-login the next time its token expires. This is\n');
      process.stdout.write('expected — the same tradeoff claude-meter documents.\n');
      process.stdout.write('\nTo enrol another subscription:\n');
      process.stdout.write('  CLAUDE_CONFIG_DIR=~/.claude-<id> claude          # create the profile and log in\n');
      process.stdout.write('  node usage-enroll.js add <id> "<label>" --config-dir ~/.claude-<id>\n');
      process.stdout.write('\nIf the HUD is already running, restart it once: the poller checks enrolment at startup.\n');
    } else if (args.cmd === 'list') {
      await listAccounts();
    } else {
      await removeAccount(args.id);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    process.stderr.write(`[vault-hud] enrol: ${err.message}\n`);
    process.exit(1);
  }
}
