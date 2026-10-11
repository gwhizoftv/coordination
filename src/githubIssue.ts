import { readFileSync } from "node:fs";
import { z } from "zod";
import { sha256 } from "./hash.js";

export const stableFilingKey = (issueSessionId: string, agent: string, revisionSha: string): string =>
  `coord:follow-up:${sha256(`follow-up-key:${issueSessionId}:${agent}:${revisionSha}`)}`;

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
  closeoutReason?: string | null;
  followUpIssues?: readonly { agent: string; issue: number; url: string }[] | null;
}): { title: string; body: string } => {
  const issueTitle = input.title.trim() === "" ? "coordinated implementation" : input.title.trim();
  const lines = [
    `Closes #${input.issue}`,
    "",
    input.draft
      ? `Draft PR for issue ${input.issue}. Owner merges. Final pin: ${input.finalSha}.`
      : `PR for issue ${input.issue}. Coordinator merges. Final pin: ${input.finalSha}.`
  ];
  if (input.closeoutReason !== undefined && input.closeoutReason !== null && input.closeoutReason !== "") {
    lines.push("", `Conclusion: ${input.closeoutReason}.`);
  }
  if (input.followUpIssues !== undefined && input.followUpIssues !== null && input.followUpIssues.length > 0) {
    lines.push("", "Follow-up issues filed by objecting agents:");
    for (const item of input.followUpIssues) {
      lines.push(`- ${item.agent}: #${item.issue} (${item.url})`);
    }
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

export type VerifyFollowUpResult =
  | { ok: true; issue: number; url: string; title: string }
  | { ok: false; retry: boolean; error: string };

export const verifyFollowUpIssue = async (input: {
  origin: string;
  concludingIssue: number;
  agent: string;
  revisionSha: string;
  stableKey: string;
  followUpUrl: string;
  cwd: string;
  runner: CommandRunner;
}): Promise<VerifyFollowUpResult> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    return { ok: false, retry: false, error: `foreign repository URL or unsupported origin ${input.origin}` };
  }
  const match = new RegExp(`^https://github\\.com/${repository.replace("/", "\\/")}/issues/(\\d+)$`).exec(input.followUpUrl.trim());
  if (match === null || match[1] === undefined) {
    return { ok: false, retry: false, error: `follow-up issue URL ${input.followUpUrl} does not match repository ${repository}` };
  }
  const issueNumber = Number(match[1]);
  if (issueNumber === input.concludingIssue) {
    return { ok: false, retry: false, error: `follow-up issue cannot be concluding issue #${input.concludingIssue}` };
  }
  let snapshot: GitHubIssueSnapshot;
  try {
    snapshot = await fetchGitHubIssue({
      origin: input.origin,
      issue: issueNumber,
      cwd: input.cwd,
      runner: input.runner
    });
  } catch (error) {
    return { ok: false, retry: true, error: `GitHub issue lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = snapshot.body;
  const backlink = `#${input.concludingIssue}`;
  if (!body.includes(backlink) && !body.includes(`/issues/${input.concludingIssue}`)) {
    return { ok: false, retry: false, error: `follow-up issue #${issueNumber} body is missing a backlink to #${input.concludingIssue}` };
  }
  if (!body.includes(input.revisionSha)) {
    return { ok: false, retry: false, error: `follow-up issue #${issueNumber} body does not cite revision commit ${input.revisionSha}` };
  }
  if (!body.includes(input.stableKey)) {
    return { ok: false, retry: false, error: `follow-up issue #${issueNumber} body does not cite stable filing key ${input.stableKey}` };
  }
  return { ok: true, issue: issueNumber, url: snapshot.url, title: snapshot.title };
};
