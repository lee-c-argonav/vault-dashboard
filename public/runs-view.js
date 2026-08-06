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

/**
 * The duration cell for a unit OR a sub-agent. One function, because they are
 * the same quantity and were drifting apart: two copies of these branches meant
 * a future agent stamp went unflagged while the identical unit case did not.
 *
 * Returns the text, whether it is an anomaly rather than a measurement, and why.
 */
// A column of numbers stays a column of numbers. Where no duration can be
// computed the cell is a dash, always the same dash and always the same colour
// whatever the state, because the answer is identical in every such case: we
// cannot tell you. The reason lives in the tooltip, not in the column.
const NO_TIME = '—';
const cell = (text, bad, why, state) =>
  ({ text, bad, why, state, cls: `dur is-${state}${bad ? ' is-bad' : ''}` });

export function durationOf(x, now) {
  if (x.state === 'done') {
    if (x.started && x.ended) {
      const ms = Date.parse(x.ended) - Date.parse(x.started);
      if (ms < 0) {
        return cell(NO_TIME, true, `Ended before it started: ${x.ended} precedes ${x.started}`, 'done');
      }
      return cell(humanMs(ms), false, '', 'done');
    }
    return cell(NO_TIME, true, 'Done, but missing a start or end stamp', 'done');
  }
  if (x.state === 'running') {
    if (!x.started) return cell(NO_TIME, true, 'Running, but recorded no start time', 'running');
    const ms = now - Date.parse(x.started);
    if (ms < 0) {
      return cell(NO_TIME, true,
        `Running now, but its recorded start is ${humanMs(-ms)} ahead of the clock (${x.started}), so no elapsed time can be computed. The writing session's clock is wrong.`,
        'running');
    }
    return cell(humanMs(ms), false, '', 'running');
  }
  // failed and blocked are already carried by the dot, so the cell stays empty
  // rather than repeating the state as if it were a measurement.
  return cell('', false, '', x.state);
}

export const UNIT_WINDOW = 5;
export const UNIT_TAIL = 2;

// How many runs get the full treatment. Five, because that is the realistic
// ceiling for concurrent sessions and scrolling a handful is fine. Beyond it the
// rest collapse to one line, which is a safety valve rather than normal use:
// measured at 20 runs, expanding every one produced 7697px of scroll against
// 1294px of panel, leaving 17 of 20 below the fold.
export const EXPAND_LIMIT = 5;

export const URGENCY = { 'needs-input': 0, blocked: 1, running: 2, paused: 3, done: 4 };

/**
 * Which runs render in full and which collapse. Urgency decides, so whatever
 * needs the operator expands first. Shared, because a surface that expanded a
 * different set would be showing a different board.
 */
export function expandSet(runs) {
  const order = [...runs].sort((a, b) => URGENCY[runState(a)] - URGENCY[runState(b)]);
  return new Set(order.slice(0, EXPAND_LIMIT).map((r) => r.runId));
}

/**
 * Which units to show, for any surface. A long run cannot render every unit, so
 * this returns a window around wherever the run currently is plus the final
 * units, with the hidden counts at either end.
 *
 * Shared rather than duplicated: the HUD and the phone page must agree about
 * what a run's progress looks like, and two copies of this arithmetic would not.
 */
export function unitWindow(units) {
  // A failure outranks a running unit. The row is already labelled BLOCKED
  // because of it, so a window pivoted elsewhere hides its own stated reason.
  let pivot = units.findIndex((u) => u.state === 'failed');
  if (pivot === -1) pivot = units.findIndex((u) => u.state === 'running');
  if (pivot === -1) {
    const lastDone = units.map((u) => u.state).lastIndexOf('done');
    pivot = lastDone === -1 ? 0 : lastDone;
  }
  let start = Math.max(0, Math.min(pivot - Math.floor(UNIT_WINDOW / 2), units.length - UNIT_WINDOW));
  start = Math.max(0, start);
  const end = Math.min(units.length, start + UNIT_WINDOW);
  const tailStart = Math.max(end, units.length - UNIT_TAIL);
  return {
    earlier: start,
    visible: units.slice(start, end),
    gap: tailStart - end,
    tail: units.slice(tailStart),
  };
}

/**
 * What the row says is wrong, and how long it has been wrong.
 *
 * A run can be BLOCKED by a failed unit carrying no `blockers[]` entry, so the
 * fallback names the unit. That fallback lived only in the HUD, which meant the
 * phone rendered BLOCKED with no reason at all. Shared, because a surface that
 * synthesised a different reason would be describing a different run.
 */
export function askOf(run, now) {
  const st = runState(run);
  const source = st === 'needs-input' ? run.needsInput[0]
    : st === 'blocked' ? run.blockers[0] : null;
  if (source) {
    const text = source.question ?? source.what;
    const ms = source.since ? now - Date.parse(source.since) : null;
    // A `since` in the future is the same writer bug durationOf reports, and
    // rendering it as `--` said nothing at all.
    const age = !Number.isFinite(ms) ? '' : ms < 0 ? ' · not yet' : ` · ${humanMs(ms)}`;
    return text + age;
  }
  if (st !== 'blocked') return '';
  const failed = run.units.filter((u) => u.state === 'failed');
  if (!failed.length) return '';
  return failed.length === 1
    ? `Unit ${failed[0].id} failed: ${failed[0].label}`
    : `${failed.length} units failed: ${failed.map((u) => u.id).join(', ')}`;
}

export function counts(units) {
  return { done: units.filter((u) => u.state === 'done').length, total: units.length };
}

function bucket(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 60_000) : '';
}
