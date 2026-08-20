# vault-hud

A read-only instrument panel for an [Obsidian](https://obsidian.md) vault. One
always-open window that answers two questions at a glance — **what is on me right
now**, and **is the vault healthy** — plus a force-directed graph of the notes and
their wikilinks, a strip of machine vitals, and a row of one-click shortcuts.

The dashboard **never writes to the vault.** It opens files for reading and watches
directories; there is no code path that can modify a note. The window repaints
itself the instant a file changes.

**Zero npm dependencies.** Node built-ins only — no framework, no bundler, no build
step. The whole thing is a static `public/` directory and a small HTTP + SSE server.

> Built for one person's vault and shared as-is. It assumes a specific folder
> layout (see [Vault layout](#vault-layout-it-assumes)) and macOS for the vitals
> strip and shortcuts. The core dashboard works anywhere Node runs; the
> platform-specific parts degrade gracefully when their data source is missing.

## What you see

- **Header** — the vault name, today's date, and five live counters: open, stale,
  due today, overdue, done today.
- **Vitals strip** — CPU, GPU, memory and battery in a thin row, with a slot that
  names a process only when one is genuinely eating the machine (>80% of a core or
  >4 GB RSS), plus a second slot that names the app driving the GPU whenever the
  GPU reading itself is high. macOS only; cells hide themselves when their data
  source is absent.
- **Focus** — today's lead line, lifted from the top of the daily note.
- **Todos** — every open `- [ ]` grouped by project, with due/stale badges.
- **Rolled over** — open todos sitting in daily notes dated before today.
- **Decisions** — dated decision lines pulled from recent daily notes.
- **Lattice** — a force-directed graph of notes and their `[[wikilinks]]`; click a
  node to expand it.
- **Integrity** — broken links and orphaned notes.
- **Shortcut bar** — configurable buttons that focus a browser tab, open a deep
  link, or run a fixed local command (see [Shortcuts](#shortcuts-the-action-bar)).

## Requirements

- **Node 22 or newer** (uses `process.loadEnvFile`, added in 20.12).
- **macOS** for the vitals strip (`ioreg`, `vm_stat`, `pmset`, `ps`) and the
  `type: exec` / `type: browser` shortcuts. Everything else is cross-platform.

## Quickstart

```sh
git clone https://github.com/OWNER/vault-dashboard.git vault-hud
cd vault-hud
cp .env.example .env          # then edit .env — at minimum set VAULT_HUD_VAULT
npm start
```

Open <http://127.0.0.1:5959>.

`npm run dev` is the same under `node --watch`, so edits to `server.js` or
`parse.js` restart the process. To sanity-check the parser alone:

```sh
node parse.js --json
```

## Configuration

All machine- and account-specific values live in a **`.env` file that is never
committed** (`.gitignore` excludes it). The server loads it at boot. Copy the
template and fill it in:

```sh
cp .env.example .env
```

| Variable | What it does |
|---|---|
| `VAULT_HUD_VAULT` | **Required.** Absolute path to the Obsidian vault to read and watch. |
| `VAULT_HUD_PORT` | Port on `127.0.0.1` (default `5959`). The server never binds any other interface. |
| `VAULT_HUD_DATA_DIR` | Where the usage poller keeps `usage-tokens.json` (secrets, mode `0600`) and `usage.json` (default `~/Library/Application Support/vault-hud`). Never point it into the repo or the vault. |
| `GITHUB_URL`, `SUPABASE_DASHBOARD_URL`, `VERCEL_URL`, `DEV_URL` | Targets for the shortcut-bar browser buttons. |
| `OBSIDIAN_VAULT` | Vault **name** (not path) used to build the `obsidian://` daily-note deep link. |
| `PROJECT_DIR` | Directory the Terminal and VS Code shortcuts open. |

Two more environment variables are read directly (not usually set in `.env`):

| Variable | Default | What it does |
|---|---|---|
| `VAULT_HUD_PUBLIC` | `./public` | Static root. Relative values resolve against the repo root, so `VAULT_HUD_PUBLIC=candidates/b npm start` serves an alternate frontend against the same live data — how frontend candidates get A/B tested. |
| `VAULT_HUD_METRICS_MS` | `10000` | Base sampling tick for the vitals strip. Everything else is a multiple of it, so this one number tunes the whole feature's cost. Floored at 1000. |

## Vault layout it assumes

`parse.js` is written against a numbered-folder convention. It reads:

```
00-Inbox  10-Projects  20-Research  30-Reading
40-Daily  50-People    60-Standards 70-Memory   + any *.md at the vault root
```

and skips `99-Archive`, `_to_delete`, `node_modules`, and every dotfile directory
(`.obsidian`, `.git`, …). Project todos are attributed by living in
`10-Projects/<name>.md` or by wikilinking to a note that does. Daily notes are
`40-Daily/YYYY-MM-DD.md`, and that filename date is how a todo's age (and therefore
"stale" / "rolled over") is computed. If your vault uses different folder names,
adjust the scope constants at the top of `parse.js`.

## Shortcuts (the action bar)

The row of buttons is defined in [`tools.json`](tools.json). The browser only ever
sends a button `id`; the server looks it up and runs the fixed action it finds
there. Three kinds:

- `browser` — focus an existing Chrome tab whose URL starts with `match`, else open `url`.
- `open` — hand `url` to the default handler (used for `obsidian://` deep links).
- `exec` — run `run` as an argv array, **never through a shell** (no word-splitting,
  globbing or interpolation).

Machine-specific URLs and paths in `tools.json` are written as `${VAR}` and filled
from `.env` at boot, so nothing account-specific lives in the tracked file. A
shortcut whose only target comes from an unset variable simply drops out of the bar.

See [`shortcuts.js`](shortcuts.js) for the full threat model — the command surface
is drawn deliberately narrow, and the client never sees a command or a URL, only
presentation fields.

## Routes

| Route | Response |
|---|---|
| `GET /` | `public/index.html` |
| `GET /api/state` | The current State as JSON |
| `GET /events` | SSE stream. One `data:` frame per vault change, plus a `:keepalive` comment every 25 s. |
| `GET /api/metrics` | The last machine-vitals reading as JSON (a cache read — returns nulls until `/metrics` has had a subscriber). |
| `GET /api/publish` | The last status-page publish attempt: when, whether it succeeded, and the error if not. `{"enabled":false}` unless `VAULT_HUD_PUBLISH=1`. |
| `GET /metrics` | SSE stream of machine vitals. Sampling starts on the first subscriber and stops on the last. |
| `GET /<file>` | Static files under the public root. Path traversal is rejected. |

Anything other than `GET` or `HEAD` gets a 405.

## Run it at login (launchd, macOS)

A launchd job starts the server at login and restarts it if it dies, so the PWA
window is always live. The plist is a **template** — edit its placeholder paths
first. Full instructions in [`launchd/README.md`](launchd/README.md):

```sh
# after editing placeholders in launchd/local.vault-hud.plist
cp launchd/local.vault-hud.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/local.vault-hud.plist
launchctl list | grep vault-hud
```

## Install as a desktop app (Chrome PWA)

1. Open <http://127.0.0.1:5959> in Chrome.
2. Click the install icon at the right edge of the address bar (or three-dot menu →
   Cast, Save and Share → Install page as app).
3. Confirm. Chrome creates a standalone window with no address bar.

`public/sw.js` is a pass-through service worker. It exists only because Chrome
requires one before offering the install prompt; it caches nothing, on purpose, so
the dashboard always shows live data. To reinstall after changing the manifest or
icons: uninstall from the app-window menu, hard-reload, install again.

## How the parser reads the vault

`parse.js` walks the vault once per change and returns a single State object — the
whole contract between parser, server, and frontend.

- **Fences first.** Every file has its fenced code blocks stripped before anything
  is extracted, so template checkboxes inside a `CLAUDE.md` are not counted as work.
- **Todos.** Any `- [ ]` / `- [x]` becomes a Todo tagged with the nearest preceding
  `## ` heading, attributed to a project by folder or by wikilink; everything else
  lands in `UNASSIGNED`.
- **Dates.** A due date is a bare `YYYY-MM-DD` in the todo text, searched only after
  wikilinks and inline code are removed, so `[[2026-07-21-meeting-notes]]` is a link
  and not an overdue deadline. Age comes from the daily-note filename; future-dated
  notes are scheduled, not owed, and excluded from the open/stale/rolled-over counts.
- **Links.** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
  `[[target^block]]` resolve to the part before the first delimiter, Obsidian-style
  (exact relative path, then unique basename). Unresolved links are reported broken;
  resolved links become deduplicated graph edges. A note with no inbound links is an
  orphan.
- **Health.** Inbox age comes from a `YYYY-MM-DD-` filename prefix (falling back to
  mtime); `stale30` counts non-daily notes whose mtime is older than 30 days.

## The vitals strip (macOS)

A one-line readout of CPU, GPU, memory, battery, plus a slot that names a process
only when one is genuinely eating the machine. Check it standalone:

```sh
node metrics.js          # one line
node metrics.js --json   # the full reading
```

**Cost is the design constraint.** It runs behind an always-open window, so total
CPU comes from `os.cpus()` tick deltas with no subprocess at all, and everything
else is staggered by how fast it actually moves:

| Cadence | Sampled | Cost |
|---|---|---|
| every tick (10s) | CPU via `os.cpus()`, GPU via `ioreg`, memory via `vm_stat` | ~28 ms |
| every 3rd tick (30s) | process table via `ps`, per-app GPU via `ioreg` | ~40 ms |
| every 12th tick (120s) | battery via `ioreg`, throttling via `pmset -g therm` | ~16 ms |

That averages ~4 ms of CPU per second (~0.02% of an 18-core machine). Sampling runs
only while `/metrics` has a subscriber, and the page drops its subscription when the
window is hidden, so a backgrounded window costs nothing.

**Deliberately missing:** CPU temperature, fan speed and Energy Impact all come from
`powermetrics`, which is root-only — running a privileged sampler on a timer behind a
read-only dashboard is the wrong trade, so honest substitutes are used (`pmset -g
therm` for actual clock clamping, battery sensor for temperature). Per-process
ranking is real interval CPU time, labelled CPU, never "energy". The CPU cell is
percent of the whole machine (0–100 across all cores); the hot slot is percent of
**one** core (the `ps`/`top` convention, so it can exceed 100). GPU utilisation reads
an undocumented `Device Utilization %` key; if a macOS update removes it, the cell
hides itself rather than showing a confident zero.

**Per-app GPU** answers the question a high GPU number raises — *which app?* — and
does it unprivileged, no `powermetrics` and no root. Every process with a live Metal
context owns `AGXDeviceUserClient` nodes in the IO registry carrying a cumulative
`accumulatedGPUTime` counter tagged with the owning pid; differencing it per process
over the interval (exactly how CPU ranking differences `ps` TIME) names the driver,
and the slot appears only while the GPU cell is already high. It advances on
command-buffer completion, so it tracks streaming GPU work (video, WebGL,
compositing) accurately and only lags a single kernel that pins the GPU for seconds.
Like every vital it is nullable: no reliable reading, no slot, never a confident
wrong name.

## Claude subscription usage

If you run one or more Claude (Pro/Max) subscriptions, the HUD can poll their
usage windows — the five-hour session window, the seven-day weekly windows,
and the Fable weekly window where the plan reports one — and show each
account's utilisation. The verdict cell answers "do I need to switch": it
names the current account while it has headroom, and only advises a switch
once the current account passes 80% of its session window or 90% of its
weekly one (both fixed in `public/usage-view.js`). Which account is current
comes from the default CLI profile, matched by account uuid — never by token
string, which rotates on every refresh.

The data lives in the **data directory**, never in the repo and never in the
vault:

| File | Contents |
|---|---|
| `usage-tokens.json` | One OAuth bundle per enrolled account. Secrets, written mode `0600`; only `usage-poller.js` and `usage-enroll.js` read it. |
| `usage.json` | The public-safe snapshot the HUD renders. |

The directory defaults to `~/Library/Application Support/vault-hud`; set
`VAULT_HUD_DATA_DIR` to move it.

**A run row says which of those subscriptions it is spending.** `machine` names
the computer and stops there, so on a board carrying runs from more than one
machine and more than one account, neither the computer nor the plan identifies
the account. A run file's `account.accountUuid` — written by the agent, resolved
from disk at every write — joins to the same enrollment row the usage strip
shows, so the two never name one account two ways. The loopback board renders the
enrollment label, the phone page renders the enrollment id, and the address never
leaves this machine.

Where the poller can see the run, it wins: a run with a live session on this
machine is spending whatever account the CLI is on now, not the one its file was
stamped with. A run from another machine keeps its own.

`account.js` answers the same question from local disk when the poller cannot —
its reading needs the Keychain and a network call, and comes back empty often
enough to matter. It reads no token on any branch.

### One-time enrollment per account

```sh
node usage-enroll.js add main "Main account"     # reads the default ~/.claude Keychain entry
node usage-enroll.js list
node usage-enroll.js remove main
```

`add` reads the Claude CLI's credential from the macOS Keychain (or from
`--stdin`, if you paste the credential JSON yourself). For a second or third
subscription, give each its own CLI profile, log each in, and enrol each one:

```sh
CLAUDE_CONFIG_DIR=~/.claude-alt claude           # create the profile and log in
node usage-enroll.js add alt "Alt account" --config-dir ~/.claude-alt
```

Enrollment performs **one deliberate token refresh** so this copy of the
credential is decoupled from the CLI's own. The CLI's stored refresh token goes
stale in the process, so that profile will ask for **one re-login** the next
time its token expires. That is the accepted tradeoff (the same one
claude-meter makes). Afterwards the poller refreshes tokens on its own and
nothing asks again.

The poller runs inside the server: every five minutes, accounts queried
sequentially a couple of seconds apart, and the snapshot written atomically.
It checks for enrolled accounts once at startup, so restart the HUD after the
first enrollment. To poll once by hand:

```sh
node usage-poller.js --once
```

**Caveat.** The usage endpoint is a private, undocumented API
(`api.anthropic.com/api/oauth/usage`) read with each subscription's own OAuth
token — the same mechanism third-party tools like claude-meter use. It can
change or disappear without notice; if it does, the affected accounts show an
error state and the rest of the dashboard is unaffected.

## Failure behaviour

The window never goes blank.

- If a parse throws, the server keeps the last good State, pushes it with a
  `warnings` entry, and logs the stack. The dashboard shows stale data with a
  visible warning strip rather than nothing.
- If the filesystem watcher dies, the server tears it down and re-establishes it
  after 500 ms, doubling up to 8 s until it succeeds, then forces a re-parse so
  nothing missed while it was down stays missed.
- Vault changes are coalesced with a 150 ms trailing debounce, so an Obsidian Sync
  burst produces one re-parse, not fifty.

## Safety

- **Read-only.** The server never calls a write API. There is no code path that can
  modify the vault.
- **Loopback only.** It binds `127.0.0.1` — no external interface, no CORS, no auth
  because there is nothing to authenticate against.
- **Confined static serving.** Any resolved path outside the public root is rejected
  with a 403.
- **No secrets in the repo.** Vault paths and account-specific URLs live only in the
  gitignored `.env`. See [`CLAUDE.md`](CLAUDE.md) for the public-repo rule.

## The claim layer (`claims.js`, `check.js`, `mcp-vault.mjs`)

The dashboard shows you the vault. The claim layer lets an *agent* ask what the vault
asserts, with citations. Same parser, no extra dependencies, still read-only.

A wikilink says two notes touch. A **claim** says what the relation is and which file
and line asserted it. The predicate comes from the enclosing `##` heading, so existing
section conventions carry the typing and nothing is annotated by hand:

| Enclosing section | Predicate | Human-asserted |
|---|---|---|
| `## Decisions`, `## Recent decisions` | `decided_about` | |
| `## Key docs & references` | `references` | |
| `## Related patterns and standards` | `governed_by` | ✓ |
| `## What it is`, `## Guiding values` | `describes` | ✓ |
| `## Todos` | `todo_on` | |
| `## Worked on` | `worked_on` | |
| anything else | `related_to` | |

The map is deliberately small: a predicate graduates only when a real query needs it.
Everything else falls back to `related_to` and is reported by `--unmapped`, so the map
grows on evidence rather than on speculation.

*Human-asserted* marks the HUMAN ZONE sections of the project-hub template — sections an
agent may never write, so a claim from one carries a human's assertion.

```sh
npm run claims                 # summary: claims per predicate, decisions, unresolved
node claims.js --unmapped      # sections that fell back, with counts
node claims.js --json          # the full index

node check.js claim  <subject> <predicate> <object>
node check.js decision <query text>
node check.js note   <note name>
```

### Verdicts, and what they refuse to say

- `supported` — asserted; every source file and line is cited
- `related` — the notes are linked, under a *different* predicate. **Not a contradiction.**
- `no vault evidence` — a note is unknown, or nothing connects them

`vetoBasis` is `false` on every verdict. A link graph holds assertions, not refutations,
so it can never prove a negative — silence is not disagreement. This is a deliberate
divergence from the design this was lifted from, which reports `contradicted` whenever a
different predicate exists; in a vault that manufactures false rejections.

`check_decision` searches the dated decision ledger, which is where most real questions
("did we decide X?") are actually answered. It matches on word boundaries, so a search
for `Linear` does not match `scaleLinear`, and falls back to substring only when word
matching finds nothing — reporting `matchMode` either way.

### Calling it from another repo

The CLI is the interface. It resolves the vault from this repo's `.env`, so it needs no
environment prefix and no setup:

```sh
node /path/to/vault-hud/check.js decision "some topic"
```

That is what makes it usable from an agent session in an unrelated repo: one Bash call,
JSON on stdout, no service to keep running.

`mcp-vault.mjs` wraps the same three functions as an MCP server if you want them in a
tool list instead:

```sh
claude mcp add vault --scope user -- node /path/to/vault-hud/mcp-vault.mjs
```

It is **optional and off by default**. MCP buys discovery — the tools appear without the
agent being told they exist — and costs three tool schemas in the context of every
session, including all the ones that never touch the vault. Naming the command in a
document you already load is usually the better trade. The index is rebuilt per call
either way: a full parse of a few hundred notes measures ~10ms (worst observed 18ms), and
a stale answer about your own vault is worse than a cheap one.

## Repository layout

```
server.js      HTTP + SSE server, loads .env, binds 127.0.0.1
parse.js       vault → State (the parser); runnable standalone
claims.js      vault → typed, sourced claims; runnable standalone
check.js       verdicts over the claim index (supported / related / no evidence)
mcp-vault.mjs  read-only MCP server exposing the three check tools
shortcuts.js   the narrow command surface for the action bar
metrics.js     macOS machine vitals sampler
runs.js        15-Runs/ and 99-Archive/runs/ → validated run objects
usage.js       usage.json → normalised snapshot (whitelisted fields, no clock)
account.js     which Claude account this machine's CLI is signed in as, from disk
usage-poller.js  polls Claude usage endpoints, rotates OAuth tokens; --once standalone
usage-enroll.js  enrols CLI credentials into the data directory (add/list/remove)
sessions.js    live agent sessions, read from the process table (ps + lsof)
run-terminal.js  focus the Terminal tab a run or session occupies
publish.js     rebuilds and redeploys the phone status page on a timer
status-page/   the published phone board (build.js, deploy.sh); NOT Git-connected
tools.json     shortcut-bar definitions (uses ${VAR} from .env)
public/        the static frontend (index.html, app.js, hud.css, sw.js, icons)
test/          node:test suites over a synthetic fixture vault
launchd/       login-job template + instructions
SPEC.md        the full design spec
```

## License

MIT. See [`LICENSE`](LICENSE).
