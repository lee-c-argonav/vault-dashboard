// shortcuts.js — the one place vault-hud can act on the machine rather than just
// read the vault. Everything here is deliberately narrow.
//
// THREAT MODEL. The rest of this server is a pure reader. These shortcuts give it
// a command surface, so the trust boundary is drawn hard:
//   1. The catalogue is authored by the user in tools.json and read at boot. The
//      browser never supplies a command, a URL, or an argument — only an `id`.
//   2. The server looks that id up in the catalogue and runs the fixed action it
//      finds. A `browser`/`open` action's URL and an `exec` action's argv come
//      entirely from tools.json.
//   3. Nothing is ever run through a shell. execFile with an argv array means no
//      word-splitting, no globbing, no interpolation. osascript receives the URL
//      as an `on run argv` argument, not spliced into the script text.
// So the blast radius is exactly the set of shortcuts the user wrote, and a
// malicious id simply 404s.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'tools.json');

// tools.json keeps machine- and account-specific values out of tracked source by
// referencing them as ${VAR}. They are substituted from the environment (populated
// from .env at boot) before the JSON is parsed. An unset var expands to an empty
// string, which is why a shortcut pointing only at unset vars simply drops out.
function expandEnv(text) {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name] ?? '';
    // Keep the result valid JSON: escape backslashes and quotes from the value.
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
}

/**
 * Focus a Chrome tab whose URL starts with any of the given prefixes, else open a
 * new one. The URL and every prefix arrive as `on run argv` arguments, never
 * interpolated into the script text.
 *
 * Prefixes are a list, tried in order, because services redirect: opening
 * supabase.com/dashboard/project/<ref> can land on a sign-in or a sub-page, so an
 * exact-URL match would miss the tab it just opened and duplicate it on every
 * click. Narrow prefix first, broader fallback after.
 */
const CHROME_FOCUS_OR_OPEN = [
  'on run argv',
  '  set theURL to item 1 of argv',
  '  if (count of argv) > 1 then',
  '    set prefixes to items 2 thru -1 of argv',
  '  else',
  '    set prefixes to {theURL}',
  '  end if',
  '  tell application "Google Chrome"',
  '    activate',
  '    if (count of windows) is 0 then',
  '      make new window',
  '      set URL of active tab of front window to theURL',
  '      return',
  '    end if',
  '    repeat with p in prefixes',
  '      repeat with w in windows',
  '        set idx to 0',
  '        repeat with t in tabs of w',
  '          set idx to idx + 1',
  '          if (URL of t) starts with p then',
  '            set active tab index of w to idx',
  '            set index of w to 1',
  '            return',
  '          end if',
  '        end repeat',
  '      end repeat',
  '    end repeat',
  '    tell front window to make new tab with properties {URL:theURL}',
  '  end tell',
  'end run'
];

let catalogue = [];

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Read tools.json. Missing or malformed config is not fatal: the row of buttons
 * simply does not appear, and the rest of the dashboard is unaffected.
 * @returns {Promise<number>} how many shortcuts loaded
 */
export async function loadShortcuts() {
  try {
    const raw = JSON.parse(expandEnv(await readFile(CONFIG, 'utf8')));
    catalogue = Array.isArray(raw?.shortcuts) ? raw.shortcuts.filter(isValid) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[vault-hud] tools.json ignored: ${err.message}\n`);
    }
    catalogue = [];
  }
  return catalogue.length;
}

function isValid(s) {
  if (!s || typeof s.id !== 'string' || typeof s.label !== 'string') return false;
  if (s.type === 'exec') return Array.isArray(s.run) && s.run.every((a) => typeof a === 'string');
  if (s.type === 'browser' || s.type === 'open') return typeof s.url === 'string';
  return false;
}

/** The client only ever sees presentation fields, never the command or the URL. */
export function publicShortcuts() {
  return catalogue.map((s) => ({
    id: s.id,
    label: s.label,
    icon: typeof s.icon === 'string' ? s.icon : null,
    title: s.title ?? s.id,
    accent: s.accent === true
  }));
}

/**
 * Run the shortcut with this id. Returns { ok } or { error }. Never throws into
 * the request handler.
 */
export function runShortcut(id) {
  const s = catalogue.find((x) => x.id === id);
  if (!s) return { ok: false, status: 404, error: 'unknown shortcut' };

  try {
    if (s.type === 'exec') {
      spawn(s.run[0], s.run.slice(1));
    } else if (s.type === 'browser') {
      const url = resolveUrl(s);
      const prefixes = (Array.isArray(s.match) ? s.match : [s.match ?? url]).filter(Boolean);
      spawn('osascript', [...CHROME_FOCUS_OR_OPEN.flatMap((l) => ['-e', l]), url, ...prefixes]);
    } else if (s.type === 'open') {
      spawn('open', [resolveUrl(s)]);
    }
    return { ok: true };
  } catch (err) {
    process.stderr.write(`[vault-hud] shortcut ${id} failed: ${err.message}\n`);
    return { ok: false, status: 500, error: 'shortcut failed' };
  }
}

/** `{today}` in a URL expands to the local date, so the daily-note button always
 *  points at today without the catalogue needing a nightly edit. */
function resolveUrl(s) {
  return s.url.replaceAll('{today}', localDate(new Date()));
}

function spawn(cmd, args) {
  execFile(cmd, args, (err) => {
    if (err) process.stderr.write(`[vault-hud] ${cmd} exited: ${err.message}\n`);
  });
}
