// metrics.js — machine vitals for the header strip. Read-only, like the rest of
// the server: it observes the Mac, it never changes it.
//
// COST IS THE DESIGN CONSTRAINT. This runs forever behind an always-open window,
// so a readout that costs real CPU to produce would be self-defeating. Three
// decisions follow from that:
//
//   1. Total CPU comes from `os.cpus()` tick deltas, in-process. No subprocess at
//      all. The kernel already keeps these counters; reading them is free.
//   2. Everything else is staggered by how fast it actually moves. GPU and memory
//      change second to second. The process table does not need to be re-read
//      that often. Battery and thermal state move over minutes.
//   3. Every sampler is skipped while its previous run is still outstanding, so a
//      wedged `ioreg` can never stack up processes.
//
// At the default 10s tick the whole module averages ~4ms of CPU per second,
// roughly 0.02% of an 18-core machine. It does not show up in its own readout.
//
// WHAT IS DELIBERATELY MISSING. CPU temperature, fan speed, and Activity
// Monitor's "Energy Impact" all come from `powermetrics`, which is root-only.
// Running a privileged sampler on a timer would cost more than everything here
// combined and would put a root surface behind a read-only dashboard. So the
// honest substitutes are used instead: `pmset -g therm` reports the OS actually
// clamping clocks, and battery temperature comes from the battery's own sensor.
// Per-process ranking is real interval CPU time, labelled CPU, never "energy".
//
// PER-PROCESS GPU is the same trap and is NOT taken the root way. The clean
// per-process GPU source, `powermetrics --samplers gpu_power`, is root-only, so
// it is refused for exactly the reasons above. What is used instead is
// unprivileged and real: every process holding a live Metal context owns
// `AGXDeviceUserClient` nodes in the IO registry, each tagged with the creating
// pid and carrying a cumulative `accumulatedGPUTime` counter. Differencing that
// per pid over an interval — the same move `sampleProcesses` makes on CPU time —
// names the process actually driving the GPU. It is a "who", reported only to
// explain a GPU reading that is already high; see `sampleGpuProcs` for what the
// counter does and does not measure.

import { execFile } from 'node:child_process';
import os from 'node:os';

// Base tick. Everything else is a multiple of it, so one env var tunes the whole
// module's cost. 10s is calm enough to be invisible and fast enough to be live.
const BASE_MS = Math.max(1000, Number(process.env.VAULT_HUD_METRICS_MS ?? 10_000));
const PROC_EVERY = 3;   // process table: every 3rd tick (30s at the default)
const SLOW_EVERY = 12;  // battery + thermal: every 12th tick (120s at the default)

// No sampler may outlive a tick. A hung ioreg is reported as a missing metric,
// not as a stalled strip.
const EXEC_TIMEOUT_MS = 1500;

// A process is worth naming when it is genuinely eating the machine, not merely
// when it is the busiest of an idle bunch. CPU is percent of ONE core, the
// convention ps/top/Activity Monitor use, so 50 means half a core.
// 80 rather than 50: WindowServer alone idles around half a core on a machine
// driving a display, and a slot that is always lit says nothing.
const HOT_CPU_PCT = 80;
const HOT_RSS_BYTES = 4 * 1024 ** 3;

/**
 * The other reason to name a process: the MACHINE is busy, whoever is doing it.
 *
 * HOT_CPU_PCT above is percent of ONE core, the ps/top convention, so it fires
 * only when a single process is individually hot. Eight processes at 20% of a
 * core each is a machine at ~160% with nothing crossing 80, and the slot stayed
 * dark — which is the case the operator was asking about when they said "if the
 * CPU is above 30% I want the app that uses it the most".
 *
 * BUSY_CPU_PCT is percent of the WHOLE machine, the same quantity the CPU cell
 * renders, so the trigger and the number it explains are finally the same
 * measurement. Above it the top process is named whether or not it is hot on its
 * own, because at that point "who is doing this" is the question.
 */
const BUSY_CPU_PCT = 30;

const BATTERY_WARM_C = 40;

/** Run a command with no shell, resolving to '' on any failure. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

// ── CPU ───────────────────────────────────────────────────────────────────────

/** Sum every core's tick counters into one pair. */
function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const core of os.cpus()) {
    const t = core.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let prevCpu = null;

/**
 * Percent of total machine capacity in use since the previous call, 0-100 across
 * all cores. Null until there are two snapshots to difference.
 */
function cpuPercent() {
  const now = cpuSnapshot();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) return null;
  const total = now.total - prev.total;
  if (total <= 0) return null;
  return clampPct((1 - (now.idle - prev.idle) / total) * 100);
}

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

// ── GPU ───────────────────────────────────────────────────────────────────────

// `Device Utilization %` inside the accelerator's PerformanceStatistics is not a
// documented interface. It is what Activity Monitor's GPU history reads, it is
// free, and it is the only unprivileged source there is. If a macOS update ever
// removes it this returns null and the client hides the cell rather than
// displaying a confident zero.
const GPU_UTIL = /"Device Utilization %"\s*=\s*(\d+)/g;

async function sampleGpu() {
  for (const cls of ['AGXAccelerator', 'IOAccelerator']) {
    const out = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', cls]);
    // A machine can expose more than one accelerator node. The busiest one is the
    // one the user can feel.
    let best = null;
    for (const m of out.matchAll(GPU_UTIL)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) best = best === null ? v : Math.max(best, v);
    }
    if (best !== null) return clampPct(best);
  }
  return null;
}

// ── GPU per-process attribution ────────────────────────────────────────────────

// `sampleGpu` says the GPU is busy; it never says who. Each process with a live
// Metal/GPU context owns one or more `AGXDeviceUserClient` nodes, and every node
// carries the pid that created it (`IOUserClientCreator`) and an `AppUsage` array
// whose `accumulatedGPUTime` is a cumulative per-process nanosecond counter.
// Differencing it over an interval — exactly what `sampleProcesses` does to `ps`
// TIME for CPU — gives GPU time consumed per process, and the busiest one is the
// process driving the reading. All of it is one unprivileged `ioreg`: no
// `powermetrics`, no root. It is the only unprivileged per-process GPU signal
// macOS exposes, and by all appearances the one Activity Monitor's own
// per-process GPU column reads; the root alternative
// (`powermetrics --show-process-gpu`) is itself unreliable on Apple Silicon.
//
// What the counter is, honestly, because it is not a documented interface:
//   - It advances when a command buffer COMPLETES, so a process that pins the GPU
//     with a single multi-second submission is under-counted until that finishes.
//     Ordinary GPU load — video, WebGL, window compositing, a stream of Metal
//     work — completes continuously and attributes correctly; one monopolising
//     kernel is the only shape it lags, and that is not what "high GPU with no
//     explanation" looks like.
//   - It is a process's share of wall time on the GPU, not a slice carved out of
//     `Device Utilization %`, so the two do not have to sum. This answers "who";
//     the GPU cell answers "how much". The client shows this slot only while the
//     GPU cell is already high, so normal compositing never lights it.
// If `AGXDeviceUserClient` or `AppUsage` ever disappears, this returns null and
// the client shows no offender rather than a confident wrong one.
const GPU_CREATOR = /"IOUserClientCreator"\s*=\s*"pid (\d+), ([^"]*)"/;
const GPU_ACCUM = /"accumulatedGPUTime"\s*=\s*(\d+)/g;

// Below this share of the interval a process is not driving the GPU, it is just
// the busiest of a quiet field; naming it would be noise. The client gates on the
// live GPU % on top of this, so the floor only has to reject the genuinely idle.
const GPU_HOT_FLOOR_PCT = 5;

let prevGpuProcs = null; // { table: Map<pid, cumulative GPU ns>, at: bigint }

/**
 * Name the process that consumed the most GPU time since the previous GPU-process
 * sample, or null if none cleared the floor. Nullable and cheap like every other
 * sampler; a missing or changed IO registry simply yields null.
 */
async function sampleGpuProcs() {
  const out = await run('ioreg', ['-r', '-c', 'AGXDeviceUserClient', '-w', '0', '-l']);
  if (!out) return null;

  const now = process.hrtime.bigint();
  const table = new Map(); // pid → summed GPU ns
  const names = new Map(); // pid → creator name

  // A pid can own several client nodes and a node several command queues, so
  // every accumulatedGPUTime in a node's block sums into that node's pid.
  for (const block of out.split('+-o AGXDeviceUserClient').slice(1)) {
    const cre = block.match(GPU_CREATOR);
    if (!cre) continue;
    const pid = Number(cre[1]);
    let ns = 0;
    for (const m of block.matchAll(GPU_ACCUM)) ns += Number(m[1]);
    table.set(pid, (table.get(pid) ?? 0) + ns);
    if (!names.has(pid)) names.set(pid, cre[2].trim());
  }

  const prev = prevGpuProcs;
  prevGpuProcs = { table, at: now };
  if (!prev) return null; // first pass only establishes the baseline

  const elapsedNs = Number(now - prev.at);
  if (elapsedNs <= 0) return null;

  let top = null;
  for (const [pid, ns] of table) {
    const before = prev.table.get(pid);
    // A pid absent last time is new (or was recycled); its lifetime total is not
    // a delta, and a recycled pid can read backwards, so only forward deltas count.
    if (before === undefined) continue;
    const dNs = ns - before;
    if (dNs <= 0) continue;
    const pct = (dNs / elapsedNs) * 100;
    if (!top || pct > top.pct) top = { pct, name: names.get(pid) };
  }

  if (!top || top.pct < GPU_HOT_FLOOR_PCT) return null;
  return { name: top.name, gpuPct: clampPct(top.pct) };
}

// ── Memory ────────────────────────────────────────────────────────────────────

/**
 * Used memory the way the machine actually feels it: resident pages plus the
 * pages the compressor is holding. Free and speculative pages are not "used";
 * inactive pages are reclaimable and are not counted either.
 */
async function sampleMemory() {
  const out = await run('vm_stat', []);
  if (!out) return null;

  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  if (!pageSize) return null;

  const pages = (label) => {
    const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm'));
    return m ? Number(m[1]) : 0;
  };

  const active = pages('Pages active');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  const total = os.totalmem(); // free, and the only figure vm_stat cannot give

  const used = (active + wired + compressed) * pageSize;
  return {
    usedBytes: used,
    totalBytes: total,
    compressedBytes: compressed * pageSize,
    percent: total > 0 ? clampPct((used / total) * 100) : null
  };
}

// ── Battery ───────────────────────────────────────────────────────────────────

/**
 * One ioreg call covers charge, charging state, time remaining, temperature,
 * cycle count and health. A machine without a battery returns nothing here, and
 * null simply hides the cell.
 */
async function sampleBattery() {
  const out = await run('ioreg', ['-r', '-n', 'AppleSmartBattery', '-w', '0']);
  if (!out) return null;

  const num = (key) => {
    const m = out.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const yes = (key) => {
    const m = out.match(new RegExp(`"${key}"\\s*=\\s*(Yes|No|true|false)`));
    return m ? m[1] === 'Yes' || m[1] === 'true' : null;
  };

  const percent = num('CurrentCapacity');
  if (percent === null) return null;

  const charging = yes('IsCharging') ?? false;
  const design = num('DesignCapacity');
  const rawMax = num('AppleRawMaxCapacity');
  // 65535 is the sentinel for "still working it out" right after a state change.
  const mins = num('TimeRemaining');

  return {
    percent: clampPct(percent),
    charging,
    external: yes('ExternalConnected') ?? false,
    minutesRemaining: mins !== null && mins > 0 && mins < 60 * 24 ? mins : null,
    // Hundredths of a degree Celsius, from the battery's own sensor. This is not
    // CPU temperature and must never be labelled as such.
    tempC: num('Temperature') !== null ? Math.round(num('Temperature') / 100) : null,
    cycles: num('CycleCount'),
    healthPct: design && rawMax ? Math.round((rawMax / design) * 100) : null
  };
}

// ── Thermal ───────────────────────────────────────────────────────────────────

/**
 * `pmset -g therm` only reports a speed limit while the OS is actually clamping
 * clocks, which makes it a true "the machine is in trouble" signal rather than a
 * temperature to stare at. Anything below 100 means throttled.
 */
async function sampleThermal() {
  const out = await run('pmset', ['-g', 'therm']);
  if (!out) return null;
  const limit = Number(out.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1] ?? 100);
  return { speedLimit: Number.isFinite(limit) ? limit : 100, throttled: limit < 100 };
}

// ── Processes ─────────────────────────────────────────────────────────────────

/**
 * ps TIME is `[dd-]hh:mm:ss.ss`, except the hours field is unbounded minutes on
 * short-lived shapes like `592:10.29`. Accumulate from the right so every shape
 * parses without branching on which one it is.
 */
function cpuSeconds(field) {
  const [days, clock] = field.includes('-') ? field.split('-') : ['0', field];
  const parts = clock.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const [i, part] of parts.reverse().entries()) seconds += part * 60 ** i;
  return seconds + Number(days) * 86_400;
}

let prevProcs = null; // Map<pid, cpuSeconds> plus the wall clock it was taken at

/**
 * Rank processes by CPU actually consumed since the previous process sample.
 *
 * `ps %cpu` is deliberately not used: on BSD it is a decaying average over up to
 * a minute, so it lags badly and reports a process that just went idle as busy.
 * Differencing cumulative CPU time over a known interval is both cheaper to
 * reason about and true for the window it covers.
 *
 * `comm` is placed last in the format string because `-c` names contain spaces
 * ("Google Chrome He"); the first three fields split cleanly and the remainder is
 * the name.
 */
async function sampleProcesses() {
  const out = await run('ps', ['-Aceo', 'pid=,time=,rss=,comm=']);
  if (!out) return null;

  const now = process.hrtime.bigint();
  const table = new Map();
  const rows = [];

  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const secs = cpuSeconds(m[2]);
    if (secs === null) continue;
    table.set(pid, secs);
    rows.push({ pid, secs, rssBytes: Number(m[3]) * 1024, name: m[4].trim() });
  }

  const prev = prevProcs;
  prevProcs = { table, at: now };
  if (!prev) return null; // first pass only establishes the baseline

  const elapsed = Number(now - prev.at) / 1e9;
  if (elapsed <= 0) return null;

  let topCpu = null;
  let topMem = null;
  for (const row of rows) {
    const before = prev.table.get(row.pid);
    // A pid absent from the previous sample is new; its lifetime CPU time is not
    // a delta and counting it would spike the readout with a phantom.
    if (before !== undefined) {
      const pct = Math.round(((row.secs - before) / elapsed) * 100);
      if (pct > 0 && (!topCpu || pct > topCpu.cpuPct)) topCpu = { ...row, cpuPct: pct };
    }
    if (!topMem || row.rssBytes > topMem.rssBytes) topMem = row;
  }

  // One slot, one offender. Whichever resource is further past its threshold is
  // the one worth naming.
  const cpuHot = topCpu && topCpu.cpuPct >= HOT_CPU_PCT;
  const memHot = topMem && topMem.rssBytes >= HOT_RSS_BYTES;
  let hot = null;
  if (cpuHot && (!memHot || topCpu.cpuPct / HOT_CPU_PCT >= topMem.rssBytes / HOT_RSS_BYTES)) {
    hot = { name: topCpu.name, pid: topCpu.pid, kind: 'cpu', cpuPct: topCpu.cpuPct, rssBytes: topCpu.rssBytes };
  } else if (memHot) {
    hot = { name: topMem.name, pid: topMem.pid, kind: 'mem', cpuPct: null, rssBytes: topMem.rssBytes };
  }
  // WHAT IT IS, not just what it is called. The table above is read with `ps -c`,
  // which reports the executable name only, so the answer to "what is eating the
  // machine" was the word `node` — true and useless, since a dozen unrelated
  // things on this machine are node.
  //
  // One targeted `ps` for the offender alone, never for the table: ~4ms, and only
  // on a tick where something already crossed a threshold, so an idle machine
  // pays nothing. The full argument list is far too long to render, so what is
  // kept is the part that distinguishes one node from another.
  if (hot) hot.detail = await describeProcess(hot.pid ?? topCpu?.pid ?? topMem?.pid);

  // `top` is returned whether or not it crossed HOT_CPU_PCT, because the OTHER
  // trigger — the machine as a whole being busy — is not knowable here. This
  // function samples the process table; the machine's CPU comes from tick deltas
  // in the loop below. The decision is made where both are in hand.
  const top = topCpu
    ? { name: topCpu.name, pid: topCpu.pid, kind: 'cpu', cpuPct: topCpu.cpuPct, rssBytes: topCpu.rssBytes }
    : null;
  return { hot, top, count: rows.length };
}

/**
 * The distinguishing part of a command line, and how long it has been up.
 *
 * Pure so it can be tested against captured `ps` output, in the style of
 * sessions.js's parsers. What it looks for, in order:
 *   1. A known marker — the automation browsers and MCP servers that accumulate
 *      on this machine are the things most often worth killing, and their own
 *      argument lists name them.
 *   2. The script or bundle a runtime was handed: the last path segment of the
 *      first argument that is not a flag. `node /a/b/server.js` is `server.js`.
 *   3. Nothing, when neither is present. An empty detail renders as no detail
 *      rather than as a guess.
 */
export function describeArgs(args) {
  const a = String(args ?? '').trim();
  if (!a) return '';
  const MARKERS = [
    [/chrome-devtools-mcp|--user-data-dir=[^ ]*chrome-devtools/, 'chrome-devtools automation browser'],
    [/ms-playwright-mcp|@playwright\/mcp/, 'playwright automation browser'],
    [/--type=renderer/, 'browser tab'],
    [/npm exec|npx /, 'npm-run tool'],
    [/vault-hud[^ ]*server\.js/, 'the HUD daemon itself'],
  ];
  for (const [re, label] of MARKERS) if (re.test(a)) return label;

  const parts = a.split(/\s+/);
  for (const part of parts.slice(1)) {
    if (part.startsWith('-')) continue;
    const leaf = part.split('/').filter(Boolean).pop();
    if (leaf && /\.(js|mjs|cjs|py|ts|sh)$/.test(leaf)) return leaf;
  }
  // An .app bundle, which is what a GUI process usually is.
  const app = a.match(/\/([^/]+)\.app\//);
  return app ? app[1] : '';
}

/** One `ps` for one pid. Empty on any failure; a missing detail is not an error. */
async function describeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  const out = await run('ps', ['-o', 'etime=,args=', '-p', String(pid)]);
  const line = String(out).trim();
  if (!line) return '';
  const m = line.match(/^(\S+)\s+(.*)$/);
  if (!m) return '';
  const detail = describeArgs(m[2]);
  return detail ? `${detail} · up ${m[1]}` : `up ${m[1]}`;
}

// ── Sampling loop ─────────────────────────────────────────────────────────────

/** Last full reading, so a new subscriber gets numbers immediately. */
let latest = emptySample();
let timer = null;
let tick = 0;
let inFlight = false;
let listener = null;
/** CLI only: sample every signal on every pass, so one run exercises all of them. */
let forceAll = false;

function emptySample() {
  return {
    at: new Date().toISOString(),
    intervalMs: BASE_MS,
    cores: os.cpus().length,
    cpu: null,
    gpu: null,
    memory: null,
    battery: null,
    thermal: null,
    hot: null,
    gpuHot: null,
    warnings: []
  };
}

/**
 * Take one reading. Slow signals are carried over from the previous sample
 * rather than re-measured, so the shape the client sees never changes.
 */
async function sample() {
  if (inFlight) return; // a wedged sampler must not stack up work
  inFlight = true;
  try {
    // CPU FIRST, because it decides whether the process table is worth reading
    // this tick. It is free — tick deltas from os.cpus(), no subprocess.
    const cpu = cpuPercent();

    // Demand-driven. The process table is normally read every 3rd tick, and at a
    // 10s base that is a 30-second answer to "who is eating the machine" — long
    // enough that a spike can be over before it is attributed, which is what
    // happened in testing: 97% CPU and an empty slot, because no process sample
    // fell inside the busy window.
    //
    // A busy machine forces the sample on the tick that noticed. The extra cost
    // is one `ps` (~15ms) and only while CPU is already above BUSY_CPU_PCT, so
    // it buys the answer exactly when it is wanted and costs nothing when idle.
    const busy = cpu !== null && cpu >= BUSY_CPU_PCT;
    const doProcs = forceAll || busy || tick % PROC_EVERY === 0;
    const doSlow = forceAll || tick % SLOW_EVERY === 0;
    tick++;

    const [gpu, memory, procs, gpuHot, battery, thermal] = await Promise.all([
      sampleGpu(),
      sampleMemory(),
      doProcs ? sampleProcesses() : Promise.resolve(undefined),
      doProcs ? sampleGpuProcs() : Promise.resolve(undefined),
      doSlow ? sampleBattery() : Promise.resolve(undefined),
      doSlow ? sampleThermal() : Promise.resolve(undefined)
    ]);

    latest = {
      at: new Date().toISOString(),
      intervalMs: BASE_MS,
      cores: os.cpus().length,
      cpu,
      gpu,
      memory,
      battery: battery === undefined ? latest.battery : battery,
      thermal: thermal === undefined ? latest.thermal : thermal,
      // Two ways to earn the slot. A process hot on its own (HOT_CPU_PCT, one
      // core), or the machine busy at all (BUSY_CPU_PCT, whole machine) — in
      // which case the top process is named even though nothing is individually
      // hot, which is the eight-processes-at-20% case the first rule misses.
      hot: procs === undefined
        ? latest.hot
        : (procs?.hot ?? (busy ? (procs?.top ?? null) : null)),
      gpuHot: gpuHot === undefined ? latest.gpuHot : gpuHot,
      warnings: []
    };
    if (latest.battery?.tempC >= BATTERY_WARM_C) {
      latest.warnings.push(`battery ${latest.battery.tempC}°C`);
    }
    if (latest.thermal?.throttled) {
      latest.warnings.push(`cpu clamped to ${latest.thermal.speedLimit}%`);
    }
    listener?.(latest);
  } catch (err) {
    // A metrics failure must never reach the vault side of the server.
    process.stderr.write(`[vault-hud] metrics sample failed: ${err?.message ?? err}\n`);
  } finally {
    inFlight = false;
  }
}

/** The latest reading, for a one-shot GET. */
export function currentMetrics() {
  return latest;
}

/**
 * Start sampling and call `onSample` after each reading. Idempotent: extra calls
 * only replace the listener. The server starts this on the first subscriber and
 * stops it on the last, so a closed window costs nothing at all.
 */
export function startMetrics(onSample) {
  listener = onSample;
  if (timer) return;

  prevCpu = cpuSnapshot();
  prevProcs = null;
  prevGpuProcs = null;
  tick = 0;

  // A subscriber wants a number now, not in ten seconds. Take a quick first
  // reading a second in, then settle into the real cadence.
  const first = setTimeout(() => {
    sample();
    timer = setInterval(sample, BASE_MS);
    timer.unref();
  }, 1000);
  first.unref();
  timer = first;
}

/** Stop sampling. Called when the last SSE subscriber disconnects. */
export function stopMetrics() {
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
  listener = null;
  prevCpu = null;
  prevProcs = null;
  prevGpuProcs = null;
}

// `node metrics.js --json` prints one full reading, matching `parse.js --json`.
// Two samples are taken because CPU and process figures are deltas and the first
// pass only establishes a baseline.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = process.hrtime.bigint();
  forceAll = true;
  startMetrics(() => {});
  await new Promise((r) => setTimeout(r, 1100));
  await sample();
  stopMetrics();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(latest, null, 2) + '\n');
  } else {
    const m = latest;
    process.stdout.write(
      `cpu ${m.cpu}% · gpu ${m.gpu}% · mem ${m.memory?.percent}% · ` +
        `bat ${m.battery?.percent}%${m.battery?.charging ? ' charging' : ''} · ` +
        `hot ${m.hot ? `${m.hot.name} ${m.hot.cpuPct ?? ''}` : 'none'} · ` +
        `gpu-hot ${m.gpuHot ? `${m.gpuHot.name} ${m.gpuHot.gpuPct}%` : 'none'} · ${ms.toFixed(0)}ms\n`
    );
  }
  process.exit(0);
}
