/**
 * Secret redaction. Every string that reaches the event log, an artifact file
 * or the terminal passes through a Redactor first.
 *
 * Two layers:
 *  1. Exact values of secret-looking environment variables (and any value
 *     registered explicitly, e.g. an API key read from a file).
 *  2. Well-known token shapes (GitHub, Linear, OpenAI/Anthropic, bearer headers).
 */

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|_KEY$)/i;
const MIN_SECRET_LENGTH = 8;

const NAMED_PATTERNS: Array<[string, RegExp]> = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["Linear API key", /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g],
  ["Anthropic/OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["bearer credential", /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];
const TOKEN_PATTERNS: RegExp[] = NAMED_PATTERNS.map(([, re]) => re);

export const REDACTED = "[REDACTED]";

export class Redactor {
  private readonly values = new Set<string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const [name, value] of Object.entries(env)) {
      if (value && value.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) {
        this.values.add(value);
      }
    }
  }

  /** Register an additional secret value (e.g. read from a credentials file). */
  add(secret: string | undefined): void {
    if (secret && secret.length >= MIN_SECRET_LENGTH) this.values.add(secret);
  }

  redact(input: string): string {
    let out = input;
    // Longest first so overlapping secrets are fully removed.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join(REDACTED);
    }
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, (match, prefix?: string) =>
        typeof prefix === "string" && /^(bearer|token)$/i.test(prefix) ? `${prefix} ${REDACTED}` : REDACTED,
      );
    }
    return out;
  }

  /**
   * Find secrets in text without changing it (for refusing to commit or publish).
   * Returns labels only, never the secret itself.
   */
  findSecrets(input: string): string[] {
    const found = new Set<string>();
    for (const value of this.values) if (input.includes(value)) found.add("a known secret value (from the operator environment)");
    for (const [label, pattern] of NAMED_PATTERNS) {
      // "token <word>" is too common in ordinary code and prose to refuse a commit over; it is still redacted in logs.
      if (label === "bearer credential") continue;
      pattern.lastIndex = 0;
      if (pattern.test(input)) found.add(label);
      pattern.lastIndex = 0;
    }
    return [...found];
  }

  /** Deep-redact any JSON-compatible value. */
  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length > 0 ? REDACTED : this.redactValue(v);
      }
      return out as T;
    }
    return value;
  }
}
