## Comparison

### Bound Implementation Pins

- codex: `e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5`
- claude: `9d8d25436530ced335f15843350413c969af1d60`
- cursor: `5e7f8fee93746dc11083bca7f0029d1137982620`
- antigravity: `3cf68ba1181b8e6e4d2ccdd7c46d38692adb193b`

### Scope and Discipline Comparison

All four implementations adhered strictly to the approved 22-file map and avoided creating unnecessary new product files or introducing speculative dependencies. Each implementation reused existing structures and types (`BoundInput`, `DerivedDecisionRecord`, `hasCompleteActiveDenominator`, `fetchGitHubIssue`, `formatFinalizationPullRequest`). However, there are significant differences in correctness, schema robustness, and edge-case handling across the four solutions.

### Detailed Findings

#### Finding 1 (claude: `9d8d25436530ced335f15843350413c969af1d60`)

- **File and Line**: `src/state.ts:608`
- **Rule**: `ConsensusDerived.objectors` must be a list of agent identifiers (`agentIdSchema[]`) to maintain compatibility with participant filtering in `orderParticipantAgents` and serialization in `derivedDecisionJournalDetails`.
- **Concrete Failure**: Claude defines `consensusObjectorSchema = z.object({ agent: agentIdSchema, disposition: z.enum(["revise", "escalate"]) })` and types `objectors: z.array(consensusObjectorSchema).min(1).optional()`. In `src/steps.ts`, `orderParticipantAgents` checks `conclusion.objectors.includes(agent)`. Because `conclusion.objectors` contains objects `{ agent, disposition }` instead of string agent IDs, `conclusion.objectors.includes(agent)` evaluates to `false` for every active agent string. Consequently, no agents are identified as participants for `R6.follow-up`, preventing objectors from ever being ordered to file their follow-up issues.
- **Illustrative Test**:
```ts
const objectors = [{ agent: "claude" as const, disposition: "revise" as const }];
const agent = "claude";
expect((objectors as any[]).includes(agent)).toBe(false); // Fails participant match
```

#### Finding 2 (cursor: `5e7f8fee93746dc11083bca7f0029d1137982620`)

- **File and Line**: `src/githubIssue.ts:99`
- **Rule**: Stable filing keys generated for follow-up deduplication must use a cryptographic digest of the issue session, agent, and revision commit SHA to produce a bounded, collision-resistant token safe for `gh issue list --search` queries.
- **Concrete Failure**: Cursor defines `followUpFilingKey` as a raw concatenated template string: ``coord-follow-up:${issueSessionId}:${agent}:${revisionSha}``. Because `issueSessionId` can contain arbitrary characters, spaces, and colons, searching GitHub issues using an unhashed multi-colon string risks query parsing errors and false-positive substring matches against issue text in other repositories.
- **Illustrative Test**:
```ts
const key = followUpFilingKey("issue-177:8d38734a", "cursor", "5e7f8fee");
expect(key).toMatch(/^coord:follow-up:[0-9a-f]{64}$/); // Fails: received raw string
```

#### Finding 3 (codex: `e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5`)

- **File and Line**: `src/githubIssue.ts:216-218`
- **Rule**: Follow-up issue backlink validation must flexibly accept valid GitHub markdown references to the concluding issue rather than requiring exact line-level literal strings (`"Related to ..."`), which breaks when agents format backlinks naturally (e.g. `Related to https://...` with punctuation or markdown links).
- **Concrete Failure**: Codex uses strict exact line matching: `lines.includes(\`Related to ${parentUrl}\`)` and `lines.includes(\`Revision: ${input.revisionCommitSha}\`)`. If an objecting agent formats the issue body with standard markdown links `Related to [#177](...)` or adds trailing punctuation, Codex's `assessFollowUpIssue` rejects the valid filing with an unrecoverable format error.
- **Fix Sketch**: Use regular expressions that inspect the body content for the backlink URL and commit SHA rather than exact whole-line equality.

### Overall Assessment

1. **antigravity (`3cf68ba1181b8e6e4d2ccdd7c46d38692adb193b`)**: Implements the approved plan cleanly and completely. Uses a strict discriminated union for `ConsensusDerived` distinguishing `unanimous-active-roster-v1` from `revision-limit-active-roster-v1`, properly schedules only active objectors during `R6.follow-up`, derives stable hash-based tracking keys (`coord:follow-up:<sha256>`), truthfully annotates PR titles and bodies with closeout reasons and issue links, and safely handles terminal consensus preservation across owner drops and restarts. All product, unit, and system tests pass.
2. **codex (`e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5`)**: Solid and thorough implementation that authored the plan. Only minor brittleness in exact-line body matching in `src/githubIssue.ts`.
3. **cursor (`5e7f8fee93746dc11083bca7f0029d1137982620`)**: Well-structured discriminated union for consensus derived schemas, but uses unhashed tracking keys and slightly inconsistent naming.
4. **claude (`9d8d25436530ced335f15843350413c969af1d60`)**: Incomplete alignment with plan data structures, storing objects in `objectors` that break participant filtering in `orderParticipantAgents`.
