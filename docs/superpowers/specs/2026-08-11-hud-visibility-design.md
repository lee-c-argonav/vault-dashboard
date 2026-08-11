# HUD visibility — design

Date: 2026-08-11
Status: approved in outline, revised after three independent reviews

Paths are written as `$VAULT_HUD_VAULT` and `$HOME`. Project and person names are
omitted. This repository is public.

Revision note: the first draft of this document was reviewed on feasibility,
completeness and risk. Six of its mechanisms were falsified against the machine
and are replaced below. Where a first-draft rule was wrong, the correct rule is
stated with the measurement that settled it.

## Problem

Every figure was measured on 2026-08-11.

**Most sessions say nothing.** Three agent processes were alive. One had a run
file and rendered as a full row. Two rendered as a path and an uptime with the
tag `NO STATUS`. During the design session a fourth case arrived unprompted: a
2h11m session's run file was archived by its own close routine, and that session
dropped from a full row to a bare `NO STATUS` line with 27 sub-agent transcripts
on disk, unread.

**Declared fan-out was wrong by the whole quantity.** One run file declared 8
sub-agents on its third unit, 7 of them `running` at 22m and climbing. The
filesystem held 27 sub-agent transcripts for that session, and all 27 had
returned. The board showed 7 running when none was running.

**A unit rendered as not started after its agent had finished.** Its sub-agent
was dispatched at 14:30:52Z and returned at 14:41:45Z reporting completion. The
unit still rendered `todo`, with a dot at 1.44:1.

**Declared timestamps drifted from the clock.** One run file's `updated` read
`16:05Z`, then `17:12Z` forty minutes later, against a wall clock of `15:11Z` —
120 minutes ahead. Liveness is measured from file mtime, so QUIET survived.
Figures derived from `updated` did not.

**The encoding does not carry its own meaning.** Against `--bg #08090A`:

| element | ratio | consequence |
|---|---|---|
| todo dot `#2A2D33` | 1.44:1 | not visibly rendered |
| running orange vs blocked amber | 1.44:1 | the state most worth catching changes least |
| done time grey vs running time orange | 1.60:1 | the duration column changes tense silently |
| done dot vs running dot | 2.42:1 | the only separator between finished and live work |
| done label vs running label | identical `--bone` | finished work is as loud as live work |

State names exist only in `title` tooltips (`public/app.js:259`, `:272`), which
need a hover and do not render on the phone.

**The hierarchy states a distinction that is not real.** Two sections carry three
vocabularies for one idea: the section header says `NOT REPORTING`, its counter
says `SESSIONS`, the row tag says `NO STATUS`. The same slot holds `machine` on a
run row (`public/app.js:319`) and a relative path on a session row
(`public/runs-view.js:235`). `QUIET` means "has no run file" in the panel counter
(`public/app.js:436`) and "has not written in N minutes" on a run row
(`public/runs-view.js:430`).

## The model

There is one object: a **session**. Every live agent process is one row. What
varies is how much is known, and every layer is read from disk without the
agent's cooperation.

| layer | source | yields |
|---|---|---|
| 0 process | `ps` + `lsof`, today's `sessions.js` | exists, where, uptime |
| 1 identity | `$HOME/.claude/sessions/<pid>.json` | session id, cwd, start, version, name, busy/idle |
| 2 transcript | `<slug>/<sessionId>.jsonl` | activity, branch, needs-you |
| 3 sub-agents | `<slug>/<sessionId>/subagents/` | count, per-agent label, started, last moved, state |
| 4 run file | `$VAULT_HUD_VAULT/15-Runs/<id>.json` | goal, unit plan, needsInput, blockers |

Layer 4 is the only declared layer. It is reduced to what cannot be observed:
what the work is for, and how the operator wants it broken up.

### The join

The first draft did not say how a pid reaches a transcript, and the obvious rules
are all wrong. Measured: the process holds no descriptor on its transcript
(`lsof` returns nothing); two live processes currently share one cwd; a slug
directory holds 37 and 60 historical transcripts; and a resumed session attaches
a new process to an old file.

`$HOME/.claude/sessions/<pid>.json` is the join, written by the process itself.
Three files existed for exactly three live pids, each carrying `sessionId`,
`cwd`, `procStart`, `version`, a derived `name`, and `status`.

Rules:

1. Read `$HOME/.claude/sessions/<pid>.json` for each pid `sessions.js` found.
2. Reject unless its `cwd` equals the cwd `lsof` reported for that pid. This
   guards pid reuse and a stale file, and makes a wrong read harmless.
3. `procStart` is rendered in **UTC**; `ps lstart`, parsed at `sessions.js:84`,
   is rendered in **local time**. Both are parsed to epoch milliseconds before
   comparison, tolerance 5s. A string or naive `Date.parse` comparison is wrong
   by the UTC offset.
4. On any rejection or missing file, the row stays at layer 0. There is no
   fallback guess. This matches `linkSessions`, which leaves a session unclaimed
   rather than assert a pairing it cannot support.
5. The transcript is `<slug>/<sessionId>.jsonl`, where `<slug>` is the cwd with
   every non-alphanumeric character replaced by `-`. If that directory does not
   exist, locate the file by `sessionId`, which is a UUID and unique. **The slug
   is an absolute path in a form no `/` search will catch, and must never leave
   the module.** `SPEC.md` already forbids an absolute path reaching State.

## Stage 1 — encoding

Scope corrected after review. The first draft put the merged single list here and
claimed it shipped standalone. It does not: the row's activity slot has no source
in today's `/api/state`, so the merged list moves to stage 2. Stage 1 is the
visual language only, and does ship standalone.

### 1.1 Tokens

The palette is duplicated between `public/hud.css:3-24` and
`status-page/build.js:150-187`. They are not identical and the divergence is
deliberate: `--dim` is `#6E7175` on the desktop and `#8B8F95` on the phone, and
the phone carries a light-mode palette the desktop has none of.
`status-page/status.html` is generated by `build.js` and gitignored — there are
two sources, not three.

So the shared file carries four palettes plus a desktop-only layout block. It is
a real CSS file at `public/tokens.css`, linked from `index.html` before
`hud.css`, and read by `build.js` at build time and prepended inside its
`<style>` element. CSP is not involved: `style-src 'unsafe-inline'` already
permits the inline style, and nothing is fetched at runtime.

The read must be wrapped. `publish.js` imports `build.js` and `server.js` imports
`publish.js`, so a bare top-level read that throws would kill the daemon during
module evaluation, before the error handler is installed. It falls back to the
current inline string.

A JS module exporting tokens does not work, because `hud.css` cannot import it,
and generating `hud.css` contradicts the no-build-step rule.

### 1.2 Encoding

Brightness carries attention, hue carries state, shape carries severity.

| change | from | to | reason |
|---|---|---|---|
| todo dot | `#2A2D33` filled | `--dim` 1px hollow | 1.44:1 to 4.06:1 desktop, 6.13:1 phone dark |
| done label | `--bone` | `--dim` | finished work stops competing with live work |
| blocked label | `--dim` | `--amber` | blocked is not a recessive state |
| blocked mark | amber square | amber triangle via `clip-path` | orange/amber is 1.44:1; shape survives it |
| running duration | `47m` | `+47m` | one character marks the tense, survives monochrome |
| sub-agent label | `--dim` always | `--bone` open, `--dim` returned | today a 4px dot is the only separator |

The triangle is a `clip-path` on the existing 6px box in both renderers. The
`ic-triangle` sprite symbol is desktop-only and every phone mark is a CSS box, so
the sprite settles nothing.

Contrast is asserted as a matrix of surface × theme, not one number per element,
because `--dim` differs across surfaces and the phone has a light mode.

### 1.3 Legend

Five glyphs and their words. The five are the **unit** states — `todo, running,
done, blocked, failed` (`runs.js:11`) — not the run states, because 1.2 changes
unit marks. The panel header has no reserved space for it: `.phead` is a 26px
flex row whose counter is already `white-space: nowrap` and can read `05 RUNS ·
02 QUIET · 01 NEEDS YOU`, with no `overflow` rule and nothing to clip. The legend
gets its own row beneath the header, not a slot inside it.

### 1.4 Counter vocabulary

`QUIET` in the panel counter becomes `SILENT`, so the word keeps one meaning. The
run-row `QUIET` is unchanged.

## Stage 2 — observed state and the merged list

### 2.1 `transcripts.js`

Read-only. No absolute path, slug, prompt text or tool argument leaves the
module.

**Degradation is per file, not per module.** `sessions.js` wraps its whole body
in one `try/catch` because its two subprocess calls are all-or-nothing. This
module performs roughly 60 file reads, and one unreadable file must cost one row.
Explicit handling for `ENOENT`, `EACCES`, `EISDIR` and `ELOOP`, plus a read
timeout, since no timeout exists anywhere in the module today.

**Reading.** Constants, all previously left as words:

| constant | value | basis |
|---|---|---|
| `TAIL_BYTES` | 64 KB | first read window |
| `TAIL_MAX_BYTES` | 1 MB | grow ×4 when the window holds no complete line; largest observed single line is 907,522 bytes |
| `HEAD_BYTES` | n/a | removed; see labels |
| `SUBAGENT_CAP` | 64 | newest by mtime; the excess is reported on screen, never dropped silently |
| `CACHE_MS` | 2,000 | below the 5,000 in `sessions.js` so a new tool call lands on the next parse |
| `AGENT_STALE_MS` | 600,000 | an `open` sub-agent that has not moved becomes `stalled` |
| `STAMP_TOLERANCE_MS` | 60,000 | matches `STAMP_LAG_TOLERANCE_MS` |

**The leading fragment of a tail read is discarded unconditionally.** A 64KB tail
almost always begins mid-line. Without this rule `JSON.parse` throws on nearly
every session and, under the never-throw posture, every session silently degrades
to layer 0. One bad line is skipped; the rest of the window is used.

The cache key is `(path, mtime, size)`. The directory listing is cached
separately on the directory's own mtime, because the file key cannot express
which files exist.

**Session status.** Revised again during implementation, because the mechanism
this section previously specified does not exist.

*What was specified and is impossible.* A `tool` state and a `needs-you` state
derived from an unresolved `tool_use` at the tail. The entry is not written
before the tool runs. Measured directly: while a Bash tool of the implementing
session was executing, that session's own transcript held **zero** unresolved
`tool_use` entries, and a 12-second sampler over a second busy session caught
none either. The assistant message carrying a tool call is flushed with its
result, not before it. So "which tool is it in right now" is not on disk. Neither
is "is it blocked on a permission prompt": the pid file carries `busy` and `idle`
and nothing else, and a slow command and a pending prompt are indistinguishable.

*What is observable, and is used instead:*

- `idle` — the pid file says `idle`. Actionable on its own: nothing will happen
  in that session until the operator types.
- `stalled` — the pid file says `busy` and the transcript has not grown for
  `SESSION_STALE_MS`. A process claiming to work while writing nothing.
- `working` — `busy`, and writing.

`lastTool` is the most recent tool the session used, and the row says *last*
rather than *current*, because that is the only honest reading of a call that
reaches disk with its result. `heldMs` comes from `statusUpdatedAt` and makes
"busy for forty minutes and silent" expressible without inferring anything.

NEEDS YOU stays what it already was: the run file's declared `needsInput`. That
is the only trustworthy source for it, it is already the loudest thing on both
surfaces, and a state that fires when nothing is waiting costs the board its
credibility.

**Kimi sessions stay at layer 0.** `sessions.js` discovers `claude` and `kimi`
alike because the standard binds both. Only one of them writes a pid file, so a
Kimi session gets a path and an uptime and no observed detail. Verified live: 4
of 5 sessions joined, the fifth being Kimi.

Entries are scanned **backwards for the last message-bearing entry**. Transcripts
end with untimestamped records of several types, and `gitBranch` is absent on
some of them.

**`branch`** renders only when `gitBranch` is a branch. `HEAD` (detached) and an
absent field both render nothing rather than a meaningless value.

### 2.2 Sub-agents

**Labels come from `agent-<id>.meta.json`**, a 129-175 byte sidecar beside every
sub-agent transcript carrying `agentType`, a human-written `description`,
`toolUseId`, `spawnDepth` and, when nested, `parentAgentId`. The first draft read
the dispatch prompt instead. That was wrong three ways, all measured: 27 of 27
prompts begin with an absolute path, so any prefix truncation preserves the leak
rather than redacting it; 19 of 27 first lines exceed 4KB, so the proposed read
truncates the JSON and throws; and the text is a multi-kilobyte paragraph, not a
row label. **No prompt text is read at all**, which removes the largest privacy
surface in this design.

**`returned` is "the last message-bearing entry contains no `tool_use` block".**
The first draft required `stop_reason: end_turn`. Measured across 27 sub-agent
transcripts: the last entry is an assistant message in 27 of 27; `stop_reason` is
`end_turn` in 20 and **null in 7**; a `tool_use` block appears in the last entry
in 0 of 27. The first-draft rule reports those 7 as open forever, which restates
the defect this design exists to remove. `stop_reason` also takes the value
`tool_use` on live entries, so it is usable for detecting `waiting` and not for
detecting `returned`.

An `open` sub-agent whose file has not moved for `AGENT_STALE_MS` renders
`stalled`. A sub-agent whose parent process is gone is not live whatever its file
says.

`spawnDepth` exists and reaches at least 2 on this machine, so nested agents nest
under their `parentAgentId` rather than flattening into one count.

**Fan-out is session-scoped, and moves to the row.** Nothing on disk maps a
sub-agent to a unit: the sidecar carries `toolUseId` and no unit id. Today all
four render sites are unit-scoped (`app.js:268`, `:286`, `build.js:341`, and the
cluster in `runs-view.js`). Observed fan-out therefore renders at row level. The
first draft said observed agents "take precedence" over declared ones; that is
not executable, because the two live at different levels of the tree.

### 2.3 The merged list

One list, one row type, rows grow taller as more is known. `NOT REPORTING`
disappears as a section.

Slots by layer, with every previously undefined slot now assigned:

| slot | L0 | L1-2 | L3 | L4 |
|---|---|---|---|---|
| state mark | hollow, `unknown` | working / idle / tool / needs-you | unchanged | run state wins the mark |
| label | `name` from the pid file | same | same | `goal` |
| where | relative path (desktop only) | branch when meaningful | — | `machine` |
| activity | empty | tool name, or last prompt when idle | `N out, M stalled` | unit label |
| elapsed | uptime | last moved | oldest agent | run elapsed |

**Precedence.** A row with both a run file and a session shows the run state on
the mark. The session status renders beside it when the two disagree, because a
run reading `RUNNING` whose session has been at one tool call for 40 minutes is
the case this whole design is about.

**Ordering.** `URGENCY` (`runs-view.js:519`) ranks the five run states 0-4 and
has no rank for the session states, and `undefined - undefined` is `NaN`, which
makes the sort depend on input order. One rank function covers the merged set:
`needs-you` before `blocked` before `stalled` before `running`/`tool` before
`working` before `idle` before `done`. Tiebreak on last-moved, then pid. Repo
grouping survives, and sessions join it by `project`. `expandSet` ranks
session-only rows by the same function.

**Click target.** A row with a run and a session keeps both actions: the row
opens the terminal by pid, matching today's session behaviour, because that is
what the operator wants from a row that is running.

**`rowSignature`.** Every new field enters it, and `movedAt` is bucketed. The
comment at `runs-view.js:446` records a unit timer frozen at "running 5m" for
nineteen minutes because a clock-derived string was missing from the signature;
an unbucketed `movedAt` causes the opposite defect, rebuilding the row on every
parse and destroying text selection. Bucket: 30s.

**`sessionContext`** (`runs-view.js:271`) is kept and narrowed. Layer 2 answers
"what is it doing" better from the transcript, but `sessionContext` carries the
*goal sentence* of a finished run, which no transcript yields. It becomes the
goal-recall line only. It must also read the archive: today `parse.js` feeds it
`15-Runs` alone, which is why a session whose run was archived mid-run loses its
goal entirely.

### 2.4 Parse path and watcher

The second watcher needs four things the first draft did not state.

1. **Its own predicate.** `server.js:377` accepts only `.md` and `.json`;
   `'x.jsonl'.endsWith('.json')` is false, and `server.js:372` rejects any path
   segment starting with `.`, which `$HOME/.claude` is. A measured 40s watch on
   the transcripts root produced 6 events, all `.jsonl`, all of which the current
   predicate discards.
2. **Its own restart state.** `watcher`, `retryDelay` and `retryTimer` are
   singular, and `scheduleWatcherRestart` returns early when a retry is pending,
   so an error on one watcher tears down the other. `shutdown()` closes one.
3. **A debounce max-wait.** `scheduleRefresh` clears and resets its timer, and
   `SAFETY_REFRESH_MS` is routed through the same function, so the safety net
   participates in the coalescing rather than breaking it. Measured on the
   busiest session: 290 entries in one minute, median gap 0.315s, and 40% of gaps
   below the 150ms debounce. `DEBOUNCE_MAX_MS` of 1,000 fires regardless of
   continuing events, and `SAFETY_REFRESH_MS` routes to `refresh()` directly.
4. **A partial refresh.** A transcript event must not re-walk the vault.
   `refresh()` is all-or-nothing today, measured at 110ms cold and 17ms warm plus
   a 149KB SSE broadcast per push. At the observed fan-out rate that is roughly
   three full vault parses per second driven by files the vault parse never
   reads. Transcript-derived fields are merged into the last State and broadcast
   without a re-parse.

Fd cost is not a concern: macOS uses one FSEvents stream, and a recursive watch
over the 5,985-file tree added zero descriptors.

### 2.5 Run-file contract

`units[].agents` is no longer written. Fan-out comes from disk.

**`agents: []` stays in the normalised shape.** `status-page/build.js:135`
dereferences `u.agents` with no guard, and it is safe today only because
`runs.js:27` normalises it. Removing the field makes `boardDigest` throw,
`publish.js:102` catches it and returns false, and the publisher stops deploying
while reporting a caught error — the silent stale board this repo already
documents. A run file written elsewhere that still carries agents keeps parsing,
and renders when no observed fan-out exists for that session.

Standards to change: `60-Standards/run-status.md`, `15-Runs/README.md`,
`60-Standards/orchestrated-agent-runs.md`, `60-Standards/agent-behavior-defaults.md`.
The first draft named two of the four.

### 2.6 Stamp health

`stampLagMs` (`runs-view.js:60`) detects `updated` **behind** the file write and
returns 0 when the sign reverses, so it is blind to the 120-minute case in the
problem statement. The check is extended to both directions and rendered in the
**existing** `STAMPS` chip segment, not a new one: `build.js:228` records a chip
string overflowing a 320px screen by 163px and putting a sideways scrollbar on
the page, a regression already fixed once. One segment, two directions.

Layer 2 and 3 timestamps mix a written clock (`timestamp` in JSON) with a
filesystem clock (mtime). Elapsed figures are computed from one clock only —
mtime — and a written stamp that disagrees with mtime beyond tolerance is
reported rather than used.

## Stage 3 — publication

### 3.1 Projection

There is no serialization seam today. `build.js` renders from the same in-memory
objects the desktop uses, and what reaches the page is decided by hand-written
template literals. Every field this design adds is one keystroke from an
unauthenticated URL.

A pure `toPublicBoard()` projection with an explicit field allowlist sits between
`readBoard()` and `build()`. `build()` never holds an object carrying a branch,
a prompt, a tool name, a slug or a path. `boardDigest` is computed over the
projection, which makes "the volatile set and the privacy set are the same cut" a
property of one function rather than a claim in prose.

**The existing privacy test cannot fail.** `test/publish.test.js:198` injects a
session with `where: ''` and asserts the output contains no home-directory
prefix. It asserts
that a fixture with no path yields no path. Its replacement seeds a board with a
real relative path, a real branch name and a real sidecar description, and
asserts none appear in the HTML.

**A relative path reaches the published page today.** `sessionText`
(`runs-view.js:235`) renders `where`, and `build.js:425` emits it. One live value
is a directory named after a confidential project codename, published to an
unauthenticated URL. The projection removes the path from the phone. A
session-only row on the phone carries state, counts and timers, and no location.
This is a reduction in what the phone shows, and it is what the tiered boundary
means once the paths themselves are confidential.

### 3.2 Cadence

The phone carries the coarse layer, bucketed so it cannot both be shown and be
stale. `silence()` (`build.js:104`) already establishes the pattern with a
30-minute bucket for a clock-derived value; the agents-out count and
silent-for-N-minutes enter the digest on a 5-minute bucket. A field that is on
the page and out of the digest is a field the page can show wrong indefinitely.

Cadence changes, with the arithmetic stated:

- `PUBLISH_MS` 5 minutes to 60 seconds, which is 1,440 ticks a day against 288
  today. The digest suppresses most of them.
- **A minimum interval between deploys**, independent of the tick, so a fast tick
  cannot become a fast deploy rate. The overlap guard at `publish.js:69` assumes
  "the tick is five minutes, so this should never fire", and `DEPLOY_TIMEOUT_MS`
  is 4 minutes; at a 60s tick, skipping becomes routine and one hung upload costs
  four consecutive ticks.
- The meta refresh at `build.js:507` and the footer string at `build.js:530` both
  say 2 minutes and must change together, or the page states a cadence it does
  not have.

**Open, and to be answered before this stage is built:** the account's actual
deploy quota. The Hobby plan caps deployments at 100/day; the scope lives in a
gitignored file and was not read. The minimum-interval limiter is sized from that
number.

## Precondition — the pre-push gate

Not part of this feature, and it blocks committing it.

`scripts/check-no-secrets.sh:94` scans the tracked tree with `git grep -nIiE`.
Git's ERE does not implement `\b`. Measured:

```
git grep -nIiE '\bsessions\b'            → 0 hits
git grep -nIiE 'sessions'                → 1 hit
/usr/bin/grep -IiE '\bsessions\b'        → 1 hit
git grep -nIiE '[[:<:]]sessions[[:>:]]'  → 1 hit
```

Four patterns in `.confidential-patterns` are written with `\b` and are therefore
never enforced on files: the firm name, the product codename, the owner's first
name, and the teammate list. Commit messages and identities are scanned through
`/usr/bin/grep` and do work.

Nothing has leaked: all four patterns return zero hits against the committed tree
when run with a working engine.

Fix: convert every `\b` to `[[:<:]]`/`[[:>:]]`, and add a self-test asserting a
known confidential string is caught by the tree scan. Check
`.confidential-patterns.example`, which is tracked and public, for the same
idiom.

## Not built

- Per-number provenance glyphs. Replaced by 2.6.
- Context burn, model and effort on rows.
- Any new infrastructure: no function, no token, no CSP change, no tunnel, no
  dependency.
- Sub-second phone updates, ruled out by static hosting.
- Reading any prompt text, at any layer, for any purpose.

## Testing

Baseline is 188 tests passing in 183ms.

- `transcripts.js` parser units against fixtures, plus degradation: missing
  directory, unreadable file, `EACCES`, `EISDIR`, a tail window containing no
  complete line, a leading partial line, an empty file, a file that grows between
  `stat` and read, and a 1MB single line.
- The join: a pid file whose `cwd` disagrees, a missing pid file, a `procStart`
  in the other timezone rendering, and two live pids sharing a cwd.
- `returned` detection against all three observed shapes: `end_turn`, `null`
  `stop_reason`, and a live entry with `stop_reason: tool_use`.
- Contrast as a surface × theme matrix parsed from `public/tokens.css`.
- A digest test proving a bucketed volatile field does not move the digest within
  its bucket and does move it across one.
- A privacy test seeded with a real relative path, branch and sidecar
  description, asserting none reach the HTML.
- A pre-push gate self-test asserting the tree scan catches a planted string.
- Existing run files and archived runs still render.

## Risks

**The transcript format is not a public contract.** Two live sessions were
running different CLI versions at the same moment, so the format can differ
concurrently rather than only across upgrades. Every field read is optional and a
missing or renamed field degrades that row one layer rather than throwing. This
extends to the pid file and the sidecar, both equally undocumented.

**mtime is not monotonic.** A restore, a sync or a copy gives a returned agent a
fresh mtime and it renders as having just moved. Accepted; no cheap defence
exists, and the failure is a stale-looking row rather than a false alarm.

**Two renderers can drift.** 1.1 reduces this to the token file; the markup still
exists twice, and the encoding test runs against both.
