import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentScript } from "../../src/adapters/mock/index.js";
import { resumeRun, startRun } from "../../src/app.js";
import { approve, createHarness, git, writeFeature, type Harness } from "../helpers.js";

let h: Harness;
afterEach(() => h?.cleanup());

const start = () => startRun(h.app, { issueKey: "ACM-1", repo: "acme/widget", configFile: h.configFile, dryRun: false, ciWaitMinutes: 0 });

type Verdict = "met" | "not_met" | "needs_human";
const finding = (id: string, severity: string, extra: Record<string, unknown> = {}) => ({
  id,
  severity,
  file: "feature.txt",
  line: 1,
  title: `${severity} ${id}`,
  detail: `Detail of ${id}.`,
  suggestion: `Fix ${id}.`,
  actionable: true,
  ...extra,
});
/** The harness issue has two criteria: AC1 "feature.txt exists", AC2 "it says hello". */
const review = (verdict: "approve" | "request_changes", findings: unknown[] = [], criteria: Verdict[] = ["met", "met"]) => ({
  structured: { verdict, summary: `${verdict} summary`, findings, criteria: criteria.map((status, i) => ({ id: `AC${i + 1}`, status, evidence: `evidence ${i + 1}` })) },
});
const reviews = (...outs: Array<ReturnType<typeof review>>): AgentScript => (_task, call) => outs[Math.min(call, outs.length) - 1]!;
const body = () => (h.host.prs[0] as unknown as { body: string }).body;
const pushedHead = (branch: string) => git(h.origin, "rev-parse", `refs/heads/${branch}`);
const eventTypes = () => h.app.store.events(h.app.store.listRuns()[0]!.id).map((e) => e.type);

describe("minor findings after an approval", () => {
  it("get one bounded round, re-checked and re-reviewed, and the approved result is delivered", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hello\n" : "hello, world\n");
        return call === 1 ? {} : { structured: { summary: "Polished", findings: [{ id: "R2", status: "fixed", note: "added the comma" }] } };
      },
      review: reviews(review("approve", [finding("R2", "minor")]), review("approve")),
      config: { merge: { max_fix_attempts: 0 } },
    });
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "minor"]);
    expect(run.context.minorRound?.status).toBe("applied");
    // The minor round asked for a per-finding report and named only R2; it never used the correction budget (0).
    const polish = h.implementer.calls[1]!;
    expect(polish.outputSchema).toBeDefined();
    expect(polish.prompt).toContain("R2 [minor]");
    expect(polish.prompt).toContain("Minor findings round");
    // Re-reviewed with the finding and the implementer's answer to verify.
    expect(h.reviewer.calls).toHaveLength(2);
    expect(h.reviewer.calls[1]!.prompt).toContain("R2 [minor]");
    expect(h.reviewer.calls[1]!.prompt).toContain("R2: fixed — added the comma");
    expect(pushedHead(run.context.branch!)).toBe(run.context.reviewedSha);
    expect(git(h.origin, "show", `${run.context.reviewedSha}:feature.txt`)).toBe("hello, world");
    expect(body()).toContain("went through one more correction round");
  });

  it("are never polished when they are nits or not actionable", async () => {
    h = createHarness({ review: reviews(review("approve", [finding("N1", "nit"), finding("M1", "minor", { actionable: false })])) });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.implementer.calls).toHaveLength(1);
    expect(run.context.minorRound ?? null).toBeNull();
    expect(body()).toContain("Open non-blocking findings");
  });

  it("are left open when review.minor_fix_rounds is 0", async () => {
    h = createHarness({ review: reviews(review("approve", [finding("R2", "minor")])), config: { review: { minor_fix_rounds: 0 } } });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.implementer.calls).toHaveLength(1);
  });

  it("restore the approved commit, re-checked and re-reviewed against the blockers the rejected attempt raised, without spending the correction budget", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        if (call === 2) writeFileSync(join(task.cwd, "extra.txt"), "risky\n");
        return {};
      },
      review: reviews(review("approve", [finding("R2", "minor")]), review("request_changes", [finding("R3", "major")]), review("approve")),
      config: { merge: { max_fix_attempts: 0 } },
    });
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    const approvedSha = run.context.minorRound!.approvedSha;
    expect(run.context.minorRound?.status).toBe("reverted");
    expect(run.context.minorRound?.rejectedFindings?.map((f) => f.id)).toEqual(["R3"]);
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "minor", "revert"]);
    // Delivered: exactly the commit approved before the round.
    expect(run.context.reviewedSha).toBe(approvedSha);
    expect(pushedHead(run.context.branch!)).toBe(approvedSha);
    expect(git(h.origin, "show", `${approvedSha}:feature.txt`)).toBe("hello");
    expect(() => git(h.origin, "show", `${approvedSha}:extra.txt`)).toThrow();
    // R3 might apply to the approved commit too: it was reviewed again against it, not waved through.
    expect(h.reviewer.calls).toHaveLength(3);
    expect(h.reviewer.calls[2]!.prompt).toContain("raised on a later attempt that was discarded");
    expect(h.reviewer.calls[2]!.prompt).toContain("R3 [major]");
    expect(run.context.rounds.at(-1)?.checks?.every((c) => c.ok)).toBe(true);
    expect(eventTypes()).toContain("minor.restored");
    expect(body()).toContain(`delivers the last approved commit \`${approvedSha.slice(0, 12)}\``);
    expect(body()).toContain("reviewed again against the blocking findings raised on the discarded attempt (R3)");
    expect(body()).toContain("R2 [minor]");
  });

  it("never deliver the restored commit when its re-review finds the blocker applies to it too", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        if (call === 2) writeFileSync(join(task.cwd, "extra.txt"), "risky\n");
        return {};
      },
      review: reviews(review("approve", [finding("R2", "minor")]), review("request_changes", [finding("R3", "major")])),
      config: { merge: { max_fix_attempts: 0 } },
    });
    const run = await start();
    expect(run.state).toBe("FAILED");
    expect(run.reason).toMatch(/review not approved/);
    expect(h.host.prs).toHaveLength(0);
  });

  it("reuse the approval of the restored commit when the rejection raised no blocking finding", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        if (call === 2) writeFileSync(join(task.cwd, "extra.txt"), "x\n");
        return {};
      },
      review: reviews(review("approve", [finding("R2", "minor")]), review("request_changes", [finding("R4", "minor")])),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.reviewer.calls).toHaveLength(2);
    expect(run.context.rounds.at(-1)?.review?.reused).toBe(true);
    expect(eventTypes()).toContain("review.reused");
  });

  it("restore the approved commit when the implementer fails during the round", async () => {
    h = createHarness({
      implement: (task, call) => {
        if (call === 1) writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return call === 1 ? {} : { ok: false, error: "budget exhausted" };
      },
      review: reviews(review("approve", [finding("R2", "minor")])),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.minorRound?.status).toBe("reverted");
    expect(run.context.minorRound?.reason).toMatch(/budget exhausted/);
    expect(h.reviewer.calls).toHaveLength(1);
  });

  it("block, then re-run the checks on resume, when the restored commit no longer passes", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        if (call === 1) writeFileSync(join(task.cwd, ".gitignore"), "flaky-marker\n");
        else {
          // An ignored leftover survives the restore and breaks the check: an "environment" change.
          writeFileSync(join(task.cwd, "flaky-marker"), "x\n");
          writeFileSync(join(task.cwd, "extra.txt"), "x\n");
        }
        return {};
      },
      review: reviews(review("approve", [finding("R2", "minor")])),
      config: { checks: [{ name: "feature-exists", run: "test -f feature.txt && test ! -f flaky-marker" }] },
    });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/restored after the minor-finding round, no longer passes/);
    expect(h.host.prs).toHaveLength(0);

    rmSync(join(run.context.worktreePath!, "flaky-marker"));
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.reviewedSha).toBe(run.context.minorRound?.approvedSha);
    expect(run.context.rounds.at(-1)?.checks?.every((c) => c.ok)).toBe(true);
  });

  it("restore the approved commit when the round breaks the checks", async () => {
    h = createHarness({
      implement: (task, call) => {
        if (call === 1) writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        else {
          rmSync(join(task.cwd, "feature.txt"));
          writeFileSync(join(task.cwd, "renamed.txt"), "hello\n");
        }
        return {};
      },
      review: reviews(review("approve", [finding("R2", "minor")])),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.minorRound?.status).toBe("reverted");
    expect(run.context.minorRound?.reason).toMatch(/feature-exists/);
    expect(h.reviewer.calls).toHaveLength(1);
    expect(git(h.origin, "show", `${run.context.reviewedSha}:feature.txt`)).toBe("hello");
  });

  it("deliver the approved commit without another review when the implementer declines them", async () => {
    h = createHarness({
      implement: (task, call) => {
        if (call === 1) writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return call === 1 ? {} : { structured: { summary: "No change", findings: [{ id: "R2", status: "declined", note: "needs a product decision" }] } };
      },
      review: reviews(review("approve", [finding("R2", "minor")])),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.minorRound?.status).toBe("declined");
    expect(h.reviewer.calls).toHaveLength(1);
    expect(run.context.reviewedSha).toBe(run.context.minorRound?.approvedSha);
    expect(body()).toContain("R2: declined — needs a product decision");
  });
});

describe("acceptance criteria", () => {
  it("a criterion the reviewer finds not met blocks approval and goes back to the implementer", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hi\n" : "hello\n");
        return {};
      },
      review: reviews(review("approve", [], ["met", "not_met"]), review("approve")),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "review"]);
    const fix = h.implementer.calls[1]!.prompt;
    expect(fix).toContain("Acceptance criteria the reviewer found not met");
    expect(fix).toContain("AC2: it says hello");
    expect(h.reviewer.calls[0]!.prompt).toContain("AC1: feature.txt exists");
  });

  it("never ticks a criterion that needs a person, and says so at the top of the PR", async () => {
    h = createHarness({ review: reviews(review("approve", [], ["met", "needs_human"])) });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(body()).toContain("- [x] **AC1** feature.txt exists");
    expect(body()).toContain("- [ ] **AC2** it says hello — ⚠️ **needs your judgement**: evidence 2");
    expect(body()).toContain("1 acceptance criterion needs your judgement before merging: AC2");
    expect(run.reason).toMatch(/AC2/);
  });

  it("a criterion the reviewer did not assess is reported as needing a person, never as met", async () => {
    h = createHarness({ review: () => ({ structured: approve }) });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(body()).not.toContain("[x]");
    expect(body()).toContain("The reviewer gave no verdict for this criterion.");
  });

  it("criteria the planner derives from the issue's scope are judged too", async () => {
    h = createHarness({
      implement: (task) => {
        if (task.role === "planner") {
          return {
            structured: { summary: "plan", steps: [], files: [], tests: [], risks: [], open_questions: [], acceptance_criteria: ["feature.txt exists", "README links the feature"] },
          };
        }
        return writeFeature(task, 1);
      },
      config: { agents: { planner: { adapter: "mock", provider: "anthropic-mock" } } },
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.plan?.acceptanceCriteria.derived).toEqual(["README links the feature"]);
    expect(h.reviewer.calls[0]!.prompt).toContain("AC3: README links the feature (derived from the issue's scope)");
  });
});

describe("declined findings", () => {
  it("a review round that declines every finding with a reason is re-reviewed instead of blocked", async () => {
    h = createHarness({
      implement: (task, call) => {
        if (call === 1) writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return call === 1 ? {} : { structured: { summary: "Disagree", findings: [{ id: "F1", status: "declined", note: "the issue asks for exactly this" }] } };
      },
      review: reviews(review("request_changes", [finding("F1", "major")]), review("approve")),
    });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.reviewer.calls).toHaveLength(2);
    expect(h.reviewer.calls[1]!.prompt).toContain("F1: declined — the issue asks for exactly this");
    expect(eventTypes()).toContain("review.declined");
  });

  it("a review round that changes nothing and gives no reasons still blocks", async () => {
    h = createHarness({
      implement: (task, call) => {
        if (call === 1) writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return {};
      },
      review: reviews(review("request_changes", [finding("F1", "major")])),
    });
    const run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/no changes in response to review feedback/);
  });
});

describe("PR description and delivery", () => {
  it("rewrites the description of its own PR after a CI fix, for the new reviewed commit and CI", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hello\n" : "hello again\n");
        return {};
      },
    });
    h.host.ciScript = (pr) => [{ name: "CI", bucket: pr.headSha === firstSha ? "fail" : "pass" }];
    let firstSha = "";
    const origCreate = h.host.createPullRequest.bind(h.host);
    h.host.createPullRequest = async (input) => {
      const pr = await origCreate(input);
      firstSha = pr.headSha;
      return pr;
    };
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "ci"]);
    expect(h.host.prs).toHaveLength(1);
    // CI failure, the new reviewed commit, then CI passing on it: the body followed each step.
    const updates = h.host.bodyUpdates.map((u) => u.body);
    expect(updates.some((b) => b.includes(`❌ Failing on \`${firstSha.slice(0, 12)}\``))).toBe(true);
    expect(body()).toContain(`reviewed \`${run.context.reviewedSha!.slice(0, 12)}\``);
    expect(body()).toContain(`✅ Passed on \`${run.context.reviewedSha!.slice(0, 12)}\``);
    expect(body()).toContain("<!-- orchestrator-run: ");
    expect(h.host.prs[0]!.isDraft).toBe(true);
  });

  it("does not resend an unchanged description", async () => {
    h = createHarness();
    await start();
    const n = h.host.bodyUpdates.length;
    expect(n).toBe(1); // the CI line, once
    const { resumeRun } = await import("../../src/app.js");
    await resumeRun(h.app, h.app.store.listRuns()[0]!.id, { ciWaitMinutes: 0 });
    expect(h.host.bodyUpdates).toHaveLength(n);
  });

  it("stops editing a description a person replaced", async () => {
    h = createHarness();
    const origCreate = h.host.createPullRequest.bind(h.host);
    h.host.createPullRequest = async (input) => {
      const pr = await origCreate(input);
      // Someone rewrites the description right after the PR opens.
      h.host.prs.find((p) => p.number === pr.number)!.body = "A person's description";
      return pr;
    };
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.host.bodyUpdates).toHaveLength(0);
    expect(body()).toBe("A person's description");
    expect(eventTypes()).toContain("pr.body_not_owned");
  });

  it("stops editing a description a person changed, even when the marker survives", async () => {
    h = createHarness();
    const origCreate = h.host.createPullRequest.bind(h.host);
    h.host.createPullRequest = async (input) => {
      const pr = await origCreate(input);
      const live = h.host.prs.find((p) => p.number === pr.number)!;
      live.body = `${live.body}\n\nReviewer notes from a person.`;
      return pr;
    };
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.host.bodyUpdates).toHaveLength(0);
    expect(body()).toContain("Reviewer notes from a person.");
  });

  it("keeps delivering when a description update fails", async () => {
    h = createHarness();
    h.host.updatePullRequestBody = async () => {
      throw new Error("gh: HTTP 422");
    };
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(eventTypes()).toContain("pr.body_update_failed");
  });

  it("marks the PR ready for review once delivered, only when the operator opted in, and never merges", async () => {
    h = createHarness({ config: { pull_request: { mark_ready_when_delivered: true } } });
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.host.readied).toEqual([1]);
    expect(h.host.prs[0]!.isDraft).toBe(false);
    expect(h.host.merges).toHaveLength(0);
    expect(run.reason).toMatch(/marked ready for review; a human merges/);
  });

  it("does not mark the PR ready without CI that passed, even when the config does not require CI", async () => {
    h = createHarness({ config: { pull_request: { mark_ready_when_delivered: true }, merge: { require_ci: false } } });
    h.host.ciScript = () => [];
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.host.readied).toHaveLength(0);
  });

  it("keeps the PR a draft by default", async () => {
    h = createHarness();
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(h.host.readied).toHaveLength(0);
    expect(run.reason).toMatch(/PR is a draft: mark it ready, then merge/);
  });

  it("does not mark the PR ready while CI is still running", async () => {
    h = createHarness({ config: { pull_request: { mark_ready_when_delivered: true } } });
    h.host.ciScript = () => [{ name: "CI", bucket: "pending" }];
    const run = await start();
    expect(run.state).toBe("WAITING_FOR_CI");
    expect(h.host.readied).toHaveLength(0);
  });

  it("waits for GitHub to show a new push instead of treating its previous head as a foreign change", async () => {
    h = createHarness({
      implement: (task, call) => {
        writeFileSync(join(task.cwd, "feature.txt"), call === 1 ? "hello\n" : "hello again\n");
        return {};
      },
    });
    let firstSha = "";
    let lag = 0;
    h.host.ciScript = (pr) => [{ name: "CI", bucket: pr.headSha === firstSha ? "fail" : "pass" }];
    const origCreate = h.host.createPullRequest.bind(h.host);
    h.host.createPullRequest = async (input) => {
      const pr = await origCreate(input);
      firstSha = pr.headSha;
      return pr;
    };
    const origGet = h.host.getPullRequest.bind(h.host);
    h.host.getPullRequest = async (repo, n) => {
      const pr = await origGet(repo, n);
      // After the second push, report the first head once more (GitHub catching up).
      // Twice: once for PR_OPEN's description sync, once for WAITING_FOR_CI, which must wait it out.
      if (pr.headSha !== firstSha && lag++ < 2) return { ...pr, headSha: firstSha, checks: [] };
      return pr;
    };
    const run = await start();
    expect(run.state).toBe("READY_TO_MERGE");
    expect(lag).toBeGreaterThanOrEqual(2);
    expect(run.context.rounds.map((r) => r.trigger)).toEqual(["initial", "ci"]);
  }, 60_000);
});
