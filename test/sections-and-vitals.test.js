// sections-and-vitals.test.js — what the board shows that it used to withhold.
//
// Two display rules, both pinned in one place (runs-view.js) because app.js
// alone could not keep them honest:
//
//   sections — rows group by PROJECT · BRANCH, always. Two repos sharing a
//   branch name do not merge into one section, a lone session on a branch
//   still gets its section, and '' (the session reported no branch) labels as
//   the project rather than keying a section named nothing.
//
//   offenders — the vitals strip names the app behind a hot GPU once the GPU
//   itself counts as busy (35, not the amber line of 80 that hid exactly the
//   readings prompting the question), and the CPU/memory offender says WHAT
//   the process is, not only its name and figure.
//
// This repository is public, so no test may read the real vault or name a real
// person, project or firm. Fixtures are widget / sprocket / laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionKeyOf, sectionLabelOf, gpuOffenderShown, gpuOffenderText, hotOffenderText,
  GPU_HOT_SHOW,
} from '../public/runs-view.js';

// ── the section key is project AND branch; the label names what is known ─────

test('the same branch in two projects does not merge into one section', () => {
  const w = { project: 'widget', branch: 'feature-x' };
  const s = { project: 'sprocket', branch: 'feature-x' };
  assert.notEqual(sectionKeyOf(w), sectionKeyOf(s));
  assert.equal(sectionLabelOf(w), 'widget · feature-x');
  assert.equal(sectionLabelOf(s), 'sprocket · feature-x');
});

test('two branches of one project list apart', () => {
  assert.notEqual(
    sectionKeyOf({ project: 'widget', branch: 'feature-x' }),
    sectionKeyOf({ project: 'widget', branch: 'main' }),
  );
});

test('an empty branch is a real reading: project key, project label', () => {
  assert.equal(sectionKeyOf({ project: 'widget', branch: '' }), 'widget\0');
  assert.equal(sectionLabelOf({ project: 'widget', branch: '' }), 'widget');
});

test('a run takes its branch from the linked session', () => {
  const r = { runId: 'widget-1', project: 'widget', session: { branch: 'feature-y' } };
  assert.equal(sectionKeyOf(r), 'widget\0feature-y');
  assert.equal(sectionLabelOf(r), 'widget · feature-y');
});

test('a row with neither project nor branch labels as nothing', () => {
  assert.equal(sectionKeyOf({}), '\0');
  assert.equal(sectionLabelOf({}), '—');
});

// ── the GPU offender shows once the GPU counts as busy ───────────────────────

test('the offender is named at the floor and above', () => {
  assert.equal(GPU_HOT_SHOW, 35);
  assert.equal(gpuOffenderShown({ gpu: 35, gpuHot: { name: 'game' } }), true);
  assert.equal(gpuOffenderShown({ gpu: 90, gpuHot: { name: 'game' } }), true);
});

test('one notch under the floor stays silent', () => {
  assert.equal(gpuOffenderShown({ gpu: 34, gpuHot: { name: 'game' } }), false);
});

test('no GPU reading stays silent even with an offender in hand', () => {
  assert.equal(gpuOffenderShown({ gpu: null, gpuHot: { name: 'game' } }), false);
});

test('no offender stays silent however busy the GPU', () => {
  assert.equal(gpuOffenderShown({ gpu: 90 }), false);
});

// ── the hot offender says what the process is ────────────────────────────────

test('a cpu offender names the process, the figure, and what it is', () => {
  const hot = { name: 'node', kind: 'cpu', cpuPct: 214, detail: 'node server.js' };
  assert.equal(hotOffenderText(hot), '▸ node  214% · node server.js');
});

test('no detail, no dangling separator', () => {
  assert.equal(hotOffenderText({ name: 'node', kind: 'cpu', cpuPct: 214, detail: '' }),
    '▸ node  214%');
  assert.equal(hotOffenderText({ name: 'node', kind: 'cpu', cpuPct: 214 }),
    '▸ node  214%');
});

test('a memory offender keeps the two-figure format', () => {
  const gib = 1024 ** 3;
  assert.equal(hotOffenderText({ name: 'renderer', kind: 'mem', rssBytes: 2.5 * gib }),
    '▸ renderer  2.5G');
  assert.equal(hotOffenderText({ name: 'renderer', kind: 'mem', rssBytes: 12 * gib }),
    '▸ renderer  12G');
  assert.equal(hotOffenderText(
    { name: 'renderer', kind: 'mem', rssBytes: 2.5 * gib, detail: 'tab 4242' }),
    '▸ renderer  2.5G · tab 4242');
});

test('no offender renders nothing', () => {
  assert.equal(hotOffenderText(null), '');
});

// ── the GPU offender reads like the CPU one ──────────────────────────────────

test('a gpu offender names the process, the figure, and what it is', () => {
  const gh = { name: 'game', gpuPct: 61, detail: 'game --render' };
  assert.equal(gpuOffenderText(gh), '▸ game  61% · game --render');
});

test('a gpu offender with no detail has no dangling separator', () => {
  assert.equal(gpuOffenderText({ name: 'game', gpuPct: 61, detail: '' }), '▸ game  61%');
  assert.equal(gpuOffenderText({ name: 'game', gpuPct: 61 }), '▸ game  61%');
});

test('no gpu offender renders nothing', () => {
  assert.equal(gpuOffenderText(null), '');
});
