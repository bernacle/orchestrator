import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent, stripParentSession } from "../../src/adapters/claude.js";
import { CodexAgent } from "../../src/adapters/codex.js";
import { GitHubHost, mapPr } from "../../src/adapters/github.js";
import { LinearTracker, mapIssue } from "../../src/adapters/linear.js";
import { RepoConfigSchema } from "../../src/config/schema.js";

const cfg = RepoConfigSchema.parse({
  repo: "o/r",
  linear: { teams: ["O"] },
  agents: {
    implementer: { adapter: "claude-code", allowed_tools: ["Read", "Edit", "Bash(pnpm test:*)"], model: "opus" },
    reviewer: { adapter: "codex", model: "gpt-x" },
  },
});

describe("ClaudeCodeAgent", () => {
  const agent = new ClaudeCodeAgent(cfg.agents.implementer as never);
  it("implementer: auto-accepts edits, denies unlisted tools and git push/commit, never bypasses", () => {
    const args = agent.args({ role: "implementer", sessionId: "11111111-1111-1111-1111-111111111111" });
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--model", "opus"]));
    expect(args.join(" ")).toContain("Bash(git push:*)");
    expect(args.join(" ")).toContain("Bash(gh:*)");
    expect(args).toContain("--session-id");
    expect(args.join(" ")).not.toMatch(/bypassPermissions|dangerously/);
  });
  it("resumes the same session for fix rounds", () => {
    const args = agent.args({ role: "implementer", resumeSessionId: "abc" });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "abc"]);
    expect(args).not.toContain("--session-id");
  });
  it("planner only gets read-only tools", () => {
    const args = agent.args({ role: "planner", outputSchema: { type: "object" } });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).toContain("--json-schema");
  });
  it("strips parent Claude Code session variables from the child env", () => {
    expect(stripParentSession({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" })).toEqual({ CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" });
  });
});

describe("ClaudeCodeAgent auto memory and sandbox reads", () => {
  it("turns auto memory off in the settings and the environment of every Claude process", async () => {
    // A stand-in `claude` that records its environment and arguments, then answers like `claude -p`.
    const dir = mkdtempSync(join(tmpdir(), "orch-claude-"));
    try {
      const bin = join(dir, "claude");
      writeFileSync(bin, `#!/bin/sh\nenv > "${dir}/env.txt"\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat > /dev/null\necho '{"result":"ok","session_id":"s","is_error":false}'\n`);
      chmodSync(bin, 0o755);
      const a = new ClaudeCodeAgent(cfg.agents.implementer as never, { denyRead: [], deniedEnv: [], allowRead: ["/iso/gitconfig-empty"] }, bin);
      const r = await a.run({ role: "implementer", cwd: dir, prompt: "x", artifactDir: dir, artifactPrefix: "t", timeoutMs: 30_000, env: { PATH: "/usr/bin:/bin" }, signal: new AbortController().signal, readablePaths: ["/nvm/v24.21.0"] });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(dir, "env.txt"), "utf8")).toMatch(/^CLAUDE_CODE_DISABLE_AUTO_MEMORY=1$/m);
      const args = readFileSync(join(dir, "args.txt"), "utf8").split("\n");
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { autoMemoryEnabled: boolean; sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } } };
      expect(settings.autoMemoryEnabled).toBe(false);
      // The pinned Node and the isolation stubs become readable; nothing becomes writable.
      expect(settings.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining(["/iso/gitconfig-empty", "/nvm/v24.21.0"]));
      expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
      // The audit copy shows the same settings the process ran under.
      expect(JSON.parse(readFileSync(join(dir, "t.claude-settings.json"), "utf8"))).toEqual(settings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("planner and reviewer settings also disable auto memory", () => {
    const a = new ClaudeCodeAgent(cfg.agents.implementer as never);
    expect((a.settings("planner") as { autoMemoryEnabled: boolean }).autoMemoryEnabled).toBe(false);
    expect((a.settings("reviewer") as { autoMemoryEnabled: boolean }).autoMemoryEnabled).toBe(false);
  });
});

describe("CodexAgent", () => {
  const agent = new CodexAgent(cfg.agents.reviewer as never);
  it("reviews in the read-only sandbox with approvals off and a schema", () => {
    const args = agent.args({ role: "reviewer", cwd: "/wt", outputSchema: {}, artifactDir: "/a", artifactPrefix: "review-0" });
    expect(args.slice(0, 1)).toEqual(["exec"]);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toEqual(expect.arrayContaining(["--json", "-C", "/wt", "--output-schema", "/a/review-0.schema.json", "-m", "gpt-x", "-"]));
    expect(args.join(" ")).toContain('approval_policy="never"');
    expect(args.join(" ")).not.toMatch(/dangerously|danger-full-access/);
  });

  it("attaches screenshots as images, one flag per file, before the stdin prompt marker", () => {
    const args = agent.args({ role: "reviewer", cwd: "/wt", artifactDir: "/a", artifactPrefix: "review-0", images: ["/wt/a.png", "/wt/b c.png"] });
    expect(args.slice(-5)).toEqual(["--image", "/wt/a.png", "--image", "/wt/b c.png", "-"]);
    expect(agent.args({ role: "reviewer", cwd: "/wt", artifactDir: "/a", artifactPrefix: "review-0" })).not.toContain("--image");
  });
});

describe("Linear mapping", () => {
  const ref = (identifier: string, type = "started") => ({ identifier, title: identifier, url: `u/${identifier}`, state: { name: type, type } });
  const raw = {
    id: "1",
    identifier: "BRU-2",
    title: "T",
    description: null,
    url: "u",
    updatedAt: "2026",
    branchName: "bru-2",
    priority: 2,
    priorityLabel: "High",
    state: { name: "Todo", type: "unstarted" },
    team: { key: "BRU", name: "B" },
    project: null,
    assignee: null,
    labels: { nodes: [{ name: "core" }] },
    parent: null,
    children: { nodes: [] },
    relations: { nodes: [{ type: "blocks", relatedIssue: ref("BRU-3") }, { type: "related", relatedIssue: ref("BRU-9") }] },
    inverseRelations: { nodes: [{ type: "blocks", issue: ref("BRU-1") }] },
    comments: { nodes: [{ body: "b", createdAt: "2026-02", user: null }, { body: "a", createdAt: "2026-01", user: { name: "Ana" } }] },
    attachments: { nodes: [] },
  };
  it("distinguishes blockers from blocked issues", () => {
    const issue = mapIssue(raw);
    expect(issue.blockedBy.map((r) => r.key)).toEqual(["BRU-1"]);
    expect(issue.blocks.map((r) => r.key)).toEqual(["BRU-3"]);
    expect(issue.related.map((r) => r.key)).toEqual(["BRU-9"]);
    expect(issue.comments.map((c) => c.author)).toEqual(["Ana", "unknown"]);
  });
  it("sends the key as the Authorization header and surfaces API errors", async () => {
    const seen: Array<Record<string, string>> = [];
    const tracker = new LinearTracker("lin_api_test_key_1234567890abcdef", async (_url, init) => {
      seen.push(init.headers);
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: "Entity not found" }] }) };
    });
    await expect(tracker.getIssue("BRU-404")).rejects.toThrow(/BRU-404 not found/);
    expect(seen[0]!.authorization).toBe("lin_api_test_key_1234567890abcdef");
  });
  it("explains a missing key", async () => {
    await expect(new LinearTracker(undefined).getIssue("BRU-1")).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe("GitHub adapter", () => {
  it("maps check rollups to buckets", () => {
    const pr = mapPr({
      number: 1,
      url: "u",
      state: "OPEN",
      isDraft: true,
      headRefName: "h",
      headRefOid: "s",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null },
        { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "StatusContext", context: "legacy", state: "PENDING" },
      ],
    });
    expect(pr.checks.map((c) => `${c.name}:${c.bucket}`)).toEqual(["lint:pass", "test:pending", "e2e:fail", "legacy:pending"]);
    expect(pr.reviewDecision).toBeNull();
  });

  it("merges with --match-head-commit and never --admin", async () => {
    const calls: string[][] = [];
    const host = new GitHubHost(async (args) => {
      calls.push(args);
      return "";
    });
    await host.mergePullRequest({ repo: "o/r", number: 3, headSha: "c".repeat(40), method: "squash" });
    expect(calls[0]).toEqual(["pr", "merge", "3", "--repo", "o/r", "--squash", "--match-head-commit", "c".repeat(40)]);
    await expect(host.mergePullRequest({ repo: "o/r", number: 3, headSha: "HEAD", method: "squash" })).rejects.toThrow(/full head SHA/);
  });

  it("combines classic protection and rulesets", async () => {
    const host = new GitHubHost(async (args) => {
      if (!args[1]!.includes("/rules/")) return JSON.stringify({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return JSON.stringify([
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } },
        { type: "pull_request", parameters: { required_approving_review_count: 1 } },
      ]);
    });
    const p = await host.getBranchProtection("o/r", "main");
    expect(p).toMatchObject({ protected: true, requiredChecks: ["CI"], requiredApprovals: 1 });
  });
});
