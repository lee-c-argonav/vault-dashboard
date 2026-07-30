#!/usr/bin/env node
// claims.js — vault markdown → typed, sourced claims. Read-only: nothing here
// writes to the vault.
//
// A wikilink says two notes touch. A claim says WHAT the relation is and WHICH
// file and line asserted it. The predicate comes from the enclosing `##` heading,
// so the vault's existing section conventions carry the typing and nothing has to
// be annotated by hand.
//
// Parsing primitives are imported from parse.js rather than reimplemented, so the
// claim layer and the HUD can never disagree about what a wikilink is.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  collectNotes, stripFences, buildResolver, wikilinkTargets, H2_RE, DECISION_RE,
} from './parse.js';

const DAILY_NOTE_RE = /^40-Daily\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Enclosing `##` section (lowercased) → predicate.
 *
 * Deliberately small. A predicate graduates only when a real query needs it;
 * everything else falls back to `related_to` and is reported by `--unmapped`, so
 * the map grows on evidence rather than on speculation.
 *
 * `human: true` marks the HUMAN ZONE sections of the project-hub template. Those
 * are the sections an agent may never write, so a claim from one is a human
 * assertion — the vault's equivalent of an asserted alias.
 */
export const PREDICATES = new Map([
  ['decisions', { predicate: 'decided_about', human: false }],
  ['recent decisions', { predicate: 'decided_about', human: false }],
  ['key docs & references', { predicate: 'references', human: false }],
  ['related patterns and standards', { predicate: 'governed_by', human: true }],
  ['what it is', { predicate: 'describes', human: true }],
  ['guiding values', { predicate: 'describes', human: true }],
  ['todos', { predicate: 'todo_on', human: false }],
  ['worked on', { predicate: 'worked_on', human: false }],
]);

export const FALLBACK = { predicate: 'related_to', human: false };

/**
 * Every claim and decision in the vault, plus the resolver that produced them.
 *
 * Claim shape — `source` and `line` are kept separate rather than joined into
 * `path:line`, matching the Todo shape parse.js already emits.
 *
 *   { subject, predicate, object, objectText, source, line, section, human, validFrom }
 *
 * `object` is the resolved note id, or null with the raw target preserved in
 * `objectText` — an unresolved link loses its target otherwise, and a broken link
 * is exactly the kind of thing worth being able to query for.
 */
export async function buildClaims(vaultPath) {
  const root = path.resolve(vaultPath);
  const notePaths = await collectNotes(root);
  const resolve = buildResolver(notePaths);

  const claims = [];
  const decisions = [];
  const unmapped = new Map();

  for (const rel of notePaths) {
    const id = rel.slice(0, -3);
    const dailyDate = DAILY_NOTE_RE.exec(rel)?.[1] ?? null;
    const lines = stripFences((await readFile(path.join(root, rel), 'utf8')).split(/\r?\n/));

    let section = null;
    lines.forEach((line, i) => {
      const heading = H2_RE.exec(line);
      if (heading) {
        section = heading[1];
        return;
      }
      const lineNo = i + 1;

      // A decision line is dated, and that date is the claim's valid_from. Read it
      // before the links on the line so both the decision and its links carry it.
      const decision = DECISION_RE.exec(line);
      const inDecisions = section !== null && /^(recent )?decisions$/i.test(section);
      if (decision && inDecisions) {
        decisions.push({ date: decision[1], text: decision[2].trim(), source: rel, line: lineNo });
      }

      const targets = wikilinkTargets(line);
      if (!targets.length) return;

      const key = section?.toLowerCase() ?? null;
      const mapped = key !== null ? PREDICATES.get(key) : undefined;
      const { predicate, human } = mapped ?? FALLBACK;
      if (mapped === undefined && section !== null) {
        unmapped.set(section, (unmapped.get(section) ?? 0) + targets.length);
      }

      // decided_about takes the date off the line; worked_on takes it off the
      // daily note's filename. Both come free from conventions already in use.
      const validFrom = (decision && inDecisions) ? decision[1]
        : predicate === 'worked_on' ? dailyDate
        : null;

      for (const target of targets) {
        const { id: objectId } = resolve(target);
        if (objectId === id) continue;                 // a note linking to itself is not an edge
        claims.push({
          subject: id,
          predicate,
          object: objectId,
          objectText: objectId ? null : target,
          source: rel,
          line: lineNo,
          section,
          human,
          validFrom,
        });
      }
    });
  }

  decisions.sort((a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source) || a.line - b.line);

  return {
    vaultPath: root,
    claims,
    decisions,
    notePaths,
    resolve,
    unmapped: [...unmapped].map(([section, count]) => ({ section, count }))
      .sort((a, b) => b.count - a.count || a.section.localeCompare(b.section)),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const vaultPath = process.env.VAULT_HUD_VAULT ?? path.join(homedir(), 'Obsidian', 'vault');
  const index = await buildClaims(vaultPath);

  if (process.argv.includes('--json')) {
    const { resolve: _drop, ...serialisable } = index;
    process.stdout.write(`${JSON.stringify(serialisable, null, 2)}\n`);
  } else if (process.argv.includes('--unmapped')) {
    const out = [`${index.unmapped.length} unmapped sections (links fell back to related_to)`];
    for (const u of index.unmapped) out.push(`  ${String(u.count).padStart(4)}  ${u.section}`);
    process.stdout.write(`${out.join('\n')}\n`);
  } else {
    const byPredicate = new Map();
    for (const c of index.claims) byPredicate.set(c.predicate, (byPredicate.get(c.predicate) ?? 0) + 1);
    const out = [
      `CLAIMS  ${index.claims.length} across ${index.notePaths.length} notes`,
      ...[...byPredicate].sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `  ${String(n).padStart(4)}  ${p}`),
      '',
      `DECISIONS  ${index.decisions.length}`,
      `UNRESOLVED ${index.claims.filter((c) => c.object === null).length} (target kept in objectText)`,
      `HUMAN      ${index.claims.filter((c) => c.human).length} from HUMAN ZONE sections`,
      `UNMAPPED   ${index.unmapped.length} sections — run --unmapped to grow the predicate map`,
    ];
    process.stdout.write(`${out.join('\n')}\n`);
  }
}
