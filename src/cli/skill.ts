import { join } from "node:path";
import type { Command } from "commander";
import { PACKAGE_ROOT } from "../config/load.js";
import { probe } from "../core/exec.js";
import { defaultTargets, installTo, skillEnv, skillStatus, uninstallFrom, type ActionResult, type TargetStatus } from "../skills/install.js";
import { loadSkillSource, PROVIDERS, type Provider } from "../skills/render.js";
import { verifyClaude, verifyCodex } from "../skills/verify.js";
import { c } from "../report/render.js";
import { output, printJson } from "./common.js";

/** The orchestrator launcher in this checkout. */
export function launcherPath(): string {
  return join(PACKAGE_ROOT, "bin", "orchestrator.js");
}

/**
 * The command baked into installed skills: this Node binary + the launcher, both absolute. Agent
 * shells often have another Node first on PATH (a login shell picked Node 16 under Codex), and
 * `orchestrator` itself is usually not on PATH, so neither is relied on.
 */
export function launcherCommand(): string {
  return [process.execPath, launcherPath()].map(shellQuote).join(" ");
}

function shellQuote(p: string): string {
  return /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

export function skillVersion(pkgVersion: string): string {
  return `${pkgVersion}+${loadSkillSource().sourceSha256.slice(0, 10)}`;
}

interface TargetOpts {
  provider?: string;
  all?: boolean;
  claudeHome?: string[];
  codexSkillsDir?: string;
  json?: boolean;
  force?: boolean;
}

function providersFrom(opts: TargetOpts, defaultAll: boolean): Provider[] {
  if (opts.all) return PROVIDERS;
  if (opts.provider) {
    if (!PROVIDERS.includes(opts.provider as Provider)) throw new Error(`unknown provider "${opts.provider}" (expected: ${PROVIDERS.join(", ")})`);
    return [opts.provider as Provider];
  }
  if (defaultAll) return PROVIDERS;
  throw new Error("choose --provider claude|codex or --all");
}

const KNOWN_LIMITS: Record<Provider, string[]> = {
  claude: [
    "Automatic activation is the model's choice from the skill description; it is likely but not guaranteed for any given sentence. /orchestrate always works.",
    "Claude Code picks up new or edited skills in a running session; a skills directory created after the session started needs /reload-skills (or a new session).",
    "With many skills installed, Claude Code may drop descriptions from its listing (1% context budget); see /doctor.",
  ],
  codex: [
    "Automatic activation is the model's choice from the skill description; $orchestrate always works.",
    "Codex detects new skills automatically; if one does not appear, restart the Codex session.",
  ],
};

function commonOptions(cmd: Command): Command {
  return cmd
    .option("--provider <name>", "claude or codex")
    .option("--all", "every supported provider")
    .option("--claude-home <dir>", "Claude Code config dir to use instead of the detected ones (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--codex-skills-dir <dir>", "Codex skills dir instead of ~/.agents/skills")
    .option("--json", "versioned JSON (schemaVersion 1)");
}

function overridesFrom(opts: TargetOpts): { claudeHomes?: string[]; codexSkillsDir?: string } {
  return { ...(opts.claudeHome?.length ? { claudeHomes: opts.claudeHome } : {}), ...(opts.codexSkillsDir ? { codexSkillsDir: opts.codexSkillsDir } : {}) };
}

function printActions(results: ActionResult[]): void {
  for (const r of results) {
    const color = r.action === "skipped" ? c.yellow : r.action === "installed" || r.action === "updated" || r.action === "removed" ? c.green : c.dim;
    console.log(`${color(r.action.padEnd(13))} ${r.provider.padEnd(7)} ${r.path}  ${c.dim(r.detail)}`);
  }
}

export function registerSkillCommands(program: Command, pkgVersion: string): void {
  const skill = program.command("skill").description("Install the Orchestrator skill for Claude Code and Codex (user level: works in every project)");

  commonOptions(skill.command("install"))
    .description("Install (or upgrade) the skill. Idempotent; never touches skills it does not own")
    .option("--force", "replace operator-edited skill files (the edited copies are kept as *.orig-<timestamp>)")
    .action((opts: TargetOpts) => {
      output.json = Boolean(opts.json);
      const se = skillEnv();
      const results = providersFrom(opts, false).flatMap((p) => defaultTargets(p, se, overridesFrom(opts)).map((t) => installTo(t, { cli: launcherCommand(), version: skillVersion(pkgVersion), se, ...(opts.force ? { force: true } : {}) })));
      if (opts.json) return printJson("skill_install", results);
      printActions(results);
      if (results.some((r) => r.action === "installed" || r.action === "updated")) {
        console.log(c.dim("\nIn any project: ask \"Use Orchestrator to implement BRU-488\", or type /orchestrate BRU-488 (Claude Code) / $orchestrate BRU-488 (Codex).\nCheck discovery with: orchestrator skill verify --all"));
      }
      if (results.some((r) => r.action === "skipped")) process.exitCode = 1;
    });

  commonOptions(skill.command("update"))
    .description("Upgrade existing Orchestrator-owned installs to this version (installs nothing new)")
    .option("--force", "replace operator-edited skill files (the edited copies are kept as *.orig-<timestamp>)")
    .action((opts: TargetOpts) => {
      output.json = Boolean(opts.json);
      const se = skillEnv();
      const results = providersFrom(opts, true).flatMap((p) => defaultTargets(p, se, overridesFrom(opts)).map((t) => installTo(t, { cli: launcherCommand(), version: skillVersion(pkgVersion), se, onlyInstalled: true, ...(opts.force ? { force: true } : {}) })));
      if (opts.json) return printJson("skill_update", results);
      printActions(results);
    });

  commonOptions(skill.command("uninstall"))
    .description("Remove Orchestrator-owned skill files only")
    .option("--force", "also remove skill files the operator edited")
    .action((opts: TargetOpts) => {
      output.json = Boolean(opts.json);
      const se = skillEnv();
      const results = providersFrom(opts, false).flatMap((p) => defaultTargets(p, se, overridesFrom(opts)).map((t) => uninstallFrom(t, { ...(opts.force ? { force: true } : {}) })));
      if (opts.json) return printJson("skill_uninstall", results);
      printActions(results);
    });

  commonOptions(skill.command("status"))
    .description("Where the skill is installed, which version, whether it is current, and known discovery limits")
    .action(async (opts: TargetOpts) => {
      output.json = Boolean(opts.json);
      const se = skillEnv();
      const version = skillVersion(pkgVersion);
      const providers = providersFrom(opts, true);
      const statuses: TargetStatus[] = providers.flatMap((p) => skillStatus(p, se, { cli: launcherCommand(), version, ...overridesFrom(opts) }));
      const versions = Object.fromEntries(await Promise.all(providers.map(async (p) => [p, await probe(p === "claude" ? "claude" : "codex")] as const)));
      const data = {
        skillVersion: version,
        cli: { command: launcherCommand(), version: pkgVersion },
        providers: providers.map((p) => ({ provider: p, cliVersion: versions[p] ?? null, targets: statuses.filter((s) => s.provider === p), limitations: KNOWN_LIMITS[p] })),
      };
      if (opts.json) return printJson("skill_status", data);
      console.log(`${c.bold("Orchestrator skill")} ${version}  ${c.dim(`CLI ${launcherCommand()}`)}`);
      for (const p of data.providers) {
        console.log(`\n${c.bold(p.provider === "claude" ? "Claude Code" : "Codex")} ${p.cliVersion ? c.dim(p.cliVersion) : c.yellow("(not found on PATH)")}`);
        for (const t of p.targets) {
          const color = t.state === "current" ? c.green : t.state === "not_installed" ? c.dim : c.yellow;
          console.log(`  ${color(t.state.padEnd(14))} ${t.path}  ${c.dim(`${t.why}${t.installedVersion ? `, installed ${t.installedVersion}` : ""}`)}`);
          for (const n of t.notes) console.log(`  ${" ".repeat(14)} ${c.yellow(n)}`);
          if (t.modifiedFiles.length) console.log(`  ${" ".repeat(14)} ${c.yellow(`edited by the operator: ${t.modifiedFiles.join(", ")}`)}`);
        }
        for (const l of p.limitations) console.log(c.dim(`  · ${l}`));
      }
    });

  commonOptions(skill.command("verify"))
    .description("Non-destructive discovery check: Codex renders its model-visible skill catalog (no model call); Claude Code's SKILL.md is parsed as Claude Code does")
    .action(async (opts: TargetOpts) => {
      output.json = Boolean(opts.json);
      const se = skillEnv();
      const statuses = providersFrom(opts, true).flatMap((p) => skillStatus(p, se, { cli: launcherCommand(), version: skillVersion(pkgVersion), ...overridesFrom(opts) }));
      const results = [];
      for (const s of statuses) {
        if (s.state === "not_installed" || s.state === "foreign") {
          results.push({ provider: s.provider, path: s.path, ok: false, method: "-", detail: s.state === "foreign" ? "a different skill with this name is installed here" : "not installed" });
          continue;
        }
        results.push(s.provider === "claude" ? verifyClaude(s) : await verifyCodex(s));
      }
      if (opts.json) printJson("skill_verify", { results, note: "Discovery checks only. Whether a model chooses the skill for a sentence is measured with real calls: pnpm eval:skills" });
      else {
        for (const r of results) console.log(`${r.ok ? c.green("✓") : c.red("✗")} ${r.provider.padEnd(7)} ${r.path}\n    ${r.detail}\n    ${c.dim(r.method)}`);
        console.log(c.dim("\nThis proves discovery, not model choice. Measure activation with real model calls: corepack pnpm eval:skills"));
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    });

  // Deprecated alias kept for existing instructions.
  program
    .command("install-skill")
    .description("Deprecated: use `orchestrator skill install --provider claude`")
    .option("--dir <skills-dir>", "Claude Code skills directory")
    .action((opts: { dir?: string }) => {
      const se = skillEnv();
      const targets = opts.dir ? [{ provider: "claude" as const, dir: opts.dir, why: "--dir" }] : defaultTargets("claude", se);
      console.error(c.yellow("install-skill is deprecated; use: orchestrator skill install --all"));
      printActions(targets.map((t) => installTo(t, { cli: launcherCommand(), version: skillVersion(pkgVersion), se })));
    });
}
