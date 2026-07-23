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
    hot = { name: topCpu.name, kind: 'cpu', cpuPct: topCpu.cpuPct, rssBytes: topCpu.rssBytes };
  } else if (memHot) {
    hot = { name: topMem.name, kind: 'mem', cpuPct: null, rssBytes: topMem.rssBytes };
  }
  return { hot, count: rows.length };
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
    const doProcs = forceAll || tick % PROC_EVERY === 0;
    const doSlow = forceAll || tick % SLOW_EVERY === 0;
    tick++;

    const [gpu, memory, procs, battery, thermal] = await Promise.all([
      sampleGpu(),
      sampleMemory(),
      doProcs ? sampleProcesses() : Promise.resolve(undefined),
      doSlow ? sampleBattery() : Promise.resolve(undefined),
      doSlow ? sampleThermal() : Promise.resolve(undefined)
    ]);

    latest = {
      at: new Date().toISOString(),
      intervalMs: BASE_MS,
      cores: os.cpus().length,
      cpu: cpuPercent(),
      gpu,
      memory,
      battery: battery === undefined ? latest.battery : battery,
      thermal: thermal === undefined ? latest.thermal : thermal,
      hot: procs === undefined ? latest.hot : (procs?.hot ?? null),
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
        `hot ${m.hot ? `${m.hot.name} ${m.hot.cpuPct ?? ''}` : 'none'} · ${ms.toFixed(0)}ms\n`
    );
  }
  process.exit(0);
}
