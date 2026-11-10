import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resumeRun, startRun } from "../../src/app.js";
import type { RunContext } from "../../src/core/workflow.js";
import { createHarness, git, type Harness } from "../helpers.js";

let h: Harness;
afterEach(() => h?.cleanup());

const start = (opts: { interrupt?: AbortSignal; onEvent?: Parameters<typeof startRun>[1]["onEvent"] } = {}) =>
  startRun(h.app, {
    issueKey: "ACM-1",
    repo: "acme/widget",
    configFile: h.configFile,
    dryRun: false,
    ciWaitMinutes: 0,
    ...(opts.interrupt ? { interrupt: opts.interrupt } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });

const events = (id: string, type: string) => h.app.store.events(id).filter((e) => e.type === type);
const remoteBranches = () => git(h.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter((b) => b && b !== "main");

/** Nothing left the machine: no implementer, no pushed branch, no PR. */
function expectNoExternalEffects(): void {
  expect(h.implementer.calls).toHaveLength(0);
  expect(remoteBranches()).toEqual([]);
  expect(h.host.prs).toHaveLength(0);
}

// The default harness check (`test -f feature.txt`) fails on the untouched base, so with
// baseline_checks the base is red until the operator changes something.
describe("resume must not auto-unblock a block that happens during the resumed drive", () => {
  it("a run interrupted before IMPLEMENTING, resumed onto a red base, stays BLOCKED and never starts the implementer", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    const interrupt = new AbortController();
    let run = await start({
      interrupt: interrupt.signal,
      onEvent: (e) => {
        if (e.type === "step.started" && e.state === "PLANNING") interrupt.abort();
      },
    });
    expect(run.state).not.toBe("BLOCKED"); // stopped mid-flight, like a killed CLI
    expect(h.implementer.calls).toHaveLength(0);

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/is red before any change/);
    expect(events(run.id, "run.resumed")).toHaveLength(0);
    expectNoExternalEffects();
    // The person approved continuing a run that was not blocked, and was told a later block would stop it.
    const resume = h.approvals.find((a) => a.purpose === "resume_live_run")!;
    expect(resume.reason).toMatch(/ at (PLANNING|IMPLEMENTING): /);
    expect(resume.details.join("\n")).toContain("any block reached stops the run (no unblock)");
  });

  it("resuming a red-baseline block re-runs the baseline instead of trusting the saved red result", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    expect(run.context.baseline ?? null).toBeNull(); // a red baseline is never the accepted one
    expect(run.context.baselineFailure).toMatchObject({ attempt: 1, results: [expect.objectContaining({ name: "feature-exists", ok: false })] });

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 }); // base still red, nothing fixed

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/is red before any change/);
    expect(run.context.baselineAttempts).toBe(2);
    expect(run.context.baselineFailure?.attempt).toBe(2);
    // The check really ran again (a second, fresh effect), it was not replayed from the first attempt.
    const effects = h.app.store.effects(run.id).filter((e) => e.key.startsWith("baseline."));
    expect(effects.map((e) => e.key).sort()).toEqual(["baseline.1.feature-exists", "baseline.2.feature-exists"]);
    expect(events(run.id, "run.resumed")).toHaveLength(1);
    expectNoExternalEffects();
  });

  it("a red baseline stored by an older version (as if completed) is not trusted: the base is checked again", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    // Shape written before this fix: the red result saved as `baseline`, no attempt bookkeeping.
    const red = run.context.baselineFailure!.results;
    h.app.store.patchContext<RunContext>(run.id, { baseline: red, baselineAttempts: undefined, baselineFailure: undefined });

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/is red before any change/);
    expect(run.context.baseline ?? null).toBeNull();
    expectNoExternalEffects();
  });

  it("a red base can never reach READY_TO_MERGE or a draft PR, however often it is resumed", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    for (let i = 0; i < 3; i++) {
      run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
      expect(run.state).toBe("BLOCKED");
    }
    expect(h.app.store.events(run.id).some((e) => e.state === "READY_TO_MERGE" || e.state === "PR_OPEN")).toBe(false);
    expectNoExternalEffects();
  });

  it("a block reached after an approved unblock is not bypassed: it needs its own resume", async () => {
    // Red base (approved resume after fixing the check config), then a new block at PR_OPEN.
    h = createHarness({ config: { baseline_checks: true, permissions: { github: { push: false } } } });
    let run = await start();
    expect(run.reason).toMatch(/is red before any change/);

    h.writeConfig({ checks: [{ name: "readme", run: "test -f README.md" }] });
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/not permitted to push/);
    expect(events(run.id, "run.resumed")).toHaveLength(1);
    expect(h.host.prs).toHaveLength(0);
    expect(remoteBranches()).toEqual([]);

    // The new block is shown to the person and approved separately.
    h.writeConfig({ permissions: { github: { push: true } } });
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });
    expect(run.state).toBe("READY_TO_MERGE");
    expect(events(run.id, "run.resumed")).toHaveLength(2);
  });

  it("does not unblock when the block changed between the approval and the drive", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    expect(run.state).toBe("BLOCKED");
    // While the person looks at the prompt, the stored block changes (another process, or a forged store).
    h.answer = () => {
      h.app.store.db.prepare("UPDATE runs SET reason = ?, blocked_from = ? WHERE id = ?").run("something else entirely", "PR_OPEN", run.id);
      return true;
    };

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toBe("something else entirely");
    expect(events(run.id, "run.resumed")).toHaveLength(0);
    expect(events(run.id, "run.resume_refused")[0]!.message).toContain("Resume again to approve this block");
    expectNoExternalEffects();
  });
});

describe("legitimate recovery still works", () => {
  it("after the operator fixes the check configuration, the resumed run re-checks the base and completes", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    expect(run.state).toBe("BLOCKED");

    h.writeConfig({ checks: [{ name: "readme", run: "test -f README.md" }] });
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.baselineAttempts).toBe(2);
    expect(run.context.baseline).toEqual([expect.objectContaining({ name: "readme", ok: true })]);
    expect(run.context.baselineFailure).toBeNull();
    expect(h.implementer.calls).toHaveLength(1);
    expect(h.host.prs).toHaveLength(1);
    expect(h.host.prs[0]!.isDraft).toBe(true);
  });

  it("a green baseline is not re-run when the run re-enters IMPLEMENTING", async () => {
    // Green base, then the implementer is interrupted: the resume reuses the accepted baseline.
    const interrupt = new AbortController();
    let calls = 0;
    h = createHarness({
      config: { baseline_checks: true, checks: [{ name: "readme", run: "test -f README.md" }] },
      implement: async (task) => {
        calls++;
        if (calls === 1) {
          interrupt.abort();
          await new Promise((r) => setTimeout(r, 1_200));
          return { ok: false, error: "interrupted" };
        }
        writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
        return {};
      },
    });
    let run = await start({ interrupt: interrupt.signal });
    expect(run.state).toBe("IMPLEMENTING");
    expect(run.context.baseline).toEqual([expect.objectContaining({ name: "readme", ok: true })]);

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.baselineAttempts).toBe(1);
    expect(events(run.id, "baseline.reused")).toHaveLength(1);
    expect(h.app.store.effects(run.id).filter((e) => e.key.startsWith("baseline.")).map((e) => e.key)).toEqual(["baseline.1.readme"]);
  });

  it("a baseline interrupted mid-way continues its own attempt, reusing checks that already completed", async () => {
    const interrupt = new AbortController();
    h = createHarness({
      config: {
        baseline_checks: true,
        checks: [
          { name: "first", run: "test -f README.md" },
          { name: "second", run: "test -f README.md" },
        ],
      },
    });
    let run = await start({
      interrupt: interrupt.signal,
      onEvent: (e) => {
        if (e.type === "effect.started" && e.message.startsWith('baseline "second"')) interrupt.abort();
      },
    });
    expect(run.state).toBe("IMPLEMENTING");
    expect(h.implementer.calls).toHaveLength(0);

    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.baselineAttempts).toBe(1);
    expect(events(run.id, "effect.reused").map((e) => (e.data as { key?: string } | null)?.key)).toContain("baseline.1.first");
    expect(run.context.baseline?.map((r) => r.name)).toEqual(["first", "second"]);
  });
});

describe("toolchain in live execution", () => {
  it("a Node requirement that cannot be met blocks the live run before any repository command or agent", async () => {
    h = createHarness({ config: { baseline_checks: true } });
    let run = await start();
    expect(run.reason).toMatch(/is red before any change/);

    // The operator "fixes" the base by pinning a Node that is not installed: the resumed run must not
    // run the baseline (or the agent) on whatever Node happens to be on PATH.
    h.writeConfig({ checks: [{ name: "readme", run: "test -f README.md" }], toolchain: { node: "99.0.0" } });
    run = await resumeRun(h.app, run.id, { ciWaitMinutes: 0 });

    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/^toolchain: wants 99\.0\.0 \(toolchain\.node\)/);
    expect(h.app.store.effects(run.id).some((e) => e.key === "baseline.2.readme")).toBe(false);
    expectNoExternalEffects();
  });

  it("an exact .nvmrc in the repository is required exactly, and planning reports where it came from", async () => {
    h = createHarness({ config: { toolchain: { node: process.versions.node.split(".")[0] } } });
    writeFileSync(join(h.clone, ".nvmrc"), "99.1.2\n");
    git(h.clone, "add", ".nvmrc");
    git(h.clone, "commit", "-q", "-m", "pin node");
    const run = await start();

    // Config says only the major; .nvmrc disagrees on the major: blocked, never guessed.
    expect(run.state).toBe("BLOCKED");
    expect(run.reason).toMatch(/conflicts with the repository's \.nvmrc \(99\.1\.2\)/);
    expect(h.implementer.calls).toHaveLength(0);
  });

  it("an exact .nvmrc matching the running Node resolves to it, refining a major-only config", async () => {
    h = createHarness({ config: { toolchain: { node: process.versions.node.split(".")[0] } } });
    writeFileSync(join(h.clone, ".nvmrc"), `v${process.versions.node}\n`);
    git(h.clone, "add", ".nvmrc");
    git(h.clone, "commit", "-q", "-m", "pin node");
    const run = await start();

    expect(run.state).toBe("READY_TO_MERGE");
    expect(run.context.nodeVersionFile).toEqual({ file: ".nvmrc", content: `v${process.versions.node}` });
    expect(run.context.plan!.toolchain).toMatchObject({ requested: process.versions.node, from: expect.stringContaining(".nvmrc (refines toolchain.node") });
  });
});
