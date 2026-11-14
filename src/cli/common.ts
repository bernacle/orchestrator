import { openApp, type App } from "../app.js";
import { envelope } from "../report/summary.js";
import type { ApprovalChannel } from "../core/remote-approval.js";

/** Set by commands run with --json, so failures are reported as a JSON envelope too. */
export const output: { json: boolean; approvalChannel?: ApprovalChannel } = { json: false };

export function withApp<T>(fn: (app: App) => Promise<T> | T): Promise<T> {
  const app = openApp({ approvalChannel: output.approvalChannel });
  return Promise.resolve()
    .then(() => fn(app))
    .finally(() => app.close());
}

export function printJson(kind: string, data: unknown): void {
  console.log(JSON.stringify(envelope(kind, data), null, 2));
}
