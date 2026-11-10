import { openApp, type App } from "../app.js";
import { envelope } from "../report/summary.js";

/** Set by commands run with --json, so failures are reported as a JSON envelope too. */
export const output = { json: false };

export function withApp<T>(fn: (app: App) => Promise<T> | T): Promise<T> {
  const app = openApp();
  return Promise.resolve()
    .then(() => fn(app))
    .finally(() => app.close());
}

export function printJson(kind: string, data: unknown): void {
  console.log(JSON.stringify(envelope(kind, data), null, 2));
}
