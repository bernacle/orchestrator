import type { Command } from "commander";
import { LinearTracker } from "../adapters/linear.js";
import { resolvePaths } from "../config/load.js";
import { CredentialError, LinearCredentialStore, resolveLinearKey } from "../credentials/linear.js";
import { c } from "../report/render.js";
import { output, printJson } from "./common.js";

/** Read a secret from stdin: hidden when interactive, piped otherwise. Never from argv. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          return resolveSecret(value.trim());
        }
        if (ch === "\u0003") {
          cleanup();
          return reject(new CredentialError("cancelled"));
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Credentials shared by the CLI and the Claude Code / Codex skills (stored once, per account)");
  const linear = auth.command("linear").description("Linear API keys, stored per workspace (macOS Keychain, or a 0600 file elsewhere)");

  linear
    .command("login")
    .description("Store a Linear personal API key. Reads it from stdin (hidden prompt in a terminal); verifies it and stores it under its workspace")
    .option("--workspace <urlKey>", "expected workspace urlKey; refuses a key from another workspace")
    .action(async (opts: { workspace?: string }) => {
      const paths = resolvePaths();
      const key = await readSecret("Linear API key (input hidden): ");
      if (!key) throw new CredentialError("no key given");
      const who = await new LinearTracker(key).whoami().catch((err: Error) => {
        throw new CredentialError(`Linear rejected the key: ${err.message}`);
      });
      if (opts.workspace && opts.workspace.toLowerCase() !== who.urlKey.toLowerCase()) {
        throw new CredentialError(`that key belongs to workspace "${who.urlKey}", not "${opts.workspace}"; nothing was stored`);
      }
      const stored = new LinearCredentialStore(paths).save({ workspace: who.urlKey.toLowerCase(), user: who.user, workspaceName: who.workspace }, key);
      console.log(`${c.green("Stored")} Linear key for ${who.user} @ ${who.workspace} (${stored.backend}). Every orchestrator session and skill now uses it for "${stored.workspace}".`);
    });

  linear
    .command("logout")
    .description("Remove a stored Linear key")
    .requiredOption("--workspace <urlKey>", "workspace to remove")
    .action((opts: { workspace: string }) => {
      const removed = new LinearCredentialStore(resolvePaths()).remove(opts.workspace.toLowerCase());
      console.log(removed ? `Removed the stored key for ${opts.workspace}.` : `No stored key for ${opts.workspace}.`);
    });

  auth
    .command("status")
    .description("Which credentials would be used (never prints secrets)")
    .option("--workspace <urlKey>", "check the key a request for this Linear workspace would use")
    .option("--verify", "call Linear to confirm the key works")
    .option("--json", "versioned JSON (schemaVersion 1)")
    .action(async (opts: { workspace?: string; verify?: boolean; json?: boolean }) => {
      output.json = Boolean(opts.json);
      const paths = resolvePaths();
      const accounts = new LinearCredentialStore(paths).list();
      const resolved = resolveLinearKey({ env: process.env, paths, workspace: opts.workspace ?? null });
      let verified: { ok: boolean; detail: string } | null = null;
      if (opts.verify && resolved.key) {
        verified = await new LinearTracker(resolved.key)
          .whoami()
          .then((w) => ({ ok: true, detail: `${w.user} @ ${w.workspace}` }))
          .catch((err: Error) => ({ ok: false, detail: err.message }));
      }
      const data = { linear: { stored: accounts, selected: { source: resolved.source, workspace: resolved.workspace, available: Boolean(resolved.key), problem: resolved.problem }, verified } };
      if (opts.json) return printJson("auth_status", data);
      console.log(c.bold("Linear"));
      for (const a of accounts) console.log(`  ${a.workspace.padEnd(20)} ${a.user} (${a.workspaceName}), ${a.backend}, stored ${a.storedAt.slice(0, 10)}`);
      if (!accounts.length) console.log("  no stored accounts");
      console.log(resolved.key ? `  → would use ${resolved.source}${verified ? ` — ${verified.ok ? c.green(verified.detail) : c.red(verified.detail)}` : ""}` : c.yellow(`  → ${resolved.problem}`));
      console.log(c.dim("GitHub uses `gh auth` (see orchestrator doctor); Claude Code and Codex use their own logins."));
    });
}
