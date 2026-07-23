#!/usr/bin/env bash
# check-no-secrets.sh — mandatory pre-push confidentiality gate for this PUBLIC repo.
#
# Scans the committed tree (HEAD) for confidential / private / personal data and
# exits non-zero if it finds any. Run it before EVERY push:
#
#     bash scripts/check-no-secrets.sh && git push
#
# or install it as a real git hook so it runs automatically:
#
#     ln -sf ../../scripts/check-no-secrets.sh .git/hooks/pre-push
#
# Exit 0 = clean, safe to push. Exit 1 = something confidential is staged/committed.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

fail=0
report() { printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=1; }

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

# 3. Scan committed content for leak patterns. `.env.example` is excluded because it
#    holds documented placeholders. Allowed placeholder forms are filtered out after.
#    Note: `git grep HEAD` only sees committed content, which is exactly what a push sends.
scan() {
  # $1 = human label, $2 = extended-regex
  local hits
  hits=$(git grep -nIiE "$2" HEAD -- . ':!.env.example' ':!scripts/check-no-secrets.sh' 2>/dev/null \
    | grep -vE '/Users/YOU|/Users/<|/ABSOLUTE/PATH|lee-c-argonav/vault-dashboard' )
  if [ -n "$hits" ]; then
    report "$1"
    printf '%s\n' "$hits" | sed 's/^/      /'
  fi
}

# Secrets — must never appear.
scan "possible secret (JWT / API key / token / private key)" \
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(sk|rk|pk)-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# Real absolute home paths (placeholders /Users/YOU and /Users/<name> are filtered above).
scan "real absolute home path (use \$VAULT_HUD_VAULT, ~, or a placeholder)" \
  '/Users/[a-z0-9._-]+/'

# Known firm / account / personal identifiers that belong in .env, not the source.
scan "firm/account identifier (move to .env as \${VAR})" \
  'keelmb|lee-argonav|k-argonav|vercel\.com/argonav|vlormvfpuqgeruwophqp|Desktop/(lee-vault|repos)'

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mPRE-PUSH CHECK FAILED.\033[0m Do NOT push. Fix the findings above,\n'
  printf 'move machine/account values into the gitignored .env, and re-run.\n'
  printf 'If any of this was already committed, rewrite history before pushing.\n'
  exit 1
fi

printf '\033[32m✓ pre-push check clean — nothing confidential or private in the committed tree.\033[0m\n'
exit 0
