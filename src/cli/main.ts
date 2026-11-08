import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { cancelRun, findRunOrThrow, openApp, resumeRun, RunError, startRun, type App } from "../app.js";
import { ConfigError, listRepoConfigs, PACKAGE_ROOT } from "../config/load.js";
import { LeaseError, type RunRecord } from "../core/store.js";
import { TERMINAL_STATES } from "../core/states.js";
import type { RunContext } from "../core/workflow.js";
import { c, nextStep, renderEvent, renderPlanMarkdown, renderRunDetail, renderStatusTable, stateColor } from "../report/render.js";
import { renderCapabilities } from "./capabilities.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { runPreflight } from "./preflight.js";
import { loadRepoConfig } from "../config/load.js";

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };

function withApp<T>(fn: (app: App) => Promise<T> | T): Promise<T> {
  const app = openApp();
  return Promise.resolve()
    .then(() => fn(app))
    .finally(() => app.close());
}

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

program
  .command("run")
  .description("Start a run for a Linear issue (dry run unless --execute)")
  .argument("<issue>", "Linear issue key, e.g. BRU-488")
  .option("--repo <owner/name>", "target repository (default: inferred from the issue's team)")
  .option("--config <file>", "explicit repository config file")
  .option("--dry-run", "plan and simulate only; change nothing (default)")
  .option("--execute", "start a supervised live run: agents edit code, branches are pushed, a draft PR is opened")
  .option("--with-agent-plan", "in a dry run, also run the read-only planner agent (costs tokens, changes nothing)")
  .option("--accept-dependency <key>", "treat a dependency named in the description as non-blocking (repeatable; recorded in the audit trail)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--ci-wait <minutes>", "how long to poll CI before handing back", positiveInt, 30)
  .option("--issue-snapshot <issue.json>", "dry run only: replay Linear data recorded by an earlier run (runs/<id>/issue.json)")
  .option("--json", "print the final run record as JSON")
  .action(async (issue: string, opts: { repo?: string; config?: string; dryRun?: boolean; execute?: boolean; withAgentPlan?: boolean; acceptDependency: string[]; ciWait: number; issueSnapshot?: string; json?: boolean }) => {
    if (opts.dryRun && opts.execute) throw new RunError("--dry-run and --execute are mutually exclusive");
    const dryRun = !opts.execute;
    if (!opts.dryRun && !opts.execute) console.error(c.dim("No --execute given: running as a dry run."));
    const onEvent = progress(Boolean(opts.json));
    await withApp(async (app) => {
      const run = await startRun(app, {
        issueKey: issue,
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.config ? { configFile: opts.config } : {}),
        dryRun,
        withAgentPlan: Boolean(opts.withAgentPlan),
        acceptDependencies: opts.acceptDependency,
        ciWaitMinutes: opts.ciWait,
        ...(opts.issueSnapshot ? { issueSnapshot: opts.issueSnapshot } : {}),
        ...(onEvent ? { onEvent } : {}),
        interrupt: interruptSignal(),
      });
      if (opts.json) {
        console.log(JSON.stringify(run, null, 2));
      } else {
        if (run.context.plan) console.log(`\n${renderPlanMarkdown(run.context.plan)}`);
        console.log(summarize(app, run));
      }
      process.exitCode = exitCodeFor(run);
    });
  });

program
  .command("status")
  .description("List recent runs, or show one run in detail")
  .argument("[run-id]", "run id or unique prefix")
  .option("--limit <n>", "number of runs to list", positiveInt, 20)
  .option("--json", "machine-readable output")
  .action((id: string | undefined, opts: { limit: number; json?: boolean }) =>
    withApp((app) => {
      if (id) {
        const run = findRunOrThrow(app, id);
        if (opts.json) console.log(JSON.stringify({ run, artifacts: app.store.artifacts(run.id), effects: app.store.effects(run.id) }, null, 2));
        else console.log(renderRunDetail(run, app.store.artifacts(run.id), app.store.effects(run.id), app.store.leaseHolder(run.id)));
        return;
      }
      const runs = app.store.listRuns(opts.limit);
      console.log(opts.json ? JSON.stringify(runs, null, 2) : renderStatusTable(runs, (rid) => app.store.leaseHolder(rid)));
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
  .description("Continue a run (re-enters the blocked step, re-checks CI or merge state)")
  .argument("<run-id>", "run id or unique prefix")
  .option("--ci-wait <minutes>", "how long to poll CI before handing back", positiveInt)
  .option("--accept-dependency <key>", "treat a dependency named in the description as non-blocking (repeatable; audited)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--json", "print the final run record as JSON")
  .action((id: string, opts: { ciWait?: number; acceptDependency: string[]; json?: boolean }) =>
    withApp(async (app) => {
      const run = await resumeRun(app, id, {
        ...(opts.ciWait !== undefined ? { ciWaitMinutes: opts.ciWait } : {}),
        acceptDependencies: opts.acceptDependency,
        ...(opts.json ? {} : { onEvent: progress(false)! }),
        interrupt: interruptSignal(),
      });
      console.log(opts.json ? JSON.stringify(run, null, 2) : summarize(app, run));
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
        console.log(`${c.bold(config.repo)}  teams ${config.linear.teams.join(",")}  merge ${config.merge.mode}  ${c.dim(source)}`);
      }
    }),
  );

program
  .command("capabilities")
  .description("What is supported today versus planned")
  .action(() => console.log(renderCapabilities()));

program
  .command("install-skill")
  .description("Link the /orchestrate skill into Claude Code (used by T3-hosted Claude sessions)")
  .option("--dir <skills-dir>", "skills directory (default: $CLAUDE_CONFIG_DIR/skills or ~/.claude/skills)")
  .action((opts: { dir?: string }) => {
    const dir = opts.dir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "skills");
    const target = join(dir, "orchestrate");
    const source = join(PACKAGE_ROOT, "integrations", "claude-skill", "orchestrate");
    mkdirSync(dir, { recursive: true });
    if (existsSync(target) || isSymlink(target)) {
      console.log(`${target} already exists; leaving it unchanged.`);
      return;
    }
    symlinkSync(source, target, "dir");
    console.log(`Linked ${target} → ${source}\nIn a T3 Claude Code thread, type: /orchestrate BRU-488`);
  });

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const known = err instanceof RunError || err instanceof ConfigError || err instanceof LeaseError;
  console.error(c.red(`error: ${(err as Error).message}`));
  if (!known && process.env.ORCHESTRATOR_DEBUG) console.error((err as Error).stack);
  process.exitCode = 1;
});
