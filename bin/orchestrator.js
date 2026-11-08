#!/usr/bin/env node
// Thin launcher: prefer the compiled build, fall back to tsx for source checkouts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`orchestrator needs Node.js >= 22.5 (for node:sqlite); this is ${process.version}. Try: nvm use 24`);
  process.exit(1);
}

// Node 22.5–22.12 and 23.0–23.3 ship node:sqlite behind a flag: re-exec with it.
let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}
if (!hasSqlite) {
  if (process.execArgv.includes("--experimental-sqlite")) {
    console.error(`node:sqlite is unavailable in ${process.version} even with --experimental-sqlite. Use Node 24 (nvm use 24).`);
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  // The child receives Ctrl-C from the terminal and handles interruption itself.
  process.on("SIGINT", () => {});
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
} else {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const built = join(root, "dist", "cli", "main.js");
  if (existsSync(built)) {
    await import(pathToFileURL(built).href);
  } else {
    const { register } = await import("tsx/esm/api");
    register();
    await import(pathToFileURL(join(root, "src", "cli", "main.ts")).href);
  }
}
