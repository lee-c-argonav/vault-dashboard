// check.test.js — the verdict layer. The load-bearing case is that a differing
// predicate reports `related`, never `contradicted`: over-rejection is the failure
// mode this whole surface exists to prevent.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaims } from '../claims.js';
import { checkClaim, checkDecision, getNote } from '../check.js';
import { makeVault, cleanup } from './fixture.js';

let root;
let index;

before(async () => {
  root = await makeVault();
  index = await buildClaims(root);
});
after(() => cleanup(root));

describe('checkClaim', () => {
  test('an asserted relation is supported and cites its source', () => {
    const r = checkClaim(index, 'widget', 'governed_by', 'style-rules');
    assert.equal(r.verdict, 'supported');
    assert.equal(r.evidence.length, 1);
    assert.equal(r.evidence[0].source, '10-Projects/widget.md');
    assert.equal(r.evidence[0].line, 21);
  });

  test('a claim from a HUMAN ZONE section is flagged human-asserted', () => {
    assert.equal(checkClaim(index, 'widget', 'governed_by', 'style-rules').humanAsserted, true);
    assert.equal(checkClaim(index, 'widget', 'todo_on', 'gadget-study').humanAsserted, false);
  });

  test('a different predicate between linked notes is `related`, NOT `contradicted`', () => {
    const r = checkClaim(index, 'widget', 'depends_on', 'style-rules');
    assert.equal(r.verdict, 'related');
    assert.notEqual(r.verdict, 'contradicted');
    assert.deepEqual(r.held.map((h) => h.predicate), ['governed_by']);
  });

  test('`related` is explicitly marked as not a veto basis', () => {
    assert.equal(checkClaim(index, 'widget', 'depends_on', 'style-rules').vetoBasis, false);
  });

  test('no verdict this layer can return is ever a veto basis', () => {
    // The vault holds link claims, not refutations: nothing here can prove a
    // negative, so nothing here may justify rejecting a change on its own.
    const cases = [
      checkClaim(index, 'widget', 'governed_by', 'style-rules'),
      checkClaim(index, 'widget', 'depends_on', 'style-rules'),
      checkClaim(index, 'widget', 'governed_by', 'sprocket'),
      checkClaim(index, 'ghost-note', 'governed_by', 'style-rules'),
    ];
    for (const r of cases) assert.equal(r.vetoBasis, false, `${r.verdict} must not be a veto basis`);
  });

  test('an unknown subject is no vault evidence, and says which side was missing', () => {
    const r = checkClaim(index, 'ghost-note', 'governed_by', 'style-rules');
    assert.equal(r.verdict, 'no vault evidence');
    assert.match(r.detail, /ghost-note/);
  });

  test('two known notes with no connection is no vault evidence', () => {
    const r = checkClaim(index, 'style-rules', 'governed_by', 'sprocket');
    assert.equal(r.verdict, 'no vault evidence');
  });

  test('resolution is by basename, so a bare note name works', () => {
    assert.equal(checkClaim(index, 'widget', 'describes', 'sprocket').verdict, 'supported');
  });

  test('predicate matching is case-insensitive', () => {
    assert.equal(checkClaim(index, 'widget', 'GOVERNED_BY', 'style-rules').verdict, 'supported');
  });
});

describe('checkDecision', () => {
  test('matches decision text and returns newest first', () => {
    const r = checkDecision(index, 'sprocket');
    assert.equal(r.matches.length, 3);
    assert.deepEqual(r.matches.map((m) => m.date), ['2026-01-15', '2026-01-14', '2026-01-10']);
  });

  test('every match cites a source and line', () => {
    for (const m of checkDecision(index, 'sprocket').matches) {
      assert.match(m.source, /\.md$/);
      assert.ok(Number.isInteger(m.line));
    }
  });

  test('matching is case-insensitive', () => {
    assert.equal(checkDecision(index, 'SPROCKET').matches.length, 3);
  });

  test('matches on word boundaries, so a query is not found inside a longer word', () => {
    // Found against the real vault: a naive substring search for "Linear" matched
    // a decision about `scaleLinear`, which is a different subject entirely.
    const r = checkDecision(index, 'sprocket');
    assert.equal(r.matchMode, 'word');
    assert.equal(r.matches.length, 3);
    assert.ok(!r.matches.some((m) => m.text.includes('microSprocket')),
      'must not match "sprocket" inside "microSprocket"');
  });

  test('falls back to substring only when word matching finds nothing, and says so', () => {
    const r = checkDecision(index, 'procke');
    assert.equal(r.matchMode, 'substring');
    // 4, not 3: the fallback is deliberately looser and also picks up
    // "microSprocket". Reporting matchMode is what keeps that honest.
    assert.equal(r.matches.length, 4);
  });

  test('a query with regex metacharacters is matched literally, not as a pattern', () => {
    assert.doesNotThrow(() => checkDecision(index, 'cost (.*) held'));
    assert.equal(checkDecision(index, 'cost (.*) held').matches.length, 0);
  });

  test('no match is no vault evidence, never a veto basis', () => {
    const r = checkDecision(index, 'a topic nobody ever decided');
    assert.equal(r.verdict, 'no vault evidence');
    assert.equal(r.matches.length, 0);
    assert.equal(r.vetoBasis, false);
  });
});

describe('getNote', () => {
  test('returns the note with its outbound and inbound claims', () => {
    const r = getNote(index, 'widget');
    assert.equal(r.note, '10-Projects/widget');
    assert.ok(r.outbound.length >= 6);
    assert.ok(r.inbound.some((c) => c.subject === '20-Research/gadget-study'));
  });

  test('includes the decisions recorded in that note', () => {
    assert.equal(getNote(index, 'widget').decisions.length, 2);
  });

  test('an unknown name returns no match rather than throwing', () => {
    assert.equal(getNote(index, 'ghost-note').error !== undefined, true);
  });
});

describe('index round-tripped through JSON', () => {
  test('checks still work when the live resolver was lost to serialisation', () => {
    const { resolve: _dropped, ...serialised } = index;
    const revived = JSON.parse(JSON.stringify(serialised));
    assert.equal(checkClaim(revived, 'widget', 'governed_by', 'style-rules').verdict, 'supported');
    assert.equal(getNote(revived, 'widget').note, '10-Projects/widget');
  });
});
