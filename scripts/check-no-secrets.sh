#!/usr/bin/env bash
# check-no-secrets.sh — mandatory pre-push confidentiality gate for this PUBLIC repo.
#
# Scans the committed tree (HEAD = exactly what a push sends) and exits non-zero if
# it finds anything confidential. Two layers:
#
#   1. DETERMINISTIC — structural secret/path patterns (hard-coded below, none of
#      which are themselves sensitive) PLUS any regexes in the gitignored
#      .confidential-patterns file. Firm / product / person / account identifiers
#      live ONLY in that local file, never in this committed script, so the gate
#      cannot leak the very names it guards against. See .confidential-patterns.example.
#
#   2. LLM — if the `claude` CLI is available, a semantic reviewer reads the whole
#      committed text tree and flags confidential content a regex would miss (real
#      names, project codenames, private vault content). It runs only after the
#      deterministic layer is clean, and is skipped with a notice if `claude` is
#      absent or VAULT_HUD_SKIP_LLM_CHECK=1 — the deterministic layer is the floor.
#
# Run before EVERY push:
#     bash scripts/check-no-secrets.sh && git push
# or install as a real hook so it runs automatically:
#     ln -sf ../../scripts/check-no-secrets.sh .git/hooks/pre-push
#
# Exit 0 = clean, safe to push. Non-zero = something confidential is committed.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

fail=0
report() { printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=1; }
note()   { printf '  \033[33m• %s\033[0m\n' "$1"; }

SELF='scripts/check-no-secrets.sh'
# Placeholder forms that are allowed to appear anywhere; filtered out of every scan.
ALLOW='/Users/YOU|/Users/<|/ABSOLUTE/PATH|OWNER/vault-dashboard|YOUR-VAULT|project-[xyz]'
# Upper bound on the text fed to the LLM reviewer in one pass. Set above the current
# committed size with headroom; if the tree outgrows it the reviewer warns that its
# pass was partial (at which point split the review into chunks).
LLM_MAX_CHARS=500000

# 1. .env (or any real env file) must never be tracked. Only .env.example is allowed.
if git ls-files | grep -E '^\.env(\.|$)' | grep -qv '^\.env\.example$'; then
  report "a .env file is tracked — it must be gitignored"
  git ls-files | grep -E '^\.env(\.|$)' | grep -v '^\.env\.example$' | sed 's/^/      /'
fi

# 2. No real vault fixture may come back.
if git ls-files | grep -qE '(^|/)fixture.*\.json$'; then
  report "a fixture JSON is tracked — reintroduces real vault data; a demo fixture must be synthetic"
  git ls-files | grep -E '(^|/)fixture.*\.json$' | sed 's/^/      /'
fi

# git grep HEAD only sees committed content, which is exactly what a push sends.
# .env.example and this script are excluded; allowed placeholders are filtered after.
scan() { # $1 = human label, $2 = extended-regex
  local hits
  hits=$(git grep -nIiE "$2" HEAD -- . ':!.env.example' ":!$SELF" 2>/dev/null | grep -vE "$ALLOW")
  if [ -n "$hits" ]; then
    report "$1"
    printf '%s\n' "$hits" | sed 's/^/      /'
  fi
}

# 3a. Secrets — structural, never sensitive to name here.
scan "possible secret (JWT / API key / token / private key)" \
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(sk|rk|pk)-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# 3b. Real absolute home paths (placeholders filtered above).
scan "real absolute home path (use \$VAULT_HUD_VAULT, ~, or a placeholder)" \
  '/Users/[a-z0-9._-]+/'

# 3c. Local, never-committed identifiers: firm / product / project / person / account
#     names. Keeping them out of this committed file is what stops the gate leaking
#     them. One extended-regex per line; blank lines and # comments ignored.
PATTERNS_FILE='.confidential-patterns'
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r pat || [ -n "$pat" ]; do
    case "$pat" in ''|\#*) continue ;; esac
    scan "confidential identifier (.confidential-patterns): /${pat}/" "$pat"
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
if [ "${VAULT_HUD_SKIP_LLM_CHECK:-}" = "1" ]; then
  note "LLM confidentiality review skipped (VAULT_HUD_SKIP_LLM_CHECK=1)."
elif ! command -v claude >/dev/null 2>&1; then
  note "\`claude\` CLI not found — LLM confidentiality review skipped (deterministic layer passed)."
else
  printf '  … running LLM confidentiality review (claude)\n'
  # Committed text only (-I skips binaries); the gate script excludes itself. Bounded
  # so a huge tree cannot blow up the call; note the bound if it is hit.
  tree_text=$(git grep -I -n -e '.' HEAD -- . ":!$SELF" 2>/dev/null)
  if [ "$(printf '%s' "$tree_text" | wc -c)" -gt "$LLM_MAX_CHARS" ]; then
    note "committed text exceeds ${LLM_MAX_CHARS} chars; LLM review is PARTIAL — split into chunks."
    tree_text=$(printf '%s' "$tree_text" | head -c "$LLM_MAX_CHARS")
  fi
  read -r -d '' PROMPT <<'PROMPT' || true
You are a confidentiality reviewer for a PUBLIC open-source repository. The repository
text about to be pushed is provided on standard input (format HEAD:path:lineno:content).
Flag ANY content that must not be public:
- real company / firm names, product names, or project codenames
- person names (real individuals)
- internal or private URLs, hostnames, org / account / project identifiers
- absolute home paths or usernames
- API keys, tokens, passwords, or other secrets
- private knowledge-base content (real todos, notes, decisions, meeting content)
Obvious placeholders are FINE and must NOT be flagged: OWNER, YOUR-VAULT, /Users/YOU,
/ABSOLUTE/PATH, project-x, project-y, project-z, example.com, foo, bar.
Reply with EXACTLY one first line: "VERDICT: CLEAN" or "VERDICT: LEAK".
If LEAK, add one bullet per finding: "- <path>: <what and why>".
PROMPT
  verdict=$(printf '%s' "$tree_text" | claude -p "$PROMPT" 2>/dev/null)
  if [ -z "$verdict" ]; then
    note "LLM review produced no output (auth / network / CLI?) — relying on the deterministic layer."
  elif printf '%s' "$verdict" | grep -qiE 'VERDICT:[[:space:]]*LEAK'; then
    report "LLM confidentiality review flagged content:"
    printf '%s\n' "$verdict" | sed 's/^/      /'
  else
    printf '  \033[32m✓ LLM review: CLEAN\033[0m\n'
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mPRE-PUSH CHECK FAILED.\033[0m Do NOT push. Resolve the findings above.\n'
  exit 1
fi

printf '\033[32m✓ pre-push check clean — nothing confidential or private in the committed tree.\033[0m\n'
exit 0
