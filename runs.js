// runs.js — read 15-Runs/*.json into State. Pure, read-only, no clock.
//
// Every field is whitelisted and type-checked rather than spread through. A run
// file is written by an agent under time pressure and this parse feeds the whole
// HUD: one bad field must cost that row, never the vault.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const RUN_STATES = new Set(['running', 'paused', 'done']);
const UNIT_STATES = new Set(['todo', 'running', 'done', 'blocked', 'failed']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function normaliseUnit(u) {
  return {
    id: str(u.id),
    label: str(u.label),
    state: UNIT_STATES.has(u.state) ? u.state : 'todo',
    started: isoOrNull(u.started),
    ended: isoOrNull(u.ended),
    // Subagents belong to the unit that fanned them out, not to the run. An
    // agent with no label is dropped: an unnamed row conveys nothing and would
    // still occupy the space of a named one.
    agents: (Array.isArray(u.agents) ? u.agents : [])
      .filter((a) => isObj(a) && typeof a.label === 'string' && a.label)
      .map((a) => ({
        label: a.label,
        state: UNIT_STATES.has(a.state) ? a.state : 'running',
        started: isoOrNull(a.started),
        ended: isoOrNull(a.ended),
      })),
  };
}

/**
 * The full result of a read: the runs, whether the folder could be read at all,
 * and how many files were unusable.
 *
 * `unreadable` exists because an empty array had two meanings that no caller
 * could tell apart: "this vault has no runs" and "I could not open this vault".
 * The long-lived server is right to treat both as nothing to show, since a
 * transient failure resolves on the next 10-second pass. A one-shot build that
 * PUBLISHES the result is not: on 2026-08-06 a mis-resolved vault path made the
 * phone page render "No run is publishing status" over a live board, with a
 * current timestamp on it, every time it deployed. Four days passed before
 * anyone noticed, because a blank board and a quiet board draw the same picture.
 *
 * @returns {Promise<{runs: object[], unreadable: boolean, skipped: number}>}
 */
export async function readRunsDetailed(vaultPath) {
  return readRunDir(join(vaultPath, '15-Runs'));
}

/**
 * Runs the vault has closed out: everything under `99-Archive/runs/`.
 *
 * Being in the archive is the stronger statement than any `state` the file
 * carries, so every run read here is reported `done`. A file left `running` in
 * there is a session that died before it finished writing, not live work, and
 * showing it as running on a history page would be a claim nobody can act on.
 *
 * An absent archive is an empty history rather than a failure. Unlike `15-Runs`
 * this folder is not load-bearing: a vault that has never closed a run out has
 * nothing here and that is the correct answer.
 */
export async function readFinishedRuns(vaultPath) {
  return (await readFinishedRunsDetailed(vaultPath)).runs;
}

/**
 * The archive, plus whether it could be read.
 *
 * Same reason `readRunsDetailed` exists: a permissions failure on the archive is
 * indistinguishable from an empty one once the error is swallowed, and "no
 * finished runs" is then displayed with nothing saying why. Absent is still not
 * an error — a vault that has never closed a run out has nothing here — but
 * absent and unreadable are no longer the same value.
 */
export async function readFinishedRunsDetailed(vaultPath) {
  const { runs, unreadable, skipped } = await readRunDir(join(vaultPath, '99-Archive', 'runs'));
  return { runs: runs.map((r) => ({ ...r, state: 'done' })), unreadable, skipped };
}

async function readRunDir(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { runs: [], unreadable: true, skipped: 0 };
  }
  const runs = [];
  let skipped = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name.startsWith('.')) continue;
    let raw;
    let wrote = null;
    try {
      const full = join(dir, name);
      // When the writer last touched this file. Ground truth for liveness: it is
      // a direct measurement rather than a stamp the writing agent generates,
      // and so cannot be skewed by that agent's clock. Observed 2026-08-10: a
      // run written at 19:07:10Z claimed `updated: 17:21:00Z`, and the board
      // reported it silent for 2h46m when the real figure was under 40 minutes.
      //
      // Caveat, stated because it is the one way this can mislead: anything that
      // rewrites the file without the run writing it — a checkout, an rsync —
      // resets mtime and would make a dead run look recent. That is rarer, and
      // more visible, than the clock skew the standard already warns writers
      // about, so mtime is the better of the two sources rather than a perfect
      // one. `updated` is still carried and still checked against it.
      wrote = (await stat(full)).mtime.toISOString();
      const text = await readFile(full, 'utf8');
      // A leading BOM makes JSON.parse throw forever, not transiently. Without
      // stripping it a run written by a BOM-emitting editor never appears and
      // there is nothing to see anywhere explaining why.
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      // A half-written file is normal; the writer may be mid-save. Skipping it
      // for one pass is right, crashing the whole parse over it is not.
      skipped += 1;
      continue;
    }
    if (!isObj(raw) || typeof raw.runId !== 'string' || !raw.runId) {
      skipped += 1;
      continue;
    }
    runs.push({
      runId: raw.runId,
      project: str(raw.project),
      goal: str(raw.goal, raw.runId),
      machine: str(raw.machine),
      state: RUN_STATES.has(raw.state) ? raw.state : 'running',
      note: str(raw.note),
      // The Terminal tab this run is executing in, so the HUD can focus it.
      // Validated against a device pattern in run-terminal.js before it is used.
      tty: str(raw.tty),
      started: isoOrNull(raw.started),
      updated: isoOrNull(raw.updated),
      wrote,
      // An id is required: a bare {} would otherwise normalise into a real unit,
      // inflating the count and drawing a tick for something that does not exist.
      units: (Array.isArray(raw.units) ? raw.units : [])
        .filter((u) => isObj(u) && typeof u.id === 'string' && u.id)
        .map(normaliseUnit),
      needsInput: (Array.isArray(raw.needsInput) ? raw.needsInput : [])
        .filter(isObj)
        .map((n) => ({ question: str(n.question), since: isoOrNull(n.since) })),
      blockers: (Array.isArray(raw.blockers) ? raw.blockers : [])
        .filter(isObj)
        .map((b) => ({ what: str(b.what), since: isoOrNull(b.since) })),
    });
  }
  // One run, one row. Two files claiming the same id means a stale copy was left
  // behind, and the phone page keys on runId, so duplicates corrupt that key
  // space. The later-updated file is the live writer.
  const byId = new Map();
  for (const r of runs) {
    const prev = byId.get(r.runId);
    if (!prev || (r.updated ?? '') > (prev.updated ?? '')) byId.set(r.runId, r);
  }
  if (byId.size !== runs.length) skipped += runs.length - byId.size;
  return {
    runs: [...byId.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
    unreadable: false,
    skipped,
  };
}

/**
 * The runs alone. Every caller that only draws rows uses this; the two that must
 * react to a failed read (parse.js, which raises a warning, and the status-page
 * build, which refuses to publish) call readRunsDetailed instead.
 */
export async function readRuns(vaultPath) {
  return (await readRunsDetailed(vaultPath)).runs;
}
