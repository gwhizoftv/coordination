# Issue 177 plan review

Reviewed the exact exported plans bound by action `9cb5a9fb-6285-4cc3-bb28-1a271345f46f`:

- Claude: `0f30e5ec0b55ee7c62b49bbefec13fe91d2510d2`.
- Codex: `29ff9141bb350e934d8e72cd1a145303db4cd344`.
- Antigravity: `a8d047341f304dcb068a2a803f66a48b8089d37f`.
- Cursor: `6b9d1ef94dfa29410a7b919c27a6534283bb105c`.

Each artifact is `.plans/issue-177/plan.md` at its cited pin. All four exported files match their manifest SHA-256 digests. Source references below describe the existing implementation the plans propose to extend.

## Findings

### 1. [P1] Claude: the required public issue exposes a still-private ballot

**Plan claim:** The `src/runLoop.ts` file-list entry instructs a final-round `revise` voter to create a public follow-up issue before submitting its private ballot, and the parser rejects the ballot without that URL.

**Rule:** Ballot judgments must remain private until the complete ballot set is published. The existing workflow archives private responses and publishes one complete batch before advancing (`docs/coord-driver.md:527`, `src/machine.ts:248`). Issue 177 does not remove that independence requirement.

**Concrete failure:** If Claude finishes first, it must publicly file its objections while Codex and Cursor are still reviewing. They can read Claude's disposition and findings before submitting their own judgments. The later private-response batch cannot restore that lost privacy. Requiring the URL inside the ballot makes the early disclosure mandatory rather than accidental.

**Smallest correction:** Collect ballots first and request public filing from objectors only after the matching batch has been published.

### 2. [P1] Claude: a URL-shaped rationale does not establish the required follow-up

**Plan claim:** The `src/ballotResponse.ts` entry accepts any same-repository issue URL with a different number; Alternatives Rejected explicitly rejects checking the issue. The PR formatter then states that each objection was filed by the objecting agent.

**Rule:** The requested closeout must leave an actual follow-up issue containing the remaining objections and linking to the concluding issue. Publication must not claim that obligation is satisfied from URL syntax alone.

**Concrete failure:** A rationale containing `https://github.com/<repository>/issues/999999999` passes the proposed check even if that issue does not exist. An unrelated existing issue with no backlink also passes. Finalization can then open a PR claiming the objection was filed while the objection has no follow-up. Putting the URL before the owner does not meet the requested automatic workflow, particularly under the existing coordinator-merge policy.

**Smallest correction:** Verify the issue and backlink asynchronously in the run loop and retain accepted evidence. The pure ballot parser need not perform network I/O.

### 3. [P1] Claude: the existing stuck state remains on the obsolete owner question

**Plan claim:** Risks and Mitigations says that a run already parked on a `revision-limit` question keeps that question until answered. The machine change affects only the later completed-ballot branch.

**Rule:** A persisted third-round limit state with complete accepted evidence must reach the new closeout without requiring another same-pin ballot or abandonment; this is the failure state described in the issue.

**Concrete failure:** `src/machine.ts:190` returns the existing owner question before inspecting completed ballots, so restarting an affected issue with the new implementation still offers only retry or abandon. Retry then removes its accepted round-three responses (`src/ownerControls.ts:282`) and asks every reviewer to vote again on the same pin. The new finalization path is unreachable from that state without repeating the work the issue asks to conclude.

**Smallest correction:** Retire the obsolete limit question under the existing state lock once its terminal evidence is established, preserving ballots and independent pauses/holds, and test resumption from that persisted state.

### 4. [P1] Antigravity: the approved file map cannot implement the proposed workflow

**Plan claim:** Reuse and Scope introduces `R6.objection`, an objection receipt, a persisted `concludedWithObjections` decision, and follow-up links in the PR. The exact changed-file list omits the modules that register, validate, persist, and display those additions.

**Rule:** Every necessary implementation edit must be included in the approved file map, and new workflow identifiers/evidence must pass the existing strict state and evidence schemas.

**Concrete failure:** With the listed files alone, `src/state.ts:54` rejects `R6.objection` and `src/state.ts:585` rejects the proposed extra decision field. `src/evidence.ts:381` still parses an unhandled Git artifact as finalization evidence, so an objection receipt cannot be accepted. Adding a workflow/evidence identifier also leaves the exhaustive maps in `src/issueReport.ts:10` and `src/agentLanguage.ts:117` incomplete, failing typecheck. The promised PR formatting extension belongs to the omitted `src/githubIssue.ts`. Citing a file only in Reuse and Scope does not authorize editing it.

**Smallest correction:** Enumerate these necessary files and the actual persistence/validation changes before implementation. Retain the existing numbered interactive menu unless a separate unsolved input requirement is demonstrated; a textual command parser does not repair the missing workflow integration.

### 5. [P1] Cursor, also Claude's late-drop mitigation: changing only consensus rederivation does not prevent rewind

**Plan claim:** Cursor behavior item 11 and its drop test say that recomputing the stored limit consensus with the new limit function preserves closeout. Claude's owner-controls entry and late-drop mitigation make the same claim by passing the revision limit to `computeConsensusDerived`.

**Rule:** Dropping a non-reviser after the final revision has been selected must retain that product pin and completed selection authority; a recovery operation must not restart development from planning or an older implementation.

**Concrete failure:** `rederiveAfterDrop` processes the prior plan at `src/ownerControls.ts:147`, before the proposed consensus-call change at line 203. With an ordinary three-agent history, dropping one agent leaves only a three-agent published plan batch. `publishedBallotBatch` requires an exact current roster (`src/runLoop.ts:264`), so `computePlanSelectionDerived` returns null. The earlier branch resets to `R3.plan-ballot` and removes accepted implementation/revision evidence; the new consensus code is never reached. If the drop leaves one agent whose plan was not the selected plan, line 149 instead resets directly to `R4.implement`. Merely preserving the new follow-up step during profile normalization cannot recover the removed final pin.

**Smallest correction:** Handle terminal closeout before the earlier-selection reset branches, preserving completed product authority while rebuilding only the affected remaining-roster evidence. Test realistic histories with plan and implementation selections populated, including a one-agent remainder.

### 6. [P2] Cursor: follow-up creation has no replay rule when verification fails

**Plan claim:** Behavior item 6 directs every filing action to create an issue; item 8 reissues rejected submissions, and the GitHub verifier tests treat a `gh` failure as a rejection. No stable filing identity or search/reuse rule is specified.

**Rule:** Retrying observation of an already-created follow-up must preserve that filing and must not instruct the agent to create another issue for the same objections.

**Concrete failure:** The agent creates issue 178 and submits its receipt. A temporary failure of the coordinator's `gh issue view` rejects the submission and issues another action whose instruction is again to create an issue. Following that instruction produces issue 179 for the same objections. Repeated lookup failures multiply issues; a crash after successful creation but before the receipt has the same effect.

**Smallest correction:** Give filing a stable key based on issue session, agent, and final revision; require lookup/reuse on reissue, and return retryable verification for transient lookup failure while keeping the original completion evidence. Cover successful creation followed by failed verification and restart.

## Conclusion

- **Claude — revise.** Its small file map reuses the existing derivation and PR path, but the proposed shortcut compromises private voting, cannot establish the required linked follow-up, and leaves already-stuck issues on the old question. Its late-drop mitigation also does not reach the actual rewind branch.
- **Antigravity — revise.** The post-ballot filing direction is appropriate, but the file map omits essential schema, validation, and presentation changes. The proposed interactive parser adds scope to mechanics already supported by numbered menus. The Tests section also needs executable commands, as required by the repository protocol.
- **Cursor — revise.** It provides a concrete post-publication filing step, real issue verification, and legacy-question recovery. Its main unresolved problems are terminal drop recovery and replay of issue creation after lookup failure. The existing-file approach and focused test locations are appropriate.
- **Codex — no blocking finding identified.** Its larger map accounts for strict schemas, evidence routing, issue verification, publication, and recovery; it reuses existing state/action/test support and creates no product files or dependencies. It explicitly addresses sealed-ballot timing, filing reconciliation, legacy limit questions, and the earlier-selection rewind. During implementation, keep those changes confined to terminal closeout and the listed files.

There is a policy difference worth retaining in the selection decision: Claude and Cursor leave third-round `escalate` as an owner question; Codex treats both final-round non-approval dispositions as follow-up obligations. None of the plans should bypass failed product checks, and the final pin must continue through the existing verification and configured PR policy.

Verification performed: read and hash-checked the four bound plans; traced the relevant state, ballot, evidence, owner-control, and finalization code; ran a focused pure diagnostic against the existing compiled derivation helper. That diagnostic confirmed that a valid three-agent plan selection becomes null after dropping one agent despite both remaining ballots choosing the same winner. No product files changed and no product suite was run for this review artifact.
