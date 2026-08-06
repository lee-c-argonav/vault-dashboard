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
const SPREAD_LIMIT = 2;

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
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (d.length < MIN_SAMPLES) return null;
  const remaining = units.filter((u) => u.state !== 'done').length;
  if (remaining === 0) return null;
  const spread = d[d.length - 1] / d[0];
  if (spread <= SPREAD_LIMIT) {
    return { point: d[Math.floor(d.length / 2)] * remaining, measured: d.length };
  }
  // A wide spread means the median is not predictive. The band is the observed
  // extremes, so it always contains the data that triggered it. A multiplier
  // around the median can be narrower than the samples themselves.
  return { low: d[0] * remaining, high: d[d.length - 1] * remaining, measured: d.length };
}

export function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

export function etaText(e) {
  if (!e) return '';
  if (e.point != null) return `~${humanMs(e.point)} left · n=${e.measured}`;
  return `${humanMs(e.low)}–${humanMs(e.high)} left · n=${e.measured}`;
}

export function stateText(run, now) {
  const label = LABEL[runState(run)] || runState(run);
  return isQuiet(run, now) ? `${label} · QUIET ${humanMs(quietMs(run, now))}` : label;
}

export function counts(units) {
  return { done: units.filter((u) => u.state === 'done').length, total: units.length };
}
