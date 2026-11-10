import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { authorizeRepository, confirmAssociation, resumeRun, startRun } from "../../src/app.js";
import { loadRepoConfigFile, PACKAGE_ROOT } from "../../src/config/load.js";
import { describeScope, runScope } from "../../src/core/approval.js";
import type { RunContext } from "../../src/core/workflow.js";
import { inspectRequest } from "../../src/intake/context.js";
import { buildProposal, localConfigFile, proposalFile } from "../../src/intake/proposal.js";
import { createHarness, git, type Harness } from "../helpers.js";

/**
 * The live-run authorization boundary, exercised at the engine and the real CLI binary. A caller
 * (human or agent) can always type `--execute`; a live run must still not start unless the
 * approver, which stands for a person at a system prompt, says yes for this exact scope.
 */

let h: Harness;
afterEach(() => h?.cleanup());

const live = (over: { issue?: string; dryRun?: boolean } = {}) =>
  startRun(h.app, { issueKey: over.issue ?? "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: over.dryRun ?? false, ciWaitMinutes: 0 });

describe("live runs need a person's approval, enforced by the engine", () => {
  it("an --execute without approval starts nothing: no run, no agent, no push, no PR", async () => {
    h = createHarness();
    h.answer = false;
    await expect(live()).rejects.toMatchObject({ code: "approval_required", message: expect.stringMatching(/not approved: refused in test\. Nothing was started/) });
    expect(h.app.store.listRuns()).toHaveLength(0);
    expect(h.implementer.calls).toHaveLength(0);
    expect(h.host.prs).toHaveLength(0);
    expect(git(h.origin, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    // The refusal is audited.
    const audit = readFileSync(join(h.home, "audit", "approvals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toEqual([expect.objectContaining({ purpose: "live_run", issue: "ACM-1", repo: "acme/widget", approved: false })]);
  });

  it("dry runs never ask", async () => {
    h = createHarness();
    h.answer = false;
    expect((await live({ dryRun: true })).state).toBe("COMPLETED");
    expect(h.approvals).toHaveLength(0);
  });

  it("asks for the exact scope and records the approval on the run", async () => {
    h = createHarness();
    const run = await live();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.approvals).toHaveLength(1);
    const req = h.approvals[0]!;
    const { hash } = runScope({ issue: "ACM-1", config: loadRepoConfigFile(h.configFile).config, configSource: h.configFile });
    expect(req).toMatchObject({ purpose: "live_run", issue: "ACM-1", repo: "acme/widget", scopeHash: hash });
    expect(req.reason).toMatch(/start a live Orchestrator run of ACM-1 on acme\/widget: .*pushes a branch, opens a draft PR, updates Linear; merge manual/);
    expect(req.details.join("\n")).toMatch(/Permissions: push true, draft PR true, merge false/);
    expect(run.context.authorization).toMatchObject({ purpose: "live_run", scopeHash: hash, channel: "test", user: "tester" });
    expect(h.app.store.events(run.id).some((e) => e.type === "run.authorized")).toBe(true);
  });

  it("an approval is never reusable: every live run asks again", async () => {
    h = createHarness({ issues: [makeIssue({ key: "ACM-1" }), makeIssue({ key: "ACM-2" })] });
    await live({ issue: "ACM-1" });
    h.answer = false;
    await expect(live({ issue: "ACM-2" })).rejects.toMatchObject({ code: "approval_required" });
    expect(h.approvals.map((a) => a.issue)).toEqual(["ACM-1", "ACM-2"]);
    expect(h.app.store.runsFor("ACM-2")).toHaveLength(0);
  });

  it("binds approvals to issue, repository, config and permissions", () => {
    h = createHarness();
    const cfg = loadRepoConfigFile(h.configFile).config;
    const base = runScope({ issue: "ACM-1", config: cfg, configSource: h.configFile }).hash;
    expect(runScope({ issue: "acm-1", config: cfg, configSource: h.configFile }).hash).toBe(base);
    expect(runScope({ issue: "ACM-2", config: cfg, configSource: h.configFile }).hash).not.toBe(base);
    expect(runScope({ issue: "ACM-1", config: { ...cfg, repo: "acme/other" }, configSource: h.configFile }).hash).not.toBe(base);
    expect(runScope({ issue: "ACM-1", config: cfg, configSource: "/elsewhere.yaml" }).hash).not.toBe(base);
    expect(runScope({ issue: "ACM-1", config: { ...cfg, permissions: { ...cfg.permissions, github: { ...cfg.permissions.github, merge: true } } }, configSource: h.configFile }).hash).not.toBe(base);
    expect(runScope({ issue: "ACM-1", config: { ...cfg, limits: { ...cfg.limits, max_run_cost_usd: 999 } }, configSource: h.configFile }).hash).not.toBe(base);
    expect(runScope({ issue: "ACM-1", config: cfg, configSource: h.configFile, acceptedDependencies: ["ACM-0"] }).hash).not.toBe(base);
  });

  it("the prompt calls out automatic merging when the configuration grants it", () => {
    h = createHarness();
    const cfg = loadRepoConfigFile(h.configFile).config;
    expect(describeScope(runScope({ issue: "ACM-1", config: cfg, configSource: h.configFile }).scope).reason).toMatch(/; merge manual;/);
    const auto = { ...cfg, merge: { ...cfg.merge, mode: "auto" as const }, permissions: { ...cfg.permissions, github: { ...cfg.permissions.github, merge: true } } };
    expect(describeScope(runScope({ issue: "ACM-1", config: auto, configSource: h.configFile }).scope).reason).toMatch(/MERGES AUTOMATICALLY/);
  });

  it("repository permissions still apply: no live run where agents.run is not granted, and no prompt for it", async () => {
    h = createHarness({ config: { permissions: { agents: { run: false } } } });
    await expect(live()).rejects.toMatchObject({ code: "not_permitted" });
    expect(h.approvals).toHaveLength(0);
  });

  it("an approval does not widen repository permissions (push denied by config stays denied)", async () => {
    h = createHarness({ config: { permissions: { github: { push: false, create_pr: false } } } });
    const run = await live();
    expect(h.approvals).toHaveLength(1);
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/github\.push/);
    expect(h.host.prs).toHaveLength(0);
  });

  it.each([
    ["mode", "UPDATE runs SET mode = 'supervised'"],
    ["issue", "UPDATE runs SET issue_key = 'ACM-9'"],
  ])("a dry run whose stored %s is rewritten mid-drive gains no live effects and stops", async (_what, sql) => {
    h = createHarness();
    h.answer = false;
    let tampered = false;
    const run = await startRun(h.app, {
      issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: true, ciWaitMinutes: 0,
      onEvent: (e) => {
        // A full-access agent edits the store through its own connection while the dry run is driving.
        if (!tampered && e.type === "state.changed") {
          tampered = true;
          const db = new DatabaseSync(h.app.paths.db);
          db.exec(sql);
          db.close();
        }
      },
    });
    expect(tampered).toBe(true);
    expect(run.state).toBe("FAILED");
    expect(run.reason).toMatch(/run identity changed in the store during the drive/);
    expect(h.approvals).toHaveLength(0);
    expect(h.implementer.calls).toHaveLength(0);
    expect(h.host.prs).toHaveLength(0);
    expect(git(h.origin, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    expect(h.app.store.events(run.id).some((e) => e.type === "safety.violation")).toBe(true);
  });

  it("ORCHESTRATOR_NO_EXECUTE refuses before asking anyone", async () => {
    h = createHarness();
    h.app.env.ORCHESTRATOR_NO_EXECUTE = "1";
    await expect(live()).rejects.toMatchObject({ code: "execution_disabled" });
    expect(h.approvals).toHaveLength(0);
  });
});

describe("resuming live runs", () => {
  it("asks again on every resume; a refusal leaves the run untouched", async () => {
    h = createHarness();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const run = await live();
    expect(run.state).toBe("WAITING_FOR_CI");
    h.answer = false;
    await expect(resumeRun(h.app, run.id, { ciWaitMinutes: 0 })).rejects.toMatchObject({ code: "approval_required" });
    const after = h.app.store.getRun<RunContext>(run.id)!;
    expect([after.state, after.version]).toEqual([run.state, run.version]);
    h.answer = true;
    expect((await resumeRun(h.app, run.id, { ciWaitMinutes: 0 })).state).toBe("WAITING_FOR_CI");
    expect(h.approvals.map((a) => a.purpose)).toEqual(["live_run", "resume_live_run", "resume_live_run"]);
  });

  it("a forged or copied approval record in the store is not accepted as consent", async () => {
    h = createHarness({ issues: [makeIssue({ key: "ACM-1" }), makeIssue({ key: "ACM-2" })] });
    const approved = await live({ issue: "ACM-1" });
    // An agent with file access writes a supervised run for another issue, with the first run's
    // approval (or a correctly recomputed hash) copied into it, then asks to resume it.
    const forged = h.app.store.createRun<RunContext>({
      id: "acm-2-forged",
      issueKey: "ACM-2",
      repo: "acme/widget",
      mode: "supervised",
      context: { ...approved.context, rounds: [], authorization: { ...approved.context.authorization!, scopeHash: runScope({ issue: "ACM-2", config: loadRepoConfigFile(h.configFile).config, configSource: h.configFile }).hash } },
    });
    h.answer = false;
    await expect(resumeRun(h.app, forged.id, { ciWaitMinutes: 0 })).rejects.toMatchObject({ code: "approval_required" });
    expect(h.app.store.getRun(forged.id)!.state).toBe("QUEUED");
    expect(h.implementer.calls).toHaveLength(1); // only the approved run's
    expect(h.approvals.at(-1)).toMatchObject({ purpose: "resume_live_run", issue: "ACM-2" });
  });

  it("dry-run resumes never ask", async () => {
    h = createHarness({ issues: [makeIssue({ key: "ACM-1", blockedBy: [{ key: "ACM-0", title: "x", state: { name: "Todo", type: "unstarted" } }] })] });
    const run = await live({ dryRun: true });
    expect(run.state).toBe("BLOCKED");
    h.answer = false;
    expect((await resumeRun(h.app, run.id)).state).toBe("BLOCKED");
    expect(h.approvals).toHaveLength(0);
  });
});

describe("repository authorization and associations also need a person", () => {
  function pending(): void {
    buildProposal({
      repo: "acme/fresh",
      inspection: { root: "/r", headSha: "x", packageManager: "pnpm@10", scripts: { test: "vitest" }, workspaces: [], ciWorkflows: [], guidanceFiles: [], topLevel: ["package.json"], nodeEngine: null, nodeVersionFile: null },
      teams: ["ACM"],
      agentsAvailable: { claude: true, codex: true },
      paths: h.app.paths,
    });
  }

  it("repo authorize writes nothing without approval, and grants after it", async () => {
    h = createHarness();
    pending();
    h.answer = false;
    await expect(authorizeRepository(h.app, "acme/fresh")).rejects.toMatchObject({ code: "approval_required" });
    expect(existsSync(localConfigFile(h.app.paths, "acme/fresh"))).toBe(false);
    h.answer = true;
    const r = await authorizeRepository(h.app, "acme/fresh");
    expect(existsSync(r.file)).toBe(true);
    expect(h.approvals.map((a) => [a.purpose, a.repo])).toEqual([
      ["authorize_repository", "acme/fresh"],
      ["authorize_repository", "acme/fresh"],
    ]);
  });

  it("repo authorize writes what the person was shown, even if the proposal is swapped while the prompt is open", async () => {
    h = createHarness();
    pending();
    const file = proposalFile(h.app.paths, "acme/fresh");
    const original = parseYaml(readFileSync(file, "utf8")) as { permissions: { github: { merge: boolean } }; merge: { mode: string } };
    h.answer = (req) => {
      // A full-access agent rewrites the pending proposal during the prompt to grant itself merge.
      writeFileSync(file, stringify({ ...original, permissions: { ...original.permissions, github: { ...original.permissions.github, merge: true } } }));
      expect(req.reason).toMatch(new RegExp(`merge ${original.merge.mode}`));
      expect(req.reason).not.toMatch(/MERGE/);
      return true;
    };
    const r = await authorizeRepository(h.app, "acme/fresh");
    const written = loadRepoConfigFile(r.file).config;
    expect(written.permissions.github.merge).toBe(original.permissions.github.merge);
    expect(written.authorization?.proposal_sha256).toBe(r.sha256);
  });

  it("repo authorize shows the merge permission a proposal actually grants", async () => {
    h = createHarness();
    pending();
    const file = proposalFile(h.app.paths, "acme/fresh");
    const raw = parseYaml(readFileSync(file, "utf8")) as { permissions: { github: { merge: boolean } } };
    raw.permissions.github.merge = true;
    writeFileSync(file, stringify(raw));
    h.answer = false;
    await expect(authorizeRepository(h.app, "acme/fresh")).rejects.toMatchObject({ code: "approval_required" });
    expect(h.approvals[0]!.reason).toMatch(/MERGE/);
    expect(h.approvals[0]!.details.join("\n")).toMatch(/merge true/);
  });

  it("associate persists nothing without approval", async () => {
    h = createHarness();
    h.answer = false;
    await expect(confirmAssociation(h.app, { issue: "ACM-7", repo: "acme/widget", workspace: null })).rejects.toMatchObject({ code: "approval_required" });
    expect(existsSync(join(h.home, "associations.json"))).toBe(false);
  });

  it("after authorization, the natural-language flow sees an executable repository", async () => {
    h = createHarness({ issues: [makeIssue({ key: "ACM-1", url: "https://linear.app/mock-workspace/issue/ACM-1", attachments: [{ title: "r", url: "https://github.com/acme/widget" }] })] });
    mkdirSync(join(h.home, "repos", "acme"), { recursive: true });
    copyFileSync(h.configFile, join(h.home, "repos", "acme", "widget.yaml"));
    const cwd = join(h.root, "project");
    mkdirSync(cwd);
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "remote", "add", "origin", "git@github.com:acme/widget.git");
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", cwd });
    expect(ctx.problems).toEqual([]);
    const supervised = ctx.modes.find((m) => m.id === "supervised")!;
    expect(supervised.available).toBe(true);
    expect(ctx.nextActions.find((a) => a.id === "execute")).toMatchObject({ needsUserApproval: true, description: expect.stringMatching(/Touch ID \/ password/) });
  });
});

describe("the real CLI binary", () => {
  const cli = join(PACKAGE_ROOT, "bin", "orchestrator.js");
  let scratch: string;
  afterEach(() => scratch && rmSync(scratch, { recursive: true, force: true }));

  function setup(extraEnv: Record<string, string> = {}) {
    scratch = mkdtempSync(join(tmpdir(), "orch-cli-auth-"));
    const config = join(scratch, "widget.yaml");
    writeFileSync(
      config,
      stringify({
        repo: "acme/widget",
        linear: { teams: ["ACM"] },
        checks: [{ name: "t", run: "true" }],
        agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } },
        permissions: { agents: { run: true }, github: { push: true, create_pr: true } },
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, ORCHESTRATOR_HOME: join(scratch, "home"), ...extraEnv };
    delete env.LINEAR_API_KEY;
    delete env.LINEAR_API_KEY_FILE;
    return { config, env };
  }

  /**
   * Run the CLI exactly as an agent would, but where no person can answer: on macOS the system
   * prompt is made unavailable (osascript may not execute), elsewhere there is no controlling tty.
   */
  function runCli(args: string[], env: NodeJS.ProcessEnv) {
    const argv = process.platform === "darwin" ? ["/usr/bin/sandbox-exec", ["-p", '(version 1)(allow default)(deny process-exec (literal "/usr/bin/osascript"))', process.execPath, cli, ...args]] : ["setsid", [process.execPath, cli, ...args]];
    return spawnSync(argv[0] as string, argv[1] as string[], { env, encoding: "utf8", timeout: 120_000, cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  }

  it("`run --execute` from an agent shell cannot start a live run without a person", () => {
    const { config, env } = setup();
    const r = runCli(["run", "ACM-1", "--repo", "acme/widget", "--config", config, "--execute", "--json"], env);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as { kind: string; data: { code: string; message: string } };
    expect(out).toMatchObject({ kind: "error", data: { code: "approval_required" } });
    expect(out.data.message).toMatch(/Nothing was started or changed/);
    expect(r.stderr).toMatch(/Approval needed to start a live Orchestrator run of ACM-1 on acme\/widget/);
    const audit = readFileSync(join(env.ORCHESTRATOR_HOME!, "audit", "approvals.jsonl"), "utf8");
    expect(JSON.parse(audit.trim())).toMatchObject({ purpose: "live_run", approved: false });
    const status = JSON.parse(runCli(["status", "--json"], env).stdout) as { data: unknown[] };
    expect(status.data).toEqual([]);
  });

  it.each([["--yes"], ["--approved"], ["--confirm"], ["--approve"]])("there is no %s flag to skip the approval", (flag) => {
    const { config, env } = setup();
    const r = runCli(["run", "ACM-1", "--repo", "acme/widget", "--config", config, "--execute", flag], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/);
  });

  it("ORCHESTRATOR_NO_EXECUTE=1 refuses unconditionally", () => {
    const { config, env } = setup({ ORCHESTRATOR_NO_EXECUTE: "1" });
    const r = runCli(["run", "ACM-1", "--repo", "acme/widget", "--config", config, "--execute", "--json"], env);
    expect(JSON.parse(r.stdout)).toMatchObject({ data: { code: "execution_disabled" } });
    expect(existsSync(join(env.ORCHESTRATOR_HOME!, "audit", "approvals.jsonl"))).toBe(false);
  });
});
