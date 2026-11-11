/**
 * Independent review contract. The reviewer returns structured findings; the
 * orchestrator — not the reviewer's verdict alone, and never the implementer —
 * decides whether the change is approved.
 */

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  id: string;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
  /**
   * The reviewer's judgement that a concrete, in-scope code change resolves it. Absent on reviews
   * recorded before this field existed; only `false` excludes a minor finding from the minor-fix round.
   */
  actionable?: boolean;
}

/** An acceptance criterion as the engine numbers it for this run (AC1, AC2, …). */
export interface Criterion {
  id: string;
  text: string;
  /** "issue": stated in the issue's acceptance/done section; "planner": derived from its scope by the read-only planner. */
  source: "issue" | "planner";
}

export const CRITERION_STATUSES = ["met", "not_met", "needs_human"] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export interface CriterionVerdict {
  id: string;
  status: CriterionStatus;
  evidence: string;
}

export interface ReviewOutcome {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: Finding[];
  /** One verdict per acceptance criterion. Absent on reviews recorded before criteria were judged. */
  criteria?: CriterionVerdict[];
}

/** A criterion with the verdict the engine holds for it (always one per criterion, never dropped). */
export interface CriterionReport extends Criterion {
  status: CriterionStatus;
  evidence: string;
}

export interface ReviewDecision {
  approved: boolean;
  blocking: Finding[];
  nonBlocking: Finding[];
  /** Non-blocking `minor` findings the reviewer considers actionable: the minor-fix round's input. Never nits. */
  actionableMinor: Finding[];
  /** Every criterion in order, with its verdict. A criterion the reviewer did not assess is `needs_human`. */
  criteria: CriterionReport[];
  unmetCriteria: CriterionReport[];
  needsHuman: CriterionReport[];
  reasons: string[];
}

/** Strict JSON schema (all properties required, no extras) so it works for structured-output APIs. */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "criteria"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "file", "line", "title", "detail", "suggestion", "actionable"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          title: { type: "string" },
          detail: { type: "string" },
          suggestion: { type: ["string", "null"] },
          actionable: { type: "boolean" },
        },
      },
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "evidence"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: [...CRITERION_STATUSES] },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export class ReviewParseError extends Error {
  override name = "ReviewParseError";
}

/** Validate reviewer output. Malformed output is an error, never an approval. */
export function parseReview(value: unknown): ReviewOutcome {
  if (!value || typeof value !== "object") throw new ReviewParseError("reviewer returned no structured output");
  const v = value as Record<string, unknown>;
  if (v.verdict !== "approve" && v.verdict !== "request_changes") throw new ReviewParseError(`invalid verdict: ${String(v.verdict)}`);
  if (!Array.isArray(v.findings)) throw new ReviewParseError("findings must be an array");
  const findings = v.findings.map((raw, i): Finding => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const severity = SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : "major"; // unknown severity: assume it matters
    return {
      id: typeof f.id === "string" && f.id ? f.id : `F${i + 1}`,
      severity,
      file: typeof f.file === "string" ? f.file : null,
      line: typeof f.line === "number" ? f.line : null,
      title: String(f.title ?? "Untitled finding"),
      detail: String(f.detail ?? ""),
      suggestion: typeof f.suggestion === "string" ? f.suggestion : null,
      ...(typeof f.actionable === "boolean" ? { actionable: f.actionable } : {}),
    };
  });
  const criteria: CriterionVerdict[] = Array.isArray(v.criteria)
    ? v.criteria
        .map((raw) => (raw ?? {}) as Record<string, unknown>)
        .filter((c) => typeof c.id === "string" && c.id)
        .map((c) => ({
          id: String(c.id).trim(),
          // An unknown status is never read as "met".
          status: CRITERION_STATUSES.includes(c.status as CriterionStatus) ? (c.status as CriterionStatus) : "needs_human",
          evidence: String(c.evidence ?? ""),
        }))
    : [];
  return { verdict: v.verdict, summary: String(v.summary ?? ""), findings, criteria };
}

/**
 * The engine's reading of each criterion: the reviewer's verdict, or `needs_human` when it gave none.
 * A criterion is never reported as met without the reviewer saying so.
 */
export function criteriaReport(outcome: Pick<ReviewOutcome, "criteria"> | null, criteria: readonly Criterion[]): CriterionReport[] {
  const byId = new Map((outcome?.criteria ?? []).map((v) => [v.id.toUpperCase(), v]));
  return criteria.map((c) => {
    const v = byId.get(c.id.toUpperCase());
    return v ? { ...c, status: v.status, evidence: v.evidence } : { ...c, status: "needs_human", evidence: "The reviewer gave no verdict for this criterion." };
  });
}

export function decideReview(outcome: ReviewOutcome, blockingSeverities: readonly Severity[], criteria: readonly Criterion[] = []): ReviewDecision {
  const blocking = outcome.findings.filter((f) => blockingSeverities.includes(f.severity));
  const nonBlocking = outcome.findings.filter((f) => !blockingSeverities.includes(f.severity));
  const actionableMinor = nonBlocking.filter((f) => f.severity === "minor" && f.actionable !== false);
  const report = criteriaReport(outcome, criteria);
  const unmetCriteria = report.filter((c) => c.status === "not_met");
  const needsHuman = report.filter((c) => c.status === "needs_human");
  const reasons: string[] = [];
  if (outcome.verdict !== "approve") reasons.push("reviewer requested changes");
  if (blocking.length > 0) reasons.push(`${blocking.length} blocking finding(s): ${blocking.map((f) => `${f.id} [${f.severity}]`).join(", ")}`);
  if (unmetCriteria.length > 0) reasons.push(`${unmetCriteria.length} acceptance criteria not met: ${unmetCriteria.map((c) => c.id).join(", ")}`);
  // A reviewer that "approves" while reporting blocking findings or unmet criteria is not an approval.
  return {
    approved: outcome.verdict === "approve" && blocking.length === 0 && unmetCriteria.length === 0,
    blocking,
    nonBlocking,
    actionableMinor,
    criteria: report,
    unmetCriteria,
    needsHuman,
    reasons,
  };
}

// ---- implementer report (correction rounds driven by review findings) ------------------

export interface FindingDisposition {
  id: string;
  status: "fixed" | "declined";
  note: string;
}

export interface ImplementerReport {
  summary: string;
  findings: FindingDisposition[];
}

/** Structured final output for review-driven rounds: what the implementer did about each finding. */
export const IMPLEMENTER_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "note"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["fixed", "declined"] },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

/** Self-reported by the implementer: shown to the reviewer to verify, never trusted as a result. */
export function parseImplementerReport(value: unknown): ImplementerReport | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.findings)) return null;
  const findings = v.findings
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((f) => typeof f.id === "string" && (f.status === "fixed" || f.status === "declined"))
    .map((f) => ({ id: String(f.id), status: f.status as FindingDisposition["status"], note: String(f.note ?? "") }));
  return { summary: String(v.summary ?? ""), findings };
}

/** True when the report answers every requested id (finding or criterion) and declines all of them, each with a reason. */
export function declinedAll(report: ImplementerReport | null, requested: readonly string[]): boolean {
  if (!report || requested.length === 0) return false;
  const byId = new Map(report.findings.map((f) => [f.id.trim().toUpperCase(), f]));
  return requested.every((id) => {
    const d = byId.get(id.trim().toUpperCase());
    return d?.status === "declined" && d.note.trim().length > 0;
  });
}

export function formatDispositions(report: ImplementerReport | null | undefined): string {
  if (!report?.findings.length) return "(the implementer gave no per-finding report)";
  return report.findings.map((d) => `- ${d.id}: ${d.status}${d.note ? ` — ${d.note.replace(/\n/g, " ")}` : ""}`).join("\n");
}

export function formatCriteria(criteria: readonly Criterion[]): string {
  return criteria.map((c) => `- ${c.id}: ${c.text}${c.source === "planner" ? " (derived from the issue's scope)" : ""}`).join("\n");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none)";
  return findings
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      return `- ${f.id} [${f.severity}] ${f.title}${loc}\n  ${f.detail.replace(/\n/g, "\n  ")}${f.suggestion ? `\n  Suggested fix: ${f.suggestion}` : ""}`;
    })
    .join("\n");
}
