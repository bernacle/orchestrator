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
}

export interface ReviewOutcome {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: Finding[];
}

export interface ReviewDecision {
  approved: boolean;
  blocking: Finding[];
  nonBlocking: Finding[];
  reasons: string[];
}

/** Strict JSON schema (all properties required, no extras) so it works for structured-output APIs. */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "file", "line", "title", "detail", "suggestion"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          title: { type: "string" },
          detail: { type: "string" },
          suggestion: { type: ["string", "null"] },
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
    };
  });
  return { verdict: v.verdict, summary: String(v.summary ?? ""), findings };
}

export function decideReview(outcome: ReviewOutcome, blockingSeverities: readonly Severity[]): ReviewDecision {
  const blocking = outcome.findings.filter((f) => blockingSeverities.includes(f.severity));
  const nonBlocking = outcome.findings.filter((f) => !blockingSeverities.includes(f.severity));
  const reasons: string[] = [];
  if (outcome.verdict !== "approve") reasons.push("reviewer requested changes");
  if (blocking.length > 0) reasons.push(`${blocking.length} blocking finding(s): ${blocking.map((f) => `${f.id} [${f.severity}]`).join(", ")}`);
  // A reviewer that "approves" while reporting blocking findings is not an approval.
  return { approved: outcome.verdict === "approve" && blocking.length === 0, blocking, nonBlocking, reasons };
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
