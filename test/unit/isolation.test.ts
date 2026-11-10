import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ShellCheckRunner } from "../../src/adapters/checks.js";
import { ClaudeCodeAgent, DEFAULT_DENIED } from "../../src/adapters/claude.js";
import {
  childEnv,
  claudeIsolationSettings,
  compareTripwire,
  compareVersions,
  credentialPaths,
  defaultWritable,
  describeTripwireChanges,
  isolationDirs,
  isolationReadPaths,
  repositoryReadPaths,
  sandboxSupport,
  seatbeltProfile,
  takeTripwire,
} from "../../src/core/isolation.js";
import { Redactor } from "../../src/core/redact.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-iso-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const dirs = isolationDirs(join(scratch, "home"));

describe("childEnv", () => {
  const base = {
    PATH: "/bin",
    HOME: "/Users/me",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    GH_TOKEN: "ghp_x",
    GITHUB_TOKEN: "y",
    LINEAR_API_KEY: "lin",
    LINEAR_API_KEY_FILE: "/f",
    SSH_AUTH_SOCK: "/s",
    AWS_SECRET_ACCESS_KEY: "a",
    CLAUDE_CONFIG_DIR: "/c",
    ANTHROPIC_API_KEY: "sk",
    OPENAI_API_KEY: "o",
    RANDOM_APP_SECRET: "r",
    CLAUDECODE: "1",
  };
  it("passes only the allow-list and drops every credential", () => {
    const env = childEnv(base, { dirs });
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "LINEAR_API_KEY_FILE", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "RANDOM_APP_SECRET", "CLAUDECODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/Users/me", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: dirs.emptyGhConfig, GIT_CONFIG_GLOBAL: dirs.emptyGitConfig });
  });
  it("gives an agent only its own auth variables", () => {
    expect(childEnv(base, { agent: "claude-code", dirs })).toMatchObject({ CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "sk" });
    expect(childEnv(base, { agent: "claude-code", dirs }).OPENAI_API_KEY).toBeUndefined();
    expect(childEnv(base, { agent: "codex", dirs })).toMatchObject({ OPENAI_API_KEY: "o" });
    expect(childEnv(base, { agent: "codex", dirs }).ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("never lets operator config re-add a denied token", () => {
    expect(childEnv(base, { dirs, extra: { GH_TOKEN: "sneaky", FOO: "bar" } })).toMatchObject({ FOO: "bar" });
    expect(childEnv(base, { dirs, extra: { GH_TOKEN: "sneaky" } }).GH_TOKEN).toBeUndefined();
  });
});

describe("seatbelt profile", () => {
  it("denies writes by default, credential reads, keychain, and network for checks", () => {
    const p = seatbeltProfile({ writable: ["/wt"], denyRead: ["/Users/me/.ssh"], network: "none" });
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/wt")');
    expect(p).toMatch(/\(deny file-read\*[\s\S]*\/Users\/me\/\.ssh/);
    expect(p).toContain('global-name "com.apple.SecurityServer"');
    expect(p).toContain("(deny network-outbound)");
    expect(seatbeltProfile({ writable: ["/wt"], denyRead: [], network: "outbound" })).not.toContain("(deny network-outbound)");
  });
  it("covers the usual credential stores and orchestrator state", () => {
    const paths = credentialPaths({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work2" }, "/Users/me/.orchestrator");
    for (const p of [".ssh", ".config/gh", ".t3/userdata", ".codex", ".aws", ".npmrc", "Library/Keychains"]) expect(paths).toContain(`/Users/me/${p}`);
    expect(paths).toEqual(expect.arrayContaining(["/Users/me/.claude-work2", "/Users/me/.orchestrator/orchestrator.db", "/Users/me/.orchestrator/runs"]));
  });
});

describe("Claude Code isolation settings", () => {
  const settings = claudeIsolationSettings({ denyRead: ["/Users/me/.ssh"], deniedEnv: ["GH_TOKEN"], allow: [], deny: DEFAULT_DENIED }) as Record<string, any>;
  it("fails closed and forbids unsandboxed retries", () => {
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { allowedDomains: [] } });
    expect(settings.sandbox.credentials.envVars).toEqual([{ name: "GH_TOKEN", mode: "deny" }]);
    expect(settings.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true });
    expect(settings).toMatchObject({ disableAllHooks: true, disableClaudeAiConnectors: true, enableAllProjectMcpServers: false });
  });
  it("implementer invocation excludes repository/user settings and MCP, and denies exfiltration tools", () => {
    const agent = new ClaudeCodeAgent({ adapter: "claude-code", permission_mode: "acceptEdits", allowed_tools: ["Read"], disallowed_tools: [], timeout_minutes: 1 }, { denyRead: ["/x"], deniedEnv: ["GH_TOKEN"] });
    const args = agent.args({ role: "implementer", sessionId: "s", maxBudgetUsd: 3.2 });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Read,Edit,Write,Glob,Grep");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("3.20");
    const disallowed = args.slice(args.indexOf("--disallowedTools") + 1);
    for (const t of ["Bash(curl:*)", "Bash(gh:*)", "Bash(git push:*)", "Bash(security:*)", "WebFetch"]) expect(disallowed).toContain(t);
    const s = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(s.sandbox.filesystem.denyRead).toEqual(["/x"]);
  });
  it("requires a Claude Code version with blockWritesOutsideWorkingDirectories", () => {
    expect(compareVersions("2.1.318", "2.1.314")).toBe(1);
    expect(compareVersions("2.1.300", "2.1.314")).toBe(-1);
  });
});

describe("global git config", () => {
  it("is unreadable to sandboxed children, who get an empty one instead (it can hold tokens)", () => {
    const paths = credentialPaths({ HOME: "/Users/me" }, "/Users/me/.orchestrator");
    expect(paths).toEqual(expect.arrayContaining(["/Users/me/.gitconfig", "/Users/me/.config/git/config"]));
    expect(childEnv({ HOME: "/Users/me" }, { dirs }).GIT_CONFIG_GLOBAL).toBe(dirs.emptyGitConfig);
    // The agent shell must still be able to read the empty stand-in, or every git command fails.
    expect(isolationReadPaths(dirs)).toEqual([dirs.emptyGitConfig, dirs.emptyGhConfig]);
  });
});

describe("what repository code may read under $HOME", () => {
  it("is the worktree, the clone's git dir, the toolchain, specific caches and operator extras only", () => {
    const env = { HOME: "/Users/me" };
    const paths = repositoryReadPaths({ worktree: "/Users/me/.orchestrator/worktrees/a/b/r1", gitDir: "/Users/me/.orchestrator/clones/a/b/.git", toolchain: ["/Users/me/.nvm/versions/node/v24.21.0"], extra: ["/Users/me/opt/tool"], env });
    expect(paths).toEqual(
      expect.arrayContaining(["/Users/me/.orchestrator/worktrees/a/b/r1", "/Users/me/.orchestrator/clones/a/b/.git", "/Users/me/.nvm/versions/node/v24.21.0", "/Users/me/.cache/node/corepack", "/Users/me/Library/Caches/ms-playwright", "/Users/me/opt/tool"]),
    );
    // Never the home directory or a whole cache root: those hold other tools' tokens and browser data.
    for (const broad of ["/Users/me", "/Users/me/Library", "/Users/me/Library/Caches", "/Users/me/.cache", "/Users/me/.config"]) expect(paths).not.toContain(broad);
  });
});

describe("Claude Code auto memory", () => {
  it("is off in the isolation settings", () => {
    expect(claudeIsolationSettings({ denyRead: [], deniedEnv: [], allow: [], deny: [] })).toMatchObject({ autoMemoryEnabled: false });
  });
});

describe("tripwire evidence", () => {
  it("records hashes and metadata, never contents, and shows a file replaced by rename (how git config writes)", () => {
    const dir = join(scratch, "trip-evidence");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, ".gitconfig");
    writeFileSync(f, "[user]\n\tname = me\n");
    const before = takeTripwire([f]);
    const inode = statSync(f).ino;
    writeFileSync(`${f}.lock`, "[url \"https://x-access-token:SECRET@github.com/\"]\n");
    renameSync(`${f}.lock`, f);
    const details = describeTripwireChanges(before, takeTripwire([f]));
    expect(details).toHaveLength(1);
    expect(details[0]!.path).toBe(f);
    expect(details[0]!.before).not.toBe(details[0]!.after);
    expect(details[0]!.now).toMatchObject({ exists: true, kind: "file" });
    expect(details[0]!.now.inode).not.toBe(inode);
    expect(JSON.stringify(details)).not.toContain("SECRET");
  });
});

describe("tripwires", () => {
  it("detect created, modified and deleted files and changed directories", () => {
    const dir = join(scratch, "tw");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "config"), "a");
    const paths = [join(dir, "config"), join(dir, "hooks"), join(dir, "absent")];
    const before = takeTripwire(paths);
    expect(compareTripwire(before, takeTripwire(paths))).toEqual([]);
    writeFileSync(join(dir, "config"), "b");
    writeFileSync(join(dir, "hooks", "pre-commit"), "#!/bin/sh");
    writeFileSync(join(dir, "absent"), "now here");
    expect(compareTripwire(before, takeTripwire(paths)).sort()).toEqual(paths.sort());
  });
});

describe("secret scan", () => {
  it("finds token shapes and known secret values without echoing them", () => {
    const r = new Redactor({ MY_SERVICE_TOKEN: "s3cr3t-known-value-1234" });
    expect(r.findSecrets("const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';")).toEqual(["GitHub token"]);
    expect(r.findSecrets("x = s3cr3t-known-value-1234")).toEqual(["a known secret value (from the operator environment)"]);
    expect(r.findSecrets("const token = generateMetricProposalToken();")).toEqual([]);
  });
});

describe.runIf(sandboxSupport().available)("Seatbelt sandbox, for real (macOS)", () => {
  const wt = join(scratch, "worktree");
  mkdirSync(wt, { recursive: true });
  const outside = join(homedir(), `.orch-sandbox-test-${process.pid}`);
  const runner = new ShellCheckRunner(new Redactor({}));
  const env = childEnv({ ...process.env, GH_TOKEN: "ghp_shouldnotleakshouldnotleak1234" }, { dirs });
  const run = (command: string, network: "none" | "outbound" = "none") =>
    runner.run({
      name: "probe",
      command,
      cwd: wt,
      env,
      timeoutMs: 20_000,
      optional: false,
      logPath: join(scratch, "logs", `${Math.random()}.log`),
      signal: new AbortController().signal,
      sandbox: { writable: defaultWritable(wt, process.env), denyRead: credentialPaths(process.env, join(scratch, "home")), network },
    });

  it("allows writing inside the worktree", async () => {
    expect((await run("echo ok > inside.txt")).ok).toBe(true);
    expect(existsSync(join(wt, "inside.txt"))).toBe(true);
  });
  it("blocks writing outside it", async () => {
    const r = await run(`touch "${outside}"`);
    expect(r.ok).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });
  it("blocks reading SSH keys and gh credentials", async () => {
    expect((await run("ls ~/.ssh")).ok).toBe(false);
    expect((await run("cat ~/.config/gh/hosts.yml")).ok).toBe(false);
  });
  it("hides tokens and blocks network", async () => {
    expect((await run('test -z "$GH_TOKEN"')).ok).toBe(true);
    expect((await run("node -e \"require('https').get('https://example.com',()=>process.exit(0)).on('error',()=>process.exit(1))\"")).ok).toBe(false);
  });

  // A private "home" inside the scratch dir: readable/unreadable rules are the same as for $HOME.
  const home = join(scratch, "private-home");
  const wt2 = join(home, "wt");
  const cache = join(home, "cache");
  const creds = join(cache, "creds");
  for (const d of [wt2, creds]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wt2, ".git"), "gitdir: /somewhere\n");
  writeFileSync(join(home, "notes.txt"), "personal");
  writeFileSync(join(cache, "tool.txt"), "cache");
  writeFileSync(join(creds, "key"), "secret");
  const strict = (command: string) =>
    runner.run({
      name: "probe",
      command,
      cwd: wt2,
      env,
      timeoutMs: 20_000,
      optional: false,
      logPath: join(scratch, "logs", `${Math.random()}.log`),
      signal: new AbortController().signal,
      sandbox: { writable: [wt2], readOnly: [join(wt2, ".git")], denyRead: [creds], privateHome: { home, readable: [wt2, cache] }, network: "none" },
    });

  it("never lets repository code rewrite, replace or delete the worktree's gitfile", async () => {
    expect((await strict("echo 'gitdir: /attacker' > .git")).ok).toBe(false);
    expect((await strict("echo x > g && mv g .git")).ok).toBe(false);
    expect((await strict("rm .git")).ok).toBe(false);
    expect(readFileSync(join(wt2, ".git"), "utf8")).toBe("gitdir: /somewhere\n");
    expect((await strict("echo ok > other.txt")).ok).toBe(true);
  });

  it("private home: only the worktree and allowed paths are readable, and credentials stay denied inside an allowed path", async () => {
    expect((await strict(`cat "${join(home, "notes.txt")}"`)).ok).toBe(false);
    expect((await strict(`ls "${home}"`)).ok).toBe(false);
    expect((await strict(`cat "${join(cache, "tool.txt")}"`)).ok).toBe(true);
    expect((await strict("cat other.txt || true; ls .")).ok).toBe(true);
    // Regression: a file-read-data allow outranked the file-read* credential deny until both were denied.
    expect((await strict(`cat "${join(creds, "key")}"`)).ok).toBe(false);
  });

  it("kills what a check leaves running in the background once it exits", async () => {
    const marker = join(wt, `late-${process.pid}.txt`);
    // Both kinds: one that keeps the output pipe open, one that detaches from it.
    expect((await run(`(sleep 1; touch "${marker}") & exit 0`)).ok).toBe(true);
    expect((await run(`(sleep 1; touch "${marker}.2") >/dev/null 2>&1 </dev/null & exit 0`)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.2`)).toBe(false);
  });
});
