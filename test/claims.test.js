// claims.test.js — the claim extractor: predicates, provenance, and what it must ignore.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaims } from '../claims.js';
import { makeVault, cleanup } from './fixture.js';

let root;
let index;

before(async () => {
  root = await makeVault();
  index = await buildClaims(root);
});
after(() => cleanup(root));

/** Claims out of one subject, optionally filtered by object. */
const from = (subject, object) =>
  index.claims.filter((c) => c.subject === subject && (object === undefined || c.object === object));

describe('predicate mapping', () => {
  test('preamble prose with no enclosing section falls back to related_to', () => {
    const [c] = from('10-Projects/widget', '20-Research/gadget-study').filter((x) => x.line === 3);
    assert.equal(c.predicate, 'related_to');
    assert.equal(c.section, null);
  });

  test('## What it is → describes, flagged human-asserted', () => {
    const [c] = from('10-Projects/widget', '20-Research/sprocket');
    assert.equal(c.predicate, 'describes');
    assert.equal(c.human, true);
  });

  test('## Todos → todo_on', () => {
    const [c] = from('10-Projects/widget').filter((x) => x.line === 10);
    assert.equal(c.predicate, 'todo_on');
    assert.equal(c.human, false);
  });

  test('## Recent decisions → decided_about, carrying the decision date', () => {
    const [c] = from('10-Projects/widget').filter((x) => x.line === 13);
    assert.equal(c.predicate, 'decided_about');
    assert.equal(c.validFrom, '2026-01-10');
  });

  test('## Key docs & references → references', () => {
    const [c] = from('10-Projects/widget').filter((x) => x.line === 17);
    assert.equal(c.predicate, 'references');
  });

  test('## Related patterns and standards → governed_by, flagged human-asserted', () => {
    const [c] = from('10-Projects/widget', '60-Standards/style-rules');
    assert.equal(c.predicate, 'governed_by');
    assert.equal(c.human, true);
  });

  test('## Worked on in a daily note → worked_on, carrying the note date', () => {
    const [c] = from('40-Daily/2026-01-15').filter((x) => x.line === 4);
    assert.equal(c.predicate, 'worked_on');
    assert.equal(c.validFrom, '2026-01-15');
  });

  test('an unmapped section falls back to related_to and is reported', () => {
    const [c] = from('10-Projects/widget').filter((x) => x.line === 24);
    assert.equal(c.predicate, 'related_to');
    assert.equal(c.section, 'Worth noticing');
    assert.ok(index.unmapped.find((u) => u.section === 'Worth noticing' && u.count === 1),
      `expected "Worth noticing" in unmapped, got ${JSON.stringify(index.unmapped)}`);
  });
});

describe('provenance', () => {
  test('every claim carries a source path and a line number', () => {
    assert.ok(index.claims.length > 0);
    for (const c of index.claims) {
      assert.match(c.source, /\.md$/, `bad source on ${JSON.stringify(c)}`);
      assert.ok(Number.isInteger(c.line) && c.line >= 1, `bad line on ${JSON.stringify(c)}`);
    }
  });

  test('line numbers match the file on disk', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    for (const c of index.claims) {
      const lines = (await readFile(path.join(root, c.source), 'utf8')).split('\n');
      assert.ok(lines[c.line - 1].includes('[['),
        `${c.source}:${c.line} does not hold a wikilink: ${JSON.stringify(lines[c.line - 1])}`);
    }
  });

  test('a claim is never its own subject', () => {
    for (const c of index.claims) assert.notEqual(c.object, c.subject);
  });
});

describe('unresolved and ignored links', () => {
  test('a broken link keeps its raw target in objectText rather than being dropped', () => {
    const broken = index.claims.filter((c) => c.object === null);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].objectText, 'note-that-does-not-exist');
    assert.equal(broken[0].subject, '20-Research/gadget-study');
  });

  test('a resolved claim carries no objectText', () => {
    for (const c of index.claims) {
      if (c.object !== null) assert.equal(c.objectText, null);
    }
  });

  test('a wikilink inside a fenced code block is ignored', () => {
    assert.equal(from('20-Research/gadget-study', '20-Research/sprocket').length, 0);
  });

  test('a wikilink inside inline backticks is ignored', () => {
    const line9 = index.claims.filter((c) => c.source === '20-Research/gadget-study.md' && c.line === 9);
    assert.equal(line9.length, 0);
  });

  test('99-Archive is out of scope, so its links never become claims', () => {
    assert.equal(index.claims.filter((c) => c.source.startsWith('99-Archive')).length, 0);
  });
});

describe('decisions', () => {
  test('every dated decision line is captured, uncapped and as raw text', () => {
    assert.equal(index.decisions.length, 4);
    assert.ok(index.decisions.every((d) => !d.text.includes('<a ')), 'text must be raw, not HTML');
  });

  test('decisions carry a date, source and line', () => {
    const d = index.decisions.find((x) => x.date === '2026-01-10');
    assert.equal(d.source, '10-Projects/widget.md');
    assert.equal(d.line, 13);
    assert.match(d.text, /Chose/);
  });

  test('decisions are sorted newest first', () => {
    const dates = index.decisions.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });
});
