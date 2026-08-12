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

# The team and the page URL are machine- and account-specific, so they live in
# the gitignored .env like every other such value in this repo. The URL in
# particular is the ONLY access control the page has: it is an obscured slug on
# a page that serves real vault content to an unauthenticated GET, so committing
# it to a public repo would hand it to anyone. See .env.example.
#
# SOURCED BEFORE VAULT IS RESOLVED, and the order is load-bearing. It ran the
# other way round from 2026-08-06 to 2026-08-10: VAULT expanded a
# VAULT_HUD_VAULT that .env had not defined yet, fell back to the generic
# default, and every deploy for four days built the page from a directory that
# does not exist on this machine. The page published "No run is publishing
# status" with a current timestamp while the desktop HUD showed a live run.
# test/publish.test.js asserts this ordering; do not move either block.
if [ -f "$HERE/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/../.env"
  set +a
fi

VAULT="${VAULT_HUD_VAULT:-$HOME/Obsidian/vault}"

# Fail here rather than let the build render an empty board. build.js refuses
# too, so this is the first of two guards; it exists because the message a
# person reads from the script can name the value they have to fix.
if [ ! -d "$VAULT/15-Runs" ]; then
  echo "no 15-Runs under $VAULT" >&2
  echo "set VAULT_HUD_VAULT in $HERE/../.env (see .env.example); nothing deployed" >&2
  exit 1
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

# Publish-time confidentiality scan. There was no check of any kind between the
# build and the upload: the pre-push gate reads the git tree, and this page is
# never committed, so nothing had ever looked at the bytes actually served.
#
# The session NAME is exempt too, as of 2026-08-11, because the operator asked
# for it and it is therefore deliberately published content — the same category
# as a run goal, not an accident. It is exempted per ELEMENT, so the gate still
# reads everything else on the row: a path, a branch or a tool name appearing
# beside the name would still block the publish.
#
# This is the narrowest change that unblocks it. The alternative — dropping the
# two name patterns in .confidential-patterns — would blind the scan everywhere,
# and a session name contains those words incidentally rather than being what the
# patterns are for. Reverse by deleting the class="sl" line below.
#
# RUN-AUTHORED TEXT IS EXEMPT by the 2026-08-11 decision — the goal, the note,
# unit labels, the ask and the run's project are deliberately published, and the
# operator writes them. Those regions are stripped before the scan, so what is
# checked is everything ELSE: session lines, the legend, the footer, history.
# That is where a new leak would appear, and it is the class this cannot catch by
# reading the source, because the source is a template and the leak is a value.
#
# The stripped list is longer than the obvious three because the same authored
# text reaches the page through several elements: the goal appears in the run
# heading, again in a session's goal-recall line, and again in history. The first
# run of this scan found the last two, which is the gate working.
patterns="$HERE/../.confidential-patterns"
if [ -f "$patterns" ]; then
  scrubbed=$(sed -E \
    -e 's#<h2>[^<]*</h2>##g' \
    -e 's#<p class="note">[^<]*</p>##g' \
    -e 's#<p class="ask[^"]*">[^<]*</p>##g' \
    -e 's#<span class="hsub">[^<]*</span>##g' \
    -e 's#<p class="repo">[^<]*</p>##g' \
    -e 's#<span class="ul">[^<]*</span>##g' \
    -e 's#<span class="uid">[^<]*</span>##g' \
    -e 's#<div class="sctx">[^<]*</div>##g' \
    -e 's#<span class="hg">[^<]*</span>##g' \
    -e 's#<span class="sl">[^<]*</span>##g' \
    "$HERE/public/index.html")
  bad=0
  while IFS= read -r pat; do
    case "$pat" in ''|\#*) continue ;; esac
    # /usr/bin/grep, never git grep: git's ERE silently ignores \b and four of
    # these patterns are written with it. Same repair as 2026-08-11.
    if printf '%s' "$scrubbed" | /usr/bin/grep -qIiE "$pat"; then
      echo "  confidential pattern in the built page: /$pat/" >&2
      printf '%s' "$scrubbed" | /usr/bin/grep -oIiE "$pat" | sort -u | head -3 | sed 's/^/      /' >&2
      bad=1
    fi
  done < "$patterns"
  if [ "$bad" -ne 0 ]; then
    echo "publish BLOCKED — the page carries confidential content outside run-authored text" >&2
    exit 1
  fi
  echo "  publish scan clean (run-authored text exempt by decision)"
else
  echo "  no .confidential-patterns; publish scan skipped" >&2
fi

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
