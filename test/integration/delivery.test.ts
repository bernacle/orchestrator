import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileRunById, startRun, watchRunById } from "../../src/app.js";
import { settleRun } from "../../src/core/settle.js";
import { hostName } from "../../src/core/store.js";
import type { RunContext } from "../../src/core/workflow.js";
import { inspectRequest } from "../../src/intake/context.js";
import { buildDeliveryReport } from "../../src/report/delivery.js";
import { createHarness, git, type Harness } from "../helpers.js";

let h: Harness;
afterEach(() => h?.cleanup());

const start = (dryRun = false) => startRun(h.app, { issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun, ciWaitMinutes: 0 });
const types = (id: string) => h.app.store.events(id).map((e) => e.type);
const report = (id: string) => buildDeliveryReport(h.app.store, h.app.store.getRun<RunContext>(id)!);

/** A person pushes a commit to the PR branch outside the engine. */
function pushOutsideCommit(branch: string): string {
  const tmp = join(h.root, "person");
  git(h.root, "clone", "-q", "--branch", branch, h.origin, tmp);
  writeFileSync(join(tmp, "feature.txt"), "hello from a person\n");
  git(tmp, "-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qam", "tweak by a person");
  git(tmp, "push", "-q", "origin", branch);
  return git(tmp, "rev-parse", "HEAD");
}

describe("merge reconciliation", () => {
  it("records a person's merge as MERGED → COMPLETED without a resume, an approval or any write to GitHub or git", async () => {
    h = createHarness();
    const delivered = await start();
    expect(delivered.state).toBe("READY_TO_MERGE");
    const approvals = h.approvals.length;
    const bodyUpdates = h.host.bodyUpdates.length;
    const branchHead = git(h.origin, "rev-parse", `refs/heads/${delivered.context.branch}`);

    await h.host.simulateMerge(1, { by: "bernacle" });
    const run = await reconcileRunById(h.app, delivered.id);

    expect(run.state).toBe("COMPLETED");
    expect(run.reason).toBe("merged");
    expect(run.context.merged).toMatchObject({ by: "bernacle", headIsReviewed: true, outsideCommits: [], recordedBy: "reconcile", headSha: delivered.context.reviewedSha });
    // Read-only: no approval asked, nothing pushed, merged, edited or driven.
    expect(h.approvals).toHaveLength(approvals);
    expect(h.host.bodyUpdates).toHaveLength(bodyUpdates);
    expect(h.host.merges).toHaveLength(0);
    expect(git(h.origin, "rev-parse", `refs/heads/${delivered.context.branch}`)).toBe(branchHead);
    expect(h.implementer.calls).toHaveLength(1);
    expect(types(run.id)).toContain("pr.merged");
    expect(types(run.id)).not.toContain("run.resume");
    const transitions = h.app.store.events(run.id).filter((e) => e.type === "state.changed" || e.type === "pr.merged").map((e) => `${e.type}:${e.state}`);
    expect(transitions.slice(-2)).toEqual(["pr.merged:MERGED", "state.changed:COMPLETED"]);
    expect(report(run.id).outcome).toBe("completed");
  });

  it("records commits a person added outside the engine before merging", async () => {
    h = createHarness();
    const delivered = await start();
    const outside = pushOutsideCommit(delivered.context.branch!);
    await h.host.simulateMerge(1);
    const run = await reconcileRunById(h.app, delivered.id);

    expect(run.state).toBe("COMPLETED");
    expect(run.reason).toBe("merged with 1 commit(s) added outside Orchestrator");
    expect(run.context.merged?.headIsReviewed).toBe(false);
    expect(run.context.merged?.headSha).toBe(outside);
    expect(run.context.merged?.outsideCommits).toEqual([{ sha: outside, message: "tweak by a person" }]);
    // The review history is untouched: the engine's record still names the commit it reviewed.
    expect(run.context.reviewedSha).toBe(delivered.context.reviewedSha);
    const r = report(run.id);
    expect(r.headline).toMatch(/1 commit\(s\) added outside Orchestrator after its review were merged too; Orchestrator did not review them/);
    expect(readFileSync(join(h.home, "runs", run.id, "delivery.md"), "utf8")).toContain("tweak by a person");
    expect(h.notes.at(-1)?.message).toMatch(/includes commits Orchestrator did not review/);
  });

  it("records a PR closed without merging as CANCELLED", async () => {
    h = createHarness();
    const delivered = await start();
    await h.host.simulateMerge(1, { close: true });
    const run = await reconcileRunById(h.app, delivered.id);
    expect(run.state).toBe("CANCELLED");
    expect(run.reason).toBe("PR #1 was closed without merging");
    expect(types(run.id)).toContain("pr.closed");
    expect(h.notes.at(-1)?.message).toMatch(/closed without merging/);
  });

  it("completes a blocked run whose PR a person merged anyway", async () => {
    h = createHarness();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const waiting = await start();
    expect(waiting.state).toBe("WAITING_FOR_CI");
    const outside = pushOutsideCommit(waiting.context.branch!);
    // The engine sees the unreviewed head and blocks.
    const { resumeRun } = await import("../../src/app.js");
    const blocked = await resumeRun(h.app, waiting.id, { ciWaitMinutes: 0 });
    expect(blocked.state).toBe("BLOCKED");
    await h.host.simulateMerge(1);
    const run = await reconcileRunById(h.app, blocked.id);
    expect(run.state).toBe("COMPLETED");
    expect(run.context.merged).toMatchObject({ headIsReviewed: false, headSha: outside });
  });

  it("leaves a run a process is driving to that process", async () => {
    h = createHarness();
    const delivered = await start();
    await h.host.simulateMerge(1);
    h.app.store.acquireLease(delivered.id, `${hostName()}:${process.pid}:driver`, 60_000);
    const run = await reconcileRunById(h.app, delivered.id);
    expect(run.state).toBe("READY_TO_MERGE");
  });

  it("finishes a record a crash left at MERGED", async () => {
    h = createHarness();
    const delivered = await start();
    h.app.store.transition<RunContext>(delivered.id, delivered.version, { to: "MERGED", reason: "PR #1 merged" });
    h.reopen();
    const run = await reconcileRunById(h.app, delivered.id);
    expect(run.state).toBe("COMPLETED");
  });

  it("context records a merge first, so the merged run no longer counts as active", async () => {
    h = createHarness();
    const delivered = await start();
    await h.host.simulateMerge(1);
    const ctx = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget", configFile: h.configFile });
    expect(ctx.problems.map((p) => p.code)).not.toContain("active_run_exists");
    expect(h.app.store.getRun(delivered.id)!.state).toBe("COMPLETED");
  });

  it("watch follows a delivered run until the merge, then returns", async () => {
    h = createHarness();
    const delivered = await start();
    setTimeout(() => void h.host.simulateMerge(1), 50);
    const { run, settled } = await watchRunById(h.app, delivered.id, { intervalMs: 20, timeoutMs: 10_000 });
    expect(settled).toBe(true);
    expect(run.state).toBe("COMPLETED");
  });

  it("watch gives up after its window without changing anything", async () => {
    h = createHarness();
    const delivered = await start();
    const { run, settled } = await watchRunById(h.app, delivered.id, { intervalMs: 20, timeoutMs: 100 });
    expect(settled).toBe(false);
    expect(run.state).toBe("READY_TO_MERGE");
  });
});

describe("merge records stay honest", () => {
  it("measures a merge against the last commit Orchestrator pushed, and says the PR was merged before delivery", async () => {
    let firstSha = "";
    h = createHarness({
      implement: (task, call) => {
        if (call === 3) return { ok: false, error: "agent crashed" };
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hello\n" : "hello again\n");
        return {};
      },
      // The CI fix is rejected by the reviewer: that commit stays local and is never pushed.
      review: (_t, n) => ({ structured: n === 1 ? { verdict: "approve", summary: "ok", findings: [], criteria: [] } : { verdict: "request_changes", summary: "no", findings: [{ id: "F1", severity: "major", file: null, line: null, title: "x", detail: "", suggestion: null, actionable: true }], criteria: [] } }),
    });
    const origCreate = h.host.createPullRequest.bind(h.host);
    h.host.createPullRequest = async (input) => {
      const pr = await origCreate(input);
      firstSha = pr.headSha;
      return pr;
    };
    h.host.ciScript = (pr) => [{ name: "CI", bucket: pr.headSha === firstSha ? "fail" : "pass" }];
    const blocked = await start();
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.context.reviewedSha).not.toBe(firstSha); // the rejected local commit

    await h.host.simulateMerge(1);
    const run = await reconcileRunById(h.app, blocked.id);
    expect(run.state).toBe("COMPLETED");
    // The merged head is exactly what Orchestrator approved and pushed: no invented outside commits.
    expect(run.context.merged).toMatchObject({ headSha: firstSha, reviewedSha: firstSha, headIsReviewed: true, delivered: false, stateAtMerge: "BLOCKED" });
    expect(run.reason).toBe("merged before delivery (the run was BLOCKED)");
    const r = report(run.id);
    expect(r.headline).toMatch(/merged before Orchestrator delivered it: the run was BLOCKED/);
    expect(r.headline).not.toMatch(/outside Orchestrator/);
    expect(h.notes.at(-1)?.message).toMatch(/merged before Orchestrator delivered it/);
  });

  it("says commits were added outside Orchestrator even when they cannot be listed", async () => {
    h = createHarness();
    const delivered = await start();
    pushOutsideCommit(delivered.context.branch!);
    h.host.compare = async () => {
      throw new Error("HTTP 404");
    };
    await h.host.simulateMerge(1);
    const run = await reconcileRunById(h.app, delivered.id);
    expect(run.state).toBe("COMPLETED");
    expect(run.context.merged?.outsideCommits).toBeNull();
    expect(run.reason).toBe("merged with commits added outside Orchestrator");
  });

  it("an unreachable GitHub never breaks context, and is logged once", async () => {
    h = createHarness();
    const delivered = await start();
    h.host.getPullRequest = async () => {
      throw new Error("fetch failed: ENOTFOUND api.github.com");
    };
    const first = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget", configFile: h.configFile });
    const second = await inspectRequest(h.app, { issueRef: "ACM-1", repo: "acme/widget", configFile: h.configFile });
    expect(first.problems.map((p) => p.code)).toContain("active_run_exists");
    expect(second.problems.map((p) => p.code)).toContain("active_run_exists");
    expect(h.app.store.getRun(delivered.id)!.state).toBe("READY_TO_MERGE");
    expect(types(delivered.id).filter((t) => t === "reconcile.failed")).toHaveLength(1);
  });

  it("a merge recorded long after it happened sends no notification", async () => {
    h = createHarness();
    const delivered = await start();
    const before = h.notes.length;
    await h.host.simulateMerge(1, { at: "2026-01-01T00:00:00.000Z" });
    const run = await reconcileRunById(h.app, delivered.id);
    expect(run.state).toBe("COMPLETED");
    expect(h.notes).toHaveLength(before);
  });
});

describe("delivery report", () => {
  it("is written when a run settles and says what is left for the person", async () => {
    h = createHarness();
    const run = await start();
    const md = join(h.home, "runs", run.id, "delivery.md");
    expect(existsSync(md)).toBe(true);
    expect(existsSync(join(h.home, "runs", run.id, "delivery.json"))).toBe(true);
    const r = report(run.id);
    expect(r.outcome).toBe("delivered");
    expect(r.headline).toMatch(/^Delivered: PR #1 is CI-green, independently reviewed at/);
    expect(r.actionsForYou[0]).toMatch(/Review and merge PR #1/);
    // Criteria the reviewer did not assess are the person's to judge, never done.
    expect(r.criteria.every((x) => x.status === "needs_human")).toBe(true);
    expect(r.actionsForYou.some((a) => a.startsWith("Judge AC1"))).toBe(true);
    expect(r.pr).toMatchObject({ number: 1, reviewedSha: run.context.reviewedSha });
    expect(r.checks).toEqual([{ name: "feature-exists", ok: true, optional: false }]);
    expect(r.ci?.state).toBe("pass");
    expect(r.reviewHistory).toHaveLength(1);
    expect(r.usage.note).toMatch(/API-equivalent/);
    expect(r.usage.note).toMatch(/not an amount you are charged/);
    expect(readFileSync(md, "utf8")).toMatch(/API-equivalent usage: \$0\.00/);
    const summary = (await import("../../src/report/summary.js")).summarizeRun(h.app.store, h.app.store.getRun<RunContext>(run.id)!);
    expect(summary.delivery?.outcome).toBe("delivered");
    expect(summary.delivery?.reportPath).toBe(md);
  });

  it("never calls a run delivered while CI is pending or the PR is not eligible", async () => {
    h = createHarness();
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const waiting = await start();
    expect(report(waiting.id).outcome).toBe("waiting_for_ci");

    h.cleanup();
    h = createHarness({ protection: { requiredApprovals: 1 } });
    const ready = await start();
    expect(ready.state).toBe("READY_TO_MERGE");
    const r = report(ready.id);
    expect(r.outcome).toBe("not_deliverable");
    expect(r.headline).toMatch(/requires 1 approving GitHub review/);
    expect(h.notes.some((n) => n.message.includes("ready for your review"))).toBe(false);
  });

  it("reports failures and blocks with their reason", async () => {
    h = createHarness({ implement: () => ({ text: "All done!" }) });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    const r = report(run.id);
    expect(r.outcome).toBe("blocked");
    expect(r.headline).toMatch(/^Blocked: implementer reported/);
    expect(r.completion.reason).toBe(run.reason);
  });

  it("lists recovery the engine did by itself", async () => {
    let call = 0;
    h = createHarness({
      implement: (task) => {
        call++;
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        if (call === 2) writeFileSync(join(task.cwd, "x.txt"), "x\n");
        return {};
      },
      review: (_t, n) => ({
        structured: {
          verdict: n === 1 ? "approve" : "request_changes",
          summary: "s",
          findings: [{ id: n === 1 ? "R2" : "R4", severity: "minor", file: null, line: null, title: "t", detail: "d", suggestion: null, actionable: true }],
          criteria: [],
        },
      }),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(report(run.id).recovery.map((e) => e.type)).toEqual(expect.arrayContaining(["minor.rejected", "minor.restored"]));
  });

  it("is not written for dry runs", async () => {
    h = createHarness();
    const run = await start(true);
    expect(existsSync(join(h.home, "runs", run.id, "delivery.md"))).toBe(false);
    expect(h.notes).toHaveLength(0);
  });
});

describe("notifications", () => {
  it("tell the person once when the PR is ready, and once when the run completes", async () => {
    h = createHarness();
    const run = await start();
    expect(h.notes.map((n) => n.key)).toEqual([`delivered:${run.context.reviewedSha}`]);
    expect(h.notes[0]!.title).toBe("Orchestrator · ACM-1");
    expect(h.notes[0]!.message).toMatch(/PR #1 is ready for your review \(still a draft\)/);
    // Settling again (status, a restart) never repeats it.
    await settleRun(h.app, h.app.store.getRun<RunContext>(run.id)!);
    h.reopen();
    await settleRun(h.app, h.app.store.getRun<RunContext>(run.id)!);
    expect(h.notes).toHaveLength(1);

    await h.host.simulateMerge(1);
    await reconcileRunById(h.app, run.id);
    await reconcileRunById(h.app, run.id);
    expect(h.notes.map((n) => n.key)).toEqual([`delivered:${run.context.reviewedSha}`, "completed"]);
  });

  it("never claim CI is green when no CI was reported", async () => {
    h = createHarness({ config: { merge: { require_ci: false } } });
    h.host.ciScript = () => [];
    const run = await start();
    expect(report(run.id).outcome).toBe("delivered");
    expect(h.notes.at(-1)?.message).not.toMatch(/CI green/);
    expect(h.notes.at(-1)?.message).toMatch(/independently reviewed/);
  });

  it("tell the person when a run is blocked or failed", async () => {
    h = createHarness({ implement: () => ({ text: "nothing" }) });
    const blocked = await start();
    expect(blocked.state).toBe("BLOCKED");
    expect(h.notes.at(-1)?.message).toMatch(/^Blocked — needs you: implementer reported/);

    h.cleanup();
    h = createHarness({ review: () => ({ structured: { verdict: "request_changes", summary: "", findings: [{ id: "F1", severity: "major", file: null, line: null, title: "x", detail: "", suggestion: null, actionable: true }], criteria: [] } }), config: { merge: { max_fix_attempts: 0 } } });
    const failed = await start();
    expect(failed.state).toBe("FAILED");
    expect(h.notes.at(-1)?.message).toMatch(/^Failed: review not approved/);
  });

  it("a notifier that fails never breaks the run, and is not retried", async () => {
    h = createHarness();
    h.notifyFails = true;
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.app.store.events(run.id).filter((e) => e.type === "notify.sent")).toHaveLength(1);
    expect(h.app.store.events(run.id).filter((e) => e.type === "notify.failed")).toHaveLength(1);
    h.notifyFails = false;
    await settleRun(h.app, h.app.store.getRun<RunContext>(run.id)!);
    expect(h.notes).toHaveLength(0);
  });
});
