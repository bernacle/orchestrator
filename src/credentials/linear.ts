import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Paths } from "../config/load.js";

/**
 * Linear credentials, resolved the same way for the CLI, the Claude Code skill and the Codex skill
 * (the skills only ever run the CLI). Order:
 *
 *   1. LINEAR_API_KEY, then LINEAR_API_KEY_FILE (existing behaviour, CI and secret managers);
 *   2. a key stored by `orchestrator auth linear login`, per Linear workspace:
 *        - macOS: the login Keychain (service "orchestrator.linear", account = workspace urlKey);
 *        - elsewhere: ORCHESTRATOR_HOME/credentials/linear/<workspace>.key, mode 0600.
 *
 * A non-secret index (workspace, user, backend, date) lives in ORCHESTRATOR_HOME/credentials/linear.json
 * so status can list accounts without reading secrets. Keys are never printed, never written to
 * run artifacts (the redactor learns them), never passed on a command line, and the credentials
 * directory is unreadable from the check and agent sandboxes (see isolation.credentialPaths).
 */

export const KEYCHAIN_SERVICE = "orchestrator.linear";

export interface StoredAccount {
  workspace: string;
  user: string;
  workspaceName: string;
  backend: "keychain" | "file";
  storedAt: string;
}

export interface ResolvedLinearKey {
  key: string | undefined;
  /** Where the key came from, never the key itself. */
  source: string;
  /** Workspace urlKey the key is stored for (unknown for env keys until verified). */
  workspace: string | null;
  /** Why no key was selected, with what to do about it. */
  problem: string | null;
}

export class CredentialError extends Error {
  override name = "CredentialError";
}

export function onboardingHint(workspace?: string | null): string {
  return (
    `Run \`orchestrator auth linear login${workspace ? ` --workspace ${workspace}` : ""}\` in a terminal and paste a Linear personal API key ` +
    `(Linear → Settings → Security & access → API keys). It is stored ${process.platform === "darwin" ? "in the macOS Keychain" : "in ~/.orchestrator/credentials (mode 0600)"} ` +
    `and reused by every session. Never paste the key into an agent chat. Alternatively set LINEAR_API_KEY or LINEAR_API_KEY_FILE.`
  );
}

interface Backend {
  readonly name: StoredAccount["backend"];
  get(workspace: string): string | null;
  set(workspace: string, key: string): void;
  delete(workspace: string): void;
}

function keychainBackend(): Backend {
  return {
    name: "keychain",
    get(workspace) {
      const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", workspace, "-w"], { encoding: "utf8", timeout: 15_000 });
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    set(workspace, key) {
      // `security -i` reads the command from stdin, so the key never appears in a process list.
      const r = spawnSync("security", ["-i"], { input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${workspace}" -l "Orchestrator Linear (${workspace})" -w "${key}"\n`, encoding: "utf8", timeout: 15_000 });
      if (r.status !== 0 || /error/i.test(r.stderr)) throw new CredentialError(`could not store the key in the Keychain: ${r.stderr.trim() || `exit ${r.status}`}`);
    },
    delete(workspace) {
      spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", workspace], { encoding: "utf8", timeout: 15_000 });
    },
  };
}

function fileBackend(dir: string): Backend {
  const file = (ws: string) => join(dir, "linear", `${ws}.key`);
  return {
    name: "file",
    get: (ws) => (existsSync(file(ws)) ? readFileSync(file(ws), "utf8").trim() || null : null),
    set(ws, key) {
      mkdirSync(join(dir, "linear"), { recursive: true, mode: 0o700 });
      writeFileSync(file(ws), `${key}\n`, { mode: 0o600 });
      chmodSync(file(ws), 0o600);
    },
    delete: (ws) => rmSync(file(ws), { force: true }),
  };
}

export class LinearCredentialStore {
  readonly dir: string;
  private readonly backend: Backend;
  private readonly fallback: Backend;

  constructor(paths: Pick<Paths, "home">, env: NodeJS.ProcessEnv = process.env) {
    this.dir = join(paths.home, "credentials");
    this.fallback = fileBackend(this.dir);
    const wanted = env.ORCHESTRATOR_CREDENTIAL_BACKEND;
    this.backend = wanted === "file" || (wanted !== "keychain" && process.platform !== "darwin") ? this.fallback : keychainBackend();
  }

  private indexFile(): string {
    return join(this.dir, "linear.json");
  }

  list(): StoredAccount[] {
    if (!existsSync(this.indexFile())) return [];
    try {
      return (JSON.parse(readFileSync(this.indexFile(), "utf8")) as { accounts?: StoredAccount[] }).accounts ?? [];
    } catch {
      return [];
    }
  }

  private writeIndex(accounts: StoredAccount[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.indexFile(), `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
  }

  get(workspace: string): string | null {
    const account = this.list().find((a) => a.workspace === workspace);
    if (!account) return null;
    return (account.backend === "file" ? this.fallback : this.backend).get(workspace);
  }

  save(account: Omit<StoredAccount, "backend" | "storedAt">, key: string): StoredAccount {
    if (!/^[\w-]{8,200}$/.test(key)) throw new CredentialError("that does not look like a Linear API key (expected lin_api_…)");
    if (!/^[\w-]+$/.test(account.workspace)) throw new CredentialError(`invalid workspace urlKey "${account.workspace}"`);
    this.backend.set(account.workspace, key);
    const stored: StoredAccount = { ...account, backend: this.backend.name, storedAt: new Date().toISOString() };
    this.writeIndex([...this.list().filter((a) => a.workspace !== account.workspace), stored]);
    return stored;
  }

  remove(workspace: string): boolean {
    const account = this.list().find((a) => a.workspace === workspace);
    if (!account) return false;
    (account.backend === "file" ? this.fallback : this.backend).delete(workspace);
    this.writeIndex(this.list().filter((a) => a.workspace !== workspace));
    return true;
  }
}

/**
 * Pick the Linear key for a request. `workspace` is the workspace the request needs (from a Linear
 * URL or the repository's `linear.workspace`); with several stored accounts and no workspace, no
 * key is chosen: an unrelated account is never picked silently.
 */
export function resolveLinearKey(input: { env: NodeJS.ProcessEnv; paths: Pick<Paths, "home">; workspace?: string | null; store?: LinearCredentialStore }): ResolvedLinearKey {
  const { env } = input;
  const workspace = input.workspace?.toLowerCase() ?? null;
  if (env.LINEAR_API_KEY?.trim()) return { key: env.LINEAR_API_KEY.trim(), source: "env LINEAR_API_KEY", workspace: null, problem: null };
  if (env.LINEAR_API_KEY_FILE) {
    if (existsSync(env.LINEAR_API_KEY_FILE)) {
      const key = readFileSync(env.LINEAR_API_KEY_FILE, "utf8").trim();
      if (key) return { key, source: "file named by LINEAR_API_KEY_FILE", workspace: null, problem: null };
    }
    return { key: undefined, source: "LINEAR_API_KEY_FILE", workspace: null, problem: `LINEAR_API_KEY_FILE points at a missing or empty file. ${onboardingHint(workspace)}` };
  }
  const store = input.store ?? new LinearCredentialStore(input.paths, env);
  const accounts = store.list();
  const pick = workspace ? accounts.find((a) => a.workspace === workspace) : accounts.length === 1 ? accounts[0] : undefined;
  if (!pick) {
    if (accounts.length === 0) return { key: undefined, source: "none", workspace, problem: `No Linear credentials found. ${onboardingHint(workspace)}` };
    const names = accounts.map((a) => a.workspace).join(", ");
    return {
      key: undefined,
      source: "none",
      workspace,
      problem: workspace
        ? `No stored Linear key for workspace "${workspace}" (stored: ${names}). ${onboardingHint(workspace)}`
        : `Several Linear workspaces are stored (${names}) and nothing says which one this request uses: pass a linear.app issue URL, set linear.workspace in the repository config, or pass --linear-workspace.`,
    };
  }
  const key = store.get(pick.workspace);
  if (!key) return { key: undefined, source: `${pick.backend}:${pick.workspace}`, workspace: pick.workspace, problem: `The stored key for "${pick.workspace}" could not be read from the ${pick.backend}. ${onboardingHint(pick.workspace)}` };
  return { key, source: `${pick.backend === "keychain" ? "macOS Keychain" : "credentials file"} (${pick.workspace})`, workspace: pick.workspace, problem: null };
}
