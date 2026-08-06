// runs.js — read 15-Runs/*.json into State. Pure, read-only, no clock.
//
// Every field is whitelisted and type-checked rather than spread through. A run
// file is written by an agent under time pressure and this parse feeds the whole
// HUD: one bad field must cost that row, never the vault.

import { readdir, readFile } from 'node:fs/promises';
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

export async function readRuns(vaultPath) {
  const dir = join(vaultPath, '15-Runs');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs = [];
  let skipped = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name.startsWith('.')) continue;
    let raw;
    try {
      const text = await readFile(join(dir, name), 'utf8');
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
      started: isoOrNull(raw.started),
      updated: isoOrNull(raw.updated),
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
  // KNOWN GAP: `skipped` is counted and dropped. A property hung on the returned
  // array would not survive JSON.stringify into State, so surfacing it properly
  // means routing it through `warnings` in parse.js. Until then, a file this
  // reader cannot use is a run that never appears with nothing explaining why.
  void skipped;
  return [...byId.values()].sort((a, b) => a.runId.localeCompare(b.runId));
}
