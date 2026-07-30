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
