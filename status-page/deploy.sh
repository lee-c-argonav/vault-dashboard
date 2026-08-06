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

cd "$HERE" || exit 1
out=$(vercel deploy --prod --yes 2>&1)
status=$?
if [ "$status" -ne 0 ]; then
  echo "$out" >&2
  echo "deploy failed" >&2
  exit "$status"
fi

# Print the production URL, not the deployment-specific one, so what is echoed
# here is the link that stays valid.
printf '%s\n' "$out" | tail -3
