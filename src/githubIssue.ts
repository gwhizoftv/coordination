import { readFileSync } from "node:fs";
import { z } from "zod";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

const issueResponseSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z
      .string()
      .nullable()
      .transform((body) => body ?? ""),
    url: z.string().url()
  })
  .strict();

const issueSnapshotSchema = z
  .object({
    repository: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    url: z.string().url()
  })
  .strict();

export type GitHubIssueSnapshot = {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
};

/** Load the start-time `github-issue.json` snapshot written under the issue runtime. */
export const readGitHubIssueSnapshot = (path: string): GitHubIssueSnapshot => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read GitHub issue snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = issueSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`GitHub issue snapshot ${path} is invalid.`);
  }
  return parsed.data;
};

/**
 * Title and body for the coordinator-opened finalization PR.
 * `Closes #N` must appear in the body so GitHub auto-closes the issue on merge.
 * Optional evidence fields name the coordinator-authored ballot publication
 * branch; they are not a cryptographic agent signature.
 */
export const formatFinalizationPullRequest = (input: {
  issue: number;
  title: string;
  finalSha: string;
  draft: boolean;
  evidenceBranch?: string | null;
  evidenceTip?: string | null;
  /** Present only for a revision-limit closeout. Unanimous PRs omit it. */
  capped?: boolean;
  followUpUrls?: readonly string[];
}): { title: string; body: string } => {
  const issueTitle = input.title.trim() === "" ? "coordinated implementation" : input.title.trim();
  const lines = [
    `Closes #${input.issue}`,
    "",
    input.draft
      ? `Draft PR for issue ${input.issue}. Owner merges. Final pin: ${input.finalSha}.`
      : `PR for issue ${input.issue}. Coordinator merges. Final pin: ${input.finalSha}.`
  ];
  if (input.capped === true) {
    lines.push("", "Concluded at the revision limit. Remaining objections were filed by the objecting agents.");
    for (const url of input.followUpUrls ?? []) lines.push(`- ${url}`);
  }
  if (input.evidenceBranch !== undefined && input.evidenceBranch !== null && input.evidenceBranch !== "") {
    lines.push(
      "",
      `Ballot evidence branch: ${input.evidenceBranch}` +
        (input.evidenceTip !== undefined && input.evidenceTip !== null && input.evidenceTip !== ""
          ? ` (tip ${input.evidenceTip}).`
          : "."),
      "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
    );
  }
  return {
    title: `Issue ${input.issue}: ${issueTitle}`,
    body: lines.join("\n")
  };
};

export const followUpFilingKey = (issueSessionId: string, agent: string, revisionSha: string): string =>
  `coord-follow-up:${issueSessionId}:${agent}:${revisionSha}`;

const githubIssueUrl = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/issues\/(\d+)\/?$/;

export type FollowUpAssessment =
  | { status: "ok"; url: string; number: number }
  | { status: "retry"; reason: string }
  | { status: "reject"; reason: string };

/**
 * Confirm a receipt URL is a different issue in the concluding repository.
 * Lookup failure is retryable. A wrong issue or a missing backlink is a rejection
 * the objecting agent can correct. This never creates an issue.
 */
export const assessFollowUpIssue = async (input: {
  origin: string;
  parentIssue: number;
  parentUrl: string;
  agent: string;
  issueSessionId: string;
  revisionSha: string;
  followUpUrl: string;
  cwd: string;
  runner: CommandRunner;
}): Promise<FollowUpAssessment> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    return { status: "reject", reason: `origin ${input.origin} is not a supported github.com repository` };
  }
  const match = githubIssueUrl.exec(input.followUpUrl.trim());
  if (match === null) {
    return { status: "reject", reason: `follow-up URL ${input.followUpUrl} is not a GitHub issue URL` };
  }
  const urlRepository = `${match[1]}/${match[2]!.replace(/\.git$/, "")}`;
  const number = Number(match[3]);
  if (urlRepository !== repository) {
    return { status: "reject", reason: `follow-up issue is in ${urlRepository}, not ${repository}` };
  }
  if (number === input.parentIssue) {
    return { status: "reject", reason: "follow-up URL is the concluding issue, not a separate issue" };
  }
  let snapshot: GitHubIssueSnapshot;
  try {
    snapshot = await fetchGitHubIssue({ origin: input.origin, issue: number, cwd: input.cwd, runner: input.runner });
  } catch (error) {
    return { status: "retry", reason: error instanceof Error ? error.message : String(error) };
  }
  const normalized = (url: string): string => url.replace(/\/$/, "");
  if (normalized(snapshot.url) !== normalized(input.followUpUrl)) {
    return { status: "reject", reason: "looked-up issue URL does not match the receipt" };
  }
  const key = followUpFilingKey(input.issueSessionId, input.agent, input.revisionSha);
  if (!snapshot.body.includes(key)) {
    return { status: "reject", reason: "follow-up issue body is missing the filing key" };
  }
  if (!snapshot.body.includes(input.revisionSha)) {
    return { status: "reject", reason: "follow-up issue body is missing the revision SHA" };
  }
  const closing = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#${input.parentIssue}\b`, "i");
  if (closing.test(snapshot.body)) {
    return { status: "reject", reason: `follow-up issue uses a closing reference to #${input.parentIssue}` };
  }
  const linksParent =
    snapshot.body.includes(input.parentUrl) ||
    new RegExp(String.raw`(^|[^\w])#${input.parentIssue}\b`).test(snapshot.body);
  if (!linksParent) {
    return { status: "reject", reason: "follow-up issue does not link the concluding issue" };
  }
  return { status: "ok", url: snapshot.url, number: snapshot.number };
};

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

export const renderGitHubIssueSnapshot = (snapshot: GitHubIssueSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

const remediation = (repository: string, issue: number): string =>
  `Create GitHub issue ${issue} in ${repository} first, or repair GitHub CLI access with \`gh auth status\`.`;

export const fetchGitHubIssue = async (input: {
  origin: string;
  issue: number;
  cwd: string;
  runner: CommandRunner;
}): Promise<GitHubIssueSnapshot> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue}: origin ${input.origin} is not a supported github.com repository. ` +
        `Point the workspace at the GitHub repository that owns the issue, create issue ${input.issue} there first, ` +
        "and verify GitHub CLI access with `gh auth status`."
    );
  }

  let result: CommandResult;
  try {
    result = await input.runner(
      [
        "gh",
        "issue",
        "view",
        String(input.issue),
        "--repo",
        repository,
        "--json",
        "number,title,body,url"
      ],
      input.cwd
    );
  } catch (error) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue} from ${repository}: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `gh exited ${result.exitCode}`;
    throw new Error(`Cannot read GitHub issue ${input.issue} from ${repository}: ${detail}. ${remediation(repository, input.issue)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  const parsed = issueResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned an invalid snapshot. ${remediation(repository, input.issue)}`
    );
  }
  if (parsed.data.number !== input.issue) {
    throw new Error(
      `GitHub returned issue ${parsed.data.number} while issue ${input.issue} was requested from ${repository}. ` +
        remediation(repository, input.issue)
    );
  }
  return { repository, ...parsed.data };
};
