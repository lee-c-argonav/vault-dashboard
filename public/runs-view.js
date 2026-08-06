// runs-view.js — everything both surfaces need to turn a run into a row.
//
// No DOM and no fs, so the browser can import it over the static route and Node
// can import it directly. claims.js takes the same approach for the same reason:
// two readers that reimplement a rule eventually disagree about it.
//
// The clock lives here, never in State. A derived value that changes with the
// wall clock would make every 10-second broadcast look different to app.js's
// stringify diff, and the panel would tear down on a timer.

export const STALE_MS = 20 * 60 * 1000;
const MIN_SAMPLES = 3;

export const LABEL = {
  'needs-input': 'NEEDS YOU',
  blocked: 'BLOCKED',
  running: 'RUNNING',
  paused: 'PAUSED',
  done: 'DONE',
};

export function quietMs(run, now) {
  const t = Date.parse(run.updated);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

// Quiet is a second axis, not a sixth state. A run that asked a question and
// then crashed is still asking; hiding the silence behind the state is what
// would let it claim to be alive.
export function isQuiet(run, now) {
  const q = quietMs(run, now);
  return q === null || q > STALE_MS;
}

export function runState(run) {
  if (run.state === 'done' || run.state === 'paused') return run.state;
  if (run.needsInput.length) return 'needs-input';
  if (run.blockers.length) return 'blocked';
  if (run.units.some((u) => u.state === 'failed')) return 'blocked';
  return 'running';
}

export function eta(units) {
  const d = units
    .filter((u) => u.state === 'done' && u.started && u.ended)
    .map((u) => Date.parse(u.ended) - Date.parse(u.started))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (d.length < MIN_SAMPLES) return null;
  // Only work that can still run. Counting blocked and failed units advertised
  // time remaining on a run that had stopped.
  const remaining = units.filter((u) => u.state === 'todo' || u.state === 'running').length;
  if (remaining === 0) return null;
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length;
  const point = mean * remaining;
  // What is left is a SUM of `remaining` units, and a sum concentrates: its
  // spread grows as sqrt(remaining) while the total grows linearly, so relative
  // uncertainty shrinks as the run gets longer. Scaling the fastest and slowest
  // unit ever seen answers "what if every remaining unit is the extreme one",
  // which nobody asks and which produced a band six times too wide on real data.
  const sd = Math.sqrt(variance * remaining);
  if (sd / point <= 0.2) return { point, measured: d.length };
  return { low: Math.max(0, point - sd), high: point + sd, measured: d.length };
}

export function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

// The sample count stays on the object but is no longer rendered: the estimate
// is already suppressed below MIN_SAMPLES, so the floor is enforced whether or
// not the number is on screen.
export function etaText(e) {
  if (!e) return '';
  if (e.point != null) return `~${humanMs(e.point)} left`;
  return `${humanMs(e.low)}–${humanMs(e.high)} left`;
}

/** How long the run has been going, from its own `started` stamp. */
export function elapsedText(run, now) {
  const t = Date.parse(run.started);
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  // `-- elapsed` reads as a missing measurement. A future start is a writer bug
  // and says so, exactly as the unit renderer does.
  return ms < 0 ? `starts in ${humanMs(-ms)}` : `${humanMs(ms)} elapsed`;
}

export function stateText(run, now) {
  const label = LABEL[runState(run)] || runState(run);
  const q = quietMs(run, now);
  // A missing or malformed stamp is a writer bug, not silence. Rendering it as
  // "QUIET --" both reads as nothing and dims a run that may be perfectly alive.
  if (q === null) return `${label} · NO STAMP`;
  return q > STALE_MS ? `${label} · QUIET ${humanMs(q)}` : label;
}

// Rows only need rebuilding when what they display changes. Runs repaint on
// every 10s broadcast, and a rebuild destroys text selection, so the panel's
// own question could never be copied.
export function rowSignature(run, now) {
  return [
    run.runId, run.goal, run.project, run.machine, run.note,
    runState(run), stateText(run, now),
    run.units.map((u) => u.state).join(''),
    run.needsInput[0]?.question ?? '', run.blockers[0]?.what ?? '',
    JSON.stringify(eta(run.units)),
    // Any clock-derived string the row renders must appear here, or the guard
    // freezes it: a unit timer read "running 5m" for nineteen straight minutes
    // because the signature was invariant in `now`. Bucketed to the minute,
    // which is what humanMs prints at, so a row rebuilds when its text actually
    // changes rather than on every 10-second push.
    run.units.filter((u) => u.state === 'running')
      .flatMap((u) => [bucket(u.started, now),
        ...u.agents.filter((a) => a.state === 'running').map((a) => bucket(a.started, now))]).join(','),
    bucket(run.started, now),
    bucket(run.needsInput[0]?.since ?? run.blockers[0]?.since, now),
  ].join('\u0000');
}

export function counts(units) {
  return { done: units.filter((u) => u.state === 'done').length, total: units.length };
}

function bucket(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 60_000) : '';
}
