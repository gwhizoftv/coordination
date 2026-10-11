import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessFollowUpIssue,
  fetchGitHubIssue,
  followUpFilingKey,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot,
  renderGitHubIssueSnapshot
} from "../src/githubIssue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub issue snapshots", () => {
  it("derives supported repositories and binds lookup to origin rather than cwd", async () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("/tmp/app.git")).toBeNull();
    const calls: string[][] = [];
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 42,
      cwd: "/unrelated/repository",
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Work",
            body: "Do it",
            url: "https://github.com/acme/app/issues/42"
          }),
          stderr: ""
        };
      }
    });
    expect(calls[0]).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--repo",
      "acme/app",
      "--json",
      "number,title,body,url"
    ]);
    expect(snapshot.repository).toBe("acme/app");
    expect(renderGitHubIssueSnapshot(snapshot)).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });

  it("fails with issue-first remediation on a missing or unreadable issue", async () => {
    await expect(
      fetchGitHubIssue({
        origin: "https://github.com/acme/app.git",
        issue: 999,
        cwd: "/tmp",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "issue not found" })
      })
    ).rejects.toThrow(/Create GitHub issue 999.*gh auth status/);
  });

  it("rejects malformed and mismatched responses", async () => {
    const input = {
      origin: "https://github.com/acme/app.git",
      issue: 7,
      cwd: "/tmp"
    };
    await expect(
      fetchGitHubIssue({ ...input, runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) })
    ).rejects.toThrow(/invalid snapshot/);
    await expect(
      fetchGitHubIssue({
        ...input,
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            number: 8,
            title: "wrong",
            body: "",
            url: "https://github.com/acme/app/issues/8"
          }),
          stderr: ""
        })
      })
    ).rejects.toThrow(/issue 8 while issue 7/);
  });

  it("normalizes an empty GitHub issue body to an empty string", async () => {
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 3,
      cwd: "/tmp",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          title: "Body optional",
          body: null,
          url: "https://github.com/acme/app/issues/3"
        }),
        stderr: ""
      })
    });
    expect(snapshot.body).toBe("");
  });

  it("reads a durable runtime snapshot and formats finalization PR text", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-issue-snap-"));
    roots.push(root);
    const path = join(root, "github-issue.json");
    const snapshot = {
      repository: "acme/app",
      number: 112,
      title: "Have PR's include the issue title",
      body: "Close on merge.",
      url: "https://github.com/acme/app/issues/112"
    };
    writeFileSync(path, renderGitHubIssueSnapshot(snapshot));
    expect(readGitHubIssueSnapshot(path)).toEqual(snapshot);
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: snapshot.title,
        finalSha: "a".repeat(40),
        draft: true,
        evidenceBranch: "issue-112/coordinator-evidence",
        evidenceTip: "c".repeat(40)
      })
    ).toEqual({
      title: "Issue 112: Have PR's include the issue title",
      body: [
        "Closes #112",
        "",
        `Draft PR for issue 112. Owner merges. Final pin: ${"a".repeat(40)}.`,
        "",
        `Ballot evidence branch: issue-112/coordinator-evidence (tip ${"c".repeat(40)}).`,
        "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
      ].join("\n")
    });
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: "  ",
        finalSha: "b".repeat(40),
        draft: false
      }).title
    ).toBe("Issue 112: coordinated implementation");
  });

  it("names a capped closeout and its follow-up links without dropping the concluding reference", () => {
    const body = formatFinalizationPullRequest({
      issue: 177,
      title: "Conclude review",
      finalSha: "a".repeat(40),
      draft: true,
      capped: true,
      followUpUrls: ["https://github.com/acme/app/issues/200"]
    }).body;
    expect(body).toContain("Closes #177");
    expect(body).toContain("Concluded at the revision limit.");
    expect(body).toContain("https://github.com/acme/app/issues/200");
    expect(body).not.toContain("approved");
  });
});

describe("follow-up issue verification", () => {
  const revision = "d".repeat(40);
  const key = followUpFilingKey("issue-177:abc", "codex", revision);
  const parentUrl = "https://github.com/acme/app/issues/177";
  const assess = (url: string, runner: Parameters<typeof assessFollowUpIssue>[0]["runner"]) =>
    assessFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      parentIssue: 177,
      parentUrl,
      agent: "codex",
      issueSessionId: "issue-177:abc",
      revisionSha: revision,
      followUpUrl: url,
      cwd: "/unused",
      runner
    });
  const issue = (body: string, url = "https://github.com/acme/app/issues/200") =>
    async (argv: readonly string[]) => {
      expect(argv).not.toContain("create");
      expect(argv.slice(0, 3)).toEqual(["gh", "issue", "view"]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ number: 200, title: "Objections", body, url }),
        stderr: ""
      };
    };

  it("accepts a different issue that carries the key, revision, and a non-closing backlink", async () => {
    const result = await assess(
      "https://github.com/acme/app/issues/200",
      issue(`Remaining failure.\nExpected: the third revision concludes.\n${revision}\n${key}\nSee ${parentUrl}`)
    );
    expect(result).toEqual({ status: "ok", url: "https://github.com/acme/app/issues/200", number: 200 });
  });

  it("rejects the concluding issue, a foreign repository, and a missing backlink or key", async () => {
    const runner = issue(`no key`);
    expect((await assess(parentUrl, runner)).status).toBe("reject");
    expect((await assess("https://github.com/other/repo/issues/200", runner)).status).toBe("reject");
    expect((await assess("https://github.com/acme/app/issues/200", issue(`${revision}\n${key}`))).status).toBe("reject");
    expect((await assess("https://github.com/acme/app/issues/200", issue(`${revision}\nSee #177`))).status).toBe("reject");
    expect(
      (await assess("https://github.com/acme/app/issues/200", issue(`${revision}\n${key}\nCloses #177`))).status
    ).toBe("reject");
  });

  it("retries when the lookup is unavailable and does not create an issue", async () => {
    const calls: string[][] = [];
    const result = await assess("https://github.com/acme/app/issues/200", async (argv) => {
      calls.push([...argv]);
      throw new Error("gh unavailable");
    });
    expect(result.status).toBe("retry");
    expect(calls.some((argv) => argv.includes("create"))).toBe(false);
  });
});
