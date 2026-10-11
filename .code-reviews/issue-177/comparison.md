# Comparison — issue 177 implementations

## Comparison

Bound implementation pins (all implement the selected codex plan
`29ff9141bb350e934d8e72cd1a145303db4cd344`):

- codex `e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5`
- claude `9d8d25436530ced335f15843350413c969af1d60`
- cursor `5e7f8fee93746dc11083bca7f0029d1137982620`
- antigravity `3cf68ba1181b8e6e4d2ccdd7c46d38692adb193b`

I read the four exported worktrees and compared them file by file with plain
`diff` (no peer fetches). I ran no product suites for this comparison; no
coordinator candidate results were bound to this action.

### What all four share

All four stay inside the approved 22-path map, add no files or dependencies,
and extend the same eight existing test files. All four:

- derive a `revision-limit-active-roster-v1` decision on the round-3 revision
  pin when a round-3 ballot contains `revise` or `escalate`, instead of the old
  retry/abandon question; rounds 1–2 keep their behavior;
- add an `R6.follow-up` Git step for the active objectors only, after the
  round-3 batch is published, with a `follow-up-ready` receipt;
- verify the cited issue with `gh issue view` before acceptance and never let
  the coordinator create issues;
- list the follow-ups in the PR body and keep `Closes #N`;
- retire a parked round-3 owner question once its ballots are published;
- skip the plan/implementation re-elections when a non-reviser is dropped
  after the conclusion.

### Differences that matter

| | codex | claude | cursor | antigravity |
|---|---|---|---|---|
| src growth over baseline | +273 lines | +494 | +569 | +382 |
| Late drop | resets to round-3 ballot, republishes a batch for the reduced roster, re-derives | rebuilds the decision from the already-published round-3 batch | rebuilds from a superset batch, **rewrites old selection rosters** | superset batch accepted inside `publishedBallotBatch` |
| Cited issue missing on GitHub | rejected with correction | rejected with correction | **retried forever** | **retried forever** |
| Backlink check | exact `Related to <url>` line | `#N` word-bounded or URL, closing keyword rejected | `#N` word-bounded or URL, closing keyword rejected | **substring `#N`** |
| Question retirement journaled | yes (`owner-question-retired`) | yes (`owner-question`, `retired: true`) | yes | **no** |
| Blocks `retry` on a round-3 question | yes | no (question retired first) | yes | no |

### Findings

1. **cursor `src/githubIssue.ts:145`** (and antigravity `src/githubIssue.ts:220`).
   Rule: a follow-up receipt citing an issue that does not exist must be
   rejected with a correction; only a transport failure may be retried
   without reissue (the selected plan: "Reject a wrong issue … treat a failed
   lookup as retryable").
   Failure: both catch every `fetchGitHubIssue` error and return retry. An
   objector who mistypes the number (for example cites `/issues/18` instead
   of `/issues/180`) gets `gh: Could not resolve to an issue…`, which becomes
   `retry-verification` on every tick. The action is never reissued, so the
   agent never sees a correction, the receipt is never accepted, and
   `R6.follow-up` never advances to finalization: the revision-limit stall the
   issue is about comes back in a new step.
   Test: in `test/githubIssue.test.ts`, a runner returning exit 1 with stderr
   `GraphQL: Could not resolve to an issue or pull request with the number of 18.`
   must yield a rejection, while `error connecting to api.github.com` yields
   retry. codex (`src/githubIssue.ts:208`) and claude (`src/githubIssue.ts:232`)
   already make that split.

2. **antigravity `src/githubIssue.ts:224`.**
   Rule: the follow-up must link the concluding issue itself (plan:
   "exact concluding-issue backlink").
   Failure: `body.includes("#177")` and `body.includes("/issues/177")` are
   substring tests. A body that only mentions `#1770` or
   `https://github.com/o/r/issues/1771` passes, so a follow-up linked to an
   unrelated issue is accepted and listed in the PR as the objection for #177.
   The check also accepts `Fixes #177`, which the plan asked to exclude as a
   closing reference.
   Test: in `test/githubIssue.test.ts`, a body containing the revision, the
   key and only `See #1770` must be rejected.

3. **cursor `src/ownerControls.ts:151` and `:153`.**
   Rule: a derived decision's identity is a hash over its ordered active
   roster (`computeDerivedInputSetHash`; `invalidateDerivedForDrop` in
   `src/state.ts` relies on "every decision identity includes the ordered
   active roster"). A record must never claim a roster it was not derived
   over.
   Failure: on a drop after the conclusion, cursor rewrites
   `planSelection.activeRoster` and `implementationSelection.activeRoster` to
   the reduced roster but keeps the old `inputSetHash` and `decisionId`, and
   journals nothing. After dropping `cursor` from `[claude, codex, cursor]`,
   `computeDerivedInputSetHash("implementation-selection", record.activeRoster, record.inputs)`
   no longer equals `record.inputSetHash`. The stored state now contradicts the
   `decision-derived` journal, which still shows the three-agent roster, so the
   audit trail cannot tell which roster elected the implementation. The rewrite
   exists only to satisfy `needsImplementationSelectionDerive`; codex avoids
   that check for the final round and claude keeps the prior records unchanged.
   Test: after `dropOwnerAgent`, assert
   `cursors.derived.implementationSelection` deep-equals the pre-drop record.

4. **antigravity `src/runLoop.ts:3079`.**
   Rule: clearing an owner question is an owner-visible state change and must
   be journaled like its creation (`owner-question` → `owner-answer`).
   Failure: the parked round-3 question is set to `null` inside `runTick` with
   no journal event. The journal shows a question that was asked and never
   resolved, so `coord status` history and analytics that pair questions with
   their resolution cannot explain why the issue moved on. codex journals
   `owner-question-retired`; claude journals `owner-question` with
   `retired: true` and a deduplicating `eventId`.

5. **claude `src/ownerControls.ts:159`** (my own).
   Rule: a drop after the conclusion must never route the issue through the
   ballot step while the earlier selections are intentionally stale.
   Failure: if `computeTerminalConsensusDerived` returns `null` (for example
   the round-3 revision acceptance is missing), the fallback resets to
   `R6.ballot` while keeping the pre-drop `implementationSelection`. The
   machine's `needsImplementationSelectionDerive` then waits indefinitely at
   `R6.ballot`. The path is unreachable with consistent state, but the fallback
   is wrong. codex's design (republish the reduced batch and bypass that check
   for round 3) does not have this hole.

6. **claude `src/githubIssue.ts:232`** (my own, minor).
   Rule: only a genuinely missing issue should be rejected.
   Failure: the generic `not found` alternative also matches unrelated
   failures (for example a repository-access error worded "not found"),
   turning a fixable access problem into a rejection and reissue. codex's
   pattern (`issue[^\n]*not found`) is narrower.

### Scope, reuse and tests

- **codex** has the smallest change for the same behavior. It follows the
  plan literally: a stable `Tracking key`, exact body lines, transport-only
  retry, journaled retirement, a refused round-3 `retry`, and a drop that
  republishes the reduced batch instead of reinterpreting the old one. Its
  tests cover revise and escalate at round 3, follow-up acceptance, and
  restart/drop.
- **claude** behaves the same apart from findings 5–6 and uses one more
  derivation helper (`computeTerminalConsensusDerived`) instead of
  republishing. Its tests cover the same cases plus PR body and status
  output.
- **cursor** is the largest change. It adds a separate `derive-revision-limit`
  decision and a historical-batch fallback used by every consensus
  derivation, and it carries findings 1 and 3.
- **antigravity** is mid-sized but widens `publishedBallotBatch` for every
  round-3 consensus read and carries findings 1, 2 and 4.

Overall ranking: codex, then claude, then cursor and antigravity. Codex has no
finding against it and is the most direct reading of the approved plan.
Cursor and antigravity each re-introduce an indefinite stall when an objector
cites a missing issue (finding 1).
