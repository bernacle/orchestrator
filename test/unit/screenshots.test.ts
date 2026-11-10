import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScreenshotsSchema } from "../../src/config/schema.js";
import { globRoot, matchGlob } from "../../src/core/glob.js";
import { collectScreenshots, outputStamps, pngProblem, screenshotCheck, screenshotsRequired } from "../../src/core/screenshots.js";
import { makePng } from "../helpers.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "orch-shots-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PNG = makePng();
const cfg = (over: Record<string, unknown> = {}) => ScreenshotsSchema.parse({ run: "pnpm test:smoke", outputs: ["docs/**/screenshots/*.png"], ...over });
let n = 0;
const worktree = () => {
  const wt = join(scratch, `wt${n++}`);
  mkdirSync(join(wt, "docs", "design", "theming", "screenshots"), { recursive: true });
  return wt;
};
const shot = (wt: string, name: string, body: Buffer | string = PNG) => writeFileSync(join(wt, "docs", "design", "theming", "screenshots", name), body);

describe("screenshot requirement", () => {
  it("is required only when the change touches when_changed (or always when it is empty)", () => {
    const ui = cfg({ when_changed: ["apps/**", "packages/react/**"] });
    expect(screenshotsRequired(ui, [{ status: "M", path: "packages/react/src/chart.tsx" }])).toBe(true);
    expect(screenshotsRequired(ui, [{ status: "M", path: "packages/core/src/x.ts" }])).toBe(false);
    expect(screenshotsRequired(ui, [{ status: "D", path: "apps/demo/page.tsx" }])).toBe(false);
    expect(screenshotsRequired(cfg(), [{ status: "M", path: "README.md" }])).toBe(true);
    expect(screenshotsRequired(undefined, [{ status: "M", path: "apps/x" }])).toBe(false);
  });

  it("runs as a check with no outbound network, whatever the defaults", () => {
    expect(screenshotCheck(cfg())).toMatchObject({ name: "screenshots", run: "pnpm test:smoke", network: "none", optional: false });
  });

  it("globs: ** crosses directories, the walk starts at the literal prefix", () => {
    expect(matchGlob("docs/design/theming/screenshots/a.png", "docs/**/screenshots/*.png")).toBe(true);
    expect(matchGlob("docs/screenshots/a.webp", "docs/**/screenshots/*.png")).toBe(false);
    expect(globRoot("docs/design/**/screenshots/*.png")).toBe("docs/design");
    expect(globRoot("*.png")).toBe("");
  });
});

describe("collecting screenshots", () => {
  it("takes only the images the command wrote or rewrote, never files that were there untouched", () => {
    const wt = worktree();
    shot(wt, "stale.png"); // e.g. placed by hand just before, or left from an earlier round
    shot(wt, "rerendered.png");
    const before = outputStamps(wt, cfg());
    // The command runs: one new file, and one rewritten with identical bytes (new mtime).
    shot(wt, "desktop.png");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(wt, "docs", "design", "theming", "screenshots", "rerendered.png"), later, later);
    const r = collectScreenshots(wt, cfg(), before);
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(["docs/design/theming/screenshots/desktop.png", "docs/design/theming/screenshots/rerendered.png"]);
    expect(r.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses files that are not images, too large, symbolic links, or too many", () => {
    const wt = worktree();
    shot(wt, "fake.png", "not an image");
    shot(wt, "huge.png", makePng({ idat: Buffer.alloc(2 * 1024 * 1024) }));
    symlinkSync("/etc/hosts", join(wt, "docs", "design", "theming", "screenshots", "link.png"));
    const r = collectScreenshots(wt, cfg({ max_file_mb: 1 }), {});
    expect(r.files).toEqual([]);
    expect(r.problems.join("\n")).toMatch(/fake\.png is not a PNG/);
    expect(r.problems.join("\n")).toMatch(/huge\.png is 2\.0 MB \(limit 1 MB\)/);
    expect(r.problems.join("\n")).toMatch(/link\.png is a symbolic link/);

    const many = worktree();
    for (let i = 0; i < 3; i++) shot(many, `s${i}.png`);
    expect(collectScreenshots(many, cfg({ max_files: 2 }), {}).problems).toEqual(["3 screenshots (limit 2)"]);
  });

  it("refuses names that could be read as pathspec magic or break Markdown", () => {
    const wt = worktree();
    shot(wt, "ok-1.png");
    shot(wt, "x](javascript:alert(1)).png");
    shot(wt, ":(glob)a.png");
    shot(wt, ".hidden.png");
    const r = collectScreenshots(wt, cfg(), {});
    expect(r.files.map((f) => f.path)).toEqual(["docs/design/theming/screenshots/ok-1.png"]);
    expect(r.problems).toHaveLength(3);
    expect(r.problems.every((p) => p.includes("has characters outside [A-Za-z0-9._-]"))).toBe(true);
  });

  it("does not follow a symlinked directory out of the worktree", () => {
    const wt = join(scratch, `wt${n++}`);
    const outside = join(scratch, `outside${n++}`, "screenshots");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "a.png"), PNG);
    mkdirSync(wt, { recursive: true });
    symlinkSync(join(outside, ".."), join(wt, "docs"));
    const r = collectScreenshots(wt, cfg(), {});
    expect(r.files).toEqual([]);
    expect(r.problems).toEqual(["docs resolves outside the worktree"]);
  });
});

describe("PNG validation", () => {
  it("accepts a plain screenshot (IHDR, IDAT, IEND) and refuses anything that can carry extra bytes", () => {
    expect(pngProblem(makePng())).toBeNull();
    expect(pngProblem(makePng({ extra: [{ type: "pHYs", data: Buffer.alloc(9) }] }))).toBeNull();
    expect(pngProblem(makePng({ extra: [{ type: "tEXt", data: Buffer.from("Comment\0hi") }] }))).toMatch(/"tEXt" chunk/);
    expect(pngProblem(makePng({ extra: [{ type: "iCCP", data: Buffer.from("x\0\0") }] }))).toMatch(/"iCCP" chunk/);
    expect(pngProblem(makePng({ extra: [{ type: "prVt", data: Buffer.from("secret") }] }))).toMatch(/"prVt" chunk/);
    expect(pngProblem(makePng({ trailing: Buffer.from("appended payload") }))).toBe("has data after the end of the PNG");
    expect(pngProblem(makePng({ badCrc: true }))).toBe("is a corrupt PNG (bad chunk checksum)");
    expect(pngProblem(makePng().subarray(0, 30))).toBe("is a truncated PNG");
    expect(pngProblem(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("is not a PNG image"); // JPEG
  });
});

describe("committing validated bytes", () => {
  it("commits exactly the buffer it was given, whatever is on disk, and only those paths", async () => {
    const { GitWorkspace } = await import("../../src/adapters/git.js");
    const { execFileSync } = await import("node:child_process");
    const repo = join(scratch, `repo${n++}`);
    mkdirSync(repo, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "x\n");
    g("add", ".");
    g("commit", "-q", "-m", "init");
    const ws = new GitWorkspace({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    mkdirSync(join(repo, "shots"));
    writeFileSync(join(repo, "shots", "a.png"), "swapped on disk after validation");
    writeFileSync(join(repo, "unrelated.txt"), "not part of the commit");
    const sha = await ws.commitBlobs(repo, [{ path: "shots/a.png", data: PNG }], "shots");
    expect(sha).toBe(g("rev-parse", "HEAD"));
    expect(Buffer.from(execFileSync("git", ["show", "HEAD:shots/a.png"], { cwd: repo }))).toEqual(PNG);
    expect(g("show", "--name-only", "--format=", "HEAD")).toBe("shots/a.png");
    // A path the repository routes through a filter (Git LFS) is refused, not committed raw.
    writeFileSync(join(repo, ".gitattributes"), "lfs/*.png filter=lfs diff=lfs merge=lfs -text\n");
    await expect(ws.commitBlobs(repo, [{ path: "lfs/b.png", data: PNG }], "lfs")).rejects.toThrow(/use a git filter \(e\.g\. Git LFS\).*lfs\/b\.png/);
    rmSync(join(repo, ".gitattributes"));
    // The same bytes again: nothing to commit.
    expect(await ws.commitBlobs(repo, [{ path: "shots/a.png", data: PNG }], "again")).toBeNull();
    // Leftovers are discarded: the tampered file goes back to the committed bytes, untracked output is removed.
    await ws.discardPaths(repo, await ws.uncommittedPaths(repo));
    expect(readFileSync(join(repo, "shots", "a.png"))).toEqual(PNG);
    expect(existsSync(join(repo, "unrelated.txt"))).toBe(false);
  });
});
