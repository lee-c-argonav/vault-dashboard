// sessions.js — which agent sessions are alive on this machine right now.
//
// WHY THIS EXISTS. Until 2026-08-10 the board could only show a session that
// chose to describe itself, by writing a file into `15-Runs/`. Publishing is
// opt-in and gated on a size threshold, so most sessions never appeared at all:
// four were running on this machine and one was on the board. From the operator's
// side that reads as the instrument being broken, and he is right, because an
// instrument that shows one of the four things it is pointed at is not measuring.
//
// So liveness is now observed rather than declared. A run file still carries
// everything a row needs to be useful — units, sub-agents, the question waiting
// on you — and nothing here replaces it. What this adds is the floor: a session
// that publishes nothing still occupies a line, so the absence of a run file
// reads as "this session is not reporting" instead of as nothing at all.
//
// COST. Two child processes per sample, both read-only, both bounded: one `ps`
// for the whole table and one `lsof` over the pids it found. Measured together
// at about 90ms on this machine for four sessions. The vault re-parses every ten
// seconds, and paying 90ms of process spawn on that path would be most of the
// parse, so samples are cached for CACHE_MS and shared by every caller.
//
// SAFETY. Read-only inspection of the process table, the same posture as
// metrics.js and run-terminal.js. Every value reaches execFile as an argument
// and nothing is ever spliced into a shell. Nothing here writes anywhere.
//
// PRIVACY. The phone page is published to an unauthenticated URL, so no absolute
// path leaves this module. `where` is relative to $HOME and `project` is a single
// path segment, which matches what `60-Standards/run-status.md` already permits
// a run file to carry into the vault.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, basename } from 'node:path';

/**
 * The binaries whose processes count as an agent session.
 *
 * More than one, because `60-Standards/run-status.md` binds "every agent in
 * every repo, Claude and Kimi alike", and a discovery list that knew about only
 * one of them would reintroduce the invisibility this module exists to fix, just
 * for the other tool. Override with VAULT_HUD_AGENTS as a comma-separated list.
 */
const AGENT_COMMS = new Set(
  (process.env.VAULT_HUD_AGENTS ?? 'claude,kimi').split(',').map((s) => s.trim()).filter(Boolean),
);

/** How long a sample stays fresh. Shorter than the 10s vault parse, so a new
 *  session shows up on the next parse rather than the one after. */
export const CACHE_MS = 5_000;

/** A single `ps` line can be long; a runaway table must not become unbounded
 *  memory. 4MB is far past any real process table and far below trouble. */
const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT_MS = 3_000;

const TTY_RE = /^tty[a-zA-Z0-9]{1,12}$/;

/**
 * Parse `ps -Ao pid=,tty=,lstart=,comm=`.
 *
 * `comm` is last deliberately. It is the only field that can contain spaces in
 * practice, and `lstart` always spells five space-separated tokens
 * ("Mon Aug 10 13:29:48 2026"), so the line splits from both ends without
 * ambiguity. Splitting on whitespace from the left alone would break the moment
 * a command name contained one.
 */
export function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 8) continue;              // pid + tty + 5 lstart tokens + comm
    const pid = Number(parts[0]);
    const tty = parts[1];
    // basename, because `comm=` reports an absolute path on some systems and a
    // bare name on others.
    const comm = basename(parts.slice(7).join(' '));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!AGENT_COMMS.has(comm)) continue;
    // A session with no controlling terminal cannot be focused and is almost
    // always a helper process rather than an interactive session.
    if (!TTY_RE.test(tty)) continue;
    const since = Date.parse(parts.slice(2, 7).join(' '));
    out.push({
      pid,
      tty: `/dev/${tty}`,
      since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    });
  }
  return out;
}

/**
 * Parse `lsof -a -d cwd -p <pids> -Fpn` into pid → cwd.
 *
 * The `-F` machine format emits one field per line, prefixed by its letter, and
 * groups them under the most recent `p` line. Parsing it positionally rather
 * than by prefix would break on any process whose cwd could not be read.
 */
export function parseLsof(stdout) {
  const byPid = new Map();
  let pid = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) ? n : null;
    } else if (line.startsWith('n') && pid !== null) {
      byPid.set(pid, line.slice(1));
      pid = null;                                 // one cwd per process
    }
  }
  return byPid;
}

/**
 * Turn a working directory into the two things a surface may show.
 * Absolute paths never leave here; see PRIVACY above.
 */
export function describeCwd(cwd, home = homedir()) {
  if (!cwd) return { project: '', where: '' };
  const rel = relative(home, cwd);
  // `relative(home, home)` is '', so home itself would otherwise fall through to
  // basename(home), which is the account name. That is not a project and it is
  // not something to put on an unauthenticated page.
  if (rel === '') return { project: '~', where: '~' };
  // Outside $HOME entirely, or above it. Name the leaf and nothing else, so a
  // path like /Volumes/client-work/acme leaks its parent to nobody.
  const inHome = !rel.startsWith('..');
  return { project: basename(cwd), where: inHome ? rel : '' };
}

// `at: -Infinity`, not 0. A never-sampled cache must read as stale at every
// clock value, and `now - 0 < CACHE_MS` is true for any `now` under five
// seconds. Real callers pass Date.now() and would never have noticed.
let cache = { at: -Infinity, value: [] };

/** Drop the cache. Tests and a shutdown both want this; nothing else should. */
export function resetSessions() {
  cache = { at: -Infinity, value: [] };
}

/**
 * Every live agent session on this machine.
 *
 * Never throws and never rejects. This runs inside the vault parse, and a
 * machine where `ps` or `lsof` is missing, slow or sandboxed must degrade to an
 * empty list rather than take the whole panel down with it.
 *
 * @param {{now?: number, run?: (cmd: string, args: string[]) => Promise<string>}} opts
 * @returns {Promise<{pid: number, tty: string, project: string, where: string, since: string|null}[]>}
 */
export async function readSessions(opts = {}) {
  const now = opts.now ?? Date.now();
  const run = opts.run ?? sh;
  if (now - cache.at < CACHE_MS) return cache.value;

  // The default runner resolves '' on failure, but an injected one may throw and
  // a future `sh` could too. This sits on the vault parse path, where an
  // exception costs every panel in the window, not just this list.
  let value = [];
  try {
    const procs = parsePs(await run('ps', ['-Ao', 'pid=,tty=,lstart=,comm=']));
    let cwds = new Map();
    if (procs.length) {
      // One lsof for every pid at once. Per-pid calls cost a process spawn each
      // and this is on the parse path.
      const out = await run('lsof', ['-a', '-d', 'cwd', '-p', procs.map((p) => p.pid).join(','), '-Fpn']);
      cwds = parseLsof(out);
    }
    value = procs
      .map((p) => ({ ...p, ...describeCwd(cwds.get(p.pid)) }))
      .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? '') || a.pid - b.pid);
  } catch {
    // Cache the empty result like any other, so a machine without these tools
    // does not respawn them on every parse.
    value = [];
  }

  cache = { at: now, value };
  return value;
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) =>
      resolve(err ? '' : String(stdout)));
  });
}
