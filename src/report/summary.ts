import { buildDeliveryReport, type DeliveryOutcome } from "./delivery.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../config/load.js";
import { readShimTarget, shimPath } from "../skills/launcher.js";
import type { RunRecord, Store } from "../core/store.js";
import { TERMINAL_STATES } from "../core/states.js";
import type { RunContext } from "../core/workflow.js";
import { nextStep } from "./render.js";

/**
 * Versioned, machine-readable views for the provider skills (and anything else scripting the
 * CLI). `schemaVersion` changes only on incompatible changes; fields may be added.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface Envelope<K extends string, T> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  kind: K;
  data: T;
}

export function envelope<K extends string, T>(kind: K, data: T): Envelope<K, T> {
  return { schemaVersion: JSON_SCHEMA_VERSION, kind, data };
}

export interface RunSummary {
  id: string;
  issue: { key: string; title: string | null; url: string | null };
  repo: string;
  mode: "dry_run" | "supervised";
  state: string;
  terminal: boolean;
  reason: string | null;
  blockedFrom: string | null;
  /** A process is driving this run right now. */
  driving: boolean;
  createdAt: string;
  updatedAt: string;
  planPath: string | null;
  blockers: string[];
  warnings: string[];
  budget: { costUsd: number; maxRunCostUsd: number | null; maxRunMinutes: number | null };
  checks: Array<{ name: string; ok: boolean; optional: boolean; exitCode: number | null }> | null;
  review: { verdict: string; approved: boolean; blocking: number; summary: string; findingCount: number } | null;
  /** Every acceptance criterion with the latest review's verdict (`needs_human`: a person must judge it). */
  criteria: Array<{ id: string; text: string; source: string; status: string; evidence: string }> | null;
  /** The bounded round for actionable minor findings, when one ran. */
  minorRound: { status: string; approvedSha: string; findings: string[]; reason: string | null } | null;
  pr: { number: number; url: string } | null;
  merge: { eligible: boolean; ciState: string; reasons: string[] } | null;
  /** The delivery report's verdict (runs/<id>/delivery.md): what happened and what is left for a person. */
  delivery: { outcome: DeliveryOutcome; headline: string; actionsForYou: string[]; reportPath: string | null } | null;
  worktreePath: string | null;
  association: RunContext["options"]["intake"] | null;
  next: string;
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function summarizeRun(store: Store, run: RunRecord<RunContext>): RunSummary {
  const ctx = run.context;
  const plan = ctx.plan;
  const last = [...(ctx.rounds ?? [])].reverse();
  const checks = last.find((r) => r.checks)?.checks ?? null;
  const review = last.find((r) => r.review)?.review ?? null;
  const planMd = store.artifacts(run.id).find((a) => a.label === "execution plan");
  return {
    id: run.id,
    issue: { key: run.issueKey, title: ctx.issue?.title ?? plan?.issue?.title ?? null, url: ctx.issue?.url ?? plan?.issue?.url ?? null },
    repo: run.repo,
    mode: run.mode,
    state: run.state,
    terminal: TERMINAL_STATES.has(run.state),
    reason: run.reason,
    blockedFrom: run.blockedFrom,
    driving: Boolean(store.leaseHolder(run.id)),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    planPath: planMd?.path ?? null,
    blockers: plan?.blockers ?? [],
    warnings: plan?.warnings ?? [],
    budget: { costUsd: ctx.costUsd ?? 0, maxRunCostUsd: plan?.limits?.maxRunCostUsd ?? null, maxRunMinutes: plan?.limits?.maxRunMinutes ?? null },
    checks: checks?.map((c) => ({ name: c.name, ok: c.ok, optional: c.optional, exitCode: c.exitCode })) ?? null,
    review: review ? { verdict: review.verdict, approved: review.approved, blocking: review.blocking, summary: review.summary, findingCount: review.findings.length } : null,
    criteria: review?.criteria?.map((c) => ({ id: c.id, text: c.text, source: c.source, status: c.status, evidence: c.evidence })) ?? null,
    minorRound: ctx.minorRound ? { status: ctx.minorRound.status, approvedSha: ctx.minorRound.approvedSha, findings: ctx.minorRound.findings.map((f) => f.id), reason: ctx.minorRound.reason ?? null } : null,
    pr: ctx.pr ? { number: ctx.pr.number, url: ctx.pr.url } : null,
    merge: ctx.merge ? { eligible: ctx.merge.eligible, ciState: ctx.merge.ciState, reasons: ctx.merge.reasons } : null,
    delivery: deliverySummary(store, run),
    worktreePath: ctx.worktreePath ?? null,
    association: ctx.options.intake ?? null,
    next: nextStep(run).replace(ANSI, ""),
  };
}

function deliverySummary(store: Store, run: RunRecord<RunContext>): RunSummary["delivery"] {
  if (run.mode !== "supervised") return null;
  const r = buildDeliveryReport(store, run);
  const path = [...store.artifacts(run.id)].reverse().find((a) => a.label === "delivery report")?.path ?? null;
  return { outcome: r.outcome, headline: r.headline, actionsForYou: r.actionsForYou, reportPath: path };
}

/** Every review round's findings, newest last, as recorded by the engine (never re-derived). */
export function reviewFindings(run: RunRecord<RunContext>): {
  runId: string;
  state: string;
  rounds: Array<{
    attempt: number;
    trigger: string;
    verdict: string;
    approved: boolean;
    reviewedSha: string;
    summary: string;
    findings: NonNullable<RunContext["rounds"][number]["review"]>["findings"];
    criteria: NonNullable<NonNullable<RunContext["rounds"][number]["review"]>["criteria"]>;
    /** No reviewer ran: the commit is one an earlier round approved. */
    reused: boolean;
  }>;
} {
  return {
    runId: run.id,
    state: run.state,
    rounds: (run.context.rounds ?? [])
      .filter((r) => r.review)
      .map((r) => ({
        attempt: r.attempt,
        trigger: r.trigger,
        verdict: r.review!.verdict,
        approved: r.review!.approved,
        reviewedSha: r.review!.reviewedSha,
        summary: r.review!.summary,
        findings: r.review!.findings,
        criteria: r.review!.criteria ?? [],
        reused: Boolean(r.review!.reused),
      })),
  };
}

/**
 * How to invoke this CLI in a printed command that an agent will run: the stable launcher when it
 * points at this installation (what installed skills use), otherwise this Node binary + the
 * launcher's absolute path (`orchestrator` when running from source via tsx).
 */
export function cliInvocation(env: NodeJS.ProcessEnv = process.env, argv1: string | undefined = process.argv[1], node: string = process.execPath): string {
  if (!argv1 || !/orchestrator(\.js)?$/.test(argv1)) return "orchestrator";
  let self: string;
  try {
    self = realpathSync(argv1);
  } catch {
    return "orchestrator";
  }
  const quote = (p: string) => (/^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
  const shim = shimPath(resolvePaths(env).home);
  const target = readShimTarget(shim);
  if (target && safeReal(join(target.packageRoot, "bin", "orchestrator.js")) === self) return quote(shim);
  // An agent's shell may have another Node (or no `orchestrator`) first on PATH.
  return `${quote(node)} ${quote(self)}`;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
