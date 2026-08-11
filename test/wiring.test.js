// wiring.test.js — a symbol used in a render path must be imported.
//
// WHY THIS EXISTS. Nothing in this suite loads public/app.js: it needs a DOM and
// this repo has no dependencies, so a browser is the only thing that has ever
// executed it. That gap let the same defect ship twice in one day — a bare
// identifier in a render path, `ReferenceError` on first paint, the whole window
// dead with a BOOT footer, and 259 tests passing throughout. Both times it was
// found by opening the page.
//
// This does not execute app.js. It reads it, and asserts the two halves of the
// seam that broke: every name imported from runs-view.js is actually exported by
// it, and every name runs-view.js exports that app.js USES is actually imported.
// The second half is the one that catches the real bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const APP = read('public/app.js');
const VIEW = read('public/runs-view.js');

/** Everything runs-view.js exports by name. */
function exportedNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export const (\w+)/gm)) out.add(m[1]);
  return out;
}

/** The names app.js pulls out of runs-view.js. */
function importedFromView(src) {
  const m = src.match(/import\s*\{([\s\S]*?)\}\s*\n?\s*from\s*'\.\/runs-view\.js'/);
  assert.ok(m, 'app.js no longer imports from runs-view.js — update this test');
  return new Set(m[1].split(',').map((x) => x.trim()).filter(Boolean));
}

const EXPORTS = exportedNames(VIEW);
const IMPORTS = importedFromView(APP);

test('runs-view.js exports every name app.js imports from it', () => {
  const missing = [...IMPORTS].filter((n) => !EXPORTS.has(n));
  assert.deepEqual(missing, [],
    `app.js imports names runs-view.js does not export: ${missing.join(', ')}`);
});

test('app.js imports every runs-view symbol it uses', () => {
  // The body, minus the import statement itself.
  const body = APP.replace(/import[\s\S]*?from\s*'\.\/runs-view\.js';/, '');
  const used = [...EXPORTS].filter((name) => {
    if (IMPORTS.has(name)) return false;
    // A call, or a bare reference that is not a property access or a definition.
    return new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(body)
      || new RegExp(`(?<![.\\w])${name}(?![\\w:])`).test(body);
  });
  assert.deepEqual(used, [],
    `app.js uses these without importing them, which is a ReferenceError on first `
    + `paint and takes the whole window down: ${used.join(', ')}`);
});
