// status-page/build.js — render 15-Runs into one self-contained HTML file.
//
// Same data and the same derivation as the HUD: runs-view.js is imported, never
// reimplemented, so the desktop and the phone cannot disagree about whether a
// run is waiting on the operator, how long a unit has taken, or which units are
// worth showing. Everything is inlined because a published page cannot reach any
// external host, so a CDN font or a remote stylesheet renders as nothing at all.
//
// The visual language is the HUD's, adapted rather than copied. Hairlines and
// four-value contrast steps depend on a controlled room; a phone is read in
// daylight, so borders step up to --rule-hot and the light theme is a real
// palette rather than an inversion.

import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { readRunsDetailed, readFinishedRunsDetailed } from '../runs.js';
import { readSessions } from '../sessions.js';
import {
  LABEL, runState, stateText, durationOf, unitWindow, expandSet, askOf, quietMs,
  eta, etaText, elapsedText, humanMs, counts, partitionRuns, linkSessions, sessionText, batchStamped,
  STALE_MS,
  sessionContext, sortRank, blockedNote, FINISHED_MAX_AGE_MS,
} from '../public/runs-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.VAULT_HUD_VAULT || join(homedir(), 'Obsidian', 'vault');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Everything the page is rendered from. One reader, used by `build()` here and
 * by `publish.js` to decide whether an upload is worth doing.
 *
 * @throws when the vault cannot be read; see the guard in build().
 */
export async function readBoard(vaultPath, injectedSessions, now = null) {
  // Defaulted here as well as in build(), so a caller that passes an unset env
  // var gets the configured vault instead of `join(undefined, …)` throwing.
  const vault = vaultPath || VAULT;
  const { runs, unreadable, skipped } = await readRunsDetailed(vault);
  if (unreadable) {
    throw new Error(
      `cannot read ${vault}/15-Runs — refusing to publish an empty board over a live one. ` +
      'Check VAULT_HUD_VAULT.',
    );
  }
  // A done run drops off the live board into history on its own, so the page is
  // correct whether or not anyone remembered to archive the file.
  const archive = await readFinishedRunsDetailed(vault);
  const { active, finished } = partitionRuns(runs, archive.runs, now);
  const sessions = injectedSessions ?? await readSessions();
  // Take BOTH halves. The linked runs carry `.session`, which is what lets
  // stateText say NO UPDATE rather than QUIET for a run whose session is still
  // there. Destructuring only `unpublished` left every run on the phone page
  // without it, so the phone would have kept saying QUIET after the desktop
  // stopped.
  const linked = linkSessions(active, sessions);
  // A session between pieces of work still has something to say.
  //
  // `finished`, not `runs.filter(done)`. The archive was missing from this list,
  // so a session that closed its run out and moved the file into
  // `99-Archive/runs/` — step 9 of `/close`, and the reason readFinishedRuns
  // exists at all — got no context and rendered NO STATUS. That is exactly the
  // "best-described session becomes the emptiest row" case sessionContext was
  // written to fix, surviving in the one path most likely to hit it.
  //
  // `linked.runs` carries `.session`, which sessionContext needs in order to
  // refuse a run already credited to a different session.
  const context = linked.runs.concat(finished);
  const withContext = linked.unpublished.map((s) => ({
    ...s, context: now === null ? '' : sessionContext(s, context, now),
  }));
  return {
    active: linked.runs,
    finished,
    unpublished: withContext,
    // Both folders. A corrupt file in the archive is as invisible as one in
    // 15-Runs and earns the same line in the footer.
    skipped: skipped + archive.skipped,
  };
}

/**
 * What the board SAYS, ignoring when it was read.
 *
 * Hashed over the run data, never over the rendered HTML. The data carries no
 * clock-derived value by design — that invariant is stated in SPEC.md and tested
 * by "no derived field in a run changes with the clock" — so it is stable by
 * construction. Hashing the page instead was tried first and was wrong: elapsed
 * times, quiet counters, the ETA band, the build stamp and a duration cell's
 * explanatory `title` are all clock-derived, and stripping them by pattern
 * missed the tooltip, so two reads forty minutes apart hashed differently with
 * an unchanged board.
 *
 * `publish.js` uses this to skip an upload that would repeat the last one. On a
 * five-minute timer that is 288 deploys a day, nearly all identical.
 */
export const QUIET_BUCKET_MS = 30 * 60_000;

export function boardDigest({ active, finished, unpublished, skipped = 0 }, now = null) {
  // How silent a run is, coarsely.
  //
  // boardDigest hashes no clock-derived value, and taken literally that froze
  // the page: QUIET and NO UPDATE ARE clock-derived, so a run that simply
  // stopped writing produced an identical digest forever, no deploy fired, and
  // the phone went on rendering it as healthy. Surfacing a stalled run is the
  // one thing this instrument exists for, so it could not be the one thing the
  // publisher could not see.
  //
  // Fresh runs collapse to a single bucket, so an ordinary tick is still not a
  // change and the timer is not a deploy loop. Past the stale threshold the
  // bucket advances every half hour: the counter can lag the truth by up to that
  // much, which the page's own build stamp discloses, in exchange for at most
  // two deploys an hour for a run nobody is updating.
  const silence = (r) => {
    if (now === null) return 0;
    const q = quietMs(r, now);
    if (q === null) return 'nostamp';
    return q <= STALE_MS ? 0 : Math.floor(q / QUIET_BUCKET_MS) + 1;
  };
  // Field order fixed here rather than inherited from object key order, so a
  // reordered literal upstream cannot silently invalidate every digest.
  const run = (r) => [r.runId, r.project, r.goal, r.machine, r.state, r.note, r.tty,
    r.started, r.updated,
    // Whether a session is still writing this run. It decides QUIET versus
    // NO UPDATE on the row, and a claimed session never reaches `unpublished`
    // below, so without this a session's death was invisible to the check and
    // the page would have gone on saying NO UPDATE about a dead run.
    r.session?.pid ?? null,
    r.units.map((u) => [u.id, u.label, u.state, u.started, u.ended,
      u.agents.map((a) => [a.label, a.state, a.started, a.ended])]),
    r.needsInput.map((n) => [n.question, n.since]),
    r.blockers.map((b) => [b.what, b.since])];
  return createHash('sha256').update(JSON.stringify({
    active: active.map((r) => [run(r), silence(r)]),
    finished: finished.map(run),
    // Rendered in the footer as "N run files unreadable", so a newly corrupt
    // file must be able to reach the page.
    skipped,
    // `since` is the process start time, which is fixed for the life of a
    // session, so it is stable. Uptime is derived from it at render time.
    sessions: unpublished.map((s) => [s.pid, s.tty, s.project, s.where, s.since]),
  })).digest('hex');
}

const CSS = `
:root{
  color-scheme: dark light;
  --bg:#08090A; --panel:#101113; --panel-2:#16181B;
  --rule:#1E2024; --rule-hot:#2A2D33;
  --orange:#FF5D1F; --amber:#F0A202;
  --bone:#E8E4DC; --dim:#8B8F95; --dimmer:#42454A; --text-3:#8B8F95;
  --mono: ui-monospace,"SF Mono",Menlo,monospace;
  --sans: -apple-system,"Helvetica Neue","Inter",sans-serif;
}
/* The quiet steps are one stop lighter than the HUD's, deliberately: a phone is
   read in daylight at arm's length, a desktop panel in a controlled room. The
   HUD's --dim measures 3.85:1 on a card here, below AA at 11px; this is 5.47:1.
   --dimmer stays a mark tint and is never used for text on either surface.

   A real light palette, not an inversion. The HUD's accents fail on white:
   #FF5D1F is 2.9:1 there and #F0A202 is 1.9:1, so both are darkened until they
   carry the same meaning at the same legibility. */
@media (prefers-color-scheme: light){
  :root{
    --bg:#F4F2EE; --panel:#FFFFFF; --panel-2:#F0EDE7;
    --rule:#D8D4CC; --rule-hot:#B9B4AA;
    --orange:#C63C08; --amber:#8A5D00;
    --bone:#14161A; --dim:#4E5258; --dimmer:#B9B4AA; --text-3:#4E5258;
  }
}
:root[data-theme="light"]{
  --bg:#F4F2EE; --panel:#FFFFFF; --panel-2:#F0EDE7;
  --rule:#D8D4CC; --rule-hot:#B9B4AA;
  --orange:#C63C08; --amber:#8A5D00;
  --bone:#14161A; --dim:#4E5258; --dimmer:#B9B4AA; --text-3:#4E5258;
}
:root[data-theme="dark"]{
  --bg:#08090A; --panel:#101113; --panel-2:#16181B;
  --rule:#1E2024; --rule-hot:#2A2D33;
  --orange:#FF5D1F; --amber:#F0A202;
  --bone:#E8E4DC; --dim:#8B8F95; --dimmer:#42454A; --text-3:#8B8F95;
}

*,*::before,*::after{box-sizing:border-box;border-radius:0}
body{
  margin:0 auto; max-width:680px; padding:22px 16px 48px;
  background:var(--bg); color:var(--bone);
  font:16px/1.5 var(--sans);
  -webkit-font-smoothing:antialiased;
}

.k{font:10px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
.n{font:40px/.95 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.04em;
   color:var(--orange);margin:0 0 26px}
.n.calm{color:var(--bone)}

.repo{font:10px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;
      color:var(--dim);margin:26px 0 10px;display:flex;gap:10px;align-items:center}
.repo::after{content:"";flex:1;height:1px;background:var(--rule)}

.run{border:1px solid var(--rule-hot);border-left-width:3px;background:var(--panel);
     padding:15px 16px;margin-bottom:14px}
.run.needs-input{border-left-color:var(--orange);background:var(--panel-2)}
.run.blocked{border-left-color:var(--amber)}
.run.running{border-left-color:var(--dim)}
/* Working, with something blocked. Amber edge, matching the unit dot and the
   desktop, so the block is visible before the badge is read. */
.run.running.warn{border-left-color:var(--amber)}
.run.paused,.run.done{border-left-color:var(--rule-hot)}

/* Wraps, and the title keeps a floor on its width. The state badge is nowrap by
   necessity and grew from "RUNNING" to "RUNNING · 1 BLOCKED · NO UPDATE 2h31m";
   against an unconstrained h2 with overflow-wrap:anywhere that squeezed the
   title to one character per line on a 390px phone. The badge now drops to its
   own line instead. */
.hd{display:flex;align-items:baseline;gap:8px 10px;justify-content:space-between;
    flex-wrap:wrap}
.hd .st{flex:0 0 auto;margin:0}
h2{font:600 17px/1.35 var(--sans);margin:0;overflow-wrap:anywhere;
   flex:1 1 14ch;min-width:0}
.mach{font:11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}

.st{display:inline-block;margin:11px 0 0;padding:4px 7px;border:1px solid var(--rule-hot);
    font:10px/1 var(--mono);letter-spacing:.13em;color:var(--dim);white-space:nowrap}
.needs-input .st{color:var(--bg);background:var(--orange);border-color:var(--orange)}
.blocked .st{color:var(--amber);border-color:var(--amber)}
.nostamp .st{color:var(--amber);border-color:var(--amber);background:none}
.needs-input.nostamp .st{color:var(--bg);background:var(--orange);border-color:var(--orange);
  outline:1px solid var(--amber);outline-offset:1px}

.note{font-size:15px;color:var(--bone);margin:11px 0 0;overflow-wrap:anywhere}
.ask{margin:12px 0 0;padding:11px 12px;background:var(--panel-2);
     border-left:2px solid var(--orange);font-size:15px;color:var(--bone);overflow-wrap:anywhere}
.blocked .ask,.ask.warn{border-left-color:var(--amber)}

/* Units. Same three columns as the HUD so the two surfaces read alike. */
.units{margin:14px 0 0;border-top:1px solid var(--rule);padding-top:4px}
.u{display:grid;grid-template-columns:7px 38px minmax(0,1fr) 54px;gap:8px;
   align-items:baseline;padding:5px 0}
.dot{width:6px;height:6px;align-self:start;margin-top:7px;background:var(--rule-hot)}
.u.done .dot{background:var(--bone)}
.u.running .dot{background:var(--orange)}
.u.blocked .dot{background:var(--amber)}
.u.failed .dot{background:var(--bone);box-shadow:inset 0 0 0 1px var(--orange)}
.uid{font:11px/1.45 var(--mono);letter-spacing:.06em;color:var(--text-3);
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ul{font:14px/1.45 var(--sans);color:var(--dim);overflow-wrap:anywhere}
.u.done .ul,.u.running .ul{color:var(--bone)}
.dur{font:11px/1.45 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.04em;
     text-align:right;white-space:nowrap;color:var(--text-3)}
.dur.is-done{color:var(--dim)}
.dur.is-running{color:var(--orange)}
.dur.is-bad{color:var(--amber)}
.more{padding:5px 0 5px 61px;font:10px/1.45 var(--mono);letter-spacing:.1em;
      text-transform:uppercase;color:var(--text-3)}

/* Sub-agents, indented past the label column exactly as on the desktop. */
.a{display:grid;grid-template-columns:4px minmax(0,1fr) 54px;gap:8px;
   align-items:baseline;padding:3px 0 3px 61px}
.a .dot{width:4px;height:4px;align-self:start;margin-top:7px;background:var(--rule-hot)}
.a.done .dot{background:var(--bone)}
.a.running .dot{background:var(--orange)}
.a.blocked .dot{background:var(--amber)}
.a.failed .dot{background:var(--bone);box-shadow:inset 0 0 0 1px var(--orange)}
.al{font:13px/1.45 var(--sans);color:var(--text-3);overflow-wrap:anywhere}
.a.done .al,.a.running .al{color:var(--dim)}

.foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin:13px 0 0;
      padding-top:10px;border-top:1px solid var(--rule);
      font:11px/1.4 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim)}

.run.collapsed{padding:12px 16px}
.run.collapsed h2{font-size:15px}
.mini{flex:none;font:11px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.06em;color:var(--dim)}
.empty{color:var(--dim);font:12px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase}
footer{margin-top:30px;font:11px/1.5 var(--mono);color:var(--dim);
       display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;
       border-top:1px solid var(--rule);padding-top:14px}

/* Refresh. Installed to the home screen the page runs standalone, with no
   address bar and no pull-to-refresh, so without this there is no way to get a
   newer copy short of closing the app. A link to the page itself, because the
   Content-Security-Policy is default-src 'none' and no script may run. */
.rf{display:inline-flex;align-items:center;gap:7px;padding:9px 14px;
    border:1px solid var(--rule-hot);color:var(--bone);text-decoration:none;
    font:11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;
    /* A comfortable tap target on a phone. */
    min-height:38px}
.rf:active{border-color:var(--orange);color:var(--orange)}
.rf::before{content:"";width:7px;height:7px;background:var(--orange)}
.age{font-variant-numeric:tabular-nums}

/* Live sessions publishing nothing. Same rank as on the desktop: below the
   runs, quieter than them, one line each. "Not reporting" is an absence of
   state rather than a fifth one, so the mark is a rule tint and not an accent. */
.sess{padding:9px 0;border-bottom:1px solid var(--rule)}
.sess:last-of-type{border-bottom:0}
.sess-head{display:flex;align-items:baseline;gap:9px}
.sess .dot{width:5px;height:5px;align-self:center;margin:0;background:var(--dimmer)}
/* What the session last published. A session between pieces of work is not the
   same thing as one nobody has heard from, and the bare row said the second
   about both. */
.sctx{margin:4px 0 0 14px;font:12px/1.4 var(--sans);color:var(--text-3);overflow-wrap:anywhere}
.sl{flex:1 1 auto;min-width:0;font:12px/1.4 var(--mono);color:var(--text-3);
    overflow-wrap:anywhere}
.stag{flex:0 0 auto;font:9px/1 var(--mono);letter-spacing:.12em;color:var(--dim);
      border:1px solid var(--rule-hot);padding:3px 5px;white-space:nowrap}

/* History. Deliberately quieter than the live board: it is a record, and a
   finished run competing for attention with a running one is the whole problem
   this section was added to solve. One line each, no units, no left accent. */
.hist-head{font:10px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;
           color:var(--dim);margin:34px 0 12px;display:flex;gap:10px;align-items:center}
.hist-head::after{content:"";flex:1;height:1px;background:var(--rule)}
.h{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;
   align-items:baseline;padding:9px 0;border-bottom:1px solid var(--rule)}
.h:last-of-type{border-bottom:0}
.hg{font:14px/1.4 var(--sans);color:var(--dim);overflow-wrap:anywhere}
.hm{font:11px/1.4 var(--mono);font-variant-numeric:tabular-nums;color:var(--text-3);
    white-space:nowrap;text-align:right}
.hsub{grid-column:1/-1;font:11px/1.45 var(--mono);color:var(--text-3)}
`;

function unitRows(units, now) {
  const w = unitWindow(units);
  // Over the whole run, not the window: a stamp pair can straddle the fold.
  const batched = batchStamped(units);
  const row = (u) => {
    const d = durationOf(u, now, batched);
    const agents = u.state === 'running'
      ? u.agents.map((a) => {
          const ad = durationOf(a, now);
          return `<div class="a ${esc(a.state)}"><i class="dot"></i>` +
            `<span class="al">${esc(a.label)}</span>` +
            `<span class="${esc(ad.cls)}">${esc(ad.text)}</span></div>`;
        }).join('')
      : '';
    return `<div class="u ${esc(u.state)}"><i class="dot"></i>` +
      `<span class="uid">${esc(u.id)}</span>` +
      `<span class="ul">${esc(u.label || '—')}</span>` +
      `<span class="${esc(d.cls)}"${d.why ? ` title="${esc(d.why)}"` : ''}>${esc(d.text)}</span>` +
      `</div>${agents}`;
  };
  return [
    w.earlier ? `<div class="more">+${w.earlier} earlier</div>` : '',
    ...w.visible.map(row),
    w.gap ? `<div class="more">+${w.gap} later</div>` : '',
    ...w.tail.map(row),
  ].join('');
}

function runCard(r, now, expanded) {
  const st = runState(r);
  const ask = askOf(r, now);
  const c = counts(r.units);
  const e = eta(r.units);
  const elapsed = elapsedText(r, now);
  if (!expanded) {
    // Same rule as the desktop: at scale most runs collapse to one line, and
    // the surfaces must agree about which ones. expandSet decides for both.
    return `
<article class="run collapsed ${esc(st)}${blockedNote(r) ? ' warn' : ''}${quietMs(r, now) === null ? ' nostamp' : ''}">
  <div class="hd">
    <h2>${esc(r.goal)}</h2>
    <span class="st">${esc(stateText(r, now, r.session))}</span>
  </div>
  <p class="foot"><span class="mach">${esc(r.machine)}</span> · ${c.done}/${c.total}</p>
</article>`;
  }
  return `
<article class="run ${esc(st)}${blockedNote(r) ? ' warn' : ''}${quietMs(r, now) === null ? ' nostamp' : ''}">
  <div class="hd">
    <h2>${esc(r.goal)}</h2>
    <span class="st">${esc(stateText(r, now, r.session))}</span>
  </div>
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
  ${ask ? `<p class="ask${blockedNote(r) ? ' warn' : ''}">${esc(ask)}</p>` : ''}
  ${r.units.length ? `<div class="units">${unitRows(r.units, now)}</div>` : ''}
  <div class="foot">
    <span><span class="mach">${esc(r.machine)}</span> · ${c.done} of ${c.total} done${elapsed ? ` · ${elapsed}` : ''}</span>
    <span>${e ? esc(etaText(e)) : ''}</span>
  </div>
</article>`;
}

/**
 * @param {{now?: number, vault?: string, outDir?: string}} opts
 * @returns {Promise<string>} the path written
 * @throws when the vault cannot be read, rather than publishing an empty board
 */
// How many finished runs the page carries. The board is read on a phone, and
// history is for glancing back over recent sessions rather than auditing the
// year. Anything dropped is stated on the page, never trimmed silently.
const HISTORY_LIMIT = 40;

/** How long a run took, end to end, from its own stamps. */
function ranFor(r) {
  const a = Date.parse(r.started);
  const b = Date.parse(r.updated);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? humanMs(b - a) : '';
}

/**
 * Sessions that are alive and publishing nothing.
 *
 * The phone gets these for the same reason the desktop does: without them a
 * quiet board is indistinguishable from an idle machine. They are not clickable
 * here, because there is no terminal to focus from a phone.
 */
function sessionSection(sessions, now) {
  if (!sessions.length) return '';
  const rows = sessions.map((s) =>
    `<div class="sess"><div class="sess-head"><i class="dot"></i>` +
    `<span class="sl">${esc(sessionText(s, now))}</span>` +
    `<span class="stag">${s.context ? 'IDLE' : 'NO STATUS'}</span></div>` +
    (s.context ? `<div class="sctx">${esc(s.context)}</div>` : '') +
    `</div>`).join('');
  return `<p class="hist-head">Not reporting · ${String(sessions.length).padStart(2, '0')}</p>${rows}`;
}

/** A finished run is one line: what it was, when it ended, how much it did. */
function historySection(finished, now) {
  if (!finished.length) return '';
  const shown = finished.slice(0, HISTORY_LIMIT);
  const rows = shown.map((r) => {
    const c = counts(r.units);
    const ended = Date.parse(r.updated);
    const when = Number.isFinite(ended)
      ? new Date(ended).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : 'no date';
    const took = ranFor(r);
    return `<div class="h">` +
      `<span class="hg">${esc(r.goal)}</span>` +
      `<span class="hm">${esc(when)}${took ? ` · ${esc(took)}` : ''}</span>` +
      (r.note ? `<span class="hsub">${esc(r.note)}</span>` : '') +
      `<span class="hsub">${esc(r.project || '—')} · ${c.done}/${c.total} units</span>` +
      `</div>`;
  }).join('');
  const dropped = finished.length - shown.length;
  // The window is stated rather than left to be inferred from what is missing.
  // Runs older than it are already gone by the time this renders, so without
  // saying so the list looks like the complete history and is not.
  const days = Math.round(FINISHED_MAX_AGE_MS / 86_400_000);
  return `<p class="hist-head">Finished · ${String(finished.length).padStart(2, '0')} ` +
    `· last ${days} days</p>` +
    rows +
    (dropped ? `<p class="hsub">${dropped} older not shown</p>` : '');
}

export async function build(opts = {}) {
  const now = opts.now ?? Date.now();
  const vault = opts.vault ?? VAULT;
  const outDir = opts.outDir ?? HERE;

  // readBoard carries the unreadable-vault guard. A deploy overwrites a live
  // board with whatever it renders, so "I could not read the vault" must stop
  // the build. It does NOT stop on an empty-but-readable vault: no runs is a
  // true and useful statement, and refusing to publish it would replace one
  // silent lie with another.
  // `opts.sessions` lets a test hand sessions in rather than read the machine.
  const { active, finished, unpublished, skipped } = await readBoard(vault, opts.sessions, now);

  const needing = active.filter((r) => runState(r) === 'needs-input').length;
  const expand = expandSet(active);

  // Group by repo, worst urgency first, exactly as the HUD does.
  const rank = { 'needs-input': 0, blocked: 1, running: 2, paused: 3, done: 4 };
  const byRepo = new Map();
  for (const r of active) {
    const key = r.project || '—';
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(r);
  }
  const worst = (list) => Math.min(...list.map((r) => rank[runState(r)]));
  const groups = [...byRepo.entries()]
    .sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]));

  const body = active.length
    ? groups.map(([repo, list]) =>
        (groups.length > 1 ? `<p class="repo">${esc(repo)}</p>` : '') +
        list.sort((a, b) => sortRank(a) - sortRank(b))
            .map((r) => runCard(r, now, expand.has(r.runId))).join('')).join('')
    : '<p class="empty">No run is publishing status</p>';

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Auto-refresh. Added to the home screen this page runs standalone: no address
     bar, no reload button, no pull-to-refresh, so a stale copy could sit there
     indefinitely. A meta refresh is the only mechanism available, because the
     Content-Security-Policy is default-src 'none' and no script may run; the
     alternative was widening the CSP on a page that serves real vault content
     to an unauthenticated GET, which is not worth a nicer reload.
     120s, comfortably under the publisher's 5-minute cycle. -->
<meta http-equiv="refresh" content="120">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#08090A" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F4F2EE" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<!-- Both spellings. The apple- prefix is what iOS has always read and is what
     makes the home-screen install run standalone; the unprefixed name is the
     standard one and the only one modern engines accept without warning. -->
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Runs">
<title>Run status</title>
<style>${CSS}</style>
<p class="k">${needing ? 'Needs you' : 'Active runs'}</p>
<p class="n${needing ? '' : ' calm'}">${String(needing || active.length).padStart(2, '0')}</p>
${body}
${sessionSection(unpublished, now)}
${historySection(finished, now)}
<footer>
  <a class="rf" href="/" aria-label="Reload this page now">Refresh</a>
  <span class="age">Built ${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · reloads every 2 min</span>${skipped
    ? `<span class="age">${skipped} run ${skipped === 1 ? 'file' : 'files'} unreadable</span>`
    : ''}
</footer>`;

  await mkdir(outDir, { recursive: true });
  const out = join(outDir, 'status.html');
  await writeFile(out, html);
  return out;
}

// argv[1] is undefined under `node -e` and `node --eval`, and pathToFileURL
// throws on undefined, so any programmatic import of this module crashed on
// load before the guard could answer. Check it exists before converting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A build that cannot vouch for its own output must fail the shell, or
  // deploy.sh carries on and publishes it.
  try {
    console.log(await build());
  } catch (err) {
    process.stderr.write(`[status-page] ${err.message}\n`);
    process.exit(1);
  }
}
