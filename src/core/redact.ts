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

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g, // Linear keys
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI style
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

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
