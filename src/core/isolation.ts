import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Process isolation for everything the orchestrator runs on behalf of a
 * repository or an agent. Three layers, none of which is claimed to be a VM:
 *
 *  1. Environment allow-list: children get only what they need to run;
 *     tokens, SSH agents and credential helpers are not passed on.
 *  2. OS sandbox (macOS Seatbelt via /usr/bin/sandbox-exec) for setup and
 *     check commands: writes confined to the worktree and caches, credential
 *     paths unreadable, network off for checks.
 *  3. Tripwires: hashes of sensitive files outside the worktree, compared
 *     after every agent and check step.
 *
 * Claude Code's implementer Bash runs inside Claude Code's own sandbox
 * (configured in claudeIsolationSettings below), also Seatbelt on macOS.
 */

// ---- 1. environment ---------------------------------------------------------------

/** Variables children may inherit. Everything else is dropped. */
const BASE_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "TZ",
  "NVM_DIR",
  "COREPACK_HOME",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

/** Extra variables a specific agent needs to authenticate itself. */
export const AGENT_ENV: Record<string, string[]> = {
  "claude-code": ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  mock: [],
};

/** Never passed to any child, even if a config lists it. */
export const ALWAYS_DENIED_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "LINEAR_API_KEY",
  "LINEAR_API_KEY_FILE",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "T3CODE_CLI_PATH",
];

export interface ChildEnvOptions {
  /** Agent adapter id, to pass its own auth variables. */
  agent?: string;
  /** Operator-configured additions (toolchain.env). Secrets in ALWAYS_DENIED_ENV are still dropped. */
  extra?: Record<string, string>;
  /** Isolated config dirs (see isolationDirs). */
  dirs: IsolationDirs;
}

export function childEnv(base: NodeJS.ProcessEnv, opts: ChildEnvOptions): NodeJS.ProcessEnv {
  const allow = new Set([...BASE_ALLOW, ...(opts.agent ? (AGENT_ENV[opts.agent] ?? []) : [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (allow.has(k) || k.startsWith("LC_")) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) env[k] = v;
  for (const k of ALWAYS_DENIED_ENV) delete env[k];
  return {
    ...env,
    // No interactive git, no system/global git config (credential helpers, insteadOf rewrites, hooksPath).
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: opts.dirs.emptyGitConfig,
    // A gh with an empty config dir knows no hosts, so it cannot find a token.
    GH_CONFIG_DIR: opts.dirs.emptyGhConfig,
    GH_PROMPT_DISABLED: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    CI: "1",
  };
}

export interface IsolationDirs {
  root: string;
  emptyGitConfig: string;
  emptyGhConfig: string;
}

export function isolationDirs(home: string): IsolationDirs {
  const root = join(home, "isolation");
  const emptyGhConfig = join(root, "gh-empty");
  const emptyGitConfig = join(root, "gitconfig-empty");
  mkdirSync(emptyGhConfig, { recursive: true });
  if (!existsSync(emptyGitConfig)) writeFileSync(emptyGitConfig, "# intentionally empty: children get no global git config\n");
  return { root, emptyGitConfig, emptyGhConfig };
}

// ---- credential locations ----------------------------------------------------------

/** Paths no child process should be able to read. Missing paths are harmless. */
export function credentialPaths(env: NodeJS.ProcessEnv, orchestratorHome: string): string[] {
  const h = env.HOME ?? homedir();
  return [
    join(h, ".ssh"),
    join(h, ".gnupg"),
    join(h, ".aws"),
    join(h, ".azure"),
    join(h, ".kube"),
    join(h, ".docker"),
    join(h, ".netrc"),
    join(h, ".npmrc"),
    join(h, ".config", "gh"),
    join(h, ".config", "gcloud"),
    join(h, ".config", "git", "credentials"),
    join(h, ".git-credentials"),
    // Global git config can hold credentials (e.g. a token inside a url.<base>.insteadOf). Children
    // never need it: they run with GIT_CONFIG_GLOBAL pointing at an empty file (childEnv).
    join(h, ".gitconfig"),
    join(h, ".config", "git", "config"),
    join(h, ".t3", "userdata"),
    join(h, ".codex"),
    join(h, ".claude"),
    join(h, ".claude.json"),
    join(h, "Library", "Keychains"),
    ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
    ...(env.CODEX_HOME ? [env.CODEX_HOME] : []),
    ...(env.LINEAR_API_KEY_FILE ? [env.LINEAR_API_KEY_FILE] : []),
    join(orchestratorHome, "credentials"),
    join(orchestratorHome, "orchestrator.db"),
    join(orchestratorHome, "orchestrator.db-wal"),
    join(orchestratorHome, "orchestrator.db-shm"),
    join(orchestratorHome, "runs"),
    join(orchestratorHome, "repos"),
  ];
}

// ---- 2. OS sandbox for setup/check commands ----------------------------------------

export type NetworkPolicy = "none" | "outbound";

export interface SandboxSpec {
  /** Directories the command may write to. */
  writable: string[];
  /**
   * Paths inside `writable` that stay unwritable: the worktree's `.git` gitfile, which points the
   * orchestrator's own (unsandboxed) git at a git directory. Rewritten, it could redirect that git
   * to a config with filters or an ssh command.
   */
  readOnly?: string[];
  /** Paths the command may not read. */
  denyRead: string[];
  /**
   * File contents under `home` are unreadable except in `readable` (and `writable`). Used where a
   * command's output is published (screenshots): it then sees only what it needs, not your files.
   */
  privateHome?: { home: string; readable: string[] };
  network: NetworkPolicy;
}

export interface SandboxSupport {
  available: boolean;
  mechanism: "seatbelt" | "none";
  detail: string;
}

export function sandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return { available: true, mechanism: "seatbelt", detail: "macOS Seatbelt (/usr/bin/sandbox-exec)" };
  }
  return {
    available: false,
    mechanism: "none",
    detail:
      platform === "linux"
        ? "no check sandbox implemented for Linux yet (bubblewrap support is on the roadmap)"
        : `no check sandbox available on ${platform}`,
  };
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function sbString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Seatbelt profile: everything not denied is allowed (so ordinary tooling
 * works), but file writes are denied except in `writable`, reads of
 * credential paths are denied, keychain services are unreachable, and
 * network is off (or outbound-only for setup).
 */
export function seatbeltProfile(spec: SandboxSpec): string {
  const writable = [...new Set(spec.writable.map(real))];
  const denyRead = [...new Set(spec.denyRead.flatMap((p) => [p, real(p)]))];
  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    ";; Writes only inside the worktree, temp dirs and package caches.",
    "(deny file-write*)",
    "(allow file-write*",
    ...writable.map((p) => `  (subpath ${sbString(p)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))',
    ...(spec.readOnly?.length
      ? ["", ";; Never writable, even inside the worktree (later rules win).", "(deny file-write*", ...[...new Set(spec.readOnly.flatMap((p) => [p, real(p)]))].map((p) => `  (literal ${sbString(p)}) (subpath ${sbString(p)})`), ")"]
      : []),
    ...(spec.privateHome
      ? [
          "",
          ";; Home directory contents are unreadable except the listed paths (metadata stays visible).",
          `(deny file-read-data (subpath ${sbString(real(spec.privateHome.home))}))`,
          "(allow file-read-data",
          ...[...new Set(spec.privateHome.readable.flatMap((p) => [p, real(p)]))].map((p) => `  (subpath ${sbString(p)})`),
          ")",
        ]
      : []),
    "",
    ";; Credentials are not readable. Denied for file-read-data as well: a rule naming that specific",
    ";; operation (the private-home allow-list) would otherwise take precedence over file-read*.",
    "(deny file-read*",
    ...denyRead.map((p) => `  (subpath ${sbString(p)})`),
    ")",
    "(deny file-read-data",
    ...denyRead.map((p) => `  (subpath ${sbString(p)})`),
    ")",
    "",
    ";; No access to keychain services (git/gh credential helpers use them).",
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    "",
  ];
  if (spec.network === "none") {
    lines.push(";; No network except loopback (tests may bind localhost).", "(deny network-outbound)", '(allow network-outbound (remote ip "localhost:*"))', '(allow network-outbound (remote unix-socket))');
  } else {
    lines.push(";; Outbound network allowed (package installation). Credentials above stay unreadable.");
  }
  return lines.join("\n");
}

/** Wrap a shell command so it runs inside the sandbox. */
export function sandboxedShell(command: string, spec: SandboxSpec): { command: string; args: string[] } {
  return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(spec), "/bin/sh", "-c", command] };
}

/**
 * What repository code (setup, checks, screenshots) may read under $HOME: the worktree, the clone's
 * git directory (read-only: tests may run git), the pinned toolchain, the specific package-manager
 * and browser caches it needs, and whatever the operator lists in `isolation.read_paths`. Everything
 * else in your home directory (shell history, other repositories, tool configs holding tokens) is
 * unreadable. Other caches stay writable but not readable.
 */
export function repositoryReadPaths(input: { worktree: string; gitDir?: string | null; toolchain: string[]; extra?: string[]; env: NodeJS.ProcessEnv }): string[] {
  const h = input.env.HOME ?? homedir();
  return [
    input.worktree,
    ...(input.gitDir ? [input.gitDir] : []),
    ...input.toolchain,
    ...toolchainCaches(input.env),
    input.env.PLAYWRIGHT_BROWSERS_PATH ?? join(h, "Library", "Caches", "ms-playwright"),
    join(h, "Library", "Caches", "pnpm"),
    join(h, "Library", "pnpm"),
    join(h, ".local", "share", "pnpm"),
    join(h, ".pnpm-store"),
    join(h, ".npm"),
    ...(input.extra ?? []),
  ];
}

/** Standard writable set for a worktree: the worktree itself, temp, and package-manager caches. */
export function defaultWritable(worktree: string, env: NodeJS.ProcessEnv): string[] {
  const h = env.HOME ?? homedir();
  return [
    worktree,
    tmpdir(),
    "/private/tmp",
    "/private/var/folders",
    join(h, "Library", "pnpm"),
    join(h, "Library", "Caches"),
    join(h, ".cache"),
    join(h, ".npm"),
    join(h, ".local", "share", "pnpm"),
    join(h, ".pnpm-store"),
    ...(env.XDG_CACHE_HOME ? [env.XDG_CACHE_HOME] : []),
  ];
}

// ---- Claude Code's own sandbox -----------------------------------------------------

export const MIN_CLAUDE_VERSION_FOR_ISOLATION = "2.1.314"; // permissions.blockWritesOutsideWorkingDirectories

/**
 * Settings passed with `claude --settings` (and `--setting-sources ""`, so the
 * repository's .claude/settings*.json and the operator's user settings do not
 * apply). Verified empirically on 2.1.318 (see docs/isolation.md).
 */
export function claudeIsolationSettings(input: { denyRead: string[]; deniedEnv: string[]; allow: string[]; deny: string[]; allowWrite?: string[]; allowRead?: string[]; denyWrite?: string[] }): object {
  const toolCaches = input.allowWrite ?? [];
  return {
    disableAllHooks: true,
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: false,
    // Auto memory lives outside the worktree (<config>/projects/<repo>/memory, shared by every
    // worktree of the clone) and is loaded into later sessions: an isolated run must neither read a
    // previous run's notes nor leave its own. The adapter also sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1.
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      allow: input.allow,
      deny: input.deny,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      // Outside the worktree the shell may read only: tool caches it must also update (corepack's
      // lastKnownGood.json), the pinned Node install it executes, and the orchestrator's empty
      // git/gh config stubs (GIT_CONFIG_GLOBAL points there, so git fails if it cannot read it).
      filesystem: {
        denyRead: input.denyRead,
        allowRead: [...new Set([...toolCaches, ...(input.allowRead ?? [])])],
        allowWrite: toolCaches,
        // The worktree's `.git` gitfile steers the orchestrator's own git; Claude Code protects only
        // `.git/hooks` and `.git/config`, not the gitfile of a linked worktree.
        ...(input.denyWrite?.length ? { denyWrite: input.denyWrite } : {}),
      },
      network: { allowedDomains: [] },
      credentials: { envVars: input.deniedEnv.map((name) => ({ name, mode: "deny" })) },
    },
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Caches the package-manager toolchain must write even inside the agent sandbox. */
export function toolchainCaches(env: NodeJS.ProcessEnv): string[] {
  const h = env.HOME ?? homedir();
  return [env.COREPACK_HOME ?? join(h, ".cache", "node", "corepack")];
}

/**
 * Files inside a readable toolchain installation that can hold credentials (npm's global config,
 * `<prefix>/etc/npmrc`, may carry registry tokens). Denied even though the installation is readable:
 * in Claude Code's sandbox the narrower rule wins, so these stay blocked.
 */
export function toolchainSecretPaths(readable: string[]): string[] {
  return readable.flatMap((dir) => [join(dir, "etc", "npmrc"), join(dir, ".npmrc")]);
}

/** Read-only paths every agent shell needs outside the worktree: the isolation stubs childEnv points at. */
export function isolationReadPaths(dirs: IsolationDirs): string[] {
  return [dirs.emptyGitConfig, dirs.emptyGhConfig];
}

// ---- 3. tripwires ------------------------------------------------------------------

export interface TripwireSnapshot {
  takenAt: string;
  entries: Record<string, string>;
}

/** Files outside the worktree that an escaped process would most likely touch. */
export function tripwirePaths(env: NodeJS.ProcessEnv, gitDirs: string[]): string[] {
  const h = env.HOME ?? homedir();
  const files = [
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".gitconfig",
    ".npmrc",
    ".ssh/authorized_keys",
    ".ssh/config",
    ".claude/settings.json",
    ".codex/config.toml",
  ].map((f) => join(h, f));
  if (env.CLAUDE_CONFIG_DIR) files.push(join(env.CLAUDE_CONFIG_DIR, "settings.json"));
  for (const g of gitDirs) files.push(join(g, "config"), join(g, "hooks"), join(g, "info", "attributes"));
  return files;
}

function fingerprint(path: string): string {
  if (!existsSync(path)) return "absent";
  const st = statSync(path);
  if (st.isDirectory()) {
    const items = readdirSync(path)
      .sort()
      .map((name) => `${name}:${fingerprint(join(path, name))}`);
    return `dir:${createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 16)}`;
  }
  return `file:${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)}`;
}

export function takeTripwire(paths: string[], now = new Date()): TripwireSnapshot {
  return { takenAt: now.toISOString(), entries: Object.fromEntries(paths.map((p) => [p, fingerprint(p)])) };
}

/**
 * What the operator needs to investigate a tripwire hit, without file contents (a changed file may
 * hold a credential): both fingerprints and the file's current metadata. A new inode or a birth time
 * after the snapshot means the file was replaced (git, editors and most tools write a temp file and
 * rename it). The tripwire cannot tell which process wrote it: any process running as the operator,
 * including unrelated sessions outside the orchestrator, can change these files.
 */
export interface TripwireChange {
  path: string;
  before: string;
  after: string;
  now: { exists: boolean; size?: number; mtime?: string; ctime?: string; birthtime?: string; inode?: number; kind?: "file" | "dir" | "symlink" | "other" };
}

export function describeTripwireChanges(before: TripwireSnapshot, after: TripwireSnapshot): TripwireChange[] {
  return compareTripwire(before, after).map((path) => {
    let now: TripwireChange["now"] = { exists: false };
    try {
      const st = lstatSync(path);
      now = {
        exists: true,
        size: st.size,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
        birthtime: st.birthtime.toISOString(),
        inode: st.ino,
        kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      };
    } catch {
      /* removed */
    }
    return { path, before: before.entries[path] ?? "absent", after: after.entries[path] ?? "absent", now };
  });
}

export function compareTripwire(before: TripwireSnapshot, after: TripwireSnapshot): string[] {
  const changed: string[] = [];
  for (const [path, fp] of Object.entries(before.entries)) {
    if (after.entries[path] !== fp) changed.push(path);
  }
  return changed;
}
