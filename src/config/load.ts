import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RepoConfigSchema, type RepoConfig } from "./schema.js";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Paths {
  home: string;
  db: string;
  runs: string;
  worktrees: string;
  clones: string;
  repoConfigs: string;
}

/** ORCHESTRATOR_HOME holds all mutable state; nothing is written elsewhere. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = expandHome(env.ORCHESTRATOR_HOME ?? join(homedir(), ".orchestrator"));
  return {
    home,
    db: join(home, "orchestrator.db"),
    runs: join(home, "runs"),
    worktrees: join(home, "worktrees"),
    clones: join(home, "clones"),
    repoConfigs: join(home, "repos"),
  };
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `${VAR}` and `${VAR:-default}` expansion for config string values. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedRepoConfig {
  config: RepoConfig;
  source: string;
}

/** Locations searched for `<owner>/<name>.yaml`, highest precedence first. */
export function repoConfigSearchPath(paths: Paths): string[] {
  return [paths.repoConfigs, join(PACKAGE_ROOT, "config", "repos")];
}

export function loadRepoConfigFile(file: string): LoadedRepoConfig {
  if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${file}: invalid repository config\n${issues}`);
  }
  const config = parsed.data;
  if (config.local_path) config.local_path = expandHome(expandEnv(config.local_path));
  for (const [k, v] of Object.entries(config.toolchain.env)) config.toolchain.env[k] = expandEnv(expandHome(v));
  return { config, source: file };
}

export function loadRepoConfig(repo: string, paths: Paths, explicitFile?: string): LoadedRepoConfig {
  if (explicitFile) {
    const loaded = loadRepoConfigFile(resolve(explicitFile));
    if (loaded.config.repo !== repo) throw new ConfigError(`${explicitFile} configures ${loaded.config.repo}, not ${repo}`);
    return loaded;
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new ConfigError(`--repo must be owner/name, got "${repo}"`);
  for (const dir of repoConfigSearchPath(paths)) {
    for (const ext of ["yaml", "yml"]) {
      const file = join(dir, owner, `${name}.${ext}`);
      if (existsSync(file)) {
        const loaded = loadRepoConfigFile(file);
        if (loaded.config.repo !== repo) throw new ConfigError(`${file} configures ${loaded.config.repo}, not ${repo}`);
        return loaded;
      }
    }
  }
  throw new ConfigError(
    `no configuration for ${repo}. Create ${join(paths.repoConfigs, owner, `${name}.yaml`)} (see config/repos/ for examples).`,
  );
}

/** All configured repositories, for resolving a repo from an issue key. */
export function listRepoConfigs(paths: Paths): LoadedRepoConfig[] {
  const seen = new Map<string, LoadedRepoConfig>();
  for (const dir of repoConfigSearchPath(paths)) {
    if (!existsSync(dir)) continue;
    for (const owner of readdirSync(dir, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const file of readdirSync(join(dir, owner.name))) {
        if (!/\.ya?ml$/.test(file)) continue;
        const loaded = loadRepoConfigFile(join(dir, owner.name, file));
        if (!seen.has(loaded.config.repo)) seen.set(loaded.config.repo, loaded);
      }
    }
  }
  return [...seen.values()];
}

/** Pick the repository for an issue key when --repo is not given. */
export function resolveRepoForIssue(issueKey: string, paths: Paths): LoadedRepoConfig {
  const team = issueKey.split("-")[0]?.toUpperCase();
  const matches = listRepoConfigs(paths).filter((c) => c.config.linear.teams.map((t) => t.toUpperCase()).includes(team ?? ""));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new ConfigError(`no configured repository handles ${team} issues; pass --repo owner/name`);
  throw new ConfigError(`${team} issues map to several repositories (${matches.map((m) => m.config.repo).join(", ")}); pass --repo`);
}
