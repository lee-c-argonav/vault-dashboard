// remote.js — which Claude account a remote machine's CLI is signed in as.
//
// WHY THIS EXISTS. The usage strip answers "which account am I working in" for
// the machine the daemon runs on, read from the poller. The DGX Spark runs agent
// sessions and has neither daemon nor poller, so the board could say nothing
// about it at all. Its account is not fixed either: it was observed changing
// inside a single session on 2026-08-20, so anything written down goes stale.
//
// THE MAC PULLS; THE SPARK RUNS NOTHING. `server.js` binds 127.0.0.1 by design,
// so accepting a push would mean opening the daemon to the tailnet for one
// string. Pulling needs no listener and no new surface: passwordless SSH already
// exists over Tailscale. This is `sessions.js`'s pattern — shell out, parse,
// cache, degrade to nothing when the tools are missing — pointed at another host.
//
// ONE RESOLVER, NOT THREE. `account.js` is piped to the remote over stdin and
// run there, rather than reimplemented in shell or python and rather than
// depending on a copy checked out on that machine. The remote needs node and
// nothing else, the answer always comes from this repo's current code, and there
// is no third implementation to drift. The vault's copy already had to be held
// in step with the port; a third would not have been.
//
// NO TOKEN CROSSES THE WIRE. `account.js` reads no token on any branch and opens
// `.credentials.json` for exactly `subscriptionType` and `rateLimitTier`. The
// alternative — cat the two files back and parse here — would ship live OAuth
// tokens over SSH for two non-secret fields, which is why it is not done.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * How often a host is re-asked. Measured 2026-08-20 against the Spark over
 * Tailscale: 130ms for a full call, of which 100ms is the SSH handshake and
 * 10ms is node starting on the far side. At this interval that is 720 calls and
 * about 94 seconds of wall time a day, none of it on the board's critical path.
 *
 * `REMOTE_STALE_MS` in `public/usage-view.js` is derived from this — a reading
 * is presented as current until it has missed more than two refreshes. Changing
 * one without the other makes a chip claim freshness it does not have.
 */
const REFRESH_MS = 120_000;
/** A host that does not answer in this long is unreachable for this pass. */
const TIMEOUT_MS = 12_000;
/** Half the budget is spent getting a connection; the rest is the round trip. */
const CONNECT_TIMEOUT_S = 6;

/**
 * A host must look like a host.
 *
 * ssh takes options positionally, so a "host" beginning with `-` is read as one:
 * `-oProxyCommand=…` in this list would run an arbitrary command on THIS machine
 * every two minutes. The value comes from `.env` rather than from anything
 * remote, so this is a guard rather than a live hole, but the cost of closing it
 * is one regex and the cost of leaving it open is command execution.
 *
 * Deliberately narrow: an alias from `~/.ssh/config`, a hostname, or
 * `user@host`. Anything else is dropped and named in the log rather than passed
 * to ssh to see what happens.
 */
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Find node on a machine whose login shell never ran. nvm puts it on PATH from
 * `.bashrc`, which a non-interactive `ssh host cmd` does not source, so
 * `command -v node` alone returns nothing on exactly the box this was written
 * for. The glob is sorted by version so an nvm upgrade does not pin this to an
 * old install, and the whole thing is one line because it is passed as an
 * argument rather than written to the remote.
 */
const REMOTE_SH =
  'n=$(command -v node 2>/dev/null); ' +
  '[ -z "$n" ] && n=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1); ' +
  '[ -z "$n" ] && { echo "no node on this host" >&2; exit 127; }; ' +
  'exec "$n" --input-type=module -';

/** The hosts to ask, as SSH aliases. Unset means the feature is off. */
export function remoteHosts(env = process.env, log = () => {}) {
  const raw = (env.VAULT_HUD_REMOTE_HOSTS || '')
    .split(',').map((h) => h.trim()).filter(Boolean);
  const ok = raw.filter((h) => SAFE_HOST.test(h));
  for (const bad of raw.filter((h) => !ok.includes(h))) {
    log(`[vault-hud] remote: ignoring VAULT_HUD_REMOTE_HOSTS entry ${JSON.stringify(bad)}; ` +
      'a host must start alphanumeric and hold only letters, digits, dot, dash, underscore or @\n');
  }
  return ok;
}

let sourceCache = null;
async function resolverSource() {
  if (sourceCache) return sourceCache;
  const src = await readFile(join(HERE, 'account.js'), 'utf8');
  // The module has no CLI entry of its own, deliberately: it is imported by the
  // daemon and a top-level side effect would run on every import. The trailer is
  // added here, where the one caller that needs stdout lives.
  sourceCache = `${src}\nprocess.stdout.write(JSON.stringify(await resolveAccount()));\n`;
  return sourceCache;
}

async function askHost(host, timeoutMs) {
  const src = await resolverSource();
  return new Promise((resolve) => {
    const child = execFile('ssh', [
      '-o', 'BatchMode=yes',
      // Short, because this runs behind a live board. A host that is asleep or
      // off the tailnet must not hold the refresh open.
      '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
      host, REMOTE_SH,
    ], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        // The MESSAGE, never the whole error: execFile's error carries the
        // argv, which carries the host alias and would be fine, but also the
        // remote command, which is a shell line nobody needs on a board.
        const why = String(stderr || err.message || 'ssh failed').trim().split('\n')[0];
        return resolve({ ok: false, error: why.slice(0, 160) });
      }
      try {
        const a = JSON.parse(stdout);
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          return resolve({ ok: false, error: 'the resolver returned something that is not an account' });
        }
        return resolve({ ok: true, account: a });
      } catch {
        return resolve({ ok: false, error: 'the resolver returned unreadable JSON' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(src);
  });
}

// One entry per host, kept across refreshes. The LAST GOOD reading survives a
// failed pass on purpose: an unreachable machine is not a machine with no
// account, and the two rendered the same way is the 2026-08-10 defect — an empty
// result and an unreachable source must never be the same value in anything that
// publishes.
const state = new Map();
let inFlight = null;

async function refresh(hosts, deps) {
  const at = new Date(deps.now()).toISOString();
  await Promise.all(hosts.map(async (host) => {
    // The resolver source is read inside askHost, not here: it is a detail of
    // how the SSH path asks, and reading it here put real file I/O in front of
    // every refresh including the ones a test injects an `ask` for.
    const r = await deps.ask(host, deps.timeoutMs).catch((err) => ({
      ok: false, error: String(err?.message || err).slice(0, 160),
    }));
    const prev = state.get(host) ?? {};
    state.set(host, r.ok
      ? { host, account: r.account, at, reachable: true, error: null }
      : { host, account: prev.account ?? null, at: prev.at ?? null,
          reachable: false, error: r.error, checkedAt: at });
  }));
}

/**
 * The last known account for every configured host.
 *
 * NEVER BLOCKS. It returns whatever the cache holds and starts a refresh behind
 * it when the cache is old. The parse runs every 10 seconds and an SSH round
 * trip is about a second, so awaiting one here would put a network call on the
 * critical path of every board update — and a host that is asleep would stall
 * the whole parse until the timeout. The first call therefore returns an empty
 * reading and the next parse has the answer, which is the correct behaviour for
 * a board: it says "not yet" rather than waiting.
 *
 * Each entry is one of three states, and they are deliberately distinct:
 *   reachable: true   — asked and answered. `account` is current as of `at`.
 *   reachable: false  — asked and failed. `account` is the last good reading and
 *                       `at` is when it was taken, so the row can age it;
 *                       `error` says why this pass failed.
 *   absent            — never asked yet, or the host is not configured.
 */
export function readRemoteAccounts({
  hosts = remoteHosts(),
  now = () => Date.now(),
  ask = askHost,
  timeoutMs = TIMEOUT_MS,
  refreshMs = REFRESH_MS,
} = {}) {
  // Re-checked here, not only at parse time: a caller can pass `hosts` directly
  // and a guard that only runs on one path is a guard that will be walked around.
  const safe = hosts.filter((h) => typeof h === 'string' && SAFE_HOST.test(h));
  if (!safe.length) return [];
  hosts = safe;
  const stale = hosts.some((h) => {
    const e = state.get(h);
    if (!e) return true;
    const last = Date.parse(e.checkedAt ?? e.at ?? '');
    return !Number.isFinite(last) || now() - last >= refreshMs;
  });
  if (stale && !inFlight) {
    inFlight = refresh(hosts, { now, ask, timeoutMs })
      .catch(() => {})
      .finally(() => { inFlight = null; });
  }
  return hosts.map((h) => state.get(h)).filter(Boolean);
}

/** For tests: forget every cached reading. */
export function resetRemoteAccounts() {
  state.clear();
  inFlight = null;
  sourceCache = null;
}
