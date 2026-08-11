#!/usr/bin/env node
// vault-hud — read-only HTTP + SSE server for an Obsidian vault.
// Never writes to the vault. Binds loopback only.

import { createServer } from 'node:http';
import { createReadStream, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import parseVault, { observeSessions } from './parse.js';
import { loadShortcuts, publicShortcuts, runShortcut } from './shortcuts.js';
import { startMetrics, stopMetrics, currentMetrics } from './metrics.js';
import { focusRunTerminal, focusSessionTerminal, RUN_PREFIX, SESSION_PREFIX } from './run-terminal.js';
import { startPublishing, stopPublishing, publishStatus } from './publish.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load ./.env if present (zero-dependency; Node 20.12+). Config and the paths in
// tools.json live there, never in the tracked source. Missing file is fine.
try {
  process.loadEnvFile(path.join(HERE, '.env'));
} catch {
  /* no .env — fall back to real env and defaults below */
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.VAULT_HUD_PORT ?? 5959);
const VAULT = path.resolve(
  process.env.VAULT_HUD_VAULT ?? path.join(os.homedir(), 'Obsidian', 'vault')
);
// Relative values resolve against the repo root, so `VAULT_HUD_PUBLIC=candidates/b`
// works from any cwd and lets frontend candidates be A/B tested against one server.
const PUBLIC_ROOT = path.resolve(HERE, process.env.VAULT_HUD_PUBLIC ?? './public');

const DEBOUNCE_MS = 150;
/** Ceiling on how long a burst may postpone the parse. Without it, any event
 *  stream whose gaps stay under DEBOUNCE_MS defers it forever. */
const DEBOUNCE_MAX_MS = 1_000;
/** Where agent sessions write about themselves. Outside the vault, so the
 *  recursive vault watch cannot see it. Override for tests. */
const TRANSCRIPT_ROOT = process.env.VAULT_HUD_CLAUDE_HOME
  ? path.join(process.env.VAULT_HUD_CLAUDE_HOME, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');
const KEEPALIVE_MS = 25_000;
const WATCH_RETRY_MIN_MS = 500;
const WATCH_RETRY_MAX_MS = 8_000;

const EXCLUDED_DIRS = new Set(['99-Archive', '_to_delete', 'node_modules']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

// ── State cache ───────────────────────────────────────────────────────────────

/** Last successful parse. Never cleared, so a failing parse can still be served. */
let lastGood = null;
/** What every consumer sees: `lastGood`, or `lastGood` plus a parse warning. */
let current = bootState();
let currentJson = JSON.stringify(current);

function bootState() {
  const now = new Date();
  return {
    generatedAt: now.toISOString(),
    today: localDate(now),
    todayLabel: now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    vaultPath: VAULT,
    vaultName: path.basename(VAULT),
    stats: { open: 0, stale: 0, dueToday: 0, overdue: 0, doneToday: 0 },
    focus: null,
    groups: [],
    rolledOver: [],
    decisions: [],
    graph: { nodes: [], edges: [] },
    // Present before the first parse, so app.js never reads undefined off the
    // boot state and every consumer sees one shape.
    runs: [],
    sessions: [],
    health: {
      notes: 0,
      links: 0,
      inbox: { count: 0, oldestDays: 0 },
      orphans: 0,
      stale30: 0,
      broken: []
    },
    warnings: ['vault has not been parsed yet']
  };
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function publish(state) {
  current = state;
  currentJson = JSON.stringify(state);
  broadcast(currentJson);
}

/**
 * Re-parse the vault. On failure the last good State is re-published with a
 * warning appended, so the window degrades to stale data instead of blanking.
 * Returns the parse duration in ms.
 */
async function refresh() {
  const started = process.hrtime.bigint();
  try {
    const state = await parseVault(VAULT);
    lastGood = state;
    // Bumped on every full parse, so a partial refresh that was mid-await can
    // tell its inputs are stale and stand down.
    stateGeneration += 1;
    publish(state);
  } catch (err) {
    process.stderr.write(`[vault-hud] parse failed: ${err?.stack ?? err}\n`);
    const base = lastGood ?? bootState();
    publish({
      ...base,
      warnings: [
        ...(lastGood?.warnings ?? []),
        `parse failed at ${new Date().toISOString()}, showing last good data (${err?.message ?? err})`
      ]
    });
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// ── SSE ───────────────────────────────────────────────────────────────────────

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

function broadcast(json) {
  const frame = `data: ${json}\n\n`;
  for (const res of clients) res.write(frame);
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // Seed the stream so a client that subscribes after fetching /api/state cannot
  // miss an update that landed between the two requests.
  res.write(`data: ${currentJson}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ── Metrics SSE ───────────────────────────────────────────────────────────────

// A second stream rather than extra fields on State. The two have nothing in
// common but a transport: State is pushed when the vault changes and carries the
// whole graph, metrics are pushed on a timer and carry six numbers. Folding them
// together would rebroadcast the entire vault every tick, and a metrics failure
// would land in the middle of the vault render path. Separate streams keep both
// costs and both failure modes apart.

/** @type {Set<import('node:http').ServerResponse>} */
const metricClients = new Set();

function openMetricStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify(currentMetrics())}\n\n`);
  metricClients.add(res);
  // Sampling exists only while someone is watching. A closed PWA window, or one
  // hidden in the background, costs exactly nothing.
  if (metricClients.size === 1) startMetrics(pushMetrics);
  req.on('close', () => {
    metricClients.delete(res);
    if (metricClients.size === 0) stopMetrics();
  });
}

function pushMetrics(sample) {
  const frame = `data: ${JSON.stringify(sample)}\n\n`;
  for (const res of metricClients) res.write(frame);
}

const keepalive = setInterval(() => {
  for (const res of clients) res.write(':keepalive\n\n');
  for (const res of metricClients) res.write(':keepalive\n\n');
}, KEEPALIVE_MS);
keepalive.unref();

// ── Static files ──────────────────────────────────────────────────────────────

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** Resolve a URL path inside PUBLIC_ROOT, or null if it escapes. */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // urlPath always starts with "/", so "." + decoded keeps the lookup relative to
  // the root; anything that climbs out of it is rejected rather than normalised.
  const full = path.resolve(PUBLIC_ROOT, '.' + decoded);
  if (!full.startsWith(PUBLIC_ROOT + path.sep)) return null;
  return full;
}

async function serveStatic(req, res, urlPath) {
  const file = resolveStatic(urlPath);
  if (!file) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');

  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  if (!info.isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ── Shortcut actions ──────────────────────────────────────────────────────────

/**
 * Trigger a shortcut. This is the only endpoint that can act on the machine, so
 * it is guarded against a malicious web page driving it (CSRF):
 *   - Bound to loopback, like the rest of the server.
 *   - `Sec-Fetch-Site` must be `same-origin`. Chrome sets this on every request
 *     and a page cannot forge it; a cross-site fetch is rejected outright.
 *   - A custom `X-Vault-HUD` header is required. Any cross-origin fetch that sets
 *     it triggers a CORS preflight, and since no `Access-Control-*` headers are
 *     ever sent, the browser refuses to send the real request. Same-origin
 *     requests from our own page set it freely.
 * The body is a tiny JSON `{ id }`; the id is looked up in the server-side
 * catalogue and nothing from the request reaches a shell.
 */
function handleAction(req, res) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') {
    return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  }
  if (req.headers['x-vault-hud'] !== '1') {
    return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  }

  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 && !tooBig) { tooBig = true; req.destroy(); } // no large bodies here
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (tooBig) return;
    let id;
    try {
      id = JSON.parse(body)?.id;
    } catch {
      return send(res, 400, '{"error":"bad json"}', 'application/json; charset=utf-8');
    }
    if (typeof id !== 'string') {
      return send(res, 400, '{"error":"missing id"}', 'application/json; charset=utf-8');
    }
    // `run:<runId>` focuses the Terminal tab that run is executing in. It is
    // still only an id from the browser: run-terminal.js resolves the tty from
    // the run's own file, which this server already parses for the panel.
    if (id.startsWith(RUN_PREFIX)) {
      focusRunTerminal(id, VAULT).then((result) => {
        send(res, result.ok ? 200 : (result.status ?? 500), JSON.stringify(result),
          'application/json; charset=utf-8');
      });
      return;
    }
    // `session:<pid>` focuses a live session that is publishing no run file.
    // Same rule as above: the page sends an id, run-terminal.js resolves the
    // tty from the process table and validates it before it reaches osascript.
    if (id.startsWith(SESSION_PREFIX)) {
      focusSessionTerminal(id).then((result) => {
        send(res, result.ok ? 200 : (result.status ?? 500), JSON.stringify(result),
          'application/json; charset=utf-8');
      });
      return;
    }
    const result = runShortcut(id);
    send(res, result.ok ? 200 : (result.status ?? 500), JSON.stringify(result),
      'application/json; charset=utf-8');
  });
}

// ── Routing ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  const isActionPost = req.method === 'POST' && req.url === '/action';
  if (!isGet && !isActionPost) {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    return res.end();
  }

  // `GET //` makes `new URL` throw ERR_INVALID_URL, because a leading `//`
  // opens an empty authority. Uncaught inside this listener that is fatal: one
  // such request kills the daemon, and any page in the browser can send it with
  // a no-cors fetch without needing a CORS grant. Never let the parse throw.
  let urlPath;
  try {
    urlPath = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    return send(res, 400, 'bad request', 'text/plain; charset=utf-8');
  }

  if (isActionPost) return handleAction(req, res);

  if (urlPath === '/api/tools') {
    return send(res, 200, JSON.stringify(publicShortcuts()), 'application/json; charset=utf-8');
  }
  if (urlPath === '/api/state') {
    return send(res, 200, currentJson, 'application/json; charset=utf-8');
  }
  if (urlPath === '/api/publish') {
    return send(res, 200, JSON.stringify(publishStatus()), 'application/json; charset=utf-8');
  }
  if (urlPath === '/api/metrics') {
    return send(res, 200, JSON.stringify(currentMetrics()), 'application/json; charset=utf-8');
  }
  if (urlPath === '/events') {
    if (req.method === 'HEAD') return res.writeHead(200).end();
    return openStream(req, res);
  }
  if (urlPath === '/metrics') {
    if (req.method === 'HEAD') return res.writeHead(200).end();
    return openMetricStream(req, res);
  }
  return serveStatic(req, res, urlPath === '/' ? '/index.html' : urlPath);
});

// ── Watcher ───────────────────────────────────────────────────────────────────

let debounceTimer = null;
/** When the current debounce burst began, so a continuous event stream cannot
 *  postpone the parse forever. See DEBOUNCE_MAX_MS. */
let debounceStarted = 0;
let sessionTimer = null;
/** Incremented by every full parse. See scheduleSessionRefresh. */
let stateGeneration = 0;

/**
 * One watcher's mutable state.
 *
 * There are two watchers now — the vault and the transcript tree — and they must
 * fail independently. A single set of `watcher`/`retryDelay`/`retryTimer` meant
 * an error on either tore down the other, and `scheduleWatcherRestart` returning
 * early while a retry was pending dropped the second failure entirely.
 */
function watcherState(name, root, isRelevant, onEvent) {
  return { name, root, isRelevant, onEvent, handle: null,
    retryDelay: WATCH_RETRY_MIN_MS, retryTimer: null };
}

/** True for .md files that are inside the scanning scope. */
function relevant(filename) {
  if (!filename) return true; // macOS can report a null name; re-parse to be safe
  const parts = filename.split(path.sep);
  const base = parts.pop();
  for (const dir of parts) {
    if (dir.startsWith('.') || EXCLUDED_DIRS.has(dir)) return false;
  }
  const lower = base.toLowerCase();
  // .json for 15-Runs. A run file changing is exactly the event the runs panel
  // exists for; without this it would only surface on the 10s safety refresh.
  return (lower.endsWith('.md') || lower.endsWith('.json')) && !base.startsWith('.');
}

/**
 * True for a transcript file. Its own predicate, because `relevant()` above
 * rejects every one of them: `'x.jsonl'.endsWith('.json')` is false, and the
 * first loop rejects any path segment beginning with a dot, which `.claude` is.
 * Filenames arrive relative to the watched root.
 */
function relevantTranscript(filename) {
  if (!filename) return true;
  const lower = filename.toLowerCase();
  return lower.endsWith('.jsonl') || lower.endsWith('.meta.json');
}

/**
 * Coalesce a burst, but never past DEBOUNCE_MAX_MS.
 *
 * The plain version cleared and re-armed on every event, so any stream whose
 * gaps stay under 150ms postponed the parse indefinitely. A vault of markdown
 * never produced one; the transcript tree does — measured at 290 entries in one
 * minute on a fanned-out session, with 40% of gaps under the debounce. The
 * ceiling makes the delay bounded rather than best-effort.
 */
function scheduleRefresh() {
  const now = Date.now();
  if (!debounceTimer) debounceStarted = now;
  else if (now - debounceStarted >= DEBOUNCE_MAX_MS) return;   // already due; let it fire
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refresh().catch((err) => process.stderr.write(`[vault-hud] refresh error: ${err}\n`));
  }, DEBOUNCE_MS);
}

/**
 * Refresh only what a transcript event can have changed.
 *
 * Re-reads the process table and the session files and republishes the last
 * good State with new session data. Does NOT re-walk the vault: nothing under
 * the transcript tree can change a note, a todo or the graph, and routing these
 * events through the full parse is how a fanned-out session turns into three
 * vault parses a second.
 */
let sessionRefreshInFlight = false;

function scheduleSessionRefresh() {
  if (sessionTimer) return;
  sessionTimer = setTimeout(async () => {
    // Cleared only after the work finishes, together with the in-flight flag.
    // Clearing it first let two partial refreshes overlap and publish out of
    // order.
    if (sessionRefreshInFlight) { sessionTimer = null; return; }
    sessionRefreshInFlight = true;
    try {
      if (!lastGood) return;
      // The full parse assigns `lastGood` wholesale and runs on its own timer,
      // so the value read BEFORE this await can be superseded during it.
      // Capturing a generation lets a stale result be discarded rather than
      // resurrecting a run the parse just retired, or dropping one it just
      // added — wrong for up to a full safety interval.
      const gen = stateGeneration;
      const finished = lastGood.finishedRuns ?? [];
      const { runs, sessions } = await observeSessions(
        lastGood.runs ?? [], finished, Date.now(),
      );
      if (gen !== stateGeneration) return;   // a full parse landed; it wins
      lastGood = { ...lastGood, runs, sessions };
      publish(lastGood);
    } catch (err) {
      process.stderr.write(`[vault-hud] session refresh error: ${err}\n`);
    } finally {
      sessionRefreshInFlight = false;
      sessionTimer = null;
    }
  }, DEBOUNCE_MS);
}

function startWatcher(w) {
  try {
    w.handle = watch(w.root, { recursive: true });
  } catch (err) {
    process.stderr.write(`[vault-hud] ${w.name} watch failed to start: ${err.message}\n`);
    return scheduleWatcherRestart(w);
  }
  w.retryDelay = WATCH_RETRY_MIN_MS;
  w.handle.on('change', (_event, filename) => {
    if (w.isRelevant(filename)) w.onEvent();
  });
  w.handle.on('error', (err) => {
    process.stderr.write(`[vault-hud] ${w.name} watcher error: ${err.message}\n`);
    scheduleWatcherRestart(w);
  });
  w.handle.on('close', () => {
    if (!shuttingDown) scheduleWatcherRestart(w);
  });
}

/** Tear one watcher down and re-establish it, backing off on repeated failure.
 *  Per watcher, so a failing transcript tree cannot take the vault with it. */
function scheduleWatcherRestart(w) {
  if (shuttingDown || w.retryTimer) return;
  if (w.handle) {
    w.handle.removeAllListeners();
    try {
      w.handle.close();
    } catch {
      /* already dead */
    }
    w.handle = null;
  }
  process.stderr.write(`[vault-hud] restarting ${w.name} watcher in ${w.retryDelay}ms\n`);
  w.retryTimer = setTimeout(() => {
    w.retryTimer = null;
    startWatcher(w);
    // Catch up on anything missed while the watcher was down.
    w.onEvent();
  }, w.retryDelay);
  w.retryDelay = Math.min(w.retryDelay * 2, WATCH_RETRY_MAX_MS);
}

const WATCHERS = [
  watcherState('vault', VAULT, relevant, scheduleRefresh),
  // The transcript tree lives outside the vault, so the recursive watch above
  // never sees it and observed session detail only moved on the 10s safety
  // refresh. Its own predicate and its own retry state; see both above.
  watcherState('transcripts', TRANSCRIPT_ROOT, relevantTranscript, scheduleSessionRefresh),
];

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(keepalive);
  clearInterval(rollover);
  clearInterval(safetyRefresh);
  clearTimeout(debounceTimer);
  clearTimeout(sessionTimer);
  // Every watcher, not one. Closing a single handle left the other running and
  // its retry timer armed, so shutdown did not shut down.
  for (const w of WATCHERS) {
    clearTimeout(w.retryTimer);
    w.handle?.close();
  }
  stopMetrics();
  stopPublishing();
  for (const res of clients) res.end();
  clients.clear();
  for (const res of metricClients) res.end();
  metricClients.clear();
  server.close(() => process.exit(0));
  // Nothing should hold the loop open at this point; bail out if something does.
  setTimeout(() => process.exit(0), 2000).unref();
  process.stderr.write(`[vault-hud] ${signal} received, shutting down\n`);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// This is a KeepAlive daemon behind an always-open window. Dying on an
// unexpected throw costs the user every SSE client and a log full of stack
// traces, so log and keep serving instead. A wedged process is still visible:
// the window flips to OFFLINE.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[vault-hud] uncaught: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[vault-hud] unhandled rejection: ${err?.stack ?? err}\n`);
});
// A server that cannot hold the port can never serve anything, so it dies
// rather than log and continue. Observed 2026-08-10: two daemons were running,
// one holding :5959 and one holding no socket at all. The second had been up
// three days and twenty-three hours, burning twelve minutes of CPU re-parsing
// the whole vault every ten seconds for nobody, and writing into the same log
// file as the real one. Logging and continuing is right for a parse failure,
// where the window degrades to stale data; it is wrong here, where there is no
// window left to degrade.
server.on('error', (err) => {
  process.stderr.write(`[vault-hud] server error: ${err?.stack ?? err}\n`);
  if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') {
    process.stderr.write(
      `[vault-hud] cannot hold ${HOST}:${PORT} (${err.code}); another instance owns it. Exiting.\n`);
    process.exit(1);
  }
});

// The vault can sit untouched across midnight, and `today` plus every
// date-derived number is computed at parse time. Without this the header still
// reads yesterday's date, and yesterday's todos are not yet counted as stale,
// for as long as nobody writes a file.
const DATE_CHECK_MS = 60_000;

const rollover = setInterval(() => {
  if (current && localDate(new Date()) !== current.today) {
    process.stdout.write(`[vault-hud] date rolled to ${localDate(new Date())}, re-parsing\n`);
    refresh(); // publish() broadcasts to every open window
  }
}, DATE_CHECK_MS);
rollover.unref();

// A floor under the watcher. macOS `fs.watch` silently drops events when the vault
// lives on a synced volume (iCloud/Dropbox) or the editor saves via atomic
// temp-swap, which would otherwise leave the window stale until the next event or
// midnight. This periodic re-parse guarantees convergence within one interval; the
// watcher still delivers sub-second updates on the events it does see. Routed
// through the debounced scheduler so it coalesces with watcher bursts, and a parse
// that finds nothing changed republishes identical State cheaply.
const SAFETY_REFRESH_MS = 10_000;
// Straight to refresh(), NOT through scheduleRefresh. Routed through the
// debounce, the safety net cleared and re-armed the very timer it exists to
// backstop, so a sustained event stream postponed the floor along with
// everything else. A floor that can be postponed is not a floor.
const safetyRefresh = setInterval(() => {
  refresh().catch((err) => process.stderr.write(`[vault-hud] refresh error: ${err}\n`));
}, SAFETY_REFRESH_MS);
safetyRefresh.unref();

const parseMs = await refresh();
const shortcutCount = await loadShortcuts();
for (const w of WATCHERS) startWatcher(w);

server.listen(PORT, HOST, () => {
  // Publishing starts only once the port is genuinely held.
  //
  // It ran before listen() at first, which meant a SECOND daemon started while
  // one already owned :5959 would spawn deploy.sh and push to Vercel, and only
  // then hit EADDRINUSE and exit — and process.exit does not reap the bash and
  // vercel children it had already spawned, so the upload completed from a
  // daemon that no longer existed. That is the duplicate-daemon case the exit
  // guard above was added for, arriving through a door beside it.
  const publishing = startPublishing((line) => process.stderr.write(line));
  process.stdout.write(
    `[vault-hud] http://${HOST}:${PORT} · vault ${VAULT} · ` +
      `${current.health.notes} notes · ${shortcutCount} shortcuts · ` +
      `publish ${publishing ? 'on' : 'off'} · parsed in ${parseMs.toFixed(1)}ms\n`
  );
});
