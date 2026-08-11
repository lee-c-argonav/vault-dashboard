// vault-hud client — renders State, repaints on SSE, draws the lattice.
// Every vault-authored string arrives here either as pre-escaped `.html` from the
// parser or is inserted with textContent. Nothing is built by concatenating raw text.

// Shared with status-page/build.js, which renders the same runs for the phone.
// Both import it so the two surfaces cannot disagree about whether a run is
// waiting on you. Liveness lives here, not in State: State is diffed by
// stringify below, so a clock-derived field would look changed on every push.
import { runState, quietMs, stateText, rowSignature, eta, humanMs, etaText, elapsedText, durationOf, unitWindow, expandSet, URGENCY, sortRank, blockedNote, batchStamped, askOf, counts, sessionText, sessionActivity, mergedRank, attentionModel, attentionCaption, agentEta, contextBreakdown, clockAt, finishClock, goalEta, goalEtaText, fanoutStrip }
  from './runs-view.js';

const STATE_SOURCES = ['/api/state'];

const $ = (id) => document.getElementById(id);

const pad2 = (n) => String(Math.abs(n)).padStart(2, '0');
const noteName = (source) => source.split('/').pop().replace(/\.md$/, '');

/** Markdown-ish source text → plain words, for tooltips and the hero sub-line. */
const plain = (text) =>
  text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Insert parser-escaped HTML. Only ever called with State `.html` fields. */
function htmlNode(tag, className, html) {
  const node = document.createElement(tag);
  node.className = className;
  node.innerHTML = html;
  return node;
}

/** Render a raw markdown-ish string (focus) without innerHTML: split on `code` spans. */
function inlineCode(target, raw) {
  target.replaceChildren();
  for (const [i, part] of raw.split('`').entries()) {
    if (part === '') continue;
    target.append(i % 2 ? el('code', null, part) : document.createTextNode(part));
  }
}

function openNote(url) {
  if (url) window.location.href = url;
}

function clickable(node, url) {
  if (!url) return node;
  // Marks the row as interactive so CSS can scope the pointer cursor and hover
  // state to rows that actually navigate.
  node.dataset.clickable = '';
  node.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // those carry their own behaviour
    openNote(url);
  });
  return node;
}

/** Refill a scroller without throwing the reader back to the top on every push. */
function fill(hostId, rows, empty) {
  const host = $(hostId);
  const top = host.scrollTop;
  host.replaceChildren(...(rows.length ? rows : [el('div', 'empty-row', empty)]));
  host.scrollTop = top;
}

// ── change flash ─────────────────────────────────────────────────────────────

const signatures = new Map();

/**
 * How this slice of State compares to the last render. `first` is tracked
 * separately from `changed` because the two callers want opposite things from it:
 * the lattice must build on first sight, and a panel must not flash on it.
 */
function diff(key, data) {
  const sig = JSON.stringify(data);
  const previous = signatures.get(key);
  signatures.set(key, sig);
  return { first: previous === undefined, changed: previous !== sig };
}

function flashIfChanged(panel, data) {
  const d = diff(panel.id, data);
  if (d.first || !d.changed) return;
  panel.classList.remove('flash');
  void panel.offsetWidth; // restart the transition
  panel.classList.add('flash');
  setTimeout(() => panel.classList.remove('flash'), 150);
}

// ── header ───────────────────────────────────────────────────────────────────

function renderHeader(state) {
  $('h-vault').textContent = state.vaultName;
  $('h-date').textContent = state.today;
  $('h-day').textContent = state.todayLabel;

  // Read from the attention model, so the header and the gauge can never
  // disagree about how many sessions are alive.
  //
  // RUNS, SESSIONS and AGENTS are volume and stay neutral however large they get:
  // eight agents working is not a problem. STALLED and NEEDS YOU go orange the
  // moment they are non-zero, because both mean something has stopped.
  const att = attentionModel(state);
  const cells = [
    ['s-runs', (state.runs ?? []).length, false],
    ['s-sessions', att.counts.sessions, false],
    ['s-agents', att.counts.agentsOut, false],
    ['s-stalled', att.counts.stalled, true],
    ['s-needs', att.counts.needsYou, true],
  ];
  for (const [id, value, hotWhenSet] of cells) {
    const node = $(id);
    node.textContent = pad2(value);
    node.className = 'cell-v' + (value === 0 ? ' zero' : hotWhenSet ? ' hot' : '');
  }
  flashIfChanged($('p-head'), cells.map((c) => c[1]));
}

// ── focus + load gauge ───────────────────────────────────────────────────────

function renderFocus(state) {
  const eyebrow = $('focus-eyebrow');
  const text = $('focus-text');

  if (state.focus) {
    const { label, detail } = state.focus;
    eyebrow.textContent = detail ? label : 'TODAY';
    text.className = 'focus-text';
    inlineCode(text, detail || label);
    text.title = plain(detail || label);
  } else {
    eyebrow.textContent = 'TODAY';
    text.className = 'focus-text empty';
    text.textContent = 'NO FOCUS SET FOR ' + state.today;
    text.title = '';
  }
  $('focus-src').textContent = `40-DAILY/${state.today}`;

  // The attention census. One discrete mark per real thing, demand left of the
  // divider and flight right of it — never one bar summing both, because the
  // sum was large on the healthiest board this machine shows (LOAD 70 from
  // three working sessions, measured 2026-08-11) and on the worst (100 from
  // the same three stalled). See attentionModel in runs-view.js for the full
  // model and what it replaced.
  //
  // Discrete marks rather than proportional segments: a weighted segment's
  // width could not be read back to a count (a wide one might be three repos
  // or one question), while marks are countable at a glance and the colour
  // says which kind. The number beside the strip is the demand count — things
  // stopped on a human — which is the one figure with an action in it.
  const att = attentionModel(state);
  const n = $('load-n');
  n.textContent = pad2(att.demandCount);
  n.classList.toggle('hot', att.demandCount > 0);
  n.title = att.demandCount
    ? `${att.demandCount} stopped on a human: `
      + att.demand.map((t) => `${t.count} ${t.label.toLowerCase()}`).join(', ')
    : 'Nothing is stopped waiting on a human';

  // The census stays readable past subitizing by stopping, not shrinking: 16
  // marks × 8px is 128px against a ≥300px track, and beyond that the number
  // and the caption are the instrument — the counts stay exact there while a
  // 20th mark adds nothing a glance can use.
  const MARK_CAP = 16;
  const mark = (cls, title) => {
    const m = el('i', `mk is-${cls}`);
    m.title = title;
    return m;
  };
  const strip = $('load-strip');
  const kids = [];
  for (const t of att.demand) {
    for (let i = 0; i < t.count && kids.length < MARK_CAP; i += 1) {
      kids.push(mark(t.cls, `${t.count} ${t.label}`));
    }
  }
  const f = att.flight;
  if (kids.length && f.sessions) kids.push(el('i', 'load-div'));
  for (let i = 0; i < Math.min(f.sessions, MARK_CAP); i += 1) {
    kids.push(mark('live', `${f.sessions} session${f.sessions === 1 ? '' : 's'} working`));
  }
  strip.replaceChildren(...kids);
  $('load-cap').textContent = attentionCaption(att) || 'nothing running';

  // The census, broken out by context. The caption above is the aggregate and
  // cannot be acted on — it says three contexts and not which three. This fills
  // the space the panel already had with the answer to "where is it".
  // Capped. The panel is a fixed height in the grid, so an uncapped list is a
  // list that overlaps the focus line the moment a fourth repo appears.
  const LOAD_CTX_MAX = 4;
  const all = contextBreakdown(state);
  const ctx = all.slice(0, LOAD_CTX_MAX);
  const most = Math.max(1, ...ctx.map((c) => c.sessions + c.agents));
  $('load-ctx').replaceChildren(...ctx.map((c) => {
    const line = el('div', `lc${c.demand ? ' has-demand' : ''}`);
    line.append(el('span', 'lc-name', c.project));

    // One mark per thing, demand first and hot. Countable, where a proportional
    // bar is not: a wide segment might be three sessions or one question.
    const marks = el('span', 'lc-marks');
    for (let i = 0; i < c.needsYou; i++) marks.append(el('i', 'mk is-hot'));
    for (let i = 0; i < c.blocked + c.stalled; i++) marks.append(el('i', 'mk is-warn'));
    for (let i = 0; i < c.sessions; i++) marks.append(el('i', 'mk is-live'));
    line.append(marks);

    const bits = [];
    if (c.sessions) bits.push(`${c.sessions} SESSION${c.sessions === 1 ? '' : 'S'}`);
    if (c.agents) bits.push(`${c.agents} AGENT${c.agents === 1 ? '' : 'S'}`);
    if (c.needsYou) bits.push(`${c.needsYou} NEEDS YOU`);
    if (c.blocked) bits.push(`${c.blocked} BLOCKED`);
    if (c.stalled) bits.push(`${c.stalled} STALLED`);
    line.append(el('span', 'lc-n', bits.join(' · ')));

    // A share bar, scaled to the busiest context rather than to an invented
    // ceiling — the same reason the census strip has no track.
    const bar = el('span', 'lc-bar');
    const fill = el('i');
    fill.style.width = `${(100 * (c.sessions + c.agents)) / most}%`;
    bar.append(fill);
    line.append(bar);
    return line;
  }));
  if (all.length > ctx.length) {
    const more = el('div', 'lc lc-more');
    more.append(el('span', 'lc-name', `+${all.length - ctx.length} MORE`));
    $('load-ctx').append(more);
  }
  // Everything this panel renders derives from these counts, so the flash
  // signature is exactly them: number, marks and caption cannot change without
  // moving one.
  flashIfChanged($('p-focus'), [state.focus,
    att.demand.map((t) => `${t.key}${t.count}`).join(','),
    f.sessions, f.contexts, f.agentsOut,
    // The breakdown is clock-free, but its counts are not in any term above:
    // work moving between contexts changes this panel and nothing else.
    ctx.map((c) => `${c.project}${c.sessions}${c.agents}${c.demand}`).join(',')]);
}

// ── hero: the one number that says what is wrong ──────────────────────────────

/**
 * The one number that most deserves the biggest type on the board.
 *
 * Ordered by what has STOPPED, then by what is moving. Every branch used to read
 * from the todo system — OVERDUE, DUE TODAY, STALE, OPEN — which no longer
 * reflects anything anyone works from.
 */
function heroFor(state) {
  const runs = state.runs ?? [];
  const live = [...(state.sessions ?? []), ...runs.map((r) => r.session).filter(Boolean)];
  const OUT = new Set(['running', 'stalled', 'open']);

  const asks = runs.flatMap((r) => (r.needsInput ?? []).map((q) => ({ q, r })));
  if (asks.length) {
    return {
      label: 'NEEDS YOU',
      n: asks.length,
      sub: clip(plain(asks[0].q.question ?? asks[0].r.goal ?? ''), 52),
    };
  }

  const stalled = live.filter((s) => s.status === 'stalled');
  if (stalled.length) {
    return {
      label: 'STALLED',
      n: stalled.length,
      sub: `${clip(stalled[0].name || stalled[0].project || 'a session', 28)} — BUSY AND WRITING NOTHING`,
    };
  }

  const blocked = runs.filter((r) => runState(r) === 'blocked');
  if (blocked.length) {
    return { label: 'BLOCKED', n: blocked.length, sub: clip(plain(blocked[0].goal ?? ''), 52) };
  }

  const out = live.flatMap((s) => (s.agents ?? []).filter((a) => OUT.has(a.state)));
  if (out.length) {
    // Oldest first: the one that has been out longest is the one worth naming.
    const oldest = out.slice().sort((a, b) =>
      String(a.started ?? '').localeCompare(String(b.started ?? '')))[0];
    return {
      label: 'AGENTS RUNNING',
      n: out.length,
      sub: oldest?.label ? `OLDEST — ${clip(oldest.label, 44)}` : '',
    };
  }

  const working = live.filter((s) => s.status === 'running');
  if (working.length) {
    const contexts = new Set(working.map((s) => s.project || '—')).size;
    return {
      label: 'RUNNING',
      n: working.length,
      calm: true,
      sub: `${pad2(contexts)} ${contexts === 1 ? 'CONTEXT' : 'CONTEXTS'} · NOTHING WAITING ON YOU`,
    };
  }

  return { label: 'IDLE', n: live.length, calm: true, sub: 'NO AGENT IS RUNNING' };
}

function renderHero(state) {
  const hero = heroFor(state);
  $('p-hero').classList.toggle('calm', !!hero.calm);
  $('hero-label').textContent = hero.label;
  $('hero-num').textContent = pad2(hero.n);
  const sub = $('hero-sub');
  sub.textContent = hero.sub;
  sub.title = hero.sub;
  flashIfChanged($('p-hero'), [hero.label, hero.n, hero.sub]);
}

// ── runs ─────────────────────────────────────────────────────────────────────

/**
 * Ask the server to focus the Terminal tab this run is executing in. Sends only
 * the run id; the server resolves the tty from the run's own file and validates
 * it before it reaches osascript. Feedback reuses the shortcut bar's vocabulary:
 * a brief orange confirm, a brief amber miss.
 */
async function openRunTerminal(runId, row) {
  // Re-find by id each time. The round trip is ~2.2s, a rebuild can happen
  // inside it, and a class written to a detached node is feedback nobody sees.
  const find = () => document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`) ?? row;
  find().classList.add('busy');
  let ok = false;
  try {
    const res = await fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Hud': '1' },
      body: JSON.stringify({ id: `run:${runId}` }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  const live = find();
  live.classList.remove('busy');
  // A miss is normal: the session may have been closed since it recorded its
  // tty. Say so briefly rather than failing silently or throwing a dialog.
  live.classList.add(ok ? 'hit' : 'miss');
  setTimeout(() => find().classList.remove('hit', 'miss'), 900);
}

/**
 * The units around wherever the run currently is. A 28-unit run rendered in full
 * is a 28-row list, and three of those fill the column, so the list is windowed
 * on the running unit and the hidden counts are shown at either end rather than
 * dropped silently.
 */
function unitList(units, now) {
  const wrap = el('div', 'run-units');
  const w = unitWindow(units);
  // Computed over the whole run, not the visible window: two units sharing a
  // stamp pair may sit either side of the fold.
  const batched = batchStamped(units);

  const renderUnit = (u) => {
    const line = el('div', `run-u${u.state === 'todo' ? '' : ` is-${u.state}`}`);
    line.append(el('i', 'run-u-dot'));
    const uid = el('span', 'run-u-id', u.id);
    uid.title = u.id;
    line.append(uid);
    const label = el('span', 'run-u-label', u.label || '—');
    label.title = `${u.id} ${u.label} — ${u.state}`;
    line.append(label);

    const d = durationOf(u, now, batched);

    // A cluster on every unit that fanned out, so you can see that it did
    // without the agent names costing a row each.
    // Only where the names are not already listed below. On the running unit the
    // agents render in full underneath, so a cluster there is the same fact twice.
    if (u.agents.length && u.state !== 'running') {
      const cluster = el('span', 'run-u-agents');
      for (const a of u.agents) {
        const dot = el('i', `run-a-dot${a.state === 'todo' ? '' : ` is-${a.state}`}`);
        dot.title = `${a.label} — ${a.state}`;
        cluster.append(dot);
      }
      cluster.title =
        `${u.agents.filter((a) => a.state === 'done').length} of ${u.agents.length} agents done`;
      line.append(cluster);
    }
    const ut = el('span', d.cls, d.text);
    if (d.why) ut.title = d.why;
    line.append(ut);
    wrap.append(line);

    // Names only under the unit actually running, which is at most one or two.
    // Every unit's agents at once would swamp a list built to be readable.
    if (u.state === 'running' && u.agents.length) {
      for (const a of u.agents) {
        const sub = el('div', `run-a${a.state === 'todo' ? '' : ` is-${a.state}`}`);
        sub.append(el('i', 'run-a-dot'));
        const alabel = el('span', 'run-a-label', a.label);
        alabel.title = a.label;
        sub.append(alabel);
        const ad = durationOf(a, now, null);
        const atn = el('span', ad.cls, ad.text);
        if (ad.why) atn.title = ad.why;
        sub.append(atn);
        wrap.append(sub);
      }
    }
  };
  if (w.earlier > 0) wrap.append(el('div', 'run-u-more', `+${w.earlier} earlier`));
  for (const u of w.visible) renderUnit(u);
  if (w.gap > 0) wrap.append(el('div', 'run-u-more', `+${w.gap} later`));
  for (const u of w.tail) renderUnit(u);
  return wrap;
}

function runRow(r, now, expanded = true) {
  const st = runState(r);
  const nostamp = quietMs(r, now) === null;
  // `is-warn` marks a run that is working with something blocked. Without it
  // the row is indistinguishable from ordinary work and the amber vocabulary
  // used everywhere else for a block would not apply to it.
  const row = el('div', `run is-${st}${blockedNote(r) ? ' is-warn' : ''}${nostamp ? ' is-nostamp' : ''}`);

  const top = el('div', 'run-top');
  // A run gets a mark too, and a LARGER one than a session's. A run outranks a
  // session on this panel by design, and until now only sessions carried the
  // at-a-glance "this is alive" signal — a run's state lived in a chip at the
  // far right of the row, which is a read rather than a glance.
  //
  // Phase-offset by the runId, for the reason the session dot is offset by pid:
  // every row is rebuilt at once, so without it the whole column beats in
  // lockstep and reads as one signal. Derived, so it survives a rebuild
  // identically rather than jumping.
  const mark = el('i', 'run-dot');
  const seed = [...String(r.runId || '')].reduce((n, c) => n + c.charCodeAt(0), 0);
  mark.style.animationDelay = `-${(seed % 24) / 10}s`;
  top.append(mark);
  const goal = el('span', 'run-goal', r.goal);
  goal.title = r.goal;
  top.append(goal, el('span', 'run-proj', r.machine || ''));
  // stateText, not a hand-built string. build.js renders the same label and the
  // shared module exists so the two surfaces cannot drift apart on it.
  top.append(el('span', 'run-state', stateText(r, now, r.session)));
  row.append(top);

  if (!expanded) {
    // One line: goal, state, progress. Enough to decide whether to look closer,
    // and nothing that costs vertical space you do not have beyond a handful.
    row.classList.add('is-collapsed');
    const c0 = counts(r.units);
    top.append(el('span', 'run-mini', `${c0.done}/${c0.total}`));
    return row;
  }

  if (r.note) {
    const note = el('div', 'run-note', r.note);
    note.title = r.note;
    row.append(note);
  }

  // The ask is rendered in full rather than behind a click. A question you have
  // to open is a question that waits another hour.
  const ask = askOf(r, now);
  if (ask) row.append(el('div', 'run-ask', ask));

  if (r.units.length) row.append(unitList(r.units, now));

  // Observed sub-agents, at ROW level.
  //
  // They have to live here rather than under a unit, because nothing on disk
  // maps a sub-agent to a unit — the sidecar carries a tool-use id and no unit
  // id. The declared `units[].agents` field is unit-scoped and still renders
  // above for any run file that carries it.
  //
  // Without this the run row lost its fan-out entirely the moment an agent
  // followed the new standard and stopped writing `units[].agents`, which is
  // information removed rather than moved. The run row is where the operator
  // looks to see whether the work is progressing.
  const observed = r.session?.agents ?? [];
  if (observed.length) row.append(agentList(observed, r.session.agentsCapped ?? 0, now));

  // Clicking anywhere in the row focuses the Terminal tab this run is executing
  // in. Agents share their parent's terminal, so a sub-row does the same thing.
  // Only the runId crosses the wire; the server resolves the tty from the run's
  // own file. A run that recorded no tty is simply not clickable.
  // Always clickable. A run that recorded no tty can often still be resolved
  // server-side from the live agent processes, and when it cannot the click
  // fails visibly in amber. Gating on r.tty here made a resolvable run look
  // permanently dead.
  row.dataset.runId = r.runId;
  row.dataset.clickable = '';
  row.title = r.tty
    ? `Open the terminal running this (${r.tty})`
    : 'Open the terminal running this (will be resolved from the running session)';
  row.addEventListener('click', () => openRunTerminal(r.runId, row));

  const c = counts(r.units);
  const foot = el('div', 'run-foot');
  const elapsed = elapsedText(r, now);
  // The AT beside the SO FAR. "3h53m elapsed" alone makes the reader do the
  // subtraction to know when the run began; the clock is the fact, the delta
  // the magnitude, and they are cheap to state together.
  const began = clockAt(r.started, now);
  foot.append(el('span', null,
    `${c.done} of ${c.total} done`
    + (began ? ` · started ${began}` : '')
    + (elapsed ? ` · ${elapsed}` : '')));
  // The GOAL's time left — one slot, never silently blank while work remains.
  // goalEta decides the claim: a forecast from timed units, a ≥floor borrowed
  // from the live fan-out, or the reason no estimate exists. The fan-out's own
  // figure stays in the sub-agent block above; the two answer different
  // questions and each sits with its subject.
  const g = goalEta(r, now);
  const fin = g?.kind === 'estimate' ? finishClock(g, now) : '';
  const slot = el('span', null, goalEtaText(g) + (fin ? ` · ${fin}` : ''));
  if (g?.kind === 'estimate') {
    slot.title = `Estimated from ${g.measured} timed units — mean unit time × what remains, `
      + 'widened by the measured spread. The clock is the projected finish.';
  } else if (g?.kind === 'floor') {
    slot.title = 'A floor, not a forecast: the goal cannot finish before its current '
      + 'fan-out does, and too few units have finished with usable stamps to estimate the rest.';
  } else if (g) {
    slot.title = 'A forecast needs 3 independently timed units; this run does not have them yet.';
  }
  foot.append(slot);
  row.append(foot);
  return row;
}

/**
 * A live session that is publishing nothing. One line: where it is and how long
 * it has been up. Clicking focuses its terminal, the same as a run row.
 *
 * Only the pid crosses the wire. The server resolves the tty from the live
 * process table and validates it, so the page can never hand a device path to
 * osascript. Same rule as `run:`; see run-terminal.js.
 */
function sessionRow(s, now) {
  const activity = sessionActivity(s, now);
  // Both, not one. `activity || context` dropped the goal-recall line — what the
  // session last published — the moment there was any observed activity to show,
  // which is exactly when a session is most worth reading about.
  const sub = [activity, s.context].filter(Boolean).join('  ·  ');
  // ONE skeleton whatever the session carries: headline, identity, activity,
  // fan-out, with an empty slot collapsing rather than promoting another field
  // into its place. This replaced two shapes in one column — a titled session
  // led with a bright description and a second line, an untitled one led with a
  // dim mono path and no second line — so the eye could not scan the list.
  //
  // The headline is the best available answer to "about what". The session's
  // own title first: it is rewritten as the work moves, so it cannot go stale.
  // With no title the NAME leads, not `context`: context recalls a run that
  // already finished, so promoting it would put stopped work in the row's one
  // bright slot, and it is empty for most live sessions, which would make the
  // next fallback the common case anyway. The name always exists for a session
  // whose transcript is readable, is stable for the session's life, and is the
  // word the operator uses to find the terminal. A title that merely repeats
  // the name (a hand-renamed session) falls through to the same string.
  const headline = s.title || s.name || s.where || s.project || `pid ${s.pid}`;
  const t = Date.parse(s.since);
  // `up 8h58m`, not a bare `8h58m`: a bare duration is reserved for a finished
  // span, and an uptime is still growing. Same form as the phone.
  const up = Number.isFinite(t) ? `up ${humanMs(Math.max(0, now - t))}` : '--';
  // The identity line answers "which session · where · how long", and drops only
  // a part the headline already said, so the slot collapses content without
  // changing the row's shape. Every part is in the render signature: name and
  // where directly, uptime through sessionText, which prints the same humanMs.
  const meta = [s.name, s.where || s.project, up]
    .filter((part) => part && part !== headline).join(' · ');
  const row = el('div', `sess is-${s.status || 'unknown'}`);
  const head = el('div', 'sess-head');
  const dot = el('i', 'sess-dot');
  // Phase-offset the pulse by pid. Every row is rebuilt at once by
  // replaceChildren, so without this all animations restart together and the
  // column blinks in lockstep — which reads as one system-wide signal rather
  // than N processes each alive on its own. A NEGATIVE delay starts the
  // animation partway through instead of waiting, so the dot is never dark on
  // first paint. Derived from the pid, so it is varied without being random and
  // survives a rebuild identically; same reasoning as the lattice's per-node
  // drift.
  dot.style.animationDelay = `-${(s.pid % 24) / 10}s`;
  head.append(dot);

  const label = el('span', 'sess-title', headline);
  label.title = meta ? `${headline}\n${meta}` : headline;
  head.append(label);
  // The process's own answer where there is one. NO STATUS is now reserved for
  // a session that could not be joined at all — a Kimi session, or one whose
  // files are unreadable — rather than being the default for everything.
  head.append(el('span', 'sess-tag', (s.status || (s.context ? 'idle' : 'no status')).toUpperCase()));
  row.append(head);
  if (meta) {
    const where = el('div', 'sess-where', meta);
    where.title = `${s.where || s.project} · pid ${s.pid} · ${s.tty}`;
    row.append(where);
  }
  if (sub) {
    const ctx = el('div', 'sess-ctx', sub);
    // `sub`, not `s.context`. The line clips with an ellipsis and the tooltip is
    // the only way to read the rest, so showing half of what was clipped made the
    // activity half unreachable.
    ctx.title = sub;
    row.append(ctx);
  }
  // The sub-agents themselves, not just a count of them. A session fanning out to
  // eight agents and one fanning out to none said the same thing on this row —
  // a number — while the run row beside it named every agent still out. They are
  // the same object at different detail levels, so they get the same detail.
  if ((s.agents ?? []).length) {
    row.append(agentList(s.agents, s.agentsCapped ?? 0, now));
  }

  row.dataset.sessionPid = String(s.pid);
  row.dataset.clickable = '';
  row.title = `Open this session's terminal (${s.tty})`;
  row.addEventListener('click', () => openSessionTerminal(s.pid, row));
  return row;
}

async function openSessionTerminal(pid, row) {
  const find = () => document.querySelector(`[data-session-pid="${CSS.escape(String(pid))}"]`) ?? row;
  find().classList.add('busy');
  let ok = false;
  try {
    const res = await fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Hud': '1' },
      body: JSON.stringify({ id: `session:${pid}` }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  const live = find();
  live.classList.remove('busy');
  live.classList.add(ok ? 'hit' : 'miss');
  setTimeout(() => find().classList.remove('hit', 'miss'), 900);
}

/**
 * A run's live fan-out, read from disk rather than declared.
 *
 * Named rows for the agents still out, because those are the ones the operator
 * can act on, and a single counted line for the ones that have returned — the
 * same shape the unit list already uses, where names appear only under the unit
 * actually running. A 35-agent run rendered in full is a 35-row list.
 */
function agentList(agents, capped, now) {
  const wrap = el('div', 'run-agents');
  const OUT = new Set(['running', 'stalled', 'open']);
  const out = agents.filter((a) => OUT.has(a.state));
  const done = agents.length - out.length;

  // Words, not a ratio. "07 OUT · 29 BACK" reads as a score and does not say what
  // is being counted or which number is the total; the operator asked what it
  // meant. This names the thing, gives the total first, and says what the two
  // parts are in plain language.
  const head = el('div', 'run-agents-head');
  const total = agents.length + capped;
  head.append(el('span', 'run-agents-k',
    `${total} SUB-AGENT${total === 1 ? '' : 'S'}`));
  // "ALL n RETURNED" is stated against the TOTAL, never against the read subset.
  // With a cap in play the two differ, and "70 SUB-AGENTS · ALL 64 RETURNED" is
  // the same which-number-is-the-total confusion this wording was written to fix.
  head.append(el('span', 'run-agents-split',
    out.length
      ? `${out.length} STILL RUNNING · ${done} RETURNED`
      : (capped ? `${done} OF ${total} RETURNED` : `ALL ${done} RETURNED`)));
  if (capped) head.append(el('span', 'run-agents-note', `${capped} NOT READ`));

  // Time left on the fan-out, estimated from the ones that already came back.
  const e = out.length ? agentEta(agents, now) : null;
  if (e?.over) {
    // Past the usual span. Amber, because this is the same "wants a look" the
    // rest of the board spends amber on, and it is a different claim from a
    // countdown — it says the sample stopped predicting, not that time remains.
    const over = el('span', 'run-agents-eta is-over',
      `${humanMs(e.over)} PAST THE USUAL ${humanMs(e.usual)}`);
    over.title = 'The longest-running agent has outrun every one that returned, '
      + 'so how much it has left is not estimable from them.';
    head.append(over);
  } else if (e) {
    // The projected landing as a clock beside the delta — the operator asked
    // when a fan-out finishes, not only how far away that is. `by` on a range:
    // only the high bound is a commitment the band supports.
    const fin = finishClock(e, now);
    head.append(el('span', 'run-agents-eta', etaText(e) + (fin ? ` · ${fin}` : '')));
  }
  wrap.append(head);

  // The fan-out drawn, not only counted: a time axis from dispatch to the
  // slowest RETURNED span. Grey ticks are returns at how long each took —
  // spread reads as clustering — and orange ticks are live agents at their
  // elapsed so far, marching right. One clamped amber at the end is an agent
  // past everything that returned, the same fact the PAST text states. CSS and
  // absolute positioning only; fractions come from the shared model so the
  // picture and the estimate cannot disagree.
  const marks = fanoutStrip(agents, now);
  if (marks) {
    const bar = el('div', 'fan-strip');
    bar.title = `Each grey tick: a returned agent at how long it took. Each orange tick: `
      + `a live agent at its elapsed so far. Axis 0–${humanMs(marks.axis)} (the slowest return); `
      + 'amber at the end is an agent past every return.';
    const tick = (cls, frac) => {
      const t = el('i', `fan-t ${cls}`);
      // 99.6, not 100: a 1px tick placed at left:100% sits outside the track.
      // Half a percent of nudge on an ~500px strip is under 3px.
      t.style.left = `${Math.min(99.6, frac * 100).toFixed(2)}%`;
      return t;
    };
    for (const f of marks.done) bar.append(tick('is-done', f));
    for (const l of marks.live) bar.append(tick(l.over ? 'is-over' : 'is-live', l.frac));
    wrap.append(bar);
  }

  // When nothing is out, name the most recent returns instead of showing a bare
  // count. A session whose 35 agents have all come back has just done 35 things,
  // and "00 OUT · 35 BACK" says none of them. Three is enough to say what the
  // work was without turning a row into a list.
  const RECENT = 3;
  const shown = out.length
    ? out
    : agents.slice()
      .sort((a, b) => String(b.movedAt ?? '').localeCompare(String(a.movedAt ?? '')))
      .slice(0, RECENT);
  if (!out.length && shown.length) {
    head.append(el('span', 'run-agents-note',
      `${Math.min(RECENT, shown.length)} MOST RECENT SHOWN`));
  }

  // GROUPED BY WORKFLOW. A workflow's agents share one name and have no other —
  // their sidecar carries no description, so fourteen of them rendered fourteen
  // identical rows reading `audio-route-and-oss`, which is a list that says one
  // thing fourteen times. One row per workflow says more in a fourteenth of the
  // space: how many are running, and how long the oldest has been at it.
  //
  // Directly dispatched agents are NOT grouped. Each carries its own written
  // description, so each row is a different fact.
  const groups = [];
  const byWorkflow = new Map();
  for (const a of shown) {
    if (!a.workflow) { groups.push({ one: a }); continue; }
    if (!byWorkflow.has(a.workflow)) {
      const g = { workflow: a.workflow, label: a.label, members: [] };
      byWorkflow.set(a.workflow, g);
      groups.push(g);
    }
    byWorkflow.get(a.workflow).members.push(a);
  }

  for (const g of groups) {
    if (!g.one && g.members.length > 1) {
      // The group's own state is its worst: one stalled member is the fact worth
      // surfacing, and a row that reads `running` while a member is stuck hides
      // exactly what the operator is scanning for.
      const state = g.members.some((m) => m.state === 'stalled') ? 'stalled' : 'running';
      // THREE columns, the same as every other row. A fourth cell for the count
      // needed its own grid, and that grid did not resolve as written — the
      // count's column came out 82px against ~110px of text and spilled into the
      // duration. The count belongs in the label anyway: it is part of what the
      // row is called, not a separate measurement.
      const row = el('div', `run-a is-group is-${state}`);
      row.append(el('i', 'run-a-dot'));
      const stalled = g.members.filter((m) => m.state === 'stalled').length;
      const label = el('span', 'run-a-label',
        `${g.label || g.workflow} ×${g.members.length}${stalled ? ` · ${stalled} stalled` : ''}`);
      label.title = `${g.members.length} agents in this workflow`
        + (stalled ? `, ${stalled} of them stalled` : '');
      row.append(label);
      // The OLDEST member's elapsed, because a batch is finished when its
      // slowest member is, and that is the number the operator is waiting on.
      const oldest = g.members.reduce((a, b) =>
        (String(a.started ?? '') <= String(b.started ?? '') ? a : b));
      const d = durationOf({ state: 'running', started: oldest.started }, now, null);
      const t = el('span', d.cls, d.text);
      t.title = 'The longest-running agent in this workflow';
      row.append(t);
      wrap.append(row);
      continue;
    }
    const a = g.one ?? g.members[0];
    const sub = el('div', `run-a is-${a.state === 'open' ? 'running' : a.state}`);
    sub.append(el('i', 'run-a-dot'));
    const label = el('span', 'run-a-label', a.label || a.agentType || a.id);
    label.title = `${a.label || a.id}${a.depth > 1 ? ` · nested, depth ${a.depth}` : ''}`;
    sub.append(label);
    // A returned agent gets its measured span, not a clock still counting up.
    const d = a.state === 'done'
      ? durationOf({ state: 'done', started: a.started, ended: a.movedAt }, now, null)
      : durationOf({ state: 'running', started: a.started }, now, null);
    const t = el('span', d.cls, d.text);
    if (a.state === 'stalled') t.title = 'Open, but its transcript has not moved in over ten minutes';
    sub.append(t);
    wrap.append(sub);
  }
  return wrap;
}

let runsSig = null;

function renderRuns(runs, sessions = []) {
  const now = Date.now();
  const needing = runs.filter((r) => runState(r) === 'needs-input').length;
  $('p-runs').classList.toggle('hot', needing > 0);
  // Sessions are counted separately from runs. Folding them into one number
  // would say "05 RUNS" when two of the five are publishing nothing, which is
  // the overstatement this whole change exists to remove.
  $('runs-count').textContent =
    `${pad2(runs.length)} RUNS` +
    // NO RUN FILE, the fact itself. The counter said QUIET, then SILENT, and
    // both collided with a different claim already on the panel: QUIET is a run
    // file that stopped moving (stateText), and SILENT is now a session whose
    // transcript stopped moving, with a figure (sessionActivity). This count is
    // neither — it is sessions publishing no run file at all.
    (sessions.length ? ` · ${pad2(sessions.length)} NO RUN FILE` : '') +
    (needing ? ` · ${pad2(needing)} NEEDS YOU` : '');

  // Rebuild only when something displayed actually changed. This render is
  // unguarded so quiet time keeps advancing, but replaceChildren tears down text
  // selection, and the whole point of the panel is a question you need to answer
  // and therefore copy. Signature includes the rendered state text, so a quiet
  // counter still ticks over, roughly once a minute instead of every 10 seconds.
  const sig = [
    ...runs.map((r) => rowSignature(r, now)),
    // Sessions carry a clock-derived uptime, so the bucket goes in the
    // signature for the same reason unit timers do: without it the line freezes
    // at whatever it first said.
    //
    // Every observed field is here too. One missing from this list renders once
    // and never changes again — the defect recorded above, where a unit timer
    // sat at "running 5m" for nineteen minutes. `movedAt` is BUCKETED rather
    // than raw: it moves every few seconds on a working session, and an
    // unbucketed value would rebuild the row on every parse, destroying the
    // text selection this guard exists to protect.
    ...sessions.map((s) => [
      s.pid, s.tty, s.where, sessionText(s, now), s.status ?? '', s.name ?? '',
      s.lastTool ?? '', s.branch ?? '', s.agentsCapped ?? 0, s.context ?? '', s.title ?? '',
      // Labels and starts too, now that the row renders them by name rather than
      // counting them. A field the row shows and the signature omits renders once
      // and then never changes again.
      (s.agents ?? []).map((a) => `${a.id}${a.state}${a.label ?? ''}${a.started ?? ''}`).join(','),
      s.movedAt ? Math.floor(Date.parse(s.movedAt) / 30_000) : '',
    ].join('\x01')),
  ].join('\n');
  if (sig !== runsSig) {
    runsSig = sig;
    fill('runs-list', groupedRows(runs, sessions, now), 'NOTHING IS RUNNING');
  }
  flashIfChanged($('p-runs'), [runs, sessions]);
}

// Rank a repo by the worst thing inside it, so the group holding the run that
// needs the operator sorts first. Grouping otherwise buries the urgent row at an
// unpredictable depth, which is the one thing this panel cannot afford.

/**
 * Runs and sessions in one list.
 *
 * They used to be two sections with three vocabularies for one idea — the header
 * said NOT REPORTING, its counter said SESSIONS, the row tag said NO STATUS —
 * and the same visual slot held a machine name on one and a path on the other.
 * They are the same object: a session. A run file only adds a goal and a unit
 * plan on top of one.
 *
 * Sessions carry a `project`, so they group with the runs in the same repo
 * rather than being stacked underneath everything.
 */
function groupedRows(runs, sessions, now) {
  const expand = expandSet(runs);
  const byRepo = new Map();
  const put = (key, item) => {
    const k = key || '—';
    if (!byRepo.has(k)) byRepo.set(k, []);
    byRepo.get(k).push(item);
  };
  for (const r of runs) put(r.project, r);
  for (const s of sessions) put(s.project, s);

  // Rank a repo by the worst thing inside it, so the group holding the row that
  // needs the operator sorts first. Grouping otherwise buries the urgent row at
  // an unpredictable depth, which is the one thing this panel cannot afford.
  const worst = (list) => Math.min(...list.map(mergedRank));
  const groups = [...byRepo.entries()].sort(
    (a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]),
  );

  const rows = [];
  for (const [repo, list] of groups) {
    // One header over one group is chrome, so it only appears when grouping is
    // doing work.
    if (groups.length > 1) {
      const head = el('div', 'repo-head');
      head.append(el('span', 'repo-name', repo));
      head.append(el('span', 'rule-fill'));
      const needing = list.filter((r) => r.runId && runState(r) === 'needs-input').length;
      const quiet = list.filter((r) => !r.runId).length;
      head.append(el('span', 'repo-tally',
        `${pad2(list.length)} ${list.length === 1 ? 'ROW' : 'ROWS'}` +
        // Same word as the panel counter, for the same reason: this counts
        // sessions with no run file, not silence.
        (quiet ? ` · ${pad2(quiet)} NO RUN FILE` : '') +
        (needing ? ` · ${pad2(needing)} NEEDS YOU` : '')));
      rows.push(head);
    }
    // One comparator over both kinds. Sorting each kind separately and
    // concatenating would put a merrily running run above a stalled session,
    // and one of those two may be dead.
    for (const item of list.sort((a, b) => mergedRank(a) - mergedRank(b)
      || String(a.runId || a.name || '').localeCompare(String(b.runId || b.name || '')))) {
      rows.push(item.runId ? runRow(item, now, expand.has(item.runId)) : sessionRow(item, now));
    }
  }
  return rows;
}

// ── warnings + footer ────────────────────────────────────────────────────────

function renderWarnings(state) {
  const strip = $('warnstrip');
  strip.hidden = state.warnings.length === 0;
  strip.replaceChildren(
    ...state.warnings.flatMap((w) => [el('span', 'wglyph', '!'), el('span', 'wtext', w)]),
  );
}

function renderFooter(state) {
  const h = state.health;
  const stats = [
    ['NOTES', h.notes],
    ['LINKS', h.links],
    ['INBOX', h.inbox.count, h.inbox.count ? `${pad2(h.inbox.oldestDays)}D OLD` : null],
    ['ORPHAN', h.orphans],
    ['STALE30', h.stale30],
    ['BROKEN', h.broken.length],
  ];

  $('foot-stats').replaceChildren(
    ...stats.map(([label, value, note]) => {
      const cell = el('div', 'fstat');
      cell.append(el('span', null, label));
      cell.append(el('b', value === 0 ? 'zero' : null, pad2(value)));
      if (note) cell.append(el('i', null, note));
      return cell;
    }),
  );

  $('foot-path').textContent = state.vaultPath;
  $('foot-sync').textContent = 'SYNC ' + state.generatedAt.slice(11, 19) + 'Z';
}

// ── lattice ──────────────────────────────────────────────────────────────────

function createLattice(panel, field, canvas) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const ink = (token) => css.getPropertyValue(token).trim();
  const C = {
    panel: ink('--panel'), rule: ink('--rule-hot'), grid: 'rgba(232,228,220,0.03)',
    edge: 'rgba(138,53,18,0.25)', orange: ink('--orange'), amber: ink('--amber'),
    bone: ink('--bone'), dim: ink('--dim'), dimmer: ink('--dimmer'), bg: ink('--bg'),
  };

  const placed = new Map(); // id → {x, y}, kept across re-renders so nodes do not jump
  let nodes = [], links = [], hovered = null;
  let w = 0, h = 0, alpha = 0, frame = 0;

  // The force solve is never rendered. A displayed solve reads as nodes vibrating
  // in place for two seconds, because the integrator overshoots equilibrium and
  // oscillates across it before cooling. Instead the whole solve runs in one
  // synchronous burst (46 nodes, a few milliseconds), and what gets animated is a
  // single eased glide from where each node was to where it ended up.
  const ENTRANCE_MS = 750;
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;
  let anim = null; // { from: Map(id → [x, y]), t0 }

  // Once the simulation settles the lattice keeps breathing: a per-node sine drift
  // of a couple of pixels, driven by the clock rather than by the force model, so
  // it costs a draw and no physics. Deterministic per node id, so it never looks
  // random. Throttled and suspended with the tab, because this window stays open.
  const IDLE_FPS = 30;
  const DRIFT_PX = 4.6;
  const PULSE_LANES = 3;      // signals in flight along edges at any moment
  const PULSE_MS = 2400;      // time for one to traverse its edge
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let idleAt = 0;

  // Two incommensurate components per axis. A single sine reads as a machine
  // ticking; summing periods that never line up reads as something alive.
  const driftX = (n, t) => (still.matches ? 0 :
    (Math.sin(t * 0.00040 + n.phase) * 0.64 + Math.sin(t * 0.00071 + n.phase * 2.3) * 0.36) * DRIFT_PX);
  const driftY = (n, t) => (still.matches ? 0 :
    (Math.cos(t * 0.00031 + n.phase * 1.7) * 0.64 + Math.cos(t * 0.00059 + n.phase * 3.1) * 0.36) * DRIFT_PX);

  // Node breath, phase-offset per node so the swell ripples across the field
  // instead of the whole lattice throbbing in unison.
  const breath = (n, t) => (still.matches ? 1 : 1 + Math.sin(t * 0.0011 + n.phase) * 0.07);

  const radius = (n) => 3 + Math.sqrt(n.inbound) * 2.2;

  // Deterministic scatter: the same vault always opens to the same picture, and a
  // pre-spread start avoids the outward burst a ring seeding produces on tick one.
  function hash01(id, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < id.length; i++) { h = Math.imul(h ^ id.charCodeAt(i), 16777619); }
    return ((h >>> 0) % 9973) / 9973;
  }

  function setData(graph) {
    const hoveredId = hovered?.id ?? null;
    nodes = graph.nodes.map((n) => {
      const seat = placed.get(n.id);
      return {
        ...n,
        r: radius(n),
        phase: hash01(n.id, 3) * Math.PI * 2,
        vx: 0,
        vy: 0,
        x: seat ? seat.x : w / 2 + (hash01(n.id, 1) - 0.5) * w * 0.34,
        y: seat ? seat.y : h / 2 + (hash01(n.id, 2) - 0.5) * h * 0.34,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Re-seat the hover on the new object, or the readout keeps drawing a node
    // that is no longer in the simulation.
    hovered = hoveredId ? byId.get(hoveredId) ?? null : null;
    links = graph.edges
      .map((e) => ({ a: byId.get(e.source), b: byId.get(e.target) }))
      .filter((l) => l.a && l.b);
    layout();
  }

  /** Solve to completion off-screen, then animate the result into place. */
  function layout() {
    if (!w || !h || !nodes.length) return;

    const from = new Map(nodes.map((n) => [n.id, [n.x, n.y]]));

    alpha = 1;
    for (let i = 0; i < MAX_STEPS && alpha > 0.02; i++) step();
    for (const n of nodes) placed.set(n.id, { x: n.x, y: n.y });

    anim = { from, t0: performance.now() };
    if (!frame) frame = requestAnimationFrame(tick);
  }

  // Fruchterman–Reingold: repulsion k²/d, attraction d²/k, gravity, cooling to a stop.
  // Half the vault is unlinked, so gravity — not the frame — is what has to contain
  // the cloud. Derive it rather than guess it: per axis, this is the constant that
  // balances repulsion at SPREAD × that half-axis, so the cloud settles as an ellipse
  // matching the tile instead of a disc floating in a wide frame.
  // Repulsion is truncated past CUTOFF × k. Untruncated 1/d repulsion makes the
  // unlinked notes orbit out into a shell around the linked core; local-only
  // repulsion lets gravity distribute them evenly through the field instead.
  // Velocity with damping rather than direct position stepping. Applying force
  // straight to position overshoots equilibrium and then oscillates back across
  // it, which is exactly what "the nodes vibrate" looks like. Damping bleeds that
  // energy off instead of storing it, so the layout converges rather than ringing.
  const REPULSION = 0.42;
  const SPREAD = 1.0;
  const CUTOFF = 2.2;
  const DAMPING = 0.80;
  const MAX_STEPS = 600;
  const NEIGHBOURS = Math.PI * CUTOFF * CUTOFF; // nodes inside the cutoff at even density

  function step() {
    const count = Math.max(nodes.length, 1);
    const k = Math.sqrt((w * h) / count);
    const limit = alpha * k * 0.35;
    const pull = (span) => (REPULSION * k * k * NEIGHBOURS) / Math.pow((SPREAD * span) / 2, 2);
    const gx = pull(w), gy = pull(h);
    const cutoff = k * CUTOFF;
    for (const n of nodes) { n.dx = 0; n.dy = 0; }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let vx = a.x - b.x, vy = a.y - b.y;
        let d = Math.hypot(vx, vy);
        if (d > cutoff) continue;
        if (d < 0.01) { vx = (i - j) * 0.01 || 0.01; vy = 0.01; d = 0.014; }
        const f = (REPULSION * k * k) / d / d;
        a.dx += vx * f; a.dy += vy * f;
        b.dx -= vx * f; b.dy -= vy * f;
      }
    }

    for (const { a, b } of links) {
      const vx = a.x - b.x, vy = a.y - b.y;
      const d = Math.max(Math.hypot(vx, vy), 0.01);
      const f = d / k;
      a.dx -= vx * f; a.dy -= vy * f;
      b.dx += vx * f; b.dy += vy * f;
    }

    for (const n of nodes) {
      n.dx += (w / 2 - n.x) * gx;
      n.dy += (h / 2 - n.y) * gy;
      const pad = n.r + 12;
      // Soft margin rather than a hard clamp: a clamp parks overflowing nodes in a
      // dead-straight line along the frame, which reads as a bug.
      n.dx += margin(n.x, pad, w);
      n.dy += margin(n.y, pad, h);

      n.vx = (n.vx + n.dx) * DAMPING;
      n.vy = (n.vy + n.dy) * DAMPING;

      const speed = Math.max(Math.hypot(n.vx, n.vy), 0.001);
      const scale = Math.min(speed, limit) / speed;
      n.vx *= scale;
      n.vy *= scale;

      n.x = Math.min(w - 2, Math.max(2, n.x + n.vx));
      n.y = Math.min(h - 2, Math.max(2, n.y + n.vy));
    }
    alpha *= 0.97;
  }

  /** Inward push that grows with the square of how far past the margin a node is. */
  function margin(v, pad, span) {
    if (v < pad) return (pad - v) ** 2 * 0.05;
    if (v > span - pad) return -((v - span + pad) ** 2) * 0.05;
    return 0;
  }

  function paintNode(n, x, y, t) {
    // Hue is the folder, fill is "something links here", hollow is orphan.
    let colour = C.dim;
    if (n.folder === '10-Projects') colour = C.orange;
    else if (n.folder === '40-Daily') colour = C.amber;
    else if (n.folder === '60-Standards') colour = C.bone;
    else if (n.orphan) colour = C.dimmer;
    const hollow = n.orphan || n.folder === '40-Daily';
    const r = n.r * breath(n, t);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (hollow) { ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.stroke(); }
    else { ctx.fillStyle = colour; ctx.fill(); }

    // Notes carrying open work breathe: the ring is the only thing on the field
    // that moves on its own, so open work is what the eye is drawn to.
    if (n.todos > 0) {
      const swell = still.matches ? 0 : (Math.sin(t * 0.0018 + n.phase) + 1) * 1.1;
      ctx.beginPath();
      ctx.arc(x, y, r + 3.2 + swell, 0, Math.PI * 2);
      ctx.strokeStyle = C.orange;
      ctx.globalAlpha = still.matches ? 1 : 0.55 + Math.cos(t * 0.0018 + n.phase) * 0.35;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Signals running the edges. A few at a time, each traversing one link and
   * fading in and out at the ends, so the lattice reads as carrying traffic
   * rather than sitting still. Which edge each lane takes is derived from the
   * clock, so it is varied without being random and survives a reload identically.
   */
  function paintPulses(t, px, gain) {
    if (still.matches || !links.length || gain <= 0) return;

    ctx.lineWidth = 1;
    for (let lane = 0; lane < PULSE_LANES; lane++) {
      const clock = t + (lane / PULSE_LANES) * PULSE_MS;
      const cycle = Math.floor(clock / PULSE_MS);
      const link = links[(cycle * 7 + lane * 13) % links.length];
      const a = px.get(link.a), b = px.get(link.b);
      if (!a || !b) continue;

      const p = (clock % PULSE_MS) / PULSE_MS;
      const fade = Math.sin(p * Math.PI) * gain;
      const x = a[0] + (b[0] - a[0]) * p;
      const y = a[1] + (b[1] - a[1]) * p;
      const tail = Math.max(0, p - 0.09);

      ctx.globalAlpha = fade * 0.4;
      ctx.strokeStyle = C.orange;
      ctx.beginPath();
      ctx.moveTo(a[0] + (b[0] - a[0]) * tail, a[1] + (b[1] - a[1]) * tail);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.globalAlpha = fade;
      ctx.fillStyle = C.orange;
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function paintReadout(n, x, y) {
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();

    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    const meta = `${n.folder || 'ROOT'} · IN ${pad2(n.inbound)} · OUT ${pad2(n.outbound)}` +
      (n.todos ? ` · ${pad2(n.todos)} TODO` : '');
    const width = Math.max(ctx.measureText(n.label).width, ctx.measureText(meta).width) + 16;
    const bx = Math.min(x + 12, w - width - 4);
    const by = Math.min(y + 10, h - 40);

    ctx.fillStyle = C.bg;
    ctx.fillRect(bx, by, width, 34);
    ctx.strokeStyle = C.rule;
    ctx.strokeRect(bx + 0.5, by + 0.5, width - 1, 33);
    ctx.fillStyle = C.bone;
    ctx.fillText(n.label, bx + 8, by + 14);
    ctx.fillStyle = C.dim;
    ctx.fillText(meta, bx + 8, by + 27);
  }

  function draw(t = 0) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += 24) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y < h; y += 24) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();

    // Drift is applied at paint time, so the settled positions in `placed` stay
    // clean and the graph never wanders away from where the simulation put it.
    // During the entrance, position is an eased interpolation toward the solved
    // layout and drift is scaled in behind it, so the two never fight.
    const e = anim ? easeOutCubic(Math.min(1, (t - anim.t0) / ENTRANCE_MS)) : 1;
    const px = new Map();
    for (const n of nodes) {
      let x = n.x, y = n.y;
      const start = anim?.from.get(n.id);
      if (start) {
        x = start[0] + (x - start[0]) * e;
        y = start[1] + (y - start[1]) * e;
      }
      px.set(n, [x + driftX(n, t) * e, y + driftY(n, t) * e]);
    }

    ctx.strokeStyle = C.edge;
    ctx.beginPath();
    for (const { a, b } of links) {
      const [ax, ay] = px.get(a), [bx, by] = px.get(b);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();

    paintPulses(t, px, e);

    for (const n of nodes) { const [x, y] = px.get(n); paintNode(n, x, y, t); }
    if (hovered && px.has(hovered)) {
      const [x, y] = px.get(hovered);
      paintReadout(hovered, x, y);
    }
  }

  function tick(t = 0) {
    if (!w || !h || !nodes.length) { frame = 0; return; }

    // Entrance: full frame rate, no physics — the solve already happened.
    if (anim) {
      if (t - anim.t0 >= ENTRANCE_MS) anim = null;
      draw(t);
      if (anim) { frame = requestAnimationFrame(tick); return; }
    }

    // Settled. Keep breathing, but at a fraction of the frame rate, and not at all
    // while the tab is hidden or the user has asked for stillness.
    if (still.matches || document.hidden) { frame = 0; return; }
    if (t - idleAt >= 1000 / IDLE_FPS) { idleAt = t; draw(t); }
    frame = requestAnimationFrame(tick);
  }

  function resize() {
    const nw = field.clientWidth, nh = field.clientHeight;
    if (!nw || !nh) return;
    const resized = nw !== w || nh !== h;

    // Carry the existing layout across the size change proportionally, so the
    // re-solve starts from something already close and the glide stays short.
    // Expanding the tile to full screen is the big one: without this the graph
    // would re-solve from scratch and visibly scramble.
    if (resized && w && h) {
      const sx = nw / w, sy = nh / h;
      for (const n of nodes) { n.x *= sx; n.y *= sy; n.vx = 0; n.vy = 0; }
      for (const [id, p] of placed) placed.set(id, { x: p.x * sx, y: p.y * sy });
    }

    w = nw;
    h = nh;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!nodes.length) return;
    if (!resized) {
      // Setting canvas.width cleared it, so repaint even when nothing moved.
      draw(performance.now());
      if (!frame && !still.matches && !document.hidden) frame = requestAnimationFrame(tick);
      return;
    }
    layout();
  }

  function nodeAt(event) {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    const t = performance.now();
    return nodes.find((n) =>
      Math.hypot(n.x + driftX(n, t) - x, n.y + driftY(n, t) - y) <= n.r + 5) || null;
  }

  canvas.addEventListener('mousemove', (e) => {
    const found = nodeAt(e);
    if (found === hovered) return;
    hovered = found;
    canvas.style.cursor = found ? 'pointer' : 'crosshair';
    if (!frame) draw(performance.now());
  });
  canvas.addEventListener('mouseleave', () => { hovered = null; if (!frame) draw(performance.now()); });
  canvas.addEventListener('click', (e) => {
    const found = nodeAt(e);
    if (found) openNote(found.obsidian);
    else setExpanded(!panel.classList.contains('expanded'));
  });

  function setExpanded(on) {
    hovered = null;
    panel.classList.toggle('expanded', on);
    $('lattice-hint').textContent = on ? 'ESC OR CLICK FIELD TO COLLAPSE' : 'CLICK FIELD TO EXPAND';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('expanded')) setExpanded(false);
  });

  // The idle loop parks itself when the tab goes away; restart it on return, or
  // the lattice comes back frozen.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !frame && nodes.length) frame = requestAnimationFrame(tick);
  });
  still.addEventListener('change', () => {
    if (!still.matches && !frame && nodes.length) frame = requestAnimationFrame(tick);
    else if (still.matches) draw(0);
  });

  new ResizeObserver(resize).observe(field);

  return {
    update(graph) {
      if (!w) resize();
      setData(graph);
    },
  };
}

const lattice = createLattice($('p-lattice'), $('lattice-field'), $('lattice-canvas'));

function renderLattice(state) {
  // Reheating on every push would restart a four-second settle each time a note is
  // saved, so the graph only re-simulates when the graph itself actually changed.
  if (diff('graph', state.graph).changed) lattice.update(state.graph);
  $('lattice-meta').textContent =
    `${pad2(state.graph.nodes.length)} NODES · ${pad2(state.graph.edges.length)} EDGES`;
}

// ── wiring ───────────────────────────────────────────────────────────────────

function render(state) {
  renderHeader(state);
  renderFocus(state);
  renderHero(state);
  // Deliberately not guarded by diff(): runs carry no clock value, so a run that
  // stops writing produces byte-identical State and a guard would freeze its
  // quiet time forever. fill() keeps scroll position, so an unguarded repaint
  // costs what every other panel already pays.
  renderRuns(state.runs || [], state.sessions || []);
  renderLattice(state);
  renderWarnings(state);
  renderFooter(state);
}

function setLink(live) {
  const node = $('link-state');
  node.classList.toggle('live', live);
  $('link-text').textContent = live ? 'LIVE' : 'OFFLINE';
}

async function loadState() {
  for (const url of STATE_SOURCES) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch { /* try the next source */ }
  }
  return null;
}

async function refresh() {
  const state = await loadState();
  if (state) render(state);
}

// EventSource only retries by itself when the server closes the stream cleanly.
// If the process dies abruptly the stream goes to CLOSED and the browser gives
// up permanently, which leaves the window showing frozen numbers behind a dim
// OFFLINE lamp for as long as it stays open. So reconnect explicitly.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

let stream = null;
let retryAt = RETRY_MIN_MS;
let retryTimer = null;

function subscribe() {
  clearTimeout(retryTimer);
  stream?.close();

  let dropped = false;
  stream = new EventSource('/events');

  stream.addEventListener('open', () => {
    retryAt = RETRY_MIN_MS;
    setLink(true);
    if (dropped) { dropped = false; refresh(); } // the stream may have missed writes
  });
  stream.addEventListener('message', (e) => {
    setLink(true);
    render(JSON.parse(e.data));
  });
  stream.addEventListener('error', () => {
    dropped = true;
    setLink(false);
    // readyState CONNECTING means the browser is already retrying; CLOSED means
    // it has given up and reconnecting is on us.
    if (stream.readyState !== EventSource.CLOSED) return;
    retryTimer = setTimeout(subscribe, retryAt);
    retryAt = Math.min(retryAt * 2, RETRY_MAX_MS);
  });
}

// Waking from sleep or switching back to the window are the moments a dead
// stream is most likely and most visible. Re-check both.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stream?.readyState === EventSource.CLOSED) subscribe();
});
window.addEventListener('online', () => {
  if (stream?.readyState === EventSource.CLOSED) subscribe();
});

// ── shortcuts ────────────────────────────────────────────────────────────────

// The action bar. Buttons come from the server's catalogue; a click sends only
// the shortcut id back. The custom header is what makes the POST safe: any
// cross-origin page trying to forge it triggers a CORS preflight the server
// never grants, so only this same-origin page can drive an action.
async function fire(id, button) {
  button.classList.add('busy');
  try {
    const res = await fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-HUD': '1' },
      body: JSON.stringify({ id })
    });
    button.classList.toggle('failed', !res.ok);
  } catch {
    button.classList.add('failed');
  } finally {
    setTimeout(() => button.classList.remove('busy', 'failed'), 900);
  }
}

// Icons are referenced by name against the sprite in index.html, never injected
// as markup. An unknown name falls back to the text label, so a typo in
// tools.json degrades to two letters rather than to an empty button.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = new Set(['git', 'window', 'gem', 'terminal', 'code', 'bolt', 'triangle', 'vault']);

function iconNode(name) {
  if (!ICONS.has(name)) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#ic-${name}`);
  svg.append(use);
  return svg;
}

async function loadShortcuts() {
  let list = [];
  try {
    const res = await fetch('/api/tools', { cache: 'no-store' });
    if (res.ok) list = await res.json();
  } catch { /* no bar, no harm */ }

  const host = $('shortcuts');
  host.replaceChildren(
    ...list.map((s) => {
      const btn = el('button', 'sc' + (s.accent ? ' accent' : ''));
      btn.type = 'button';
      btn.title = s.title;
      btn.setAttribute('aria-label', s.title);

      const icon = iconNode(s.icon);
      if (icon) btn.append(icon);
      else { btn.classList.add('is-text'); btn.textContent = s.label; }

      btn.addEventListener('click', () => fire(s.id, btn));
      return btn;
    })
  );
}

// ── vitals ───────────────────────────────────────────────────────────────────

// Machine vitals ride their own SSE stream so a metrics outage cannot touch the
// vault render path, and so the two cadences stay independent.
//
// The stream is closed whenever the window is hidden. That is not just a client
// saving: the server samples only while it has a subscriber, so a backgrounded
// window drops the cost of this feature to zero rather than to "small".

// Load and utilisation climb toward bad; charge falls toward it. Both are
// expressed as the same two thresholds so the strip reads consistently.
const VIT_WARN = 80;
const VIT_CRIT = 92;
const BAT_WARN = 20;
const BAT_CRIT = 10;

const pct = (n) => (n == null ? null : `${Math.round(n)}%`);

/** Bytes → a two-character-ish figure. Only ever used for process memory. */
function gib(bytes) {
  const g = bytes / 1024 ** 3;
  return g >= 10 ? `${Math.round(g)}G` : `${g.toFixed(1)}G`;
}

/**
 * Paint one reading. `value` is the number driving both the text and the bar;
 * passing null hides the whole cell, which is how an unavailable GPU or a
 * machine with no battery renders.
 */
function vitCell(id, value, text, level) {
  const box = $(`v-${id}`);
  if (value == null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle('warn', level === 'warn');
  box.classList.toggle('crit', level === 'crit');
  $(`v-${id}-n`).textContent = text;
  $(`v-${id}-b`).style.width = `${Math.max(0, Math.min(100, value))}%`;
}

/** Rising metrics: bigger is worse. */
const risingLevel = (n) => (n >= VIT_CRIT ? 'crit' : n >= VIT_WARN ? 'warn' : null);

function renderVitals(m) {
  // The frame seeded on connect is whatever was last measured, which is nothing
  // at all until sampling has run once. Stay dim until there is a real reading,
  // rather than presenting an empty strip as a live one.
  const measured = m.cpu != null || m.gpu != null || m.memory != null || m.battery != null;
  $('p-vitals').classList.toggle('stale', !measured);

  vitCell('cpu', m.cpu, pct(m.cpu), m.cpu == null ? null : risingLevel(m.cpu));
  vitCell('gpu', m.gpu, pct(m.gpu), m.gpu == null ? null : risingLevel(m.gpu));

  const mem = m.memory;
  vitCell('mem', mem?.percent ?? null, pct(mem?.percent),
    mem?.percent == null ? null : risingLevel(mem.percent));

  const bat = m.battery;
  // On the charger a low reading is a fact, not a problem, so it never escalates.
  const batLevel = !bat || bat.external ? null
    : bat.percent <= BAT_CRIT ? 'crit'
      : bat.percent <= BAT_WARN ? 'warn' : null;
  vitCell('bat', bat?.percent ?? null, pct(bat?.percent), batLevel);

  // The charging mark is appended rather than folded into the number so the
  // digits keep their fixed width and the row never twitches.
  const batBox = $('v-bat');
  const hasMark = batBox.querySelector('.vit-chg');
  if (bat?.charging && !hasMark) batBox.append(el('span', 'vit-chg'));
  else if (!bat?.charging && hasMark) hasMark.remove();

  // One flag at a time, worst first. Throttling means the machine is already
  // losing performance; a warm battery is only a heads-up.
  const flag = $('v-flag');
  const warning = m.thermal?.throttled
    ? `THROTTLED ${m.thermal.speedLimit}%`
    : bat?.tempC >= 40 ? `BATTERY ${bat.tempC}°C` : null;
  flag.hidden = !warning;
  flag.textContent = warning ?? '';

  const hot = m.hot;
  $('v-hot').textContent = hot
    ? `▸ ${hot.name}  ${hot.kind === 'cpu' ? `${hot.cpuPct}%` : gib(hot.rssBytes)}`
    : '';

  // GPU offender. The server always reports the top GPU process when one clears
  // its floor, but naming it whenever the GPU is merely awake (WindowServer sits
  // there forever) would be the always-lit slot the CPU offender deliberately
  // avoids. So it surfaces only once the GPU cell is itself high — the same line
  // at which that cell turns amber — and answers the question that reading raises:
  // which app. The dim GPU key keeps it distinct from the CPU/mem offender, which
  // can name the very same app for a different reason.
  const gpuHotSlot = $('v-gpu-hot');
  const gh = m.gpuHot;
  if (gh && m.gpu != null && m.gpu >= VIT_WARN) {
    gpuHotSlot.replaceChildren(
      el('span', 'vit-hot-k', 'GPU'),
      document.createTextNode(`▸ ${gh.name}  ${gh.gpuPct}%`)
    );
  } else {
    gpuHotSlot.replaceChildren();
  }
}

let vitStream = null;
let vitRetryAt = RETRY_MIN_MS;
let vitRetryTimer = null;

function subscribeVitals() {
  clearTimeout(vitRetryTimer);
  vitStream?.close();
  vitStream = new EventSource('/metrics');

  vitStream.addEventListener('open', () => { vitRetryAt = RETRY_MIN_MS; });
  vitStream.addEventListener('message', (e) => {
    try {
      renderVitals(JSON.parse(e.data));
    } catch { /* a malformed frame must not kill the listener */ }
  });
  vitStream.addEventListener('error', () => {
    // Dim rather than blank: the last reading stays on screen, visibly stale.
    $('p-vitals').classList.add('stale');
    if (vitStream.readyState !== EventSource.CLOSED) return;
    vitRetryTimer = setTimeout(subscribeVitals, vitRetryAt);
    vitRetryAt = Math.min(vitRetryAt * 2, RETRY_MAX_MS);
  });
}

function releaseVitals() {
  clearTimeout(vitRetryTimer);
  vitStream?.close();
  vitStream = null;
  $('p-vitals').classList.add('stale');
}

// Hidden window, no subscriber, no sampling. This is the whole reason the server
// gates its timer on subscriber count.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseVitals();
  else if (!vitStream || vitStream.readyState === EventSource.CLOSED) subscribeVitals();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* install prompt only */ });
}

await refresh();
loadShortcuts();
subscribe();
if (!document.hidden) subscribeVitals();
