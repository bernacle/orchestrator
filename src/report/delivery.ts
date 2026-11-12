import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../core/redact.js";
import type { RunRecord, Store } from "../core/store.js";
import { correctionsUsed, runCriteria, type RunContext } from "../core/workflow.js";
import { criteriaReport, decideReview, type CriterionReport, type Finding } from "../planning/review.js";

/**
 * One persistent account of a run's outcome, rebuilt from durable state only (the run record and
 * its timeline), so a crash or a second process always produces the same report. Written to
 * runs/<id>/delivery.{md,json} whenever a drive or a reconciliation settles the run.
 */

export type DeliveryOutcome = "completed" | "delivered" | "not_deliverable" | "waiting_for_ci" | "blocked" | "failed" | "cancelled" | "in_progress" | "dry_run";

export interface DeliveryReport {
  schemaVersion: 1;
  /** The run's last update: the report describes the run as of then. */
  asOf: string;
  outcome: DeliveryOutcome;
  headline: string;
  /** What a person still has to decide or do, most important first. Empty when nothing is left. */
  actionsForYou: string[];
  issue: { key: string; title: string | null; url: string | null };
  repo: string;
  run: { id: string; mode: string; state: string; reason: string | null; createdAt: string; authorization: string | null };
  pr: {
    number: number;
    url: string;
    reviewedSha: string | null;
    /** The engine marked its draft ready for review (pull_request.mark_ready_when_delivered). */
    markedReady: boolean;
    merged: RunContext["merged"] | null;
  } | null;
  checks: Array<{ name: string; ok: boolean; optional: boolean }>;
  ci: { state: string; sha: string; checks: Array<{ name: string; bucket: string }> } | null;
  criteria: CriterionReport[];
  openFindings: Finding[];
  minorRound: { status: string; approvedSha: string; findings: string[]; reason: string | null } | null;
  openQuestions: string[];
  reviewHistory: Array<{ attempt: number; trigger: string; verdict: string; approved: boolean; reviewedSha: string; findings: string[]; reused: boolean }>;
  screenshots: Array<{ path: string; url: string | null }>;
  recovery: Array<{ ts: string; type: string; message: string }>;
  usage: {
    /** Claude Code's API-equivalent estimate. On a subscription it is not what you are charged. */
    apiEquivalentUsd: number;
    capUsd: number | null;
    correctionRounds: number;
    note: string;
    rounds: Array<{ attempt: number; trigger: string; apiEquivalentUsd: number | null; minutes: number | null }>;
  };
  completion: { at: string | null; reason: string | null };
}

const RECOVERY_EVENTS = new Set([
  "step.retry",
  "run.interrupted",
  "run.resume",
  "run.resumed",
  "run.resume_refused",
  "minor.rejected",
  "minor.restored",
  "review.declined",
  "pr.body_update_failed",
  // Bounded recovery: one retry of a crashed or unusable agent, a run-scoped branch around a
  // collision, and the failed CI steps' logs handed to the implementer.
  "agent.retry",
  "agent.retry_result",
  "branch.scoped",
  "ci.logs",
]);

export function buildDeliveryReport(store: Store, run: RunRecord<RunContext>): DeliveryReport {
  const c = run.context;
  const criteria = criteriaReport(c.lastReview ?? null, runCriteria(c));
  const unmet = criteria.filter((x) => x.status === "not_met");
  const needsHuman = criteria.filter((x) => x.status === "needs_human");
  const checks = (c.lastChecks ?? []).map((k) => ({ name: k.name, ok: k.ok, optional: k.optional }));
  const checksOk = checks.every((k) => k.ok || k.optional);
  const ci = c.lastCi ?? null;
  const m = c.merge ?? null;
  const prRef = c.pr ?? null;
  const decision = c.lastReview ? decideReview(c.lastReview, [], []) : null;
  const openFindings = c.reviewApproved && decision ? decision.nonBlocking : [];
  const openQuestions = c.agentPlan?.open_questions ?? [];
  const events = store.events(run.id);
  const reviewedSha = c.reviewedSha ?? null;

  // Delivered means every gate holds on the PR head as last checked: never inferred from a state name alone.
  const delivered =
    run.state === "READY_TO_MERGE" &&
    Boolean(m?.eligible) &&
    Boolean(c.reviewApproved) &&
    m?.headSha === reviewedSha &&
    (m?.ciState === "pass" || m?.ciState === "none") &&
    checksOk &&
    unmet.length === 0;

  const prLabel = prRef ? `PR #${prRef.number}` : "the PR";
  let outcome: DeliveryOutcome;
  let headline: string;
  const actions: string[] = [];
  if (run.mode === "dry_run") {
    outcome = "dry_run";
    headline = "Dry run: nothing was changed.";
  } else if (run.state === "COMPLETED") {
    outcome = "completed";
    const mg = c.merged;
    headline = `Completed: ${prLabel} was merged${mg?.by ? ` by ${mg.by}` : ""}; the run is closed.`;
    if (mg?.delivered === false) {
      headline += ` It was merged before Orchestrator delivered it: the run was ${mg.stateAtMerge}${mg.reasonAtMerge ? ` (${mg.reasonAtMerge})` : ""}, so its checks, CI or review did not all pass on what was merged.`;
    }
    if (mg && !mg.headIsReviewed) {
      headline += ` ${mg.outsideCommits ? `${mg.outsideCommits.length} commit(s)` : "Commits"} added outside Orchestrator after its review were merged too; Orchestrator did not review them.`;
    }
  } else if (run.state === "CANCELLED") {
    outcome = "cancelled";
    headline = `Cancelled: ${run.reason ?? "cancelled"}.`;
  } else if (run.state === "FAILED") {
    outcome = "failed";
    headline = `Failed: ${run.reason ?? "unknown reason"}.`;
    actions.push("Inspect the run (orchestrator status / logs) before anything else; a failed run is never resumed automatically. Start a new run when the cause is fixed.");
  } else if (run.state === "BLOCKED") {
    outcome = "blocked";
    headline = `Blocked: ${run.reason ?? "unknown reason"}.`;
    actions.push(`Resolve the block, then resume: orchestrator resume ${run.id}`);
  } else if (delivered) {
    outcome = "delivered";
    headline = `Delivered: ${prLabel} is ${m?.ciState === "pass" ? "CI-green, " : ""}independently reviewed at ${reviewedSha?.slice(0, 8)}, and ready for your review and merge.`;
    actions.push(`Review and merge ${prLabel}${prRef ? ` (${prRef.url})` : ""}. Orchestrator records the merge by itself.`);
  } else if (run.state === "READY_TO_MERGE") {
    outcome = "not_deliverable";
    const reasons = [...(m?.reasons ?? []), ...(checksOk ? [] : ["a required check failed"]), ...(unmet.length ? [`${unmet.length} acceptance criteria not met`] : [])];
    headline = `Not deliverable yet: ${reasons.join("; ") || "merge eligibility not established"}.`;
    actions.push(...reasons.map((r) => `Resolve: ${r}`));
  } else if (run.state === "WAITING_FOR_CI") {
    outcome = "waiting_for_ci";
    headline = `Waiting for CI on ${prLabel}${ci ? ` (${ci.state} on ${ci.sha.slice(0, 8)})` : ""}.`;
  } else {
    outcome = "in_progress";
    headline = `In progress: ${run.state}.`;
  }
  if (outcome === "delivered" || outcome === "not_deliverable" || outcome === "waiting_for_ci") {
    for (const x of needsHuman) actions.push(`Judge ${x.id}: ${x.text}${x.evidence ? ` (reviewer: ${x.evidence})` : ""}`);
    for (const q of openQuestions) actions.push(`Confirm the implementer's choice: ${q}`);
    if (openFindings.length) actions.push(`Decide on ${openFindings.length} open non-blocking finding(s): ${openFindings.map((f) => `${f.id} [${f.severity}]`).join(", ")}`);
  }

  const shotsRound = [...c.rounds].reverse().find((r) => r.screenshots?.files.length);
  const screenshots = (shotsRound?.screenshots?.files ?? []).map((f) => ({
    path: f.path,
    url: reviewedSha ? `https://github.com/${run.repo}/blob/${reviewedSha}/${f.path.split("/").map(encodeURIComponent).join("/")}?raw=true` : null,
  }));
  const terminalEvent = [...events].reverse().find((e) => e.type === "state.changed" && ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(e.state));
  const auth = c.authorization;
  return {
    schemaVersion: 1,
    asOf: run.updatedAt,
    outcome,
    headline,
    actionsForYou: actions,
    issue: { key: run.issueKey, title: c.issue?.title ?? null, url: c.issue?.url ?? null },
    repo: run.repo,
    run: {
      id: run.id,
      mode: run.mode,
      state: run.state,
      reason: run.reason,
      createdAt: run.createdAt,
      authorization: auth ? (auth.basis === "trust" ? `repository trust ${auth.trust?.id ?? ""} (granted by ${auth.user})` : `approved by ${auth.user} via ${auth.channel}`) : null,
    },
    pr: prRef ? { number: prRef.number, url: prRef.url, reviewedSha, markedReady: events.some((e) => e.type === "pr.marked_ready"), merged: c.merged ?? null } : null,
    checks,
    ci,
    criteria,
    openFindings,
    minorRound: c.minorRound ? { status: c.minorRound.status, approvedSha: c.minorRound.approvedSha, findings: c.minorRound.findings.map((f) => f.id), reason: c.minorRound.reason ?? null } : null,
    openQuestions,
    reviewHistory: c.rounds
      .filter((r) => r.review)
      .map((r) => ({ attempt: r.attempt, trigger: r.trigger, verdict: r.review!.verdict, approved: r.review!.approved, reviewedSha: r.review!.reviewedSha, findings: r.review!.findings.map((f) => `${f.id} [${f.severity}] ${f.title}`), reused: Boolean(r.review!.reused) })),
    screenshots,
    recovery: events.filter((e) => RECOVERY_EVENTS.has(e.type)).map((e) => ({ ts: e.ts, type: e.type, message: e.message })),
    usage: {
      apiEquivalentUsd: Math.round((c.costUsd ?? 0) * 100) / 100,
      capUsd: c.plan?.limits?.maxRunCostUsd ?? null,
      correctionRounds: correctionsUsed(run),
      note: "API-equivalent usage as estimated by Claude Code (planner and implementer). With a Claude subscription this is not an amount you are charged. The Codex reviewer reports no usage.",
      rounds: c.rounds.map((r) => ({ attempt: r.attempt, trigger: r.trigger, apiEquivalentUsd: r.implementer?.costUsd ?? null, minutes: r.implementer ? Math.round(r.implementer.durationMs / 6_000) / 10 : null })),
    },
    completion: {
      at: ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(run.state) ? (terminalEvent?.ts ?? run.updatedAt) : null,
      reason: ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(run.state) ? run.reason : null,
    },
  };
}

const STATUS_MARK: Record<string, string> = { met: "✅ met", not_met: "❌ not met", needs_human: "⚠️ needs your judgement" };

export function renderDeliveryMarkdown(r: DeliveryReport): string {
  const out: string[] = [];
  const push = (...l: string[]) => out.push(...l);
  push(`# ${r.issue.key}: ${r.issue.title ?? ""}`.trimEnd(), "", `**${r.headline}**`, "");
  if (r.actionsForYou.length) push("## What's left for you", ...r.actionsForYou.map((a) => `- ${a}`), "");
  push(
    "## Run",
    `- Repository: ${r.repo}`,
    `- Run: \`${r.run.id}\` (${r.run.mode}), state **${r.run.state}**${r.run.reason ? `: ${r.run.reason}` : ""}`,
    ...(r.run.authorization ? [`- Authorization: ${r.run.authorization}`] : []),
    `- Started ${r.run.createdAt}; report as of ${r.asOf}${r.completion.at ? `; settled ${r.completion.at}` : ""}`,
    "",
  );
  if (r.pr) {
    push("## Pull request", `- ${r.pr.url}${r.pr.markedReady ? " (marked ready for review by Orchestrator)" : ""}`, `- Reviewed commit: ${r.pr.reviewedSha ? `\`${r.pr.reviewedSha.slice(0, 12)}\`` : "none"}`);
    const mg = r.pr.merged;
    if (mg) {
      push(`- Merged${mg.by ? ` by ${mg.by}` : ""}${mg.at ? ` at ${mg.at}` : ""}${mg.mergeCommitSha ? ` as \`${mg.mergeCommitSha.slice(0, 12)}\`` : ""}, head \`${mg.headSha.slice(0, 12)}\``);
      if (!mg.headIsReviewed) {
        push(`- ⚠️ The merged head is not the reviewed commit. Added outside Orchestrator, not reviewed by it:`);
        push(...(mg.outsideCommits?.length ? mg.outsideCommits.map((x) => `  - \`${x.sha.slice(0, 12)}\` ${x.message}`) : ["  - (could not be listed)"]));
      }
    }
    push("");
  }
  push("## Checks (run by the orchestrator)", ...(r.checks.length ? r.checks.map((k) => `- ${k.ok ? "✅" : k.optional ? "⚪" : "❌"} ${k.name}`) : ["- none recorded"]), "");
  push("## CI", r.ci ? `- ${r.ci.state} on \`${r.ci.sha.slice(0, 12)}\`${r.ci.checks.length ? `: ${r.ci.checks.map((k) => `${k.name} (${k.bucket})`).join(", ")}` : ""}` : "- not observed yet", "");
  push("## Acceptance criteria", ...(r.criteria.length ? r.criteria.map((x) => `- ${STATUS_MARK[x.status]} **${x.id}** ${x.text}${x.evidence ? ` — ${x.evidence}` : ""}`) : ["- none stated"]), "");
  if (r.openFindings.length || r.minorRound) {
    push("## Open findings");
    push(...r.openFindings.map((f) => `- ${f.id} [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`));
    if (r.minorRound) push(`- Minor-finding round: ${r.minorRound.status} (${r.minorRound.findings.join(", ")})${r.minorRound.reason ? `: ${r.minorRound.reason}` : ""}`);
    push("");
  }
  if (r.openQuestions.length) push("## Product decisions the implementer made conservatively", ...r.openQuestions.map((q) => `- ${q}`), "");
  if (r.reviewHistory.length) {
    push("## Review history");
    push(...r.reviewHistory.map((h) => `- Round ${h.attempt} (${h.trigger}) on \`${h.reviewedSha.slice(0, 12)}\`: ${h.approved ? "approved" : h.verdict}${h.reused ? " (approval of the same commit reused)" : ""}${h.findings.length ? ` — ${h.findings.join("; ")}` : ""}`));
    push("");
  }
  if (r.screenshots.length) push("## Screenshots", ...r.screenshots.map((s) => `- ${s.url ? `[${s.path}](${s.url})` : s.path}`), "");
  push("## Recovery", ...(r.recovery.length ? r.recovery.map((e) => `- ${e.ts} ${e.type}: ${e.message}`) : ["- none needed"]), "");
  push(
    "## Usage",
    `- API-equivalent usage: $${r.usage.apiEquivalentUsd.toFixed(2)}${r.usage.capUsd !== null ? ` of the $${r.usage.capUsd} cap` : ""}; ${r.usage.correctionRounds} correction round(s)`,
    `- ${r.usage.note}`,
    "",
  );
  return out.join("\n");
}

/** Write runs/<id>/delivery.{md,json}; the artifact table gets a row only when the content changed. */
export function writeDeliveryReport(store: Store, runsDir: string, redactor: Redactor, run: RunRecord<RunContext>): { report: DeliveryReport; path: string } {
  const report = redactor.redactValue(buildDeliveryReport(store, run)) as DeliveryReport;
  const dir = join(runsDir, run.id);
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string, string]> = [
    ["delivery.md", "delivery report", redactor.redact(renderDeliveryMarkdown(report))],
    ["delivery.json", "delivery report (json)", JSON.stringify(report, null, 2)],
  ];
  const known = store.artifacts(run.id);
  for (const [name, label, content] of files) {
    const path = join(dir, name);
    const sha256 = createHash("sha256").update(content).digest("hex");
    writeFileSync(path, content);
    const last = [...known].reverse().find((a) => a.label === label);
    if (last?.sha256 !== sha256) store.recordArtifact({ runId: run.id, kind: "report", label, path, sha256, bytes: Buffer.byteLength(content) });
  }
  return { report, path: join(dir, "delivery.md") };
}

/**
 * The one notification a run's current state deserves, or null. Keys make each one fire once:
 * a block per BLOCKED transition, delivery per reviewed commit, completion and failure once.
 */
export function notificationFor(store: Store, run: RunRecord<RunContext>, report: DeliveryReport): { key: string; title: string; message: string } | null {
  if (run.mode !== "supervised") return null;
  const title = `Orchestrator · ${run.issueKey}`;
  const pr = report.pr ? `PR #${report.pr.number}` : "the PR";
  switch (report.outcome) {
    case "blocked": {
      const block = [...store.events(run.id)].reverse().find((e) => e.type === "state.changed" && e.state === "BLOCKED");
      return { key: `blocked:${block?.id ?? run.version}`, title, message: `Blocked — needs you: ${run.reason ?? "see orchestrator status"}` };
    }
    case "failed":
      return { key: "failed", title, message: `Failed: ${run.reason ?? "see orchestrator status"}` };
    case "delivered": {
      const judge = report.criteria.filter((x) => x.status === "needs_human").length;
      return {
        key: `delivered:${report.pr?.reviewedSha ?? ""}`,
        title,
        message: `${pr} is ready for your review${report.pr?.markedReady ? "" : " (still a draft)"}: ${report.ci?.state === "pass" ? "CI green, " : ""}independently reviewed.${judge ? ` ${judge} acceptance criteri${judge === 1 ? "on needs" : "a need"} your judgement.` : ""}`,
      };
    }
    case "completed": {
      const mg = report.pr?.merged;
      return {
        key: "completed",
        title,
        message: `${pr} merged; run completed.${mg?.delivered === false ? " It was merged before Orchestrator delivered it." : ""}${mg && !mg.headIsReviewed ? " The merged head includes commits Orchestrator did not review." : ""}`,
      };
    }
    case "cancelled":
      return run.reason?.includes("closed without merging") ? { key: "cancelled", title, message: `${pr} was closed without merging; run cancelled.` } : null;
    default:
      return null;
  }
}
