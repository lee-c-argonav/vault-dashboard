// run-terminal.js — focus the Terminal tab a run is executing in.
//
// THREAT MODEL, continuous with shortcuts.js. The browser supplies an id and
// nothing else: `run:<runId>`. The tty is never sent by the page. The server
// reads it from the run's own file in 15-Runs/, which it already parses for the
// panel, then checks it against a strict device pattern before use. So the only
// value that can reach osascript is one an agent wrote into the vault, in the
// shape of a tty device path, and osascript receives it as an `on run argv`
// argument rather than spliced into the script text.
//
// Everything here is best-effort. A run may predate the tty field, its session
// may have been closed, or Terminal may not be running. None of those are
// errors worth surfacing as failures; they are simply "nothing to focus".

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns } from './runs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'focus-terminal.applescript');

// /dev/ttys003 and friends. Anything else never reaches execFile.
const TTY_RE = /^\/dev\/tty[a-zA-Z0-9]{1,12}$/;

export const RUN_PREFIX = 'run:';

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
  if (!run.tty) return { ok: false, status: 404, error: 'run recorded no terminal' };
  if (!TTY_RE.test(run.tty)) return { ok: false, status: 400, error: 'not a tty path' };

  return new Promise((resolve) => {
    execFile('osascript', [SCRIPT, run.tty], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, status: 500, error: 'osascript failed' });
      const result = String(stdout).trim();
      // notfound is a normal outcome, not a failure: the tab may be closed.
      resolve({ ok: result === 'ok', status: result === 'ok' ? 200 : 404, result });
    });
  });
}
