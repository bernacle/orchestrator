import { describe, expect, it } from "vitest";
import { Redactor, REDACTED } from "../../src/core/redact.js";
import { canTransition } from "../../src/core/states.js";
import { LeaseError, Store, TransitionError } from "../../src/core/store.js";

const store = () => new Store(":memory:", new Redactor({ GITHUB_TOKEN: "ghp_supersecretvalue1234567890abcd" }));

describe("state machine", () => {
  it("allows the happy path and recovery edges only", () => {
    expect(canTransition("QUEUED", "PLANNING")).toBe(true);
    expect(canTransition("QUEUED", "PR_OPEN")).toBe(false);
    expect(canTransition("REVIEWING", "FIXING")).toBe(true);
    expect(canTransition("FIXING", "PR_OPEN")).toBe(false); // must be re-tested and re-reviewed
    expect(canTransition("IMPLEMENTING", "BLOCKED")).toBe(true);
    expect(canTransition("BLOCKED", "REVIEWING")).toBe(true);
    expect(canTransition("COMPLETED", "PLANNING")).toBe(false);
    expect(canTransition("CANCELLED", "BLOCKED")).toBe(false);
  });
});

describe("Store", () => {
  it("rejects illegal transitions and concurrent writers", () => {
    const s = store();
    const run = s.createRun({ id: "r1", issueKey: "X-1", repo: "o/r", mode: "supervised", context: {} });
    expect(() => s.transition("r1", run.version, { to: "MERGED" })).toThrow(TransitionError);
    s.transition("r1", run.version, { to: "PLANNING" });
    expect(() => s.transition("r1", run.version, { to: "IMPLEMENTING" })).toThrow(/changed concurrently/);
  });

  it("records BLOCKED origin for resume", () => {
    const s = store();
    const run = s.createRun({ id: "r1", issueKey: "X-1", repo: "o/r", mode: "supervised", context: {} });
    const p = s.transition("r1", run.version, { to: "PLANNING" });
    const b = s.transition("r1", p.version, { to: "BLOCKED", reason: "dep" });
    expect(b.blockedFrom).toBe("PLANNING");
  });

  it("enforces a single driver per run", () => {
    const s = store();
    s.createRun({ id: "r1", issueKey: "X-1", repo: "o/r", mode: "supervised", context: {} });
    const me = `${require("node:os").hostname()}:${process.pid}:a`;
    s.acquireLease("r1", me, 60_000);
    expect(() => s.acquireLease("r1", `${require("node:os").hostname()}:${process.pid}:b`, 60_000)).toThrow(LeaseError);
    s.releaseLease("r1", me);
    expect(s.leaseHolder("r1")).toBeNull();
  });

  it("frees leases held by dead processes", () => {
    const s = store();
    s.createRun({ id: "r1", issueKey: "X-1", repo: "o/r", mode: "supervised", context: {} });
    s.acquireLease("r1", `${require("node:os").hostname()}:999999:x`, 60_000);
    expect(s.leaseHolder("r1")).toBeNull();
    expect(() => s.acquireLease("r1", `${require("node:os").hostname()}:${process.pid}:y`, 60_000)).not.toThrow();
  });

  it("redacts secrets in events and effects", () => {
    const s = store();
    s.createRun({ id: "r1", issueKey: "X-1", repo: "o/r", mode: "supervised", context: {} });
    s.appendEvent("r1", "QUEUED", "info", "t", "token ghp_supersecretvalue1234567890abcd leaked", { auth: "Bearer abcdefghijklmnopqrstuvwxyz" });
    const ev = s.events("r1").at(-1)!;
    expect(ev.message).toBe(`token ${REDACTED} leaked`);
    expect(JSON.stringify(ev.data)).not.toContain("abcdefghijklmnop");
    s.putEffect({ runId: "r1", key: "k", permission: "github.push", status: "failed", description: "push", result: null, error: "lin_api_aaaaaaaaaaaaaaaaaaaaaaaa rejected" });
    expect(s.getEffect("r1", "k")!.error).toBe(`${REDACTED} rejected`);
  });
});

describe("Redactor", () => {
  it("redacts env secrets and known token shapes but keeps ordinary text", () => {
    const r = new Redactor({ MY_API_KEY: "s3cr3t-value-123", HOME: "/Users/me" });
    expect(r.redact("key=s3cr3t-value-123 home=/Users/me")).toBe(`key=${REDACTED} home=/Users/me`);
    expect(r.redact("sk-ant-abcdefghijklmnopqrstuvwxyz")).toBe(REDACTED);
    expect(r.redactValue({ LINEAR_API_KEY: "whatever-it-is", issueKey: "BRU-1" })).toEqual({ LINEAR_API_KEY: REDACTED, issueKey: "BRU-1" });
  });
});
