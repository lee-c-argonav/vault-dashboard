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

/**
 * How far back the finished-run history reaches. Five days, at the operator's
 * ask: "I don't want to see too old sessions either."
 *
 * Only applied when a caller passes a clock to partitionRuns. Expiry is a view
 * decision and the default stays "keep everything", so no caller loses rows by
 * not knowing about this.
 */
export const FINISHED_MAX_AGE_MS = 5 * 86_400_000;

export const LABEL = {
  'needs-input': 'NEEDS YOU',
  blocked: 'BLOCKED',
  running: 'RUNNING',
  paused: 'PAUSED',
  done: 'DONE',
};

/**
 * A few seconds between generating `updated` and the file landing on disk is
 * normal. Beyond this the two are telling different stories.
 */
export const STAMP_LAG_TOLERANCE_MS = 60_000;

/** When this run last actually reported, preferring the filesystem's answer. */
function lastReport(run) {
  const wrote = Date.parse(run.wrote);
  if (Number.isFinite(wrote)) return wrote;
  const claimed = Date.parse(run.updated);
  return Number.isFinite(claimed) ? claimed : null;
}

export function quietMs(run, now) {
  const t = lastReport(run);
  return t === null ? null : Math.max(0, now - t);
}

/**
 * How far a run's own `updated` stamp trails the moment its file was written.
 *
 * Zero for a healthy writer. Large for one whose clock is wrong, which
 * `60-Standards/run-status.md` documents as a recurring failure and warns
 * writers about — and a mistake the spec has to warn about is one the reader
 * should be able to detect rather than silently repeat. Observed 2026-08-10 at
 * 1h46m on a live run, which made the board overstate its silence by that much.
 */
export function stampLagMs(run) {
  const wrote = Date.parse(run.wrote);
  const claimed = Date.parse(run.updated);
  if (!Number.isFinite(wrote) || !Number.isFinite(claimed)) return 0;
  const lag = wrote - claimed;
  return lag > STAMP_LAG_TOLERANCE_MS ? lag : 0;
}

/**
 * A stamp claiming a time the clock has not reached yet.
 *
 * `stampLagMs` above measures `wrote - claimed` and returns 0 when the sign
 * reverses, so it is blind to the opposite and worse error: a writer stamping
 * the FUTURE. Measured on a live run on 2026-08-11 — its `updated` read 16:05Z,
 * then 17:12Z forty minutes later, against a wall clock of 15:11Z, running 120
 * minutes ahead and climbing. Liveness survives it because that is taken from
 * the file's mtime, and every figure derived from `updated` does not.
 *
 * Reported through the SAME chip segment as the lag, never a second one. A
 * five-segment chip already overflowed a 320px screen by 163px and put a
 * sideways scrollbar on the published page; that regression is fixed and is not
 * worth reopening for a rarer fault.
 */
export function stampAheadMs(run, now) {
  const claimed = Date.parse(run.updated);
  if (!Number.isFinite(claimed)) return 0;
  const ahead = claimed - now;
  return ahead > STAMP_LAG_TOLERANCE_MS ? ahead : 0;
}

// Quiet is a second axis, not a sixth state. A run that asked a question and
// then crashed is still asking; hiding the silence behind the state is what
// would let it claim to be alive.
export function isQuiet(run, now) {
  const q = quietMs(run, now);
  return q === null || q > STALE_MS;
}

const isRunning = (u) => u.state === 'running';
const isBlocked = (u) => u.state === 'blocked';
const isFailed = (u) => u.state === 'failed';

export function runState(run) {
  // Guarded here rather than at one call site. The load gauge (now
  // attentionModel) wrapped this in a try/catch claiming the panel was
  // protected; it protected one
  // of six call sites, and the other five reach it unguarded from renderRuns,
  // which has no catch above it — so one half-shaped run for one tick would take
  // down the whole window and every refresh after it.
  if (!run || !Array.isArray(run.units) || !Array.isArray(run.needsInput)
      || !Array.isArray(run.blockers)) return 'running';
  if (run.state === 'done' || run.state === 'paused') return run.state;
  if (run.needsInput.length) return 'needs-input';
  if (run.blockers.length) return 'blocked';
  // A failure is not something the run works around, so it outranks live work.
  if (run.units.some(isFailed)) return 'blocked';
  // A blocked unit only makes the RUN blocked when nothing is still moving.
  //
  // Both halves of this were wrong at different times on 2026-08-10. Before that
  // day no reader branched on `blocked` at all, so a unit waiting on the
  // operator sat invisible while its run read RUNNING. The fix over-corrected:
  // any blocked unit made the whole run read BLOCKED, and the operator caught it
  // the same afternoon — a run with a unit blocked 31 units back and four
  // sub-agents actively running read "BLOCKED · QUIET", which describes a dead
  // run. The block is real and still stated, by blockedNote and by askOf; it is
  // not the run's state while the run is demonstrably working.
  if (run.units.some(isBlocked) && !run.units.some(isRunning)) return 'blocked';
  return 'running';
}

/**
 * "1 BLOCKED", when a run is working and something in it is not.
 *
 * Empty whenever the state already carries it, so the row never says blocked
 * twice.
 */
export function blockedNote(run) {
  if (runState(run) !== 'running') return '';
  const n = run.units.filter(isBlocked).length;
  return n ? `${n} BLOCKED` : '';
}

/**
 * Sort order, which is finer than the state label.
 *
 * A run that is working with something blocked reads RUNNING, and must still
 * sort above a run with nothing wrong: the block is the reason the operator
 * would look at it. URGENCY stays the coarse state ranking that both surfaces
 * group by; this is the tiebreak inside it.
 */
export function sortRank(run) {
  return (URGENCY[runState(run)] ?? 9) * 2 + (blockedNote(run) ? 0 : 1);
}

/**
 * Split runs into what is still live and what is history.
 *
 * `state: "done"` is the whole test. Until 2026-08-10 a finished run only left
 * the board when a session remembered to `mv` its file into `99-Archive/runs/`,
 * which is step 9 of `/close` and which failed on 2026-08-08: the state was set,
 * the move was not, and the run sat on both surfaces for two days. A board whose
 * correctness depends on a manual file move will be wrong sooner or later, so
 * the move is now tidying and the state is the fact.
 *
 * @param {object[]} runs      everything in 15-Runs
 * @param {object[]} archived  everything in 99-Archive/runs, optional
 */
export function partitionRuns(runs, archived = [], now = null) {
  // Archived ids are excluded from `active` as well as deduped out of
  // `finished`. A `cp` instead of a `mv`, or a move interrupted halfway, leaves
  // a copy in 15-Runs still marked `running`; filtering only `finished` rendered
  // that run as live AND as history on the same page.
  const archivedIds = new Set(archived.map((r) => r.runId));
  const active = runs.filter((r) => r.state !== 'done' && !archivedIds.has(r.runId));
  // The archived copy wins on a collision. If a run is in both places the move
  // has happened and the copy left behind in 15-Runs is the stale one.
  const byId = new Map();
  for (const r of runs) if (r.state === 'done') byId.set(r.runId, r);
  for (const r of archived) byId.set(r.runId, r);

  const key = (r) => {
    const t = Date.parse(r.updated);
    return Number.isFinite(t) ? t : null;
  };
  let finished = [...byId.values()];
  if (now !== null) {
    // History is for glancing back over the last few days, not for keeping
    // everything ever run. A run with no usable stamp goes too: it can neither
    // be aged out nor ordered, so keeping it means a row pinned to the bottom of
    // the list permanently.
    finished = finished.filter((r) => {
      const t = key(r);
      return t !== null && now - t <= FINISHED_MAX_AGE_MS;
    });
  }
  // Newest first. An unparseable stamp sorts last rather than poisoning the
  // comparator: Date.parse gives NaN, and NaN in a subtract makes the order
  // depend on input order.
  finished.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
  return { active, finished };
}

/**
 * Match live sessions to the runs that are publishing, and return the ones that
 * are not.
 *
 * The point of the unpublished list is that it is the honest floor of the board.
 * A run file says everything useful about a session, so a session that writes
 * one gets a full row and disappears from here. A session that writes nothing
 * used to appear nowhere at all, which is indistinguishable from not running.
 *
 * Two ways a run claims a session, strongest first:
 *   - it recorded that terminal, which is a fact rather than a guess
 *   - it names the project the session is sitting in, AND the session is older
 *     than the run, because a session cannot have written a run that predates it
 *
 * One session per run and one run per session. Two sessions in one repo with one
 * run between them leaves one unclaimed, which is the true statement: something
 * is running there that is not reporting.
 *
 * Only a live run claims anything. A `done` run whose terminal is still open
 * describes a session that has stopped reporting, and hiding it would hide
 * exactly the case this list exists for.
 */
export function linkSessions(runs, sessions) {
  const taken = new Set();
  const claim = (pred) => {
    for (const s of sessions) {
      if (taken.has(s.pid)) continue;
      if (pred(s)) { taken.add(s.pid); return s; }
    }
    return null;
  };
  // Two passes, so a run that recorded its tty is never outbid by a project
  // guess made on another run's behalf.
  const live = runs.filter((r) => r.state !== 'done');
  const byTty = new Map();
  for (const r of live) {
    if (!r.tty) continue;
    const s = claim((x) => x.tty === r.tty);
    if (s) byTty.set(r.runId, s);
  }
  for (const r of live) {
    if (byTty.has(r.runId) || !r.project) continue;
    const started = Date.parse(r.started);
    const s = claim((x) => {
      if (x.project !== r.project) return false;
      const began = Date.parse(x.since);
      // No usable stamp on either side means no way to rule the pairing out,
      // so allow it: a project match is still evidence.
      if (!Number.isFinite(began) || !Number.isFinite(started)) return true;
      return began <= started;
    });
    if (s) byTty.set(r.runId, s);
  }
  return {
    runs: runs.map((r) => ({ ...r, session: byTty.get(r.runId) ?? null })),
    unpublished: sessions.filter((s) => !taken.has(s.pid)),
  };
}

/**
 * What the ATTENTION instrument measures, and why it is a census and not a sum.
 *
 * TWO GAUGES PRECEDED IT, both replaced for the same defect: one number built
 * from quantities the operator cannot act on.
 *
 * The first was one 2px tick per open todo — 78 of them on this machine. It
 * measured a queue nobody worked from: it did not move when five agents started
 * working, and did not move when a run stopped to ask a question. The todo
 * system is not in use and stays out of this instrument in any form.
 *
 * The second was a weighted sum against a capacity:
 *
 *     LOAD = 3·needsYou + 2·blocked + 2·stalled + 1·context + 0.5·session
 *            + 0.75·√agentsOut,   GAUGE = min(100, 100 · LOAD / 8)
 *
 * Measured on the live board, 2026-08-11: three sessions all working, nothing
 * waiting on the operator, and it read LOAD 70. The same three sessions all
 * STALLED reads 100. The healthiest board this machine shows and the worst one
 * both push the number UP, thirty points apart on a hundred-point scale, and
 * which situation you are in lived only in the caption. Adding "work running
 * fine" to "work stopped on a human" is the defect: the sum is large in the
 * best case and the worst, so the number alone was never actionable. The
 * denominator was the other defect — CAPACITY = 8 was never measured against
 * anything, so the percent claimed a rigor it did not have, and nothing the
 * operator does differs at 66 versus 41.
 *
 * THE MODEL NOW: two populations, never added, because they mean opposite
 * things.
 *
 *   DEMAND — things stopped on a human. A run asking a question, a run
 *   blocked, a session claiming to work and writing nothing. Each one is one
 *   thing to go do, so they are counted, not weighted. The count is the
 *   headline: it is 0 on a healthy board however busy, and every unit of it
 *   is an action.
 *
 *   FLIGHT — things moving on their own. Working sessions, the distinct repos
 *   they spread across, agents still out. Volume, not pressure: it can be
 *   large on a perfectly healthy board, so it renders calm and is never
 *   summed with demand.
 *
 * WHAT SURVIVES from the weighted design, deliberately:
 *   - The severity order needsYou > blocked > stalled — always the defensible
 *     part of the weights. It is now an explicit rank (DEMAND_KINDS order),
 *     not arithmetic: needsYou means only you can restart the work, blocked
 *     may or may not be yours to clear, stalled needs a look first.
 *   - The no-todo rule, above.
 *   - The runState guard: a half-shaped run costs its own term, not the panel.
 *
 * WHAT DIED WITH THE SUM, so it is not rebuilt by accident:
 *   - The weights. They existed to merge unlike terms into one scalar; with
 *     no scalar there is nothing to weight.
 *   - The √fan-out. It existed so one 44-agent fan-out could not drown the
 *     sum; with no sum there is nothing to drown, and the honest figure for
 *     "how many agents are out" is the count.
 *   - The capacity and the percent. If a ceiling is ever justified it will be
 *     a measured one — the session count at which stalls start appearing —
 *     and no such measurement exists yet.
 *
 * WHAT WAS CONSIDERED AND REJECTED:
 *   - A state word (IDLE / WORKING / BLOCKED / SATURATED). heroFor in app.js
 *     is already that instrument, one panel to the right, and it names the
 *     worst thing on the board. A second state word says the same thing twice.
 *   - A trend (now versus ten minutes ago). Neither surface can carry one
 *     honestly: the phone page runs no script under default-src 'none' and is
 *     rebuilt statelessly, and the desktop loses client-side history on every
 *     reload, so the trend would render blank or fabricated exactly when it
 *     was wanted.
 */
export const DEMAND_KINDS = [
  ['needsYou', 'NEEDS YOU', 'hot'],
  ['blocked', 'BLOCKED', 'warn'],
  ['stalled', 'STALLED', 'warn'],
];

const AGENT_OUT = new Set(['running', 'stalled', 'open']);

/**
 * Agents still out for one session, whichever shape it arrives in.
 *
 * The desktop hands sessions carrying an `agents` array; the phone hands the
 * published projection, which strips the array (labels are private) and keeps
 * only the counts. Both surfaces read this model, so it accepts both shapes —
 * the same idempotence toPublicBoard's own agentCounts already needs.
 */
const agentsOutOf = (s) => (Array.isArray(s.agents)
  ? s.agents.filter((a) => AGENT_OUT.has(a.state)).length
  : (s.agentsOut ?? 0));

/**
 * The census both surfaces render: what is stopped on a human, and what is
 * moving on its own. No clock input, so nothing here can freeze stale between
 * pushes, and the same board always produces the same census.
 */
export function attentionModel(state) {
  const runs = state?.runs ?? [];
  const sessions = state?.sessions ?? [];
  // Both halves. A session attached to a run is still a live thread.
  const live = [...sessions, ...runs.map((r) => r?.session).filter(Boolean)];
  const busy = live.filter((s) => s?.status && s.status !== 'idle');
  // Contexts are only countable where the session names its project. The phone
  // projection strips `project` (a relative path is still a path), so there the
  // count is a floor, not a fact — `contextsExact` is what lets the caption
  // refuse to state it rather than publish "1 CONTEXT" about any spread.
  const withProject = busy.filter((s) => s.project);

  const counts = {
    // Items, not runs: one run asking three questions is three things to answer.
    needsYou: runs.reduce((n, r) => n + (r?.needsInput?.length ?? 0), 0),
    // Guarded. `runState` dereferences `needsInput` and `units`, and this
    // renders on every parse including the partial refresh, so a run that is
    // half-shaped for one tick must cost that term and not the whole panel.
    blocked: runs.filter((r) => {
      try { return runState(r) === 'blocked'; } catch { return false; }
    }).length,
    stalled: busy.filter((s) => s.status === 'stalled').length,
    sessions: live.filter((s) => s?.status === 'running').length,
    contexts: new Set(withProject.map((s) => s.project)).size,
    agentsOut: live.reduce((n, s) => n + agentsOutOf(s), 0),
  };

  const demand = DEMAND_KINDS
    .map(([key, label, cls]) => ({ key, label, count: counts[key], cls }))
    .filter((t) => t.count > 0);

  return {
    counts,
    demand,
    demandCount: demand.reduce((n, t) => n + t.count, 0),
    flight: {
      sessions: counts.sessions,
      contexts: counts.contexts,
      // A stalled session still occupies its repo, so it holds a context even
      // though it earns no working-session count.
      contextsExact: busy.length > 0 && withProject.length === busy.length,
      agentsOut: counts.agentsOut,
    },
  };
}

/**
 * The one-line caption: demand first in severity order — what to go do — then
 * flight, which is context. Counts a person can verify by looking at the board,
 * with real plurals: the old caption's "1 AGENTS OUT" was a standing typo.
 */
export function attentionCaption(m) {
  const parts = m.demand.map((t) => `${t.count} ${t.label}`);
  const f = m.flight;
  if (f.sessions) parts.push(`${f.sessions} SESSION${f.sessions === 1 ? '' : 'S'}`);
  if (f.contexts && f.contextsExact) {
    parts.push(`${f.contexts} CONTEXT${f.contexts === 1 ? '' : 'S'}`);
  }
  // "RUNNING", not "OUT". Out is jargon — it means dispatched and not yet
  // returned, which a reader has to be told rather than shown, and the operator
  // asked what it meant. The rows already say "STILL RUNNING", so this is also
  // the board agreeing with itself. The internal field keeps the name
  // `agentsOut`, because renaming it reaches the projection and the digest and
  // buys a reader nothing.
  if (f.agentsOut) parts.push(`${f.agentsOut} AGENT${f.agentsOut === 1 ? '' : 'S'} RUNNING`);
  return parts.join(' · ');
}

/** How long a session has been up, for the one line it gets. */
export function sessionText(s, now) {
  const t = Date.parse(s.since);
  const up = Number.isFinite(t) ? humanMs(Math.max(0, now - t)) : '--';
  return `${s.where || s.project || 'unknown'} · ${up}`;
}

/**
 * What a session is doing, in the slot a run row uses for its note.
 *
 * Says LAST rather than naming a current tool, because a tool call reaches disk
 * with its result and not before it — so the current tool is not knowable and a
 * row claiming otherwise would be inventing it.
 */
export function sessionActivity(s) {
  const bits = [];
  if (s.status === 'stalled') bits.push('SILENT');
  // 'open' is in the out set too. agentState returns it for an agent whose
  // transcript has no message yet, which is precisely a just-dispatched one —
  // counting it as done reported "01 AGENTS DONE" about an agent two seconds old.
  const OUT = new Set(['running', 'stalled', 'open']);
  const out = (s.agents ?? []).filter((a) => OUT.has(a.state));
  // No fan-out clause here. The block below this line names the agents and states
  // the split, so putting the same counts in the activity line said it twice in
  // consecutive lines. This carries only what that block cannot: silence, the
  // last tool, and the branch.
  if (s.agentsCapped) bits.push(`+${s.agentsCapped} MORE`);
  if (s.lastTool) bits.push(`LAST ${s.lastTool.replace(/^mcp__[^_]+__/, '')}`);
  if (s.branch) bits.push(s.branch);
  return bits.join(' · ');
}

/**
 * Whether this session could be the one that wrote this run. The same two rules
 * `linkSessions` claims by, in the same order, so a session cannot be matched to
 * one run for a row and a different one for its context.
 */
function couldOwn(session, run) {
  if (run.tty && session.tty) return run.tty === session.tty;
  if (!run.project || run.project !== session.project) return false;
  const began = Date.parse(session.since);
  // run.STARTED, matching linkSessions exactly. This compared run.updated at
  // first, which is a different rule wearing the same description: a run started
  // at 09:00 and still being written at 10:05 would be refused by linkSessions
  // for a session that began at 10:00, keeping `session: null` — and null is
  // precisely what the guard in sessionContext treats as "unclaimed, fair game",
  // so the session was then credited with a run that predates it.
  const started = Date.parse(run.started);
  if (!Number.isFinite(began) || !Number.isFinite(started)) return true;
  return began <= started;
}

/**
 * What a session that is publishing nothing can still be said to have done.
 *
 * A bare "NO STATUS" is the correct floor for a session nobody has heard from,
 * and it is the wrong answer for one that published a full run and closed it
 * out a minute ago. Finishing a run releases the session — `linkSessions` only
 * lets a live run claim one — so the best-described session on the board becomes
 * the emptiest row on it at the moment its work completes. Reported by the
 * operator on 2026-08-10 against his own session.
 *
 * @param {object[]} runs  every run, finished ones included
 * @returns {string} '' when there is genuinely nothing to say
 */
export function sessionContext(session, runs, now) {
  const stamp = (r) => Date.parse(r.updated);
  const mine = runs.filter((r) =>
    // A run linkSessions already gave to a DIFFERENT session is that session's
    // work, not this one's. Two sessions in one repo with one run between them
    // would otherwise both be credited with it — the unclaimed one reading
    // "last wrote 3m ago" about a run it never touched. Runs carrying no
    // `session` at all (finished ones, and anything read before linking) stay
    // eligible, which is the common case this function exists for.
    (!r.session || r.session.pid === session.pid)
    && couldOwn(session, r) && Number.isFinite(stamp(r)));
  if (!mine.length) return '';
  // A recorded tty is a fact and outranks a project guess whatever the dates
  // say, matching linkSessions. Within each rule, most recent wins.
  const byTty = mine.filter((r) => r.tty && r.tty === session.tty);
  const pool = byTty.length ? byTty : mine;
  const best = pool.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
  const ago = humanMs(Math.max(0, now - stamp(best)));
  const verb = best.state === 'done' ? 'finished' : 'last wrote';
  return `${best.goal} — ${verb} ${ago} ago`;
}

/**
 * Which completed units carry a start and end shared with another unit.
 *
 * A session that writes its units in one batch at the end stamps them all with
 * the same pair, and the board then shows the same duration on every row: five
 * units all reading 7m. The operator asked the right question about it on
 * 2026-08-10 — "how can everything be 7 minutes?" — and the answer is that they
 * are one measurement copied, not five measurements that agreed.
 *
 * Units that genuinely ran concurrently produce the same pattern and are treated
 * the same way, which is correct: two units that started and ended together are
 * one sample of how long that work takes, whatever the reason.
 *
 * Keyed on the unit OBJECT, never on `u.id`. runs.js drops units without an id
 * so real vault data always has one, but this module is imported directly by
 * tests and by anything else holding unit-shaped data, and an id-keyed set folds
 * every id-less unit onto one key: a single duplicate pair would then flag the
 * whole run and empty its estimate.
 *
 * @returns {Set<object>} the units involved
 */
export function batchStamped(units) {
  const seen = new Map();
  for (const u of units) {
    if (u.state !== 'done' || !u.started || !u.ended) continue;
    const key = `${u.started}|${u.ended}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(u);
  }
  const out = new Set();
  for (const group of seen.values()) {
    if (group.length > 1) for (const u of group) out.add(u);
  }
  return out;
}

export function eta(units) {
  // Copied stamps are excluded outright rather than de-duplicated to one sample.
  // The estimate's whole premise is spread measured across independent units,
  // and a batch-written run gives no evidence about spread at all; counting one
  // of them would state a confidence the data does not support.
  const batched = batchStamped(units);
  const d = units
    .filter((u) => u.state === 'done' && u.started && u.ended && !batched.has(u))
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

/**
 * Time left on a fan-out, from the sub-agents that have already returned.
 *
 * Reuses `eta` rather than reimplementing it: an agent is a unit as far as the
 * estimator is concerned — a thing with a start, an end, and a state — and the
 * spread model does not care what produced the samples. A returned agent's end
 * is its file's last write, which is the same clock its start comes from.
 */
export function agentEta(agents, now = Date.now()) {
  const list = agents ?? [];
  // `eta` models a QUEUE: its estimate is `mean × remaining`, which is right for
  // units that run one after another. Sub-agents run at the same time, so that
  // multiplier overstated by 3x to 10x — measured against ten real fan-outs, a
  // 44-agent session with 5 out read "27m-1h13m left" against a true 7m, and the
  // error grows with the number out, so it was worst exactly when an estimate
  // matters. What is left on a parallel batch is what the slowest straggler has
  // still to run, not the sum of all of them.
  //
  // STALLED AGENTS ARE EXCLUDED. transcripts.js defines stalled as one abandoned
  // when its parent died and calls counting it as running "the defect this module
  // exists to remove"; feeding it here reintroduced that in another column, so a
  // fan-out with one agent stalled 90m advertised "~7m left".
  const done = list.filter((a) => a.state === 'done' && a.started && a.movedAt)
    .map((a) => Date.parse(a.movedAt) - Date.parse(a.started))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (done.length < MIN_SAMPLES) return null;

  const live = list.filter((a) => a.state === 'running' || a.state === 'open');
  if (!live.length) return null;

  const mean = done.reduce((a, b) => a + b, 0) / done.length;
  const variance = done.reduce((a, b) => a + (b - mean) ** 2, 0) / done.length;
  const sd = Math.sqrt(variance);
  // How long the one that has been out longest still has, on the mean. Elapsed
  // is subtracted because a running agent has already served part of its time —
  // `eta` ignores that, which a queue can absorb and a batch cannot.
  const oldest = Math.max(...live.map((a) => {
    const t = Date.parse(a.started);
    return Number.isFinite(t) ? now - t : 0;
  }));
  // OVERRUN. When the one that has been out longest has already run past the
  // top of the range, the returned agents no longer predict it — it is an
  // outlier and the sample says nothing about how much it has left.
  //
  // Clamping at zero instead produced "<1m–<1m left" beside an agent showing
  // +19m, which is the estimator asserting confidence it does not have, about
  // the exact case where it has least. The operator caught it on the board.
  // What is reported instead is the fact that IS known: how far past the usual
  // span it has gone.
  const high = mean + sd - oldest;
  if (high <= 0) return { over: oldest - mean, usual: mean };
  const point = Math.max(0, mean - oldest);
  const low = Math.max(0, mean - sd - oldest);
  return { point: sd === 0 ? point : null, low, high };
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

/**
 * @param {object} run
 * @param {number} now
 * @param {object|null} session  the live session writing this run, if one is visible
 */
/**
 * True when a run claims to be running and has nothing left to run.
 *
 * "5 of 5 done" beside "RUNNING" is a contradiction on the face of the row, and
 * the operator read it as one on 2026-08-10. Both halves are true of the file:
 * every unit is done and the run has not set `state: "done"`. It means the run
 * is closing out, or that it finished and never said so. Either way the row
 * should say it rather than leave the two facts to be reconciled by eye.
 */
function allUnitsDone(run) {
  return run.state === 'running'
    && run.units.length > 0
    && run.units.every((u) => u.state === 'done');
}

export function stateText(run, now, session = null) {
  const label = LABEL[runState(run)] || runState(run);
  const blocked = blockedNote(run);
  let head = blocked ? `${label} · ${blocked}` : label;
  if (allUnitsDone(run)) head = `${head} · ALL UNITS DONE`;
  // A stamp that trails its own file is named, because every duration on the row
  // derived from it is wrong by that much and the writer is the only one who can
  // fix it.
  // One segment, two directions. AHEAD outranks BEHIND: a stamp in the future
  // is the writer reading no clock at all, which makes every other figure it
  // wrote suspect, where a lag only makes them late.
  const ahead = stampAheadMs(run, now);
  const lag = stampLagMs(run);
  if (ahead) head = `${head} · STAMPS ${humanMs(ahead)} AHEAD`;
  else if (lag) head = `${head} · STAMPS ${humanMs(lag)} BEHIND`;
  const q = quietMs(run, now);
  // A missing or malformed stamp is a writer bug, not silence. Rendering it as
  // "QUIET --" both reads as nothing and dims a run that may be perfectly alive.
  if (q === null) return `${head} · NO STAMP`;
  if (q <= STALE_MS) return head;
  // QUIET and NO UPDATE are different facts and were rendered as one.
  //
  // QUIET has always meant "this may be dead", which is the right reading when
  // the only evidence is a stamp that stopped moving. It is the wrong reading
  // when the session is sitting right there in the process table: that run is
  // alive and not reporting, which is a writer problem, not a dead run. The
  // operator caught this on 2026-08-10 — "it is not really quiet" — about a run
  // whose session had been alive throughout.
  return session
    ? `${head} · NO UPDATE ${humanMs(q)}`
    : `${head} · QUIET ${humanMs(q)}`;
}

// Rows only need rebuilding when what they display changes. Runs repaint on
// every 10s broadcast, and a rebuild destroys text selection, so the panel's
// own question could never be copied.
export function rowSignature(run, now) {
  return [
    run.runId, run.goal, run.project, run.machine, run.note,
    // `run.session` is part of what the row renders now: it decides QUIET versus
    // NO UPDATE. Left out of the signature, a run whose session exits keeps
    // claiming the session is alive until something else changes.
    runState(run), stateText(run, now, run.session), run.session?.pid ?? '',
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

export function durationOf(x, now, batched = null) {
  if (x.state === 'done') {
    if (x.started && x.ended) {
      const ms = Date.parse(x.ended) - Date.parse(x.started);
      if (ms < 0) {
        return cell(NO_TIME, true, `Ended before it started: ${x.ended} precedes ${x.started}`, 'done');
      }
      // The number stays, because it is the only number there is. What changes
      // is the claim being made about it: this is not an independent
      // measurement, and every other unit sharing the pair shows the same
      // figure for the same reason.
      if (batched?.has(x)) {
        return cell(humanMs(ms), true,
          `Shares its exact same start and end with another unit, so this is one measurement shown on several rows rather than a duration measured for this unit. Usually a run stamped in one batch at the end instead of at each unit boundary. Excluded from the estimate.`,
          'done');
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
    // The leading + marks the tense. This column carries two different claims —
    // "took 3m and finished" and "has been running 47m so far" — in the same
    // format, and colour was the only thing separating them at 1.60:1. One
    // character says which, survives monochrome, and needs no legend.
    return cell(`+${humanMs(ms)}`, false, '', 'running');
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
 * One rank over runs and sessions together.
 *
 * The two used to live in separate sections and never needed comparing. Merged,
 * they do, and `URGENCY` cannot answer it: a session state is not one of its
 * five keys, so `URGENCY[undefined]` is `undefined`, and `undefined - undefined`
 * is NaN — which makes the sort order depend on input order rather than failing
 * visibly.
 *
 * Interleaved rather than stacked, because a stalled session outranks a merrily
 * running run: one of them may be dead and the other is fine.
 *
 *   0/1 needs-input run      5 working session
 *   2/3 blocked run          6/7 paused run
 *   3   stalled session      7   idle session
 *   4/5 running run          8/9 done run
 */
const SESSION_RANK = { stalled: 3, running: 5, idle: 7, unknown: 9 };

export function mergedRank(item) {
  if (item.runId) return (URGENCY[runState(item)] ?? 9) * 2 + (blockedNote(item) ? 0 : 1);
  return SESSION_RANK[item.status] ?? 9;
}

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
  // Then wherever the run actually is. A running unit outranks a blocked one
  // here, the opposite of runState's ranking, and deliberately: a blocked unit's
  // identity is already carried in words by askOf, so the window is free to
  // stay on the live work. A run with a unit blocked 30 units back and four
  // sub-agents running now should show the sub-agents and say what is blocked.
  if (pivot === -1) pivot = units.findIndex((u) => u.state === 'running');
  if (pivot === -1) pivot = units.findIndex((u) => u.state === 'blocked');
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
  // `running` is here as well as `blocked` because a run that is working with
  // something blocked says "1 BLOCKED" in its state, and a count with no name is
  // not actionable. Gating this on `blocked` alone silently dropped the line
  // "Unit R4 blocked: the visual review, shot and waiting on you" at the moment
  // runState stopped calling that run blocked.
  if (st !== 'blocked' && st !== 'running') return '';
  // Failed first, then blocked. A run can be BLOCKED by either with no
  // `blockers[]` entry naming it, and a row that says BLOCKED and gives no
  // reason is the defect this fallback exists for.
  const name = (units, word) => (units.length === 1
    ? `Unit ${units[0].id} ${word}: ${units[0].label}`
    : `${units.length} units ${word}: ${units.map((u) => u.id).join(', ')}`);
  const failed = run.units.filter((u) => u.state === 'failed');
  if (failed.length) return name(failed, 'failed');
  const blocked = run.units.filter((u) => u.state === 'blocked');
  if (blocked.length) return name(blocked, 'blocked');
  return '';
}

export function counts(units) {
  return { done: units.filter((u) => u.state === 'done').length, total: units.length };
}

function bucket(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 60_000) : '';
}
