# progress — run board repair, 2026-08-10

Run files: `$VAULT_HUD_VAULT/15-Runs/` (both closed out).

Paths here are written as `$VAULT_HUD_VAULT`, not as real ones. This repository
is public and the same rule the pre-push gate enforces applies to notes in it.

## Goal

The board showed the wrong thing on both surfaces. The published page had been
blank for four days, the desktop carried a run finished two days earlier, and
three of four live sessions appeared nowhere. Then a second round, from the
operator reading the fixed board and finding four more things wrong with it.

## Round 1 — the board was empty, stale, and blind

| Unit | Fix | Verified by |
|---|---|---|
| 1 | deploy script read the vault path one line before `.env` defined it | published page went blank → 3 runs |
| 2 | live sessions read from the process table | `test/sessions.test.js`; probe surfaced 4 |
| 3 | `blocked`, a unit state no reader branched on | 7 tests; a waiting unit became visible |
| 4 | finished runs derived from `state`, not from a file move | `test/history.test.js` |
| 5 | timed republish, inside the daemon | `/api/publish` → `ok:true` |
| 6 | orphan daemon; a lost port bind is now fatal | duplicate exits 1, deploys nothing |
| 7 | unreadable run files surfaced instead of counted and dropped | `warnings` |
| 8 | SPEC, README, the run-status standard, `/close` step 9 | read back |

## Round 2 — the board was accurate and still said false things

Every one of these was found by the operator reading a row, none by the suite.

| Unit | Fix |
|---|---|
| 1 | the page reloads itself and offers a Refresh control |
| 2 | a run doing work no longer reads BLOCKED because one unit is |
| 3 | QUIET (no session visible) split from NO UPDATE (session alive, not writing) |
| 4 | a session between jobs says what it last published |
| 5 | history expires at five days, newest first |
| 6 | a run whose units are all done says so rather than only RUNNING |
| 7 | durations copied across units are marked and excluded from the estimate |
| 8 | a NUL byte that made a source file invisible to grep |
| 9 | liveness measured from file mtime, so a wrong writer clock cannot skew it |
| 10 | nine defects a review found in the day's work |

## Decisions

1. **Live sessions are discovered, not declared.** Publishing is opt-in and
   threshold-gated, so most sessions appeared nowhere.
2. **The page redeploys on a timer and refuses to publish a board it cannot
   read.** A manual step inside `/close` failed silently for four days.
3. **Finished is derived from `state: "done"`.** The archive move is tidying.
4. **Liveness comes from file mtime, not the `updated` stamp.** mtime is a
   measurement; `updated` is a claim, and the standard already documents writers
   getting it wrong. The disagreement is now reported rather than inherited.

## Verified by observation, not assertion

- **Auto-reload**: marker set in the page at 20:09:39, gone at 20:11:26, with
  `navigationType: "reload"` — 120s after the previous load, untouched.
- **Publish timer**: `deploys:1 skipped:0` at 20:11:42 → `skipped:1` at 20:16:37.
  Fired on its own and correctly declined to upload an unchanged board.
- **Duplicate daemon**: exits 1 on EADDRINUSE and deploys nothing.
- **NUL guard**: planted one, watched the test fail, removed it, watched it pass.

`npm test`: 174 pass, 0 fail (55 at the start of the day).

## Known limits, stated rather than left to be discovered

- The publisher runs inside the HUD daemon and is off unless `VAULT_HUD_PUBLISH=1`.
  On any machine without it, the manual deploy step still applies — which is why
  that step stayed in the standard after an earlier edit wrongly removed it.
- Nothing restarts the daemon on reboot; its launchd job has never been installed.
- A launchd timer for the republish does not work on a TCC-protected folder: a
  headless agent gets no consent prompt, and the job fails with exit 126. The
  plist is kept for anyone willing to grant Full Disk Access to `/bin/bash`.
- Liveness from mtime has one failure mode: anything that rewrites a run file
  without the run writing it (a checkout, an rsync) makes a dead run look recent.

## Scope note

