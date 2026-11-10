import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScreenshotsSchema } from "../../src/config/schema.js";
import { globRoot, matchGlob } from "../../src/core/glob.js";
import { collectScreenshots, screenshotCheck, screenshotsRequired } from "../../src/core/screenshots.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "orch-shots-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
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
  it("takes the images the command wrote and ignores older files matching the same glob", () => {
    const wt = worktree();
    shot(wt, "stale.png");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(wt, "docs", "design", "theming", "screenshots", "stale.png"), old, old);
    const since = Date.now() - 1_000;
    shot(wt, "desktop.png");
    shot(wt, "mobile.png");
    const r = collectScreenshots(wt, cfg(), since);
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(["docs/design/theming/screenshots/desktop.png", "docs/design/theming/screenshots/mobile.png"]);
    expect(r.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses files that are not images, too large, symbolic links, or too many", () => {
    const wt = worktree();
    shot(wt, "fake.png", "not an image");
    shot(wt, "huge.png", Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    symlinkSync("/etc/hosts", join(wt, "docs", "design", "theming", "screenshots", "link.png"));
    const r = collectScreenshots(wt, cfg({ max_file_mb: 1 }), 0);
    expect(r.files).toEqual([]);
    expect(r.problems.join("\n")).toMatch(/fake\.png is not a PNG/);
    expect(r.problems.join("\n")).toMatch(/huge\.png is 2\.0 MB \(limit 1 MB\)/);
    expect(r.problems.join("\n")).toMatch(/link\.png is a symbolic link/);

    const many = worktree();
    for (let i = 0; i < 3; i++) shot(many, `s${i}.png`);
    expect(collectScreenshots(many, cfg({ max_files: 2 }), 0).problems).toEqual(["3 screenshots (limit 2)"]);
  });

  it("does not follow a symlinked directory out of the worktree", () => {
    const wt = join(scratch, `wt${n++}`);
    const outside = join(scratch, `outside${n++}`, "screenshots");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "a.png"), PNG);
    mkdirSync(wt, { recursive: true });
    symlinkSync(join(outside, ".."), join(wt, "docs"));
    const r = collectScreenshots(wt, cfg(), 0);
    expect(r.files).toEqual([]);
    expect(r.problems).toEqual(["docs resolves outside the worktree"]);
  });
});
