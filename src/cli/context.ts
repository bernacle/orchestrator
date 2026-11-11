import type { Command } from "commander";
import { authorizeRepository, confirmAssociation, repositoryTrust, RunError, trustRepository, untrustRepository } from "../app.js";
import { describeTrustState } from "../core/trust.js";
import { inspectRequest, publicContext, type RequestContext } from "../intake/context.js";
import { proposeConfiguration } from "../intake/first-use.js";
import { parseIssueRef } from "../intake/issue-ref.js";
import { SnapshotTracker } from "../adapters/snapshot.js";
import { configStatus } from "../intake/resolve.js";
import { listRepoConfigs } from "../config/load.js";
import { c } from "../report/render.js";
import { output, printJson, withApp } from "./common.js";

/** Commands that prepare a request without starting anything: context, repo init/authorize, associate. */
export function registerContextCommands(program: Command): void {
  program
    .command("context")
    .description("Read-only: resolve an issue and the working directory's repository, check authorization, credentials, association and existing runs, and list what can be done next")
    .argument("<issue>", "Linear issue key or URL")
    .option("--repo <owner/name>", "target repository (default: the GitHub repository of the working directory)")
    .option("--config <file>", "explicit repository config file")
    .option("--cwd <dir>", "directory to identify the repository from")
    .option("--linear-workspace <urlKey>", "Linear workspace whose stored key to use")
    .option("--issue-snapshot <issue.json>", "use recorded Linear data instead of reading Linear")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((issue: string, opts: { repo?: string; config?: string; cwd?: string; linearWorkspace?: string; issueSnapshot?: string; json?: boolean }) =>
      withApp(async (app) => {
        output.json = Boolean(opts.json);
        const ctx = await inspectRequest(app, {
          issueRef: issue,
          ...(opts.repo ? { repo: opts.repo } : {}),
          ...(opts.config ? { configFile: opts.config } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.linearWorkspace ? { linearWorkspace: opts.linearWorkspace } : {}),
          ...(opts.issueSnapshot ? { snapshotIssue: new SnapshotTracker(opts.issueSnapshot).issue } : {}),
        });
        const view = publicContext(ctx);
        if (opts.json) printJson("context", view);
        else console.log(renderContext(view));
      }),
    );

  const repo = program.command("repo").description("First-use repository configuration (stored outside the repository)");
  repo
    .command("init")
    .description("Inspect a repository (read-only) and write a pending configuration proposal. Grants nothing.")
    .option("--repo <owner/name>", "repository (default: the working directory's GitHub repository)")
    .option("--cwd <dir>", "directory to identify the repository from")
    .option("--team <KEY>", "Linear team key whose issues this repository handles, e.g. BRU")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((opts: { repo?: string; cwd?: string; team?: string; json?: boolean }) =>
      withApp(async (app) => {
        output.json = Boolean(opts.json);
        const r = await proposeConfiguration(app, { ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.team ? { team: opts.team } : {}) });
        const authorize = `orchestrator repo authorize ${r.proposal.repo}`;
        if (opts.json) {
          printJson("proposal", { repo: r.proposal.repo, file: r.proposal.file, sha256: r.proposal.sha256, inspected: r.inspected, existingConfig: r.existing, summary: r.proposal.summary, yaml: r.proposal.yaml, authorize: { command: authorize, readOnly: `${authorize} --read-only`, needsUserApproval: true, approvedBy: "a system prompt (Touch ID / password) the user confirms" } });
          return;
        }
        const s = r.proposal.summary;
        console.log(
          [
            c.bold(`Proposed configuration for ${s.repo}`) + c.dim(` (inspected ${r.inspected})`),
            r.existing ? c.yellow(`An authorized config already exists: ${r.existing}. Authorizing this proposal would need --replace.`) : "",
            `Tracker:     Linear, teams ${s.tracker.teams.join(", ")}`,
            `Agents:      implementer ${s.agents.implementer}; reviewer ${s.agents.reviewer}; planner ${s.agents.planner}`,
            `Setup:       ${s.setup.join("; ") || "none"}`,
            `Checks:      ${s.checks.join("; ") || "none"}`,
            `CI steps:    ${s.ciSteps.join("; ") || "none found"}`,
            `Execution:   ${s.execution}`,
            `GitHub:      push ${s.github.push}, draft PRs ${s.github.create_pr}, merge ${s.github.merge}`,
            `Linear:      comment ${s.linear.comment}, move issues ${s.linear.update_state}`,
            `Budget:      $${s.limits.max_run_cost_usd} and ${s.limits.max_run_minutes} min per run`,
            `Merge:       ${s.merge}`,
            ...s.warnings.map((w) => c.yellow(`warning: ${w}`)),
            "",
            `Pending proposal (grants nothing): ${r.proposal.file}`,
            `Review or edit it, then authorize:  ${authorize}   (or --read-only for dry runs only)`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }),
    );
  repo
    .command("authorize")
    .description("Authorize the pending proposal for a repository after you confirm a system prompt (Touch ID / password on macOS): writes ~/.orchestrator/repos/<owner>/<name>.yaml with an authorization record")
    .argument("<owner/name>", "repository")
    .option("--read-only", "grant no agent runs or remote writes (dry runs only)")
    .option("--replace", "replace an existing local config")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((repoName: string, opts: { readOnly?: boolean; replace?: boolean; json?: boolean }) =>
      withApp(async (app) => {
        output.json = Boolean(opts.json);
        const r = await authorizeRepository(app, repoName, { ...(opts.readOnly ? { readOnly: true } : {}), ...(opts.replace ? { replace: true } : {}) });
        const st = configStatus(repoName, app.paths);
        if (opts.json) return printJson("authorized", { repo: repoName, file: r.file, scope: r.scope, proposalSha256: r.sha256, active: st.status === "authorized" ? st.loaded.source : null });
        console.log(`${c.green("Authorized")} ${repoName} (${r.scope}) → ${r.file}`);
        if (st.status === "authorized" && st.loaded.source !== r.file) console.log(c.yellow(`note: ${st.loaded.source} takes precedence`));
      }),
    );

  const repoArg = (positional: string | undefined, opts: { repo?: string }): string => {
    const r = opts.repo ?? positional;
    if (!r) throw new RunError("name the repository: --repo owner/name");
    if (positional && opts.repo && positional.toLowerCase() !== opts.repo.toLowerCase()) throw new RunError(`two different repositories given (${positional}, ${opts.repo})`);
    return r;
  };
  repo
    .command("trust")
    .description(
      "Trusted mode (opt-in): let live runs and resumes of ONE repository start without a per-run system prompt, after you confirm a one-time prompt (Touch ID / password on macOS) showing exactly what is delegated. Repository permissions, budgets, sandbox, review and manual merging still apply; any change to the config's scope makes runs ask again until you renew",
    )
    .argument("[owner/name]", "repository (or --repo)")
    .option("--repo <owner/name>", "repository to trust")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((positional: string | undefined, opts: { repo?: string; json?: boolean }) =>
      withApp(async (app) => {
        output.json = Boolean(opts.json);
        const name = repoArg(positional, opts);
        const r = await trustRepository(app, name);
        const data = { repo: r.record.repo, state: r.state, file: r.file, trustId: r.record.id, scopeHash: r.record.scopeHash, configSource: r.record.scope.configSource, trustedBy: r.record.trustedBy, trustedAt: r.record.trustedAt, revoke: `orchestrator repo untrust ${r.record.repo}` };
        if (opts.json) return printJson("trust", data);
        console.log(
          r.state === "already_trusted"
            ? `${r.record.repo} is already trusted for its current configuration (trust ${r.record.id}, ${r.record.trustedAt.slice(0, 10)}); nothing changed.`
            : `${c.green("Trusted")} ${r.record.repo} (trust ${r.record.id}) → ${r.file}
Live runs and resumes of ${r.record.repo} now start without a per-run prompt, while ${r.record.scope.configSource} keeps this scope.
Revoke any time: orchestrator repo untrust ${r.record.repo}`,
        );
      }),
    );
  repo
    .command("untrust")
    .description("Revoke trusted mode for a repository: every live run and resume asks in a system prompt again. Needs no approval (it only removes authority)")
    .argument("[owner/name]", "repository (or --repo)")
    .option("--repo <owner/name>", "repository to stop trusting")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((positional: string | undefined, opts: { repo?: string; json?: boolean }) =>
      withApp((app) => {
        output.json = Boolean(opts.json);
        const name = repoArg(positional, opts);
        const removed = untrustRepository(app, name);
        if (opts.json) return printJson("untrust", { repo: name.toLowerCase(), removed });
        console.log(removed ? `${c.green("Revoked")} trust for ${name}: live runs and resumes ask again.` : `${name} was not trusted; nothing changed.`);
      }),
    );
  repo
    .command("trusted")
    .description("Read-only: show the authorization mode (trusted or supervised) of one repository, or of every configured or trusted repository")
    .option("--repo <owner/name>", "one repository")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((opts: { repo?: string; json?: boolean }) =>
      withApp((app) => {
        output.json = Boolean(opts.json);
        const names = opts.repo ? [opts.repo] : [...new Set([...listRepoConfigs(app.paths).map((l) => l.config.repo.toLowerCase()), ...app.trust.repos()])].sort();
        const rows = names.map((n) => {
          const t = repositoryTrust(app, n);
          return { repo: n, mode: t.state?.status === "trusted" ? "trusted" : "supervised", trust: t.state?.status ?? "unknown", detail: t.state ? describeTrustState(t.state) : t.error, configSource: t.loaded?.source ?? null };
        });
        if (opts.json) return printJson("trust_status", rows);
        if (!rows.length) return console.log("No configured repositories.");
        for (const r of rows) console.log(`${c.bold(r.repo)}  ${r.mode === "trusted" ? c.yellow("trusted") : "supervised"}  ${c.dim(r.detail ?? "")}`);
      }),
    );

  program
    .command("associate")
    .description("Record that an issue belongs to a repository after you confirm a system prompt (stored in ~/.orchestrator/associations.json)")
    .argument("<issue>", "Linear issue key or URL")
    .requiredOption("--repo <owner/name>", "the repository the issue is for")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action((issue: string, opts: { repo: string; json?: boolean }) =>
      withApp(async (app) => {
        output.json = Boolean(opts.json);
        const ref = parseIssueRef(issue);
        const st = configStatus(opts.repo, app.paths);
        if (st.status !== "authorized") throw new RunError(`${opts.repo} is not configured; authorize it first (orchestrator repo init)`);
        const saved = await confirmAssociation(app, { issue: ref.key, repo: st.loaded.config.repo, workspace: ref.workspace ?? st.loaded.config.linear.workspace ?? null });
        if (opts.json) return printJson("association", saved);
        console.log(`${c.green("Recorded")}: ${saved.issue} → ${saved.repo} (confirmed by ${saved.confirmedBy})`);
      }),
    );
}

export function renderContext(ctx: RequestContext): string {
  const ok = (b: boolean) => (b ? c.green("✓") : c.red("✗"));
  const r = ctx.repository;
  const lines: string[] = [];
  lines.push(c.bold(`${ctx.request.issue.key}${ctx.issue.title ? ` — ${ctx.issue.title}` : ""}`) + (ctx.issue.state ? c.dim(` [${ctx.issue.state}]`) : ""));
  lines.push(`${ok(r.status === "resolved")} repository   ${r.repo ?? "—"}  ${c.dim(r.reason)}`);
  const conf = ctx.configuration;
  lines.push(`${ok(conf.status === "authorized")} config       ${conf.status === "authorized" ? `${conf.source} (${conf.scope}${conf.authorizedBy ? ` by ${conf.authorizedBy}` : ""})` : conf.status === "missing" ? `none — first use (would live at ${conf.expected})` : conf.status === "invalid" ? conf.error : "—"}`);
  lines.push(`${ok(!ctx.linear.problem)} linear       ${ctx.linear.problem ?? `${ctx.linear.source}${ctx.linear.workspace ? `, workspace ${ctx.linear.workspace}` : ""}`}`);
  if (ctx.association) lines.push(`${ok(ctx.association.verified)} association  ${ctx.association.verified ? ctx.association.evidence.map((e) => e.detail).join("; ") : ctx.association.remedy}`);
  if (ctx.runs.active.length) lines.push(`${c.yellow("●")} active runs  ${ctx.runs.active.map((x) => `${x.id} ${x.state}${x.driving ? " (running)" : ""}`).join(", ")}`);
  else if (ctx.runs.recent.length) lines.push(`  recent runs  ${ctx.runs.recent.map((x) => `${x.id} ${x.mode} ${x.state}`).join(", ")}`);
  if (ctx.trust) lines.push(`${ctx.trust.mode === "trusted" ? c.yellow("●") : " "} authorization ${ctx.trust.mode}: ${ctx.trust.detail}`);
  if (ctx.approval && ctx.trust?.mode !== "trusted") lines.push(`${ok(ctx.approval.available)} approval     ${ctx.approval.detail}`);
  lines.push("", c.bold("Modes"));
  for (const m of ctx.modes) lines.push(`  ${ok(m.available)} ${m.id.padEnd(24)} ${m.available ? c.dim(m.command) : c.dim(`unavailable: ${m.missing.join("; ")}`)}`);
  for (const w of ctx.warnings) lines.push(c.yellow(`warning: ${w}`));
  if (ctx.nextActions.length) {
    lines.push("", c.bold("Next"));
    for (const a of ctx.nextActions) lines.push(`  ${a.command}${a.needsUserApproval ? c.yellow("  (needs your approval)") : ""}${a.trusted ? c.yellow("  (trusted: no per-run prompt)") : ""}${a.userRunsIt ? c.yellow("  (run it yourself)") : ""}\n    ${c.dim(a.description)}`);
  }
  return lines.join("\n");
}
