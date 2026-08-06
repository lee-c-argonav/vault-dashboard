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
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name.startsWith('.')) continue;
    let raw;
    try {
      raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      // A half-written file is normal; the writer may be mid-save. Skipping it
      // for one pass is right, crashing the whole parse over it is not.
      continue;
    }
    if (!isObj(raw) || typeof raw.runId !== 'string' || !raw.runId) continue;
    runs.push({
      runId: raw.runId,
      project: str(raw.project),
      goal: str(raw.goal, raw.runId),
      machine: str(raw.machine),
      state: RUN_STATES.has(raw.state) ? raw.state : 'running',
      note: str(raw.note),
      started: isoOrNull(raw.started),
      updated: isoOrNull(raw.updated),
      units: (Array.isArray(raw.units) ? raw.units : []).filter(isObj).map(normaliseUnit),
      needsInput: (Array.isArray(raw.needsInput) ? raw.needsInput : [])
        .filter(isObj)
        .map((n) => ({ question: str(n.question), since: isoOrNull(n.since) })),
      blockers: (Array.isArray(raw.blockers) ? raw.blockers : [])
        .filter(isObj)
        .map((b) => ({ what: str(b.what), since: isoOrNull(b.since) })),
    });
  }
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  return runs;
}
