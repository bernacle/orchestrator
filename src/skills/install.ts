import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadSkillSource, renderSkill, sha256, type Provider, type RenderedSkill } from "./render.js";

/**
 * User-level installation of the Orchestrator skill, verified against each provider's documented
 * discovery locations (docs/skills.md has the sources):
 *
 *   - Claude Code: personal skills in `<config dir>/skills/<name>/SKILL.md`, where the config dir is
 *     $CLAUDE_CONFIG_DIR or ~/.claude. T3 can run Claude Code with its own config dir per provider
 *     instance (Settings → Providers → home path); those are read, never written, from T3's settings
 *     file and included as targets.
 *   - Codex: user skills in `$HOME/.agents/skills/<name>/SKILL.md`. Codex also scans
 *     `$CODEX_HOME/skills` (legacy), and lists a skill twice when both hold it, so only one is used.
 *
 * Every installed directory carries `.orchestrator-skill.json`: owner, version, and the sha256 of
 * each file written. That marker is what makes a directory Orchestrator-owned. Without it a
 * directory is someone else's skill and is never touched. With it, a file whose hash no longer
 * matches was edited by the operator: updates and uninstalls keep it unless `force`, and a forced
 * update moves it aside first.
 */

export const MARKER = ".orchestrator-skill.json";

export interface Marker {
  owner: "bernacle/orchestrator";
  skill: string;
  provider: Provider;
  version: string;
  cli: string;
  installedAt: string;
  files: Record<string, string>;
}

export interface Target {
  provider: Provider;
  /** The provider's skills directory (the skill lives in `<dir>/<name>`). */
  dir: string;
  why: string;
}

export type InstallState = "not_installed" | "current" | "outdated" | "modified" | "foreign" | "legacy_symlink";

export interface TargetStatus extends Target {
  path: string;
  state: InstallState;
  installedVersion: string | null;
  installedCli: string | null;
  modifiedFiles: string[];
  notes: string[];
}

export interface SkillEnv {
  env: NodeJS.ProcessEnv;
  home: string;
  /** T3 settings file (to find the Claude config dirs T3 launches Claude Code with). */
  t3Settings: string | null;
}

export function skillEnv(env: NodeJS.ProcessEnv = process.env): SkillEnv {
  const home = env.HOME ?? homedir();
  return { env, home, t3Settings: env.ORCHESTRATOR_T3_SETTINGS ?? join(home, ".t3", "userdata", "settings.json") };
}

/** Claude/Codex home paths configured on T3 provider instances (read-only, best effort). */
export function t3ProviderHomes(settingsFile: string | null): { claude: string[]; codex: string[] } {
  const out = { claude: [] as string[], codex: [] as string[] };
  if (!settingsFile || !existsSync(settingsFile)) return out;
  try {
    const s = JSON.parse(readFileSync(settingsFile, "utf8")) as { providerInstances?: Record<string, { driver?: string; enabled?: boolean; config?: { homePath?: string } }> };
    for (const inst of Object.values(s.providerInstances ?? {})) {
      const homePath = inst.config?.homePath?.trim();
      if (!homePath || inst.enabled === false) continue;
      if (inst.driver === "claudeAgent") out.claude.push(resolve(homePath));
      if (inst.driver === "codex") out.codex.push(resolve(homePath));
    }
  } catch {
    /* unreadable or a different format: fall back to the documented defaults */
  }
  return out;
}

export function defaultTargets(provider: Provider, se: SkillEnv, overrides: { claudeHomes?: string[]; codexSkillsDir?: string } = {}): Target[] {
  if (provider === "claude") {
    if (overrides.claudeHomes?.length) return unique(overrides.claudeHomes.map((h) => ({ provider, dir: join(resolve(h), "skills"), why: "--claude-home" })));
    const primary = se.env.CLAUDE_CONFIG_DIR ? resolve(se.env.CLAUDE_CONFIG_DIR) : join(se.home, ".claude");
    const targets: Target[] = [{ provider, dir: join(primary, "skills"), why: se.env.CLAUDE_CONFIG_DIR ? "$CLAUDE_CONFIG_DIR" : "~/.claude (default)" }];
    for (const h of t3ProviderHomes(se.t3Settings).claude) targets.push({ provider, dir: join(h, "skills"), why: "T3 Claude provider home" });
    return unique(targets);
  }
  if (overrides.codexSkillsDir) return [{ provider, dir: resolve(overrides.codexSkillsDir), why: "--codex-skills-dir" }];
  return [{ provider, dir: join(se.home, ".agents", "skills"), why: "$HOME/.agents/skills (Codex user skills)" }];
}

/** Where an older or duplicate Codex copy would make the skill appear twice. */
export function codexLegacyDirs(se: SkillEnv): string[] {
  const homes = [se.env.CODEX_HOME ? resolve(se.env.CODEX_HOME) : join(se.home, ".codex"), ...t3ProviderHomes(se.t3Settings).codex];
  return [...new Set(homes.map((h) => join(h, "skills")))];
}

function unique(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => (seen.has(t.dir) ? false : (seen.add(t.dir), true)));
}

function readMarker(path: string): Marker | null {
  const file = join(path, MARKER);
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Marker;
    return m.owner === "bernacle/orchestrator" ? m : null;
  } catch {
    return null;
  }
}

function isLegacySymlink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return /integrations[/\\]claude-skill[/\\]orchestrate\/?$/.test(readlinkSync(path));
  } catch {
    return false;
  }
}

function isEmptyDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function targetStatus(target: Target, rendered: RenderedSkill, se?: SkillEnv): TargetStatus {
  const path = join(target.dir, rendered.name);
  const base = { ...target, path, installedVersion: null, installedCli: null, modifiedFiles: [] as string[], notes: [] as string[] };
  if (isLegacySymlink(path)) return { ...base, state: "legacy_symlink", notes: [`symlink from \`orchestrator install-skill\` → ${readlinkSync(path)}; install replaces it`] };
  if (!exists(path) || isEmptyDir(path)) return { ...base, state: "not_installed", notes: dupNotes(target, rendered, se) };
  const marker = readMarker(path);
  if (!marker) return { ...base, state: "foreign", notes: ["a skill with this name exists and is not Orchestrator-owned (no marker); it is left alone"] };
  const modified = Object.entries(marker.files).filter(([rel, hash]) => !existsSync(join(path, rel)) || sha256(readFileSync(join(path, rel), "utf8")) !== hash).map(([rel]) => rel);
  const current = Object.keys(rendered.files).every((rel) => marker.files[rel] === sha256(rendered.files[rel]!)) && Object.keys(marker.files).length === Object.keys(rendered.files).length;
  const state: InstallState = modified.length ? "modified" : current ? "current" : "outdated";
  const notes = [...dupNotes(target, rendered, se)];
  const missing = cliPaths(marker.cli).filter((p) => !existsSync(p));
  if (missing.length) notes.push(`the skill's CLI command uses ${missing.join(" and ")}, which no longer exist${missing.length > 1 ? "" : "s"}; run \`orchestrator skill install --all\` again`);
  return { ...base, state, installedVersion: marker.version, installedCli: marker.cli, modifiedFiles: modified, notes };
}

/** Absolute paths in a baked CLI command (`/node /checkout/bin/orchestrator.js`, possibly quoted). */
export function cliPaths(cli: string): string[] {
  return [...cli.matchAll(/'((?:[^']|'\\'')+)'|(\S+)/g)].map((m) => (m[1] ?? m[2]!).replace(/'\\''/g, "'")).filter((p) => p.startsWith("/"));
}

function dupNotes(target: Target, rendered: RenderedSkill, se?: SkillEnv): string[] {
  if (target.provider !== "codex" || !se) return [];
  return codexLegacyDirs(se)
    .filter((d) => d !== target.dir && exists(join(d, rendered.name)))
    .map((d) => `${join(d, rendered.name)} also exists; Codex lists both copies${readMarker(join(d, rendered.name)) ? " (Orchestrator-owned: install removes it)" : " (not Orchestrator-owned: remove it yourself)"}`);
}

export interface ActionResult {
  provider: Provider;
  path: string;
  action: "installed" | "updated" | "unchanged" | "skipped" | "removed" | "not_installed";
  detail: string;
}

function writeOwned(path: string, rendered: RenderedSkill, version: string, cli: string): void {
  mkdirSync(path, { recursive: true });
  const files: Record<string, string> = {};
  for (const [rel, content] of Object.entries(rendered.files)) {
    mkdirSync(dirname(join(path, rel)), { recursive: true });
    writeFileSync(join(path, rel), content);
    files[rel] = sha256(content);
  }
  const marker: Marker = { owner: "bernacle/orchestrator", skill: rendered.name, provider: rendered.provider, version, cli, installedAt: new Date().toISOString(), files };
  writeFileSync(join(path, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

function removeOwnedFiles(path: string, marker: Marker, keep: Set<string>): string[] {
  const kept: string[] = [];
  for (const rel of Object.keys(marker.files)) {
    if (keep.has(rel)) {
      kept.push(rel);
      continue;
    }
    rmSync(join(path, rel), { force: true });
    pruneEmpty(dirname(join(path, rel)), path);
  }
  return kept;
}

function pruneEmpty(dir: string, stop: string): void {
  let d = dir;
  while (d.startsWith(stop) && d !== stop) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}

export interface InstallOptions {
  cli: string;
  version: string;
  /** Overwrite operator-modified files (they are moved aside to `<file>.orig-<timestamp>` first). */
  force?: boolean;
  /** Only touch targets that already have an Orchestrator-owned install (`skill update`). */
  onlyInstalled?: boolean;
  se: SkillEnv;
}

export function installTo(target: Target, opts: InstallOptions): ActionResult {
  const rendered = renderSkill(target.provider, { cli: opts.cli, version: opts.version, source: loadSkillSource() });
  const status = targetStatus(target, rendered, opts.se);
  const result = (action: ActionResult["action"], detail: string): ActionResult => ({ provider: target.provider, path: status.path, action, detail });
  if (status.state === "foreign") return result("skipped", `${status.path} is not Orchestrator-owned; leaving it unchanged (remove or rename it to install)`);
  if (opts.onlyInstalled && (status.state === "not_installed")) return result("not_installed", "not installed here (use `orchestrator skill install`)");
  if (status.state === "current") {
    removeCodexDuplicates(target, rendered, opts.se);
    return result("unchanged", `already current (${status.installedVersion})`);
  }
  if (status.state === "modified" && !opts.force) {
    return result("skipped", `operator-modified file(s) ${status.modifiedFiles.join(", ")}; kept. Re-run with --force to replace them (the edited copies are kept as *.orig-<timestamp>)`);
  }
  if (status.state === "legacy_symlink") rmSync(status.path);
  if (status.state === "modified") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const rel of status.modifiedFiles) if (existsSync(join(status.path, rel))) renameSync(join(status.path, rel), join(status.path, `${rel}.orig-${stamp}`));
  }
  const marker = readMarker(status.path);
  if (marker) removeOwnedFiles(status.path, marker, new Set(Object.keys(rendered.files)));
  writeOwned(status.path, rendered, opts.version, opts.cli);
  removeCodexDuplicates(target, rendered, opts.se);
  const action = status.state === "not_installed" ? "installed" : status.state === "legacy_symlink" ? "installed" : "updated";
  return result(action, `${action === "updated" ? `${status.installedVersion ?? "?"} → ` : ""}${opts.version}${status.state === "modified" ? " (edited files moved aside)" : ""}`);
}

/** An Orchestrator-owned copy in a second Codex location would be listed twice: remove it. */
function removeCodexDuplicates(target: Target, rendered: RenderedSkill, se: SkillEnv): void {
  if (target.provider !== "codex") return;
  for (const d of codexLegacyDirs(se)) {
    const p = join(d, rendered.name);
    if (d === target.dir) continue;
    const m = readMarker(p);
    if (m && Object.entries(m.files).every(([rel, h]) => existsSync(join(p, rel)) && sha256(readFileSync(join(p, rel), "utf8")) === h)) {
      removeOwnedFiles(p, m, new Set());
      rmSync(join(p, MARKER), { force: true });
      pruneEmpty(p, d);
      try {
        rmdirSync(p);
      } catch {
        /* not empty: operator files remain */
      }
    }
  }
}

export function uninstallFrom(target: Target, opts: { force?: boolean }): ActionResult {
  const { meta } = loadSkillSource();
  const path = join(target.dir, meta.name);
  const result = (action: ActionResult["action"], detail: string): ActionResult => ({ provider: target.provider, path, action, detail });
  if (isLegacySymlink(path)) {
    rmSync(path);
    return result("removed", "removed the legacy symlink");
  }
  if (!exists(path) || isEmptyDir(path)) return result("not_installed", "nothing to remove");
  const marker = readMarker(path);
  if (!marker) return result("skipped", "not Orchestrator-owned; left unchanged");
  const modified = Object.entries(marker.files).filter(([rel, h]) => existsSync(join(path, rel)) && sha256(readFileSync(join(path, rel), "utf8")) !== h).map(([rel]) => rel);
  const kept = removeOwnedFiles(path, marker, new Set(opts.force ? [] : modified));
  if (kept.length) return result("skipped", `kept operator-modified ${kept.join(", ")} (and the marker); --force removes them too`);
  rmSync(join(path, MARKER), { force: true });
  const leftovers = readdirSync(path);
  if (leftovers.length === 0) rmdirSync(path);
  return result("removed", leftovers.length ? `removed Orchestrator files; left ${leftovers.join(", ")} (not Orchestrator-owned)` : "removed");
}

export function skillStatus(provider: Provider, se: SkillEnv, opts: { cli: string; version: string; claudeHomes?: string[]; codexSkillsDir?: string }): TargetStatus[] {
  const rendered = renderSkill(provider, { cli: opts.cli, version: opts.version });
  return defaultTargets(provider, se, opts).map((t) => targetStatus(t, rendered, se));
}
