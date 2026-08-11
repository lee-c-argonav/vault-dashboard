// transcripts.js — what each live agent session is actually doing.
//
// WHY THIS EXISTS. sessions.js made a running session visible; it could not say
// anything about it. Two of three live sessions on this machine rendered as a
// path and an uptime under the tag NO STATUS, because describing yourself means
// writing a run file and that is opt-in and gated. Meanwhile a run file that DID
// exist declared 8 sub-agents, 7 of them running at 22m and climbing, while the
// filesystem held 27 sub-agent transcripts for that session and every one had
// returned. The board showed 7 running when none was running.
//
// So this module observes rather than believes. Every fact here is read from
// disk without the session's cooperation, which is what makes it impossible for
// a session to be wrong about itself on the board.
//
// THE JOIN. A pid does not obviously lead to a transcript, and every guess is
// wrong: the process holds no descriptor on its own transcript (lsof returns
// nothing), two live processes routinely share one cwd, a slug directory holds
// dozens of historical transcripts, and `--continue` attaches a new process to
// an old file. $HOME/.claude/sessions/<pid>.json is the answer, written by the
// process itself, one file per live pid, carrying sessionId, cwd, procStart, a
// derived name and the process's own busy/idle. It is cross-checked on cwd so a
// stale file or a reused pid produces no row rather than the wrong row.
//
// COST. Never reads a whole transcript: the largest on this machine is 13MB and
// four exceed 9MB. Tail-reads a window, and reads a 131-byte sidecar per
// sub-agent instead of a multi-kilobyte prompt. Measured at 16ms cold across
// three sessions and 27 sub-agents, against ~30 stat calls in steady state.
//
// SAFETY. Read-only. Never throws and never rejects — this sits on the vault
// parse path where an exception costs every panel. Degradation is PER FILE, not
// per module: sessions.js can wrap its whole body because its two subprocess
// calls are all-or-nothing, but one unreadable transcript here must cost one
// row, not the board.
//
// PRIVACY. The phone page is published to an unauthenticated URL. No absolute
// path, no directory slug, and no prompt text leaves this module. The slug
// matters and is easy to miss: `-Users-someone-Desktop-repos-thing` IS an
// absolute path in a form no `/` search will ever catch, so it is used to open a
// file and never stored on a returned object. Sub-agent labels come from the
// sidecar's short human-written `description`, never from the dispatch prompt —
// 27 of 27 real prompts begin with an absolute path, and truncating one keeps
// the prefix, which is the leak.

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, basename } from 'node:path';

/** Shorter than the 5s in sessions.js, so a new tool call lands on the next
 *  parse rather than the one after. */
export const CACHE_MS = 2_000;

/** First tail window. */
export const TAIL_BYTES = 64 * 1024;
/** Grown ×4 up to here when the window holds no complete line. The largest
 *  single line measured on this machine is 907,522 bytes, and five lines in one
 *  transcript exceed 64KB, so a fixed 64KB window yields nothing on exactly the
 *  busiest sessions. */
export const TAIL_MAX_BYTES = 1024 * 1024;

/** Newest by mtime. The excess is reported, never dropped silently. */
export const SUBAGENT_CAP = 64;

/** An open sub-agent that has not written for this long is stalled rather than
 *  working. Without a cutoff, an agent abandoned when its parent died counts as
 *  running forever, which is the defect this module exists to remove. */
export const AGENT_STALE_MS = 10 * 60_000;

/** How recently a file must have moved for a text-only tail to read as still
 *  working rather than finished. Generous relative to the sub-second cadence of
 *  a working agent, and far under AGENT_STALE_MS. */
export const AGENT_RECENT_MS = 60_000;

/** A read that has not returned by now is treated as a failed read. Nothing in
 *  this module may block the parse; a symlink loop or a stalled mount would. */
const READ_TIMEOUT_MS = 2_000;

/** A session whose process says it is busy but whose transcript has not grown
 *  for this long is stuck rather than working. */
export const SESSION_STALE_MS = 10 * 60_000;

// WHAT IS NOT DETECTABLE HERE, AND WHY THE DESIGN CHANGED.
//
// The spec for this module derived a `tool` state and a `needs-you` state from
// an unresolved `tool_use` at the tail of the transcript. That is not possible:
// the entry is not written before the tool runs. Measured directly — while a
// Bash tool of this very session was executing, its own transcript held zero
// unresolved `tool_use` entries, and a 12-second sampler over a second busy
// session caught none either. The assistant message carrying a tool call is
// flushed with its result, not before it.
//
// So "which tool is it in right now" is not on disk, and neither is "is it
// blocked on a permission prompt": the pid file carries only busy and idle, and
// no field distinguishes a slow command from a prompt awaiting an answer.
//
// What IS observable is used instead. `busy`/`idle` is the process's own answer.
// `idle` is genuinely actionable on its own — nothing will happen in that
// session until the operator types. `busy` with a transcript that has not grown
// is a stall. And NEEDS YOU stays what it already was: the run file's declared
// `needsInput`, which is the only trustworthy source for it and is already the
// loudest thing on both surfaces.

const HOME = homedir();

/**
 * Where the agent writes about itself. Overridable with VAULT_HUD_CLAUDE_HOME,
 * matching how VAULT_HUD_VAULT and VAULT_HUD_AGENTS are handled elsewhere.
 *
 * Read per call rather than captured at import, so a test can point it at a
 * fixture tree after the module has loaded. A module that can only be exercised
 * against the real home directory cannot have its failure modes tested, and the
 * failure modes are the whole reason this module is careful.
 */
function roots() {
  const base = process.env.VAULT_HUD_CLAUDE_HOME || join(HOME, '.claude');
  return { pid: join(base, 'sessions'), projects: join(base, 'projects') };
}

// ---------------------------------------------------------------------------

/** path -> { mtimeMs, size, value }. Content is keyed on the file's identity, so
 *  an unchanged file costs one stat. */
const fileCache = new Map();
/** Directory listings key on the directory's own mtime: the file key above
 *  cannot express which files exist. */
const dirCache = new Map();
let sweep = { at: -Infinity, key: '', value: new Map() };

// The set of paths a sweep touched is passed DOWN, never held in a module
// variable. It was a singleton, and four independent schedulers call this module
// — the 10s safety refresh, the 150ms transcript debounce, the vault parse and
// the 60s publisher — so passes overlap routinely. A second pass replaced the
// Set, the first nulled it on the way out, and the second then dereferenced
// null. Measured on the live machine: 30 of 40 concurrent calls REJECTED, which
// breaks the never-throws contract this whole module is built around.

/** Tests and shutdown want this; nothing else should. */
export function resetTranscripts() {
  fileCache.clear();
  dirCache.clear();
  sweep = { at: -Infinity, key: '', value: new Map() };
}

/** Never rejects. Returns `fallback` on any failure, including a timeout. */
async function guard(fn, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((res) => { timer = setTimeout(() => res(fallback), READ_TIMEOUT_MS); timer.unref?.(); }),
    ]);
  } catch {
    return fallback;
  } finally {
    // Cleared, not left to expire. One sweep over a session with 35 sub-agents
    // arms about 110 of these, and leaving each to hold its closure for two
    // seconds was measurable drift over a long-lived daemon.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the last `want` bytes of a file, dropping the leading fragment.
 *
 * THE LEADING LINE IS ALWAYS DISCARDED. A tail window begins mid-line by
 * construction, so parsing it throws on nearly every session — and under a
 * never-throw posture that degrades every row to nothing, silently. Dropping it
 * costs one entry and is the difference between this working and not.
 */
async function tailLines(path, want = TAIL_BYTES) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(want, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // Only when the window started mid-file; a window covering the whole file
    // has a genuine first line.
    if (len < size) lines.shift();
    return lines.filter(Boolean);
  } finally {
    await fh.close();
  }
}

/** Parsed entries from the tail, growing the window when it holds none. */
async function tailEntries(path) {
  for (let want = TAIL_BYTES; want <= TAIL_MAX_BYTES; want *= 4) {
    const lines = await tailLines(path, want);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* one bad line, not the file */ }
    }
    if (out.length) return out;
    const { size } = await stat(path);
    if (want >= size) return [];        // whole file read, genuinely empty
  }
  return [];
}

/** Cached read, keyed on the file's identity. */
async function cached(path, produce, touched) {
  touched?.add(path);
  const st = await guard(() => stat(path), null);
  if (!st) { fileCache.delete(path); return null; }
  const hit = fileCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = await guard(() => produce(st), null);
  fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// ---------------------------------------------------------------------------

/**
 * The cwd→directory transform, used to open a file and never to build a value.
 *
 * It is lossy and not reliably invertible — one directory on this machine reads
 * a mangled name where the real path held a non-ASCII character — so a derived
 * slug is treated as a guess. The transcript's own `cwd` field is what confirms
 * it, and a mismatch yields no row rather than a wrong one.
 */
function slugFor(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Turn a cwd into the two things a surface may show. Mirrors describeCwd in
 * sessions.js deliberately: this module must arrive at the same pair from the
 * pid file that sessions.js arrived at from lsof, or the cross-check below
 * would compare two different conventions.
 */
function describe(cwd) {
  // String-guarded like slugFor. A non-string cwd in the pid file makes
  // path.relative throw ERR_INVALID_ARG_TYPE; the outer guard catches it, but it
  // costs the row silently rather than being refused on its merits.
  if (!cwd || typeof cwd !== 'string') return { project: '', where: '' };
  const rel = relative(HOME, cwd);
  if (rel === '') return { project: '~', where: '~' };
  return { project: basename(cwd), where: rel.startsWith('..') ? '' : rel };
}

/**
 * `procStart` is rendered in UTC; `ps lstart`, which sessions.js parses, is
 * rendered in local time. Date.parse on the bare string reads it as local and is
 * wrong by the whole UTC offset — measured at 4h on this machine, which is four
 * hours of silently pairing a pid with the wrong session.
 */
function parseProcStart(s) {
  const t = Date.parse(`${s} UTC`);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The join. Returns null rather than a guess.
 *
 * Cross-checked on cwd, so a pid file left behind by a dead process, or a pid
 * recycled by the OS onto some other program, produces no row. `procStart` is
 * the second guard and is compared with a tolerance because the two sources
 * round differently — measured at 1-2 seconds apart across three live sessions.
 */
async function readPidFile(session, touched) {
  const path = join(roots().pid, `${session.pid}.json`);
  const raw = await cached(path, async () => {
    const fh = await open(path, 'r');
    try { return JSON.parse(await fh.readFile('utf8')); } finally { await fh.close(); }
  }, touched);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;

  // Cross-check on cwd, unless lsof could not read one. sessions.js yields
  // `{project:'', where:''}` when the cwd is unreadable, and comparing that
  // against the pid file's real cwd discarded the MORE authoritative source
  // because the weaker one failed — degrading every session to layer 0 on a
  // sandboxed machine with nothing on the board saying why. `procStart` below is
  // still checked, so the pairing is never unguarded.
  const haveCwd = Boolean(session.where || session.project);
  const seen = describe(raw.cwd);
  if (haveCwd && (seen.where !== session.where || seen.project !== session.project)) return null;

  const started = parseProcStart(raw.procStart);
  const since = Date.parse(session.since);
  if (Number.isFinite(started) && Number.isFinite(since)
      && Math.abs(started - since) > 5_000) return null;

  return {
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    name: typeof raw.name === 'string' ? raw.name : '',
    // The process's own answer, which beats any inference drawn from its file.
    busy: raw.status === 'busy',
  };
}

// ---------------------------------------------------------------------------

/** The last entry carrying a message. Transcripts end with untimestamped
 *  records — turn_duration, bridge-session, last-prompt, ai-title, mode — so the
 *  literal last line is usually not the one that says anything. */
function lastMessage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]?.message;
    if (m && typeof m === 'object' && m.role) return entries[i];
  }
  return null;
}

/** Content blocks of an entry, always an array. */
const blocks = (entry) => {
  const c = entry?.message?.content;
  return Array.isArray(c) ? c : [];
};

/**
 * The most recent tool this session used, or ''.
 *
 * The LAST tool, not the current one, and the row must say so. A tool call
 * reaches disk with its result rather than before it, so the only honest reading
 * is "the last thing it did". That is still the difference between a row that
 * says nothing and a row that says `Edit`.
 */
function lastTool(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const names = blocks(entries[i])
      .filter((b) => b?.type === 'tool_use' && b.name)
      .map((b) => b.name);
    if (names.length) return names[names.length - 1];
  }
  return '';
}

/** A branch worth rendering. `HEAD` is a detached head and says nothing; the
 *  field is absent outside a repository. Neither is a failure. */
function branchOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const b = entries[i]?.gitBranch;
    if (typeof b === 'string' && b && b !== 'HEAD') return b;
  }
  return '';
}

// ---------------------------------------------------------------------------

/**
 * A sub-agent's state.
 *
 * `returned` is "the last message-bearing entry carries no tool_use block", and
 * NOT "stop_reason is end_turn". Measured across 27 real sub-agent transcripts:
 * the last entry is an assistant message in 27 of 27, `stop_reason` is
 * `end_turn` in 20 and null in 7, and a tool_use block appears in the last entry
 * in 0 of 27. The stop_reason rule reports those 7 finished agents as running
 * forever — which is exactly the miscount this module was written to remove.
 * `stop_reason` also takes the value `tool_use` on a live entry, so it is
 * evidence about waiting and not about finishing.
 */
function agentState(entries, movedAt, now) {
  const last = lastMessage(entries);
  // No message yet: just dispatched, not finished.
  if (!last) return now - movedAt > AGENT_STALE_MS ? 'stalled' : 'running';

  const role = last.message?.role;
  const hasToolUse = blocks(last).some((b) => b?.type === 'tool_use');
  // Two shapes are definitely mid-flight. A `user` entry is a tool_result the
  // agent has not answered yet, and an assistant entry carrying a tool_use is a
  // tool in progress.
  if (role === 'user' || hasToolUse) {
    return now - movedAt > AGENT_STALE_MS ? 'stalled' : 'running';
  }
  // Everything else is an assistant entry with text or thinking, and CONTENT
  // CANNOT SETTLE IT. An assistant turn is split across several entries —
  // thinking, then text, then a tool call — and only the last carries a
  // stop_reason, so a mid-turn text entry is byte-identical to a finished one.
  //
  // Measured over 4,104 mid-flight boundaries in 35 real sub-agent transcripts:
  // the previous rule ("no tool_use means done") called 2,598 of them done,
  // 63.3% of boundaries and 89.7% of wall-clock time. A board reporting
  // "8 AGENTS DONE" while eight are working is the defect this module exists to
  // remove, with the sign flipped.
  //
  // Recency settles it instead, and it is sound because a finished agent never
  // writes again while a working one writes every few seconds. Same 35 files:
  // 0 false 'done' mid-flight, and 34 of 35 completed agents correctly done.
  return now - movedAt > AGENT_RECENT_MS ? 'done' : 'running';
}

/**
 * Every sub-agent this session dispatched.
 *
 * Labels come from the `.meta.json` sidecar beside each transcript: 131 bytes
 * carrying agentType, a short human-written description, and spawnDepth. The
 * alternative — the first line of the dispatch prompt — is wrong three ways, all
 * measured: 27 of 27 begin with an absolute path so any prefix truncation keeps
 * the leak, 19 of 27 first lines exceed 4KB so a bounded head read truncates the
 * JSON and throws, and the text is a multi-kilobyte paragraph rather than a row
 * label.
 */
async function readAgents(dir, now, touched) {
  const st = await guard(() => stat(dir), null);
  if (!st?.isDirectory()) return { agents: [], capped: 0 };

  touched?.add(dir);
  const hit = dirCache.get(dir);
  let names;
  if (hit && hit.mtimeMs === st.mtimeMs) {
    names = hit.names;
  } else {
    names = (await guard(() => readdir(dir), []))
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
    dirCache.set(dir, { mtimeMs: st.mtimeMs, names });
  }

  const stamped = [];
  for (const file of names) {
    const s = await guard(() => stat(join(dir, file)), null);
    if (s) stamped.push({ file, movedAt: s.mtimeMs, birth: s.birthtimeMs || 0 });
  }
  stamped.sort((a, b) => b.movedAt - a.movedAt);
  const capped = Math.max(0, stamped.length - SUBAGENT_CAP);
  const take = stamped.slice(0, SUBAGENT_CAP);

  const agents = [];
  for (const { file, movedAt, birth } of take) {
    const id = file.slice('agent-'.length, -'.jsonl'.length);
    const meta = await cached(join(dir, `agent-${id}.meta.json`), async () => {
      const fh = await open(join(dir, `agent-${id}.meta.json`), 'r');
      try { return JSON.parse(await fh.readFile('utf8')); } finally { await fh.close(); }
    }, touched);
    const entries = await cached(join(dir, file), () => tailEntries(join(dir, file)), touched);
    if (!entries) continue;

    agents.push({
      // Short and opaque; enough to tell two rows apart, carries no path.
      id: id.slice(0, 8),
      label: typeof meta?.description === 'string' ? meta.description : '',
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : '',
      depth: Number.isInteger(meta?.spawnDepth) ? meta.spawnDepth : 1,
      parent: typeof meta?.parentAgentId === 'string' ? meta.parentAgentId.slice(0, 8) : '',
      // The file's BIRTH time, not the first stamp in the tail window. The
      // window is 64KB and every one of the 35 real sub-agent transcripts on
      // this machine is larger — smallest 160KB, median 469KB — so the first
      // stamp it captures is never the agent's start. Measured understatement:
      // median 265s, worst 2,211s, which rendered a 44-minute agent as `+7m`
      // and mis-sorted the rows, since they order by this field. birthtime
      // matched the true first timestamp on all 35 files.
      started: birth ? new Date(birth).toISOString() : firstStamp(entries),
      movedAt: new Date(movedAt).toISOString(),
      state: agentState(entries, movedAt, now),
    });
  }
  agents.sort((a, b) => String(a.started).localeCompare(String(b.started)));
  return { agents, capped };
}

function firstStamp(entries) {
  for (const e of entries) {
    if (typeof e?.timestamp === 'string') return e.timestamp;
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * One session's observed detail, or null when the join fails.
 */
async function readOne(session, now, touched) {
  const pid = await readPidFile(session, touched);
  if (!pid) return null;

  const dir = join(roots().projects, slugFor(pid.cwd));
  const path = join(dir, `${pid.sessionId}.jsonl`);
  const st = await guard(() => stat(path), null);
  if (!st) {
    // The transcript is missing or the slug guess was wrong. The name and the
    // process's own busy flag are still real, so the row keeps them.
    return {
      status: pid.busy ? 'working' : 'idle',
      lastTool: '', movedAt: null, branch: '', name: pid.name,
      agents: [], agentsCapped: 0,
    };
  }

  const entries = (await cached(path, () => tailEntries(path), touched)) ?? [];
  // Confirms the slug guess, and only that. A transcript belonging to some other
  // directory entirely means the derived slug landed on the wrong tree.
  //
  // Compared against EVERY claim in the window, not the first one. The `cwd` on
  // an entry records where a tool ran, not where the session lives, so a session
  // that read a file in a subdirectory writes entries carrying that
  // subdirectory. Taking the first match rejected a live session whose window
  // held 11 entries at its own cwd and 3 at a folder beneath it — measured, not
  // hypothetical. A path at or under the session's own cwd is confirmation.
  const claims = entries.map((e) => e?.cwd).filter((c) => typeof c === 'string' && c);
  if (claims.length
      && !claims.some((c) => c === pid.cwd || c.startsWith(`${pid.cwd}/`))) return null;

  // Three states, each from evidence that exists. `stalled` is the one worth
  // catching: a process claiming to work while writing nothing.
  const silent = now - st.mtimeMs;
  const status = !pid.busy ? 'idle'
    : silent > SESSION_STALE_MS ? 'stalled'
      : 'working';

  const { agents, capped } = await readAgents(join(dir, pid.sessionId, 'subagents'), now, touched);

  return {
    status,
    // A tool NAME, never a tool argument and never prompt text. Desktop only;
    // the published projection drops it.
    lastTool: lastTool(entries),
    movedAt: new Date(st.mtimeMs).toISOString(),
    branch: branchOf(entries),
    name: pid.name,
    agents,
    agentsCapped: capped,
  };
}

// `heldMs` was removed. It was recomputed from the clock every parse, shipped in
// State, and read by nobody — so `flashIfChanged` saw a different sessions blob
// on every parse and fired the runs-panel change flash forever, including on a
// completely idle machine. A flash that always fires means nothing.

/**
 * Observed detail for every live session, keyed by pid.
 *
 * Never throws and never rejects. A session that cannot be joined, or whose
 * files cannot be read, is simply absent from the map, and the caller renders
 * what sessions.js already knew.
 *
 * @param {{pid:number, since:string, project:string, where:string}[]} sessions
 * @returns {Promise<Map<number, object>>}
 */
export async function readTranscripts(sessions, opts = {}) {
  const now = opts.now ?? Date.now();
  const list = sessions ?? [];
  // Keyed on WHICH sessions were asked about, not on time alone. Keying on time
  // meant a second caller passing a different session list inside the window was
  // handed the first caller's answer — a new pid rendered with no detail for up
  // to CACHE_MS, and a test injecting fixture sessions could be served the real
  // machine's map. A backwards clock (an NTP step) is stale, not fresh: `now -
  // sweep.at` goes negative, which is always under the window.
  const key = list.map((s) => s.pid).sort((a, b) => a - b).join(',');
  const age = now - sweep.at;
  if (age >= 0 && age < CACHE_MS && key === sweep.key) return sweep.value;

  const out = new Map();
  const touched = new Set();
  for (const s of list) {
    const detail = await guard(() => readOne(s, now, touched), null);
    if (detail) out.set(s.pid, detail);
  }
  // Evict everything this pass did not ask for. Both caches are keyed by
  // absolute path and only ever grew: a finished session's paths are never
  // requested again, so nothing removed them. Measured at 82KB retained per
  // dead session, which on this machine's 2,832 transcript files extrapolates
  // to roughly 226MB held by a daemon that is meant to run for weeks.
  for (const k of fileCache.keys()) if (!touched.has(k)) fileCache.delete(k);
  for (const k of dirCache.keys()) if (!touched.has(k)) dirCache.delete(k);

  sweep = { at: now, key, value: out };
  return out;
}
