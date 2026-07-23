# CLAUDE.md — vault-hud

## THIS REPOSITORY IS PUBLIC

`github.com/lee-c-argonav/vault-dashboard` is a **public** repository. Anything
committed here is world-readable, is cached and indexed by third parties, and
survives in git history even after it is deleted. Treat every commit as permanent
publication.

**Never commit anything personal, confidential, or firm-identifying.** This is the
single hard rule of this repo and it overrides convenience.

## MANDATORY PRE-PUSH CHECK

**Before every `git push` to this repo, you MUST run the confidentiality check and
confirm it passes. Do not push if it fails or cannot run.**

```sh
bash scripts/check-no-secrets.sh && git push
```

The check scans the committed tree (`HEAD` — exactly what a push sends) for secrets,
real absolute home paths, firm/account identifiers, and stray fixtures, and exits
non-zero on any hit. A clean exit (`✓`) is the only condition under which a push is
allowed. If it fails:

1. **Do not push.** Fix each finding — move machine/account values into the
   gitignored `.env` and reference them as `${VAR}`, or replace with a placeholder.
2. If the confidential data is already in a commit, **rewrite history** (or squash to
   a clean commit) before pushing — removing it in a new commit is not enough
   (see [If confidential data is ever committed](#if-confidential-data-is-ever-committed)).
3. Re-run the check until it passes, then push.

To make the gate automatic, install it as a git hook (runs on every push):

```sh
ln -sf ../../scripts/check-no-secrets.sh .git/hooks/pre-push
```

This applies to any agent or human pushing to this repo. Treat a skipped or failing
check as a hard stop, never a warning to push past.

### Specifically, never commit:

- **Real vault content.** No parsed State, no fixtures, no exported todos,
  decisions, note titles, or people's names from any Obsidian vault. The old
  `docs/fixture.json` was removed for exactly this reason — do not reintroduce a
  fixture built from a real vault. If a demo fixture is ever needed, it must be
  fully synthetic.
- **Absolute home paths or usernames.** No `/Users/<name>/…`. Use `$VAULT_HUD_VAULT`,
  `~`, or a `/ABSOLUTE/PATH/TO/…` placeholder.
- **Account- or firm-specific URLs and identifiers.** No real GitHub orgs, Supabase
  project refs, Vercel teams, internal hostnames, product or client names. These
  live in `.env` (gitignored) and are referenced from `tools.json` as `${VAR}`.
- **Secrets of any kind.** API keys, tokens, passwords. There should never be a
  reason to — the app reads a local vault and binds loopback only.
- **Screenshots or recordings** that show real vault data, real paths, or a real
  vault name in the header/footer. If a screenshot is added, it must be taken
  against a synthetic vault.

### The mechanism that keeps it clean

- `.env` holds every machine- and account-specific value and is gitignored.
  `.env.example` is the committed template and must contain only placeholders.
- `tools.json` references those values as `${VAR}`; `server.js` loads `.env` at
  boot and `shortcuts.js` substitutes the vars.
- `scripts/check-no-secrets.sh` is the automated gate that enforces all of the
  above. It is mandatory before every push (see
  [Mandatory pre-push check](#mandatory-pre-push-check)). When you add a new class of
  identifier that should never ship, add its pattern to that script so the gate keeps
  up.

### If confidential data is ever committed

Removing it in a new commit is **not enough** — it stays in history. Rewrite
history (or squash to a clean initial commit) and force-push, then rotate anything
that was a real secret. Assume anything pushed public was already scraped.

## What this project is

A zero-dependency, read-only Obsidian vault dashboard. See `README.md` for usage
and `SPEC.md` for the design. The server never writes to the vault and binds
`127.0.0.1` only.
