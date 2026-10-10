# Review: Plans for Issue 177

## Findings

### 1. Claude: Premature Public Issue Creation Violates Ballot Privacy
- **Plan claim or section**: Claude's plan, `## Exact File List to be changed or deleted` (`src/runLoop.ts` lines 40-47 and `src/ballotResponse.ts` lines 61-67). Claude requires an objecting agent to run `gh issue create` and cite the URL in its `R6.ballot` rationale before submitting its ballot.
- **Rule that must hold**: Ballot responses during `R6.ballot` are private, sealed submissions that must not be revealed publicly until all active agents have voted and the canonical ballot batch is published.
- **Concrete failure**: If an agent must create a public GitHub issue before submitting its private ballot, the agent's objections and verdict are published to GitHub while peers' ballot actions remain open. Peer agents can read the newly created issue before casting their own ballots, destroying blind review independence. Additionally, if the ballot response is subsequently rejected for formatting or the agent is dropped, the public issue was created prematurely.
- **Correction**: Keep `R6.ballot` private without requiring pre-ballot public issue filing. Once all ballots are collected and published at round 3, transition objecting agents to a dedicated post-ballot follow-up task (`R6.follow-up`) to file the issue.

### 2. Cursor: Retaining Terminal Owner Question on Escalation Preserves Deadlock
- **Plan claim or section**: Cursor's plan, `## Reuse and Scope` (lines 5, 52). Cursor specifies that an `escalate` disposition at round 3 "still returns the existing owner question. At round 3 its answers stay retry and abandon."
- **Rule that must hold**: Reaching the revision limit at round 3 must not leave the workflow stranded in an owner-question deadlock where `retry` loops on the same pin and `abandon` discards completed development.
- **Concrete failure**: If an agent votes `escalate` during round 3 (for instance, due to an unaddressed regression or fundamental disagreement), `decide` will still emit `owner-action-required` with kind `ballot-escalation` offering only `retry` and `abandon`. Because round 4 is forbidden and the commit cannot change, `retry` simply re-runs the vote on the same pin and loops, recreating the exact failure reported in issue 177.
- **Correction**: Treat any non-approving disposition (`revise` or `escalate`) at the terminal round 3 as concluding the issue and routing the objecting agent to file a linked follow-up issue.

### 3. Claude: Pure URL String Matching in Rationale Fails to Verify Issue Existence or Backlink
- **Plan claim or section**: Claude's plan, `## Exact File List to be changed or deleted` (`src/ballotResponse.ts` lines 61-67) and `## Alternatives Rejected` (lines 189-192). Claude checks only that the rationale string contains `https://github.com/<repository>/issues/<n>` with `n !== issue`, rejecting any external check with `gh issue view`.
- **Rule that must hold**: The follow-up issue submitted for remaining objections must exist in the target repository and must explicitly link back to the concluding issue.
- **Concrete failure**: If an agent references a non-existent issue number, an unrelated issue from the past, or an issue that does not contain a backlink to `#<issue>`, Claude's validator accepts it unconditionally. The coordinator then finalizes and generates a PR citing a bogus or unlinked follow-up issue, leaving the unresolved objections unlinked and untracked.
- **Correction**: As planned by Codex and Cursor, asynchronously verify via the existing `fetchGitHubIssue` helper that the referenced issue exists in the repository and contains the backlink `#<concluding-issue>` before accepting the submission.

### 4. Codex: Mechanically Complete and Sound Architecture
- **Plan claim or section**: Codex's plan, `## Reuse and Scope` and `## Tests`.
- **Evaluation**: Codex's plan stays strictly within the issue, creates zero new product or helper files, reuses existing step/evidence/verification machinery, cleanly separates private ballot completion from public issue filing, verifies GitHub issue existence and backlinks, and handles restart/drop edge cases without regressions.

## Conclusion

Codex's plan (`29ff9141bb350e934d8e72cd1a145303db4cd344`) is the strongest and most mechanically complete proposal. It correctly keeps private voting confidential, schedules follow-up filing only after the round-3 ballot batch is published, eliminates terminal deadlocks for both `revise` and `escalate`, and verifies that filed issues link back to the concluding issue. Claude's plan breaks ballot confidentiality by requiring public issue creation during private voting, and Cursor's plan leaves round-3 escalation vulnerable to the original retry/abandon deadlock. Codex's plan should be selected.
