#!/usr/bin/env node
// parse.js — vault markdown → the State object. Read-only: nothing here writes
// to the vault. See SPEC.md ("Scanning scope", "The State object", "Parsing rules").

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readRunsDetailed, readFinishedRunsDetailed } from './runs.js';
import { partitionRuns, linkSessions, sessionContext } from './public/runs-view.js';
import { readSessions } from './sessions.js';
import { readTranscripts } from './transcripts.js';

/**
 * Which sessions are alive, what each is doing, and which run belongs to which.
 *
 * Factored out of parseVault so a transcript event can refresh this WITHOUT
 * re-walking the vault. A busy session with a fan-out appends several times a
 * second; routing that through the full parse re-reads every note and rebuilds
 * the graph — measured at 110ms cold and 17ms warm plus a ~150KB broadcast per
 * push, roughly three full parses a second, driven by files the vault parse
 * never opens.
 *
 * @param {object[]} activeRuns  live runs, already partitioned
 * @param {object[]} finishedRuns  for the goal-recall line only
 */
export async function observeSessions(activeRuns, finishedRuns, nowMs) {
  const live = await readSessions();
  const linked = linkSessions(activeRuns, live);
  // What each session is actually doing, read from its own files. Keyed by pid
  // and merged onto BOTH halves: a session that publishes a run still benefits
  // from observed fan-out, because a run file's declared `units[].agents` has
  // been measured wrong by the whole quantity — 8 declared and running against
  // 27 on disk with every one finished.
  const observed = await readTranscripts(live, { now: nowMs });
  // A session with no live run may still have published one that just finished.
  // Without this the best-described session on the board becomes the emptiest
  // row on it the moment its work completes.
  const sessions = linked.unpublished.map((s) => ({
    // linked.runs, not the raw read: the guard in sessionContext keys on
    // `.session`, which only exists after linking.
    ...s,
    context: sessionContext(s, linked.runs.concat(finishedRuns), nowMs),
    ...(observed.get(s.pid) ?? {}),
  }));
  // A run's session carries the same detail, so a run row can say the process
  // behind it has been silent for forty minutes while the file claims RUNNING.
  const runs = linked.runs.map((r) => (r.session
    ? { ...r, session: { ...r.session, ...(observed.get(r.session.pid) ?? {}) } }
    : r));
  return { runs, sessions };
}

const SCANNED_DIRS = [
  '00-Inbox', '10-Projects', '20-Research', '30-Reading',
  '40-Daily', '50-People', '60-Standards', '70-Memory',
];
const SKIPPED_DIRS = new Set(['99-Archive', '_to_delete', 'node_modules']);

const DAY_MS = 86_400_000;
const STALE30_DAYS = 30;
const MAX_DECISIONS = 6;
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const TODO_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/;
const CHECKBOX_RE = /^\s*[-*]\s+\[[ xX]\]/;
export const H2_RE = /^##\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const CODE_SPAN_RE = /(`[^`]+`)/;
export const DECISION_RE = /^\s*[-*]\s+\[(\d{4}-\d{2}-\d{2})\]\s+[—-]\s+(.+)$/;
const FOCUS_RE = /^\*\*(.+?)\*\*\s*(.*)$/;
// Digit-boundary anchored, so a date is not matched out of the middle of a
// longer run of digits (an id, a version string, a phone number).
const ISO_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
export const DAILY_NOTE_RE = /^40-Daily\/(\d{4}-\d{2}-\d{2})\.md$/;
const INBOX_DATE_RE = /^00-Inbox\/(\d{4}-\d{2}-\d{2})-/;

// ── dates ────────────────────────────────────────────────────────────────────

const localISODate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole-day difference between two YYYY-MM-DD strings, midnight-UTC anchored. */
const daysBetween = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

function isRealDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// ── file collection ──────────────────────────────────────────────────────────

async function walk(root, rel, out) {
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, child, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
  }
}

/** In-scope note paths, vault-relative, sorted. Scanned dirs recurse; the root does not. */
export async function collectNotes(vaultPath) {
  const paths = [];
  for (const entry of await readdir(vaultPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && entry.name.endsWith('.md')) paths.push(entry.name);
    else if (entry.isDirectory() && SCANNED_DIRS.includes(entry.name)) await walk(vaultPath, entry.name, paths);
  }
  return paths.sort();
}

// ── preprocessing ────────────────────────────────────────────────────────────

/**
 * Blank out fenced code blocks, delimiters included, keeping every line index
 * intact so reported line numbers still match the file on disk.
 */
export function stripFences(lines) {
  let fence = null;
  return lines.map((line) => {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) {
      fence = m[1];
      return '';
    }
    return line;
  });
}

// ── inline markdown → HTML ───────────────────────────────────────────────────

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// `obsidian:` as a whole is too broad: the scheme includes write-capable actions,
// and this is a read-only panel rendering links authored in arbitrary vault
// markdown. Allow only the read verb, which is the sole one the parser itself
// ever generates.
const SAFE_URL_RE = /^(https?:|mailto:|obsidian:\/\/open\?)/i;

/**
 * Everything before the first |, then # or ^, is the target; an alias overrides
 * the label.
 *
 * The pipe must be written `\|` inside a markdown table, so a link authored
 * there arrives as `[[target\|alias]]`. The backslash is an escape for the
 * *table* parser, not the wikilink parser, so it is stripped before splitting
 * and `\|` still separates target from alias. Splitting on the raw text instead
 * yields the target `target\` and reports a broken link.
 */
export function splitWikilink(inner) {
  const [beforeAlias, ...rest] = inner.replace(/\\\|/g, '|').split('|');
  const target = beforeAlias.split(/[#^]/)[0].trim();
  return { target, label: (rest.length ? rest.join('|') : beforeAlias).trim() };
}

function renderSpans(escaped, hrefFor) {
  return escaped
    .replace(WIKILINK_RE, (_, inner) => {
      const { target, label } = splitWikilink(inner);
      return `<a class="wl" href="${escapeHtml(hrefFor(target))}">${label}</a>`;
    })
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (whole, label, url) =>
      SAFE_URL_RE.test(url) ? `<a href="${url}">${label}</a>` : whole)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w*_])([*_])([^\s*_][^*_]*?)\1(?![\w*_])/g, '<em>$2</em>');
}

/**
 * The whole renderer. Input is HTML-escaped FIRST — every later substitution only
 * inserts markup this function generated, so no vault text can inject HTML. Code
 * spans are split out before the other rules run, so markdown inside them stays
 * literal (`[[wikilinks]]` in CLAUDE.md must render as text, not a link).
 */
export function renderInline(text, hrefFor) {
  return escapeHtml(text)
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 ? `<code>${part.slice(1, -1)}</code>` : renderSpans(part, hrefFor)))
    .join('');
}

// ── wikilink resolution ──────────────────────────────────────────────────────

/**
 * Obsidian-style resolution against in-scope notes: exact relative path first,
 * then a unique basename. A basename shared by two notes stays unresolved — a
 * vault usually has at least one, and it is worth surfacing.
 */
export function buildResolver(notePaths) {
  const byPath = new Map();
  const byBase = new Map();
  for (const p of notePaths) {
    const id = p.slice(0, -3);
    byPath.set(id.toLowerCase(), id);
    const base = path.basename(id).toLowerCase();
    byBase.set(base, byBase.has(base) ? null : id);
  }
  return (rawTarget) => {
    const key = rawTarget.replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase();
    if (byPath.has(key)) return { id: byPath.get(key), ambiguous: false };
    if (byBase.has(key)) {
      const hit = byBase.get(key);
      return hit ? { id: hit, ambiguous: false } : { id: null, ambiguous: true };
    }
    return { id: null, ambiguous: false };
  };
}

// ── per-line extraction ──────────────────────────────────────────────────────

/**
 * Inline code is stripped first: Obsidian does not resolve a wikilink inside
 * backticks, so neither do we. Without this, prose that merely *names* the syntax
 * (`[[wikilinks]]` in the vault's own docs) is counted as four broken links.
 */
export const wikilinkTargets = (line) =>
  [...line.replace(/`[^`]*`/g, ' ').matchAll(WIKILINK_RE)]
    .map((m) => splitWikilink(m[1]).target)
    .filter(Boolean);

/**
 * Due date = earliest real ISO date left after wikilinks, inline code and URLs
 * are removed. Every one of those removals is load-bearing: without the first,
 * `[[2026-07-21-meeting-notes]]` reads as an overdue due date; without
 * the last, a dated permalink or an archive URL does the same and inflates
 * `stats.overdue`.
 */
function extractDue(text) {
  const scrubbed = text
    .replace(WIKILINK_RE, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')      // markdown link targets
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' '); // bare URLs
  const dates = (scrubbed.match(ISO_DATE_RE) ?? []).filter(isRealDate).sort();
  return dates[0] ?? null;
}

/** First `**label** detail` line under `## Todos` in today's note, before any checkbox. */
function extractFocus(lines) {
  let inTodos = false;
  for (const line of lines) {
    const heading = H2_RE.exec(line);
    if (heading) {
      inTodos = heading[1].toLowerCase() === 'todos';
      continue;
    }
    if (!inTodos) continue;
    if (CHECKBOX_RE.test(line)) return null;
    const m = FOCUS_RE.exec(line.trim());
    if (!m) continue;
    const label = m[1].trim().replace(/\.$/, '');
    const detail = m[2].trim().replace(/\.$/, '');
    // Kept split rather than joined: the client sets the label as an eyebrow over
    // the detail, and re-splitting a joined string is guesswork once the label
    // itself contains an em dash ("Focus — project sync").
    return { label, detail: detail || null };
  }
  return null;
}

// ── State assembly ───────────────────────────────────────────────────────────

export default async function parseVault(vaultPath) {
  const root = path.resolve(vaultPath);
  const vaultName = path.basename(root);
  const now = new Date();
  const today = localISODate(now);
  const warnings = [];

  // Read the runs early so anything wrong with them lands in `warnings` with
  // every other parse complaint. Both of these used to be silent: an unreadable
  // 15-Runs looked exactly like a vault with no runs, and a run file the reader
  // could not use was counted into a local variable and discarded (the KNOWN
  // GAP that stood in runs.js until 2026-08-10). A run that never appears with
  // nothing on screen explaining why is the worst failure this panel has.
  const runsDetail = await readRunsDetailed(root);
  // The archive is read BEFORE partitioning, not after. `partitionRuns` excludes
  // archived ids from `active` for the interrupted-move case: a `cp` instead of
  // a `mv`, or a move killed halfway, leaves a copy in 15-Runs still marked
  // running. The phone has passed the archive since 2026-08-10 and the desktop
  // never did, so the two surfaces disagreed — proven against a run present in
  // both places: phone active [], desktop active ['r-1'], forever.
  const archived = await readFinishedRunsDetailed(root).catch(() => ({ runs: [] }));
  const runsRead = partitionRuns(runsDetail.runs, archived.runs ?? []);
  // Which sessions are actually alive, and which of them are telling nobody.
  // A run file is the only thing that ever put a session on this board, and
  // writing one is opt-in, so most sessions appeared nowhere. Observed liveness
  // is the floor under that.
  // The ARCHIVE too, not just 15-Runs. A session that closed its run out and
  // moved the file to 99-Archive/runs — step 9 of /close — got no goal-recall
  // line and rendered NO STATUS.
  const { runs: linkedRuns, sessions: sessionsOut } = await observeSessions(
    runsRead.active,
    runsDetail.runs.filter((r) => r.state === 'done').concat(archived.runs ?? []),
    now.getTime(),
  );
  const linked = { runs: linkedRuns };
  if (runsDetail.unreadable) {
    warnings.push(`cannot read ${path.join(root, '15-Runs')} — no run can appear`);
  }
  if (runsDetail.skipped) {
    warnings.push(
      `${runsDetail.skipped} run ${runsDetail.skipped === 1 ? 'file is' : 'files are'} ` +
      'unreadable or missing a runId, and cannot be shown',
    );
  }

  const obsidianUrl = (noteId) =>
    `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(noteId)}`;

  const notePaths = await collectNotes(root);
  const resolve = buildResolver(notePaths);
  const hrefFor = (target) => obsidianUrl(resolve(target).id ?? target);

  const notes = await Promise.all(notePaths.map(async (rel) => {
    const abs = path.join(root, rel);
    const [raw, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
    const id = rel.slice(0, -3);
    const dir = path.dirname(id);
    const dailyDate = DAILY_NOTE_RE.exec(rel)?.[1] ?? null;
    return {
      rel,
      id,
      folder: dir === '.' ? '' : dir,
      label: path.basename(id),
      lines: stripFences(raw.split(/\r?\n/)),
      mtimeMs: info.mtimeMs,
      dailyDate,
      // A daily note dated after today holds scheduled work, not owed work.
      scheduled: dailyDate !== null && dailyDate > today,
    };
  }));

  const todos = [];
  const decisions = [];
  const edges = [];
  const edgeKeys = new Set();
  const broken = [];
  const brokenKeys = new Set();
  const inbound = new Map(notes.map((n) => [n.id, new Set()]));
  const outbound = new Map(notes.map((n) => [n.id, new Set()]));
  let linkCount = 0;

  for (const note of notes) {
    let section = null;
    note.lines.forEach((line, i) => {
      const heading = H2_RE.exec(line);
      if (heading) {
        section = heading[1];
        return;
      }
      const lineNo = i + 1;

      for (const target of wikilinkTargets(line)) {
        linkCount += 1;
        const { id: targetId, ambiguous } = resolve(target);
        if (!targetId) {
          const key = `${note.id}\u0000${target}`;
          if (!brokenKeys.has(key)) {
            brokenKeys.add(key);
            broken.push({ source: note.id, link: target });
          }
          const warning = `Ambiguous wikilink [[${target}]] — more than one in-scope note has that basename`;
          if (ambiguous && !warnings.includes(warning)) warnings.push(warning);
          continue;
        }
        if (targetId === note.id) continue;
        outbound.get(note.id).add(targetId);
        inbound.get(targetId).add(note.id);
        const key = `${note.id}\u0000${targetId}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({ source: note.id, target: targetId });
        }
      }

      const todo = TODO_RE.exec(line);
      if (todo) {
        const text = todo[2].trim();
        if (text) {
          todos.push(buildTodo({
            note, lineNo, section, text, done: todo[1] !== ' ', today, resolve, hrefFor, obsidianUrl,
          }));
        }
        return;
      }

      if (section && /^(recent )?decisions$/i.test(section)) {
        const decision = DECISION_RE.exec(line);
        if (decision) {
          decisions.push({
            date: decision[1],
            html: renderInline(decision[2].trim(), hrefFor),
            source: note.rel,
            obsidian: obsidianUrl(note.id),
          });
        }
      }
    });
  }

  const openTodos = todos.filter((t) => !t.done && !t.scheduled);
  const rolledOver = openTodos
    .filter((t) => t.ageDays !== null && t.ageDays >= 1)
    .sort((a, b) => b.ageDays - a.ageDays || a.source.localeCompare(b.source) || a.line - b.line);

  const todayNote = notes.find((n) => n.dailyDate === today);
  const stats = {
    open: openTodos.length,
    stale: rolledOver.length,
    dueToday: openTodos.filter((t) => t.dueState === 'today').length,
    overdue: openTodos.filter((t) => t.dueState === 'overdue').length,
    doneToday: todayNote ? todos.filter((t) => t.done && t.source === todayNote.rel).length : 0,
  };

  const openPerNote = new Map();
  for (const t of openTodos) openPerNote.set(t.source, (openPerNote.get(t.source) ?? 0) + 1);

  const nodes = notes.map((note) => ({
    id: note.id,
    label: note.label,
    folder: note.folder,
    inbound: inbound.get(note.id).size,
    outbound: outbound.get(note.id).size,
    // Daily notes are chronological, not networked: nothing is ever supposed to
    // link back to one, so counting them as orphans buries the real strays.
    orphan: inbound.get(note.id).size === 0 && note.folder !== '40-Daily',
    todos: openPerNote.get(note.rel) ?? 0,
    obsidian: obsidianUrl(note.id),
  }));

  const inboxNotes = notes.filter((n) => n.rel.startsWith('00-Inbox/'));
  const inboxAges = inboxNotes.map((n) =>
    daysBetween(today, INBOX_DATE_RE.exec(n.rel)?.[1] ?? localISODate(new Date(n.mtimeMs))));

  return {
    generatedAt: now.toISOString(),
    today,
    todayLabel: WEEKDAYS[now.getDay()],
    vaultPath: root,
    vaultName,
    stats,
    focus: todayNote ? extractFocus(todayNote.lines) : null,
    groups: buildGroups(todos, obsidianUrl, today),
    rolledOver,
    decisions: decisions
      .sort((a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source))
      .slice(0, MAX_DECISIONS),
    graph: { nodes, edges },
    // Only live runs reach the desktop panel. A finished run used to stay on it
    // until a session remembered to move its file, and on 2026-08-08 one did
    // not, so a done run held a slot for two days. History is the phone page's
    // job; the desktop is a now instrument.
    runs: linked.runs,
    // Live sessions that are publishing nothing. One line each; see sessions.js.
    sessions: sessionsOut,
    // Carried on State so the partial refresh can feed sessionContext the same
    // finished runs a full parse would — BOTH halves, 15-Runs and the archive.
    // Carrying only the first half was the same oscillation in a smaller form:
    // /close moves the file to the archive, so the archived half is the common
    // case, and the goal-recall line flipped between its goal and empty every
    // ten seconds. Observed live over sixteen seconds before this was fixed.
    finishedRuns: runsDetail.runs.filter((r) => r.state === 'done')
      .concat(archived.runs ?? []),
    health: {
      notes: notes.length,
      links: linkCount,
      inbox: { count: inboxNotes.length, oldestDays: inboxAges.length ? Math.max(...inboxAges) : 0 },
      orphans: nodes.filter((n) => n.orphan).length,
      stale30: notes.filter((n) =>
        !n.rel.startsWith('40-Daily/') && (now.getTime() - n.mtimeMs) / DAY_MS > STALE30_DAYS).length,
      broken,
    },
    warnings,
  };
}

function buildTodo({ note, lineNo, section, text, done, today, resolve, hrefFor, obsidianUrl }) {
  const links = wikilinkTargets(text);
  const due = extractDue(text);
  return {
    id: `${note.rel}:${lineNo}`,
    text,
    html: renderInline(text, hrefFor),
    done,
    source: note.rel,
    line: lineNo,
    section,
    project: attributeProject(note, links, resolve),
    due,
    dueState: due === null ? null : due < today ? 'overdue' : due === today ? 'today' : 'future',
    ageDays: note.dailyDate ? daysBetween(today, note.dailyDate) : null,
    scheduled: note.scheduled,
    links,
    obsidian: obsidianUrl(note.id),
  };
}

const PROJECT_DIR = '10-Projects/';

/** Hub file wins; otherwise the first wikilink landing on a project hub; otherwise unassigned. */
function attributeProject(note, links, resolve) {
  const hub = new RegExp(`^${PROJECT_DIR}([^/]+)\\.md$`).exec(note.rel);
  if (hub) return hub[1];
  for (const target of links) {
    const { id } = resolve(target);
    if (!id || !id.startsWith(PROJECT_DIR)) continue;
    const name = id.slice(PROJECT_DIR.length);
    if (!name.includes('/')) return name;
  }
  return null;
}

const UNASSIGNED = 'unassigned';

// The panel is a day-planner, not a project index. Dated pressure floats to the
// top as time-horizon sections; only undated work is grouped by project. An
// explicit due date dominates daily-note age, so an item written days ago but
// due next week reads as upcoming, not behind.
function horizonOf(todo) {
  if (todo.done) return 'done';
  if (todo.dueState === 'overdue') return 'overdue';
  if (todo.dueState === 'today') return 'today';
  if (todo.dueState === 'future' || todo.scheduled) return 'upcoming';
  if (todo.ageDays >= 1) return 'overdue'; // rolled over from a past daily note
  if (todo.ageDays === 0) return 'today'; //  written in today's daily note
  return 'backlog'; //                        undated checkbox in a project/doc
}

const HORIZON_SPEC = {
  overdue: { key: 'overdue', label: 'OVERDUE', kind: 'horizon' },
  today: { key: 'today', label: 'TODAY', kind: 'horizon' },
  upcoming: { key: 'upcoming', label: 'UPCOMING', kind: 'horizon' },
  done: { key: 'done', label: 'DONE', kind: 'done' },
};

// Section order: the three horizons, then backlog projects, then DONE.
const SECTION_RANK = { overdue: 0, today: 1, upcoming: 2, backlog: 3, done: 4 };

function buildGroups(todos, obsidianUrl, today) {
  const groups = new Map();
  const ensure = (spec) => {
    if (!groups.has(spec.key)) groups.set(spec.key, { ...spec, obsidian: null, open: 0, done: 0, todos: [], ...spec.extra });
    return groups.get(spec.key);
  };

  for (const todo of todos) {
    const horizon = horizonOf(todo);
    const group =
      horizon === 'backlog'
        ? ensure({
            key: todo.project ?? UNASSIGNED,
            label: (todo.project ?? UNASSIGNED).toUpperCase(),
            kind: 'backlog',
            extra: { obsidian: todo.project ? obsidianUrl(`${PROJECT_DIR}${todo.project}`) : null },
          })
        : ensure(HORIZON_SPEC[horizon]);
    if (todo.done) group.done += 1;
    else group.open += 1;
    group.todos.push(todo);
  }

  // Authoritative within-section ordering; the client renders in the given order.
  const behind = (t) => (t.dueState === 'overdue' ? daysBetween(today, t.due) : t.ageDays ?? 0);
  const soonest = (t) => (t.dueState === 'future' ? t.due : DAILY_NOTE_RE.exec(t.source)?.[1]) ?? '9999-12-31';
  const bySourceLine = (a, b) => a.source.localeCompare(b.source) || a.line - b.line;
  const withinSection = {
    overdue: (a, b) => behind(b) - behind(a) || bySourceLine(a, b),
    today: (a, b) => (a.dueState === 'today' ? 0 : 1) - (b.dueState === 'today' ? 0 : 1) || bySourceLine(a, b),
    upcoming: (a, b) => soonest(a).localeCompare(soonest(b)) || bySourceLine(a, b),
    done: (a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity) || bySourceLine(a, b),
  };
  for (const group of groups.values()) group.todos.sort(withinSection[group.key] ?? bySourceLine);

  return [...groups.values()].sort((a, b) => {
    const ra = a.kind === 'backlog' ? SECTION_RANK.backlog : SECTION_RANK[a.key];
    const rb = b.kind === 'backlog' ? SECTION_RANK.backlog : SECTION_RANK[b.key];
    if (ra !== rb) return ra - rb;
    if (a.kind !== 'backlog') return 0; // horizons and DONE are already unique
    if ((a.key === UNASSIGNED) !== (b.key === UNASSIGNED)) return a.key === UNASSIGNED ? 1 : -1;
    return b.open - a.open || a.label.localeCompare(b.label);
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

function printSummary(state) {
  const { stats: s, health: h } = state;
  const out = [
    `VAULT-HUD  ${state.today} ${state.todayLabel}  ${state.vaultPath}`,
    `${pad2(s.open)} OPEN · ${pad2(s.stale)} STALE · ${pad2(s.dueToday)} DUE · ` +
      `${pad2(s.overdue)} OVERDUE · ${pad2(s.doneToday)} DONE TODAY`,
    `FOCUS  ${state.focus ? [state.focus.label, state.focus.detail].filter(Boolean).join(' — ') : '—'}`,
    '',
  ];
  for (const g of state.groups) {
    out.push(`▸ ${g.label.padEnd(28)} ${pad2(g.open)} open  ${pad2(g.done)} done`);
    for (const t of g.todos) {
      const flags = [
        t.due && `due ${t.due} (${t.dueState})`,
        t.ageDays >= 1 && `${t.ageDays}d old`,
        t.scheduled && 'scheduled',
      ].filter(Boolean).join(', ');
      out.push(`   ${t.done ? '☑' : '☐'} ${t.text.slice(0, 70)}${flags ? `   [${flags}]` : ''}`);
    }
  }
  out.push('', `ROLLED OVER  ${state.rolledOver.length}`);
  for (const t of state.rolledOver) out.push(`   ${t.ageDays}d  ${t.text.slice(0, 66)}`);
  out.push('', `DECISIONS  ${state.decisions.length} of the most recent`);
  for (const d of state.decisions) out.push(`   [${d.date}] ${d.source}`);
  out.push('', `HEALTH  ${h.notes} notes · ${h.links} links · ${state.graph.edges.length} edges · ` +
    `${h.inbox.count} inbox (oldest ${h.inbox.oldestDays}d) · ${h.orphans} orphans · ` +
    `${h.stale30} stale30 · ${h.broken.length} broken`);
  for (const b of h.broken) out.push(`   ✕ ${b.source} → [[${b.link}]]`);
  if (state.warnings.length) {
    out.push('', 'WARNINGS');
    for (const w of state.warnings) out.push(`   ! ${w}`);
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vaultPath = process.env.VAULT_HUD_VAULT ?? path.join(homedir(), 'Obsidian', 'vault');
  const state = await parseVault(vaultPath);
  process.stdout.write(process.argv.includes('--json')
    ? `${JSON.stringify(state, null, 2)}\n`
    : `${printSummary(state)}\n`);
}
