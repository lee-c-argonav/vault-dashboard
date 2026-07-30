#!/usr/bin/env bash
# check-no-secrets.sh — mandatory pre-push confidentiality gate for this PUBLIC repo.
#
# Scans what a push actually sends — the committed tree AND the commit messages that
# travel with it — and exits non-zero if it finds anything confidential. Two layers:
#
#   1. DETERMINISTIC — structural secret/path patterns (hard-coded below, none of
#      which are themselves sensitive) PLUS any regexes in the gitignored
#      .confidential-patterns file. Firm / product / person / account identifiers
#      live ONLY in that local file, never in this committed script, so the gate
#      cannot leak the very names it guards against. See .confidential-patterns.example.
#
#   2. LLM — if the `claude` CLI is available, a semantic reviewer reads the whole
#      committed text and flags confidential content a regex would miss (real
#      names, project codenames, private vault content). It runs only after the
#      deterministic layer is clean, and is skipped with a notice if `claude` is
#      absent or VAULT_HUD_SKIP_LLM_CHECK=1 — the deterministic layer is the floor.
#      Text larger than one pass is CHUNKED and every chunk is reviewed; the layer
#      reports CLEAN only when all of them came back clean. It never reports CLEAN
#      for a review that did not actually cover everything.
#
# Commit messages are scanned because they are pushed, are permanent, and are not
# part of any tree — a gate that reads only files cannot see them.
#
# Run before EVERY push:
#     bash scripts/check-no-secrets.sh && git push
# or let the installed hook run it automatically against EVERY ref you push
# (scripts/pre-push-hook.sh, symlinked to .git/hooks/pre-push — see that file).
#
# Usage: check-no-secrets.sh [REF] [BASE]
#   REF   commit-ish whose tree is scanned (default HEAD)
#   BASE  the remote's current sha, so messages are scanned for BASE..REF. Omitted
#         or unknown means every commit reachable from REF, which is what a push of
#         a new branch actually sends.
#
# Exit 0 = clean, safe to push. Non-zero = something confidential is committed.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

# Commit-ish to scan. Defaults to HEAD for standalone use; the pre-push hook passes
# each pushed ref's sha so `git push --all`/`--mirror` cannot slip a confidential
# branch (e.g. backup/pre-purge) past a gate that only ever looked at HEAD.
REF="${1:-HEAD}"
BASE="${2:-}"
# Files committed in $REF (the tree a push of $REF actually sends).
tracked() { git ls-tree -r --name-only "$REF"; }

# The commit range a push of $REF sends. An unknown, zero, or unreachable BASE means
# "everything reachable" — the conservative reading, and the correct one for a new
# branch. Never silently narrows to nothing.
msg_range() {
  if [ -n "$BASE" ] && [ "$BASE" != "${BASE//[^0]/}" ] \
     && git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
    printf '%s..%s' "$BASE" "$REF"
  else
    printf '%s' "$REF"
  fi
}
messages()   { git log --format='%H%n%B' "$(msg_range)" 2>/dev/null; }
# Author/committer identity is pushed with every commit and is permanent. It is not
# content anyone edits, so it gets its own finding with its own remedy: a repo-local
# git config, not a file edit.
identities() { git log --format='%an <%ae>%n%cn <%ce>' "$(msg_range)" 2>/dev/null | sort -u; }

fail=0
report() { printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=1; }
note()   { printf '  \033[33m• %s\033[0m\n' "$1"; }

SELF='scripts/check-no-secrets.sh'
# Placeholder forms that are allowed to appear anywhere; filtered out of every scan.
ALLOW='/Users/YOU|/Users/<|/ABSOLUTE/PATH|OWNER/vault-dashboard|YOUR-VAULT|project-[xyz]'
# Upper bound on the text fed to the LLM reviewer in ONE pass. Text larger than this
# is split across passes on line boundaries and every chunk is reviewed — the bound
# sizes a request, it never bounds coverage.
LLM_MAX_CHARS="${VAULT_HUD_LLM_MAX_CHARS:-500000}"

# 1. .env (or any real env file) must never be tracked. Only .env.example is allowed.
if tracked | grep -E '^\.env(\.|$)' | grep -qv '^\.env\.example$'; then
  report "a .env file is tracked — it must be gitignored"
  tracked | grep -E '^\.env(\.|$)' | grep -v '^\.env\.example$' | sed 's/^/      /'
fi

# 2. No real vault fixture may come back.
if tracked | grep -qE '(^|/)fixture.*\.json$'; then
  report "a fixture JSON is tracked — reintroduces real vault data; a demo fixture must be synthetic"
  tracked | grep -E '(^|/)fixture.*\.json$' | sed 's/^/      /'
fi

# git grep HEAD only sees committed content, which is exactly what a push sends.
# .env.example and this script are excluded; allowed placeholders are filtered after.
scan() { # $1 = human label, $2 = extended-regex
  local hits
  hits=$(git grep -nIiE "$2" "$REF" -- . ':!.env.example' ":!$SELF" 2>/dev/null | grep -vE "$ALLOW")
  if [ -n "$hits" ]; then
    report "$1"
    printf '%s\n' "$hits" | sed 's/^/      /'
  fi
}

# Same patterns, applied to the commit messages being pushed. git grep cannot reach
# these: they live in commit objects, not in any tree.
scan_msgs() { # $1 = human label, $2 = extended-regex
  local hits
  hits=$(messages | grep -nIiE "$2" | grep -vE "$ALLOW")
  if [ -n "$hits" ]; then
    report "$1 — in a COMMIT MESSAGE (rewrite history; a later commit cannot unsay it)"
    printf '%s\n' "$hits" | sed 's/^/      /'
  fi
}

# Identity is git config, not a file, so it gets the config fix rather than an edit.
#
# An identity whose email is a GitHub noreply address is exempt. That domain IS the
# platform's opt-out for exposing a real address, so such an identity is already
# exactly what GitHub publishes for the account, and the account that owns a public
# repo cannot be confidential on it. Exempting the address rather than allow-listing
# a name keeps this committed script free of the identifiers it guards.
# Residual: a display name paired with a noreply address is not pattern-scanned.
NOREPLY='@users\.noreply\.github\.com>'
scan_identity() { # $1 = human label, $2 = extended-regex
  local hits
  hits=$(identities | grep -vE "$NOREPLY" | grep -IiE "$2" | grep -vE "$ALLOW")
  if [ -n "$hits" ]; then
    report "$1 — in the COMMIT AUTHOR/COMMITTER identity of a commit being pushed"
    printf '%s\n' "$hits" | sed 's/^/      /'
    note "every commit carries this. Stop adding to it with a repo-local identity:"
    note "    git config --local user.email 'USER@users.noreply.github.com'"
    note "then amend/rebase the unpushed commits so they carry it. Commits already on"
    note "the remote keep the old identity until history is rewritten and force-pushed."
  fi
}

scan_both() { scan "$1" "$2"; scan_msgs "$1" "$2"; scan_identity "$1" "$2"; }

# 3a. Secrets — structural, never sensitive to name here.
scan_both "possible secret (JWT / API key / token / private key)" \
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(sk|rk|pk)-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# 3b. Real absolute home paths (placeholders filtered above).
scan_both "real absolute home path (use \$VAULT_HUD_VAULT, ~, or a placeholder)" \
  '/Users/[a-z0-9._-]+/'

# 3c. Local, never-committed identifiers: firm / product / project / person / account
#     names. Keeping them out of this committed file is what stops the gate leaking
#     them. One extended-regex per line; blank lines and # comments ignored.
PATTERNS_FILE='.confidential-patterns'
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r pat || [ -n "$pat" ]; do
    case "$pat" in ''|\#*) continue ;; esac
    scan_both "confidential identifier (.confidential-patterns): /${pat}/" "$pat"
  done < "$PATTERNS_FILE"
else
  note "no .confidential-patterns file — local name scan skipped (LLM layer still runs)."
  note "copy .confidential-patterns.example to .confidential-patterns and add your identifiers."
fi

# Deterministic layer must pass before spending an LLM call.
if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mPRE-PUSH CHECK FAILED (deterministic).\033[0m Do NOT push. Fix the findings above,\n'
  printf 'move machine/account values into the gitignored .env, and re-run.\n'
  printf 'If any of this was already committed, rewrite history before pushing.\n'
  exit 1
fi

# 4. LLM layer — semantic confidentiality review of the whole committed text tree.
llm_state='not run'
if [ "${VAULT_HUD_SKIP_LLM_CHECK:-}" = "1" ]; then
  note "LLM confidentiality review skipped (VAULT_HUD_SKIP_LLM_CHECK=1)."
elif ! command -v claude >/dev/null 2>&1; then
  note "\`claude\` CLI not found — LLM confidentiality review skipped (deterministic layer passed)."
else
  printf '  … running LLM confidentiality review (claude)\n'
  # Committed text only (-I skips binaries); the gate script excludes itself. The
  # commit messages being pushed are reviewed alongside it — they are as public and
  # as permanent as the files, and no tree scan can see them.
  review_text=$(
    git grep -I -n -e '.' "$REF" -- . ":!$SELF" 2>/dev/null
    printf '\n===== COMMIT MESSAGES BEING PUSHED (%s) =====\n' "$(msg_range)"
    messages
    printf '\n===== COMMIT AUTHOR/COMMITTER IDENTITIES =====\n'
    identities
  )
  read -r -d '' PROMPT <<'PROMPT' || true
You are a confidentiality reviewer for a PUBLIC open-source repository. The repository
text about to be pushed is provided on standard input (format <ref>:path:lineno:content).
Flag ANY content that must not be public:
- real company / firm names, product names, or project codenames
- person names (real individuals)
- internal or private URLs, hostnames, org / account / project identifiers
- absolute home paths or usernames
- API keys, tokens, passwords, or other secrets
- private knowledge-base content (real todos, notes, decisions, meeting content)
Obvious placeholders are FINE and must NOT be flagged: OWNER, YOUR-VAULT, /Users/YOU,
/ABSOLUTE/PATH, project-x, project-y, project-z, example.com, foo, bar.

Commit author/committer identity whose email ends in @users.noreply.github.com is
the account's PUBLIC GitHub identity and must NOT be flagged, whatever the account
name spells. GitHub publishes the owning account in the clone URL and on the repo
page of every public repository, so that name cannot be made non-public by editing
anything in this push, and reporting it blocks every push without a fix existing.
Whether the account itself should be renamed is a decision outside this review.
Identity with any OTHER email domain IS in scope: flag it.

Reply with EXACTLY one first line: "VERDICT: CLEAN" or "VERDICT: LEAK".
If LEAK, add one bullet per finding: "- <path>: <what and why>".
PROMPT
  # Split on line boundaries into passes of at most LLM_MAX_CHARS and review EVERY
  # one. Truncating instead would review a prefix and report on the whole, which is
  # the failure mode this gate exists to prevent — a partial review that reads
  # exactly like a full one.
  chunk_dir=$(mktemp -d) || exit 2
  trap 'rm -rf "$chunk_dir"' EXIT
  printf '%s\n' "$review_text" | awk -v max="$LLM_MAX_CHARS" -v dir="$chunk_dir" '
    BEGIN { n = 0; sz = 0 }
    { if (sz + length($0) + 1 > max && sz > 0) { n++; sz = 0 }
      print > sprintf("%s/chunk.%04d", dir, n); sz += length($0) + 1 }
  '
  total=$(find "$chunk_dir" -name 'chunk.*' | wc -l | tr -d ' ')
  [ "$total" -gt 1 ] && note "committed text spans ${total} review passes; all of them are reviewed."

  reviewed=0
  for chunk in "$chunk_dir"/chunk.*; do
    verdict=$(claude -p "$PROMPT" < "$chunk" 2>/dev/null)
    if [ -z "$verdict" ]; then
      note "LLM pass $((reviewed + 1))/${total} produced no output (auth / network / CLI?)."
      continue
    fi
    reviewed=$((reviewed + 1))
    if printf '%s' "$verdict" | grep -qiE 'VERDICT:[[:space:]]*LEAK'; then
      report "LLM confidentiality review flagged content (pass ${reviewed}/${total}):"
      printf '%s\n' "$verdict" | sed 's/^/      /'
    fi
  done

  # CLEAN is only claimed when every pass actually came back. An incomplete review
  # does not block the push (the deterministic layer is the floor and the CLI may
  # simply be unavailable), but it must never be reported as a clean one.
  if [ "$reviewed" -eq 0 ]; then
    note "LLM review did NOT run — relying on the deterministic layer alone."
  elif [ "$reviewed" -lt "$total" ]; then
    note "LLM review INCOMPLETE: ${reviewed} of ${total} passes returned. NOT a clean verdict — re-run before pushing."
  elif [ "$fail" -eq 0 ]; then
    llm_state='complete'
    printf '  \033[32m✓ LLM review: CLEAN (%s of %s passes)\033[0m\n' "$reviewed" "$total"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mPRE-PUSH CHECK FAILED.\033[0m Do NOT push. Resolve the findings above.\n'
  exit 1
fi

if [ "$llm_state" = 'complete' ]; then
  printf '\033[32m✓ pre-push check clean — tree, commit messages and identities, both layers.\033[0m\n'
else
  printf '\033[32m✓ deterministic checks clean\033[0m \033[33m(LLM layer did not complete — coverage is patterns only).\033[0m\n'
fi
exit 0
