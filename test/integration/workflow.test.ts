import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { cancelRun, resumeRun, startRun } from "../../src/app.js";
import type { RunContext } from "../../src/core/workflow.js";
import { approve, createHarness, git, requestChanges, type Harness } from "../helpers.js";

let h: Harness;
afterEach(() => h?.cleanup());

const start = (opts: { dryRun?: boolean; issue?: string } = {}) =>
  startRun(h.app, { issueKey: opts.issue ?? "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: opts.dryRun ?? false, ciWaitMinutes: 0 });

describe("supervised run", () => {
  it("implements, verifies, reviews independently, opens a draft PR and stops at READY_TO_MERGE", async () => {
    h = createHarness();
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.merge?.eligible).toBe(true);
    expect(run.context.merge?.autoMerge).toBe(false);

    // The branch on origin is exactly the commit the reviewer approved.
    const pushed = git(h.origin, "rev-parse", `refs/heads/${run.context.branch}`);
    expect(pushed).toBe(run.context.reviewedSha);
    expect(git(h.origin, "show", `${pushed}:feature.txt`)).toBe("hello");

    // Draft PR with orchestrator-verified checks in the body; no merge.
    expect(h.host.prs).toHaveLength(1);
    expect(h.host.prs[0]!.isDraft).toBe(true);
    expect((h.host.prs[0] as unknown as { body: string }).body).toContain("run by the orchestrator, not self-reported");
    expect(h.host.merges).toHaveLength(0);

    // Reviewer ran read-only on the worktree with the review schema; implementer and reviewer are different agents.
    expect(h.implementer.calls).toHaveLength(1);
    expect(h.reviewer.calls).toHaveLength(1);
    expect(h.reviewer.calls[0]!.role).toBe("reviewer");
    expect(h.reviewer.calls[0]!.outputSchema).toBeDefined();

    // The operator's clone was not modified: work happened in a separate worktree.
    expect(git(h.clone, "status", "--porcelain")).toBe("");
    expect(run.context.worktreePath).not.toBe(h.clone);

    // Linear comments only because the config grants linear.comment.
    expect(h.tracker.comments.map((c) => c.body).join("\n")).toContain(h.host.prs[0]!.url);

    const types = h.app.store.events(run.id).map((e) => e.type);
    expect(types).toContain("verify.changes");
    expect(types).toContain("review.result");
  });

  it("feeds review findings back to the same implementer session until approved", async () => {
    let reviews = 0;
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hi\n" : "hello\n");
        return {};
      },
      review: () => {
        reviews++;
        const out = reviews === 1 ? requestChanges() : approve;
        return { structured: out };
      },
    });
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.attempt).toBe(1);
    expect(h.implementer.calls).toHaveLength(2);
    const fix = h.implementer.calls[1]!;
    expect(fix.resumeSessionId).toBe(h.implementer.calls[0]!.sessionId);
    expect(fix.prompt).toContain("F1 [major] Missing greeting");
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "review"]);
    // The second review was told about the first round's findings.
    expect(h.reviewer.calls[1]!.prompt).toContain("Findings from the previous round");
  });

  it("does not count a reviewer 'approve' that still reports blocking findings", async () => {
    h = createHarness({ review: () => ({ structured: { ...requestChanges(), verdict: "approve" } }), config: { merge: { max_fix_attempts: 0 } } });
    const run = await start();
    expect(run.state).toBe("FAILED");
    expect(run.reason).toMatch(/review not approved/);
    expect(h.host.prs).toHaveLength(0);
  });

  it("fails after the correction budget when checks keep failing", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, `attempt-${call}.txt`), "x");
        return {};
      },
    });
    const run = await start();
    expect(run.state).toBe("FAILED");
    expect(run.reason).toMatch(/checks still failing after 2 correction round/);
    expect(h.implementer.calls).toHaveLength(3); // initial + 2 fixes
    expect(h.implementer.calls[1]!.prompt).toContain("feature-exists");
    expect(h.reviewer.calls).toHaveLength(0); // never reviewed failing code
    expect(h.host.prs).toHaveLength(0);
  });

  it("blocks when the implementer claims success but changed nothing", async () => {
    h = createHarness({ implement: () => ({ text: "All done, everything works!" }) });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/no changes/);
    expect(h.reviewer.calls).toHaveLength(0);
  });

  it("refuses to commit forbidden paths", async () => {
    h = createHarness({
      implement: (task) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        writeFileSync(join(task.cwd, ".env"), "SECRET=1\n");
        return {};
      },
    });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/forbidden paths.*\.env/);
  });

  it("blocks on unresolved dependencies before doing anything", async () => {
    h = createHarness({
      issues: [makeIssue({ key: "ACM-1", blockedBy: [{ key: "ACM-0", title: "Schema", state: { name: "In Progress", type: "started" } }] })],
    });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.blockedFrom).toBe("PLANNING");
    expect(run.reason).toContain("blocked by ACM-0");
    expect(h.implementer.calls).toHaveLength(0);
  });

  it("blocks on dependencies declared in the description, and proceeds once the operator accepts them", async () => {
    h = createHarness({
      issues: [
        makeIssue({ key: "ACM-1", description: "Build it.\n\n## Done\n\nfeature.txt says hello.\n\n## Dependencies\n* ACM-7 (merge first)" }),
        makeIssue({ key: "ACM-7", title: "Prerequisite", state: { name: "In Progress", type: "started" } }),
      ],
    });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/declared dependency ACM-7 "Prerequisite" is In Progress/);
    expect(h.implementer.calls).toHaveLength(0);

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0, acceptDependencies: ["acm-7"] });
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.plan!.dependencies.declared).toEqual([expect.objectContaining({ key: "ACM-7", accepted: true, resolved: false })]);
    const audit = h.app.store.events(run.id).filter((e) => e.type === "dependency.accepted");
    expect(audit[0]!.message).toContain("Operator accepted ACM-7");
  });

  it("blocks when the reviewer would be the implementer's own provider", async () => {
    h = createHarness({ config: { agents: { reviewer: { adapter: "mock", provider: "anthropic-mock" } } } });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/reviewer is not the implementer/);
  });

  it("blocks at PR_OPEN without push permission, then continues after the operator grants it", async () => {
    h = createHarness({ config: { permissions: { github: { push: false } } } });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.blockedFrom).toBe("PR_OPEN");
    expect(run.reason).toMatch(/permissions.github.push/);

    h.writeConfig({ permissions: { github: { push: true } } });
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
    // Nothing was redone: one implementation, one review.
    expect(h.implementer.calls).toHaveLength(1);
    expect(h.reviewer.calls).toHaveLength(1);
  });

  it("blocks if the PR head changes after review", async () => {
    h = createHarness();
    h.host.headOverride = "f".repeat(40);
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/unexpected changes after review/);
  });

  it("stays in WAITING_FOR_CI while CI is pending and resumes to READY_TO_MERGE", async () => {
    h = createHarness();
    h.host.ciScript = (_pr, reads) => [{ name: "CI", bucket: reads < 1 ? "pending" : "pass" }];
    let run = await start();
    expect(run.state).toBe("WAITING_FOR_CI");
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
  });

  it("sends CI failures back to the implementer", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), `hello ${call}\n`);
        return {};
      },
    });
    h.host.ciScript = () => [{ name: "CI", bucket: h.implementer.calls.length === 1 ? "fail" : "pass" }];
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.implementer.calls[1]!.prompt).toContain("GitHub CI failed");
    expect(h.host.prs).toHaveLength(1); // reused, not duplicated
  });
});

describe("merge policy", () => {
  const auto = {
    permissions: { github: { merge: true } },
    merge: { mode: "auto", auto_authorization: { repo: "acme/widget", authorized_by: "owner", authorized_at: "2026-11-06", actor: "bot" } },
  };

  it("never merges an unprotected branch even in auto mode", async () => {
    h = createHarness({ config: auto });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.merge?.autoMergeBlockers.join(" ")).toMatch(/not protected/);
    expect(h.host.merges).toHaveLength(0);
  });

  it("merges with a pinned head SHA when every auto rule holds", async () => {
    h = createHarness({ config: { ...auto, pull_request: { draft: false } }, protection: { protected: true, requiredChecks: ["CI"] } });
    const run = await start();
    expect(run.state).toBe("COMPLETED");
    expect(h.host.merges).toEqual([{ repo: "acme/widget", number: 1, headSha: run.context.reviewedSha, method: "squash" }]);
  });

  it("refuses auto merge for an identity that is not authorized", async () => {
    h = createHarness({ config: { ...auto, pull_request: { draft: false } }, protection: { protected: true, requiredChecks: ["CI"] } });
    h.host.login = "someone-else";
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.merge?.autoMergeBlockers.join(" ")).toMatch(/not the authorized actor/);
    expect(h.host.merges).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("plans and simulates every stage without side effects", async () => {
    h = createHarness();
    const run = await start({ dryRun: true });

    expect(run.state).toBe("COMPLETED");
    expect(run.mode).toBe("dry_run");
    expect(h.implementer.calls).toHaveLength(0);
    expect(h.reviewer.calls).toHaveLength(0);
    expect(h.host.prs).toHaveLength(0);
    expect(h.tracker.comments).toHaveLength(0);
    expect(existsSync(run.context.worktreePath!)).toBe(false);
    expect(git(h.clone, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(h.origin, "branch", "--list")).not.toContain("orch/");

    const plan = run.context.plan!;
    expect(plan.blockers).toEqual([]);
    expect(plan.acceptanceCriteria.criteria).toEqual(["feature.txt exists", "it says hello"]);
    expect(plan.stages.map((s) => s.state)).toEqual(["PLANNING", "IMPLEMENTING", "TESTING", "REVIEWING", "FIXING", "PR_OPEN", "WAITING_FOR_CI", "READY_TO_MERGE"]);
    expect(plan.agents.map((a) => `${a.role}:${a.provider}`)).toEqual(["implementer:anthropic-mock", "reviewer:openai-mock"]);

    const states = h.app.store.events(run.id).filter((e) => e.type === "state.changed").map((e) => (e.data as { to: string }).to);
    expect(states).toEqual(["PLANNING", "IMPLEMENTING", "TESTING", "REVIEWING", "PR_OPEN", "WAITING_FOR_CI", "READY_TO_MERGE", "COMPLETED"]);
    expect(h.app.store.events(run.id).filter((e) => e.type === "effect.simulated").length).toBeGreaterThan(5);
    expect(h.app.store.artifacts(run.id).map((a) => a.label)).toEqual(expect.arrayContaining(["execution plan", "execution plan (json)"]));
  });

  it("allows a dry run even when an active live run exists, but not a second live run", async () => {
    h = createHarness({ config: { permissions: { github: { push: false } } } });
    const live = await start();
    expect(live.state).toBe("BLOCKED");
    await expect(start()).rejects.toThrow(/already has an active run/);
    const dry = await start({ dryRun: true });
    expect(dry.state).toBe("COMPLETED");
  });
});

describe("cancellation and resumption", () => {
  it("cancels a run while the implementer is working", async () => {
    let runId = "";
    h = createHarness({
      implement: async (task) => {
        cancelRun(h.app, runId);
        await new Promise<void>((resolve) => {
          if (task.signal.aborted) return resolve();
          task.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: false, error: "aborted" };
      },
    });
    const origCreate = h.app.store.createRun.bind(h.app.store);
    h.app.store.createRun = ((input: Parameters<typeof origCreate>[0]) => {
      const r = origCreate(input);
      runId = r.id;
      return r;
    }) as typeof h.app.store.createRun;

    const run = await start();
    expect(run.state).toBe("CANCELLED");
    expect(h.implementer.calls[0]!.signal.aborted).toBe(true);
    // Worktree is kept for inspection.
    expect(existsSync(run.context.worktreePath!)).toBe(true);
  });

  it("an interrupted run resumes without redoing completed external actions", async () => {
    const interrupt = new AbortController();
    let reviewCalls = 0;
    h = createHarness({
      review: async (task) => {
        reviewCalls++;
        if (reviewCalls === 1) {
          interrupt.abort();
          await new Promise((r) => setTimeout(r, 1_200));
          return { ok: false, error: "interrupted" };
        }
        void task;
        return { structured: approve };
      },
    });
    let run = await startRun(h.app, { issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: false, ciWaitMinutes: 0, interrupt: interrupt.signal });
    expect(run.state).toBe("REVIEWING");
    expect(h.app.store.leaseHolder(run.id)).toBeNull();

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.implementer.calls).toHaveLength(1);
    expect(reviewCalls).toBe(2);
  });

  it("persists across process restarts (new App on the same database)", async () => {
    h = createHarness({ config: { permissions: { github: { push: false } } } });
    const run = await start();
    expect(run.state).toBe("BLOCKED");

    const app2 = h.reopen();
    const reloaded = app2.store.getRun<RunContext>(run.id)!;
    expect(reloaded.state).toBe("BLOCKED");
    expect(reloaded.context.reviewedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(app2.store.effects(run.id).find((e) => e.key === "agent.implement.0")?.status).toBe("completed");

    h.writeConfig({ permissions: { github: { push: true } } });
    const done = await resumeRun(app2, run.id, { ciWaitMinutes: 0 });
    expect(done.state).toBe("READY_TO_MERGE");
    expect(h.implementer.calls).toHaveLength(1);
  });
});
