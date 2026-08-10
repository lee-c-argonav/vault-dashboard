// run-terminal.js — focus the Terminal tab a run is executing in.
//
// THREAT MODEL, continuous with shortcuts.js. The browser supplies an id and
// nothing else: `run:<runId>`. The tty is never sent by the page. The server
// reads it from the run's own file in 15-Runs/, which it already parses for the
// panel, then checks it against a strict device pattern before use. So the only
// value that can reach osascript is one an agent wrote into the vault, in the
// shape of a tty device path, OR one resolved from the live process table by
// inferTty below. Either way it is checked against TTY_RE before use and reaches
// osascript as an `on run argv` argument, never spliced into script text and
// never through a shell.
//
// Everything here is best-effort. A run may predate the tty field, its session
// may have been closed, or Terminal may not be running. None of those are
// errors worth surfacing as failures; they are simply "nothing to focus".

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns } from './runs.js';
import { readSessions } from './sessions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'focus-terminal.applescript');

// /dev/ttys003 and friends. Anything else never reaches execFile.
const TTY_RE = /^\/dev\/tty[a-zA-Z0-9]{1,12}$/;

export const RUN_PREFIX = 'run:';
export const SESSION_PREFIX = 'session:';

/**
 * Focus the terminal of a live session that is publishing no run file.
 *
 * The page sends a pid and nothing else. The tty is looked up in the live
 * process table by that pid and checked against TTY_RE before use, so the same
 * rule holds as for `run:`: no device path supplied by the browser can ever
 * reach osascript. A pid that is not a live agent session resolves to nothing.
 */
export async function focusSessionTerminal(id) {
  const pid = Number(id.slice(SESSION_PREFIX.length));
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, status: 400, error: 'bad pid' };

  const sessions = await readSessions();
  const session = sessions.find((s) => s.pid === pid);
  // Gone since the page last rendered is the normal case, not an error worth a
  // stack trace: the session may have exited seconds ago.
  if (!session) return { ok: false, status: 404, error: 'no such live session' };
  return focusTty(session.tty);
}

/**
 * @param {string} id  an action id of the form `run:<runId>`
 * @param {string} vaultPath
 * @returns {Promise<{ok: boolean, status?: number, error?: string, result?: string}>}
 */
export async function focusRunTerminal(id, vaultPath) {
  const runId = id.slice(RUN_PREFIX.length);
  if (!runId) return { ok: false, status: 400, error: 'missing run id' };

  let runs;
  try {
    runs = await readRuns(vaultPath);
  } catch {
    return { ok: false, status: 500, error: 'cannot read runs' };
  }
  const run = runs.find((r) => r.runId === runId);
  if (!run) return { ok: false, status: 404, error: 'unknown run' };

  // A recorded tty is authoritative. Sessions that predate the field have none,
  // so fall back to inferring it from the live agent processes. Inference is a
  // heuristic and is reported as one; it never overrides a recorded value.
  let tty = run.tty;
  let inferred = false;
  if (!tty) {
    tty = await inferTty(run);
    inferred = Boolean(tty);
  }
  if (!tty) return { ok: false, status: 404, error: 'no terminal recorded or inferable' };
  return { ...(await focusTty(tty)), inferred };
}

/**
 * The one place a tty reaches osascript. Every caller routes through here so the
 * device-pattern check cannot be skipped by adding a second entry point, and the
 * value arrives as an `on run argv` argument rather than spliced into script
 * text or passed through a shell.
 */
async function focusTty(tty) {
  if (!TTY_RE.test(tty)) return { ok: false, status: 400, error: 'not a tty path' };
  return new Promise((resolve) => {
    execFile('osascript', [SCRIPT, tty], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, status: 500, error: 'osascript failed' });
      const result = String(stdout).trim();
      // notfound is a normal outcome, not a failure: the tab may be closed.
      resolve({ ok: result === 'ok', status: result === 'ok' ? 200 : 404, result, tty });
    });
  });
}

/**
 * Best-effort: which Terminal tab is this run probably in?
 *
 * Matches live agent processes by working directory against the run's project,
 * then breaks ties on start time, because two sessions can sit in the same repo.
 * Everything here is read-only inspection of the process table, in the same
 * spirit as metrics.js, and the result is always flagged `inferred` so a caller
 * never mistakes a guess for something the run actually recorded.
 */
async function inferTty(run) {
  if (!run.project) return '';
  const started = Date.parse(run.started);

  // sessions.js, not a second walk of the process table. This function used to
  // spawn `pgrep` once plus `ps` and `lsof` per pid, which is 1 + 2n processes
  // for a result sessions.js already has cached from the last vault parse. Two
  // readers of the same table also means two places to fix when the shape of it
  // changes, which is the divergence ERRORS.md records for the two renderers.
  const candidates = (await readSessions())
    .filter((s) => s.project === run.project)
    .map((s) => ({ tty: s.tty, begun: Date.parse(s.since) }));

  if (!candidates.length) return '';
  if (candidates.length === 1) return candidates[0].tty;

  // The owning session must have been alive before its run started. Among those,
  // the one that began most recently is the closest fit.
  const before = candidates
    .filter((c) => Number.isFinite(c.begun) && Number.isFinite(started) && c.begun <= started)
    .sort((a, b) => b.begun - a.begun);
  // No usable start stamp means no way to tell two sessions in the same repo
  // apart. Raising an arbitrary one is worse than raising none.
  return before[0] ? before[0].tty : '';
}
