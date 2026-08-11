// untested-half.test.js — the modules no test had ever imported.
//
// WHY THIS EXISTS. A full-codebase audit measured it: roughly half the non-test
// JavaScript in this repo was imported by no test at all — server.js, publish.js,
// shortcuts.js, run-terminal.js, and public/app.js. Every defect that audit found
// lived in that half, and both times the render path broke on this branch all
// tests stayed green.
//
// The pattern in those defects is worth naming, because it decides what is worth
// testing here: in each case the tested FUNCTION was correct and its UNTESTED
// CALLER misused it. `boardDigest` handled the clock correctly and publish.js
// called it without one. `runState` guarded nothing because five of its six call
// sites were in an untested file. So these tests aim at seams — what one module
// hands another — rather than at re-testing pure logic that already has cover.
//
// What is deliberately NOT attempted: booting the daemon, driving osascript, or
// rendering the DOM. Those need a machine, a display and a browser, and a test
// that needs all three is a test that gets skipped. What is left is still the
// part that has bitten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── run-terminal.js — the one place browser input reaches a shell-adjacent API ──

test('a terminal cannot be focused from a malformed id', async () => {
  const { focusSessionTerminal, SESSION_PREFIX } = await import('../run-terminal.js');
  // Every one of these must be refused before anything touches the process
  // table, let alone osascript.
  for (const bad of ['', 'abc', '-1', '0', '1.5', 'NaN', '../../etc', '1; rm -rf /']) {
    const r = await focusSessionTerminal(`${SESSION_PREFIX}${bad}`);
    assert.equal(r.ok, false, `accepted pid ${JSON.stringify(bad)}`);
    assert.equal(r.status, 400, `wrong status for ${JSON.stringify(bad)}`);
  }
});

test('an unknown pid is a 404, not a crash and not a shell call', async () => {
  const { focusSessionTerminal, SESSION_PREFIX } = await import('../run-terminal.js');
  // 999999 is above the default macOS pid ceiling, so it cannot collide with a
  // real session on the machine running this test.
  const r = await focusSessionTerminal(`${SESSION_PREFIX}999999`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('a run id that names no file is refused', async () => {
  const { focusRunTerminal, RUN_PREFIX } = await import('../run-terminal.js');
  const r = await focusRunTerminal(`${RUN_PREFIX}`, '/nonexistent-vault');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('the tty pattern admits only a device path', () => {
  // Asserted against the source, because focusTty is private by design — the
  // module's header says the check cannot be skipped by adding a second entry
  // point, and that property is worth pinning even though the function is not
  // exported.
  const src = read('run-terminal.js');
  const m = src.match(/const TTY_RE = (\/.*\/);/);
  assert.ok(m, 'TTY_RE is gone or renamed — this test needs updating with it');
  const re = new RegExp(m[1].slice(1, -1));
  for (const good of ['/dev/ttys000', '/dev/ttys012', '/dev/tty0']) {
    assert.ok(re.test(good), `rejected a real tty: ${good}`);
  }
  for (const bad of [
    '/dev/ttys000; rm -rf /', '/dev/../etc/passwd', 'ttys000', '/dev/ttys000 ',
    '/etc/passwd', '', '/dev/tty$(whoami)', '/dev/ttys000\n/dev/ttys001',
  ]) {
    assert.ok(!re.test(bad), `admitted a non-tty: ${JSON.stringify(bad)}`);
  }
});

// ── shortcuts.js — ids from the browser, commands from a local file ──

test('an unknown shortcut id runs nothing', async () => {
  const { runShortcut } = await import('../shortcuts.js');
  for (const bad of ['', 'nope', '../../bin/sh', 'open -a Calculator']) {
    const r = await runShortcut(bad);
    assert.equal(r?.ok, false, `ran an unknown id: ${JSON.stringify(bad)}`);
  }
});

test('the browser is never handed a command, only an id and a label', async () => {
  const { loadShortcuts, publicShortcuts } = await import('../shortcuts.js');
  await loadShortcuts();
  for (const s of publicShortcuts()) {
    // This is the whole threat model of the action endpoint: the catalogue is a
    // hand-authored local file, the browser sends an id, and nothing that looks
    // like a command crosses the wire.
    for (const key of ['cmd', 'command', 'args', 'exec', 'url', 'match']) {
      assert.equal(s[key], undefined, `publicShortcuts leaked ${key}`);
    }
  }
});

// ── publish.js — the caller that shipped a real defect ──

test('the publisher reports its own state without having run', async () => {
  const { publishStatus, MIN_DEPLOY_INTERVAL_MS, PUBLISH_MS } = await import('../publish.js');
  const s = publishStatus();
  assert.equal(s.enabled, false, 'the publisher claims to be on in a test process');
  assert.equal(typeof s.deploys, 'number');
  // The rate limiter must bound deploys independently of the tick, or a fast
  // tick becomes a fast deploy rate. Both numbers are load-bearing.
  assert.ok(MIN_DEPLOY_INTERVAL_MS >= PUBLISH_MS,
    'the minimum deploy interval is shorter than the tick, so it bounds nothing');
});

// ── server.js — the filter that decides whether the board updates at all ──

test('the two watcher predicates disagree, which is why there are two', () => {
  // `relevant` rejects every transcript path: '.jsonl' does not end in '.json',
  // and the first loop rejects any segment starting with a dot, which `.claude`
  // is. A single shared predicate silently dropped every transcript event, and
  // the fix was a second predicate rather than widening the first.
  const src = read('server.js');
  assert.match(src, /function relevantTranscript\(/,
    'the transcript watcher lost its own predicate; it cannot share the vault one');
  const vault = src.match(/function relevant\(filename\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(vault.includes(".endsWith('.md')"), 'the vault filter stopped accepting notes');
  assert.ok(!vault.includes('.jsonl'),
    'the vault filter now accepts transcripts, which would route them through the full parse');
});

test('the safety refresh does not route through the debounce it backstops', () => {
  // It did, and `scheduleRefresh` clears and re-arms its timer, so a sustained
  // sub-debounce event stream postponed the floor along with everything else. A
  // floor that can be postponed is not a floor.
  const src = read('server.js');
  const m = src.match(/const safetyRefresh = setInterval\(([\s\S]*?)\);/);
  assert.ok(m, 'the safety refresh is gone or renamed');
  assert.ok(!/scheduleRefresh/.test(m[1]),
    'the safety refresh calls scheduleRefresh again, so it can be postponed indefinitely');
});

test('every full parse is guarded against overlapping itself', () => {
  // Three paths call refresh() directly — the safety interval, the debounced
  // watcher and the midnight rollover — and two parses completing out of order
  // publish the OLDER state last, which then stands until the next interval.
  // The GUARD CLAUSE, not merely the identifier: deleting the early return
  // leaves the flag's assignments behind, so a test that greps the name passes
  // against a refresh that no longer guards anything. Verified by deleting the
  // clause and watching this fail.
  const src = read('server.js');
  assert.match(src, /if \(refreshInFlight\)\s*return/,
    'refresh() lost its overlap guard clause; two parses can publish out of order');
  assert.match(src, /refreshInFlight = false;/,
    'the guard is never released, so one parse would block every later one');
});
