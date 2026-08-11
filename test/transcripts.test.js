// transcripts.test.js — the join must refuse to guess, and nothing may throw.
//
// This module sits on the vault parse path and reads roughly 60 files it does
// not own, written by another program whose format is not a public contract and
// which differed between two sessions alive at the same moment on this machine.
// So the tests that matter are the degradation ones: what happens when a file is
// missing, unreadable, a directory, truncated, or 1MB on one line. Every one of
// those must cost one row and never the board.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTranscripts, resetTranscripts, SUBAGENT_CAP, AGENT_STALE_MS, SESSION_STALE_MS,
  AGENT_RECENT_MS,
} from '../transcripts.js';

const ROOT = mkdtempSync(join(tmpdir(), 'vh-transcripts-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const PID_DIR = join(ROOT, 'sessions');
const PROJ_DIR = join(ROOT, 'projects');
process.env.VAULT_HUD_CLAUDE_HOME = ROOT;

// A cwd outside $HOME, so describeCwd yields where:'' and project:<leaf> on both
// sides of the cross-check. Mirrors what sessions.js produces for such a path.
const CWD = join(ROOT, 'work', 'proj');
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// Anchored to the real clock, not a fixed date. Fixture files carry real mtimes,
// and staleness is `now - mtime`; a fixed START in the past made every fixture
// look like it was written in the future and every staleness case pass wrongly.
// Floored to the second because procStart is written without milliseconds.
const START = Math.floor(Date.now() / 1000) * 1000;

/** A session as sessions.js would report it. */
function session(over = {}) {
  return {
    pid: 4242,
    tty: '/dev/ttys009',
    since: new Date(START).toISOString(),
    project: 'proj',
    where: '',
    ...over,
  };
}

/** procStart as the agent writes it: UTC, in ctime shape. */
function procStart(ms = START) {
  return new Date(ms).toUTCString().replace('GMT', '').trim();
}

function writePid(over = {}) {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(join(PID_DIR, '4242.json'), JSON.stringify({
    pid: 4242,
    sessionId: SID,
    cwd: CWD,
    procStart: procStart(),
    name: 'proj-aa',
    status: 'busy',
    statusUpdatedAt: START,
    ...over,
  }));
}

const entry = (o) => `${JSON.stringify(o)}\n`;
const assistant = (content, extra = {}) => entry({
  type: 'assistant', timestamp: '2026-08-11T10:01:00Z', cwd: CWD, gitBranch: 'main',
  message: { role: 'assistant', content }, ...extra,
});

function writeTranscript(body) {
  mkdirSync(join(PROJ_DIR, SLUG), { recursive: true });
  writeFileSync(join(PROJ_DIR, SLUG, `${SID}.jsonl`), body);
}

function writeAgent(id, { meta = {}, body = null } = {}) {
  const dir = join(PROJ_DIR, SLUG, SID, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({
    agentType: 'general-purpose', description: `task ${id}`, spawnDepth: 1, ...meta,
  }));
  writeFileSync(join(dir, `agent-${id}.jsonl`),
    body ?? entry({ type: 'user', timestamp: '2026-08-11T10:00:30Z', message: { role: 'user', content: 'x' } })
      + assistant([{ type: 'text', text: 'done' }]));
}

let now = START + 1_000;
beforeEach(() => {
  rmSync(PID_DIR, { recursive: true, force: true });
  rmSync(PROJ_DIR, { recursive: true, force: true });
  resetTranscripts();
  now += 10_000;              // defeat the sweep cache between cases
});

const read = (s = session()) => readTranscripts([s], { now });

// ---- the join -------------------------------------------------------------

test('joins a session to its transcript through the pid file', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'tool_use', id: 't1', name: 'Edit' }])
    + entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } }));
  const d = (await read()).get(4242);
  assert.ok(d, 'no join');
  assert.equal(d.name, 'proj-aa');
  assert.equal(d.branch, 'main');
  assert.equal(d.lastTool, 'Edit');
  assert.equal(d.status, 'running');
});

test('refuses the join when the pid file names a different cwd', async () => {
  writePid({ cwd: join(ROOT, 'work', 'other') });
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  assert.equal((await read()).get(4242), undefined);
});

test('refuses the join when procStart disagrees with the process start', async () => {
  // Four hours out is exactly the failure a naive local-time parse produces.
  writePid({ procStart: procStart(START + 4 * 3600_000) });
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  assert.equal((await read()).get(4242), undefined);
});

test('parses procStart as UTC, not local time', async () => {
  writePid();                       // procStart is UTC; session.since is the same instant
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  assert.ok((await read()).get(4242), 'a correct UTC stamp was rejected');
});

test('no pid file means no detail, not a guess', async () => {
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  assert.equal((await read()).get(4242), undefined);
});

test('a transcript claiming a different cwd is not this session\'s', async () => {
  writePid();
  writeTranscript(entry({
    type: 'assistant', cwd: '/somewhere/else', timestamp: '2026-08-11T10:01:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
  }));
  assert.equal((await read()).get(4242), undefined);
});

test('an entry recorded in a subdirectory does not break the join', async () => {
  // A tool that ran in a folder beneath the session writes that folder as its
  // cwd. Rejecting on the first claim threw away a live session whose window
  // held 11 entries at its own cwd and 3 in a subfolder.
  writePid();
  writeTranscript(entry({
    type: 'assistant', cwd: join(CWD, 'sub', 'deeper'), timestamp: '2026-08-11T10:00:50Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
  }) + assistant([{ type: 'tool_use', id: 'k', name: 'Grep' }]));
  const d = (await read()).get(4242);
  assert.ok(d, 'a subdirectory entry rejected the session');
  assert.equal(d.lastTool, 'Grep');
});

test('two live pids in one cwd each resolve to their own transcript', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'first' }]));
  const other = 'ffffffff-1111-2222-3333-444444444444';
  writeFileSync(join(PID_DIR, '4243.json'), JSON.stringify({
    pid: 4243, sessionId: other, cwd: CWD, procStart: procStart(),
    name: 'proj-bb', status: 'idle', statusUpdatedAt: START,
  }));
  writeFileSync(join(PROJ_DIR, SLUG, `${other}.jsonl`), assistant([{ type: 'tool_use', id: 'z', name: 'Bash' }]));

  const map = await readTranscripts([session(), session({ pid: 4243 })], { now });
  assert.equal(map.get(4242).name, 'proj-aa');
  assert.equal(map.get(4243).name, 'proj-bb');
  assert.equal(map.get(4243).status, 'idle');
});

// ---- session status -------------------------------------------------------

test('busy with a silent transcript is stalled, not working', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  // From the real clock, because the transcript's mtime is a real mtime.
  const later = Date.now() + SESSION_STALE_MS + 60_000;
  resetTranscripts();
  const d = (await readTranscripts([session()], { now: later })).get(4242);
  assert.equal(d.status, 'stalled');
});

test('idle is reported from the process, not inferred', async () => {
  writePid({ status: 'idle' });
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  assert.equal((await read()).get(4242).status, 'idle');
});

test('a detached HEAD and an absent branch both render nothing', async () => {
  writePid();
  writeTranscript(entry({
    type: 'assistant', cwd: CWD, gitBranch: 'HEAD', timestamp: '2026-08-11T10:01:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
  }));
  assert.equal((await read()).get(4242).branch, '');
});

// ---- sub-agents -----------------------------------------------------------

test('sub-agent labels come from the sidecar, never from a prompt', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  // A prompt shaped like the real ones: absolute path in the first characters.
  writeAgent('a1', {
    meta: { description: 'Fix the reader states' },
    body: entry({
      type: 'user', timestamp: '2026-08-11T10:00:30Z',
      message: { role: 'user', content: `Repo ${CWD}, branch main. You OWN ONE FILE...` },
    }) + assistant([{ type: 'text', text: 'done' }]),
  });
  const d = (await read()).get(4242);
  assert.equal(d.agents.length, 1);
  assert.equal(d.agents[0].label, 'Fix the reader states');
  assert.doesNotMatch(JSON.stringify(d), /You OWN ONE FILE/, 'prompt text reached the result');
});

test('returned is decided by the absence of a tool_use, not by stop_reason', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  // 7 of 27 real finished sub-agents carry a null stop_reason. The old rule
  // called those open forever.
  writeAgent('nullstop', {
    body: assistant([{ type: 'text', text: 'Report follows' }], { message: { role: 'assistant', content: [{ type: 'text', text: 'Report follows' }], stop_reason: null } }),
  });
  writeAgent('open', { body: assistant([{ type: 'tool_use', id: 'q', name: 'Bash' }]) });

  const d = (await read()).get(4242);
  const by = Object.fromEntries(d.agents.map((a) => [a.label.split(' ').pop(), a.state]));
  assert.equal(by.nullstop, 'done', 'a finished agent with a null stop_reason read as open');
  assert.notEqual(by.open, 'done');
});

// The severe one. An assistant turn is split across entries — thinking, then
// text, then the tool call — and only the last carries a stop_reason, so a
// mid-turn entry is byte-identical to a finished one. The rule that read "no
// tool_use means done" called 2,598 of 4,104 mid-flight boundaries in 35 real
// transcripts done: 63% of boundaries, 90% of wall-clock time. A board saying
// "8 AGENTS DONE" while eight are working is this module's own defect, inverted.
test('a mid-turn sub-agent is not reported as finished', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));

  // The four shapes a live agent actually presents between tool calls.
  writeAgent('r1', { body: assistant([{ type: 'thinking', thinking: 'considering' }]) });
  writeAgent('r2', { body: assistant([{ type: 'text', text: 'Here is what I found' }]) });
  writeAgent('r3', {
    body: entry({
      type: 'user', timestamp: '2026-08-11T10:00:40Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q' }] },
    }),
  });
  writeAgent('r4', { body: assistant([{ type: 'tool_use', id: 'q', name: 'Bash' }]) });

  // Real clock: the fixtures carry real mtimes and recency is what decides an
  // ambiguous tail. The shared `now` drifts ten seconds per test, which would put
  // these files past AGENT_RECENT_MS through the harness rather than the rule.
  resetTranscripts();
  const d = (await readTranscripts([session()], { now: Date.now() })).get(4242);
  const by = Object.fromEntries(d.agents.map((a) => [a.label.split(' ').pop(), a.state]));
  for (const id of ['r1', 'r2', 'r3', 'r4']) {
    assert.notEqual(by[id], 'done', `a mid-turn ${id} entry reported the agent finished`);
  }
});

test('a sub-agent that stopped writing long ago is finished', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  writeAgent('old', { body: assistant([{ type: 'text', text: 'Done. Report follows.' }]) });
  const later = Date.now() + AGENT_RECENT_MS + 60_000;
  resetTranscripts();
  const d = (await readTranscripts([session()], { now: later })).get(4242);
  assert.equal(d.agents[0].state, 'done');
});

test('an open sub-agent that stopped writing is stalled', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  writeAgent('hung', { body: assistant([{ type: 'tool_use', id: 'q', name: 'Bash' }]) });
  const later = Date.now() + AGENT_STALE_MS + 60_000;
  resetTranscripts();
  const d = (await readTranscripts([session()], { now: later })).get(4242);
  assert.equal(d.agents[0].state, 'stalled');
});

test('nested sub-agents keep their depth and parent', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  writeAgent('child', { meta: { spawnDepth: 2, parentAgentId: 'abcdef1234567890' } });
  const a = (await read()).get(4242).agents[0];
  assert.equal(a.depth, 2);
  assert.equal(a.parent, 'abcdef12');
});

test('the sub-agent cap reports the excess rather than hiding it', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  for (let i = 0; i < SUBAGENT_CAP + 5; i++) writeAgent(`x${String(i).padStart(3, '0')}`);
  const d = (await read()).get(4242);
  assert.equal(d.agents.length, SUBAGENT_CAP);
  assert.equal(d.agentsCapped, 5);
});

// ---- degradation ----------------------------------------------------------

test('a missing transcript keeps the process facts', async () => {
  writePid();
  const d = (await read()).get(4242);
  assert.equal(d.status, 'running');
  assert.equal(d.name, 'proj-aa');
  assert.deepEqual(d.agents, []);
});

test('a tail window that begins mid-line drops the fragment and reads the rest', async () => {
  writePid();
  // 80KB of filler pushes the window boundary into the middle of a line.
  const filler = Array.from({ length: 400 }, (_, i) =>
    assistant([{ type: 'text', text: 'y'.repeat(200) + i }])).join('');
  writeTranscript(filler + assistant([{ type: 'tool_use', id: 'l', name: 'Grep' }]));
  const d = (await read()).get(4242);
  assert.ok(d, 'a mid-line window degraded the whole row');
  assert.equal(d.lastTool, 'Grep');
});

test('a single line larger than the first window is still read', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'z'.repeat(200_000) }, { type: 'tool_use', id: 'b', name: 'Read' }]));
  const d = (await read()).get(4242);
  assert.ok(d);
  assert.equal(d.lastTool, 'Read', 'the window never grew past a 200KB line');
});

test('an empty transcript and a garbage transcript both survive', async () => {
  writePid();
  writeTranscript('');
  assert.ok((await read()).get(4242), 'empty file threw away the row');

  resetTranscripts();
  writeTranscript('{ not json at all\nalso not json\n');
  assert.ok((await readTranscripts([session()], { now: now + 1 })).get(4242), 'garbage threw away the row');
});

test('an unreadable file costs one row, never the board', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  const dir = join(PROJ_DIR, SLUG, SID, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeAgent('ok');
  // A directory where a transcript is expected: EISDIR on open.
  mkdirSync(join(dir, 'agent-bad.jsonl'), { recursive: true });
  writeFileSync(join(dir, 'agent-bad.meta.json'), JSON.stringify({ description: 'bad' }));

  const d = (await read()).get(4242);
  assert.ok(d, 'an EISDIR sub-agent took down the session');
  assert.ok(d.agents.some((a) => a.label === 'task ok'));
});

test('a permission error degrades to no detail rather than throwing', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'text', text: 'x' }]));
  const p = join(PROJ_DIR, SLUG, `${SID}.jsonl`);
  chmodSync(p, 0o000);
  try {
    const map = await read();
    assert.ok(map instanceof Map, 'EACCES escaped as an exception');
  } finally {
    chmodSync(p, 0o644);
  }
});

test('a symlink loop cannot hang the parse', async () => {
  writePid();
  const dir = join(PROJ_DIR, SLUG);
  mkdirSync(dir, { recursive: true });
  const loop = join(dir, `${SID}.jsonl`);
  symlinkSync(loop, loop);        // points at itself: ELOOP on open
  const map = await read();
  assert.ok(map instanceof Map);
});

test('a pid file that is not JSON is refused quietly', async () => {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(join(PID_DIR, '4242.json'), 'not json');
  assert.equal((await read()).get(4242), undefined);
});

test('no absolute path, slug or prompt text appears in any result', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'tool_use', id: 't', name: 'Edit' }]));
  writeAgent('p1', { meta: { description: 'a task' } });
  const json = JSON.stringify([...(await read()).values()]);
  assert.doesNotMatch(json, /\/work\/proj/, 'an absolute path escaped');
  assert.doesNotMatch(json, new RegExp(SLUG.slice(1, 40)), 'the directory slug escaped');
  assert.doesNotMatch(json, /tmp/, 'a filesystem root escaped');
});

// Four independent schedulers call this module — the 10s safety refresh, the
// 150ms transcript debounce, the vault parse and the 60s publisher — so passes
// overlap routinely. The eviction set was a module singleton: a second pass
// replaced it, the first nulled it on exit, and the second then dereferenced
// null. Measured on the live machine before the fix: 30 of 40 concurrent calls
// REJECTED, from a module whose header promises it never throws.
test('overlapping passes do not reject, and do not evict each other\'s work', async () => {
  writePid();
  writeTranscript(assistant([{ type: 'tool_use', id: 't', name: 'Edit' }]));
  writeAgent('c1');
  writeAgent('c2');

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => readTranscripts([session()], { now: Date.now() })),
  );
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.deepEqual(rejected.map((r) => String(r.reason)), [], 'a concurrent pass threw');
  for (const r of results) {
    assert.equal(r.value.get(4242)?.agents.length, 2, 'a pass lost work to another pass\'s eviction');
  }
});

test('an empty session list yields an empty map and never throws', async () => {
  assert.equal((await readTranscripts([], { now })).size, 0);
  assert.equal((await readTranscripts(undefined, { now: now + 1 })).size, 0);
  assert.equal((await readTranscripts(null, { now: now + 2 })).size, 0);
});
