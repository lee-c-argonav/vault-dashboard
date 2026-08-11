// encoding.test.js — the state encoding must be legible, and must be defined once.
//
// WHY THIS EXISTS. The encoding shipped unreadable and nothing noticed, because
// no test could see a colour. Measured on 2026-08-11 against --bg: the todo dot
// was 1.44:1 and therefore not rendered at all; running against blocked was
// 1.44:1, so the state most worth catching was the one that moved least; and the
// done and running labels were the same colour, so finished work read as loudly
// as live work.
//
// It also asserts the encoding is defined in ONE place. It previously lived in
// hud.css and again in a template literal inside status-page/build.js, and the
// two drifted. A regression there is invisible on the surface you are not looking
// at, which is the failure mode a test is actually needed for.
//
// Contrast is a MATRIX, not a number. The two palettes are deliberately different
// — build.js documents why — and the phone carries a real light theme. A token
// that clears the bar on the desktop can fail on a phone in daylight, so every
// token is checked on every surface and theme it can render in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const TOKENS = read('public/tokens.css');
const HUD = read('public/hud.css');
const BUILD = read('status-page/build.js');

/** WCAG relative luminance, then the standard contrast ratio. */
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `--name: #hex` declarations in a block of CSS text. */
function hexVars(text) {
  const out = {};
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*[;}]/gi)) {
    out[m[1]] = m[2];
  }
  return out;
}
/** `--name: var(--other)` declarations, which is what tokens.css is made of. */
function refVars(text) {
  const out = {};
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/gi)) {
    out[m[1]] = m[2];
  }
  return out;
}
/** The first `:root{...}` body after `from`, or the whole file when from is 0. */
function rootBlock(text, from = 0) {
  const i = text.indexOf(':root', from);
  if (i < 0) return '';
  const open = text.indexOf('{', i);
  const close = text.indexOf('}', open);
  return text.slice(open + 1, close);
}

const SEMANTIC = refVars(TOKENS);

// One palette per surface × theme. The desktop has a single dark theme; the
// phone has dark and light, and its light accents are darkened rather than
// inverted, so they must be checked independently.
const PALETTES = {
  'desktop dark': hexVars(rootBlock(HUD)),
  'phone dark': hexVars(rootBlock(BUILD, BUILD.indexOf('const CSS'))),
  'phone light': hexVars(
    rootBlock(BUILD, BUILD.indexOf('prefers-color-scheme: light')),
  ),
};

/** Resolve a semantic token through one palette. */
function resolve(token, palette) {
  const base = SEMANTIC[token];
  assert.ok(base, `tokens.css does not define ${token}`);
  const hex = palette[base];
  assert.ok(hex, `palette has no ${base} for ${token}`);
  return hex;
}

const MARKS = ['--st-todo', '--st-running', '--st-done', '--st-blocked', '--st-failed'];
const LABELS = ['--lab-todo', '--lab-running', '--lab-done', '--lab-blocked', '--lab-failed'];

test('every palette parsed and carries a background', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    assert.ok(palette['--bg'], `${name}: no --bg found, the parser missed the block`);
    assert.ok(Object.keys(palette).length >= 8, `${name}: only ${Object.keys(palette).length} tokens`);
  }
});

/** What a mark or label actually sits on. Marks render inside .run, which is
 *  --panel, or --panel-2 on a needs-input row. Measuring against --bg overstates
 *  every ratio by about 0.4 and would pass a palette that fails on screen. */
const ground = (p) => p['--panel-2'] ?? p['--panel'] ?? p['--bg'];

// 3:1 is the floor for a non-text mark. The todo dot measured 1.44:1 before this
// change, which is why two units on a live board had no visible mark at all.
test('every state mark clears 3:1 against the surface it renders on', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    for (const token of MARKS) {
      const ratio = contrast(resolve(token, palette), ground(palette));
      assert.ok(ratio >= 3, `${name} ${token}: ${ratio.toFixed(2)}:1, below the 3:1 floor`);
    }
  }
});

// The repo's own documented floor for the quietest text is 3.63:1 on --panel-2.
// Labels sit on the panel, so they are measured there.
test('every state label clears 3.5:1 against the panel, on every surface', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    for (const token of LABELS) {
      const ratio = contrast(resolve(token, palette), ground(palette));
      assert.ok(ratio >= 3.5, `${name} ${token}: ${ratio.toFixed(2)}:1, below 3.5:1`);
    }
  }
});

// The defect this replaced: done and running labels were both --bone, so the
// finished unit was exactly as loud as the one actually running.
test('running and done labels are not the same colour', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    const running = resolve('--lab-running', palette);
    const done = resolve('--lab-done', palette);
    assert.notEqual(running.toLowerCase(), done.toLowerCase(),
      `${name}: running and done labels are both ${running}`);
    const ratio = contrast(running, done);
    assert.ok(ratio >= 2, `${name}: running vs done label is only ${ratio.toFixed(2)}:1`);
  }
});

// Running against blocked is 1.44:1 on the desktop palette and cannot be carried
// by colour at any size. Shape carries it instead, so the shape must be present.
test('blocked is distinguished by shape, because colour cannot carry it', () => {
  const blocked = TOKENS.match(/\.run-u\.is-blocked[^{]*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(blocked, /clip-path/, 'the blocked mark has no clip-path');
  const running = TOKENS.match(/\.run-u\.is-running[^{]*\{[^}]*\}/s)?.[0] ?? '';
  assert.doesNotMatch(running, /clip-path/, 'the running mark must stay a square');

  // And the reason, asserted rather than trusted: if these two ever clear 3:1
  // against each other, the shape rule can be revisited.
  const p = PALETTES['desktop dark'];
  const ratio = contrast(resolve('--st-running', p), resolve('--st-blocked', p));
  assert.ok(ratio < 3, `running vs blocked is now ${ratio.toFixed(2)}:1; revisit the shape rule`);
});

/**
 * The CSS that the phone actually ships, isolated from the JS around it and from
 * TOKENS_FALLBACK. The fallback is allowed to carry state colours — that is its
 * whole job — so a scan that included it would report the thing it is for.
 */
function phoneCss() {
  const start = BUILD.indexOf('const CSS = `');
  assert.ok(start > 0, 'could not find the phone CSS template');
  const from = BUILD.indexOf('`', start + 12) + 1;
  const end = BUILD.indexOf('`;', from);
  assert.ok(end > from, 'could not find the end of the phone CSS template');
  return BUILD.slice(from, end);
}

/**
 * Any rule that colours a state on a mark, a label or a duration.
 *
 * The first version of this test hand-listed selectors and covered one of the
 * five cases it named: the alternation was `(run-u|u)`, so the entire sub-agent
 * half was unreachable, and it asserted `background` while never asserting
 * `color`. Reinstating `.run-a.is-done .run-a-dot{background}` in hud.css left
 * the suite green. Scanning every rule instead of naming selectors removes the
 * chance to omit one.
 */
const STATE_SEL = /\.(is-)?(todo|running|done|blocked|failed)\b/;
const TARGET_SEL = /\.(run-u-dot|run-a-dot|run-u-label|run-a-label|dot|ul|al|dur)\b/;
function stateColourRules(css) {
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim();
    if (!STATE_SEL.test(sel) || !TARGET_SEL.test(sel)) continue;
    if (/(^|[;{]|\s)(background|color)\s*:/.test(m[2])) {
      bad.push(sel.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  return bad;
}

test('per-state mark, label and duration colours live only in tokens.css', () => {
  for (const [name, css] of [['hud.css', HUD], ['build.js CSS', phoneCss()]]) {
    const bad = stateColourRules(css);
    assert.deepEqual(bad, [], `${name} still colours a state:\n  ${bad.join('\n  ')}`);
  }
});

// And the scan must be capable of seeing one, or the assertion above is a
// tautology dressed as a guard.
test('the single-source scan detects a state colour when one is present', () => {
  const planted = '.run-a.is-done .run-a-dot { background: #FF0000; }';
  assert.deepEqual(stateColourRules(planted), ['.run-a.is-done .run-a-dot']);
  const label = '.u.blocked .ul{color:#FF0000}';
  assert.equal(stateColourRules(label).length, 1);
});

// Drift guard. One rule must govern both renderers, so both class vocabularies
// have to appear in the shared file.
test('tokens.css addresses both renderers', () => {
  // Session selectors included. The list held six unit and sub-agent selectors
  // and no session one, which is exactly why it passed while tokens.css styled
  // `.sess-dot` and the phone emitted `.dot` — every phone session mark stayed at
  // --dimmer, 1.9:1, and a stalled session looked identical to an idle one.
  for (const sel of ['.run-u-dot', '.u .dot', '.run-a-dot', '.a .dot', '.run-u-label', '.u .ul',
    '.sess-dot', '.sess .dot', '.sess-tag', '.stag']) {
    assert.ok(TOKENS.includes(sel), `tokens.css never mentions ${sel}`);
  }
});

// Todo and done labels are the same grey on the desktop palette, so the mark is
// the ONLY thing separating "not started" from "finished". That makes the shape
// load-bearing rather than decorative, and it has to be asserted.
test('todo is hollow and done is filled, because their labels cannot differ', () => {
  const todo = TOKENS.match(/\.run-u-dot,\s*\.u \.dot\s*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(todo, /background:\s*transparent/, 'the todo mark is not hollow');
  assert.match(todo, /box-shadow:\s*inset/, 'the todo mark has no ring to be seen by');

  const done = TOKENS.match(/\.run-u\.is-done \.run-u-dot,[^{]*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(done, /background:\s*var\(--st-done\)/, 'the done mark is not filled');
  assert.match(done, /box-shadow:\s*none/, 'the done mark kept the hollow ring');
});

// The old value, kept as a named regression: it is what 1.44:1 looked like.
test('the unreadable todo mark is gone from both surfaces', () => {
  const todo = resolve('--st-todo', PALETTES['desktop dark']);
  assert.notEqual(todo.toUpperCase(), '#2A2D33', 'todo mark is back to the 1.44:1 value');
});

// The phone's whole stylesheet is a JS template literal, so a backtick anywhere
// inside it — including in a CSS comment — ends the literal mid-file and the
// module stops parsing. It cost two build failures in one sitting, both times
// from writing `display:flex` in a comment out of ordinary code-comment habit.
// The syntax error names a line far from the cause, which is what makes it
// expensive rather than merely annoying.
test('the phone stylesheet contains no backticks', () => {
  const start = BUILD.indexOf('const CSS = `');
  assert.ok(start > 0, 'could not find the phone CSS template');
  const from = BUILD.indexOf('`', start + 12) + 1;
  const end = BUILD.indexOf('`;', from);
  const css = BUILD.slice(from, end);
  assert.ok(!css.includes('`'),
    'a backtick inside the CSS template literal ends it early; quote CSS in comments plainly');
});
