import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/config/load.js";
import { ephemeralReasons } from "../../src/skills/launcher.js";

/** `orchestrator skill install` through the real CLI, into a throwaway HOME. */

const scratch = mkdtempSync(join(tmpdir(), "orch-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const cli = join(PACKAGE_ROOT, "bin", "orchestrator.js");
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };

const home = join(scratch, "home");
const orchHome = join(home, ".orchestrator");
mkdirSync(home, { recursive: true });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ORCHESTRATOR_HOME: orchHome, ORCHESTRATOR_T3_SETTINGS: join(home, "t3.json"), CLAUDE_CONFIG_DIR: join(home, ".claude-work2") };
const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...env, ...extra }, timeout: 120_000 });

describe("skill installation through the CLI", () => {
  const ephemeral = ephemeralReasons(PACKAGE_ROOT, { HOME: home });

  it("refuses an ephemeral source (linked worktree, temp dir) unless explicitly allowed", () => {
    const r = run(["skill", "install", "--all"]);
    if (ephemeral.length) {
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to install skills from .*Installed skills would break when it disappears/);
    } else {
      expect(r.status).toBe(0); // a stable checkout or global install
    }
  });

  it("installs skills that reference only the stable launcher (no checkout path, no Node binary)", () => {
    const r = run(["skill", "install", "--all", "--allow-ephemeral", "--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { data: { launcher: { path: string }; results: Array<{ provider: string; path: string; action: string }> } };
    const shim = join(orchHome, "bin", "orchestrator");
    expect(out.data.launcher.path).toBe(shim);
    // T3-style Claude config dir and the Codex user dir.
    expect(out.data.results.map((x) => [x.provider, x.path, x.action])).toEqual([
      ["claude", join(home, ".claude-work2", "skills", "orchestrate"), "installed"],
      ["codex", join(home, ".agents", "skills", "orchestrate"), "installed"],
    ]);
    for (const dir of [join(home, ".claude-work2", "skills", "orchestrate"), join(home, ".agents", "skills", "orchestrate")]) {
      const text = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(text).toContain(shim);
      expect(text).not.toContain(PACKAGE_ROOT);
      expect(text).not.toContain(process.execPath);
    }
    expect(readFileSync(join(home, ".claude-work2", "skills", "orchestrate", "SKILL.md"), "utf8")).toContain(`Bash(${shim} context:*)`);
  });

  it("the launcher runs this installation even when an incompatible Node is first on PATH", () => {
    const fake = join(scratch, "node16");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "node"), "#!/bin/sh\necho 'v16.14.0'; exit 1\n");
    chmodSync(join(fake, "node"), 0o755);
    const r = spawnSync(join(orchHome, "bin", "orchestrator"), ["--version"], { encoding: "utf8", env: { ...env, PATH: `${fake}:/usr/bin:/bin` }, timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("status reports the launcher target and whether it is stable", () => {
    const r = run(["skill", "status", "--json"]);
    const data = (JSON.parse(r.stdout) as { data: { launcher: { installed: boolean; packageRoot: string; packageRootExists: boolean; ephemeral: string[] }; providers: Array<{ targets: Array<{ state: string }> }> } }).data;
    expect(data.launcher).toMatchObject({ installed: true, packageRoot: PACKAGE_ROOT, packageRootExists: true, ephemeral });
    expect(data.providers.flatMap((p) => p.targets.map((t) => t.state))).toEqual(["current", "current"]);
  });

  it("re-installing is idempotent and the skills don't change when the launcher is repointed", () => {
    const before = readFileSync(join(home, ".agents", "skills", "orchestrate", "SKILL.md"), "utf8");
    const r = run(["skill", "install", "--all", "--allow-ephemeral", "--json"]);
    const out = JSON.parse(r.stdout) as { data: { launcher: { changed: boolean }; results: Array<{ action: string }> } };
    expect(out.data.launcher.changed).toBe(false);
    expect(out.data.results.map((x) => x.action)).toEqual(["unchanged", "unchanged"]);
    expect(readFileSync(join(home, ".agents", "skills", "orchestrate", "SKILL.md"), "utf8")).toBe(before);
  });
});
