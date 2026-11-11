import type { ExecutionPlan } from "../planning/plan.js";
import type { ArtifactRecord, EffectRecord, RunEvent, RunRecord } from "../core/store.js";
import { TERMINAL_STATES, type RunState } from "../core/states.js";

// ---- tiny color helper ---------------------------------------------------------------

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33), blue: wrap(34), cyan: wrap(36) };

export function stateColor(state: RunState): (s: string) => string {
  if (state === "COMPLETED" || state === "MERGED" || state === "READY_TO_MERGE") return c.green;
  if (state === "FAILED") return c.red;
  if (state === "BLOCKED" || state === "CANCELLED") return c.yellow;
  return c.cyan;
}

const yesNo = (ok: boolean) => (ok ? "✓" : "✗");
const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 8) : "—");

// ---- plan ----------------------------------------------------------------------------

export function renderPlanMarkdown(p: ExecutionPlan): string {
  const L: string[] = [];
  const push = (...lines: string[]) => L.push(...lines);
  const repo = p.repository;

  push(`# Execution plan — ${p.issue.key}: ${p.issue.title}`, "");
  push(`Run \`${p.runId}\` · mode **${p.mode === "dry_run" ? "dry run (no side effects)" : "supervised"}** · generated ${p.generatedAt}`, `Config: \`${p.configSource}\``, "");

  if (p.blockers.length) {
    push("## ⛔ Blockers — a live run would stop at PLANNING", ...p.blockers.map((b) => `- ${b}`), "");
  } else {
    push("## ✅ No blockers — a live run could proceed", "");
  }
  if (p.warnings.length) push("## Warnings", ...p.warnings.map((w) => `- ${w}`), "");

  push("## Issue");
  push(
    `- **${p.issue.key}** [${p.issue.state.name}] · team ${p.issue.team.key} · project ${p.issue.project ?? "—"} · priority ${p.issue.priority.label}`,
    `- Labels: ${p.issue.labels.join(", ") || "—"} · assignee: ${p.issue.assignee ?? "—"} · ${p.issue.commentCount} comment(s) · updated ${p.issue.updatedAt}`,
    ...(p.issue.url ? [`- ${p.issue.url}`] : []),
    "",
  );
  push(`### Acceptance criteria (${p.acceptanceCriteria.source === "none" ? "none found" : `from ${p.acceptanceCriteria.source}`})`);
  push(...(p.acceptanceCriteria.criteria.length ? p.acceptanceCriteria.criteria.map((x) => `- ${x}`) : ["- _none stated_"]), "");
  if (p.acceptanceCriteria.derived?.length) {
    push("Derived from the issue's scope by the read-only planner (the reviewer judges these too):", ...p.acceptanceCriteria.derived.map((x) => `- ${x}`), "");
  }

  push("### Dependencies");
  if (p.dependencies.length === 0) push("- none");
  else {
    push("| Issue | Linear state | Classification | Blocks? | Reason |", "|---|---|---|---|---|");
    for (const d of p.dependencies) push(`| ${d.key} ${d.title.replace(/\|/g, "/").slice(0, 60)} | ${d.state.name} | **${d.classification}** | ${d.blocking ? "yes" : "no"} | ${d.reason.replace(/\|/g, "/")} |`);
    push("", "<details><summary>Evidence per dependency</summary>", "");
    for (const d of p.dependencies) {
      push(`- **${d.key}** → ${d.classification}`);
      for (const e of d.evidence) push(`  - [${e.kind}] ${e.detail}${e.url ? ` (${e.url})` : ""}`);
    }
    push("", "</details>");
  }
  const r = p.readiness;
  push(`- Parent: ${r.parent ? `${r.parent.key} "${r.parent.title}" [${r.parent.state.name}]` : "none"} · open sub-issues: ${r.openChildren.map((x) => x.key).join(", ") || "none"} · blocks: ${r.blocks.map((x) => x.key).join(", ") || "none"}`, "");
  if (p.brief) {
    push("### Operator brief", `\`${p.brief.source}\` (sha256 \`${p.brief.sha256.slice(0, 12)}\`), authoritative over the issue text for scope.`, ...p.brief.decisions.map((x) => `- ${x}`), "");
  }

  push("## Repository");
  push(
    `- ${repo.repo} · base \`${repo.baseBranch}\` @ \`${short(repo.baseSha)}\` · ${repo.visibility} · our access: ${repo.viewerPermission}`,
    `- Protection: ${repo.protection.protected ? `protected; required checks: ${repo.protection.requiredChecks.join(", ") || "none"}; required approvals: ${repo.protection.requiredApprovals}` : "**none** (no branch protection, no rulesets)"}`,
    `- Inspected \`${repo.inspectedRef}\` @ \`${short(repo.inspectedSha)}\` in \`${repo.clonePath}\``,
    `- Package manager: ${repo.packageManager ?? "—"} · Node engine: ${repo.nodeEngine ?? "—"} · workspaces: ${repo.workspaces.join(", ") || "—"}`,
    `- Toolchain: Node ${p.toolchain.requested ?? "(any)"}${p.toolchain.from ? ` (${p.toolchain.from})` : ""} → ${p.toolchain.version ?? "?"} via ${p.toolchain.source}${p.toolchain.binDir ? ` (\`${p.toolchain.binDir}\`)` : ""}${p.toolchain.detail ? ` — ${p.toolchain.detail}` : ""}`,
    `- Guidance the agents are told to follow: ${repo.guidanceFiles.join(", ") || "none"}`,
    "",
  );

  push("## Workspace");
  push(
    `- Branch \`${p.workspace.branch}\` (exists locally: ${p.workspace.branchExists.local ? "yes" : "no"}, on origin: ${p.workspace.branchExists.remote ? "yes" : "no"})`,
    `- Worktree \`${p.workspace.worktreePath}\``,
    `- Existing PR: ${p.workspace.existingPr ? `#${p.workspace.existingPr.number} (${p.workspace.existingPr.state}) ${p.workspace.existingPr.url}` : "none"}`,
    "",
  );

  const iso = p.isolation;
  push(`## Isolation — ${iso.ok ? "✅ available" : iso.required ? "⛔ required but unavailable (live run blocked)" : "⚠ unavailable (isolation.require=false)"}`);
  push(
    `- Setup and checks: ${iso.checks.available ? iso.checks.detail : `**${iso.checks.detail}**`}; setup network=${iso.checks.setupNetwork}, checks network=${iso.checks.checksNetwork}`,
    ...iso.agents.map((a) => `- ${a.role} (${a.adapter}): ${a.ok ? "" : "**unavailable** — "}${a.detail}`),
    `- Environment: ${iso.environment}`,
    `- Tripwires: ${iso.tripwires} paths outside the worktree fingerprinted around every agent and check step`,
    "- Limitations:",
    ...iso.limitations.map((l) => `  - ${l}`),
    "",
  );

  push("## Limits and expected cost");
  push(`- Max correction rounds: ${p.limits.maxFixAttempts} · run cost cap $${p.limits.maxRunCostUsd.toFixed(2)} · wall clock ${p.limits.maxRunMinutes} min`, ...p.cost.lines.map((l) => `- ${l}`), `- Worst-case metered spend: $${p.cost.maxMeteredUsd.toFixed(2)}`, "");

  push("## Agent assignments", "| Role | Adapter | Provider | Model | Access |", "|---|---|---|---|---|");
  for (const a of p.agents) push(`| ${a.role} | ${a.adapter} | ${a.provider} | ${a.model} | ${a.access} |`);
  push("", "Invariants:", ...p.invariants.map((i) => `- ${yesNo(i.ok)} ${i.rule} — ${i.detail}`), "");

  push("## Checks", "| Kind | Name | Command | Script | In CI | Timeout |", "|---|---|---|---|---|---|");
  for (const k of p.checks) {
    push(`| ${k.kind} | ${k.name}${k.optional ? " (optional)" : ""} | \`${k.command}\` | ${k.verification === "script-found" ? "✓" : k.verification === "script-missing" ? "✗ missing" : "n/a"} | ${k.inCi ? "✓" : "—"} | ${k.timeoutMinutes}m |`);
  }
  push("", `CI workflows: ${p.ci.workflows.join(", ") || "none"}${p.ci.notCoveredLocally.length ? ` · CI-only steps: ${p.ci.notCoveredLocally.map((s) => `\`${s}\``).join(", ")}` : " · every CI step is also run locally"}`, "");

  if (p.agentPlan) {
    push("## Implementation plan (read-only planner)", p.agentPlan.summary, "", ...p.agentPlan.steps.map((s, i) => `${i + 1}. ${s}`), "");
    if (p.agentPlan.files.length) push("Files:", ...p.agentPlan.files.map((f) => `- \`${f.path}\` — ${f.change}`), "");
    if (p.agentPlan.tests.length) push("Tests:", ...p.agentPlan.tests.map((t) => `- ${t}`), "");
    if (p.agentPlan.risks.length) push("Risks:", ...p.agentPlan.risks.map((r) => `- ${r}`), "");
    if (p.agentPlan.open_questions.length) push("Open questions:", ...p.agentPlan.open_questions.map((q) => `- ${q}`), "");
  }

  push("## What would happen", "");
  for (const s of p.stages) {
    push(`### ${s.state}`, s.summary);
    for (const a of s.actions) {
      const gate = a.permission === "read" ? "read" : a.allowedLive ? `allowed: ${a.permission}` : `**not permitted**: ${a.gate}`;
      push(`- ${a.description} _(${gate})_${a.command ? `\n  \`${a.command}\`` : ""}`);
    }
    push(`- → ${s.exits.join("; ")}`, "");
  }

  push("## Policy");
  push(
    `- merge.mode **${p.policy.merge.mode}** · require_ci ${p.policy.merge.require_ci} · require_independent_review ${p.policy.merge.require_independent_review} · max_fix_attempts ${p.policy.merge.max_fix_attempts}`,
    `- Blocking review severities: ${p.policy.reviewBlockingSeverities.join(", ")}`,
    ...Object.entries(p.policy.permissions).map(([k, v]) => `- ${yesNo(v.allowed)} ${k} — ${v.reason}`),
    ...p.policy.autoMergePreview.map((x) => `- ${x}`),
    "",
  );
  return L.join("\n");
}

// ---- status ----------------------------------------------------------------------------

export function renderStatusTable(runs: RunRecord[], leaseHolder: (id: string) => string | null): string {
  if (runs.length === 0) return "No runs yet. Try: orchestrator run <ISSUE> --repo owner/name --dry-run";
  const rows = runs.map((r) => {
    const live = leaseHolder(r.id) ? " ●" : "";
    return [r.id, r.issueKey, r.repo, r.mode === "dry_run" ? "dry-run" : "live", stateColor(r.state)(r.state) + live, r.updatedAt.replace("T", " ").slice(0, 19), (r.reason ?? "").slice(0, 70)];
  });
  const header = ["RUN", "ISSUE", "REPO", "MODE", "STATE", "UPDATED", "REASON"];
  const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => strip(row[i]!).length)));
  const fmt = (row: string[]) => row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - strip(cell).length))).join("  ");
  return [c.dim(fmt(header)), ...rows.map(fmt), "", c.dim("● = a process is driving this run now")].join("\n");
}

interface RunDetailContext {
  plan?: ExecutionPlan;
  branch?: string;
  worktreePath?: string;
  rounds?: Array<{ attempt: number; trigger: string; commitSha?: string | null; changedFiles?: unknown[]; checks?: Array<{ name: string; ok: boolean }>; review?: { verdict: string; blocking: number; findings: unknown[] } }>;
  pr?: { number: number; url: string } | null;
  merge?: { eligible: boolean; reasons: string[]; autoMergeBlockers: string[] } | null;
  costUsd?: number;
  options?: { origin?: { kind: string } | null };
}

export function renderRunDetail(run: RunRecord, artifacts: ArtifactRecord[], effects: EffectRecord[], holder: string | null): string {
  const ctx = run.context as RunDetailContext;
  const L: string[] = [];
  L.push(`${c.bold(run.id)}  ${run.issueKey} on ${run.repo}  ${run.mode === "dry_run" ? c.dim("[dry run]") : c.bold("[live]")}`);
  L.push(`State: ${stateColor(run.state)(run.state)}${run.blockedFrom ? ` (from ${run.blockedFrom})` : ""}${holder ? c.dim(`  driven by ${holder}`) : ""}`);
  if (run.reason) L.push(`Reason: ${run.reason}`);
  L.push(`Correction rounds: ${run.attempt}/${ctx.plan?.policy.merge.max_fix_attempts ?? "?"}${ctx.costUsd ? ` · agent cost ≈ $${ctx.costUsd.toFixed(2)}` : ""}${ctx.options?.origin ? ` · started from ${ctx.options.origin.kind}` : ""}`);
  if (ctx.branch) L.push(`Branch: ${ctx.branch}${ctx.worktreePath ? `  Worktree: ${ctx.worktreePath}` : ""}`);
  if (ctx.pr) L.push(`PR: #${ctx.pr.number} ${ctx.pr.url}`);
  if (ctx.merge) L.push(`Merge: ${ctx.merge.eligible ? c.green("eligible") : c.yellow(`not eligible — ${ctx.merge.reasons.join("; ")}`)}${ctx.merge.autoMergeBlockers.length ? c.dim(` · no auto-merge: ${ctx.merge.autoMergeBlockers.join("; ")}`) : ""}`);
  for (const r of ctx.rounds ?? []) {
    const checks = r.checks?.map((k) => `${yesNo(k.ok)}${k.name}`).join(" ") ?? "—";
    const review = r.review ? `${r.review.verdict} (${r.review.findings.length} findings, ${r.review.blocking} blocking)` : "—";
    L.push(`  round ${r.attempt} [${r.trigger}] commit ${short(r.commitSha)} · ${r.changedFiles?.length ?? 0} files · checks ${checks} · review ${review}`);
  }
  if (ctx.plan?.blockers.length) L.push("", c.yellow("Blockers:"), ...ctx.plan.blockers.map((b) => `  - ${b}`));
  if (effects.length) {
    L.push("", c.bold("External actions:"));
    for (const e of effects) L.push(`  ${e.status.padEnd(9)} ${e.permission.padEnd(18)} ${e.description}${e.error ? c.red(` — ${e.error}`) : ""}`);
  }
  if (artifacts.length) {
    L.push("", c.bold("Artifacts:"));
    for (const a of artifacts) L.push(`  ${a.kind.padEnd(13)} ${a.path}`);
  }
  L.push("", nextStep(run));
  return L.join("\n");
}

export function nextStep(run: RunRecord): string {
  if (TERMINAL_STATES.has(run.state)) return c.dim(run.mode === "dry_run" ? `Next: review the plan, then start a supervised run with --execute.` : "Run finished.");
  switch (run.state) {
    case "BLOCKED":
      return run.blockedFrom === "PLANNING"
        ? `Next: resolve the blockers (orchestrator plan ${run.id}), or for dependencies that are not prerequisites: orchestrator resume ${run.id} --accept-dependency <KEY>`
        : `Next: resolve the reason above, then: orchestrator resume ${run.id}`;
    case "WAITING_FOR_CI":
      return `Next: orchestrator resume ${run.id}  (re-checks CI)`;
    case "READY_TO_MERGE":
      return `Next: review and merge the PR yourself. The run completes by itself (orchestrator watch ${run.id} follows it; any status call records it)`;
    default:
      return `Next: orchestrator resume ${run.id}  (if no process is driving it)`;
  }
}

export function renderEvent(e: Pick<RunEvent, "ts" | "level" | "state" | "type" | "message">): string {
  const level = e.level === "error" ? c.red("ERR ") : e.level === "warn" ? c.yellow("WARN") : e.level === "debug" ? c.dim("DBG ") : c.dim("INFO");
  return `${c.dim(e.ts.slice(11, 19))} ${level} ${stateColor(e.state)(e.state.padEnd(14))} ${e.message}`;
}
