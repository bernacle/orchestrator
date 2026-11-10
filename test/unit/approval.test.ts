import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { macosApprover, ttyApprover, type ApprovalRequest, type Exec } from "../../src/core/approval.js";
import { ephemeralReasons, readShimTarget, renderShim, shimPath, writeShim } from "../../src/skills/launcher.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-approval-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const req: ApprovalRequest = { purpose: "live_run", reason: "start a live Orchestrator run of ACM-1 on acme/widget", details: ["Issue: ACM-1"], issue: "ACM-1", repo: "acme/widget", scopeHash: "abc" };
const quiet = () => {};

describe("macOS approval channel (LocalAuthentication)", () => {
  const fake = (stdout: string, exitCode = 0): Exec & { calls: Array<{ cmd: string; args: string[] }> } => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const f: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode, stdout, stderr: exitCode ? "boom" : "" };
    };
    return Object.assign(f, { calls });
  };

  it("approves only when the system reports a successful authentication", async () => {
    const exec = fake('{"ok":true}');
    const r = await macosApprover({ exec, log: quiet }).request(req);
    expect(r).toMatchObject({ approved: true, channel: "macos-local-authentication" });
    // The system binary by absolute path (a PATH entry cannot impersonate it), with the scope as the reason.
    expect(exec.calls[0]!.cmd).toBe("/usr/bin/osascript");
    expect(exec.calls[0]!.args).toContain(req.reason);
    expect(exec.calls[0]!.args.join(" ")).toContain("evaluatePolicyLocalizedReasonReply");
  });

  it.each([
    ['{"ok":false,"code":-2,"msg":"Canceled by user."}', /refused or cancelled \(Canceled by user\.\)/],
    ['{"ok":false,"code":-9,"msg":"timed out"}', /no answer within/],
    ['{"ok":false,"unavailable":true,"msg":"No UI"}', /not available here \(No UI\)/],
    ["garbage", /refused or cancelled/],
  ])("refuses on %s", async (stdout, detail) => {
    const r = await macosApprover({ exec: fake(stdout), log: quiet }).request(req);
    expect(r.approved).toBe(false);
    expect(r.detail).toMatch(detail);
  });

  it("refuses when the prompt cannot be shown (no fallback on macOS)", async () => {
    const r = await macosApprover({ exec: fake("", 1), log: quiet }).request(req);
    expect(r).toMatchObject({ approved: false, detail: expect.stringMatching(/not available here/) });
  });

  it("prints the scope before prompting", async () => {
    const lines: string[] = [];
    await macosApprover({ exec: fake('{"ok":false}'), log: (l) => lines.push(l) }).request(req);
    expect(lines.join("\n")).toMatch(/Approval needed to start a live Orchestrator run of ACM-1[\s\S]*Issue: ACM-1[\s\S]*Touch ID or your password/);
  });
});

describe("terminal approval channel (non-macOS)", () => {
  const ttyWith = (answer: string) => () => ({ write: () => {}, readLine: () => answer, close: () => {} });

  it("approves only when the issue key is typed", async () => {
    expect((await ttyApprover({ openTty: ttyWith("ACM-1\n") }).request(req)).approved).toBe(true);
    expect((await ttyApprover({ openTty: ttyWith("y\n") }).request(req)).approved).toBe(false);
  });

  it("refuses without a controlling terminal", async () => {
    const r = await ttyApprover({ openTty: () => { throw new Error("ENXIO"); } }).request(req);
    expect(r).toMatchObject({ approved: false, detail: expect.stringMatching(/no controlling terminal/) });
  });
});

describe("stable launcher", () => {
  function fakeInstall(name: string): string {
    const root = join(scratch, name);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "orchestrator.js"), "console.log('orchestrator ran with', process.version, JSON.stringify(process.argv.slice(2)));\n");
    return root;
  }

  it("runs the installation with a Node >= 22.5, skipping incompatible ones first on PATH", () => {
    const root = fakeInstall("pkg");
    const old = join(scratch, "old-node");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "node"), "#!/bin/sh\nexit 1\n"); // stands in for Node 16: fails the version check
    chmodSync(join(old, "node"), 0o755);
    const home = join(scratch, "home1");
    const { path } = writeShim(home, { packageRoot: root, node: join(scratch, "gone", "node") });
    const r = spawnSync(path, ["context", "BRU-488"], { encoding: "utf8", env: { PATH: `${old}:/usr/bin:/bin`, HOME: home, ORCHESTRATOR_NODE: process.execPath } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/orchestrator ran with v\d+.*\["context","BRU-488"\]/);
  });

  it("explains how to repoint it when the installation is gone", () => {
    const home = join(scratch, "home2");
    const { path } = writeShim(home, { packageRoot: join(scratch, "deleted-worktree"), node: process.execPath });
    const r = spawnSync(path, ["status"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/installation this launcher points at is gone[\s\S]*orchestrator skill install --all/);
  });

  it("is idempotent, repointable, records its target, and never replaces a foreign file", () => {
    const home = join(scratch, "home3");
    const a = fakeInstall("a"), b = fakeInstall("b with space");
    expect(writeShim(home, { packageRoot: a, node: "/n" }).changed).toBe(true);
    expect(writeShim(home, { packageRoot: a, node: "/n" }).changed).toBe(false);
    expect(writeShim(home, { packageRoot: b, node: "/n" })).toMatchObject({ changed: true, previous: a });
    expect(readShimTarget(shimPath(home))).toEqual({ packageRoot: b, node: "/n" });
    const other = join(scratch, "home4");
    mkdirSync(join(other, "bin"), { recursive: true });
    writeFileSync(shimPath(other), "#!/bin/sh\necho mine\n");
    expect(() => writeShim(other, { packageRoot: a, node: "/n" })).toThrow(/not an Orchestrator launcher/);
    expect(readFileSync(shimPath(other), "utf8")).toContain("echo mine");
    expect(renderShim({ packageRoot: "/x/it's", node: "/n" })).toContain("ORCH_ROOT='/x/it'\\''s'");
  });

  it("flags temporary and worktree installs as ephemeral, and a plain checkout as stable", () => {
    const stable = join(scratch, "checkout");
    mkdirSync(join(stable, ".git"), { recursive: true });
    const worktree = join(scratch, "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
    expect(ephemeralReasons(worktree, { HOME: "/nonexistent" })).toEqual(expect.arrayContaining([expect.stringMatching(/linked git worktree/), expect.stringMatching(/temporary directory/)]));
    expect(ephemeralReasons(stable, { HOME: "/nonexistent" }).some((r) => /worktree/.test(r))).toBe(false);
    const home = join(scratch, "fakehome");
    mkdirSync(join(home, ".t3", "worktrees", "orchestrator", "t3-1"), { recursive: true });
    expect(ephemeralReasons(join(home, ".t3", "worktrees", "orchestrator", "t3-1"), { HOME: home })).toEqual(expect.arrayContaining([expect.stringMatching(/T3's worktree area/)]));
  });
});
