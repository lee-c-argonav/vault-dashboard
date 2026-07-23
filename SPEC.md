# vault-hud — spec

## Purpose

A read-only instrument panel for an Obsidian vault (`$VAULT_HUD_VAULT`).
One always-open app window, next to the Claude Code terminal, that answers two
questions at a glance:

1. **What is on me right now** — today's focus, open todos grouped by project,
   what rolled over and is going stale, what is due.
2. **Is the vault healthy** — unprocessed inbox, orphan notes, stale notes,
   broken wikilinks.

Plus a force-directed graph of the 46 notes and their 104 wikilinks.

The window is **read-only**. All writing still happens in Claude Code. The
dashboard updates itself the instant a file changes; the user never touches it.

## Non-goals

No editing. No writing to the vault, ever. No auth. No build step. No framework.
No charting library. No database. No config UI. **Zero npm dependencies** — Node
built-ins only. If a feature needs `npm install`, it is out of scope.

## Architecture

```
  vault ($VAULT_HUD_VAULT)
        │  fs.watch(recursive) → 150ms debounce
        ▼
  parse.js          markdown → State (pure, no I/O beyond reading)
        │
        ▼
  server.js         127.0.0.1:5959
        ├── GET /              → public/index.html
        ├── GET /api/state     → State as JSON
        └── GET /events        → SSE, pushes State on every change
        │
        ▼
  public/app.js     renders State, repaints on SSE, draws the graph
```

Launchd (`local.vault-hud`) starts the server at login with
`RunAtLoad` + `KeepAlive`. The user opens the installed PWA window and it is
already live.

### Files

```
server.js                 http + SSE + fs.watch
parse.js                  markdown → State
metrics.js                machine vitals, sampled on a timer
public/index.html         layout shell
public/hud.css            theme
public/app.js             render + SSE client + canvas force graph
public/manifest.webmanifest
public/sw.js              pass-through, exists only to satisfy PWA install
public/icon-192.png
public/icon-512.png
tools/make-icons.js       one-time icon generation (pure Node, zlib)
launchd/local.vault-hud.plist
docs/fixture.json         real parsed State, committed, for frontend work
```

## Safety

- The server opens files **read-only**. It never calls `writeFile`, `unlink`,
  `rename`, or `mkdir` against the vault.
- Binds `127.0.0.1` only. No external interface, no CORS headers.
- Static file serving is confined to `public/` with path traversal rejected.
- Vault path comes from `VAULT_HUD_VAULT` (default
  `$VAULT_HUD_VAULT`). Port from `VAULT_HUD_PORT` (default `5959`).
  Static root from `VAULT_HUD_PUBLIC` (default `./public`, resolved against the
  repo root so `VAULT_HUD_PUBLIC=candidates/b` works from any cwd).

## Scanning scope

**Included:** `00-Inbox`, `10-Projects`, `20-Research`, `30-Reading`, `40-Daily`,
`50-People`, `60-Standards`, `70-Memory`, and `*.md` at the vault root.

**Excluded:** `99-Archive`, `_to_delete`, `.agents`, `.obsidian`, `.git`,
`node_modules`, and any dotfile directory.

**Before extracting anything**, each file is preprocessed:

1. Fenced code blocks (``` and ~~~) are removed. This is what stops the empty
   `- [ ]` in `70-Memory/repo-claude-md-snippet.md` and the templates inside
   `CLAUDE.md` from being counted as real todos.
2. Indented-4-space code blocks are left alone (the vault does not use them).

## The State object

The single contract between `parse.js`, `server.js`, and `app.js`.

```jsonc
{
  "generatedAt": "2026-07-22T14:03:11.412Z",   // ISO, server clock
  "today": "2026-07-22",                        // local date
  "todayLabel": "WED",                          // 3-letter uppercase weekday
  "vaultPath": "$VAULT_HUD_VAULT",
  "vaultName": "your-vault",

  "stats": {
    "open": 24,        // open todos in scope
    "stale": 2,        // open todos in a daily note dated before today
    "dueToday": 1,     // open todos whose due date === today
    "overdue": 0,      // open todos whose due date < today
    "doneToday": 1     // "- [x]" lines in today's daily note
  },

  // Kept split rather than joined: the client sets the label as an eyebrow over
  // the detail, and re-splitting a joined string is guesswork once the label
  // itself contains an em dash. `null` when today's note has no lead line.
  "focus": { "label": "Morning focus — Project X", "detail": "Get the main structure…" },

  "groups": [
    {
      "key": "project-x",                 // slug
      "label": "PROJECT-X",               // uppercase display
      "kind": "project",             // "project" | "daily" | "unassigned"
      "obsidian": "obsidian://open?vault=your-vault&file=10-Projects%2Fproject-x",
      "open": 7, "done": 0,
      "todos": [ /* Todo */ ]
    }
  ],

  "rolledOver": [ /* Todo, ageDays >= 1, sorted ageDays desc */ ],

  "decisions": [
    { "date": "2026-07-22", "html": "Work the <code>project-x</code> repo from…",
      "source": "40-Daily/2026-07-22.md", "obsidian": "obsidian://…" }
  ],

  "graph": {
    "nodes": [
      { "id": "10-Projects/project-x", "label": "project-x", "folder": "10-Projects",
        "inbound": 6, "outbound": 9, "orphan": false, "todos": 7,
        "obsidian": "obsidian://…" }
    ],
    "edges": [ { "source": "40-Daily/2026-07-22", "target": "10-Projects/argo" } ]
  },

  "health": {
    "notes": 46,
    "links": 104,
    "inbox": { "count": 2, "oldestDays": 1 },
    "orphans": 6,
    "stale30": 11,                    // mtime older than 30 days
    "broken": [ { "source": "40-Daily/2026-07-22", "link": "argo-meet" } ]
  },

  "warnings": []    // non-fatal parse notes, rendered as a dim strip if non-empty
}
```

### Todo

```jsonc
{
  "id": "40-Daily/2026-07-22.md:23",
  "text": "Think through user roles and permissions in `argo` …",  // raw inline md
  "html": "Think through user roles and permissions in <code>argo</code> …",
  "done": false,
  "source": "40-Daily/2026-07-22.md",
  "line": 23,
  "section": "Todos",              // nearest preceding "## " heading
  "project": "argo",               // slug or null
  "due": "2026-07-27",             // ISO or null
  "dueState": "future",            // "overdue" | "today" | "future" | null
  "ageDays": 0,                    // today − daily-note date; null outside 40-Daily
  "scheduled": false,              // lives in a future-dated daily note
  "links": ["argo"],               // wikilink targets in the line
  "obsidian": "obsidian://…"
}
```

`scheduled` exists so a future-dated daily todo stays visible without counting as
work owed. `stats.open` and `group.open` both count `!done && !scheduled`, so the
group counts sum to `stats.open`. A scheduled todo's `ageDays` is truthfully
negative; render off `scheduled`, never off the sign.
```

## Parsing rules

### Todos
- Any line matching `^\s*[-*]\s+\[( |x|X)\]\s+(.+)$` after fence-stripping.
- An empty checkbox with no text is ignored.
- `section` = nearest preceding `## ` heading.

### Project attribution (first match wins)
1. File lives at `10-Projects/<name>.md` → project = `<name>`.
2. A `[[wikilink]]` in the todo text resolves to a note under `10-Projects/` →
   that project.
3. Otherwise `null`, and the todo lands in the `UNASSIGNED` group.

### Due dates
- Search the todo text for `\d{4}-\d{2}-\d{2}`, but **only after removing**
  `[[wikilinks]]` and `` `inline code` ``. This is required: without it,
  `[[2026-07-21-meeting-notes]]` reads as an overdue due date.
- If several remain, the earliest is the due date.
- `dueState`: `overdue` if `< today`, `today` if `=== today`, else `future`.

### Staleness / rollover
- A todo's age comes from the daily note it lives in: `today − YYYY-MM-DD`
  parsed from the `40-Daily/YYYY-MM-DD.md` filename.
- Open todos with `ageDays >= 1` are stale and appear in `rolledOver`.
- Todos in project hubs have `ageDays: null` and never count as stale — a hub
  todo is a backlog item, not a dropped one.
- Daily notes **dated in the future** (the vault has `2026-08-03.md`) are
  excluded from `open`, `stale`, and `rolledOver`. They are scheduled, not owed.

### Focus
- In today's daily note, under `## Todos`, the first line matching
  `^\*\*(.+?)\*\*\s*(.*)$` before any checkbox. The bold part is the label, the
  rest is the detail, both with a trailing period stripped. Emitted as
  `{ label, detail }`, never joined.
- `focus` is the one vault-authored string that is **not** pre-escaped, because it
  is not run through the inline renderer. The client must insert it with
  `textContent` (splitting on backticks into real text and `<code>` nodes), never
  `innerHTML`.

### Decisions
- Lines matching `^\s*[-*]\s+\[(\d{4}-\d{2}-\d{2})\]\s+[—-]\s+(.+)$` under a
  `## Decisions` or `## Recent decisions` heading.
- Sorted date desc, capped at 6.

### Wikilinks and the graph
- **Inline code is stripped before link extraction.** Obsidian does not resolve a
  wikilink inside backticks, so neither does the parser. Without this, prose that
  merely names the syntax (`` `[[wikilinks]]` `` in the vault's own docs) is
  counted as four broken links.
- `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target^block]]`.
  Take everything before the first `|`, `#`, or `^`, trimmed.
- Resolution, Obsidian-style: exact relative path match first, then unique
  basename match, case-insensitive. Unresolved → a broken link. A basename shared
  by two in-scope notes is **ambiguous, not resolved**, and emits a `warnings`
  entry — the vault currently has one, `[[morning-brief]]`.
- Nodes = every in-scope note. Edges = resolved links, deduplicated per pair,
  self-links dropped.
- `inbound` = distinct notes linking in.
- `orphan` = `inbound === 0` **and the note is not in `40-Daily/`**. Daily notes
  are chronological, not networked; nothing is ever supposed to link back to one,
  so counting them buries the real strays.

### Health
- `inbox.oldestDays` — from the `YYYY-MM-DD-` filename prefix in `00-Inbox/`,
  falling back to `mtime`.
- `stale30` — `mtime` older than 30 days, excluding `40-Daily/`.
- `orphans` — count of nodes with `orphan: true`, so the same daily-note carve-out
  applies.

### Inline markdown → HTML
A deliberately small renderer, applied to todo and decision text only:
`` `code` `` → `<code>`, `**bold**` → `<strong>`, `*em*`/`_em_` → `<em>`,
`[[link]]` → `<a class="wl" href="obsidian://…">link</a>`,
`[text](url)` → `<a>`. Everything else is HTML-escaped **first**. No other
markdown is supported and none is needed.

## Server behaviour

- On boot: parse once, cache the State.
- `fs.watch(vaultPath, { recursive: true })` → ignore excluded paths and
  non-`.md` files → 150 ms trailing debounce → re-parse → broadcast.
- Full re-parse every time. 46 files takes ~10 ms; incremental parsing would be
  strictly worse code for no measurable gain.
- SSE at `/events`: `data: <json>\n\n` per update, plus a `:keepalive` comment
  every 25 s. Dead clients are pruned on `close`.
- If a parse throws, the server keeps the last good State, pushes it with a
  `warnings` entry, and logs to stderr. The window never goes blank.
- A 500 ms `fs.watch` restart on `EPERM`/watcher death, so the window does not
  silently stop updating after an Obsidian Sync burst.

### Machine vitals

- A second SSE stream at `/metrics`, deliberately not extra fields on State. The
  two share nothing but a transport: State is pushed when the vault changes and
  carries the whole graph, vitals are pushed on a timer and carry six numbers.
  Folding them together would rebroadcast the entire vault every tick and would
  put a metrics failure in the middle of the vault render path.
- Sampling is gated on subscriber count: it starts on the first subscriber to
  `/metrics` and stops on the last. The client drops its subscription while the
  window is hidden, so a backgrounded window costs nothing.
- Base tick `VAULT_HUD_METRICS_MS` (default 10 s). Process table every 3rd tick,
  battery and thermal every 12th. Total CPU is read from `os.cpus()` deltas
  in-process; nothing else forks more often than it has to. ~4 ms of CPU per
  second overall.
- Every sampler runs through `execFile` with an argv array, never a shell, with a
  1.5 s timeout, and is skipped while its previous run is outstanding, so a
  wedged `ioreg` cannot stack up processes.
- Every metric is independently nullable and the client hides a cell it has no
  reading for. A sampler that fails takes out one cell, never the strip, and
  never the vault dashboard.
- No `powermetrics`. CPU temperature, fan speed and Energy Impact are root-only;
  a privileged sampler on a timer would cost more than the whole feature and
  would put a root surface behind a read-only dashboard. `pmset -g therm` and the
  battery's own sensor are the unprivileged substitutes.

## Client behaviour

- Fetch `/api/state` on load, then subscribe to `/events`.
- On SSE message: diff nothing, just re-render. 46 notes is small.
- A panel whose data changed flashes its border orange once (150 ms), then
  settles. This is the entire animation budget.
- Connection dot: `● LIVE` orange when the SSE stream is open, `● OFFLINE`
  dim when it is not. `EventSource` auto-reconnects; on reconnect, re-fetch.
- Clicking any todo, group header, decision, or graph node opens that note in
  Obsidian via the `obsidian://` URL.
- Clicking the graph tile expands it to fill the window; `Esc` or click closes.
- The layout must fit one screen at 1440×900 with no page scroll. Individual
  panels scroll internally when they overflow.

## Visual language

**Dark base, single orange accent, Bauhaus grid, defense-HUD instrumentation.**

### Palette (the whole palette)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#08090A` | page |
| `--panel` | `#101113` | panel fill |
| `--panel-2` | `#16181B` | raised rows, hover |
| `--rule` | `#1E2024` | hairlines, 1px |
| `--rule-hot` | `#2A2D33` | hairlines under emphasis |
| `--orange` | `#FF5D1F` | the accent. Sparingly. |
| `--orange-dim` | `#8A3512` | inactive accent, graph edges |
| `--amber` | `#F0A202` | warnings only |
| `--bone` | `#E8E4DC` | primary text |
| `--dim` | `#6E7175` | labels, secondary |
| `--dimmer` | `#42454A` | tertiary, disabled |

Nothing else gets a colour. No blue, no green, no red. Overdue is orange;
warnings are amber; that is the full semantic range. Bauhaus discipline — a
restricted palette does the work.

### Type
- Labels, numbers, metadata: `ui-monospace, "SF Mono", Menlo, monospace`.
  Uppercase, `letter-spacing: .12em`, 10–11 px, `font-variant-numeric: tabular-nums`.
- Content: `-apple-system, "Helvetica Neue", "Inter", sans-serif`, 13–14 px.
- Big numerals in the header strip: mono, 28–34 px, tabular.
- The contrast between the two families **is** the design. Do not add a third.

### Geometry
- `border-radius: 0` everywhere. No exceptions.
- Strict 8 px grid. Panel padding 16 px, gaps 1 px (hairline seams, not gutters).
- Hairlines are `1px solid var(--rule)`, never a shadow. No shadows anywhere.
- Asymmetric columns: todos ~62%, graph ~38%.

### Instrumentation
- Corner brackets: 8 px L-shaped marks in `--rule-hot` at each panel corner.
- Registration ticks along the header rule at fixed intervals.
- A `● LIVE` dot that breathes (2 s ease) while the SSE stream is open.
- A 1 px grid underlay across the page at 3 % opacity, 24 px pitch.
- Section labels rendered as `▌LABEL` with a 3 px orange bar.
- Counts right-aligned and zero-padded (`04`, not `4`).

### Graph
- Canvas, `devicePixelRatio`-aware, hand-rolled force simulation
  (repulsion + spring + centring), ~40 lines, no library.
- Circles only — the Bauhaus primitive. Radius scales with inbound links.
- `10-Projects` → filled orange. `40-Daily` → amber ring, hollow.
  `60-Standards` → bone. Everything else → `--dim`. Orphans → `--dimmer` ring,
  hollow. Node with open todos → thin orange outer ring.
- Edges: `--orange-dim` at 25 % alpha, 1 px, no arrowheads.
- No labels until hover. Hover shows the label plus inbound/outbound counts.
- The simulation cools to a stop (alpha decay) and does not run forever.

### Layout

Six rows: header 74px, answer band 118px, main `1fr`, bottom band 150px, warning
strip (auto, collapses to nothing when empty), footer 30px. Both split bands use
the same `62fr / 38fr` columns, so the principal vertical hairline is continuous
down the screen.

```
┌ ▚ VAULT-HUD  YOUR-VAULT · 2026-07-22 · WED    OPEN STALE  DUE OVER DONE ──┐
│                                               38    08   00   00   01   │
├──────────────────────────────────────────────────────┬──────────────────┤
│ ▌FOCUS                            40-DAILY/2026-07-22│ ▌STALE           │
│ MORNING FOCUS — ARGO MEET                            │                  │
│ Get the main structure going and get plan.md ready…  │       08         │
│ LOAD ▌▌▌▌▌▌▌▌▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎              │ OLDEST 02D — GO… │
├──────────────────────────────────────────┬───────────┴──────────────────┤
│ ▌TODOS          38 OPEN · 08 DONE · 04 G │ ▌LATTICE   46 NODES · 67 EDG │
│ ▸ ARGO                              10   │            ●   ╱│╲   ●       │
│  01 ☐ Think through user roles…  01L …:22│          ●───●───●           │
│  02 ☐ Decompose page.tsx     DUE 07-27   │            ╲│╱      ○ ○      │
│ ▸ MORNING-BRIEF                     04   ├──────────────────────────────┤
│ ▸ ARGO-V2-PROJECT-TRACKER           03   │ ▌DECISIONS                06 │
│ ▸ UNASSIGNED            08 DONE     21   │ 07-22 Work the argo repo fro…│
├──────────────────────────────────────────┼──────────────────────────────┤
│ ▌ROLLED OVER          08 · OLDEST 02D    │ ▌INTEGRITY 03 BROKEN · 18 OR │
│ 02D Go through the v2 branch │ 02D Go th │ UNRESOLVED                   │
│ 02D Go through the v2 tracker│ 02D Brain │ [[morning-brief]] ×3  3 NOTES│
├──────────────────────────────────────────┴──────────────────────────────┤
│ ! Ambiguous wikilink [[morning-brief]] — more than one in-scope note …   │
├─────────────────────────────────────────────────────────────────────────┤
│ NOTES 46 │ LINKS 94 │ INBOX 02 │ ORPHAN 18 │ BROKEN 03 │ SYNC │ ● LIVE  │
└─────────────────────────────────────────────────────────────────────────┘
```

**The answer band** carries the two-second read. Left: the focus line, at the
largest type on the screen — larger than the wordmark, deliberately. Right: the
**hero**, a single promoted number chosen by first match of
`overdue → dueToday → stale → open`, orange for the first three and bone for the
last, with a sub-line naming the actual offending item. The header readout gives
all five counts; the hero gives the verdict and the name.

`OPEN` and `DONE` never go orange in the readout: one is a near-constant and the
other is good news. `STALE`, `DUE`, and `OVER` go orange the moment they are
non-zero. Zeros drop to `--dimmer`.

**INTEGRITY** carries both failure modes of a linked vault: links pointing at
nothing (grouped by target, since one ambiguous target usually accounts for most
of the count) and notes nothing points at (ranked by outbound, capped at 6 with a
`+NN MORE` row).

## Shortcuts

A row of buttons in the header for the tools used most. This is the only part of
the server that can act on the machine rather than just read the vault, so the
trust boundary is drawn deliberately.

**Catalogue.** `tools.json` at the repo root, authored by the user, read at boot.
Each entry has an `id`, a `label`, a `title`, and one of three action types:

| type | behaviour |
|---|---|
| `browser` | focus the first Chrome tab whose URL starts with `match`, else open `url` in a new tab |
| | `match` may be a list of prefixes, tried in order. This is load-bearing: Supabase and Vercel redirect after load, so the tab the button just opened no longer starts with the exact URL, and an exact-only match duplicates the tab on every click. Narrow prefix first, broader fallback after. |
| `open` | hand `url` to the default handler (used for `obsidian://`) |
| `exec` | run `run` as an argv array |

`{today}` inside a `url` expands to the local date, so the daily-note button
follows the date without the catalogue needing a nightly edit.

**Why a server round trip at all.** A web page cannot see your other Chrome tabs,
and `window.open(url, name)` only reuses windows that page itself opened. Focusing
an existing tab requires AppleScript, which requires a process outside the browser.

**Trust boundary.**
- The browser never supplies a command, a URL, or an argument. It sends an `id`.
  The server looks that id up in the catalogue and runs the fixed action it finds.
  `GET /api/tools` returns presentation fields only, so the catalogue's commands
  and URLs never reach the client at all.
- Nothing runs through a shell. `execFile` with an argv array means no
  word-splitting, no globbing, no interpolation. `osascript` receives the URL as an
  `on run argv` argument rather than spliced into the script text.
- `POST /action` is CSRF-guarded three ways: loopback binding, `Sec-Fetch-Site`
  must be `same-origin`, and a custom `X-Vault-HUD: 1` header is required. Any
  cross-origin fetch that sets that header triggers a CORS preflight, and since no
  `Access-Control-*` header is ever sent, the browser refuses to send the real
  request.
- Request bodies over 1KB are dropped. A malformed body is a `400`, an unknown id
  is a `404`, and neither can throw into the request handler.

So the blast radius is exactly the set of shortcuts written in `tools.json`.

**Verified:** unknown id → 404, missing custom header → 403, `Sec-Fetch-Site:
cross-site` → 403, malformed JSON → 400, valid id → 200 and the action fires.

## PWA

`manifest.webmanifest` with `display: standalone`, `background_color`/
`theme_color` `#08090A`, and 192/512 icons. `sw.js` is a pass-through fetch
handler and exists only because Chrome requires a service worker for the desktop
install prompt. Icons are generated once by `tools/make-icons.js` (pure Node,
`zlib` + manual PNG chunks): an orange Bauhaus mark on near-black.

## Verification

`node parse.js` prints a summary; `node parse.js --json` prints the full State.

Observed ground truth for the vault as of 2026-07-22, verified by running it:

| | |
|---|---|
| in-scope notes | 46 (2 inbox · 3 hubs · 7 research · 1 reading · 4 daily · 9 people · 9 standards · 7 memory · 4 root) |
| open / stale / due / overdue / done today | 38 · 08 · 00 · 00 · 01 |
| groups | ARGO 10 · UNASSIGNED 21 · MORNING-BRIEF 04 · ARGO-V2-PROJECT-TRACKER 03 |
| graph | 46 nodes · 67 edges · 94 links |
| health | 18 orphans · 0 stale30 · 3 broken (all `[[morning-brief]]`) · 1 warning |

Scanned directories **recurse**: without descending into `70-Memory/automations/`
the note count is 43, not 46.

Behaviours that must hold, each of which broke a real case during the build:

- the empty `- [ ]` in `70-Memory/repo-claude-md-snippet.md` is inside a fence and
  must **not** appear as a todo (same for `CLAUDE.md:211,237`)
- `[[2026-07-21-meeting-notes]]` must **not** produce a due date
- `` `[[wikilinks]]` `` in prose must **not** produce a link or a broken link
- `40-Daily/2026-08-03.md` ("Check 401k") must be `scheduled`, and must not count
  as open or stale
- `40-Daily/*` notes must never appear as orphans
- `focus` must resolve to `{label: "Morning focus — Project X", detail: "Get the
  main structure going and get \`plan.md\` ready to start coding against"}`
- `stale30` is legitimately 0: every in-scope file's mtime is 2026-07-20 or later

Live-update verification, run against an `rsync` copy of the vault so the real one
is never written to: load the page, append a checkbox line to the copy's daily
note, and confirm the header count increments and `SYNC` advances **without a
reload**, while the lattice does not re-settle (the graph did not change).

## Hardening

An adversarial review raised 37 findings; 11 survived independent double
refutation and are fixed. The ones that changed a design assumption:

- **`GET //` killed the daemon.** `new URL('//', base)` throws `ERR_INVALID_URL`
  because a leading `//` opens an empty authority, and the throw was uncaught
  inside the request listener. Any page in the browser could send it with a
  no-cors fetch, no CORS grant required, and under `KeepAlive` that becomes a
  crash/restart loop. The request listener must never be able to throw
  synchronously; the URL parse is wrapped and answers `400`.
- **The window never recovered from an abrupt server death.** `EventSource`
  retries on its own only when the server closes the stream cleanly. After a
  crash it goes to `CLOSED` and the browser gives up permanently, leaving frozen
  numbers behind a dim `OFFLINE` lamp. Reconnection is now explicit, with
  exponential backoff and re-subscription on `visibilitychange` and `online`.
- **Dates rolled over invisibly.** `today` and every date-derived statistic are
  computed at parse time, and the watcher only fires on writes. A vault untouched
  across midnight left the header reading yesterday. A one-minute timer re-parses
  when the local date changes.
- **A date inside a URL became a due date.** `extractDue` scrubbed wikilinks and
  inline code but not link targets, so a dated permalink read as overdue and
  inflated `stats.overdue`. URLs and markdown link targets are scrubbed too, and
  `ISO_DATE_RE` is digit-boundary anchored.
- **`obsidian:` was too broad an allow-list.** The scheme includes write-capable
  actions, and this is a read-only panel rendering links from arbitrary vault
  markdown. Narrowed to `obsidian://open?`, the only verb the parser generates.
- **`[[target\|alias]]` broke.** The escaped pipe is required inside a markdown
  table. The backslash escapes the pipe for the *table* parser, not the wikilink
  parser, so it is stripped before splitting and `\|` still separates target from
  alias.
- **Layout could amputate itself.** `body` had no explicit column, so one long
  warning sized the page column past the viewport and cut off the right edge of
  every row with no scrollbar. `grid-template-columns: minmax(0, 1fr)` plus
  `min-width: 0` containment fixes it. Separately, `.warnstrip[hidden]` used
  `display: none`, which freed its grid track and let the footer slide up into
  it; both bands are now pinned to explicit `grid-row`s.
