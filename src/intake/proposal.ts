import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import type { RepoInspection } from "../adapters/types.js";
import { ConfigError, type Paths } from "../config/load.js";
import { RepoConfigSchema } from "../config/schema.js";
import { scriptNameFor } from "../planning/plan.js";
import { safeUser } from "./association.js";

/**
 * First use of a repository: discover, propose, authorize, persist.
 *
 * Discovery reads the repository (scripts, lockfiles, CI workflows) for *hints* about its checks.
 * Nothing in the repository can grant a permission: any orchestrator-looking config file in it is
 * reported and ignored. The proposal is written to ORCHESTRATOR_HOME/proposals/ (pending, grants
 * nothing). Only `orchestrator repo authorize` turns it into ORCHESTRATOR_HOME/repos/<owner>/<name>.yaml,
 * with an `authorization` block recording who approved which scope and the proposal's hash.
 */

export interface ProposalSummary {
  repo: string;
  tracker: { kind: "linear"; teams: string[] };
  agents: { implementer: string; reviewer: string; planner: string | null; available: Record<string, boolean> };
  setup: string[];
  checks: string[];
  ciSteps: string[];
  execution: string;
  github: { push: boolean; create_pr: boolean; merge: boolean };
  linear: { comment: boolean; update_state: boolean };
  limits: { max_run_cost_usd: number; max_run_minutes: number };
  merge: string;
  ignoredRepositoryConfig: string[];
  warnings: string[];
}

export interface Proposal {
  repo: string;
  yaml: string;
  sha256: string;
  file: string;
  summary: ProposalSummary;
}

const REPO_CONFIG_LOOKALIKES = [".orchestrator.yaml", ".orchestrator.yml", "orchestrator.yaml", "orchestrator.yml", ".orchestrator"];

function lockfileManager(topLevel: string[]): "pnpm" | "yarn" | "npm" | "bun" | null {
  if (topLevel.includes("pnpm-lock.yaml")) return "pnpm";
  if (topLevel.includes("yarn.lock")) return "yarn";
  if (topLevel.includes("bun.lockb") || topLevel.includes("bun.lock")) return "bun";
  if (topLevel.includes("package-lock.json")) return "npm";
  return null;
}

function nodeMajor(engine: string | null): string | undefined {
  const m = engine?.match(/(\d{2,})/);
  return m?.[1];
}

const INSTALL_STEP = /^(corepack\b|(pnpm|yarn|bun) install\b|npm (ci|install)\b|pip install\b|uv sync\b|cd\s|echo\s|export\s|git\s|curl\s|wget\s|sudo\s)/;

/** Single-line CI `run:` steps that verify something (not installs, shell setup or network fetches). */
export function ciCheckSteps(inspection: Pick<RepoInspection, "ciWorkflows">): string[] {
  const out: string[] = [];
  for (const wf of inspection.ciWorkflows) {
    for (const raw of wf.runSteps) {
      const step = raw.trim();
      if (!step || step.includes("\n") || step.includes("${{") || INSTALL_STEP.test(step)) continue;
      if (!out.includes(step)) out.push(step);
    }
  }
  return out;
}

export function buildProposal(input: {
  repo: string;
  inspection: RepoInspection;
  teams: string[];
  agentsAvailable: { claude: boolean; codex: boolean };
  paths: Paths;
}): Proposal {
  const { repo, inspection } = input;
  const warnings: string[] = [];
  const top = inspection.topLevel;
  const ignored = REPO_CONFIG_LOOKALIKES.filter((f) => top.includes(f));
  if (ignored.length) warnings.push(`ignored ${ignored.join(", ")} in the repository: repository files cannot configure or authorize the orchestrator`);

  const pmField = inspection.packageManager?.split("@")[0] as "pnpm" | "yarn" | "npm" | "bun" | undefined;
  const pm = pmField ?? lockfileManager(top) ?? (top.includes("package.json") ? "npm" : null);
  const scripts = inspection.scripts;
  const setup: Array<{ name: string; run: string; timeout_minutes?: number }> = [];
  const checks: Array<{ name: string; run: string; timeout_minutes?: number }> = [];
  if (pm) {
    const install = { pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", npm: "npm ci", bun: "bun install --frozen-lockfile" }[pm];
    setup.push({ name: "install", run: pm === "npm" && !top.includes("package-lock.json") ? "npm install" : install, timeout_minutes: 10 });
    const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
    for (const [name, candidates] of [
      ["lint", ["lint"]],
      ["format", ["format:check", "fmt:check", "prettier:check"]],
      ["typecheck", ["typecheck", "type-check", "tsc", "check-types"]],
      ["test", ["test"]],
      ["build", ["build"]],
    ] as const) {
      const script = candidates.find((c) => scripts[c] && !/no test specified/.test(scripts[c]!));
      if (script) checks.push({ name, run: run(script), ...(name === "build" ? { timeout_minutes: 20 } : {}) });
    }
    // A CI workflow is the repository's own definition of "verified": mirror its single-line run
    // steps (minus installs) instead of guessing from script names. The operator reviews them, and
    // they run sandboxed without network like any check.
    const ciChecks = ciCheckSteps(inspection);
    if (ciChecks.length) {
      checks.length = 0;
      const used = new Set<string>();
      for (const run of ciChecks) {
        let name = (scriptNameFor(run) ?? run.split(/\s+/).slice(0, 2).join("-")).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "check";
        for (let i = 2; used.has(name); i++) name = `${name.replace(/-\d+$/, "")}-${i}`;
        used.add(name);
        checks.push({ name, run, ...(name === "build" ? { timeout_minutes: 20 } : {}) });
      }
    }
  } else if (top.includes("Cargo.toml")) {
    checks.push({ name: "test", run: "cargo test" });
  } else if (top.includes("go.mod")) {
    checks.push({ name: "vet", run: "go vet ./..." }, { name: "test", run: "go test ./..." });
  } else if (top.includes("pyproject.toml")) {
    warnings.push("Python project: no checks proposed automatically; add them before authorizing");
  }
  if (checks.length === 0) warnings.push("no checks were detected: a run would have nothing to verify the change with; add checks before authorizing");
  const ciSteps = inspection.ciWorkflows.flatMap((w) => w.runSteps.map((s) => s.trim().split("\n")[0]!));

  const { claude, codex } = input.agentsAvailable;
  if (!claude) warnings.push("claude (Claude Code) is not on PATH: the proposed implementer cannot run");
  if (!codex) warnings.push("codex is not on PATH: the proposed independent reviewer cannot run");

  const checkTools = checks.map((c) => `Bash(${c.run}:*)`);
  const config = {
    repo,
    linear: { teams: input.teams.length ? input.teams : ["CHANGE-ME"] },
    ...(nodeMajor(inspection.nodeEngine) ? { toolchain: { node: nodeMajor(inspection.nodeEngine) } } : {}),
    setup,
    checks,
    agents: {
      planner: { adapter: "claude-code", timeout_minutes: 15, max_budget_usd: 2 },
      implementer: {
        adapter: "claude-code",
        permission_mode: "acceptEdits",
        timeout_minutes: 45,
        max_budget_usd: 10,
        allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", ...checkTools, "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"],
      },
      reviewer: { adapter: "codex", sandbox: "read-only", timeout_minutes: 30 },
    },
    limits: { max_run_cost_usd: 20, max_run_minutes: 240 },
    isolation: { require: true },
    pull_request: { draft: true },
    permissions: {
      agents: { run: true },
      github: { push: true, create_pr: true, merge: false },
      linear: { comment: false, update_state: false },
    },
    merge: { mode: "manual", require_ci: true, require_independent_review: true, max_fix_attempts: 3 },
  };
  if (!input.teams.length) warnings.push("the Linear team key is unknown: set linear.teams before authorizing");
  const parsed = RepoConfigSchema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`internal error: generated proposal is invalid: ${parsed.error.message}`);

  const header = [
    `# Proposed orchestrator configuration for ${repo}.`,
    "# Generated by `orchestrator repo init`. PENDING: this file grants nothing.",
    `# Authorize it with: orchestrator repo authorize ${repo}   (add --read-only to grant no remote writes)`,
    "# Edit it first if anything is wrong; the authorized copy records this file's sha256.",
    "",
  ].join("\n");
  const yaml = `${header}${stringify(config)}`;
  const sha256 = createHash("sha256").update(yaml).digest("hex");
  const file = proposalFile(input.paths, repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml);

  return {
    repo,
    yaml,
    sha256,
    file,
    summary: {
      repo,
      tracker: { kind: "linear", teams: config.linear.teams },
      agents: { implementer: "claude-code (acceptEdits, sandboxed shell)", reviewer: "codex (read-only sandbox)", planner: "claude-code (read-only)", available: { claude, codex } },
      setup: setup.map((s) => s.run),
      checks: checks.map((c) => c.run),
      ciSteps,
      execution: "orchestrator-owned clone and worktree under ~/.orchestrator; Seatbelt sandbox for setup/checks (required); your checkout is never used",
      github: config.permissions.github,
      linear: config.permissions.linear,
      limits: config.limits,
      merge: "manual (the orchestrator never merges)",
      ignoredRepositoryConfig: ignored,
      warnings,
    },
  };
}

export function proposalFile(paths: Paths, repo: string): string {
  const [owner, name] = repo.split("/");
  return join(paths.home, "proposals", owner!, `${name}.yaml`);
}

export function localConfigFile(paths: Paths, repo: string): string {
  const [owner, name] = repo.split("/");
  return join(paths.repoConfigs, owner!, `${name}.yaml`);
}

/**
 * Turn a pending proposal into authorized operator config. `readOnly` removes every remote-write
 * and agent grant (dry runs only). Refuses to replace an existing config unless `replace`.
 */
export function authorizeProposal(paths: Paths, repo: string, opts: { readOnly?: boolean; replace?: boolean; by?: string } = {}): { file: string; scope: "supervised" | "read_only"; sha256: string } {
  const pending = proposalFile(paths, repo);
  if (!existsSync(pending)) throw new ConfigError(`no pending proposal for ${repo}; run \`orchestrator repo init\` in its checkout (or with --repo ${repo}) first`);
  const text = readFileSync(pending, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const raw = parseYaml(text) as Record<string, unknown>;
  if (raw.repo !== repo) throw new ConfigError(`${pending} is for ${String(raw.repo)}, not ${repo}`);
  const scope = opts.readOnly ? "read_only" : "supervised";
  if (opts.readOnly) {
    raw.permissions = { agents: { run: false }, github: { push: false, create_pr: false, merge: false }, linear: { comment: false, update_state: false } };
  }
  raw.authorization = { authorized_by: opts.by ?? safeUser(), authorized_at: new Date().toISOString(), scope, proposal_sha256: sha256 };
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${pending}: invalid configuration\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  if (parsed.data.linear.teams.includes("CHANGE-ME")) throw new ConfigError(`${pending}: set linear.teams to the Linear team key(s) for ${repo} before authorizing`);
  const file = localConfigFile(paths, repo);
  if (existsSync(file) && !opts.replace) throw new ConfigError(`${file} already exists; pass --replace to overwrite it`);
  mkdirSync(dirname(file), { recursive: true });
  const header = `# Authorized orchestrator configuration for ${repo} (operator-owned; never inside the repository).\n`;
  writeFileSync(file, `${header}${stringify(raw)}`);
  return { file, scope, sha256 };
}
