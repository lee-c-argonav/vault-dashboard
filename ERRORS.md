# ERRORS

## 2026-07-30 — making the confidentiality gate scan commit identity without blocking every push

**What didn't work:**
1. Added author/committer identity to the pattern scan. Every commit failed, because
   the global git identity is a work email whose domain is a blocked pattern. Correct
   finding, but it blocked all pushes including the fix itself.
2. Set a repo-local GitHub noreply identity to stop the bleeding. Still failed: the
   account name that *owns* the public repo matches a blocked pattern too, so the
   clean identity was flagged by the same rule.
3. Considered adding the account name to the committed allow-list. Rejected — the
   gate's whole design rule is that identifiers live only in the gitignored patterns
   file, so the committed script cannot leak the names it guards.

**What did:** exempt any identity whose email is a `users.noreply.github.com` address.
That domain is the platform's own opt-out for exposing a real address, so such an
identity is already exactly what GitHub publishes for the account. It keys on the
address rather than on a name, so nothing is hardcoded and the committed script stays
free of identifiers. Real emails are still scanned, verified both ways.

**Remember:** a confidentiality pattern list will eventually match something that is
unavoidably public for the repo it guards (the owning account, the repo name); exempt
the structural marker that makes it public, never allow-list the string.

## 2026-07-30 — trusting a security gate that had never been tested

**What didn't work:** the gate reported clean on every run for a week. Two of its
failure modes were silent: it built its scan text from the git tree, so commit
messages and author identity were never read at all, and over its size bound it
truncated the LLM review to a prefix and printed the same green CLEAN line as a full
pass. Reading the script did not surface either one; both look correct in isolation.

**What did:** planting known-bad input and confirming it gets caught. A commit message
containing a home path, a work-email identity, a forced-low size bound, and a stubbed
reviewer returning nothing. Each took under two minutes and the first one immediately
found a real exposure that was already on the public remote.

**Remember:** a control that only ever reports success is indistinguishable from one
that is not running; the only way to tell them apart is to plant something and watch
it fail.

## 2026-08-06 — keeping two rendering surfaces consistent

**What didn't work:** hand-copying the derivation and the CSS from `public/app.js`
into `status-page/build.js`. They drifted three times in one session, and each
drift was user-visible: the phone lost the failed-unit explanation so a run read
BLOCKED with no reason; a blocked sub-agent painted the same pixel as a
not-started one; a broken timestamp rendered in the running colour because an
amber rule tied on specificity and lost on source order. A review measured 80
divergent declarations across 32 selectors that were meant to be identical.

**What did:** one shared module, `public/runs-view.js`, holding every derivation
both surfaces call — `runState`, `durationOf`, `askOf`, `unitWindow`,
`expandSet`, `eta`. The renderers only draw. The one component that was unified
first, the duration cell, had zero divergences; the ones copied by hand had all
80.

**Remember:** two copies kept in step by review is not a design, it is a
schedule of future bugs. Share the derivation, or accept that the surfaces will
disagree and that the disagreement will reach the user before it reaches you.

## 2026-08-10 — a publish step that could not tell "no data" from "no access"

**What didn't work:** `status-page/deploy.sh` resolved the vault path on line 25
and sourced the `.env` that defines `VAULT_HUD_VAULT` on line 32. The fallback
had been the real path until commit `1a4df8d` changed it to a generic
`$HOME/Obsidian/vault` "matching server.js", one minute after `b1319ce` moved the
real path into the untracked `.env`. From then on every build read a directory
that does not exist on this machine.

Nothing failed. `readRuns` catches a missing directory and returns `[]`, which is
correct for the long-lived server, where a transient read failure resolves on the
next ten-second pass. The published page therefore rendered "No run is publishing
status", stamped itself with the current time, and deployed successfully. It sat
that way for four days while the desktop HUD showed a live run three feet away,
and `/close` step 9 instructed every session to redeploy it, so each close
overwrote the board again.

**What did:** two guards and a test that can see the shell.

- `readRunsDetailed` returns `unreadable` alongside the runs, so "I found nothing"
  and "I could not look" stop being the same value. `readRuns` keeps its array
  shape, so the callers that only draw rows were untouched.
- `build()` throws on `unreadable` and the CLI exits non-zero, so a deploy of an
  empty board cannot happen. It still publishes a readable-but-empty vault,
  because no runs is a true statement and refusing to say it would trade one
  silent lie for another.
- `test/publish.test.js` asserts the ordering inside `deploy.sh` by reading the
  file, because the entire defect lived in shell variable expansion order and no
  JavaScript test could reach it.

**Remember:** an empty result and an unreachable source must never be the same
value in anything that publishes. The reader that returns `[]` for both is not
wrong; it is under-specified, and the cost lands wherever the result is written
somewhere durable rather than merely displayed. Ask of any read-then-publish
path: if the input vanished entirely, would this ship a confident blank?

## 2026-08-10 — three of four sessions were invisible and the board looked fine

**What didn't work:** appearing on the board required writing a file into
`15-Runs/`, and writing one is opt-in above a size threshold. Four agent sessions
were running on this machine and one was on the board. Nothing was broken by any
test's definition: the reader read correctly, the renderer rendered correctly,
and the panel accurately displayed every run that existed. The instrument was
still wrong, because the operator's question is "what is running", not "what has
volunteered a status file".

A second instance of the same shape was next to it: a run finished on 2026-08-08
kept its slot for two days because `/close` step 9 sets `state: "done"` and then
moves the file, and only the first half ran. Board correctness depended on an
agent remembering to run `mv`.

**What did:** stop asking, start observing. `sessions.js` reads the process table
for live agent sessions and `linkSessions` matches them to the runs that are
publishing, so a session that writes nothing still occupies a line marked NO
STATUS. And `partitionRuns` derives "finished" from `state: "done"` rather than
from the file's location, so the archive move became tidying instead of the thing
that decides what the operator sees.

**Remember:** when a dashboard depends on the thing being measured to volunteer
its own measurement, absence of data and absence of activity are indistinguishable,
and every test still passes. Ask what the panel shows for a subject that is doing
nothing to help it — and never let a manual file move be load-bearing for
correctness, because the step that is skipped is always the second one.

## 2026-08-10 — a row that stated four true things and meant something false

**What didn't work:** the operator read `BLOCKED · QUIET 2h22m` on a run whose
four sub-agents were marked running and whose session was alive in the process
table the whole time. Every element was derived correctly. A unit was blocked, so
`runState` said blocked. `updated` had not moved in 2h22m, so `quietMs` said
quiet. The row was assembled from true parts and told him the run was dead.

Three more of the same shape came out of the same screenshot. Five units all read
`7m`, because they were stamped in one batch at the end rather than at each
boundary, and the reader passed one measurement off as five — including to `eta`,
whose entire premise is spread measured across independent units. `5 of 5 done`
sat beside `RUNNING`. And a live session reading `NO STATUS` had published a
complete run ninety seconds earlier; finishing it released the session from
`linkSessions`, so the best-described session on the board became the emptiest
row on it at the moment its work completed.

**What did:** deriving from more of what was already known, rather than adding
states. Session liveness separates `QUIET` (no stamp, no session, may be dead)
from `NO UPDATE` (the session is right there and not writing). A blocked unit
stops making a working run read blocked, and `blockedNote` plus `askOf` carry the
block instead. Units sharing an exact start and end are marked as one measurement
and excluded from the estimate. A run whose units are all done says
`ALL UNITS DONE`. A session between jobs says what it last published.

**Remember:** a dashboard can be correct field by field and wrong as a sentence.
The test is not "is each value derived properly", it is "read the whole row aloud
— is that what is happening?" Every one of these was found by the operator
reading a row, and none by a test suite that was green throughout.

## 2026-08-10 — one NUL byte made a function invisible

**What didn't work:** an automated edit put a single NUL inside a template
literal in `runs-view.js`. Nothing failed. The file was valid JavaScript,
`node --check` passed, all 141 tests passed, and the code ran correctly, because
a NUL is a legal character in a JS string. What broke was every tool that sniffs
a file before reading it: `file` began reporting `data` instead of text, and grep
silently matched nothing — for every pattern, including the names of functions
plainly present. Half an hour went into "why has this function disappeared" when
it never had, and a later edit to it silently failed to apply because the search
string no longer matched.

**What did:** `test/sources.test.js` asserts no source file contains a NUL and
that every one decodes as UTF-8, verified by planting a NUL and watching it fail.

**Remember:** grep returning nothing is not evidence of absence. It is also what
a binary file looks like. When a symbol you can see in an editor cannot be found
by search, check `file` before checking your assumptions — and note that a defect
that leaves behaviour correct while making the code unsearchable will never be
caught by a test suite that only runs the code.

## 2026-08-11 — Deciding whether a sub-agent has finished, from its transcript
**What didn't work:** Two content-shape rules in a row. First "the last entry has
no `tool_use` block", which called 2,598 of 4,104 mid-flight boundaries finished
across 35 real transcripts — 63% of boundaries and 90% of wall-clock time. Then a
reviewer's refinement adding `stop_reason !== 'tool_use'`, which still misread 25%.
Both fail for the same reason: an assistant turn is split across thinking, text and
tool-call entries, and only the last carries a stop reason, so a mid-turn entry is
byte-identical to a finished one.
**What did:** Recency. The two shapes that are definitely mid-flight (a `user`
tool_result, or an assistant entry carrying a tool call) are read from content; the
ambiguous text-only tail is decided by whether the file has moved recently. A
finished agent never writes again; a working one writes every few seconds. 0 false
finishes, and 34 of 35 completed agents correctly finished.
**Remember:** When the content of a record cannot distinguish two states, stop
refining the predicate and ask what the filesystem already knows.

## 2026-08-11 — Testing code that compares a passed-in clock to real file mtimes
**What didn't work:** Anchoring the fixtures to a fixed date while the harness
advanced its own `now`. Twice: first every fixture looked written in the future so
staleness computed negative, then the shared clock drifted ten seconds per test
until files were 200s "old" through the harness rather than the rule. Both times
the suite was green or red for reasons that had nothing to do with the code.
**What did:** Anchor the synthetic clock to the real one, and for cases that turn
on recency, pin that case to `Date.now()` rather than the shared counter.
**Remember:** A synthetic clock and a real filesystem is a mixed measurement.
Anchor them together or the test measures the harness.

## 2026-08-11 — Reopening a browser after an MCP-driven page was closed
**What didn't work:** Four attempts. `new_page` returned "The browser is already
running for .../chrome-profile"; killing the instance pid left nine node
processes and the error unchanged; `pkill` on the profile pattern reported the
same nine; passing an isolated context returned the identical error, because the
lock is on the user-data-dir and not on the context.
**What did:** Kill the Chrome process holding the profile, then remove the
`Singleton*` lock files in the user-data-dir, then reopen. The nine survivors
were MCP *server* processes, not browsers, so counting them was reading the wrong
signal for three of the four attempts.
**Remember:** A profile lock is a file, not a process. Killing processes named
after the profile is not the same as releasing it, and a process count that does
not drop is evidence you are counting the wrong thing.

## 2026-08-11 — Getting a CSS rule to reach the phone's published page
**What didn't work:** Three attempts. First a backtick inside a CSS comment
ended the stylesheet's template literal, and the syntax error named a line far
from the cause; fixing one comment exposed a second one written the same way.
Then the rule was placed in `TOKENS_FALLBACK`, the block that renders only when
`tokens.css` is unreadable, so the markup shipped with no styling at all and the
element measured 10×19 instead of 44×44. Then an anchor-based insert matched a
`.legend i` rule that exists in both the fallback and the real stylesheet, and
landed in the fallback again.
**What did:** Anchoring to a selector that exists ONLY inside the real stylesheet,
and verifying by counting the rule in the built page's `<style>` block rather
than in the source file.
**Remember:** When a file holds two copies of a stylesheet, "is the rule in the
source" and "is the rule on the page" are different questions, and only the
second one matters.

## 2026-08-11 — Checking whether two elements overlap
**What didn't work:** A bounding-box intersection test, twice. It reported the
phone's refresh control as overlapping the headline, and reported 206px of page
overflow on the desktop. Neither was real: the headline is a block element that
spans its container by design, and the overflow reading came from measuring the
desktop HUD in a 500px viewport left over from phone testing.
**What did:** Measuring ink — a `Range` around the text nodes — and confirming
the viewport width before trusting any layout number.
**Remember:** A box is not what a reader sees. Test the glyphs, and check what
viewport you are actually in before reporting a layout defect.

## 2026-08-12 — Verifying a whole-machine memory threshold live
**What didn't work:** Driving the machine over the line with allocation hogs. A
single 8GB hog tripped the per-process runaway guard first (RSS over 4GB names
the hog whatever the machine is doing), so the whole-machine fallback path never
ran. Five hogs of 3GB each, filled with random bytes so the compressor could not
shrink them, peaked the vm_stat-based reading at 83% against an 85% line: under
real pressure macOS swaps, and swapped-out pages leave the active + wired +
compressed categories the reading counts. The line could not be reached by force.
**What did:** An env override on the threshold (`VAULT_HUD_BUSY_MEM_PCT`, the
same knob `VAULT_HUD_METRICS_MS` is for the tick), set below ambient. The
identical decision path ran and named a 2.19GB process, which only the fallback
can produce — a runaway would have had to cross 4GB.
**Remember:** To verify a threshold on a resource the OS actively manages, lower
the threshold below ambient. Do not fight the OS for the resource; it will win,
and the test will have proved nothing.
