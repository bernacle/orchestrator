import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeNode, nodeMatches, nodeRequirement, parseNodePin, resolveRunToolchain, resolveToolchain } from "../../src/adapters/checks.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { isolationDirs } from "../../src/core/isolation.js";
import { baselineAccepted } from "../../src/core/workflow.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-toolchain-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fake `node` that prints a version (or, with `byDir`, one chosen by the directory it runs in, like asdf). */
function fakeNode(dir: string, version: string, byDir?: { marker: string; version: string }): string {
  mkdirSync(dir, { recursive: true });
  const body = byDir ? `if [ -f "$PWD/${byDir.marker}" ]; then echo ${byDir.version}; else echo ${version}; fi` : `echo ${version}`;
  writeFileSync(join(dir, "node"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "node"), 0o755);
  return dir;
}

let n = 0;
/** PATH has Node 24.1.0 (like asdf's); nvm has 24.1.0 and 24.21.0, like the BRU-485 machine. */
function machine(opts: { byDir?: { marker: string; version: string } } = {}) {
  const root = join(scratch, `m${n++}`);
  const pathBin = fakeNode(join(root, "asdf-shims"), "v24.1.0", opts.byDir);
  const nvm = join(root, "nvm");
  fakeNode(join(nvm, "versions", "node", "v24.1.0", "bin"), "v24.1.0");
  fakeNode(join(nvm, "versions", "node", "v24.21.0", "bin"), "v24.21.0");
  fakeNode(join(nvm, "versions", "node", "v22.9.0", "bin"), "v22.9.0");
  const env = { PATH: `${pathBin}:/usr/bin:/bin`, HOME: root, NVM_DIR: nvm };
  return { root, env, nvm, dirs: isolationDirs(join(root, "orch-home")) };
}

describe("Node version pins", () => {
  it("parses plain pins and rejects aliases and ranges", () => {
    expect(parseNodePin("24")).toBe("24");
    expect(parseNodePin("v24.21.0\n")).toBe("24.21.0");
    expect(parseNodePin("# pinned\n24.21\n")).toBe("24.21");
    expect(parseNodePin("24.x")).toBe("24");
    expect(parseNodePin("lts/*")).toBeNull();
    expect(parseNodePin("node")).toBeNull();
    expect(parseNodePin(">=24")).toBeNull();
  });

  it("matches every component the pin names, and only those", () => {
    expect(nodeMatches("v24.1.0", "24")).toBe(true);
    expect(nodeMatches("v24.1.0", "24.21.0")).toBe(false); // the BRU-485 mismatch
    expect(nodeMatches("v24.21.0", "24.21.0")).toBe(true);
    expect(nodeMatches("v24.21.3", "24.21")).toBe(true);
    expect(nodeMatches("v24.2.0", "24.21")).toBe(false); // not a string prefix match
    expect(nodeMatches(null, "24")).toBe(false);
  });

  it("an exact .nvmrc refines a major-only toolchain.node; a major-only repository keeps major matching", () => {
    expect(nodeRequirement("24", { file: ".nvmrc", content: "24.21.0" }).pin).toEqual({ spec: "24.21.0", source: ".nvmrc (refines toolchain.node 24)" });
    expect(nodeRequirement("24", { file: ".nvmrc", content: "24" }).pin).toEqual({ spec: "24", source: "toolchain.node and .nvmrc" });
    expect(nodeRequirement("24", null).pin).toEqual({ spec: "24", source: "toolchain.node" });
    expect(nodeRequirement(undefined, { file: ".node-version", content: "v24.21.0" }).pin).toEqual({ spec: "24.21.0", source: ".node-version" });
    expect(nodeRequirement("24.21.0", { file: ".nvmrc", content: "24" }).pin?.spec).toBe("24.21.0");
    expect(nodeRequirement("24", { file: ".nvmrc", content: "lts/*" }).pin?.spec).toBe("24");
    expect(nodeRequirement(undefined, null)).toEqual({ pin: null, conflict: null });
  });

  it("toolchain.node_version_file: false keeps a repository that intentionally wants any release of the major", () => {
    expect(nodeRequirement("24", { file: ".nvmrc", content: "24.21.0" }, false).pin).toEqual({ spec: "24", source: "toolchain.node" });
  });

  it("a config that disagrees with the repository's version file is a conflict, not a guess", () => {
    expect(nodeRequirement("22", { file: ".nvmrc", content: "24.21.0" }).conflict).toMatch(/toolchain\.node 22 conflicts with the repository's \.nvmrc \(24\.21\.0\)/);
    expect(nodeRequirement("24.20.0", { file: ".nvmrc", content: "24.21.0" }).conflict).toBeTruthy();
  });

  it("the schema accepts exact and major versions and rejects anything else", () => {
    const base = { repo: "a/b", linear: { teams: ["A"] }, agents: { implementer: { adapter: "mock" }, reviewer: { adapter: "mock" } } };
    expect(RepoConfigSchema.parse({ ...base, toolchain: { node: "24.21.0" } }).toolchain).toMatchObject({ node: "24.21.0", node_version_file: true });
    expect(RepoConfigSchema.parse({ ...base, toolchain: { node: "24" } }).toolchain.node).toBe("24");
    expect(() => RepoConfigSchema.parse({ ...base, toolchain: { node: ">=24" } })).toThrow(/toolchain\.node must be a version/);
  });
});

describe("toolchain resolution", () => {
  it("an exact requirement is not satisfied by a same-major Node on PATH: nvm's exact version is prepended", async () => {
    const m = machine();
    const tc = await resolveToolchain({ spec: "24.21.0", source: ".nvmrc" }, {}, m.env);
    expect(tc.node).toMatchObject({ requested: "24.21.0", source: "nvm", version: "v24.21.0", binDir: join(m.nvm, "versions", "node", "v24.21.0", "bin") });
    expect(tc.env.PATH!.split(":")[0]).toBe(tc.node.binDir);
  });

  it("a major-only requirement still accepts the Node on PATH", async () => {
    const m = machine();
    const tc = await resolveToolchain("24", {}, m.env);
    expect(tc.node).toMatchObject({ requested: "24", source: "path", version: "v24.1.0", binDir: null });
  });

  it("an exact version nobody has installed is unresolved, with the version children would run", async () => {
    const m = machine();
    const tc = await resolveToolchain("24.30.0", {}, m.env);
    expect(tc.node).toMatchObject({ source: "unresolved", version: "v24.1.0" });
    expect(describeNode(tc.node)).toBe("wants 24.30.0 (toolchain.node): children would run v24.1.0, and nvm has no Node matching 24.30.0");
  });

  it("probes in the directory checks run in (asdf/mise pick the version by directory)", async () => {
    const m = machine({ byDir: { marker: ".tool-versions", version: "v24.21.0" } });
    const worktrees = join(m.root, "worktrees", "acme", "widget");
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(worktrees, ".tool-versions"), "nodejs 24.21.0\n");
    const toolchain = { node: "24", env: {} };
    const file = { file: ".nvmrc", content: "24.21.0" };

    // From the worktrees directory (a run's worktree does not exist yet: nearest existing ancestor),
    // the shim on PATH already gives 24.21.0.
    const inTree = await resolveRunToolchain({ toolchain, versionFile: file, cwd: join(worktrees, "run-1"), dirs: m.dirs, baseEnv: m.env });
    expect(inTree.node).toMatchObject({ requested: "24.21.0", source: "path", version: "v24.21.0" });

    // From elsewhere the same shim gives 24.1.0, so nvm's 24.21.0 is used instead.
    const elsewhere = await resolveRunToolchain({ toolchain, versionFile: file, cwd: m.root, dirs: m.dirs, baseEnv: m.env });
    expect(elsewhere.node).toMatchObject({ requested: "24.21.0", source: "nvm", version: "v24.21.0" });
  });

  it("reports what children really run: a toolchain.env PATH that hides nvm's Node is unresolved, not 'nvm'", async () => {
    const m = machine();
    const tc = await resolveRunToolchain({ toolchain: { node: "24.21.0", env: { PATH: m.env.PATH } }, versionFile: null, cwd: m.root, dirs: m.dirs, baseEnv: m.env });
    expect(tc.node).toMatchObject({ source: "unresolved", version: "v24.1.0" });
  });

  it("the environment children get is the scrubbed one, with the resolved Node first on PATH", async () => {
    const m = machine();
    const tc = await resolveRunToolchain({ toolchain: { node: "24", env: {} }, versionFile: { file: ".nvmrc", content: "24.21.0" }, cwd: m.root, dirs: m.dirs, baseEnv: { ...m.env, GITHUB_TOKEN: "ghp_x", LINEAR_API_KEY: "lin_x" } });
    expect(tc.env.PATH!.split(":")[0]).toBe(join(m.nvm, "versions", "node", "v24.21.0", "bin"));
    expect(tc.env.GITHUB_TOKEN).toBeUndefined();
    expect(tc.env.LINEAR_API_KEY).toBeUndefined();
    expect(tc.env.GIT_CONFIG_GLOBAL).toBe(m.dirs.emptyGitConfig);
  });

  it("a conflict between config and version file is unresolved", async () => {
    const m = machine();
    const tc = await resolveRunToolchain({ toolchain: { node: "22", env: {} }, versionFile: { file: ".nvmrc", content: "24.21.0" }, cwd: m.root, dirs: m.dirs, baseEnv: m.env });
    expect(tc.node.source).toBe("unresolved");
    expect(describeNode(tc.node)).toMatch(/conflicts with the repository's \.nvmrc/);
  });
});

describe("baseline acceptance", () => {
  const checks = [
    { name: "lint", run: "pnpm lint", timeout_minutes: 15, optional: false },
    { name: "smoke", run: "pnpm smoke", timeout_minutes: 15, optional: true },
  ];
  const r = (name: string, ok: boolean, optional = false) => ({ name, command: name, ok, optional, exitCode: ok ? 0 : 1, durationMs: 1, timedOut: false, logPath: null });

  it("only a baseline whose required checks all passed counts as done", () => {
    expect(baselineAccepted([r("lint", true), r("smoke", false, true)], checks)).toBe(true);
    expect(baselineAccepted([r("lint", false), r("smoke", true, true)], checks)).toBe(false);
    expect(baselineAccepted(null, checks)).toBe(false);
    expect(baselineAccepted(undefined, checks)).toBe(false);
  });

  it("a baseline missing a required check (e.g. added to the config since) is not done", () => {
    expect(baselineAccepted([r("smoke", true, true)], checks)).toBe(false);
  });
});
