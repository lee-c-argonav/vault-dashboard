#!/usr/bin/env node
// check.js — verdicts over the claim index, for grounded review agents.
//
// The point of this layer is to replace "this seems off" with a verdict class and
// a citation. Its most important property is what it REFUSES to say.
//
// The graph-backed design this borrows from returns `contradicted` whenever two
// entities are linked under any predicate other than the asserted one. That
// generalises badly to a link graph over prose: a note
// being `related_to` another rather than `references` is not a contradiction, and
// reporting one manufactures exactly the false vetoes this surface exists to
// prevent. Differing predicates report `related` here, and `vetoBasis` is false on
// every verdict this layer can return — a link graph holds assertions, not
// refutations, so it can never prove a negative.

import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const join = path.join;

import { buildClaims } from './claims.js';
import { buildResolver } from './parse.js';

const NO_EVIDENCE = 'no vault evidence';

/**
 * Resolve a bare name, basename or relative path to a note id.
 *
 * `buildClaims` hands back a live resolver, but `claims.js --json` cannot serialise
 * a function, so an index round-tripped through JSON arrives without one. Rebuild
 * it from notePaths in that case rather than throwing a TypeError, which makes the
 * dump a first-class input to these checks.
 */
function resolveNote(index, name) {
  if (typeof index.resolve !== 'function') index.resolve = buildResolver(index.notePaths);
  return index.resolve(String(name ?? '').trim()).id;
}

/**
 * Is the triple (subject, predicate, object) asserted by the vault?
 *
 *   supported          — asserted; every source is cited
 *   related            — the two notes are linked, under different predicate(s)
 *   no vault evidence  — a note is unknown, or nothing connects them
 *
 * None of these is a veto basis. "no vault evidence" in particular means the vault
 * is silent, which is not the same as the claim being false.
 */
export function checkClaim(index, subject, predicate, object) {
  const s = resolveNote(index, subject);
  const o = resolveNote(index, object);
  if (!s || !o) {
    const missing = [!s && `subject "${subject}"`, !o && `object "${object}"`].filter(Boolean).join(' and ');
    return { verdict: NO_EVIDENCE, detail: `${missing} not in the vault`, evidence: [], held: [], humanAsserted: false, vetoBasis: false };
  }

  const between = index.claims.filter((c) => c.subject === s && c.object === o);
  const wanted = String(predicate ?? '').trim().toLowerCase();
  const exact = between.filter((c) => c.predicate.toLowerCase() === wanted);

  const cite = (c) => ({ predicate: c.predicate, source: c.source, line: c.line, section: c.section, human: c.human, validFrom: c.validFrom });

  if (exact.length) {
    return {
      verdict: 'supported',
      triple: `(${s}, ${exact[0].predicate}, ${o})`,
      evidence: exact.map(cite),
      held: [],
      humanAsserted: exact.some((c) => c.human),
      vetoBasis: false,
    };
  }
  if (between.length) {
    return {
      verdict: 'related',
      detail: `the vault links ${s} to ${o}, but not as "${predicate}". This is NOT a contradiction and NOT a basis for rejection.`,
      evidence: [],
      held: between.map(cite),
      humanAsserted: between.some((c) => c.human),
      vetoBasis: false,
    };
  }
  return { verdict: NO_EVIDENCE, detail: `no claims between ${s} and ${o}`, evidence: [], held: [], humanAsserted: false, vetoBasis: false };
}

/**
 * Search the dated decision ledger. This is where the vault's propositional truth
 * lives — most real questions ("did we decide X?") are answered here rather than by
 * the link graph.
 *
 * Matches are returned newest first and nothing is inferred about reversal: the
 * ledger is append-only and a decision that turned out wrong has its reversal
 * appended below it, so the newest dated entry on a topic is the live one. Guessing
 * at that with a regex would be a fragile way to sound confident.
 */
export function checkDecision(index, query) {
  const q = String(query ?? '').trim();
  if (!q) return { verdict: NO_EVIDENCE, query, matchMode: 'word', matches: [], vetoBasis: false };

  // Word-boundary first. A naive substring search for "Linear" matches a decision
  // about `scaleLinear`, which is a different subject entirely — precision matters
  // more than recall when the output is evidence. Substring is kept as a fallback
  // for genuine partial-word queries, and the mode is reported so a reader knows
  // which one produced the matches.
  const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b${literal}\\b`, 'i');
  let matchMode = 'word';
  let matches = index.decisions.filter((d) => word.test(d.text));
  if (!matches.length) {
    const lower = q.toLowerCase();
    const loose = index.decisions.filter((d) => d.text.toLowerCase().includes(lower));
    if (loose.length) { matchMode = 'substring'; matches = loose; }
  }

  return {
    verdict: matches.length ? 'decisions found' : NO_EVIDENCE,
    query,
    matchMode,
    note: matches.length > 1 ? 'Sorted newest first. The ledger is append-only: the newest dated entry on a topic is the live one.' : undefined,
    matches,
    vetoBasis: false,
  };
}

/** One note with everything the vault asserts about it, in and out, plus its decisions. */
export function getNote(index, name) {
  const id = resolveNote(index, name);
  if (!id) return { error: `no note matching "${name}"` };
  const rel = `${id}.md`;
  return {
    note: id,
    outbound: index.claims.filter((c) => c.subject === id),
    inbound: index.claims.filter((c) => c.object === id),
    decisions: index.decisions.filter((d) => d.source === rel),
  };
}

// Resolve the vault the same way server.js does: an explicit env var wins, else the
// repo's own .env, else the generic default. Without this the CLI needs a
// VAULT_HUD_VAULT prefix on every invocation from another repo, which is exactly the
// friction that stops it being used.
function vaultPathFromEnv() {
  if (!process.env.VAULT_HUD_VAULT) {
    try { process.loadEnvFile(join(HERE, '.env')); } catch { /* no .env is fine */ }
  }
  return process.env.VAULT_HUD_VAULT ?? join(homedir(), 'Obsidian', 'vault');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const vaultPath = vaultPathFromEnv();
  const index = await buildClaims(vaultPath);

  const run = {
    claim: () => checkClaim(index, rest[0], rest[1], rest[2]),
    decision: () => checkDecision(index, rest.join(' ')),
    note: () => getNote(index, rest.join(' ')),
  }[cmd];

  if (!run) {
    process.stderr.write([
      'usage:',
      '  node check.js claim    <subject> <predicate> <object>',
      '  node check.js decision <query text>',
      '  node check.js note     <note name>',
      '',
    ].join('\n'));
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`);
}
