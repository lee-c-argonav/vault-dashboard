#!/usr/bin/env bash
#
# deploy.sh — build the phone status page and push it to Vercel.
#
# One command, so a session at a phase boundary has nothing to remember and no
# way to publish a stale page: the build always runs first, against the live
# vault, and the deploy always targets the same project.
#
# The URL is permanent. `--prod` deploys to the project's production alias
# rather than a per-deployment preview URL, which is the whole point: a preview
# URL changes on every push and would have to be re-bookmarked every time.
#
# Requires `vercel login` once, interactively, by the person who owns the
# account. Everything after that is non-interactive.
#
# NOT Git-connected, deliberately. status.html carries real vault content — goal
# names, notes, the questions waiting on you — and vault-hud is a PUBLIC repo, so
# the file is gitignored. Importing this project from GitHub would either serve
# an empty page or require committing that content, which must never happen.
# The CLI uploads the built file straight from this machine instead.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${VAULT_HUD_VAULT:-$HOME/Desktop/lee-vault/lee-main}"

# The team and the page URL are machine- and account-specific, so they live in
# the gitignored .env like every other such value in this repo. The URL in
# particular is the ONLY access control the page has: it is an obscured slug on
# a page that serves real vault content to an unauthenticated GET, so committing
# it to a public repo would hand it to anyone. See .env.example.
if [ -f "$HERE/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/../.env"
  set +a
fi

: "${VERCEL_SCOPE:?set VERCEL_SCOPE in .env (see .env.example)}"
: "${STATUS_PAGE_URL:?set STATUS_PAGE_URL in .env (see .env.example)}"

command -v vercel >/dev/null 2>&1 || {
  echo "vercel CLI not installed. Run: npm i -g vercel" >&2
  exit 1
}

# Build first. A deploy of a stale file is worse than no deploy, because the
# page carries a timestamp and looks current.
VAULT_HUD_VAULT="$VAULT" node "$HERE/build.js" >/dev/null || {
  echo "build failed; nothing deployed" >&2
  exit 1
}

# The build writes status.html beside itself; Vercel serves ./public.
cp "$HERE/status.html" "$HERE/public/index.html" || exit 1

# One mark for one instrument: the icons are the HUD's, copied at deploy time
# rather than duplicated in the repo.
for icon in apple-touch-icon.png favicon-32.png icon-192.png icon-512.png icon-maskable-512.png; do
  cp "$HERE/../public/$icon" "$HERE/public/$icon" || exit 1
done

cd "$HERE" || exit 1
out=$(vercel deploy --prod --yes --scope "$VERCEL_SCOPE" 2>&1)
status=$?
if [ "$status" -ne 0 ]; then
  echo "$out" >&2
  echo "deploy failed" >&2
  exit "$status"
fi

# The per-deployment URL changes every push; the alias is the bookmark. Print
# the alias when the CLI reports one, and fall back to its own tail if not.
alias_line=$(printf '%s\n' "$out" | grep -oF "$STATUS_PAGE_URL" | head -1)
if [ -n "$alias_line" ]; then
  echo "deployed → $alias_line"
else
  printf '%s\n' "$out" | tail -3
fi
