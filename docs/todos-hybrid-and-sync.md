# TODOS panel — hybrid date/project grouping + sync-freshness fix

Status: approved design, 2026-07-24. Phase 1 = redesign + sync fix; Phase 2 = full
component review.

All examples below use synthetic project/task names. This is a public repo — never
put real vault content, project names, or paths in this file.

## Problem

The left `TODOS` panel groups every checkbox in the vault by **project**. Two
consequences:

1. **Not clear / not by date.** A todo written in today's daily note, a checkbox
   buried in a standards doc, and a future-scheduled item all sit in the same
   project bucket. Date signals (`due`, `ageDays`, `scheduled`) exist per row but
   only as small chips — never used to organize. There is no "what's my day" view.
   Most daily-note todos have no project link, so they pile into one large
   `UNASSIGNED` group.
2. **Genuinely stale.** Freshness relies solely on `fs.watch(VAULT, {recursive})`.
   There is no periodic re-parse. macOS drops FSEvents when the vault lives on
   iCloud/Dropbox or when the editor writes via atomic temp-swap; a dropped event
   leaves the panel stale until the next fs event or midnight.

## Phase 1a — hybrid grouping

Top-level sections are **time horizons**; project grouping is kept where undated
work actually lives (the backlog). Project stays visible as a row chip on dated
items.

```
TODOS                         30 OPEN
──────────────────────────────────────
▾ OVERDUE                          03
   ▪ Ship parser fix   PROJECT-A  02D
   ▪ Reply re contract PROJECT-B  05D
▾ TODAY                            04
   ▪ Draft the memo    PROJECT-B
   ▪ Review PR #12     PROJECT-A  DUE
   ▪ Call the vendor              DUE
▾ UPCOMING                         02
   ▪ Prep the deck     PROJECT-B  07-27
▾ PROJECT-A                        05   ← backlog, by project
   ▪ refactor the parser
▾ PROJECT-B                        03
   ▪ draft the ontology
▾ UNASSIGNED                       02
   ▪ misc undated checkbox
▸ DONE                             28   ← collapsed by default
```

### Bucket assignment (per open todo, first match wins)

Explicit due date dominates daily-note age: an item written days ago but due in the
future is UPCOMING, not OVERDUE.

1. `dueState === 'overdue'`            → **OVERDUE**
2. `dueState === 'today'`              → **TODAY**
3. `dueState === 'future'`             → **UPCOMING**
4. `scheduled` (future daily note)     → **UPCOMING**
5. `ageDays >= 1` (rolled from a past daily note, no due) → **OVERDUE** ("behind")
6. `ageDays === 0` (today's daily note, no due)          → **TODAY**
7. otherwise (`ageDays === null`, undated project/doc checkbox) → **BACKLOG**,
   sub-bucketed by `project` (`UNASSIGNED` last)

Completed todos (`done`) → a single **DONE** group, collapsed by default.

### Ordering

- Sections emitted in order: OVERDUE, TODAY, UPCOMING, then backlog project groups
  (open desc, `UNASSIGNED` last), then DONE. Empty sections are not emitted.
- Within **OVERDUE**: most-behind first (`days-overdue` for due items, else
  `ageDays`), desc.
- Within **TODAY**: explicit due-today first, then today's-note items.
- Within **UPCOMING**: soonest first (explicit due date, else scheduled note date).
- Within a **backlog** project: source path then line (unchanged).
- Within **DONE**: most recent first.

### Decisions (baked in; reversible)

- Rolled-over daily items live under **OVERDUE**, not a separate bucket — "carried
  over" and "past due" both mean *this is behind*; the row chip says which. Keeps
  the list to four live sections.
- The bottom **ROLLED OVER** panel stays as the age-sorted deep view of the same
  items. (Kill later if it reads as redundant.)
- Backlog is rendered as its own project-headed sections (reusing the existing
  group-header rendering), preceded by a `BACKLOG` divider so the time→project
  shift is legible.

### Contract preserved

Each group keeps `{key, label, kind, obsidian, open, done, todos}`. `kind ∈
{horizon, backlog, done}` drives styling only. Consumers that read
`state.groups.flatMap(g => g.todos)` (LOAD gauge, HERO) and the top `stats` numbers
are untouched, because every todo still appears in exactly one group and `stats` is
computed independently of grouping.

## Phase 1b — sync-freshness floor

Add a periodic safety re-parse in `server.js` as a floor under the watcher:

- `SAFETY_REFRESH_MS = 10_000`; `setInterval` calls the existing debounced
  `scheduleRefresh()`; `.unref()`; cleared in `shutdown()`.
- Watcher stays for sub-second updates; the interval only catches dropped events.
  Worst-case staleness becomes ~10s instead of unbounded.
- No client change needed: SSE already re-seeds `currentJson` on (re)connect, and
  the server now converges within 10s regardless of missed fs events.

## Files touched

- `parse.js` — rewrite `buildGroups` (bucket assignment + ordering). Self-contained.
- `public/app.js` — `renderTodos`: render `kind`-aware headers, `BACKLOG` divider,
  DONE collapsed-by-default, project chip on dated rows; move authoritative sort
  into `buildGroups`.
- `public/hud.css` — header styling per `kind`; divider; project chip.
- `server.js` — safety-refresh interval.

## Phase 2 — component review (verify each derives right and renders)

- Header numbers: OPEN / STALE / DUE / OVER / DONE vs the vault.
- LOAD gauge (one tick per open todo; due/stale/sched coloring).
- Vitals: CPU / GPU / MEM / BAT (present, plausible, degrade cleanly).
- FOCUS (today's focus line + source), HERO (the one-number logic).
- LATTICE graph (nodes/edges/orphans, interaction).
- DECISIONS, ROLLED OVER, INTEGRITY (orphans/broken/stale30/inbox).
- Footer: sync time, vault path, link/BOOT lamp state.

## Non-goals

- No new dependencies (repo is zero-dep by charter).
- No writes to the vault (read-only by charter).
- No incremental/mtime-diff parsing — the whole-vault parse is a few ms; a plain
  interval is the simplest floor.
