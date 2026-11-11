import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LoadedRepoConfig, Paths } from "../config/load.js";
import type { RepoConfig } from "../config/schema.js";
import { canonical } from "./approval.js";

/**
 * Trusted repositories: an opt-in, per-repository delegation that lets live runs and resumes start
 * without a per-run system prompt.
 *
 * What a person approves, once, with the same macOS LocalAuthentication prompt as a live run
 * (`orchestrator repo trust`), is a *trust scope*: the repository, the config file it is read from,
 * and every security-relevant setting of that config (permissions, agents, limits, isolation,
 * review, merge, forbidden paths…). The engine then accepts a live run or resume of that repository
 * without asking, only while the current config still has exactly that scope. Any change to it,
 * narrowing included, makes the trust *stale*: the run falls back to the per-run prompt until the
 * operator renews the trust. Trust never grants anything: permissions still come from the config,
 * and the permission gate, sandbox, tripwires, secret scan, budgets and independent review apply
 * exactly as in a supervised run.
 *
 * Not delegated, ever (these still need a person, or are refused):
 *   - repository authorization, associations, and trust itself (`repo authorize`, `associate`,
 *     `repo trust`);
 *   - merging: a config that grants `permissions.github.merge` or `merge.mode: auto` cannot be
 *     trusted;
 *   - running without the sandbox (`isolation.require: false`), a same-provider reviewer, or
 *     non-draft PRs;
 *   - operator-accepted dependencies (`--accept-dependency`), and a fresh time window on resume
 *     (a trusted resume keeps the run's original limit window).
 *
 * Integrity. The record lives in ORCHESTRATOR_HOME/trust/<owner>/<name>.json, outside the target
 * repository, and carries an HMAC seal. The seal key is per repository, created fresh by every
 * `repo trust` and deleted by `repo untrust`, and stored in the macOS login Keychain (elsewhere a
 * 0600 file under ORCHESTRATOR_HOME/credentials, which the sandboxes cannot read). So writing,
 * editing, copying or restoring a trust file does not create trust: only the CLI, after the prompt,
 * writes a record whose seal verifies. The backend is never chosen by the record or an environment
 * variable (code injection in tests only).
 *
 * The limit, stated plainly: a process running as you that deliberately reads the seal key out of
 * your Keychain and recomputes the seal can forge trust, just as it could edit Orchestrator's code.
 * Trusted mode is a convenience for repositories you accept that risk for. See docs/skills.md.
 */

export const TRUST_KEYCHAIN_SERVICE = "orchestrator.trust";
export const TRUST_CHANNEL = "trusted-repository";

// ---- scope --------------------------------------------------------------------------------

export interface TrustScope {
  version: 1;
  repo: string;
  configSource: string;
  baseBranch: string | null;
  localPath: string | null;
  linearWorkspace: string | null;
  permissions: RepoConfig["permissions"];
  merge: RepoConfig["merge"];
  agents: RepoConfig["agents"];
  limits: RepoConfig["limits"];
  isolation: RepoConfig["isolation"];
  review: RepoConfig["review"];
  pullRequest: { draft: boolean };
  forbiddenPaths: string[];
  baselineChecks: boolean;
  /** Network a setup/check command asks for beyond its default (commands themselves run sandboxed). */
  commandNetwork: Array<{ kind: "setup" | "check"; name: string; network: string }>;
}

/** Everything a trust delegates, in canonical form. Its hash binds the trust record. */
export function trustScope(loaded: LoadedRepoConfig): { scope: TrustScope; hash: string } {
  const c = loaded.config;
  const scope: TrustScope = {
    version: 1,
    repo: c.repo.toLowerCase(),
    configSource: loaded.source,
    baseBranch: c.base_branch ?? null,
    localPath: c.local_path ?? null,
    linearWorkspace: c.linear.workspace?.toLowerCase() ?? null,
    permissions: c.permissions,
    merge: c.merge,
    agents: c.agents,
    limits: c.limits,
    isolation: c.isolation,
    review: c.review,
    pullRequest: { draft: c.pull_request.draft },
    forbiddenPaths: [...c.forbidden_paths],
    baselineChecks: c.baseline_checks,
    commandNetwork: [
      ...c.setup.filter((s) => s.network).map((s) => ({ kind: "setup" as const, name: s.name, network: s.network! })),
      ...c.checks.filter((s) => s.network).map((s) => ({ kind: "check" as const, name: s.name, network: s.network! })),
    ],
  };
  // Round-trip through JSON so `undefined` fields hash the same as absent ones.
  const normalized = JSON.parse(JSON.stringify(scope)) as TrustScope;
  return { scope: normalized, hash: createHash("sha256").update(canonical(normalized)).digest("hex") };
}

/**
 * Settings a trusted repository must keep. Trust can't be granted, or stays unusable, unless all
 * hold: the things trusted mode promises to preserve (sandbox, independent review, manual merge,
 * draft PRs) are not left to the config to switch off.
 */
export function trustEligibility(config: RepoConfig): string[] {
  const problems: string[] = [];
  const p = config.permissions;
  if (!p.agents.run) problems.push("the configuration grants no live runs (permissions.agents.run is false)");
  if (p.github.merge) problems.push("the configuration grants merging (permissions.github.merge): trusted mode never covers merges");
  if (config.merge.mode !== "manual") problems.push(`merge.mode is ${config.merge.mode}: trusted mode requires manual merging`);
  if (!config.isolation.require) problems.push("isolation.require is false: trusted mode requires the sandbox");
  if (!config.review.require_distinct_provider) problems.push("review.require_distinct_provider is false: trusted mode requires an independent reviewer");
  if (!config.pull_request.draft) problems.push("pull_request.draft is false: trusted mode opens draft PRs only");
  return problems;
}

/** Top-level scope fields that differ, for a stale trust's explanation. */
export function scopeChanges(approved: TrustScope, current: TrustScope): string[] {
  const keys = [...new Set([...Object.keys(approved), ...Object.keys(current)])].sort();
  return keys.filter((k) => canonical((approved as unknown as Record<string, unknown>)[k]) !== canonical((current as unknown as Record<string, unknown>)[k]));
}

/** What a person is shown before trusting: a verb phrase for the system prompt, and detail lines. */
export function describeTrust(scope: TrustScope, opts: { renewing?: boolean } = {}): { reason: string; details: string[] } {
  const p = scope.permissions;
  const impl = agentName(scope.agents.implementer);
  const rev = agentName(scope.agents.reviewer);
  const actions = [`${impl} implements in a sandboxed worktree`, `${rev} reviews`];
  if (p.github.push) actions.push("pushes branches");
  if (p.github.create_pr) actions.push("opens draft PRs");
  if (p.linear.comment || p.linear.update_state) actions.push("updates Linear");
  const reason =
    `${opts.renewing ? "renew trust" : "trust"} ${scope.repo} for Orchestrator live runs and resumes WITHOUT asking you each time: ${actions.join(", ")}; ` +
    `never merges; budget $${scope.limits.max_run_cost_usd} and ${scope.limits.max_run_minutes} min per run. Until you run \`orchestrator repo untrust ${scope.repo}\` or the config changes`;
  const details = [
    `Repository:  ${scope.repo} (only this repository)`,
    `Config:      ${scope.configSource}`,
    `Agents:      implementer ${agentLabel(scope.agents.implementer)}, reviewer ${agentLabel(scope.agents.reviewer)}${scope.agents.planner ? `, planner ${agentLabel(scope.agents.planner)}` : ""}`,
    `Delegated:   start and resume live runs with: agent runs ${p.agents.run}, push ${p.github.push}, draft PR ${p.github.create_pr}, Linear comment ${p.linear.comment}, Linear state ${p.linear.update_state}`,
    `Never:       merge (${p.github.merge ? "GRANTED — not trustable" : "not granted"}; merge.mode ${scope.merge.mode}), new permissions, accepted dependencies, new time windows, repository authorization`,
    `Limits:      $${scope.limits.max_run_cost_usd} and ${scope.limits.max_run_minutes} min per run (a trusted resume keeps the run's window), ${scope.merge.max_fix_attempts} fix rounds`,
    `Isolation:   sandbox required ${scope.isolation.require}, setup network ${scope.isolation.setup_network}, checks network ${scope.isolation.checks_network}${scope.isolation.read_paths.length ? `, extra read paths ${scope.isolation.read_paths.join(", ")}` : ""}`,
    `Review:      distinct provider ${scope.review.require_distinct_provider}, blocking ${scope.review.blocking_severities.join("/")}`,
    `Ends:        on \`orchestrator repo untrust ${scope.repo}\`, or when any of the above changes in the config (runs then ask again)`,
  ];
  return { reason, details };
}

function agentName(a: RepoConfig["agents"]["implementer"]): string {
  return a.adapter === "mock" ? `mock:${a.provider}` : a.adapter;
}

function agentLabel(a: RepoConfig["agents"]["implementer"]): string {
  if (a.adapter === "claude-code") return `claude-code:${a.permission_mode}${a.model ? `:${a.model}` : ""}`;
  if (a.adapter === "codex") return `codex:${a.sandbox}${a.model ? `:${a.model}` : ""}`;
  return `mock:${a.provider}`;
}

// ---- seal keys ----------------------------------------------------------------------------

export interface TrustKeyStore {
  readonly name: "keychain" | "file" | "memory";
  get(repo: string): string | null;
  set(repo: string, key: string): void;
  delete(repo: string): void;
}

export class TrustError extends Error {
  override name = "TrustError";
}

function keychainTrustKeys(): TrustKeyStore {
  return {
    name: "keychain",
    get(repo) {
      const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", TRUST_KEYCHAIN_SERVICE, "-a", repo, "-w"], { encoding: "utf8", timeout: 15_000 });
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    set(repo, key) {
      // `security -i` reads the command from stdin, so the key never appears in a process list.
      const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s "${TRUST_KEYCHAIN_SERVICE}" -a "${repo}" -l "Orchestrator trust seal (${repo})" -w "${key}"\n`, encoding: "utf8", timeout: 15_000 });
      if (r.status !== 0 || /error/i.test(r.stderr)) throw new TrustError(`could not store the trust seal key in the Keychain: ${r.stderr.trim() || `exit ${r.status}`}`);
    },
    delete(repo) {
      spawnSync("/usr/bin/security", ["delete-generic-password", "-s", TRUST_KEYCHAIN_SERVICE, "-a", repo], { encoding: "utf8", timeout: 15_000 });
    },
  };
}

/** 0600 files under ORCHESTRATOR_HOME/credentials/trust (unreadable from every sandbox). */
export function fileTrustKeys(credentialsDir: string): TrustKeyStore {
  const file = (repo: string) => join(credentialsDir, "trust", `${repo.replace("/", "__")}.key`);
  return {
    name: "file",
    get: (repo) => (existsSync(file(repo)) ? readFileSync(file(repo), "utf8").trim() || null : null),
    set(repo, key) {
      mkdirSync(join(credentialsDir, "trust"), { recursive: true, mode: 0o700 });
      writeFileSync(file(repo), `${key}\n`, { mode: 0o600 });
      chmodSync(file(repo), 0o600);
    },
    delete: (repo) => rmSync(file(repo), { force: true }),
  };
}

/** The Keychain on macOS, a 0600 file elsewhere. Deliberately not selectable by env or by the record. */
export function systemTrustKeys(paths: Pick<Paths, "home">): TrustKeyStore {
  return process.platform === "darwin" ? keychainTrustKeys() : fileTrustKeys(join(paths.home, "credentials"));
}

// ---- records ------------------------------------------------------------------------------

const RecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  repo: z.string().min(1),
  scopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  scope: z.record(z.string(), z.unknown()),
  trustedBy: z.string().min(1),
  trustedAt: z.string().min(1),
  channel: z.string().min(1),
  detail: z.string(),
  seal: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TrustRecord = Omit<z.infer<typeof RecordSchema>, "scope"> & { scope: TrustScope };

export type TrustState =
  /** Usable: live runs and resumes of this repository start without a per-run prompt. */
  | { status: "trusted"; record: TrustRecord; file: string }
  /** No trust record: supervised (the default). */
  | { status: "untrusted"; file: string }
  /** A valid record for a different scope, or a config that no longer qualifies: runs ask again until renewed. */
  | { status: "stale"; record: TrustRecord; file: string; changed: string[]; problems: string[] }
  /** A record that was not written by `repo trust` (or whose key is gone): ignored, runs ask. */
  | { status: "invalid"; file: string; problem: string };

function sealOf(key: string, record: Omit<TrustRecord, "seal">): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonical(record)).digest("hex");
}

export class TrustStore {
  readonly dir: string;
  constructor(
    private readonly paths: Pick<Paths, "home">,
    private readonly keys: TrustKeyStore,
  ) {
    this.dir = join(paths.home, "trust");
  }

  file(repo: string): string {
    const [owner, name] = repo.toLowerCase().split("/");
    if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new TrustError(`expected owner/name, got "${repo}"`);
    return join(this.dir, owner, `${name}.json`);
  }

  /** Whether `loaded` (the config a run would use) is covered by a valid trust. Never throws. */
  evaluate(loaded: LoadedRepoConfig): TrustState {
    const repo = loaded.config.repo.toLowerCase();
    let file: string;
    try {
      file = this.file(repo);
    } catch (err) {
      return { status: "invalid", file: "", problem: (err as Error).message };
    }
    if (!existsSync(file)) return { status: "untrusted", file };
    let record: TrustRecord;
    try {
      const parsed = RecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) return { status: "invalid", file, problem: `${file} is not a trust record (${parsed.error.issues[0]?.message ?? "invalid"})` };
      record = parsed.data as unknown as TrustRecord;
    } catch (err) {
      return { status: "invalid", file, problem: `${file} is unreadable: ${(err as Error).message}` };
    }
    if (record.repo !== repo || record.scope.repo !== repo) return { status: "invalid", file, problem: `${file} is a trust record for ${record.repo}, not ${repo}: trust never transfers between repositories` };
    const key = this.keys.get(repo);
    if (!key) return { status: "invalid", file, problem: `no seal key for ${repo} in the ${this.keys.name}: the record was revoked or not written by \`orchestrator repo trust\`` };
    const { seal, ...unsealed } = record;
    const expected = sealOf(key, unsealed);
    if (seal.length !== expected.length || !timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(expected, "hex"))) {
      return { status: "invalid", file, problem: `${file}'s seal does not verify: it was edited, copied or restored, or not written by \`orchestrator repo trust\`` };
    }
    const current = trustScope(loaded);
    const problems = trustEligibility(loaded.config);
    if (current.hash !== record.scopeHash || problems.length) {
      return { status: "stale", record, file, changed: current.hash !== record.scopeHash ? scopeChanges(record.scope, current.scope) : [], problems };
    }
    return { status: "trusted", record, file };
  }

  /**
   * Write a new trust record. Only `trustRepository` (app.ts) calls this, after a person approved
   * this exact scope. A new key every time: any earlier record of this repository stops verifying.
   */
  write(input: { scope: TrustScope; scopeHash: string; trustedBy: string; trustedAt: string; channel: string; detail: string }): TrustRecord {
    const repo = input.scope.repo;
    const file = this.file(repo);
    const key = randomBytes(32).toString("hex");
    const unsealed: Omit<TrustRecord, "seal"> = { version: 1, id: randomBytes(6).toString("hex"), repo, scopeHash: input.scopeHash, scope: input.scope, trustedBy: input.trustedBy, trustedAt: input.trustedAt, channel: input.channel, detail: input.detail };
    const record: TrustRecord = { ...unsealed, seal: sealOf(key, unsealed) };
    this.keys.set(repo, key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return record;
  }

  /** Revoke: delete the key (so no copy of the record verifies again) and the record. */
  remove(repo: string): boolean {
    const file = this.file(repo);
    const had = existsSync(file) || this.keys.get(repo.toLowerCase()) !== null;
    this.keys.delete(repo.toLowerCase());
    rmSync(file, { force: true });
    return had;
  }

  /** Repositories with a trust file (valid or not), for listings. */
  repos(): string[] {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    for (const owner of readdirSync(this.dir, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const f of readdirSync(join(this.dir, owner.name))) if (f.endsWith(".json")) out.push(`${owner.name}/${f.slice(0, -5)}`);
    }
    return out.sort();
  }

  audit(entry: Record<string, unknown>): void {
    const file = join(this.paths.home, "audit", "trust.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), ...entry })}\n`);
  }
}

/** One line on a trust state, for context, doctor and the CLI. */
export function describeTrustState(t: TrustState): string {
  switch (t.status) {
    case "trusted":
      return `trusted by ${t.record.trustedBy} on ${t.record.trustedAt.slice(0, 10)} (${t.record.channel}): live runs and resumes start without a per-run prompt`;
    case "untrusted":
      return "supervised: every live run and resume asks you in a system prompt";
    case "stale":
      return `trust is stale (${[...(t.changed.length ? [`changed since it was granted: ${t.changed.join(", ")}`] : []), ...t.problems].join("; ")}): runs ask again until you renew it with \`orchestrator repo trust ${t.record.repo}\``;
    case "invalid":
      return `trust record ignored: ${t.problem}. Runs ask in a system prompt`;
  }
}
