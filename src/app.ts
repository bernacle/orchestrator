import { defaultNotifier, type Notifier } from "./core/notify.js";
import { reconcileRuns, settleRun, watchRun, type WatchOptions } from "./core/settle.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRealAdapters } from "./adapters/index.js";
import { SnapshotTracker } from "./adapters/snapshot.js";
import { detectT3Origin } from "./adapters/t3.js";
import { LinearTracker } from "./adapters/linear.js";
import type { Adapters, IssueTracker } from "./adapters/types.js";
import { ConfigError, loadRepoConfig, loadRepoConfigFile, resolvePaths, type LoadedRepoConfig, type Paths } from "./config/load.js";
import { resolveLinearKey, type ResolvedLinearKey } from "./credentials/linear.js";
import { inspectRequest, type Problem } from "./intake/context.js";
import { defaultDiscoveryDeps, type DiscoveryDeps } from "./intake/repo-discovery.js";
import { Engine, type ApprovedResume, type EngineOptions } from "./core/engine.js";
import { ALWAYS_DENIED_ENV, credentialPaths, isolationDirs, isolationReadPaths, toolchainCaches } from "./core/isolation.js";
import { Redactor } from "./core/redact.js";
import { TERMINAL_STATES } from "./core/states.js";
import { Store, type RunRecord } from "./core/store.js";
import { HANDLERS, type RunContext } from "./core/workflow.js";
import { parseIssueRef } from "./intake/issue-ref.js";
import { approvalChannelStatus, auditApproval, describeScope, runScope, systemApprover, type ApprovalPurpose, type ApprovalResult, type Approver } from "./core/approval.js";
import { saveAssociation, type SavedAssociation } from "./intake/association.js";
import { prepareAuthorization, writeAuthorization } from "./intake/proposal.js";
import { describeTrust, describeTrustState, systemTrustKeys, TRUST_CHANNEL, trustEligibility, trustScope, TrustStore, type TrustKeyStore, type TrustRecord, type TrustState } from "./core/trust.js";

export interface App {
  paths: Paths;
  store: Store;
  redactor: Redactor;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; real adapters otherwise. `linearWorkspace` picks the stored Linear key. */
  adaptersFor(loaded: LoadedRepoConfig, hints?: { linearWorkspace?: string | null }): Adapters;
  /** Issue tracker for reading an issue before a run exists (context, association checks). */
  trackerFor(workspace: string | null): { tracker: IssueTracker; credential: ResolvedLinearKey };
  /** Git/SSH access for repository discovery (injected in tests). */
  discovery: DiscoveryDeps;
  /**
   * Asks a person to approve live runs, repository authorization and associations (core/approval.ts).
   * Only code can replace it (tests); there is no flag or environment variable that does.
   */
  approver: Approver;
  /** Whether the approval prompt can be shown in this session (no UI). Absent in tests. */
  approvalStatus?: () => Promise<{ channel: string; available: boolean; detail: string }>;
  /**
   * Trusted repositories (core/trust.ts). Its seal keys live in the Keychain (a 0600 file off
   * macOS); only code can substitute another key store (tests).
   */
  trust: TrustStore;
  /** Local notifications when a run needs a person or is done (core/notify.ts). Silent in tests. */
  notifier: Notifier;
  close(): void;
}

export function openApp(
  opts: {
    env?: NodeJS.ProcessEnv;
    adapters?: (loaded: LoadedRepoConfig) => Adapters;
    tracker?: (workspace: string | null) => IssueTracker;
    discovery?: DiscoveryDeps;
    approver?: Approver;
    trustKeys?: TrustKeyStore;
    notifier?: Notifier;
    now?: () => Date;
  } = {},
): App {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const redactor = new Redactor(env);
  const store = new Store(paths.db, redactor, opts.now);
  const linearKey = (workspace: string | null | undefined) => {
    const credential = resolveLinearKey({ env, paths, workspace: workspace ?? null });
    redactor.add(credential.key);
    return credential;
  };
  return {
    paths,
    store,
    redactor,
    env,
    adaptersFor:
      opts.adapters ??
      ((loaded, hints) => {
        // The keyring token is not in the environment: register its value so redaction and the
        // pre-push secret scan recognise it.
        redactor.add(ghTokenFromKeyring(env));
        const credential = linearKey(hints?.linearWorkspace ?? loaded.config.linear.workspace);
        return createRealAdapters(redactor, env, { denyRead: credentialPaths(env, paths.home), deniedEnv: ALWAYS_DENIED_ENV, allowWrite: toolchainCaches(env), allowRead: isolationReadPaths(isolationDirs(paths.home)) }, credential);
      }),
    trackerFor: (workspace) => {
      if (opts.tracker) return { tracker: opts.tracker(workspace), credential: { key: undefined, source: "test tracker", workspace, problem: null } };
      if (opts.adapters) throw new Error("openApp: tests that inspect requests must inject `tracker`");
      const credential = linearKey(workspace);
      return { tracker: new LinearTracker(credential.key, undefined, credential.problem ?? undefined), credential };
    },
    discovery: opts.discovery ?? defaultDiscoveryDeps(env),
    approver: opts.approver ?? systemApprover(),
    ...(opts.approver ? {} : { approvalStatus: () => approvalChannelStatus() }),
    trust: new TrustStore(paths, opts.trustKeys ?? systemTrustKeys(paths)),
    notifier: opts.notifier ?? defaultNotifier(env, Boolean(opts.adapters)),
    close: () => store.close(),
  };
}

function ghTokenFromKeyring(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class RunError extends Error {
  override name = "RunError";
}

/** A request the engine refuses to start, with a machine-readable code (see intake/context.ts). */
export class IntakeError extends RunError {
  override name = "IntakeError";
  constructor(
    readonly code: Problem["code"] | "execution_disabled" | "no_run" | "approval_required" | "not_permitted" | "not_trustable",
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function newRunId(issueKey: string): string {
  return `${issueKey.toLowerCase()}-${randomBytes(3).toString("hex")}`;
}

export interface StartOptions extends Pick<EngineOptions, "onEvent" | "interrupt"> {
  /** Issue key or Linear issue URL. */
  issueKey: string;
  repo?: string;
  /** Working directory used to discover the repository when neither repo nor configFile is given. */
  cwd?: string;
  linearWorkspace?: string;
  configFile?: string;
  dryRun: boolean;
  withAgentPlan?: boolean;
  ciWaitMinutes?: number;
  acceptDependencies?: string[];
  /** Replay Linear data from a recorded issue.json (dry runs only). */
  issueSnapshot?: string;
  /** Ask a person for this live run even when the repository is trusted. */
  requireApproval?: boolean;
}

function engineFor(app: App, loaded: LoadedRepoConfig, snapshot?: SnapshotTracker, linearWorkspace?: string | null): Engine<RunContext> {
  const adapters = app.adaptersFor(loaded, { linearWorkspace: linearWorkspace ?? null });
  return new Engine<RunContext>({
    store: app.store,
    adapters: snapshot ? { ...adapters, tracker: snapshot } : adapters,
    config: loaded.config,
    configSource: loaded.source,
    paths: app.paths,
    redactor: app.redactor,
    handlers: HANDLERS,
  });
}

export async function startRun(app: App, opts: StartOptions): Promise<RunRecord<RunContext>> {
  let ref;
  try {
    ref = parseIssueRef(opts.issueKey);
  } catch (err) {
    throw new RunError((err as Error).message);
  }
  const issueKey = ref.key;
  if (opts.issueSnapshot && !opts.dryRun) throw new RunError("--issue-snapshot is for dry runs only; a live run always reads Linear");
  const snapshot = opts.issueSnapshot ? new SnapshotTracker(opts.issueSnapshot) : undefined;
  if (snapshot && snapshot.issue.key !== issueKey) throw new RunError(`snapshot ${opts.issueSnapshot} is for ${snapshot.issue.key}, not ${issueKey}`);
  if (!opts.dryRun && app.env.ORCHESTRATOR_NO_EXECUTE) throw new IntakeError("execution_disabled", "live runs are disabled in this environment (ORCHESTRATOR_NO_EXECUTE is set); run without --execute for a dry run");

  // Same gate as `orchestrator context`: repository, authorization, workspace, association, duplicates.
  const explicit = Boolean(opts.repo || opts.configFile);
  const inspected = await inspectRequest(app, {
    issueRef: opts.issueKey,
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(snapshot ? { snapshotIssue: snapshot.issue } : {}),
    ...(opts.linearWorkspace ? { linearWorkspace: opts.linearWorkspace } : {}),
    // An explicit selection needs no association evidence; planning reads Linear itself.
    fetchIssue: !explicit,
  });
  const fatal = inspected.problems.filter((p) => {
    if (p.code === "linear_auth" || p.code === "linear_issue") return !explicit; // planning reports these for explicit runs
    // A dry run has no side effects, so it may run beside an active live run (reported as a warning).
    if (p.code === "active_run_exists") return !opts.dryRun;
    return true;
  });
  if (fatal.length > 0) {
    const first = fatal[0]!;
    const message =
      first.code === "active_run_exists"
        ? `${issueKey} already has an active run (${inspected.runs.active.map((r) => `${r.id} ${r.state}`).join(", ")}); use resume or cancel it first`
        : first.message;
    throw new IntakeError(first.code, fatal.length > 1 ? `${message}\n${fatal.slice(1).map((p) => `also: ${p.message}`).join("\n")}` : message, { problems: fatal, nextActions: inspected.nextActions });
  }
  const loaded = inspected.loaded!;
  if (opts.dryRun && inspected.runs.active.length) inspected.warnings.push(`active live run(s) for ${issueKey}: ${inspected.runs.active.map((r) => `${r.id} ${r.state}`).join(", ")}; this dry run does not affect them`);
  for (const w of inspected.warnings) opts.onEvent?.({ level: "warn", state: "QUEUED", type: "intake.warning", message: w });
  const linearWorkspace = opts.linearWorkspace?.toLowerCase() ?? ref.workspace;

  // ---- live runs: repository permission, then a person's approval of this exact scope.
  let authorization: RunContext["authorization"] = null;
  if (!opts.dryRun) {
    if (!loaded.config.permissions.agents.run) {
      throw new IntakeError("not_permitted", `${loaded.config.repo}'s configuration (${loaded.source}) does not grant live runs (permissions.agents.run is false); only dry runs are possible`);
    }
    const { scope, hash } = runScope({ issue: issueKey, config: loaded.config, configSource: loaded.source, acceptedDependencies: opts.acceptDependencies ?? [] });
    const title = inspected.issue.title ?? (await app.trackerFor(linearWorkspace ?? loaded.config.linear.workspace ?? null).tracker.getIssue(issueKey).then((i) => i.title).catch(() => null));
    const last = app.store.runsFor(issueKey, loaded.config.repo, 10).find((r) => r.mode === "dry_run") as RunRecord<RunContext> | undefined;
    const lastDryRun = last ? `${last.id} ${last.state}${last.context.plan ? `, ${last.context.plan.blockers.length} blocker(s)` : ""}, ${last.createdAt.slice(0, 16).replace("T", " ")}` : null;
    const d = describeScope(scope, { title, lastDryRun });
    authorization = (
      await authorizeLive(app, {
        purpose: "live_run",
        loaded,
        issue: issueKey,
        scopeHash: hash,
        reason: d.reason,
        acceptedDependencies: scope.acceptedDependencies,
        requireApproval: Boolean(opts.requireApproval),
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        ask: (trustLine) => requireApproval(app, "live_run", { issue: issueKey, repo: loaded.config.repo, scopeHash: hash, reason: d.reason, details: [...d.details, trustLine] }),
      })
    ).authorization;
  }

  const run = app.store.createRun<RunContext>({
    id: newRunId(issueKey),
    issueKey,
    repo: loaded.config.repo,
    mode: opts.dryRun ? "dry_run" : "supervised",
    context: {
      options: {
        withAgentPlan: Boolean(opts.withAgentPlan),
        ciWaitMinutes: opts.ciWaitMinutes ?? 30,
        origin: detectT3Origin(app.env),
        acceptedDependencies: (opts.acceptDependencies ?? []).map((k) => k.toUpperCase()),
        ...(snapshot ? { issueSnapshot: { file: snapshot.file, takenAt: snapshot.takenAt } } : {}),
        intake: {
          source: inspected.selection.source!,
          reason: inspected.selection.reason,
          association: inspected.association ? { verified: inspected.association.verified, evidence: inspected.association.evidence } : null,
          cwd: inspected.request.cwd,
          linkedWorktree: inspected.repository.worktree?.linked ?? false,
          linearWorkspace,
        },
      },
      configSource: loaded.source,
      rounds: [],
      authorization,
    },
  });
  if (authorization) {
    const how = authorization.basis === "trust" ? `Live run started under repository trust ${authorization.trust?.id} (granted by ${authorization.user}; no per-run prompt)` : `Live run approved by ${authorization.user} via ${authorization.channel}`;
    app.store.appendEvent(run.id, "QUEUED", "info", "run.authorized", `${how} (scope ${authorization.scopeHash.slice(0, 12)})`, authorization);
  }
  return settled(app, await engineFor(app, loaded, snapshot, linearWorkspace).drive(run.id, { expect: { mode: run.mode, issueKey: run.issueKey, repo: run.repo }, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) }));
}

/** Every drive ends by writing the delivery report and sending the notification its state deserves. */
async function settled(app: App, run: RunRecord<RunContext>): Promise<RunRecord<RunContext>> {
  await settleRun(app, run);
  return app.store.getRun<RunContext>(run.id) ?? run;
}

/**
 * Record a person's merge or close of the run's PR without driving it: read-only towards GitHub,
 * so it never asks for approval, in either mode (core/reconcile.ts). Then settle the run.
 */
export async function reconcileRunById(app: App, id: string): Promise<RunRecord<RunContext>> {
  const run = findRunOrThrow(app, id);
  const [after] = await reconcileRuns(app, [run]);
  await settleRun(app, after!);
  return app.store.getRun<RunContext>(run.id)!;
}

/** `orchestrator watch`: follow a delivered run until its PR is merged or closed (bounded, foreground). */
export async function watchRunById(app: App, id: string, opts: WatchOptions): Promise<{ run: RunRecord<RunContext>; settled: boolean }> {
  const run = findRunOrThrow(app, id);
  const res = await watchRun(app, run.id, opts);
  await settleRun(app, res.run);
  return { run: app.store.getRun<RunContext>(run.id)!, settled: res.settled };
}

export function findRunOrThrow(app: App, id: string): RunRecord<RunContext> {
  const run = app.store.findRun<RunContext>(id);
  if (!run) throw new RunError(`no run matches "${id}" (see: orchestrator status)`);
  return run;
}

/** Reloads the repository config, so permission changes take effect on resume. */
export async function resumeRun(
  app: App,
  id: string,
  opts: Pick<EngineOptions, "onEvent" | "interrupt"> & { ciWaitMinutes?: number; acceptDependencies?: string[]; requireApproval?: boolean } = {},
): Promise<RunRecord<RunContext>> {
  let run = findRunOrThrow(app, id);
  if (TERMINAL_STATES.has(run.state)) throw new RunError(`run ${run.id} is ${run.state}; start a new run instead`);
  // What the operator is shown and approves. The engine leaves a block only if the run is still on
  // exactly this block when the drive starts; a run resumed while not BLOCKED gets no unblock at all.
  const approvedResume: ApprovedResume = { state: run.state, blockedFrom: run.blockedFrom, reason: run.reason };
  if (run.mode === "supervised" && app.env.ORCHESTRATOR_NO_EXECUTE) throw new IntakeError("execution_disabled", "live runs are disabled in this environment (ORCHESTRATOR_NO_EXECUTE is set)");
  const source = run.context.configSource;
  const loaded = source && existsSync(source) ? loadRepoConfigFile(source) : loadRepoConfig(run.repo, app.paths);
  if (loaded.config.repo !== run.repo) throw new ConfigError(`${loaded.source} now configures ${loaded.config.repo}, but the run is for ${run.repo}`);
  const accepted = [...new Set([...(run.context.options.acceptedDependencies ?? []), ...(opts.acceptDependencies ?? []).map((k) => k.toUpperCase())])];

  // The mode decided here (approval or not) is the mode the drive uses, whatever the store says later.
  const expect = { mode: run.mode, issueKey: run.issueKey, repo: run.repo };
  // Every resume of a live run asks a person again, unless the repository is trusted for exactly
  // the current scope. The approval stored on the run is audit only: the store is a file an agent
  // can write, so a stored record can never stand in for consent.
  let authorization = run.context.authorization ?? null;
  let byPerson = false;
  if (run.mode === "supervised") {
    if (!loaded.config.permissions.agents.run) throw new IntakeError("not_permitted", `${run.repo}'s configuration no longer grants live runs (permissions.agents.run is false)`);
    const { scope, hash } = runScope({ issue: run.issueKey, config: loaded.config, configSource: loaded.source, acceptedDependencies: accepted });
    const changed = authorization && authorization.scopeHash !== hash ? " (scope changed since the run was approved)" : !authorization ? " (no approval on record)" : "";
    const d = describeScope(scope, { title: run.context.issue?.title ?? null });
    const reason = `resume live Orchestrator run ${run.id} at ${run.state}${changed}: ${d.reason.replace(/^start a live Orchestrator run of /, "")}`;
    const r = await authorizeLive(app, {
      purpose: "resume_live_run",
      loaded,
      issue: run.issueKey,
      scopeHash: hash,
      reason,
      acceptedDependencies: accepted,
      requireApproval: Boolean(opts.requireApproval),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ask: (trustLine) =>
        requireApproval(app, "resume_live_run", {
          issue: run.issueKey,
          repo: run.repo,
          scopeHash: hash,
          reason,
          details: [
            `Run:         ${run.id} (${run.state}${run.reason ? `: ${run.reason}` : ""})`,
            run.state === "BLOCKED" ? "Approves:    leaving this block once; any later block stops the run again" : "Approves:    continuing from this state; any block reached stops the run (no unblock)",
            "Grants:      a new time window of limits.max_run_minutes (the cost cap is never reset)",
            ...d.details,
            trustLine,
          ],
        }),
    });
    authorization = r.authorization;
    byPerson = !r.trusted;
    app.store.appendEvent(
      run.id,
      run.state,
      "info",
      "run.authorized",
      r.trusted ? `Resume started under repository trust ${authorization.trust?.id} (no per-run prompt; the run keeps its time window)${changed}` : `Resume approved by ${authorization.user} via ${authorization.channel}${changed}`,
      authorization,
    );
  }
  // A resume a person approved grants a fresh time window (the cost cap is never reset). A trusted
  // resume does not: unattended resumes cannot extend a run past limits.max_run_minutes.
  run = app.store.patchContext<RunContext>(run.id, {
    ...(byPerson || run.mode !== "supervised" ? { limitWindowStartedAt: new Date().toISOString() } : {}),
    options: { ...run.context.options, ...(opts.ciWaitMinutes !== undefined ? { ciWaitMinutes: opts.ciWaitMinutes } : {}), acceptedDependencies: accepted },
    authorization,
  });
  app.store.appendEvent(run.id, run.state, "info", "run.resume", `Resume requested at ${run.state}`);
  const snap = run.context.options.issueSnapshot;
  return settled(app, await engineFor(app, loaded, snap ? new SnapshotTracker(snap.file) : undefined, run.context.options.intake?.linearWorkspace).drive(run.id, { resume: approvedResume, expect, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) }));
}

/**
 * Cancel. If a process is driving the run, flag it and let that process stop
 * its agent/check cleanly; otherwise transition directly. Worktrees are kept.
 */
export function cancelRun(app: App, id: string): { run: RunRecord<RunContext>; deferred: boolean } {
  const run = findRunOrThrow(app, id);
  if (TERMINAL_STATES.has(run.state)) throw new RunError(`run ${run.id} is already ${run.state}`);
  app.store.requestCancel(run.id);
  if (app.store.leaseHolder(run.id)) {
    app.store.appendEvent(run.id, run.state, "warn", "run.cancel_requested", "Cancellation requested; the driving process will stop");
    return { run: app.store.getRun<RunContext>(run.id)!, deferred: true };
  }
  const cancelled = app.store.transition<RunContext>(run.id, run.version, { to: "CANCELLED", reason: "cancelled by operator" });
  return { run: cancelled, deferred: false };
}

// ---- approvals ------------------------------------------------------------------------------

/** Ask a person (never the caller's arguments) and record the answer; throws unless approved. */
export async function requireApproval(
  app: App,
  purpose: ApprovalPurpose,
  req: { issue: string | null; repo: string; scopeHash: string; reason: string; details: string[] },
): Promise<NonNullable<RunContext["authorization"]>> {
  const full = { purpose, ...req };
  let res: ApprovalResult;
  try {
    res = await app.approver.request(full);
  } catch (err) {
    res = { approved: false, channel: app.approver.channel, detail: `approval failed: ${(err as Error).message}`, at: new Date().toISOString(), user: "unknown" };
  }
  auditApproval(app.paths.home, full, res);
  if (!res.approved) {
    throw new IntakeError("approval_required", `not approved: ${res.detail}. Nothing was started or changed. To ${req.reason}, run the same command again and confirm the system prompt on this Mac (an agent cannot answer it for you).`, { purpose, channel: res.channel, scopeHash: req.scopeHash });
  }
  return { purpose, scopeHash: req.scopeHash, approvedAt: res.at, channel: res.channel, user: res.user, detail: res.detail };
}

type Authorization = NonNullable<RunContext["authorization"]>;

/**
 * Authorization for a live run or resume: the repository's trust when it covers this exact scope,
 * otherwise a person's approval now (`ask`). Trust is never used when the caller asked for approval,
 * or when the run carries operator-accepted dependencies (an operator judgement trust does not
 * delegate). Every use of trust is audited like an approval.
 */
async function authorizeLive(
  app: App,
  input: {
    purpose: "live_run" | "resume_live_run";
    loaded: LoadedRepoConfig;
    issue: string;
    scopeHash: string;
    reason: string;
    acceptedDependencies: string[];
    requireApproval: boolean;
    onEvent?: NonNullable<EngineOptions["onEvent"]>;
    ask: (trustLine: string) => Promise<Authorization>;
  },
): Promise<{ authorization: Authorization; trusted: boolean }> {
  const trust = app.trust.evaluate(input.loaded);
  const repo = input.loaded.config.repo;
  if (trust.status === "trusted" && !input.requireApproval && input.acceptedDependencies.length === 0) {
    const rec = trust.record;
    const at = new Date().toISOString();
    const detail = `trusted repository: trust ${rec.id}, granted by ${rec.trustedBy} on ${rec.trustedAt} via ${rec.channel}; no per-run prompt`;
    auditApproval(app.paths.home, { purpose: input.purpose, reason: input.reason, details: [], issue: input.issue, repo, scopeHash: input.scopeHash }, { approved: true, channel: TRUST_CHANNEL, detail, at, user: rec.trustedBy });
    input.onEvent?.({ level: "info", state: "QUEUED", type: "run.trusted", message: `${repo} is trusted (trust ${rec.id}): starting without a per-run prompt` });
    return {
      authorization: { purpose: input.purpose, scopeHash: input.scopeHash, approvedAt: at, channel: TRUST_CHANNEL, user: rec.trustedBy, detail, basis: "trust", trust: { id: rec.id, scopeHash: rec.scopeHash, trustedBy: rec.trustedBy, trustedAt: rec.trustedAt } },
      trusted: true,
    };
  }
  const why =
    trust.status === "trusted"
      ? input.requireApproval
        ? "repository is trusted, but approval was requested (--require-approval)"
        : `repository is trusted, but operator-accepted dependencies (${input.acceptedDependencies.join(", ")}) always need a person`
      : describeTrustState(trust);
  if (trust.status !== "untrusted") input.onEvent?.({ level: "warn", state: "QUEUED", type: "run.trust_not_used", message: `Asking for approval: ${why}` });
  const a = await input.ask(`Trust:       ${why}`);
  return { authorization: { ...a, basis: "approval", trust: null }, trusted: false };
}

/**
 * `orchestrator repo trust`: after a person approves the exact scope, live runs and resumes of this
 * repository start without a per-run prompt (core/trust.ts). The config is the one a run without
 * `--config` resolves to (operator-owned locations only). Only ever called by that command.
 */
export async function trustRepository(app: App, repo: string): Promise<{ state: "trusted" | "already_trusted"; record: TrustRecord; file: string }> {
  const loaded = loadRepoConfig(repo, app.paths);
  if (loaded.config.repo.toLowerCase() !== repo.toLowerCase()) throw new ConfigError(`${loaded.source} configures ${loaded.config.repo}, not ${repo}`);
  const problems = trustEligibility(loaded.config);
  if (problems.length) throw new IntakeError("not_trustable", `${loaded.config.repo} cannot be trusted: ${problems.join("; ")}. Nothing was changed; live runs keep asking in a system prompt.`, { problems });
  const current = app.trust.evaluate(loaded);
  if (current.status === "trusted") return { state: "already_trusted", record: current.record, file: current.file };
  // Frozen before asking: what is written is what was shown. A config edited while the prompt is
  // open is simply a different scope, so the record written here would be stale, never wider.
  const { scope, hash } = trustScope(loaded);
  const d = describeTrust(scope, { renewing: current.status === "stale" });
  const res = await requireApproval(app, "trust_repository", {
    issue: null,
    repo: loaded.config.repo,
    scopeHash: hash,
    reason: d.reason,
    details: [...d.details, ...(current.status === "stale" || current.status === "invalid" ? [`Replaces:    ${describeTrustState(current)}`] : [])],
  });
  const record = app.trust.write({ scope, scopeHash: hash, trustedBy: res.user, trustedAt: res.approvedAt, channel: res.channel, detail: res.detail });
  app.trust.audit({ action: "trust", repo: record.repo, trustId: record.id, scopeHash: hash, configSource: loaded.source, by: res.user, channel: res.channel });
  return { state: "trusted", record, file: app.trust.file(record.repo) };
}

/** `orchestrator repo untrust`: revoke. Narrows authority, so it never asks. */
export function untrustRepository(app: App, repo: string): boolean {
  const removed = app.trust.remove(repo);
  app.trust.audit({ action: "untrust", repo: repo.toLowerCase(), removed });
  return removed;
}

/** A repository's trust state for the config a run without `--config` would use. */
export function repositoryTrust(app: App, repo: string): { loaded: LoadedRepoConfig | null; state: TrustState | null; error: string | null } {
  try {
    const loaded = loadRepoConfig(repo, app.paths);
    return { loaded, state: app.trust.evaluate(loaded), error: null };
  } catch (err) {
    return { loaded: null, state: null, error: (err as Error).message };
  }
}

/**
 * `orchestrator repo authorize`: grants the pending proposal's permissions after a person approves.
 * The proposal is read, validated and frozen before asking; the prompt is built from what will be
 * written, and the frozen bytes are what is written (the proposal is not read again afterwards).
 */
export async function authorizeRepository(app: App, repo: string, opts: { readOnly?: boolean; replace?: boolean } = {}): Promise<{ file: string; scope: "supervised" | "read_only"; sha256: string }> {
  const prep = prepareAuthorization(app.paths, repo, opts);
  const p = prep.config.permissions;
  const grants = prep.scope === "read_only" || !p.agents.run
    ? "dry runs only (no agent runs or remote writes)"
    : [
        "agent runs",
        p.github.push ? "push" : null,
        p.github.create_pr ? "draft PRs" : null,
        p.github.merge ? "MERGE" : null,
        p.linear.comment || p.linear.update_state ? "Linear updates" : null,
      ].filter(Boolean).join(", ");
  await requireApproval(app, "authorize_repository", {
    issue: null,
    repo,
    scopeHash: createHash("sha256").update(prep.content).digest("hex"),
    reason: `${prep.replaces ? "replace the Orchestrator authorization" : "authorize Orchestrator"} for ${repo}: ${grants}; merge ${prep.config.merge.mode}; budget $${prep.config.limits.max_run_cost_usd} per run`,
    details: [
      `Proposal:    ${prep.pending} (sha256 ${prep.sha256.slice(0, 12)})`,
      `Writes:      ${prep.file}${prep.replaces ? " (replacing the existing file)" : ""}`,
      `Scope:       ${prep.scope === "read_only" ? "read-only (dry runs only)" : "as proposed"}`,
      `Permissions: agent runs ${p.agents.run}, push ${p.github.push}, draft PR ${p.github.create_pr}, merge ${p.github.merge}, Linear comment ${p.linear.comment}, Linear state ${p.linear.update_state}`,
      `Merge:       ${prep.config.merge.mode}`,
    ],
  });
  if (!opts.replace && existsSync(prep.file)) throw new ConfigError(`${prep.file} appeared while waiting for approval; nothing was written (pass --replace to overwrite it)`);
  return writeAuthorization(prep);
}

/** `orchestrator associate`: records that an issue is this repository's work after a person approves. */
export async function confirmAssociation(app: App, input: { issue: string; repo: string; workspace: string | null }): Promise<SavedAssociation> {
  await requireApproval(app, "confirm_association", {
    issue: input.issue,
    repo: input.repo,
    scopeHash: `${input.issue}->${input.repo.toLowerCase()}`,
    reason: `record that Linear issue ${input.issue} is work for ${input.repo}`,
    details: [`Issue:      ${input.issue}${input.workspace ? ` (workspace ${input.workspace})` : ""}`, `Repository: ${input.repo}`],
  });
  return saveAssociation(app.paths, { tracker: "linear", issue: input.issue, repo: input.repo, workspace: input.workspace });
}
