# Trust Spine governed-run runbook

## Purpose and current availability

This runbook describes the Trust Spine operator contract. It is deliberately
conservative: a governed run is useful only when its admission, tape,
authorization, sandbox, candidate, review, and promotion evidence are all
available through the isolated host authority plane.

For the supported/raw/historical/shadow surface at a glance, see the
[Trust Spine compatibility matrix](trust-spine-compatibility-matrix.md).

In the current distribution, the public CLI can compile, validate, and render
a governed preview. It blocks before a worker or target-branch mutation when
the required host authority is unavailable. That block is expected behavior,
not an invitation to rerun the same packet with an ambient model shell.

## Operator lanes

| Lane | Entry point | Authority and outcome | Receipt eligibility |
| --- | --- | --- | --- |
| Governed preview | `buildplane run --packet <file>` | Compiles and shows the bounded request; creates no execution authority | None |
| Governed host request | `buildplane run --packet <file> --approve` | Requests a host-owned candidate session. It remains blocked until the host verifies admission, tape, and OCI prerequisites. | Only after the host emits a verified governed receipt |
| Governed recovery | `buildplane run --resume <opaque-host-reference> --approve` | Host-only recovery of an existing workflow identity; no caller packet or replacement envelope is accepted. | Only an exact signed result is reusable |
| Promotion decision and execution | `buildplane run --resume <promotion-approval-event-uuid> --approve --decision promote\|reject` | Seals one closed decision. Rejection terminates without Git; promotion passes only the signed decision event identity to the separately confined exactly-once executor. | Signed decision plus protected promotion result or reconciliation evidence |
| Raw compatibility | `buildplane run --raw ...` | Explicitly unsafe legacy execution; may use ambient adapters. | Never governed or trusted |

Do not use `--raw` to work around a governed block. Raw output is labelled
unsafe and cannot establish admission, approval, candidate, promotion, or
trusted receipt evidence.

## Governed source-packet preflight

Before requesting host admission, ensure the source packet has all of the
following:

1. An explicit supported `execution_role` and a non-empty `provenance_ref`.
2. A validated capability bundle and matching canonical digest.
3. A closed V1 acceptance contract with `schemaVersion: 1`, the compatible
   `contract_version: "v0"`, a diff scope, and closed check records.
4. A closed V1 trust scope with `schemaVersion: 1`, `lane: "governed"`, a
   principal, and a scope.
5. Atomic commit mode only. Incremental and saga modes are intentionally
   rejected in governed admission.

Unknown fields, alternate schema versions, missing provenance, malformed
digests, role mismatches, and malformed nested governance records are
admission failures. Correcting the packet produces a new candidate request;
it never changes a previously signed dispatch.

## Legacy-packet migration

Legacy `UnitPacket` files are compiler input only. Buildplane may render a
preview from them, but it must not infer a role, provenance, capability,
acceptance contract, trust scope, manifest, or preauthorization from omitted
data. To migrate one, create a new governed source packet with the preflight
fields above, obtain a fresh operator approval or a valid host preauthorization,
and let the host issue a new signed dispatch.

Historical tapes remain readable and are never backfilled. A legacy run and a
raw run must not be relabelled as governed after the fact, even when their
working-tree result happens to resemble an approved candidate.

## Candidate, review, and promotion

The target branch must stay unchanged while implementation creates an isolated
candidate. Deterministic acceptance and semantic review bind to that candidate
digest. A review decision other than `approve`, malformed review output,
failed acceptance, cancellation, or stale target base blocks promotion.

The default governed CLI carries a successful candidate receipt directly into
the protected read-only reviewer session using the host-issued opaque recovery
identity. An approved closed review returns a V2 host receipt containing the
exact kernel-signed `promotion_approval_requested` event ID; the CLI reports
`review-approved-awaiting-promotion-decision` and gives the operator the
corresponding `--resume` command. `request_changes`, `reject`, and `abstain`
report `review-blocked` and expose no promotion request.

The only valid promotion sequence is:

```text
immutable candidate digest
  -> deterministic acceptance bound to that digest
  -> structured approved review bound to that digest
  -> signed promotion decision bound to candidate and base
  -> sealed one-shot promotion execution lease bound to that decision
  -> one host-owned compare-and-swap merge
  -> signed result or reconciliation record
```

An operator must not merge a candidate ref manually and then report a
successful governed promotion. The native decision-bound Git executor owns
that final compare-and-swap and its durable result. The CLI invokes it only
after verifying the sealed decision response and passes only the resulting
promotion-decision event UUID. Any missing, malformed, pending, expired,
rejected-for-promote, or reconciliation response remains blocked.

### Protected promotion-decision host

`buildplane-authority-host` activates only the operator
promotion-decision endpoint. It records and kernel-seals one replay-derived
decision; it has no Git, CAS, provider, model, network, or action-execution
capability. Promotion execution remains a separate endpoint and OS role.

The binary accepts no arguments or environment overrides. A supervisor must
pass exactly one already-listening Unix stream socket as file descriptor 3.
The kernel-reported pathname must be exactly
`/run/buildplane/authority-host/promotion-decision-v1.sock`. The three parent
directories must be root-owned exact `0755`; the socket must be root-owned,
group-owned by the GID named in the fixed host config, exact `0660`, and have
one link. The broker service UID and every configured client UID must be
non-root and distinct. Failure to meet any part of this contract stops startup;
the host never binds, unlinks, replaces, or falls back to another socket.

The following systemd units illustrate the deployment contract. The
`buildplane-operator` group must resolve to the same GID as
`socket_group_gid`, while `buildplane-authority` and every authorized client
must resolve to the distinct UIDs pinned in the fixed config. The sample
assumes the configured authority root is
`/var/lib/buildplane/authority`.

```ini
# buildplane-authority-host.socket
[Unit]
Description=Buildplane protected promotion-decision socket

[Socket]
ListenStream=/run/buildplane/authority-host/promotion-decision-v1.sock
Accept=no
Service=buildplane-authority-host.service
SocketUser=root
SocketGroup=buildplane-operator
SocketMode=0660
DirectoryMode=0755
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

```ini
# buildplane-authority-host.service
[Unit]
Description=Buildplane protected promotion-decision authority
Requires=buildplane-authority-host.socket
After=buildplane-authority-host.socket
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/libexec/buildplane/buildplane-authority-host
User=buildplane-authority
Group=buildplane-authority
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/etc/buildplane/authority-host
ReadOnlyPaths=/var/lib/buildplane/authority/keys
ReadOnlyPaths=/var/lib/buildplane/authority/repository
ReadWritePaths=/var/lib/buildplane/authority/ledger
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
UMask=0077
StandardOutput=null
StandardError=journal
```

The socket unit must be the service's only activated listener so systemd
passes it as descriptor 3. Create and verify the fixed config, authority root,
keys, ledger, OS users, and group through the protected-host provisioning
process; the binary intentionally provides no provisioning mode.

The journal receives only the fixed redacted categories `startup_failed`,
`accept_failed`, `unsupported_platform`, or `invalid_arguments`; it never
receives request, identity, path, descriptor, signer, ledger, or OS-error
details from this host.

A compromised allowlisted operator UID can cause bounded availability loss by
occupying the sequential endpoint. Isolate and monitor each allowlisted UID.
This availability risk cannot expand authority or create concurrent ledger writes;
the single-writer serving model remains intentional.

### Protected promotion-execution host

`buildplane-promotion-execution-host` is a separate Linux process and
confinement role. It does not possess the operator signing key and cannot
create or alter a promotion decision. It accepts only a canonical sealed
promotion-decision event UUID over the fixed
`/run/buildplane/authority-host/promotion-execution-v1.sock` endpoint.
Candidate digest, base commit, target ref, repository path, Git command, lease,
signer, and idempotency facts are reconstructed from the signed tape.

The executor loads only the kernel key, protected ledger, replay authorities,
and the fixed `repository` directory opened without symlink traversal beneath
the descriptor-bound authority root. Provision a bare or otherwise headless
exact target repository at
`/var/lib/buildplane/authority/repository`, owned by the configured broker UID
with mode `0700`. It must be the same Git common repository that contains the
immutable candidate refs; a copy or alternate checkout is not valid.
If any worktree has the signed target ref checked out, promotion records
`root_checkout_stale` and remains reconciliation-required instead of claiming
terminal completion.

The dedicated systemd socket passes descriptor 3 at the exact execution socket
path. The service grants write access only to the protected ledger and fixed
repository. Although ledger compatibility currently requires the decision and
execution services to share the configured broker UID, the execution service's
private mount namespace makes
`/var/lib/buildplane/authority/keys/operator` inaccessible, restricts `/proc`
to the service's own PID view, and creates a private network namespace. The
executor can therefore load the kernel key it needs without gaining a path to
the operator decision key. Its canonical reviewed units are
`deploy/trust-spine/systemd/buildplane-promotion-execution-host.service` and
`.socket`. Never add a host-shell fallback, writable key directory, network
family, operator-key mount, caller-selected repository, or executable
override.

Execution first reopens trusted replay. A reject decision records and seals one
lease-free `rejected` result plus a failed `WorkflowTerminalV2`, then returns
`rejected` without claiming or entering Git. A promote decision obtains one durable
lease-bound claim, consumes one private fixed-Git capability, performs the
candidate/base compare-and-swap, and records the result. When the target ref is
not checked out anywhere, the host records and seals a completed
`WorkflowTerminalV2` and returns the signed `completed` status. Existing claims,
expired leases, uncertain Git observation, or result-write uncertainty return
`pending`, `lease_expired`, or `reconciliation_required`; they never authorize
a second Git attempt. A signed `recorded` response remains nonterminal recovery
evidence; only `completed` proves that the exact promoted result and terminal
workflow record are both kernel-sealed.

### Protected governed-session host

`buildplane-governed-session-host` is the Linux-only API-provider and reviewer
session endpoint. It accepts no arguments or environment overrides and never
binds a socket. Systemd must pass exactly one already-listening Unix stream as
descriptor 3 at
`/run/buildplane/authority-host/governed-session-v1.sock`. The same parent,
owner, group, mode, and single-link requirements described above apply, using
the `socket_group_gid` in
`/etc/buildplane/authority-host/governed-session-v1.json`.

Build and stage the exact native host/client pair plus the reviewed systemd
units as one content-addressed deployment bundle:

```sh
cargo build --release --manifest-path native/Cargo.toml \
  -p bp-authority-broker --bins
pnpm stage:trust-spine:protected-host -- \
  --out /var/tmp/buildplane-protected-host-v1
```

The staging command never installs a service or grants authority. It rejects
non-regular or symlinked inputs, snapshots Cargo hard-linked outputs into fresh
single-link files, writes fixed installation destinations and modes, and hashes
every binary and unit into `manifest.json`. Transfer the bundle through the
protected release path, independently verify every manifest hash, then install
the files at their declared destinations as root-owned, single-link regular
files. The canonical unit sources live under
`deploy/trust-spine/systemd`; do not copy the prose examples from this runbook.

Startup is all-or-nothing. Before accepting a client, the host verifies the
fixed socket, non-root broker identity, configured client UID set, signer
separation, signed ledger, protected CAS, Anthropic credential file, and the
configured rootless Podman canary. The credential must remain at the fixed
protected authority-root location; `ANTHROPIC_API_KEY`, proxy variables, PATH,
and caller-supplied paths do not select provider authority. Missing Podman,
OCI flags, image, credentials, keys, ledger, or CAS blocks startup without a
host-shell fallback.

```ini
# buildplane-governed-session-host.socket
[Unit]
Description=Buildplane protected governed-session socket

[Socket]
ListenStream=/run/buildplane/authority-host/governed-session-v1.sock
Accept=no
Service=buildplane-governed-session-host.service
SocketUser=root
SocketGroup=buildplane-governed-session
SocketMode=0660
DirectoryMode=0755
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

```ini
# buildplane-governed-session-host.service
[Unit]
Description=Buildplane protected governed-session authority
Requires=buildplane-governed-session-host.socket
After=buildplane-governed-session-host.socket
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/libexec/buildplane/buildplane-governed-session-host
User=buildplane-session-authority
Group=buildplane-session-authority
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/etc/buildplane/authority-host
ReadOnlyPaths=/var/lib/buildplane/authority/keys
ReadOnlyPaths=/var/lib/buildplane/authority/credentials
ReadWritePaths=/var/lib/buildplane/authority/cas
ReadWritePaths=/var/lib/buildplane/authority/ledger
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
UMask=0077
StandardOutput=null
StandardError=journal
```

The configured provider endpoint is fixed in the host binary and redirects
and ambient proxy discovery are disabled. Egress policy outside the process
must allow only the approved provider destination. Governed-session ingress
exposes exactly `probe`, `open_candidate_session`, `open_recovery_session`,
`run_candidate_session`, `open_reviewer_session`, and
`run_reviewer_session`. A candidate packet is accepted only while opening the
initial session. The host stores it in verified CAS and binds its digest to the
protected workspace manifest; candidate execution and recovery accept only
opaque session or recovery references and reload those exact bytes from CAS.
Caller-supplied packet replacement and general tool execution remain blocked.
Nonterminal or failed signed run responses contain only opaque session
references and the closed status set `pending`, `failed`, `lease_expired`, or
`reconciliation_required`. Candidate success requires a V2 receipt rebuilt
from the signed candidate, completion event, and exact checkpoint root.
Reviewer success requires a V2 host receipt binding the candidate, completion,
passed acceptance, reviewer dispatch, structured verdict, signed verdict
event, exact finalization checkpoint root, and a nullable promotion-request
event reference. The reference is present if and only if the closed verdict is
`approve`. A bare `succeeded` or `recorded` status is rejected as incomplete
success evidence.

### Protected plan-admission host

`buildplane-plan-admission-host` activates only the PlanForge plan-admission
endpoint. It mints and kernel-seals one `plan_admitted` event per accepted
request; it has no Git, provider, model, network, or action-execution
capability, and it holds exactly one signing key. The generic ingest lanes
still refuse `plan_admitted` on both the signed and unsigned paths — this host
is an additional surface, never a relaxation of that wall.

**Nothing drives this endpoint yet.** The PlanForge CLI verbs still throw, and
no TypeScript control-plane path connects to the socket. The mint must not gain
a transport-reachable consumer before the approval arm learns to load, verify,
and require checkpoint coverage of the admission it names. Standing the host up
today gives you a reachable minter with no approved caller; that is expected.

The binary accepts no arguments or environment overrides. A supervisor must
pass exactly one already-listening Unix stream socket as file descriptor 3. The
kernel-reported pathname must be exactly
`/run/buildplane/authority-host/plan-admission-v1.sock`. The socket ownership
and mode contract is the promotion-decision contract, enforced by the same
shared validator: three root-owned exact `0755` parent directories, and a
root-owned socket group-owned by the GID named in the fixed host config, exact
`0660`, with one link. The broker service UID and every configured client UID
must be non-root and distinct. Failure to meet any part of this contract stops
startup; the host never binds, unlinks, replaces, or falls back to another
socket.

Canonical units are `deploy/trust-spine/systemd/buildplane-plan-admission-host.socket`
and `.service`. The socket is group-owned by `buildplane-operator`, matching the
other operator-facing endpoint. The service runs as
`buildplane-plan-authority`, grants write access only to the protected ledger
and the broker-owned CAS, takes a private network namespace, and caps its
descriptor table.

**`buildplane-plan-authority` is not provisioned anywhere in this repository.**
Neither is `buildplane-v5-authority`; both are operator-created system
identities, and the units name them rather than create them. Create the user
and group before enabling the unit, and confirm the authority root, `keys`,
`ledger`, and `cas` directories are owned by that UID with mode `0700` — the
custody layer opens each one `O_NOFOLLOW` from a retained descriptor and
refuses anything else.

The single protected deployment config is
`/etc/buildplane/authority-host/plan-admission-v1.json`. Its exact closed schema
lives in `native/crates/bp-authority-broker/src/plan_admission_host_config.rs`;
unknown fields are rejected rather than ignored. It is run-scoped: one host
serves exactly the one `run_id` it names, and a request for any other run is
refused. `plan_admission_clients` is the closed UID-to-operator-identity policy
— a UID absent from it cannot connect at all, and no two UIDs may share an
identity, because that map is the *only* source of the `decided_by` recorded on
the tape. A request has no field through which it can name an operator.

The host emits exactly three operational strings on stderr and nothing else. No
path, identity, signer, or refusal reason is ever printed:

| Diagnostic | Meaning | Operator action |
| --- | --- | --- |
| `startup_failed` | The listener, config, key, ledger, or CAS custody contract was not met. | Check FD 3 and the socket pathname/ownership/mode first, then the config file's own ownership and parse, then the authority-root subdirectory ownership and modes. The host deliberately does not say which; each is a fail-closed precondition. |
| `accept_failed` | The listener stopped accepting connections. | Treat as a supervisor-level fault: inspect the socket unit and restart the pair. It is not a request-level condition. |
| `unsupported_platform` | The binary ran on a non-Linux host. | Not a misconfiguration to work around. The confinement boundary, the custody layer, and `SCM_RIGHTS` content delivery are Linux-only, and there is no reduced mode. PlanForge admission fails closed everywhere else. |

Individual requests never produce operator-visible text. A completed request
receives a kernel-signed `sealed` or `reconciliation_required` response; a
request refused at the peer, frame, run-binding, identity, digest, or
validation boundary receives no response at all and the connection closes in
silence. Reconciliation is evidence, not failure — it means the mint declined
to claim authority, and the tape is the place to look.

**Accepted residual — CAS write amplification.** An authenticated peer can
stage up to 1 MiB of self-named bytes per connection whenever the mint refuses
*downstream* of the ingress checks: an unconvincing run-start attestation, an
idempotency conflict, or a fresh-snapshot rejection all occur after the bytes
have been written. Only requests disqualified at the ingress boundary — peer,
frame, run binding, identity, digest, or asserted validation status — are
refused before anything is staged. This is inherent to the ratified content
staging shape: the mint resolves content through the broker-owned CAS, so the
bytes must be there before it can decline them. The CAS volume shares a
filesystem with the ledger. Mitigation is a deployment concern the operator
owns: give the authority root its own filesystem or quota, and schedule
collection of CAS objects that no sealed admission references.

**Standing constraint — the trusted base.** The admission's `trusted_base` is
not re-derived from a repository. The host takes the `git_head` from the run's
own `run_started` event after establishing that exactly one exists, verifies
under the realm's pinned trusted keys, and is signed by the configured kernel
identity. The value therefore originates with whoever recorded the run start
and is exactly as trustworthy as the key that signs the admission itself.
Consequently, **while `run_started` is the mint's trusted-base source it must
not become kernel-signable from caller-supplied input.** It sits on the
signed-append denylist today, pinned by name in `bp-ledger`'s
`the_signed_only_denylist_names_plan_admitted_and_run_started`; any future
native `run_started` emitter must derive `git_head` itself rather than accept it
from a request. This carries the same weight as the no-consumer-before-S4
constraint above.

### Protected promotion-decision and execution client

Promotion-decision recovery uses a separate fixed protected client. Install
`buildplane-authority-client` as the exact
root-owned regular file
`/usr/libexec/buildplane/buildplane-authority-client`, mode `0755`, with one
link. `/usr`, `/usr/libexec`, and `/usr/libexec/buildplane` must each be
root-owned exact `0755`. The CLI does not consult `PATH`,
`BUILDPLANE_NATIVE_BIN`, a workspace build, an environment variable, or a
caller option for this binary.

Provision the client-readable identity pin at the fixed path
`/etc/buildplane/authority-host/promotion-decision-client-v1.json`. Its parent
directories must be root-owned exact `0755`; the file must be root-owned,
regular, single-link, and exact `0644`. Its closed contents are:

```json
{
  "schema_version": 1,
  "listener_creator_uid": 0,
  "socket_group_gid": 992,
  "broker_identity_public_key": [
    83, 71, 9, 98, 85, 138, 110, 8,
    57, 2, 42, 230, 92, 107, 39, 35,
    179, 39, 114, 229, 192, 197, 244, 119,
    108, 184, 230, 163, 225, 11, 162, 243
  ]
}
```

Provision an independently reviewed pin with the same closed schema at
`/etc/buildplane/authority-host/promotion-execution-client-v1.json`. It must
bind the root-created execution listener and the execution host's kernel
response key. The no-authority client selects this second fixed config and
socket only for the closed
`{"operation":"execute_promotion","promotion_decision_event_id":"..."}` input.
It cannot accept a path, Git ref, candidate, lease, command, signer, or policy.

`listener_creator_uid` must be exactly `0`, because systemd creates the
listening socket as root before the non-root broker accepts it.
`socket_group_gid` is the GID of `buildplane-operator`.
`broker_identity_public_key` is the exact 32-byte Ed25519 public key for the
host config's kernel signer; the illustrative bytes above must be replaced
with the deployment key. Provisioning must reject a client pin that does not
match that protected host identity. Unknown fields, symlinks, unsafe ownership
or modes, a changed socket inode, or a connected listener whose Linux
`SO_PEERCRED` UID does not match `listener_creator_uid` blocks the request.
The native client also verifies that it is executing the exact installed
root-owned file before reading stdin.

Use only a canonical lower-case hyphenated promotion-approval request event
UUID:

```sh
buildplane run \
  --resume 123e4567-e89b-12d3-a456-426614174001 \
  --approve \
  --decision promote \
  --json
```

The client generates a fresh correlation UUID and sends one bounded request to
the fixed authority socket. The host returns a closed, canonical response
signed under the domain
`buildplane.protected-promotion-decision.response.v2`. The signature binds the
protocol and domain versions, fresh request UUID, approval event UUID, operator
decision, exact response status, and the resulting promotion-decision event
UUID when sealed. The client does not interpret `sealed` or
`reconciliation_required` or expose a decision event UUID until the pinned key
verifies that signature and all request bindings match. A replayed, substituted,
unsigned, noncanonical, or wrong-key response is blocked.

A verified `sealed` response means only that the decision was recorded and
kernel-sealed and identifies the exact decision event eligible for the
separately confined promotion-execution endpoint. A verified
`reconciliation_required` response contains no decision identity. Missing
response, timeout, malformed response, missing installation/config/socket, or
unsupported platform remains blocked. Do not automatically resubmit after a
lost or unknown response; use the same durable approval event only after
operator-led reconciliation.

## Recovery protocol

1. Preserve the opaque host recovery reference and do not submit a replacement
   packet, envelope, or idempotency key.
2. Verify the signed tape and checkpoint/root evidence with the host-native
   recovery path.
3. Ask the host to reconcile the recorded workflow identity.
4. Reuse only an exact, signed terminal activity or promotion result. A live
   promotion lease waits; an expired lease or unknown effect requires
   reconciliation and must not issue a replacement merge.
5. A signed `promote` decision without its exact result is
   `reconciliation_required`, never permission to repeat a merge.
6. If the target base changed, mark the candidate stale and regenerate or
   revalidate it. Never force a merge against the changed branch.

If the host authority, signed tape verification, OCI proof, or native Git
observer is unavailable, leave the workflow blocked. Do not infer completion
from a worker message, a worktree diff, a local SQLite projection, or a
checkpoint alone.

## GA activation checklist

The following are release gates, not optional hardening:

- OS-authenticated, worker-inaccessible authority broker with protected signing
  keys and tape/CAS access.
- Rootless OCI execution on Linux/WSL with read-only base, narrow overlay,
  scrubbed environment, resource limits, no default network, and brokered
  secrets. **This requires a Podman that provides `--no-hostname`** — see the
  version floor under "Protected-host checkout prerequisite" below. The
  governed-session host runs `attest_rootless_oci_v1` inside its startup
  composition, so an insufficient Podman blocks that host with an opaque
  `startup_failed` and no further diagnostic.
- Native candidate-view issuer for reviewer/adversary/judge roles and a
  credential-holding Anthropic/OpenAI provider gateway with typed tools and
  strict outputs.
- Native decision-bound Git promotion executor with target-base observation,
  compare-and-swap merge, signed result recording, and crash reconciliation.
- Governed checkpoint cadence/finalization and durable candidate lookup or an
  explicitly bounded verified scan.
- Crash-injection evidence for every write-ahead/result boundary, including
  duplicate delivery and crash-after-merge cases.
- Held-out 30-task, three-trial campaign across every provider named by the
  pinned release policy — `anthropic` is the only one the gate requires, since
  it is the only provider with a real adapter — and each trust tier, meeting
  the Trust Spine release gate with no unauthorized or duplicated effects and
  no false approvals.

Until every item is verified, Buildplane is in containment/pre-GA mode. The
existing preview and replay surfaces remain valuable diagnostics but do not
provide governed execution authority.

## Fail-closed GA activation and release handoff

Treat this as one gate: an unavailable, unsigned, unpinned, stale, or
unverifiable input means **block**, not a manual exception or a raw-lane
substitute.

### Enforcement already implemented

- The governed CLI does not invoke legacy JavaScript `openSession` or `admit`
  candidate/admission callbacks. Those structural callbacks would hand an
  untrusted host a writable checkout. Candidate and recovery sessions use only
  a broker minted after the fixed native client proves the protected host
  protocol; structurally similar JavaScript objects are rejected before the
  target checkout is passed to them.
- A governed host must own the capability, trusted-tape projection, opaque
  recovery identity, and rootless OCI action plane. Missing native authority,
  signed-tape/root proof, or OCI feasibility blocks before worker execution;
  there is no host-shell, ambient-model, or generic-callback fallback.
- Candidate completion flows immediately into the protected read-only
  reviewer. The CLI verifies that the reviewer receipt binds the exact
  candidate event lineage and accepts a promotion-request reference only for
  `approve`. Rejected, abstaining, malformed, or mismatched reviews leave the
  target root unchanged and non-promotable.
- The release campaign verifier accepts only an absolute, regular,
  non-symlinked bundle and the source-controlled pinned
  `config/trust-spine-release-trust-root.json`; it has no caller-selected trust
  root. It verifies the host attestation, distinct root-pinned event and
  checkpoint signer roles, signed tape events and checkpoint chains, campaign
  freshness, exact release commit, canonical release ref, and the closed
  release policy before it can return ready.
- A release-landing publish is checked twice: as an early GitHub workflow
  diagnostic and again inside `pnpm release:publish`. A failed or absent
  `TRUST_SPINE_CAMPAIGN_BUNDLE` must stop publication.

### Required operator and infrastructure work

#### Protected-host checkout prerequisite

Run campaign and preflight commands from a native Linux filesystem on the
protected host (for example, `/srv/buildplane`), using Node `24.13.1` and
pnpm `10.0.0`.

**Podman version floor (verified 2026-07-29).** The rootless-OCI action plane is
pinned to the absolute path `/usr/bin/podman` and its feasibility probe requires
all nine of `--read-only`, `--network`, `--http-proxy`, `--no-hosts`,
`--no-hostname`, `--cap-drop`, `--security-opt`, `--userns`, and `--entrypoint`
to appear in `podman run --help`. Every one of those flags except
`--no-hostname` is present in Podman `4.9.3`; `--no-hostname` is not, and it is
genuinely passed by both the governed run arguments and the startup canary, so
the requirement is not merely a capability assertion.

**Consequence: the distro Podman on Ubuntu 24.04 LTS is insufficient.** `noble`,
`noble-updates`, and `noble-security` offer only `4.9.3+ds1-1ubuntu0.2`, so the
governed-session host cannot start on a stock Ubuntu 24.04 LTS host. Provision
Podman from an upstream source that supplies `--no-hostname` and confirm it
before treating OCI readiness as satisfied:

```sh
podman --version
podman unshare true                     # userns probe; must exit 0
podman run --help | grep -c -- --no-hostname   # must be >= 1
```

`podman unshare true` succeeds on `4.9.3`, so a passing userns probe alone does
not indicate readiness — check the flag explicitly.

Do not reuse `node_modules` installed from Windows or another
OS: native dependencies such as `esbuild` are platform-specific and a
cross-platform mount can prevent the preflight from starting before it can
report OCI readiness. Clone or create a Linux-native worktree and install its
dependencies on that host:

```sh
git clone <approved-buildplane-remote> /srv/buildplane
cd /srv/buildplane
corepack pnpm install --frozen-lockfile
```

Before campaign work, run the read-only preflight against the pinned root on
the protected host using its **public** host binding:

```sh
pnpm trust-spine:release-preflight -- \
  --stage host \
  --realm <realm> \
  --key-id <host-key-id> \
  --actor-id <host-actor-id> \
  --public-key-hash <sha256:host-public-key>
```

It reports whether the binding, ordinary tape signer role, checkpoint signer
role, release policy, and local rootless-OCI prerequisites are already
enrolled/proven. It does not generate keys, prove private-key custody or
protected-host separation, edit the root, or grant authority. The production
executor separately runs a bounded no-network OCI canary before it emits an
attestation.

1. Deploy a separate protected release host. It must use a distinct
   OS/hardware-backed authority boundary from workers, retain its private host
   and tape-signing keys, and expose only the native capability-bound host
   contract. It must run the required rootless OCI setup; a local file-backed
   realm, an ambient Codex/Claude shell, or a JavaScript callback is not an
   enrollment substitute.
2. Have the release-root owners enroll that host in the pinned trust root. Add
   its immutable `realm`, `keyId`, `actorId`, public-key hash, and public key to
   `trustedHosts`; add each permitted ordinary event signer independently to
   `trustedTapeSigners`, and each checkpoint signer to
   `trustedCheckpointSigners`. These signer roles are intentionally separate:
   an event signer cannot issue a checkpoint. Use separate protected key
   custody for host attestation, event signing, and checkpoint signing, rotate
   through the same root-owner process, and never give a worker or release
   runner authority to rewrite this policy.
3. Keep the release policy and root under protected, independently reviewed
   ownership. The checked-in root is a pinned verifier input, not proof that
   the person changing it is authorized. GA requires an external immutable
   verifier/root process to approve the host, signer keys, policy, and any
   rotation before those exact public bindings land on the release commit.
4. Have the protected host run the held-out campaign for the exact release SHA
   and canonical release ref, then issue its signed campaign bundle with the
   referenced signed-tape exports, verified checkpoints, trial evidence, and
   release invariants. A hand-written report, a local projection, or a bundle
   assembled by the runner is not campaign evidence.
5. Provision that immutable bundle onto the GitHub release runner before the
   release gate runs, and set `TRUST_SPINE_CAMPAIGN_BUNDLE` to its absolute
   runner-local path. A GitHub variable carries a path, not the artifact bytes:
   the current workflow does not fetch, authenticate, or materialize the
   bundle. Hosted runners therefore need a separately operated immutable
   artifact-delivery step or trusted runner mount. Do not use a URL, a
   workspace-relative path, a symlink, or a mutable checkout copy.

After provisioning, run the runner-stage preflight on that exact runner before
publication. It delegates to the same pinned-root cryptographic campaign gate
that publication uses and makes no network request or artifact copy:

```sh
pnpm trust-spine:release-preflight -- \
  --stage runner \
  --bundle /protected-mount/trust-spine-campaign.json \
  --commit <exact-release-sha> \
  --ref refs/heads/main
```

The first four bullets above are code-enforced containment. The five numbered
items are remaining release-operator and infrastructure gates; satisfying only
the code checks leaves the deployment pre-GA.

### Promotion and recovery stop conditions

- Permit release publication only when the independently provisioned artifact
  verifies against the pinned root and exact release identity, and the campaign
  gate reports ready. Root/policy drift, an unrecognized host or signer,
  expired evidence, an incomplete campaign, or a non-ready result blocks
  publication and requires a new signed campaign rather than an override.
- Permit candidate promotion only through the native decision-bound executor
  after the candidate digest, acceptance, review, target base, signed decision,
  and final compare-and-swap result all agree. The release campaign does not
  authorize a manual candidate merge.
- For a partial or uncertain governed run, preserve the opaque host reference
  and use host-native recovery only. Reuse an exact signed terminal result;
  treat an unknown effect, missing result, failed root verification, or changed
  target base as reconciliation or a stale candidate. Never resubmit a packet,
  mint a replacement identity, or repeat a merge to clear the block.
