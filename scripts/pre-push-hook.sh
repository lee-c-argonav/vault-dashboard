#!/usr/bin/env bash
# pre-push-hook.sh — the confidentiality gate as a real pre-push hook.
#
# Git feeds a pre-push hook the refs being pushed on stdin, one per line:
#     <local ref> <local sha> <remote ref> <remote sha>
# This runs scripts/check-no-secrets.sh against EVERY pushed ref's sha (not just
# HEAD), so `git push --all` / `--mirror` cannot slip a confidential branch
# (e.g. backup/pre-purge) past a gate that only ever looked at the current HEAD.
#
# Install (symlink so edits to the tracked script take effect with no reinstall):
#     ln -sf ../../scripts/pre-push-hook.sh .git/hooks/pre-push
#
# Bypass in a genuine emergency: git push --no-verify  (do not make a habit of it).

set -uo pipefail
repo="$(git rev-parse --show-toplevel)" || exit 2
gate="$repo/scripts/check-no-secrets.sh"
[ -r "$gate" ] || { printf 'pre-push: gate script missing (%s)\n' "$gate" >&2; exit 2; }

zero='0000000000000000000000000000000000000000'
seen=' '
status=0

while read -r localref localsha remoteref remotesha; do
  # A deletion (local sha all zeros) sends no content — nothing to scan.
  [ -z "${localsha:-}" ] && continue
  [ "$localsha" = "$zero" ] && continue
  # Scan each distinct sha only once (a --all push can point many refs at one sha).
  case "$seen" in *" $localsha "*) continue ;; esac
  seen="$seen$localsha "

  printf '\n\033[1mpre-push gate → %s (%s)\033[0m\n' "${localref#refs/heads/}" "${localsha:0:12}"
  bash "$gate" "$localsha" || status=1
done

if [ "$status" -ne 0 ]; then
  printf '\n\033[31mpre-push BLOCKED — a ref being pushed contains confidential content.\033[0m\n' >&2
  printf 'Fix the findings above, or (emergency only) push with --no-verify.\n' >&2
  exit 1
fi
exit 0
