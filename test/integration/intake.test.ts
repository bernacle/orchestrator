import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { IntakeError, startRun } from "../../src/app.js";
import { saveAssociation } from "../../src/intake/association.js";
import { inspectRequest, publicContext } from "../../src/intake/context.js";
import { resumableRun, reviewedRun, runsForTarget } from "../../src/intake/targets.js";
import { reviewFindings, summarizeRun } from "../../src/report/summary.js";
import { approve, createHarness, git, requestChanges, type Harness } from "../helpers.js";

/**
 * The install-once flow: a request names an issue (key or URL) from inside some project checkout;
 * the engine identifies the repository from the working directory, checks configuration,
 * association and existing runs, and only then creates a run. Real git, mocked Linear/GitHub/agents.
 */

let h: Harness;
afterEach(() => h?.cleanup());

/** A project checkout (the "T3 session" directory) whose origin is the GitHub repository. */
function projectCheckout(remote = "git@github.com:acme/widget.git"): string {
  const dir = join(h.root, "project");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# widget\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", remote);
  return dir;
}

/** Put the harness config where an operator-owned config lives, so discovery finds it. */
function authorize(): void {
  mkdirSync(join(h.home, "repos", "acme"), { recursive: true });
  copyFileSync(h.configFile, join(h.home, "repos", "acme", "widget.yaml"));
}

const linked = (issueKey = "ACM-1") => makeIssue({ key: issueKey, url: `https://linear.app/mock-workspace/issue/${issueKey}`, attachments: [{ title: "Repo", url: "https://github.com/acme/widget" }] });

describe("request intake from a project directory", () => {
  it("first use: an unknown repository needs a proposal and authorization; no run is created", async () => {
    h = createHarness({ issues: [linked()] });
    const cwd = projectCheckout("git@github.com:acme/brand-new.git");
    const ctx = publicContext(await inspectRequest(h.app, { issueRef: "ACM-1", cwd }));
    expect(ctx.repository).toMatchObject({ status: "resolved", repo: "acme/brand-new", source: "cwd" });
    expect(ctx.configuration.status).toBe("missing");
    expect(ctx.problems.map((p) => p.code)).toEqual(["needs_configuration"]);
    expect(ctx.nextActions.map((a) => [a.id, a.needsUserApproval])).toEqual([
      ["propose_configuration", false],
      ["authorize_repository", true],
    ]);
    expect(ctx.modes.find((m) => m.id === "supervised")!.available).toBe(false);
    await expect(startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true })).rejects.toMatchObject({ code: "needs_configuration" });
    expect(h.app.store.listRuns()).toHaveLength(0);
  });

  it("an authorized repository but no evidence that the issue belongs to it: stop and ask", async () => {
    h = createHarness();
    authorize();
    const cwd = projectCheckout();
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", cwd });
    expect(ctx.association).toMatchObject({ verified: false });
    expect(ctx.problems.map((p) => p.code)).toEqual(["association_unverified"]);
    expect(ctx.nextActions[0]).toMatchObject({ id: "confirm_association", needsUserApproval: true });
    await expect(startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true })).rejects.toBeInstanceOf(IntakeError);

    // Once the operator confirms, the confirmation is reused.
    saveAssociation(h.app.paths, { tracker: "linear", issue: "ACM-1", repo: "acme/widget", workspace: null });
    const run = await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true });
    expect(run.state).toBe("COMPLETED");
    expect(run.context.options.intake).toMatchObject({ source: "cwd", association: { verified: true, evidence: [expect.objectContaining({ kind: "confirmed" })] } });
  });

  it("issue URL from a nested directory → dry run on the discovered repository, with a JSON summary", async () => {
    h = createHarness({ issues: [linked()] });
    authorize();
    const cwd = projectCheckout();
    mkdirSync(join(cwd, "src", "deep"), { recursive: true });
    const run = await startRun(h.app, { issueKey: "https://linear.app/mock-workspace/issue/ACM-1/add-a-feature", cwd: join(cwd, "src", "deep"), dryRun: true });
    expect(run).toMatchObject({ issueKey: "ACM-1", repo: "acme/widget", mode: "dry_run", state: "COMPLETED" });
    expect(run.context.options.intake).toMatchObject({ linearWorkspace: "mock-workspace", association: { evidence: [expect.objectContaining({ kind: "issue_link" })] } });
    const summary = summarizeRun(h.app.store, run);
    expect(summary).toMatchObject({ id: run.id, issue: { key: "ACM-1", title: "Add a feature" }, state: "COMPLETED", pr: null, review: null });
    expect(summary.planPath).toMatch(/plan\.md$/);
    expect(h.implementer.calls).toHaveLength(0);
    expect(h.host.prs).toHaveLength(0);
  });

  it("refuses an issue URL from another Linear workspace than the repository's", async () => {
    h = createHarness({ issues: [linked()] });
    authorize();
    const cwd = projectCheckout();
    await expect(startRun(h.app, { issueKey: "https://linear.app/someone-else/issue/ACM-1", cwd, dryRun: true })).rejects.toMatchObject({ code: "workspace_mismatch" });
  });

  it("a repository without a GitHub remote stops with an actionable error", async () => {
    h = createHarness({ issues: [linked()] });
    const cwd = projectCheckout("/srv/git/widget.git");
    await expect(startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true })).rejects.toMatchObject({ code: "repository_unresolved", message: expect.stringMatching(/no GitHub remote.*--repo/) });
  });

  it("an explicit --repo still works from an unrelated directory (warning only)", async () => {
    h = createHarness();
    const cwd = projectCheckout("git@github.com:acme/other.git");
    const warnings: string[] = [];
    const run = await startRun(h.app, { issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, cwd, dryRun: true, onEvent: (e) => (e.type === "intake.warning" ? warnings.push(e.message) : undefined) });
    expect(run.state).toBe("COMPLETED");
    expect(warnings[0]).toMatch(/belongs to acme\/other, not acme\/widget/);
    expect(run.context.options.intake?.source).toBe("explicit");
  });

  it("ORCHESTRATOR_NO_EXECUTE refuses live runs and supervised resumes, not dry runs", async () => {
    h = createHarness({ issues: [linked()] });
    authorize();
    const cwd = projectCheckout();
    h.app.env.ORCHESTRATOR_NO_EXECUTE = "1";
    await expect(startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: false })).rejects.toMatchObject({ code: "execution_disabled" });
    expect((await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true })).state).toBe("COMPLETED");
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", cwd });
    expect(ctx.modes.find((m) => m.id === "supervised")!.missing.join()).toMatch(/ORCHESTRATOR_NO_EXECUTE/);
  });
});

describe("live runs started from a T3-style linked worktree", () => {
  it("runs in the orchestrator's own worktree and leaves the session's worktree and its uncommitted changes alone", async () => {
    h = createHarness({ issues: [linked()] });
    authorize();
    const main = projectCheckout();
    const session = join(h.root, "t3-worktree");
    git(main, "worktree", "add", "-q", "-b", "t3/session", session);
    writeFileSync(join(session, "wip.txt"), "uncommitted user work\n");
    const branchesBefore = git(main, "for-each-ref", "--format=%(refname)");

    const run = await startRun(h.app, { issueKey: "ACM-1", cwd: session, dryRun: false, ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.options.intake).toMatchObject({ source: "cwd", linkedWorktree: true });
    expect(run.context.worktreePath!.startsWith(join(h.home, "worktrees"))).toBe(true);
    expect(git(session, "status", "--porcelain")).toBe("?? wip.txt");
    expect(readFileSync(join(session, "wip.txt"), "utf8")).toBe("uncommitted user work\n");
    expect(git(main, "for-each-ref", "--format=%(refname)")).toBe(branchesBefore);
    expect(h.host.merges).toHaveLength(0);
  });
});

describe("existing runs", () => {
  it("prevents a duplicate live run, offers status and resume, and resolves runs by issue", async () => {
    let reviews = 0;
    h = createHarness({
      issues: [linked()],
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hi\n" : "hello\n");
        return {};
      },
      review: () => ({ structured: ++reviews === 1 ? requestChanges() : approve }),
    });
    authorize();
    const cwd = projectCheckout();
    const first = await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: false, ciWaitMinutes: 0 });
    expect(first.state).toBe("READY_TO_MERGE"); // manual merge: still active

    await expect(startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: false })).rejects.toMatchObject({ code: "active_run_exists", message: expect.stringMatching(/already has an active run/) });
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", cwd });
    expect(ctx.runs.active.map((r) => r.id)).toEqual([first.id]);
    expect(ctx.nextActions.map((a) => a.id)).toEqual(["inspect_run", "resume_run"]);
    expect(ctx.nextActions[1]).toMatchObject({ needsUserApproval: true, command: expect.stringContaining(`resume ${first.id}`) });
    // A dry run beside it is allowed: it changes nothing.
    expect((await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true })).mode).toBe("dry_run");

    // "resume BRU-488" picks the live run, not the newer dry run.
    expect((await resumableRun(h.app, "ACM-1", { cwd })).id).toBe(first.id);
    expect((await runsForTarget(h.app, "acm-1", { cwd })).runs).toHaveLength(2);

    // Review findings come from the engine's record.
    const reviewed = await reviewedRun(h.app, "ACM-1", { cwd });
    const findings = reviewFindings(reviewed);
    expect(findings.rounds[0]!.findings[0]).toMatchObject({ severity: "major", title: "Missing greeting" });
    expect(findings.rounds.map((r) => r.approved)).toEqual([false, true]);
    expect(summarizeRun(h.app.store, reviewed)).toMatchObject({ review: { approved: true }, pr: { number: expect.any(Number) } });
  });

  it("refuses to guess between several resumable runs", async () => {
    h = createHarness({ issues: [{ ...linked(), blockedBy: [{ key: "ACM-0", title: "x", state: { name: "Todo", type: "unstarted" } }] }] });
    authorize();
    const cwd = projectCheckout();
    await expect(resumableRun(h.app, "ACM-1", { cwd })).rejects.toThrow(/no resumable run/);
    // Two blocked dry runs: ambiguous.
    await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true });
    await startRun(h.app, { issueKey: "ACM-1", cwd, dryRun: true });
    await expect(resumableRun(h.app, "ACM-1", { cwd })).rejects.toThrow(/several runs/);
  });
});

