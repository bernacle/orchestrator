import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { cancelRun, findRunOrThrow, IntakeError, openApp, resumeRun, RunError, startRun, type App } from "../app.js";
import { ConfigError, listRepoConfigs, loadRepoConfig, PACKAGE_ROOT } from "../config/load.js";
import { CredentialError } from "../credentials/linear.js";
import { LeaseError, type RunRecord } from "../core/store.js";
import { TERMINAL_STATES } from "../core/states.js";
import type { RunContext } from "../core/workflow.js";
import { IssueRefError } from "../intake/issue-ref.js";
import { resumableRun, reviewedRun, runsForTarget } from "../intake/targets.js";
import { c, nextStep, renderEvent, renderPlanMarkdown, renderRunDetail, renderStatusTable, stateColor } from "../report/render.js";
import { reviewFindings, summarizeRun } from "../report/summary.js";
import { output, printJson, withApp } from "./common.js";
import { registerAuthCommands } from "./auth.js";
import { renderCapabilities } from "./capabilities.js";
import { registerContextCommands } from "./context.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { runPreflight } from "./preflight.js";
import { registerSkillCommands } from "./skill.js";

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("expected a non-negative integer");
  return n;
};

/** Ctrl-C pauses the run (resumable); a second Ctrl-C exits immediately. */
function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  let count = 0;
  process.on("SIGINT", () => {
    count++;
    if (count === 1) {
      process.stderr.write(c.yellow("\nInterrupting: stopping the current step (Ctrl-C again to exit now)…\n"));
      controller.abort();
    } else process.exit(130);
  });
  return controller.signal;
}

function progress(json: boolean): ((e: { level: string; state: string; type: string; message: string }) => void) | undefined {
  return json ? undefined : (e) => {
    if (e.type === "step.started" || e.level === "debug") return;
    process.stdout.write(`${renderEvent({ ts: new Date().toISOString(), level: e.level as never, state: e.state as never, type: e.type, message: e.message })}\n`);
  };
}

function exitCodeFor(run: RunRecord): number {
  if (run.state === "FAILED") return 1;
  if (run.state === "BLOCKED") return 2;
  return 0;
}

function summarize(app: App, run: RunRecord<RunContext>): string {
  const lines = ["", `${c.bold("Run")} ${run.id}: ${stateColor(run.state)(run.state)}${run.reason ? ` — ${run.reason}` : ""}`];
  const intake = run.context.options.intake;
  if (intake) {
    lines.push(`Repository: ${run.repo} (${intake.reason})`);
    if (intake.association) lines.push(`Issue ↔ repository: ${intake.association.evidence.map((e) => e.detail).join("; ")}`);
  }
  const planMd = app.store.artifacts(run.id).find((a) => a.label === "execution plan");
  if (planMd) lines.push(`Plan: ${planMd.path}`);
  lines.push(nextStep(run));
  return lines.join("\n");
}

const program = new Command()
  .name("orchestrator")
  .description("Supervised engineering orchestrator: Linear issue → isolated implementation → independent review → PR.")
  .version(pkg.version)
  .showHelpAfterError();

program
  .command("doctor")
  .description("Check tools, credentials, T3, and repository configuration")
  .option("--repo <owner/name>", "check one repository (default: all configured)")
  .option("--json", "machine-readable output")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const app = openApp();
    try {
      const checks = await runDoctor(app.paths, { ...(opts.repo ? { repo: opts.repo } : {}) });
      console.log(opts.json ? JSON.stringify(checks, null, 2) : renderDoctor(checks));
      process.exitCode = checks.some((k) => k.status === "fail") ? 1 : 0;
    } finally {
      app.close();
    }
  });

registerContextCommands(program);

program
  .command("run")
  .description("Start a run for a Linear issue (dry run unless --execute). The repository is identified from the working directory unless --repo is given.")
  .argument("<issue>", "Linear issue key or URL, e.g. BRU-488 or https://linear.app/<workspace>/issue/BRU-488")
  .option("--repo <owner/name>", "target repository (default: the GitHub repository of the working directory)")
  .option("--config <file>", "explicit repository config file")
  .option("--cwd <dir>", "directory to identify the repository from (default: the current directory)")
  .option("--linear-workspace <urlKey>", "Linear workspace whose stored key to use (default: from the URL or the repository config)")
  .option("--dry-run", "plan and simulate only; change nothing (default)")
  .option("--execute", "start a supervised live run (agents edit code, a branch is pushed, a draft PR is opened) after you confirm a system prompt: Touch ID / password on macOS")
  .option("--with-agent-plan", "in a dry run, also run the read-only planner agent (costs tokens, changes nothing)")
  .option("--accept-dependency <key>", "treat a dependency named in the description as non-blocking (repeatable; recorded in the audit trail)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--ci-wait <minutes>", "how long to poll CI before handing back", positiveInt, 30)
  .option("--issue-snapshot <issue.json>", "dry run only: replay Linear data recorded by an earlier run (runs/<id>/issue.json)")
  .option("--json", "print a versioned JSON summary (schemaVersion 1) instead of the plan")
  .action(async (issue: string, opts: { repo?: string; config?: string; cwd?: string; linearWorkspace?: string; dryRun?: boolean; execute?: boolean; withAgentPlan?: boolean; acceptDependency: string[]; ciWait: number; issueSnapshot?: string; json?: boolean }) => {
    output.json = Boolean(opts.json);
    if (opts.dryRun && opts.execute) throw new RunError("--dry-run and --execute are mutually exclusive");
    const dryRun = !opts.execute;
    if (!opts.dryRun && !opts.execute) console.error(c.dim("No --execute given: running as a dry run."));
    const onEvent = progress(Boolean(opts.json));
    await withApp(async (app) => {
      const run = await startRun(app, {
        issueKey: issue,
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.config ? { configFile: opts.config } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.linearWorkspace ? { linearWorkspace: opts.linearWorkspace } : {}),
        dryRun,
        withAgentPlan: Boolean(opts.withAgentPlan),
        acceptDependencies: opts.acceptDependency,
        ciWaitMinutes: opts.ciWait,
        ...(opts.issueSnapshot ? { issueSnapshot: opts.issueSnapshot } : {}),
        ...(onEvent ? { onEvent } : {}),
        interrupt: interruptSignal(),
      });
      if (opts.json) {
        printJson("run", summarizeRun(app.store, run));
      } else {
        if (run.context.plan) console.log(`\n${renderPlanMarkdown(run.context.plan)}`);
        console.log(summarize(app, run));
      }
      process.exitCode = exitCodeFor(run);
    });
  });

program
  .command("status")
  .description("List recent runs, or show a run (by id) or an issue's runs (by key or Linear URL)")
  .argument("[target]", "run id or unique prefix, or an issue key / Linear URL")
  .option("--repo <owner/name>", "with an issue: only runs on this repository (default: the working directory's repository)")
  .option("--limit <n>", "number of runs to list", positiveInt, 20)
  .option("--json", "versioned JSON (schemaVersion 1)")
  .action((target: string | undefined, opts: { repo?: string; limit: number; json?: boolean }) =>
    withApp(async (app) => {
      output.json = Boolean(opts.json);
      if (target) {
        const found = await runsForTarget(app, target, opts.repo ? { repo: opts.repo } : {});
        if (found.byId) {
          const run = found.byId;
          if (opts.json) printJson("run_detail", { run: summarizeRun(app.store, run), artifacts: app.store.artifacts(run.id), effects: app.store.effects(run.id) });
          else console.log(renderRunDetail(run, app.store.artifacts(run.id), app.store.effects(run.id), app.store.leaseHolder(run.id)));
          return;
        }
        const runs = found.runs.slice(0, opts.limit);
        if (opts.json) printJson("issue_runs", { issue: found.issueKey, repo: found.repo, runs: runs.map((r) => summarizeRun(app.store, r)) });
        else console.log(runs.length ? renderStatusTable(runs, (rid) => app.store.leaseHolder(rid)) : `No runs for ${found.issueKey}${found.repo ? ` on ${found.repo}` : ""}.`);
        return;
      }
      const runs = app.store.listRuns(opts.limit) as Array<RunRecord<RunContext>>;
      if (opts.json) printJson("runs", runs.map((r) => summarizeRun(app.store, r)));
      else console.log(renderStatusTable(runs, (rid) => app.store.leaseHolder(rid)));
    }),
  );

program
  .command("review")
  .description("Show the independent review findings the engine recorded for a run (by id, or the newest reviewed run for an issue)")
  .argument("<target>", "run id or prefix, or an issue key / Linear URL")
  .option("--repo <owner/name>", "with an issue: only runs on this repository")
  .option("--json", "versioned JSON (schemaVersion 1)")
  .action((target: string, opts: { repo?: string; json?: boolean }) =>
    withApp(async (app) => {
      output.json = Boolean(opts.json);
      const run = await reviewedRun(app, target, opts.repo ? { repo: opts.repo } : {});
      const findings = reviewFindings(run);
      if (opts.json) return printJson("review", { ...findings, summary: summarizeRun(app.store, run) });
      if (findings.rounds.length === 0) return console.log(`${run.id} (${run.state}) has no review results yet.`);
      for (const r of findings.rounds) {
        console.log(`${c.bold(`Round ${r.attempt}`)} (${r.trigger}) on ${r.reviewedSha.slice(0, 8)}: ${r.approved ? c.green("approved") : c.yellow(r.verdict)} — ${r.summary}`);
        for (const f of r.findings) console.log(`  [${f.severity}] ${f.file ?? "-"}${f.line ? `:${f.line}` : ""} ${f.title}\n      ${f.detail}${f.suggestion ? `\n      → ${f.suggestion}` : ""}`);
      }
    }),
  );

program
  .command("logs")
  .description("Show a run's timeline")
  .argument("<run-id>", "run id or unique prefix")
  .option("-f, --follow", "keep printing new events until the run stops")
  .option("--debug", "include debug events")
  .option("--json", "JSONL output")
  .action((id: string, opts: { follow?: boolean; debug?: boolean; json?: boolean }) =>
    withApp(async (app) => {
      const run = findRunOrThrow(app, id);
      let last = 0;
      const print = () => {
        for (const e of app.store.events(run.id, { afterId: last })) {
          last = e.id;
          if (e.level === "debug" && !opts.debug) continue;
          console.log(opts.json ? JSON.stringify(e) : renderEvent(e));
        }
      };
      print();
      while (opts.follow) {
        const current = app.store.getRun(run.id)!;
        if (TERMINAL_STATES.has(current.state) || !app.store.leaseHolder(run.id)) break;
        await new Promise((r) => setTimeout(r, 1_000));
        print();
      }
    }),
  );

program
  .command("plan")
  .description("Print a run's execution plan")
  .argument("<run-id>", "run id or unique prefix")
  .option("--json", "print plan.json")
  .action((id: string, opts: { json?: boolean }) =>
    withApp((app) => {
      const run = findRunOrThrow(app, id);
      if (!run.context.plan) throw new RunError(`run ${run.id} has no plan yet (state ${run.state})`);
      console.log(opts.json ? JSON.stringify(run.context.plan, null, 2) : renderPlanMarkdown(run.context.plan));
    }),
  );

program
  .command("resume")
  .description("Continue a run (re-enters the blocked step, re-checks CI or merge state). Accepts a run id or an issue key / URL. Live runs ask you to confirm a system prompt again.")
  .argument("<target>", "run id or unique prefix, or an issue key / Linear URL (resolved to its only resumable run)")
  .option("--repo <owner/name>", "with an issue: only runs on this repository")
  .option("--ci-wait <minutes>", "how long to poll CI before handing back", positiveInt)
  .option("--accept-dependency <key>", "treat a dependency named in the description as non-blocking (repeatable; audited)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--json", "print a versioned JSON summary (schemaVersion 1)")
  .action((target: string, opts: { repo?: string; ciWait?: number; acceptDependency: string[]; json?: boolean }) =>
    withApp(async (app) => {
      output.json = Boolean(opts.json);
      const found = await resumableRun(app, target, opts.repo ? { repo: opts.repo } : {});
      const run = await resumeRun(app, found.id, {
        ...(opts.ciWait !== undefined ? { ciWaitMinutes: opts.ciWait } : {}),
        acceptDependencies: opts.acceptDependency,
        ...(opts.json ? {} : { onEvent: progress(false)! }),
        interrupt: interruptSignal(),
      });
      if (opts.json) printJson("run", summarizeRun(app.store, run));
      else console.log(summarize(app, run));
      process.exitCode = exitCodeFor(run);
    }),
  );

program
  .command("cancel")
  .description("Cancel a run (stops its agent or check; worktree is kept for inspection)")
  .argument("<run-id>", "run id or unique prefix")
  .action((id: string) =>
    withApp((app) => {
      const { run, deferred } = cancelRun(app, id);
      console.log(deferred ? `Cancellation requested for ${run.id}; the driving process will stop shortly.` : `${run.id} cancelled.`);
    }),
  );

program
  .command("preflight")
  .description("Run the repository's setup and checks in a throwaway sandboxed worktree, exactly as a live run would (no agent edits, nothing pushed)")
  .requiredOption("--repo <owner/name>", "repository to check")
  .option("--agent-probe", "also verify the implementer's Claude Code sandbox inside the worktree (cheap model, ~$0.05)")
  .option("--keep", "keep the throwaway worktree for inspection")
  .action((opts: { repo: string; agentProbe?: boolean; keep?: boolean }) =>
    withApp(async (app) => {
      const loaded = loadRepoConfig(opts.repo, app.paths);
      const report = await runPreflight({
        loaded,
        adapters: app.adaptersFor(loaded),
        paths: app.paths,
        agentProbe: Boolean(opts.agentProbe),
        keep: Boolean(opts.keep),
        onStep: (s) => console.log(`${s.ok ? c.green("✓") : c.red("✗")} ${s.kind.padEnd(11)} ${s.name.padEnd(22)} ${s.durationMs !== undefined ? c.dim(`${Math.round(s.durationMs / 1000)}s `) : ""}${s.detail}`),
      });
      console.log(`\n${report.ok ? c.green("Preflight passed") : c.red("Preflight failed")}: ${report.repo} @ ${report.baseSha.slice(0, 8)}\nReport: ${report.reportPath}`);
      process.exitCode = report.ok ? 0 : 1;
    }),
  );

program
  .command("repos")
  .description("List configured repositories")
  .action(() =>
    withApp((app) => {
      for (const { config, source } of listRepoConfigs(app.paths)) {
        console.log(`${c.bold(config.repo)}  teams ${config.linear.teams.join(",")}  merge ${config.merge.mode}${config.authorization ? `  authorized ${config.authorization.scope} by ${config.authorization.authorized_by}` : ""}  ${c.dim(source)}`);
      }
    }),
  );

program
  .command("capabilities")
  .description("What is supported today versus planned")
  .action(() => console.log(renderCapabilities()));

registerAuthCommands(program);
registerSkillCommands(program, pkg.version);

program.parseAsync(process.argv).catch((err: unknown) => {
  const known = err instanceof RunError || err instanceof ConfigError || err instanceof LeaseError || err instanceof IssueRefError || err instanceof CredentialError;
  if (output.json) {
    const e = err as Error;
    printJson("error", {
      code: err instanceof IntakeError ? err.code : err instanceof ConfigError ? "configuration" : err instanceof IssueRefError ? "invalid_issue_ref" : known ? "error" : "internal",
      message: e.message,
      ...(err instanceof IntakeError && err.details ? { details: err.details } : {}),
    });
  } else {
    console.error(c.red(`error: ${(err as Error).message}`));
  }
  if (!known && process.env.ORCHESTRATOR_DEBUG) console.error((err as Error).stack);
  process.exitCode = 1;
});
