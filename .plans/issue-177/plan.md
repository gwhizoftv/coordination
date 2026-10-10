# Plan — issue 177: conclude at the revision limit instead of stalling

## Problem

When a consensus ballot at the last allowed revision round (`maxRevisionRounds`,
3) contains a `revise` vote, `decide` in `src/machine.ts` returns
`owner-action-required` with kind `revision-limit` and only `retry | abandon`.
Neither answer moves the work forward: `retry` re-runs the same ballot on the
same pin (the agent that voted revise votes revise again, so it loops), and
`abandon` discards the finished revision. The issue asks for the opposite
behaviour: the third revision concludes the issue, the coordinator runs its
final checks and opens the PR, and each agent that still objects files a new
GitHub issue for its remaining objections, linked to the concluding issue.

Two other complaints in the issue are already fixed on the baseline and need
no change (see Reuse and Scope): the printed `answer` command now carries
`--coord-runtime` (`issueCommand` in `src/issueReport.ts`), and the
foreground `coord>` prompt already presents a pending owner question as a
numbered menu (`refreshQuestion` in `src/interactive.ts`).

## Exact File List to be changed or deleted

- `src/machine.ts` — in the `R6.ballot` completion branch, a `revise` vote
  advances to `R6.revise` only while `round < start.maxRevisionRounds`. At the
  limit it no longer returns `owner-action-required`; control falls through to
  the existing `needsConsensusDerive` → `derive-consensus` path. `escalate`
  handling is unchanged (still an owner question).
- `src/runLoop.ts`
  - `computeConsensusDerived(cursors, round, now, supersedes, maxRevisionRounds)`:
    new trailing parameter. Today it returns `null` unless every ballot is
    `approve`. New rule: every ballot `approve` → existing record with
    `algorithm: "unanimous-active-roster-v1"`; otherwise, when
    `round >= maxRevisionRounds` and every ballot is `approve` or `revise`,
    return the same record shape with
    `algorithm: "revision-limit-final-round-v1"` and `consensusPin` = the
    final revision pin. Any `escalate`, or a `revise` before the limit, still
    returns `null`.
  - `applyDerivedConsensus`: pass `start.maxRevisionRounds`. Its existing
    follow-on `advance-step` to `R7.finalize` is reused unchanged.
  - `buildOrder`: when `stepId === "R6.ballot"` and
    `round >= start.maxRevisionRounds`, append a final-round note to `task`
    (before the scaffold) stating: this is the last revision round; the
    coordinator will finalize this revision and open the pull request whatever
    the vote; an agent that votes `revise` must first create a follow-up issue
    with `gh issue create --repo <owner/repo>` whose body links `#<issue>`, and
    must put that issue's URL in its rationale; `escalate` still asks the
    owner. The repository comes from `githubRepositoryFromOrigin(start.origin)`;
    when that is `null` the note omits `--repo`. The wording avoids the banned
    terms in `src/agentLanguage.ts` (no step ids, "gate", "phase", "nudge").
  - The response-observation call to `parseBallotResponse` (currently
    `src/runLoop.ts:3065`): for an `R6.ballot` cursor whose
    `roundForStep(...) >= start.maxRevisionRounds` and whose origin yields a
    GitHub repository, pass `{ repository, issue: start.issue }` as the new
    follow-up argument. A rejected response is reissued through the existing
    `reissue(..., parsed.outstanding)` path, so the agent sees the correction.
  - `publishAcceptedFinalization`: when
    `cursors.derived.consensus?.algorithm === "revision-limit-final-round-v1"`,
    pass the accepted `R6.ballot` responses at `consensus.round` with
    `disposition === "revise"` (active roster only) as
    `objections: [{ agent, rationale }]` to `formatFinalizationPullRequest`.
- `src/ballotResponse.ts` — `parseBallotResponse` gains an optional fifth
  parameter `followUp?: { repository: string; issue: number }`. When present
  and the parsed consensus disposition is `revise`, the rationale must contain
  `https://github.com/<repository>/issues/<n>` with `n !== issue`; otherwise
  push the outstanding item
  `final-round revise rationale must include the URL of the follow-up issue you created in <repository> (not #<issue>)`.
  `approve` and `escalate` are unaffected, as is every other step.
- `src/state.ts` — `consensusDerivedSchema.algorithm` becomes
  `z.enum(["unanimous-active-roster-v1", "revision-limit-final-round-v1"])` so
  the new record persists. Existing state files still parse (old literal is a
  member of the enum).
- `src/ownerControls.ts` — the drop re-derivation call
  `computeConsensusDerived(next, priorConsensus.round, now, priorConsensus.decisionId)`
  passes `readStartState(paths).maxRevisionRounds` (already imported), so a
  drop after a final-round conclusion re-derives the same way instead of
  rewinding to `R6.ballot`.
- `src/githubIssue.ts` — `formatFinalizationPullRequest` gains optional
  `objections?: readonly { agent: string; rationale: string }[]`. When non-empty
  it appends a section: `Concluded at the revision limit. Remaining objections
  (each filed as a follow-up issue by the objecting agent):` followed by one
  `- <agent>: <rationale>` line per objection. Output is byte-identical when
  absent or empty.
- `README.md` — step 4 of the workflow summary: replace "Escalations and the
  revision limit require an owner decision rather than silent advancement" with
  "Escalations require an owner decision; at the revision limit the final
  revision is finalized and each remaining objection is filed as a follow-up
  issue by the agent that raised it."
- `docs/coord-driver.md` — next to `maxRevisionRounds` (line ~92) and the
  `answer` paragraph (line ~633), describe the final-round conclusion, the
  follow-up-issue requirement for a final-round `revise`, and that the PR body
  lists the objections; `answer` now applies to escalations.
- `test/machine.test.ts`, `test/ballotResponse.test.ts`,
  `test/githubIssue.test.ts`, `test/agentLanguage.test.ts` — extended as
  described under Tests.

## Exact file list to be created

None. Every change extends an existing module and an existing test file.

## Reuse and Scope

Reused unchanged:

- `decide`'s existing `needsConsensusDerive` / `derive-consensus` decision and
  `applyDerivedConsensus` → `persistDerivedDecision` → `advance-step` to
  `R7.finalize`; R7 then runs the existing coordinator final checks and
  `publishAcceptedFinalization` opens the PR. No new workflow step, gate,
  evidence id, journal event type, or ballot response field is introduced.
- `computeDerivedInputSetHash`, `deriveDecisionId`, `submissionCitation`,
  `responseCitation`, `publishedBallotBatch`, `hasCompleteActiveDenominator`,
  `acceptedResponsesAt`, `acceptedAt` — the final-round record cites the same
  inputs (revision pin + every ballot) as the unanimous record.
- `githubRepositoryFromOrigin` (`src/githubIssue.ts`) for the repository used
  in the action note, the rationale check, and nothing else.
- `parseBallotResponse`'s existing `outstanding` list and the run loop's
  `reissue` path for rejected responses.
- `roundForStep` for the round of the ballot cursor.
- Test fixtures already in `test/machine.test.ts`: `consensusResponses`,
  `consensusBatch`, `implementationDerived`, `initialCursors`, `start`.
  `test/agentLanguage.test.ts`'s `buildOrder` fixtures and banned-term scan.
  `test/githubIssue.test.ts`'s finalization PR text case.

Already resolved on the baseline (no change planned):

- `coord answer ... ` printing `--coord-root is required`: the hint is built by
  `issueCommand`, which now emits `--issue N --coord-runtime <path>`, and the
  `answer` command accepts `--coord-runtime`.
- Answering at the `coord>` prompt: `startInteractiveSession` shows a pending
  owner question as a numbered menu and calls `applyOwnerAnswer`.

Out of scope: the lifecycle/Stop-hook and delivery-hold examples quoted in the
issue (separate delivery problems; issue 193 work), changing `escalate`
semantics, and `drop` rewinding a workflow (with this change the owner no
longer needs to drop an objector to conclude).

## Tests

All cases fail on the baseline and pass after the change.

1. `test/machine.test.ts` — rewrite "never enters revision round four": with
   `R6.ballot` round 3, a published batch, and codex voting `revise`, `decide`
   returns `[{ type: "derive-consensus", round: 3 }]` (baseline: the
   `revision-limit` owner question). Add in the same file:
   - an `escalate` vote at round 3 still returns `owner-action-required` with
     kind `ballot-escalation` and `["retry", "abandon"]`;
   - `computeConsensusDerived(cursors, 3, now, null, 3)` with a revise vote
     returns a record that `consensusDerivedSchema.parse` accepts, with
     `algorithm: "revision-limit-final-round-v1"` and the revision pin;
   - the same ballots at round 2 (`maxRevisionRounds` 3) return `null`, so a
     non-final revise still revises.
2. `test/ballotResponse.test.ts` — extend "parses consensus dispositions and
   rejects illegal values": with `followUp = { repository: "o/r", issue: 177 }`,
   a `revise` rationale without a URL, with `.../o/r/issues/177`, or with
   another repository's issue URL is rejected with the follow-up outstanding
   item; a rationale containing `https://github.com/o/r/issues/178` is
   accepted; `approve` without a URL is accepted; without `followUp`, behaviour
   is unchanged.
3. `test/githubIssue.test.ts` — extend "reads a durable runtime snapshot and
   formats finalization PR text": with two objections the body contains the
   revision-limit sentence and both `- <agent>: <rationale>` lines; with none
   the body is unchanged.
4. `test/agentLanguage.test.ts` — one case: `buildOrder(..., "R6.ballot", 3)`
   includes the follow-up-issue instruction with `--repo` and `#<issue>`, a
   round-2 ballot does not, and the round-3 task passes the existing banned
   internal-vocabulary scan.

Commands: focused `pnpm vitest run test/machine.test.ts test/ballotResponse.test.ts test/githubIssue.test.ts test/agentLanguage.test.ts`
while developing; the commit hook runs `pnpm check:fast`; the coordinator owns
the full `pnpm run check` at the approved pin.

## Alternatives Rejected

- **Answer `finalize` to the owner question.** Adds an owner round trip to a
  situation the issue says should conclude automatically, and still needs the
  follow-up-issue mechanism. Rejected.
- **Coordinator files the follow-up issues itself** from the revise rationale.
  Simpler for sandboxed agents, but the issue explicitly says the objecting
  agent must create the new issue; the agents already push to GitHub, so `gh`
  is reachable from their clones. Rejected.
- **A new workflow step after finalization for objectors.** Needs a new step
  id, gate, evidence id, artifact schema, scaffold and state migration; the
  ballot action is already addressed to exactly the agents who might object.
  Rejected as disproportionate.
- **A structured `followUpIssue` field in the consensus ballot response.** The
  strict response schema, the observation, the decision, the accepted-response
  state schema, and the evidence-branch publication would all need a new
  field. A URL in the rationale reaches the PR body and the published ballot
  evidence with no schema change. Rejected.
- **Verify the follow-up issue exists via `gh issue view`** during response
  parsing. Makes a pure parser asynchronous and network-dependent and turns a
  GitHub outage into a reissue loop; the PR body puts the link in front of the
  owner anyway. Rejected.

## Risks and Mitigations

- **An agent cites a URL it did not create.** The format check cannot prove
  authorship. Mitigation: the URL must name the product repository and a
  different issue number, and the PR body lists every objection with its link
  for the owner who reviews or merges the PR.
- **An agent's sandbox cannot run `gh`.** Its final-round `revise` is rejected
  with a precise correction; it can still `escalate`, which keeps today's owner
  question. Mitigation documented in the action note.
- **Existing runtime state.** The algorithm enum keeps the old literal, so
  issues already past consensus parse unchanged; a run currently parked on a
  `revision-limit` owner question keeps that question until answered, as
  before.
- **Drop after a final-round conclusion.** `ownerControls` re-derives with the
  same limit, so a drop that leaves only approve/revise ballots keeps the
  conclusion instead of rewinding to the ballot.
- **Non-GitHub origin.** No follow-up URL can be validated and no PR can be
  opened (existing behaviour); the parser receives no `followUp` and the note
  omits `--repo`.

## Conclusion

Treat a final-round `revise` as a recorded objection, not a blocker: derive a
`revision-limit-final-round-v1` consensus on the final revision pin, reuse the
existing finalization and PR path, require each final-round objector to cite
the follow-up issue it created, and list those objections in the PR body. The
change touches six source files and two docs, extends four existing test
files, and adds no workflow step, file, or dependency.
