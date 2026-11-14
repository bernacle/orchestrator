# Private remote approval

Remote approval is optional. Installing or updating Orchestrator does not enable it, configure
Tailscale, open a listener, or enroll a credential. Local macOS Touch ID / password remains the
default until enrollment, and is always selectable with `--approval-channel local`.

## Operator setup (separate from implementation)

Use a **dedicated personal tailnet**, an exclusive HTTPS origin and authorized personal devices.
Do not switch or reconfigure an existing work Tailscale client to accomplish this. Arranging a
personal Tailscale context that leaves work connectivity intact is an operator deployment
prerequisite. The `tailscale` CLI used by the engine must inspect that personal context. If it
instead sees the work tailnet, remote approval refuses to start and changes nothing.

Configure the personal network separately:

- HTTPS certificates and MagicDNS for the Mac's stable `device.tailnet.ts.net` name.
- Private Serve, HTTPS on port 443, with exactly one TCP handler (HTTPS 443) and the sole `/` handler pointing to
  `http://127.0.0.1:47832`. No other application may share this origin. Additional TCP, service and foreground handlers are refused, including raw TCP forwards that could carry forged proxy headers.
- Funnel disabled. Orchestrator rejects a Serve configuration with any enabled Funnel entry.
- Tailnet access policy allowing only the authorized personal devices to reach the approval
  service. The application additionally checks the owner login and device stable ID on **every**
  HTTP request. Tailnet membership alone grants neither request visibility nor approval.
- Tailscale 1.102.2 or newer, whose Serve proxy overwrites forwarding headers with the actual source
  address, original HTTPS host and scheme. Missing or ambiguous headers fail closed.

Orchestrator only runs `tailscale status --json`, `tailscale serve status --json` and
`tailscale whois --json ADDRESS`. It never logs in, switches accounts, enables Serve or Funnel,
changes policy, or modifies Tailscale state. No cloud application, database, queue or daemon is
added. The Mac must be awake, connected, and running the waiting command. Serve can remain
configured while its loopback target is absent; Orchestrator's listener exists only during a
ceremony. Concurrent ceremonies on port 47832 fail closed; finish or cancel the first one.

## Enroll the iPhone locally once

On the Mac, after the personal endpoint is configured, run the following with the actual origin,
tailnet name, Mac stable ID, owner login and iPhone stable ID from the personal Tailscale status:

```bash
orchestrator approval enroll \
  --origin https://MAC.PERSONAL-TAILNET.ts.net \
  --personal-tailnet PERSONAL-TAILNET-NAME \
  --server-node nMAC-STABLE-ID \
  --owner YOUR-PERSONAL-LOGIN \
  --device nIPHONE-STABLE-ID
```

The example IDs and uppercase hostname are placeholders; substitute actual values. Repeat
`--device` only for personal devices you authorize. The origin has no path, port, username or
query string. Its host must match the Mac's Tailscale DNS name and advertised certificate domain.

Open the printed private HTTPS URL in Safari on the iPhone and create the passkey. The page
shows a candidate fingerprint. Compare its **entire fingerprint** with the local Mac system
prompt, then confirm Touch ID / password. The prompt binds the exact candidate public key,
origin, personal tailnet, owner and allowed devices. An open enrollment window never gives the
first caller authority. Enrollment commits only that locally approved candidate; swapping in a
second candidate while the prompt is open is refused. The Mac CLI reports when enrollment has
actually completed. A candidate receipt on the phone is not confirmation of enrollment.

Replacing the credential or changing origin, owner, devices or tailnet requires this local
ceremony again. A lost phone is recovered locally. There is no chat, file or terminal-yes
bootstrap. Passkeys may sync through their provider; the engine proves signature possession and
user verification, not a specific biometric modality or hardware provenance. Device access is
enforced separately through Tailscale.

## Requesting work from the phone

Trusted Mode still runs routine tasks without per-run approval. Added sandboxed checks within
the approved network boundary and provable restrictions do not invalidate trust. Expanded
permissions, relaxed forbidden paths, larger limits, weaker review/CI or verification safeguards,
and changes whose safety cannot be established require authorization.

Once enrolled, exceptional operations use the remote channel automatically. The waiting command
prints an `approval.pending` JSON line on stderr containing the private URL, expiry and request
digest, including when the command uses `--json`. The T3/agent frontend relays that URL and keeps
the command alive. No secret or bearer approval token is in the URL. The iPhone page shows the
repository, operation, current/proposed scope, scope changes and expiry. Expanding “Exact scope,
operation and digest” reveals the complete engine-generated authorization manifest.

“Approve with passkey” requires user verification for **each approval**. Tailscale authentication
only controls transport and visibility. The engine independently verifies the WebAuthn signature,
registered public key, exact challenge, origin, RP ID, user presence and user verification. It
rejects cross-origin ceremonies. A one-shot run/resume approval never silently renews standing
repository trust. Renewing trust is a separate operation clearly bound as `standingTrust: true`.

```bash
orchestrator approval status --json
orchestrator --approval-channel local repo trust owner/name  # explicit local option
orchestrator --approval-channel remote repo trust owner/name # explicit remote option
orchestrator approval disable                               # revoke; does not change Tailscale
```

`context` and `doctor` report channel availability. A configured remote channel that is invalid
or unavailable refuses authorization and explains the local option; it does not silently choose
a weaker channel. The protocol refuses remote authority that disables sandboxing, independent
review, required CI, draft-PR creation, or manual merging.

## Binding, expiry and replay

Each challenge hashes a domain separator, a random 256-bit nonce and an immutable manifest. The
manifest includes installation identity, credential generation, purpose, repository, issue,
scope hash, complete normalized configuration digest, exact operation and expiration. A resume
also binds the run ID, version, state, block/reason, accepted dependencies and explicit intent to
extend its time window. Before acceptance, the engine revalidates configuration and run context,
credential registry and private transport. Changes invalidate the pending operation.

Requests expire after ten minutes. Only one verification may be in progress, and successful
requests are consumed before the engine receives authorization. They live only in the requesting
process; cancellation, expiry or restart cannot restore them from files or the run database.
Restarting requires a fresh request and passkey assertion. Synced passkey signature counters may
be zero; counters are not used as the replay defense. Failed assertions confer no authority.

A normal resume retains the existing time window. Only an explicit `resume --require-approval`
requests a new one, including on the remote approval page. Cumulative cost is never reset.

The registry stores public keys and settings under `ORCHESTRATOR_HOME/credentials`, which the
execution sandboxes deny. An installation-specific HMAC key lives in macOS Keychain (a protected
credential file off macOS, although initial enrollment requires macOS). The registry cannot
select its key store. Reenrollment rotates the key, and disable deletes it; restoring an older
registry does not restore authority. Pending requests also compare the entire registry before
acceptance. Approval audit logs are never loaded as authorization.

This preserves the existing trusted-engine boundary: an agent cannot forge a passkey signature
or submit “approved” JSON as consent. It does not defend against replacing engine code or a
determined same-user process extracting an HMAC seal key and replacing trusted state. Browser
origin integrity and the engine's code remain trusted. No UI assertion proves that a person
read every line of the displayed scope. See [skills.md](skills.md#the-trade-off-plainly).

## Trusted Mode migration and verification floor

New trust records include mandatory check commands and screenshot policy. Removing/optionalizing
a mandatory check, replacing its command, or weakening screenshot policy requires approval.
Additional mandatory checks, lower budgets, removed permissions, literal subsets of read/tool
allowlists, and supersets of forbidden paths remain within authority. Glob inclusion is never
guessed; an unproven relationship requires consent. Effective command network policy is compared
after resolving defaults and overrides.

On a trusted execution, narrowed scope and added safeguards are sealed as the new ceiling/floor,
rotating the key so an old record cannot undo them. This is a restriction, not new human consent,
and is audited as `narrow`. Read-only inspection does not rewrite records. Legacy records retain
their original delegation: their check commands were never bound. The first trusted execution
anchors the checks present at that moment without expanding the old security scope. Historical
checks absent before that migration cannot be reconstructed or claimed as previously sealed.

Trust mutations/revocation are serialized per repository. A crashed mutation leaves a fail-closed
`.lock` directory, with a PID for local inspection. Retry after an active command exits; inspect
and remove a crash lock locally before retrying. There is no force-unlock or approval bypass flag.

## Verification still required before remote use

Automated tests use synthetic passkeys, real signature verification, temporary HTTP listeners
and fake read-only Tailscale responses. They do not establish readiness of a deployed personal
tailnet or an actual iPhone. Before relying on remote operation, perform local enrollment and a
real iPhone approval, rejection, expiry and replay test, verify an unauthorized device cannot
read requests, and verify a work-tailnet mismatch refuses without changing work connectivity.

BRU-461's failed run `bru-461-5af57b`, its worktree and implementation artifacts are preserved.
The PostgreSQL verification requirement and CI workflow permission expansion are not removed to
avoid consent. After setup and real-device verification, authorize the exact required scope and
request a **fresh** BRU-461 run separately. Implementing this feature never starts that run.

References: [WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion),
[SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server),
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
