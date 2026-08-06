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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { readRuns } from '../runs.js';
import {
  LABEL, runState, stateText, durationOf, unitWindow, expandSet, askOf, quietMs,
  eta, etaText, elapsedText, humanMs, counts,
} from '../public/runs-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.VAULT_HUD_VAULT || join(homedir(), 'Obsidian', 'vault');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
.run.paused,.run.done{border-left-color:var(--rule-hot)}

.hd{display:flex;align-items:baseline;gap:10px;justify-content:space-between}
h2{font:600 17px/1.35 var(--sans);margin:0;overflow-wrap:anywhere}
.mach{flex:none;font:10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}

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
.blocked .ask{border-left-color:var(--amber)}

/* Units. Same three columns as the HUD so the two surfaces read alike. */
.units{margin:14px 0 0;border-top:1px solid var(--rule);padding-top:4px}
.u{display:grid;grid-template-columns:7px 44px minmax(0,1fr) 62px;gap:8px;
   align-items:baseline;padding:5px 0}
.dot{width:6px;height:6px;align-self:center;background:var(--rule-hot)}
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
.more{padding:5px 0 5px 67px;font:10px/1.45 var(--mono);letter-spacing:.1em;
      text-transform:uppercase;color:var(--text-3)}

/* Sub-agents, indented past the label column exactly as on the desktop. */
.a{display:grid;grid-template-columns:4px minmax(0,1fr) 62px;gap:8px;
   align-items:baseline;padding:3px 0 3px 67px}
.a .dot{width:4px;height:4px;background:var(--rule-hot)}
.a.done .dot{background:var(--bone)}
.a.running .dot{background:var(--orange)}
.a.blocked .dot{background:var(--amber)}
.a.failed .dot{background:var(--bone);box-shadow:inset 0 0 0 1px var(--orange)}
.al{font:13px/1.45 var(--sans);color:var(--text-3);overflow-wrap:anywhere}
.a.done .al,.a.running .al{color:var(--dim)}

.foot{display:flex;justify-content:space-between;gap:12px;margin:13px 0 0;
      padding-top:10px;border-top:1px solid var(--rule);
      font:11px/1.4 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim)}

.run.collapsed{padding:12px 16px}
.run.collapsed h2{font-size:15px}
.mini{flex:none;font:11px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.06em;color:var(--dim)}
.empty{color:var(--dim);font:12px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase}
footer{margin-top:30px;font:11px/1.5 var(--mono);color:var(--dim)}
`;

function unitRows(units, now) {
  const w = unitWindow(units);
  const row = (u) => {
    const d = durationOf(u, now);
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
<article class="run collapsed ${esc(st)}${quietMs(r, now) === null ? ' nostamp' : ''}">
  <div class="hd">
    <h2>${esc(r.goal)}</h2>
    <span class="mini">${c.done}/${c.total}</span>
  </div>
  <span class="st">${esc(stateText(r, now))}</span>
</article>`;
  }
  return `
<article class="run ${esc(st)}${quietMs(r, now) === null ? ' nostamp' : ''}">
  <div class="hd">
    <h2>${esc(r.goal)}</h2>
    <span class="mach">${esc(r.machine)}</span>
  </div>
  <span class="st">${esc(stateText(r, now))}</span>
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
  ${ask ? `<p class="ask">${esc(ask)}</p>` : ''}
  ${r.units.length ? `<div class="units">${unitRows(r.units, now)}</div>` : ''}
  <div class="foot">
    <span>${c.done} of ${c.total} done${elapsed ? ` · ${elapsed}` : ''}</span>
    <span>${e ? esc(etaText(e)) : ''}</span>
  </div>
</article>`;
}

export async function build(now = Date.now()) {
  const runs = await readRuns(VAULT);
  const needing = runs.filter((r) => runState(r) === 'needs-input').length;
  const expand = expandSet(runs);

  // Group by repo, worst urgency first, exactly as the HUD does.
  const rank = { 'needs-input': 0, blocked: 1, running: 2, paused: 3, done: 4 };
  const byRepo = new Map();
  for (const r of runs) {
    const key = r.project || '—';
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(r);
  }
  const worst = (list) => Math.min(...list.map((r) => rank[runState(r)]));
  const groups = [...byRepo.entries()]
    .sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]));

  const body = runs.length
    ? groups.map(([repo, list]) =>
        (groups.length > 1 ? `<p class="repo">${esc(repo)}</p>` : '') +
        list.sort((a, b) => rank[runState(a)] - rank[runState(b)])
            .map((r) => runCard(r, now, expand.has(r.runId))).join('')).join('')
    : '<p class="empty">No run is publishing status</p>';

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#08090A" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F4F2EE" media="(prefers-color-scheme: light)">
<title>Run status</title>
<style>${CSS}</style>
<p class="k">${needing ? 'Needs you' : 'Active runs'}</p>
<p class="n${needing ? '' : ' calm'}">${String(needing || runs.length).padStart(2, '0')}</p>
${body}
<footer>Built ${new Date(now).toLocaleString()}</footer>`;

  await mkdir(HERE, { recursive: true });
  const out = join(HERE, 'status.html');
  await writeFile(out, html);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await build());
