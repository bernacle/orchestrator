import { execFile } from "node:child_process";

/**
 * Local, best-effort notifications (no daemon, no network). They tell a person that a run needs
 * them or is done; they never decide anything. Delivery is deduplicated through the run's
 * timeline (`notify.sent` events), which, unlike context patches, never races a driving process.
 */
export interface Notification {
  /** Stable identity: the same key is never shown twice for a run. */
  key: string;
  title: string;
  message: string;
}

export interface Notifier {
  readonly name: string;
  send(n: Notification): Promise<{ ok: boolean; detail: string }>;
}

export const silentNotifier: Notifier = {
  name: "none",
  async send() {
    return { ok: true, detail: "notifications are off" };
  },
};

/**
 * macOS Notification Center through `osascript`. The text is passed as arguments to the script
 * (`on run argv`), never spliced into it, so issue text cannot become AppleScript.
 */
export function macNotifier(): Notifier {
  return {
    name: "macos",
    send(n) {
      return new Promise((resolve) => {
        execFile(
          "/usr/bin/osascript",
          ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", clip(n.title, 80), clip(n.message, 220)],
          { timeout: 5_000 },
          (err) => resolve(err ? { ok: false, detail: err.message.split("\n")[0] ?? "osascript failed" } : { ok: true, detail: "macOS Notification Center" }),
        );
      });
    },
  };
}

/** Off in tests (injected adapters) and with ORCHESTRATOR_NOTIFY=0; macOS only. */
export function defaultNotifier(env: NodeJS.ProcessEnv, injectedAdapters: boolean): Notifier {
  if (injectedAdapters || env.ORCHESTRATOR_NOTIFY === "0" || process.platform !== "darwin") return silentNotifier;
  return macNotifier();
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
