import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveToolchain } from "../adapters/checks.js";
import { ClaudeCodeAgent } from "../adapters/claude.js";
import { CodexAgent } from "../adapters/codex.js";
import { GitHubHost, ghAuthStatus } from "../adapters/github.js";
import { LinearCredentialStore, resolveLinearKey } from "../credentials/linear.js";
import { approvalChannelStatus } from "../core/approval.js";
import { LinearTracker } from "../adapters/linear.js";
import { T3Cli } from "../adapters/t3.js";
import { listRepoConfigs, loadRepoConfig, type LoadedRepoConfig, type Paths } from "../config/load.js";
import { probe, runProcess } from "../core/exec.js";
import { compareVersions, MIN_CLAUDE_VERSION_FOR_ISOLATION, sandboxSupport } from "../core/isolation.js";
import { c } from "../report/render.js";

export type Status = "ok" | "warn" | "fail" | "info";
export interface DoctorCheck {
  section: string;
  name: string;
  status: Status;
  detail: string;
}

const MIN_NODE: [number, number] = [22, 5];

export async function runDoctor(paths: Paths, opts: { repo?: string; env?: NodeJS.ProcessEnv }): Promise<DoctorCheck[]> {
  const env = opts.env ?? process.env;
  const out: DoctorCheck[] = [];
  const add = (section: string, name: string, status: Status, detail: string) => out.push({ section, name, status, detail });

  // ---- orchestrator runtime
  const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
  add("runtime", "node", maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]) ? "ok" : "fail", `v${process.versions.node}${process.execArgv.includes("--experimental-sqlite") ? " (node:sqlite enabled via --experimental-sqlite; Node 24 recommended)" : ""}`);
  try {
    mkdirSync(paths.home, { recursive: true });
    accessSync(paths.home, constants.W_OK);
    add("runtime", "state dir", "ok", `${paths.home} (ORCHESTRATOR_HOME)`);
  } catch (err) {
    add("runtime", "state dir", "fail", `${paths.home} not writable: ${(err as Error).message}`);
  }
  const git = await probe("git");
  add("runtime", "git", git ? "ok" : "fail", git ?? "git not found");

  // ---- isolation
  const sb = sandboxSupport();
  add("isolation", "checks", sb.available ? "ok" : "fail", sb.available ? `${sb.detail}: setup/checks run with confined writes, unreadable credentials, no network for checks` : `${sb.detail}; live runs are blocked while isolation.require=true`);
  const cv = (await probe("claude"))?.match(/(\d+\.\d+\.\d+)/)?.[1];
  add(
    "isolation",
    "implementer",
    cv && compareVersions(cv, MIN_CLAUDE_VERSION_FOR_ISOLATION) >= 0 ? "ok" : "fail",
    cv ? `Claude Code ${cv} (needs ≥ ${MIN_CLAUDE_VERSION_FOR_ISOLATION}): sandboxed Bash, fenced file tools, no hooks/MCP/connectors` : "claude not found",
  );
  add("isolation", "unattended", "info", "not available: every live run needs an explicit `run --execute` by the operator (see docs/isolation.md)");

  // ---- integrations
  const gh = await ghAuthStatus();
  add("github", "gh auth", gh.ok ? "ok" : "fail", gh.detail);
  let login: string | null = null;
  if (gh.ok) {
    try {
      login = (await new GitHubHost(undefined, env).viewer()).login;
      add("github", "identity", "ok", `acting as ${login}`);
    } catch (err) {
      add("github", "identity", "fail", (err as Error).message);
    }
  }

  const stored = new LinearCredentialStore(paths, env).list();
  if (stored.length) add("linear", "stored accounts", "info", stored.map((a) => `${a.workspace} (${a.user}, ${a.backend})`).join("; "));
  const resolved = resolveLinearKey({ env, paths });
  const key = resolved.key;
  let linearUrlKey: string | null = null;
  if (!key) {
    add("linear", "api key", stored.length > 1 ? "warn" : "fail", resolved.problem ?? "no Linear key");
  } else {
    try {
      const who = await new LinearTracker(key).whoami();
      add("linear", "api key", "ok", `${who.user} @ ${who.workspace} (from ${resolved.source})`);
      linearUrlKey = who.urlKey;
    } catch (err) {
      add("linear", "api key", "fail", (err as Error).message);
    }
  }

  const approval = await approvalChannelStatus();
  add("approval", approval.channel, approval.available ? "ok" : "warn", approval.detail);

  const claude = await new ClaudeCodeAgent({ adapter: "claude-code", permission_mode: "acceptEdits", allowed_tools: [], disallowed_tools: [], timeout_minutes: 1 }).probe();
  add("agents", "claude", claude.ok ? "ok" : "fail", claude.detail);
  const codex = await new CodexAgent({ adapter: "codex", sandbox: "read-only", timeout_minutes: 1 }).probe();
  add("agents", "codex", codex.ok ? "ok" : "fail", codex.detail);

  const t3 = new T3Cli();
  const t3v = await t3.version();
  if (!t3v) add("t3", "t3 cli", "warn", "not found (optional; the CLI works without T3)");
  else {
    add("t3", "t3 cli", "ok", `${t3v} at ${t3.bin}${env.T3CODE_CLI_PATH ? " (running inside a T3 session)" : ""}`);
    try {
      await t3.listThreads(process.cwd());
      add("t3", "server", "ok", "T3 server reachable (`t3 thread list`)");
    } catch (err) {
      const msg = (err as Error).message.split("\n").pop() ?? "";
      add("t3", "server", "warn", `could not list threads for ${process.cwd()}: ${msg.slice(0, 140)}`);
    }
    add("t3", "executor", "info", "T3 threads are not used as an executor: `t3 thread start` cannot set a runtime mode (see docs/research.md)");
  }

  // ---- repositories
  let repos: LoadedRepoConfig[] = [];
  try {
    repos = opts.repo ? [loadRepoConfig(opts.repo, paths)] : listRepoConfigs(paths);
  } catch (err) {
    add("repos", opts.repo ?? "config", "fail", (err as Error).message);
  }
  if (repos.length === 0 && !opts.repo) add("repos", "config", "warn", `no repository configs found in ${paths.repoConfigs} or bundled config/repos`);

  for (const { config, source } of repos) {
    const section = `repo ${config.repo}`;
    add(section, "config", "ok", source);
    const host = new GitHubHost(undefined, env);
    if (gh.ok) {
      try {
        const info = await host.getRepo(config.repo, config.base_branch);
        const base = config.base_branch ?? info.defaultBranch;
        add(section, "github", info.viewerPermission === "read" || info.viewerPermission === "none" ? "warn" : "ok", `${info.visibility}, base ${base}@${info.baseSha.slice(0, 8)}, access ${info.viewerPermission}`);
        const prot = await host.getBranchProtection(config.repo, base);
        add(
          section,
          "protection",
          prot.protected ? "ok" : "warn",
          prot.protected ? `required checks: ${prot.requiredChecks.join(", ") || "none"}; approvals: ${prot.requiredApprovals}` : `${base} is unprotected: manual merges only (auto mode would refuse)`,
        );
      } catch (err) {
        add(section, "github", "fail", (err as Error).message.split("\n")[0] ?? "");
      }
    }
    const [owner, name] = config.repo.split("/") as [string, string];
    const clone = config.local_path ?? join(paths.clones, owner, name);
    add(section, "clone", existsSync(join(clone, ".git")) ? "ok" : "info", existsSync(join(clone, ".git")) ? clone : `${clone} (created on first run)`);

    const tc = await resolveToolchain(config.toolchain.node, config.toolchain.env, env);
    if (tc.node.source === "not-required") add(section, "node", "info", "no toolchain.node pinned");
    else add(section, "node", tc.node.source === "unresolved" ? "fail" : "ok", `wants ${tc.node.requested}: ${tc.node.version ?? "missing"} via ${tc.node.source}${tc.node.binDir ? ` (${tc.node.binDir})` : ""}`);
    if (existsSync(join(clone, ".git"))) {
      const pm = config.setup[0]?.run.split(" ")[0] ?? config.checks[0]?.run.split(" ")[0];
      if (pm && /^(pnpm|npm|yarn|bun)$/.test(pm)) {
        const r = await runProcess(pm, ["--version"], { cwd: clone, env: tc.env, timeoutMs: 30_000 }).catch(() => null);
        add(section, pm, r?.exitCode === 0 ? "ok" : "fail", r?.exitCode === 0 ? `${pm} ${r.stdout.trim()} (with resolved toolchain)` : `${pm} --version failed in ${clone}: ${(r?.stderr ?? "").trim().split("\n").pop() ?? ""}`);
      }
    }

    const implProvider = config.agents.implementer.adapter === "codex" ? "openai" : config.agents.implementer.adapter === "claude-code" ? "anthropic" : "mock";
    const revProvider = config.agents.reviewer.adapter === "codex" ? "openai" : config.agents.reviewer.adapter === "claude-code" ? "anthropic" : "mock";
    add(section, "agents", implProvider !== revProvider ? "ok" : "fail", `implementer ${config.agents.implementer.adapter} (${implProvider}), reviewer ${config.agents.reviewer.adapter} (${revProvider})`);
    if (config.permissions.linear.comment || config.permissions.linear.update_state) {
      const match = linearUrlKey !== null && linearUrlKey === config.linear.workspace;
      add(section, "linear", match ? "ok" : "warn", match ? `writes allowed to workspace ${config.linear.workspace} (key matches)` : `writes configured for workspace "${config.linear.workspace}" but the key resolves to "${linearUrlKey ?? "unknown"}": comments will be skipped`);
    }
    const p = config.permissions;
    add(
      section,
      "permissions",
      "info",
      `agents.run=${p.agents.run} push=${p.github.push} create_pr=${p.github.create_pr} merge=${p.github.merge} linear.comment=${p.linear.comment} linear.update_state=${p.linear.update_state}`,
    );
    add(section, "merge", config.merge.mode === "manual" ? "ok" : "warn", `mode=${config.merge.mode}, max_fix_attempts=${config.merge.max_fix_attempts}${login && config.merge.auto_authorization && config.merge.auto_authorization.actor !== login ? ` (authorized actor ${config.merge.auto_authorization.actor} ≠ ${login})` : ""}`);
  }
  return out;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const icon: Record<Status, string> = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗"), info: c.dim("·") };
  const lines: string[] = [];
  let section = "";
  for (const k of checks) {
    if (k.section !== section) {
      section = k.section;
      lines.push("", c.bold(section));
    }
    lines.push(`  ${icon[k.status]} ${k.name.padEnd(12)} ${k.detail}`);
  }
  const fails = checks.filter((k) => k.status === "fail").length;
  const warns = checks.filter((k) => k.status === "warn").length;
  lines.push("", fails ? c.red(`${fails} problem(s), ${warns} warning(s)`) : warns ? c.yellow(`OK with ${warns} warning(s)`) : c.green("All checks passed"));
  return lines.join("\n").trimStart();
}
