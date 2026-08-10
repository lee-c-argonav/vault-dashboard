// sources.test.js — the source files are text.
//
// Written after a single NUL byte landed inside a template literal in
// runs-view.js during an automated edit. Nothing failed: the file was still
// valid JavaScript, `node --check` passed, and all 141 tests went green. What
// broke was every tool that classifies a file before reading it — `file` began
// reporting "data", and grep silently returned nothing for every pattern,
// including the names of functions plainly present. Half an hour of diagnosis
// went into "why has this function disappeared" when it never had.
//
// A defect that makes the code invisible to search while behaving correctly is
// worth one cheap assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', '.playwright-mcp', 'public']);
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.css', '.html', '.sh', '.plist']);

async function sourceFiles(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await sourceFiles(full, out);
    else if (TEXT.has(extname(e.name))) out.push(full);
  }
  return out;
}

// public/ is walked separately because it is in SKIP for the recursion above
// only to avoid the icon binaries; its text files still matter.
async function publicText() {
  const dir = join(REPO, 'public');
  const names = await readdir(dir);
  return names.filter((n) => TEXT.has(extname(n))).map((n) => join(dir, n));
}

test('no source file contains a NUL byte', async () => {
  const files = [...await sourceFiles(REPO), ...await publicText()];
  assert.ok(files.length > 10, 'the walk must actually be finding files');
  const offenders = [];
  for (const f of files) {
    const raw = await readFile(f);
    const at = raw.indexOf(0);
    if (at !== -1) {
      offenders.push(`${f.replace(REPO, '')} at byte ${at}: ` +
        JSON.stringify(raw.subarray(Math.max(0, at - 40), at + 10).toString('utf8')));
    }
  }
  assert.deepEqual(offenders, [],
    'a NUL makes the file "binary" to grep and every other line-based tool, ' +
    'while still parsing and still passing every other test');
});

test('every source file decodes as UTF-8', async () => {
  const files = [...await sourceFiles(REPO), ...await publicText()];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const offenders = [];
  for (const f of files) {
    try {
      decoder.decode(await readFile(f));
    } catch (err) {
      offenders.push(`${f.replace(REPO, '')}: ${err.message}`);
    }
  }
  assert.deepEqual(offenders, []);
});
