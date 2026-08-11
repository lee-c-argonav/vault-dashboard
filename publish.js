// publish.js — keep the published status page from going stale.
//
// WHY THIS IS NOT A LAUNCHD TIMER. It was one first, and macOS refused it. The
// repository and the vault both live under `~/Desktop`, which is TCC-protected,
// and a LaunchAgent runs headless so it never gets the consent prompt that would
// grant access. The job failed on every fire with
//
//     shell-init: error retrieving current directory: getcwd: Operation not permitted
//     /bin/bash: .../status-page/deploy.sh: Operation not permitted
//
// and exit code 126. Making it work needs Full Disk Access granted to /bin/bash
// in System Settings, which is a far broader grant than this deserves.
// `launchd/local.vault-hud-status.plist` is kept for anyone who would rather
// take that route; it is correct apart from the permission.
//
// The server is already running with the grants it needs, because it is started
// from a terminal the operator has consented for, and it already outlives every
// individual session. So the timer lives here.
//
// WHAT THIS DOES NOT DO. It never writes to the vault. server.js is read-only
// with respect to the vault and stays that way; this spawns a build-and-upload
// of a page derived from it. The daemon already spawns child processes for
// metrics, sessions and terminal focus, so the mechanism is not new, but the
// network egress is, which is why it is off unless explicitly switched on.
//
// OFF BY DEFAULT. A daemon that uploads to the internet every few minutes is not
// something anybody should acquire by upgrading. Set VAULT_HUD_PUBLISH=1 in
// .env to turn it on.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, boardDigest } from './status-page/build.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'status-page', 'deploy.sh');

/**
 * How often the board is CHECKED. Not how often it deploys — `decideAndDeploy`
 * skips when the digest is unchanged, and MIN_DEPLOY_INTERVAL_MS bounds the rest.
 *
 * Sixty seconds rather than five minutes, because the page's worst case was
 * five minutes of publisher plus two of page reload: seven minutes behind a
 * board whose whole purpose is telling you something needs you.
 */
export const PUBLISH_MS = 60_000;

/**
 * The floor between two uploads, independent of the tick.
 *
 * A fast tick is not a fast deploy rate unless something says so. The overlap
 * guard below assumed "the tick is five minutes, so this should never fire";
 * at 60s a 40-second upload leaves 20 seconds of headroom and a slow one starts
 * dropping ticks silently. This bounds the rate directly: at 120s the ceiling
 * is 720 uploads a day, against 288 ticks a day before this change, and the
 * digest suppresses almost all of them.
 *
 * Raise it if the hosting plan caps deployments — a 100/day cap implies roughly
 * 900s here. VAULT_HUD_MIN_DEPLOY_MS overrides it without a code change.
 */
export const MIN_DEPLOY_INTERVAL_MS =
  Number(process.env.VAULT_HUD_MIN_DEPLOY_MS) || 120_000;
/** A deploy that hangs must not stack up behind the next tick. */
const DEPLOY_TIMEOUT_MS = 4 * 60_000;

let timer = null;
let inFlight = false;
let last = { at: null, ok: null, error: '', skipped: 0, deploys: 0 };
/** Digest of the board as last uploaded. */
let publishedDigest = null;
/** When the last upload actually started, for MIN_DEPLOY_INTERVAL_MS. */
let lastDeployAt = 0;

/** What the last attempt did. server.js surfaces this so a dead publisher is visible. */
export function publishStatus() {
  return { ...last, enabled: Boolean(timer) };
}

/** Forget what was published, so the next tick uploads whatever it finds. */
export function resetPublished() {
  publishedDigest = null;
  lastDeployAt = 0;
  last = { at: null, ok: null, error: '', skipped: 0, deploys: 0 };
}

/**
 * Run one deploy. Never throws: this is called from a timer with no caller to
 * catch it, and taking the daemon down because Vercel had a bad minute would
 * cost the desktop board too.
 */
export function publishOnce(log = () => {}) {
  // Overlap guard. It used to say "the tick is five minutes, so this should never
  // fire"; the tick is 60 seconds now and a 40-second upload leaves 20 seconds of
  // headroom, so this fires routinely and `last.skipped` counts it. That is the
  // intended behaviour — MIN_DEPLOY_INTERVAL_MS bounds the rate — but the comment
  // claiming otherwise had to go with the number it described.
  if (inFlight) {
    log('[vault-hud] publish skipped, previous deploy still running\n');
    return Promise.resolve(false);
  }
  inFlight = true;
  return decideAndDeploy(log).finally(() => { inFlight = false; });
}

/**
 * Read the board first, and upload only if it says something new.
 *
 * Without this the timer uploads 288 times a day and almost every one repeats
 * the last. Reading costs a handful of file reads against a Vercel deploy of
 * tens of seconds.
 *
 * A read failure is a real failure and is reported. It is also the unreadable
 * vault guard doing its job: it throws here rather than deploying a blank board.
 */
async function decideAndDeploy(log) {
  let digest;
  try {
    // Reads the same files the build would, without rendering. deploy.sh does
    // the real build when we decide to upload, and must keep doing so for the
    // manual path.
    //
    // The clock is passed, and has to be. It is what applies the five-day
    // window to finished runs, and reading without it produced a digest over a
    // different board than the one deploy.sh renders: a run ageing out changed
    // the page and not the check, so the last run to expire would have stayed
    // on the phone until something else happened to move the digest. Nothing
    // clock-derived is hashed — boardDigest takes only the run data — so this
    // does not make the digest tick.
    digest = boardDigest(await readBoard(process.env.VAULT_HUD_VAULT, undefined, Date.now()));
  } catch (err) {
    last = { ...last, at: new Date().toISOString(), ok: false, error: String(err.message).trim() };
    log(`[vault-hud] publish failed before upload: ${last.error}\n`);
    return false;
  }
  if (digest === publishedDigest) {
    last = { ...last, at: new Date().toISOString(), ok: true, error: '', skipped: last.skipped + 1 };
    return false;
  }
  // Something changed, but not long enough since the last upload. Return
  // WITHOUT recording the digest, so the next tick uploads it rather than
  // treating a rate-limited change as published.
  const since = Date.now() - lastDeployAt;
  if (lastDeployAt && since < MIN_DEPLOY_INTERVAL_MS) {
    last = {
      ...last, at: new Date().toISOString(), ok: true, error: '',
      throttled: (last.throttled ?? 0) + 1,
    };
    return false;
  }
  lastDeployAt = Date.now();
  const ok = await deploy(log);
  // Only a confirmed upload updates the mark. A failed deploy must retry on the
  // next tick rather than believe it published.
  if (ok) publishedDigest = digest;
  return ok;
}

function deploy(log) {
  return new Promise((resolve) => {
    // `detached` puts bash in its own process group so the whole tree can be
    // signalled, and the timeout is enforced here rather than by execFile.
    // execFile's own timeout signals only the direct child: it would kill bash
    // and leave the `vercel` grandchild uploading, `inFlight` would clear, and
    // the next tick would start a second upload alongside the first — the exact
    // overlap the guard in publishOnce claims to prevent.
    const child = execFile('/bin/bash', [SCRIPT], { cwd: HERE, detached: true },
      (err, stdout, stderr) => {
        clearTimeout(killer);
        last = {
          ...last,
          at: new Date().toISOString(),
          ok: !err,
          // deploy.sh refuses to publish an unreadable vault and says so on
          // stderr. Keeping the reason is the difference between a publisher
          // that is broken and one that is merely quiet.
          error: err ? String(stderr || err.message).trim().split('\n').slice(-2).join(' ') : '',
          deploys: err ? last.deploys : last.deploys + 1,
        };
        log(err
          ? `[vault-hud] publish failed: ${last.error}\n`
          : `[vault-hud] published: ${String(stdout).trim().split('\n').pop()}\n`);
        resolve(!err);
      });

    // Kill the GROUP, not the child. `-pid` addresses the process group that
    // `detached` created, so bash and every descendant including vercel get the
    // signal. Wrapped because the group is gone the moment the child exits
    // normally, and killing a dead group throws ESRCH.
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      log(`[vault-hud] publish timed out after ${Math.round(DEPLOY_TIMEOUT_MS / 60_000)}m, killed\n`);
    }, DEPLOY_TIMEOUT_MS);
    killer.unref();
  });
}

/** Start the timer. Returns false when publishing is switched off. */
export function startPublishing(log = () => {}) {
  if (process.env.VAULT_HUD_PUBLISH !== '1') return false;
  if (timer) return true;
  // Fire once on start, so a wrong path or a logged-out CLI is discovered now
  // rather than in five minutes.
  publishOnce(log);
  timer = setInterval(() => publishOnce(log), PUBLISH_MS);
  timer.unref();
  return true;
}

export function stopPublishing() {
  clearInterval(timer);
  timer = null;
}
