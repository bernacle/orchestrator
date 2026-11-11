import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { repositoryTrust, resumeRun, startRun, trustRepository, untrustRepository } from "../../src/app.js";
import { loadRepoConfigFile, PACKAGE_ROOT } from "../../src/config/load.js";
import { runScope } from "../../src/core/approval.js";
import { trustScope, type TrustRecord } from "../../src/core/trust.js";
import type { RunContext } from "../../src/core/workflow.js";
import { inspectRequest } from "../../src/intake/context.js";
import { createHarness, git, requestChanges, type Harness } from "../helpers.js";

/**
 * Trusted-repository mode: an operator-approved, per-repository delegation that lets live runs and
 * resumes start without a per-run prompt. Everything else (permissions, budgets, sandbox, review,
 * manual merge, ORCHESTRATOR_NO_EXECUTE) must hold exactly as in a supervised run, and nothing but
 * `trustRepository` after a person's approval may create trust.
 */

let h: Harness;
afterEach(() => h?.cleanup());

/** Operator-owned config location (what `repo trust` and a run without --config resolve to). */
const operatorConfig = () => join(h.home, "repos", "acme", "widget.yaml");
function install(patch?: Record<string, unknown>): void {
  if (patch) h.writeConfig(patch);
  mkdirSync(join(h.home, "repos", "acme"), { recursive: true });
  copyFileSync(h.configFile, operatorConfig());
}
const live = (over: { issue?: string; requireApproval?: boolean; acceptDependencies?: string[]; repo?: string } = {}) =>
  startRun(h.app, { issueKey: over.issue ?? "ACM-1", repo: over.repo ?? "acme/widget", dryRun: false, ciWaitMinutes: 0, ...(over.requireApproval ? { requireApproval: true } : {}), ...(over.acceptDependencies ? { acceptDependencies: over.acceptDependencies } : {}) });
const trustFile = (repo = "acme/widget") => {
  const [owner, name] = repo.split("/");
  return join(h.home, "trust", owner!, `${name}.json`);
};
const keyFile = (repo = "acme/widget") => join(h.home, "credentials", "trust", `${repo.replace("/", "__")}.key`);
const purposes = () => h.approvals.map((a) => a.purpose);
const audit = () => readFileSync(join(h.home, "audit", "approvals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

async function trusted(): Promise<TrustRecord> {
  const r = await trustRepository(h.app, "acme/widget");
  expect(r.state).toBe("trusted");
  return r.record;
}

describe("supervised stays the default", () => {
  it("an untrusted repository asks for every live run, and context says so", async () => {
    h = createHarness();
    install();
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget" });
    expect(ctx.trust).toMatchObject({ mode: "supervised", status: "untrusted" });
    expect(ctx.modes.find((m) => m.id === "supervised")).toMatchObject({ authorization: "per_run_approval" });
    expect(ctx.nextActions.find((a) => a.id === "execute")).toMatchObject({ needsUserApproval: true });
    const run = await live();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(purposes()).toEqual(["live_run"]);
    expect(run.context.authorization).toMatchObject({ basis: "approval", channel: "test" });
  });
});

describe("enabling trust needs the operator", () => {
  it("a refused prompt writes no record and no key, and live runs keep asking", async () => {
    h = createHarness();
    install();
    h.answer = false;
    await expect(trustRepository(h.app, "acme/widget")).rejects.toMatchObject({ code: "approval_required" });
    expect(existsSync(trustFile())).toBe(false);
    expect(existsSync(keyFile())).toBe(false);
    await expect(live()).rejects.toMatchObject({ code: "approval_required" });
    expect(purposes()).toEqual(["trust_repository", "live_run"]);
    expect(h.app.store.listRuns()).toHaveLength(0);
  });

  it("the one-time prompt names the repository and exactly what is delegated, and what never is", async () => {
    h = createHarness();
    install();
    await trusted();
    const req = h.approvals[0]!;
    expect(req).toMatchObject({ purpose: "trust_repository", repo: "acme/widget", issue: null, scopeHash: trustScope(loadRepoConfigFile(operatorConfig())).hash });
    expect(req.reason).toMatch(/^trust acme\/widget for Orchestrator live runs and resumes WITHOUT asking you each time: .*pushes branches, opens draft PRs, updates Linear; never merges; budget \$25/);
    const details = req.details.join("\n");
    expect(details).toMatch(/Repository: +acme\/widget \(only this repository\)/);
    expect(details).toContain(`Config:      ${operatorConfig()}`);
    expect(details).toMatch(/Delegated: +start and resume live runs with: agent runs true, push true, draft PR true, Linear comment true/);
    expect(details).toMatch(/Never: +merge \(not granted; merge.mode manual\), new permissions, accepted dependencies, new time windows, repository authorization/);
  });

  it("a hand-written or edited trust file grants nothing", async () => {
    h = createHarness();
    install();
    const { scope, hash } = trustScope(loadRepoConfigFile(operatorConfig()));
    mkdirSync(join(h.home, "trust", "acme"), { recursive: true });
    // An agent writes a plausible record (correct scope and hash, made-up seal) …
    writeFileSync(trustFile(), JSON.stringify({ version: 1, id: "x", repo: "acme/widget", scopeHash: hash, scope, trustedBy: "tester", trustedAt: new Date().toISOString(), channel: "macos-local-authentication", detail: "", seal: "0".repeat(64) }));
    expect(repositoryTrust(h.app, "acme/widget").state).toMatchObject({ status: "invalid", problem: expect.stringMatching(/no seal key/) });
    // … and even with a key file of its own, the seal must verify.
    mkdirSync(join(h.home, "credentials", "trust"), { recursive: true });
    writeFileSync(keyFile(), "ab".repeat(32));
    expect(repositoryTrust(h.app, "acme/widget").state).toMatchObject({ status: "invalid", problem: expect.stringMatching(/seal does not verify/) });
    h.answer = false;
    await expect(live()).rejects.toMatchObject({ code: "approval_required" });
    h.answer = true;
    const run = await live();
    expect(run.context.authorization?.basis).toBe("approval");
    expect(h.approvals.at(-1)!.details.join("\n")).toMatch(/Trust: +trust record ignored: .*seal does not verify/);
  });

  it("an approved trust record whose scope is edited to match a wider config no longer verifies", async () => {
    h = createHarness();
    install();
    await trusted();
    install({ limits: { max_run_cost_usd: 500 } });
    const record = JSON.parse(readFileSync(trustFile(), "utf8")) as TrustRecord;
    const wider = trustScope(loadRepoConfigFile(operatorConfig()));
    writeFileSync(trustFile(), JSON.stringify({ ...record, scope: wider.scope, scopeHash: wider.hash }));
    expect(repositoryTrust(h.app, "acme/widget").state?.status).toBe("invalid");
    await live();
    expect(purposes()).toEqual(["trust_repository", "live_run"]);
  });

  it("refuses to trust a configuration that grants merging or turns off the sandbox, review or draft PRs, without asking", async () => {
    for (const patch of [
      { permissions: { github: { merge: true } } },
      { isolation: { require: false } },
      { review: { require_distinct_provider: false } },
      { pull_request: { draft: false } },
      { permissions: { agents: { run: false } } },
    ]) {
      h = createHarness();
      install(patch);
      await expect(trustRepository(h.app, "acme/widget")).rejects.toMatchObject({ code: "not_trustable" });
      expect(h.approvals).toHaveLength(0);
      expect(existsSync(trustFile())).toBe(false);
      h.cleanup();
    }
  });
});

describe("trusted repositories start and resume without per-run approval", () => {
  it("starts a live run with no prompt, records and audits the trust it used", async () => {
    h = createHarness();
    install();
    const rec = await trusted();
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget" });
    expect(ctx.trust).toMatchObject({ mode: "trusted", status: "trusted", trustedBy: "tester" });
    expect(ctx.nextActions.find((a) => a.id === "execute")).toMatchObject({ needsUserApproval: false, trusted: true });
    const run = await live();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(purposes()).toEqual(["trust_repository"]);
    const { hash } = runScope({ issue: "ACM-1", config: loadRepoConfigFile(operatorConfig()).config, configSource: operatorConfig() });
    expect(run.context.authorization).toMatchObject({ purpose: "live_run", basis: "trust", channel: "trusted-repository", scopeHash: hash, trust: { id: rec.id, trustedBy: "tester" } });
    expect(h.app.store.events(run.id).find((e) => e.type === "run.authorized")?.message).toMatch(/under repository trust/);
    expect(audit().at(-1)).toMatchObject({ purpose: "live_run", issue: "ACM-1", approved: true, channel: "trusted-repository" });
    // Merging stays manual: a PR was opened, nothing was merged.
    expect(h.host.prs).toHaveLength(1);
    expect(h.host.merges).toHaveLength(0);
  });

  it("resumes with no prompt, but keeps the run's time window; an approved resume grants a new one", async () => {
    h = createHarness();
    install();
    await trusted();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const run = await live();
    expect(run.state).toBe("WAITING_FOR_CI");
    const resumed = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(resumed.state).toBe("WAITING_FOR_CI");
    expect(purposes()).toEqual(["trust_repository"]);
    expect(resumed.context.authorization).toMatchObject({ purpose: "resume_live_run", basis: "trust" });
    expect(run.context.limitWindowStartedAt).toEqual(expect.any(String));
    expect(resumed.context.limitWindowStartedAt).toBe(run.context.limitWindowStartedAt);
    const approved = await resumeRun(h.app, run.id, { ciWaitMinutes: 0, requireApproval: true });
    expect(purposes()).toEqual(["trust_repository", "resume_live_run"]);
    expect(approved.context.authorization).toMatchObject({ basis: "approval" });
    expect(Date.parse(approved.context.limitWindowStartedAt!)).toBeGreaterThan(Date.parse(run.context.limitWindowStartedAt!));
  });

  it("--require-approval and operator-accepted dependencies always go to a person", async () => {
    h = createHarness({ issues: [makeIssue({ key: "ACM-1" }), makeIssue({ key: "ACM-2" })] });
    install();
    await trusted();
    h.answer = false;
    await expect(live({ requireApproval: true })).rejects.toMatchObject({ code: "approval_required" });
    await expect(live({ issue: "ACM-2", acceptDependencies: ["ACM-0"] })).rejects.toMatchObject({ code: "approval_required" });
    expect(purposes()).toEqual(["trust_repository", "live_run", "live_run"]);
    expect(h.approvals[2]!.details.join("\n")).toMatch(/Trust: +repository is trusted, but operator-accepted dependencies \(ACM-0\) always need a person/);
    expect(h.app.store.listRuns()).toHaveLength(0);
  });

  it("ORCHESTRATOR_NO_EXECUTE still refuses live runs and resumes in a trusted repository", async () => {
    h = createHarness();
    install();
    await trusted();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const run = await live();
    h.app.env.ORCHESTRATOR_NO_EXECUTE = "1";
    await expect(live({ issue: "ACM-1" })).rejects.toMatchObject({ code: "execution_disabled" });
    await expect(resumeRun(h.app, run.id)).rejects.toMatchObject({ code: "execution_disabled" });
    expect(h.app.store.listRuns()).toHaveLength(1);
  });
});

describe("trust is scoped to one repository and one configuration", () => {
  it("does not transfer to another repository, even when its record is copied there", async () => {
    h = createHarness();
    install();
    await trusted();
    // A second configured repository on the same machine.
    const other = join(h.home, "repos", "acme", "other.yaml");
    writeFileSync(other, readFileSync(operatorConfig(), "utf8").replace("repo: acme/widget", "repo: acme/other"));
    expect(repositoryTrust(h.app, "acme/other").state?.status).toBe("untrusted");
    copyFileSync(trustFile(), trustFile("acme/other"));
    copyFileSync(keyFile(), keyFile("acme/other"));
    expect(repositoryTrust(h.app, "acme/other").state).toMatchObject({ status: "invalid", problem: expect.stringMatching(/trust never transfers between repositories/) });
    expect(repositoryTrust(h.app, "acme/widget").state?.status).toBe("trusted");
  });

  it("a run from another config file (--config) is not covered", async () => {
    h = createHarness();
    install();
    await trusted();
    h.answer = false;
    await expect(startRun(h.app, { issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: false, ciWaitMinutes: 0 })).rejects.toMatchObject({ code: "approval_required" });
    expect(h.approvals.at(-1)!.details.join("\n")).toMatch(/Trust: +trust is stale \(changed since it was granted: configSource\)/);
  });

  it.each([
    ["a new permission", { permissions: { linear: { update_state: true } } }, "permissions"],
    ["a narrowed permission", { permissions: { linear: { comment: false } } }, "permissions"],
    ["a larger budget", { limits: { max_run_cost_usd: 500 } }, "limits"],
    ["a different implementer", { agents: { implementer: { adapter: "mock", provider: "anthropic-mock", timeout_minutes: 9 } } }, "agents"],
    ["wider sandbox reads", { isolation: { read_paths: ["/opt/extra"] } }, "isolation"],
    ["fewer forbidden paths", { forbidden_paths: [".env"] }, "forbiddenPaths"],
  ])("%s makes trust stale: the run asks again until trust is renewed", async (_what, patch, field) => {
    h = createHarness();
    install();
    await trusted();
    install(patch);
    expect(repositoryTrust(h.app, "acme/widget").state).toMatchObject({ status: "stale", changed: [field] });
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget" });
    expect(ctx.trust).toMatchObject({ mode: "supervised", status: "stale", renew: expect.stringMatching(/repo trust acme\/widget$/) });
    h.answer = false;
    await expect(live()).rejects.toMatchObject({ code: "approval_required" });
    expect(h.approvals.at(-1)!.details.join("\n")).toMatch(new RegExp(`Trust: +trust is stale \\(changed since it was granted: ${field}\\)`));
    // Renewing asks again, and then covers the new scope.
    h.answer = true;
    await trustRepository(h.app, "acme/widget");
    expect(h.approvals.at(-1)).toMatchObject({ purpose: "trust_repository", reason: expect.stringMatching(/^renew trust acme\/widget/) });
    const n = h.approvals.length;
    await live();
    expect(h.approvals).toHaveLength(n);
  });

  it("a config that gains merge permission after trust stops being trusted, and the prompt names merging", async () => {
    h = createHarness();
    install();
    await trusted();
    install({ permissions: { github: { merge: true } } });
    expect(repositoryTrust(h.app, "acme/widget").state).toMatchObject({ status: "stale", problems: [expect.stringMatching(/grants merging/)] });
    h.answer = false;
    await expect(live()).rejects.toMatchObject({ code: "approval_required" });
    expect(h.approvals.at(-1)!.details.join("\n")).toMatch(/merge true/);
    await expect(trustRepository(h.app, "acme/widget")).rejects.toMatchObject({ code: "not_trustable" });
  });

  it("untrust revokes at once; a restored copy of the old record stays dead, and re-trusting rotates the key", async () => {
    h = createHarness();
    install();
    await trusted();
    const saved = readFileSync(trustFile(), "utf8");
    expect(untrustRepository(h.app, "acme/widget")).toBe(true);
    expect(existsSync(trustFile())).toBe(false);
    expect(existsSync(keyFile())).toBe(false);
    writeFileSync(trustFile(), saved);
    expect(repositoryTrust(h.app, "acme/widget").state?.status).toBe("invalid");
    h.answer = false;
    await expect(live()).rejects.toMatchObject({ code: "approval_required" });
    // A new trust: the earlier record does not verify under the new key.
    h.answer = true;
    await trustRepository(h.app, "acme/widget");
    const fresh = readFileSync(trustFile(), "utf8");
    writeFileSync(trustFile(), saved);
    expect(repositoryTrust(h.app, "acme/widget").state?.status).toBe("invalid");
    writeFileSync(trustFile(), fresh);
    expect(repositoryTrust(h.app, "acme/widget").state?.status).toBe("trusted");
    const log = readFileSync(join(h.home, "audit", "trust.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string });
    expect(log.map((e) => e.action)).toEqual(["trust", "untrust", "trust"]);
  });
});

describe("protections still apply in a trusted repository", () => {
  it("repository permissions: push denied by the config stays denied", async () => {
    h = createHarness();
    install({ permissions: { github: { push: false, create_pr: false } } });
    await trusted();
    const run = await live();
    expect(purposes()).toEqual(["trust_repository"]);
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/github\.push/);
    expect(h.host.prs).toHaveLength(0);
    expect(git(h.origin, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  it("budget: a run that spent its budget stays blocked on a trusted resume", async () => {
    h = createHarness({
      implement: (task) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return { text: "done", costUsd: 30 };
      },
      review: () => ({ structured: requestChanges(), text: "" }),
    });
    install();
    await trusted();
    const run = await live();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/run cost limit reached/);
    const resumed = await resumeRun(h.app, run.id);
    expect(resumed.state).toBe("BLOCKED");
    expect(resumed.reason).toMatch(/run cost limit reached/);
    expect(h.implementer.calls).toHaveLength(1);
    expect(purposes()).toEqual(["trust_repository"]);
  });

  it("independent review: changes requested are fixed before any PR, and the reviewer still decides", async () => {
    let call = 0;
    h = createHarness({
      implement: (task, n) => {
        writeFileSync(join(task.cwd, "feature.txt"), `hello ${n}\n`);
        return { text: "done" };
      },
      review: () => (++call === 1 ? { structured: requestChanges(), text: "" } : { structured: { verdict: "approve", summary: "ok", findings: [] }, text: "" }),
    });
    install();
    await trusted();
    const run = await live();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.reviewer.calls).toHaveLength(2);
    expect(h.implementer.calls).toHaveLength(2);
    expect(h.host.merges).toHaveLength(0);
  });
});

describe("existing durable runs", () => {
  it("a run approved before trusted mode existed (no basis recorded) resumes under trust, and asks without it", async () => {
    h = createHarness();
    install();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const run = await live();
    // The shape of context.authorization written by earlier versions.
    const legacy = { purpose: "live_run", scopeHash: run.context.authorization!.scopeHash, approvedAt: "2026-11-01T00:00:00.000Z", channel: "macos-local-authentication", user: "tester", detail: "confirmed" };
    h.app.store.patchContext<RunContext>(run.id, { authorization: legacy });
    h.answer = false;
    await expect(resumeRun(h.app, run.id, { ciWaitMinutes: 0 })).rejects.toMatchObject({ code: "approval_required" });
    h.answer = true;
    await trusted();
    const resumed = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(resumed.state).toBe("WAITING_FOR_CI");
    expect(resumed.context.authorization).toMatchObject({ basis: "trust" });
    expect(purposes()).toEqual(["live_run", "resume_live_run", "trust_repository"]);
  });
});

describe("the real CLI binary", () => {
  const cli = join(PACKAGE_ROOT, "bin", "orchestrator.js");
  let scratch: string;
  afterEach(() => scratch && rmSync(scratch, { recursive: true, force: true }));

  function setup() {
    scratch = mkdtempSync(join(tmpdir(), "orch-cli-trust-"));
    const home = join(scratch, "home");
    mkdirSync(join(home, "repos", "acme"), { recursive: true });
    writeFileSync(
      join(home, "repos", "acme", "widget.yaml"),
      stringify({
        repo: "acme/widget",
        linear: { teams: ["ACM"] },
        checks: [{ name: "t", run: "true" }],
        agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } },
        permissions: { agents: { run: true }, github: { push: true, create_pr: true } },
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, ORCHESTRATOR_HOME: home };
    delete env.LINEAR_API_KEY;
    delete env.LINEAR_API_KEY_FILE;
    return { home, env };
  }

  /** As an agent would run it, where no person can answer (see authorization.test.ts). */
  function runCli(args: string[], env: NodeJS.ProcessEnv) {
    const argv = process.platform === "darwin" ? ["/usr/bin/sandbox-exec", ["-p", '(version 1)(allow default)(deny process-exec (literal "/usr/bin/osascript"))', process.execPath, cli, ...args]] : ["setsid", [process.execPath, cli, ...args]];
    return spawnSync(argv[0] as string, argv[1] as string[], { env, encoding: "utf8", timeout: 120_000, cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  }

  it("`repo trust` from an agent shell cannot enable trust without a person", () => {
    const { home, env } = setup();
    const r = runCli(["repo", "trust", "--repo", "acme/widget", "--json"], env);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ kind: "error", data: { code: "approval_required" } });
    expect(r.stderr).toMatch(/Approval needed to trust acme\/widget for Orchestrator live runs and resumes WITHOUT asking you each time/);
    expect(r.stderr).toMatch(/Never: +merge/);
    expect(existsSync(join(home, "trust"))).toBe(false);
    const status = JSON.parse(runCli(["repo", "trusted", "--json"], env).stdout) as { data: Array<{ repo: string; mode: string }> };
    expect(status.data).toEqual(expect.arrayContaining([expect.objectContaining({ repo: "acme/widget", mode: "supervised" })]));
  });

  it.each([["--yes"], ["--approved"], ["--confirm"], ["--force"], ["--no-prompt"]])("there is no %s flag that grants trust", (flag) => {
    const { home, env } = setup();
    const r = runCli(["repo", "trust", "--repo", "acme/widget", flag], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/);
    expect(existsSync(join(home, "trust"))).toBe(false);
  });

  it("a forged trust file does not let `run --execute` skip the prompt", () => {
    const { home, env } = setup();
    mkdirSync(join(home, "trust", "acme"), { recursive: true });
    writeFileSync(join(home, "trust", "acme", "widget.json"), JSON.stringify({ version: 1, repo: "acme/widget", trusted: true }));
    const r = runCli(["run", "ACM-1", "--repo", "acme/widget", "--execute", "--json"], env);
    expect(JSON.parse(r.stdout)).toMatchObject({ data: { code: "approval_required" } });
    expect(r.stderr).toMatch(/Trust: +trust record ignored/);
  });

  it("`repo untrust` needs no prompt and reports what it did", () => {
    const { env } = setup();
    const r = runCli(["repo", "untrust", "acme/widget", "--json"], env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ kind: "untrust", data: { repo: "acme/widget", removed: false } });
  });
});
