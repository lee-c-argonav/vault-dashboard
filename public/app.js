// vault-hud client — renders State, repaints on SSE, draws the lattice.
// Every vault-authored string arrives here either as pre-escaped `.html` from the
// parser or is inserted with textContent. Nothing is built by concatenating raw text.

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
    if (e.target.closest('a, .gdone')) return; // those carry their own behaviour
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

  // OPEN is a near-constant and DONE is good news; neither is a pressure signal.
  // Everything else goes orange the moment it is non-zero, which is what makes
  // the header say something rather than merely report.
  const cells = [
    ['s-open', state.stats.open, false],
    ['s-stale', state.stats.stale, true],
    ['s-due', state.stats.dueToday, true],
    ['s-over', state.stats.overdue, true],
    ['s-done', state.stats.doneToday, false],
  ];
  for (const [id, value, hotWhenSet] of cells) {
    const node = $(id);
    node.textContent = pad2(value);
    node.className = 'cell-v' + (value === 0 ? ' zero' : hotWhenSet ? ' hot' : '');
  }
  flashIfChanged($('p-head'), state.stats);
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

  // One tick per open todo, oldest first: the burden gauge.
  const ticks = state.groups
    .flatMap((g) => g.todos)
    .filter((t) => !t.done)
    .sort((a, b) => (b.ageDays ?? -Infinity) - (a.ageDays ?? -Infinity));

  $('load-strip').replaceChildren(
    ...ticks.map((t) => {
      const tick = el('i');
      if (t.scheduled) tick.className = 'sched';
      else if (t.dueState === 'today' || t.dueState === 'overdue') tick.className = 'due';
      else if (t.ageDays >= 1) tick.className = 'stale';
      return tick;
    }),
  );
  flashIfChanged($('p-focus'), [state.focus, ticks.length]);
}

// ── hero: the one number that says what is wrong ──────────────────────────────

function heroFor(state) {
  const open = state.groups.flatMap((g) => g.todos).filter((t) => !t.done);
  const firstDue = (dueState) => open.find((t) => t.dueState === dueState);

  if (state.stats.overdue > 0) {
    const t = firstDue('overdue');
    return { label: 'OVERDUE', n: state.stats.overdue, sub: t ? `${t.due} — ${clip(plain(t.text), 46)}` : '' };
  }
  if (state.stats.dueToday > 0) {
    const t = firstDue('today');
    return { label: 'DUE TODAY', n: state.stats.dueToday, sub: t ? clip(plain(t.text), 52) : '' };
  }
  if (state.stats.stale > 0) {
    const oldest = state.rolledOver[0];
    return {
      label: 'STALE',
      n: state.stats.stale,
      sub: oldest ? `OLDEST ${pad2(oldest.ageDays)}D — ${clip(plain(oldest.text), 44)}` : '',
    };
  }
  return {
    label: 'OPEN',
    n: state.stats.open,
    calm: true,
    sub: `${pad2(state.groups.length)} GROUPS · NOTHING DUE OR STALE`,
  };
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

// ── todos ────────────────────────────────────────────────────────────────────

const expandedDone = new Set(); // group keys whose completed items are shown

// The source reference, link count and row index all lived on the row at one
// point. They repeat what the group header already says and turned every row into
// five competing elements, so they moved into the tooltip. What is left is the
// state of the item, its text, and the two facts that can change your plan: it is
// due, or it has been sitting.
function todoRow(todo) {
  const row = el('div', 'todo' + (todo.done ? ' is-done' : ''));
  row.title = `${plain(todo.text)}\n${todo.source}:${todo.line}`;

  const box = el('span', 'box' + (todo.done ? ' on' : ''));
  if (!todo.done && (todo.dueState === 'today' || todo.dueState === 'overdue')) box.classList.add('hot');
  row.append(box);

  row.append(htmlNode('div', 'ttext', todo.html));

  const meta = el('div', 'tmeta');
  if (todo.section && todo.section !== 'Todos') meta.append(el('span', 'chip', todo.section.toUpperCase()));
  if (todo.due) {
    const label = todo.dueState === 'today' ? 'DUE TODAY' : `DUE ${todo.due.slice(5)}`;
    meta.append(el('span', `chip due-${todo.dueState}`, label));
  }
  if (todo.scheduled) meta.append(el('span', 'chip sched', `SCHED ${noteName(todo.source).slice(5)}`));
  else if (todo.ageDays >= 1) meta.append(el('span', 'chip age', `${pad2(todo.ageDays)}D`));
  row.append(meta);

  return clickable(row, todo.obsidian);
}

// Dated pressure first, then live backlog, then scheduled, then completed.
const todoRank = (t) =>
  t.done ? 3 : t.scheduled ? 2 : t.dueState === 'overdue' || t.dueState === 'today' ? 0 : 1;

function renderTodos(state) {
  const rows = [];
  for (const group of state.groups) {
    const showDone = expandedDone.has(group.key);

    const head = el('div', 'ghead' + (group.obsidian ? '' : ' static'));
    head.append(el('span', 'gcaret'));
    head.append(el('span', 'glabel', group.label));
    head.append(el('span', 'rule-fill'));
    if (group.done) {
      const toggle = el('span', 'gdone' + (showDone ? ' on' : ''), `${pad2(group.done)} DONE`);
      toggle.addEventListener('click', () => {
        if (showDone) expandedDone.delete(group.key);
        else expandedDone.add(group.key);
        renderTodos(state);
      });
      head.append(toggle);
    }
    head.append(el('span', 'gopen', pad2(group.open)));
    rows.push(clickable(head, group.obsidian));

    const visible = group.todos.filter((t) => showDone || !t.done);
    if (!visible.length) {
      rows.push(el('div', 'gempty', group.todos.length ? 'ALL COMPLETE' : 'NO ITEMS'));
      continue;
    }
    [...visible]
      .sort((a, b) => todoRank(a) - todoRank(b) || (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.line - b.line)
      .forEach((todo) => rows.push(todoRow(todo)));
  }

  fill('todos-body', rows, 'NO TODOS IN SCOPE');

  const done = state.groups.reduce((sum, g) => sum + g.done, 0);
  $('todos-meta').textContent =
    `${pad2(state.stats.open)} OPEN · ${pad2(done)} DONE · ${pad2(state.groups.length)} GROUPS`;
  flashIfChanged($('p-todos'), state.groups);
}

// ── decisions ────────────────────────────────────────────────────────────────

function renderDecisions(state) {
  const rows = state.decisions.map((d) => {
    const row = el('div', 'dec');
    row.append(el('span', 'dec-date', d.date.slice(5)));
    const body = el('div');
    body.append(htmlNode('div', 'dec-text', d.html));
    body.append(el('div', 'dec-src', noteName(d.source)));
    row.append(body);
    return clickable(row, d.obsidian);
  });

  fill('decisions-body', rows, 'NO RECORDED DECISIONS');
  $('decisions-meta').textContent = pad2(state.decisions.length);
  flashIfChanged($('p-decisions'), state.decisions);
}

// ── rolled over ──────────────────────────────────────────────────────────────

function renderRolled(state) {
  const items = state.rolledOver;
  const rows = items.map((t) => {
    const row = el('div', 'ro');
    row.title = plain(t.text);
    row.append(el('span', 'ro-age' + (t.ageDays >= 3 ? ' hot' : ''), `${pad2(t.ageDays)}D`));
    row.append(htmlNode('span', 'ro-text', t.html));
    return clickable(row, t.obsidian);
  });

  fill('rolled-body', rows, 'NONE — CLEAN ROLLOVER');
  $('rolled-meta').textContent = items.length
    ? `${pad2(items.length)} · OLDEST ${pad2(items[0].ageDays)}D`
    : 'CLEAR';
  flashIfChanged($('p-rolled'), items);
}

// ── integrity ────────────────────────────────────────────────────────────────

const ORPHANS_SHOWN = 6;

/**
 * Two failure modes of a linked vault, in one tile: links that point at nothing,
 * and notes that nothing points at. Broken links collapse hard — a single
 * ambiguous target usually accounts for most of the count — so they are grouped
 * by target rather than listed per occurrence.
 */
function renderIntegrity(state) {
  const rows = [];

  const byTarget = new Map();
  for (const b of state.health.broken) {
    const entry = byTarget.get(b.link) ?? { link: b.link, count: 0, first: b.source };
    entry.count += 1;
    byTarget.set(b.link, entry);
  }
  const targets = [...byTarget.values()].sort((a, b) => b.count - a.count || a.link.localeCompare(b.link));

  if (targets.length) rows.push(el('div', 'ig-head', 'UNRESOLVED'));
  for (const t of targets) {
    const row = el('div', 'ig');
    row.append(el('span', 'ig-k', `[[${t.link}]]`));
    if (t.count > 1) row.append(el('span', 'ig-n', `×${t.count}`));
    row.append(el('span', 'ig-src', t.count > 1 ? `${t.count} NOTES` : noteName(t.first)));
    row.title = `${t.link} — first seen in ${t.first}`;
    rows.push(row);
  }

  // Notes that link outward but have nothing linking in: thinking that never got
  // connected back. Ranked by outbound, so the most-developed strays surface first.
  const orphans = state.graph.nodes
    .filter((n) => n.orphan)
    .sort((a, b) => b.outbound - a.outbound || a.label.localeCompare(b.label));

  if (orphans.length) {
    rows.push(el('div', 'ig-head', `ORPHANED · ${pad2(orphans.length)}`));
    for (const n of orphans.slice(0, ORPHANS_SHOWN)) {
      const row = el('div', 'ig');
      row.append(el('span', 'ig-k', n.label));
      row.append(el('span', 'ig-src', `${n.folder || 'ROOT'} · OUT ${pad2(n.outbound)}`));
      row.title = n.id;
      rows.push(clickable(row, n.obsidian));
    }
    if (orphans.length > ORPHANS_SHOWN) {
      rows.push(el('div', 'ig-more', `+${pad2(orphans.length - ORPHANS_SHOWN)} MORE`));
    }
  }

  fill('integrity-body', rows, 'ALL LINKS RESOLVE · NO ORPHANS');
  $('integrity-meta').textContent =
    `${pad2(state.health.broken.length)} BROKEN · ${pad2(state.health.orphans)} ORPHAN`;
  flashIfChanged($('p-integrity'), [state.health.broken, state.health.orphans]);
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
  renderTodos(state);
  renderLattice(state);
  renderDecisions(state);
  renderRolled(state);
  renderIntegrity(state);
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
