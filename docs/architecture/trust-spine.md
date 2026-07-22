# Trust Spine

The trust spine makes a candidate, rather than a worker's completion message,
the unit of approval. The target branch is mutable only through a promotion
decision that names one immutable candidate digest.

## Invariant

```text
signed dispatch → isolated execution → frozen candidate
  → candidate-bound acceptance → structured review
  → kernel-signed approval request → operator-signed promotion decision
  → compare-and-swap promotion
```

A reject, request-changes, abstention, invalid verdict, failed acceptance, or
stale base must leave the target `HEAD`, tree, and commit count unchanged.

## Current lanes

`buildplane run` is the governed preview/admission front door. Before it creates
the generic legacy orchestrator, it resolves an opaque capability supplied only
by a privileged host. The shipped resolver intentionally returns no capability,
so installations today render a non-executing preview and exit blocked. The CLI
does not create execution authority, a local signer, a replay resolver, a raw
worker, or a promotion handle.

If a future OS-authenticated host supplies the capability,
`run --packet <path> --approve` may pass only the original packet bytes, project
root, and `operator-requested` approval to its fresh-candidate endpoint. The
host must strict-parse and content-address the packet, obtain a fresh verified
dispatch/reducer projection, initialize the OCI action plane, persist an opaque
workflow recovery identity *before* any effect, and return only a
candidate-producing session.

Recovery is a distinct host-only endpoint:
`run --resume <opaque-reference> --approve`. It accepts no packet, envelope,
raw flag, or replacement preauthorization, so caller input cannot change the
recorded workflow, activity identity, or dispatch. A missing host, malformed
session, host failure, malformed completion receipt, or root-integrity mismatch
returns `recovery-required` with retry blocked; the CLI never retries an
unknown effect or falls back to raw execution.

### Read-only lifecycle projection

The signed native dispatch-resolution projection includes reducer-owned
`timers` and an optional `cancellation` record. TypeScript exposes those facts
only as immutable status data for blocked-resume diagnostics; they carry no
action emitter, lease, signer, or promotion handle. A scheduled timer, timer
firing, or cancellation makes the resolver refuse action recovery and activity
claim lookup until a future isolated broker reconciles the exact tape evidence.
This preserves visibility after a restart without allowing a status reader to
mint or resume an effect.

Before the CLI reports `candidate-awaiting-review`, the host must have verified
a native signed completion receipt that binds the sealed V3 candidate event,
candidate/action lineage, and tape root. The CLI then validates the receipt's
closed candidate shape, recovery identity, target branch, pre-effect base, and
an unchanged target-root snapshot. It deliberately does not treat a
TypeScript-private symbol, `kind` string, or receipt-shaped object as signature
proof. A structural `--envelope` file remains display-only and cannot create
authority.

When no host capability is available, the preview makes that distinction
machine-readable: `approval.requested`
reflects only the command-line request, while `approval.state` remains
`not-recorded`; `authorityBroker` reports
`GOVERNED_AUTHORITY_BROKER_REQUIRED`. These fields describe a blocked preview,
not a provisional admission, tape event, or execution authority.

The local SQLite projection is evidence storage, not a signature verifier. It
therefore never emits `trustedReceipt: true` by itself: even a locally complete
candidate/promotion remains blocked for publishing, memory promotion, or PR
evidence until a verified signed-tape projection is wired in.

`buildplane run --raw`, `run-graph --raw`, `run-strategy --raw`,
`replay --raw`, `fork --raw`, and `demo --raw` are legacy
development/re-execution lanes. The kernel graph and strategy APIs likewise
require an explicit `raw-legacy` lane; they do not silently select an ambient
runtime. Their output is marked `governance: unsafe` and
`trusted-receipt: false`; it
must not be used as evidence of a governed run. `buildplane ledger replay` is
the read-only tape reconstruction command.

Raw single-unit operations remain explicitly unsafe. Raw
`implement-then-review` strategies are instead rejected before graph dispatch:
the legacy implementation would have finalized the implementer before the
reviewer ran, which is not a review gate and cannot be repaired by merely
discarding separate workspaces. A future functional raw review workflow must
still use a shared immutable candidate view; it must not reintroduce
pre-review target mutation.

`planforge admit`, `dispatch`, `resume`, `recover`, and the normal `loop` are
currently blocked, rather than relabelled raw. Legacy admission could append a
locally signed, duplicable authority-looking record without sealed V3
authority; legacy execution could auto-merge an ambient Claude worker and
append signed activity/receipt events that downstream consumers would mistake
for governed evidence. `planforge dry-run`, `plan`, `authorize-envelope`, and
`loop --reset` remain available; PlanForge admission and execution return only
after they are views over the same candidate and promotion transaction as the
governed front door.
The planner also ignores legacy `plan_receipt` completion rows until they can
be correlated to that governed transaction.

The programmatic kernel keeps a compatibility execution surface for tests and
local diagnostics, but omitted or `legacy` `RunPacketOptions` now finalize as
`discard`. `auto-merge` is rejected unless the caller explicitly names
`trustLane: "unsafe"`; it remains ineligible for governed receipts. Legacy
run-level `subject: "merge"` decisions are disabled by default—including
startup recovery of mutable SQLite shadows—and exist only behind an explicit
unsafe compatibility option that neither CLI nor Mission Control enables. This
closes the former ambient `runPacket` and web-recovery target-branch merge
paths.

## Candidate transaction

The Git adapter freezes worker output under an immutable candidate ref and
records the base commit, candidate commit, tree, patch, changed-files, and
candidate digests. It never merges that ref while it is being reviewed.

For sealed V3 candidates, `CandidateCompletionRecordedV1` closes the material
ization boundary only after a fresh signed reducer projection proves the exact
candidate-create Git request, native activity claim, succeeded activity result,
terminal receipt, and sealed receipt-set entry. Its digest is bound to the
`CandidateCreatedV2` event and uses that receipt-set seal timestamp, so a
crash/retry can reconcile one immutable proof rather than inventing a new
completion time. A recovered proof with any different digest is a conflict;
missing claim/result lineage blocks rather than being inferred from a worker
message or a process-local map.

The current protected authority deployment is single-writer per governed run.
Ports in that process also serialize candidate completion by candidate-created
event ID and treat a post-append flush failure as indeterminate until tape
reconciliation. A multi-writer broker is not an enabled governed deployment
until the native ledger exposes an atomic candidate-completion append-or-resolve
operation.

For a governed candidate, deterministic acceptance executes against the frozen
commit under the exact acceptance-contract digest named by the signed dispatch.
Candidate acceptance and review are closed contracts and testable ports, not an
active CLI execution lane. The kernel still exposes closed request validation
for a candidate-bound `ReviewVerdictV1`, but its former callback-backed review
factory is now a compatibility-only fail-closed stub: an arbitrary in-process
function cannot be represented as a read-only reviewer. Governed strategy
execution likewise rejects before invoking a compatibility reviewer callback
until a native-verified reviewer dispatch, immutable candidate view, and
recorded review-evidence transaction exist.

The standalone compatibility review-session seam accepts only a closed immutable
candidate, read-only candidate view, passed acceptance record, reviewer
dispatch, and compatibility review-port field. It validates the request without
invoking or semantically inspecting that caller-controlled port, then returns
`REVIEW_PORT_UNAVAILABLE` until native OS-attested reviewer authority exists.
The separate host-owned review-session entrypoint accepts only the project root
and an opaque host-issued recovery reference. It opens the already-declared
reviewer activity through `openReviewerSession`, checks that the returned
receipt is closed and candidate-bound, and returns only frozen,
non-promotable display evidence. Candidate refs use an ASCII-only,
slash-delimited safe-segment grammar under the canonical Buildplane Git-ref
namespace; traversal-shaped, writable, networked, ambient-tool, or malformed
inputs block without calling the reviewer. Neither seam has a Git handle,
action gateway, or promotion API.

The host-owned broker now also reserves a deliberately narrower
`openReviewerSession` contract. Its caller supplies only an opaque recovery
reference and project root; it cannot select a candidate, reviewer, provider,
tool, output, receipt, or promotion decision. A real broker must re-derive the
candidate, passed acceptance, independent reviewer dispatch, manifests, and
activity identity from a fresh trusted-tape projection; mount the candidate
read-only with network and secrets disabled; and return one opaque, verified
review receipt after recording the closed V2 action and verdict evidence.
Retries resolve the same activity identity rather than starting another model
call. The shipped resolver exposes no broker, and the current native model
issuer still rejects reviewer model actions until a host can independently
attest that candidate view, so this type contract grants no review authority or
execution path by itself.

Candidate-keyed promotion receipt refs mirror that same suffix grammar under
`refs/buildplane/promotions/`; neither replay nor result recording may accept a
receipt namespace that the candidate transaction itself would reject.

The governed Git adapter intentionally exposes candidate materialization and
read-only promotion-receipt inspection only. It omits both legacy
`commitAndMergeWorkspace` and every candidate-promotion mutation method; the
kernel likewise refuses to send a sealed V3 candidate through an injected
generic workspace port, even if that port claims to be governed. A future
native decision-bound promotion executor must verify one signed decision and
all candidate/acceptance/review bindings immediately before its private target
CAS. Until then, new sealed V3 promotion is blocked, while recovery may only
inspect an existing immutable receipt and never retry the CAS.

V1 and `sealed-v2` candidate records remain readable so historical tapes can
replay, but the normal candidate-promotion API rejects them before it records a
decision or touches Git. The generic TypeScript promotion adapter is available
only through an explicitly unsafe compatibility option for local diagnostics
and tests; neither the CLI nor Mission Control enables that option.

A new sealed-V3 `promote` decision is preflighted before the public local
write-ahead sequence begins. If the pinned governed workspace boundary or the
native decision-bound executor is unavailable, the CLI records no local intent,
tape decision, receipt claim, or Git effect. A sealed-V3 `reject` decision
remains recordable because it cannot advance the target. Newly emitted signed
promotion decisions also require `authority` and `decidedBy` to name the same
actor. The structural parser remains deliberately more tolerant for historical
replay, where it never upgrades an old record into new signing authority.

The native store has a broker-private, no-CLI/no-stdin decision primitive.
It re-derives the signed V3 dispatch, candidate, completion, acceptance,
independent reviewer dispatch, review, and approval records under one immediate
SQLite transaction; it then records exactly one operator-signed decision keyed
by candidate and approval idempotency. The kernel must seal that decision with
a separately held key and a complete tape-root checkpoint. Kernel, reviewer,
and operator identities must use distinct actor identities **and distinct
public keys**.

A separate protected claim writer now derives the candidate, idempotency key,
decision reference, target/base binding, receipt namespace, and signer role
from a sealed `promote` decision. It writes and checkpoints exactly one
opaque, bounded promotion-execution lease. Only the first caller receives that
lease; duplicates observe pending, recorded, or expired recovery state. The
protected result writer requires that exact lease for every effect-bearing
terminal observation, records at most one kernel-signed result, and seals the
prefix again before returning. Both primitives are evidence-only: neither
accepts Git subprocess, path, ref, or command input, so neither can itself
mutate a target branch.

`bp-authority-broker` now privately composes a fresh
`TrustedGovernedRecoverySnapshot`, one sealed promotion-execution claim, the
unexported Linux-only fixed-Git gateway, and one terminal result record in the
same broker-owned call frame. An existing claim, an expired lease, an invalid
claim-to-snapshot binding, or any uncertainty after Git is
`reconciliation_required`; none can re-enter Git. The gateway has a
startup-pinned repository root, fixed `/usr/bin/git`, a scrubbed environment,
a closed operation list, and an atomic target/receipt `update-ref`
transaction. It verifies the candidate commit/tree/parents and semantic tree
digest, reuses an existing candidate receipt rather than issuing a second CAS,
and never checks out or resets the root worktree.

This component remains intentionally **not** wired to the CLI, generic ledger
server, or a production broker. OS-authenticated ownership of keys/CAS and
crash-supervised reconciliation remain mandatory before it may be used for
governed execution. The private claim and opaque lease are deliberately not
exposed by the CLI, generic ledger server, or a same-user worker interface.

Accordingly, `sealed` still means only "the durable decision is
recovery-verifiable." The final candidate and reviewer action-chain validation
remains the responsibility of `TrustedGovernedRecoverySnapshot` immediately
before any future effect. No caller may treat a SQLite projection, checkpoint,
or the private Git component alone as permission to merge. The native
foundation now records a write-ahead promotion lease, but the activated
transaction still requires a verified snapshot, one compare-and-swap Git
promotion, the signed result, and a durable executed/reconciliation marker.
Replayed or concurrent requests with the same candidate/idempotency key must
converge on one result; a changed target base is stale and must be regenerated
or revalidated.

### Read-only promotion recovery

`bp-replay` exposes promotion recovery only through a
`TrustedGovernedRecoverySnapshot`, created after purpose-authorized replay and
full signed tape-root verification. Its closed recovery query binds the run,
workflow attempt, dispatch event/digest, candidate digest, promotion decision
event/digest, and idempotency key. It has no project path, target-ref input,
worktree handle, lease, retry, or effect-issuance field.

The classifier returns evidence only. A recorded `promote` decision with no
recorded terminal result is always `reconciliation_required`, never a reason
to issue a second CAS. A recorded promoted result can be reused as immutable
evidence but does not grant mutation authority; a recorded rejection remains
terminal; and a target-advanced result remains reconciliation-required until
its exact signed resolution is present. Missing, legacy, substituted, or
malformed event digests block recovery. This intentionally leaves all Git
inspection and reconciliation inside the future native decision-bound
executor.

### Target CAS is not root-worktree completion

The Git CAS atomically creates a candidate-keyed receipt ref with the target
ref update. It deliberately does **not** reset, check out, read-tree, or
otherwise mutate the root worktree. Thus, a successful target-ref CAS proves
only that the target ref advanced to the immutable merge; it is neither a
synced root checkout nor a passed promotion/run.

Immediately after that CAS, the adapter reports its local
`pending_reconciliation` observation. The kernel must terminalize the normal
case as `reconciliation_required` with
`worktreeSyncState: "root_checkout_stale"`, even while the target ref still
equals the candidate merge. That state records that the target ref may now
resolve to the merge while the files under the root checkout still represent
the old base. The run is suspended rather than marked `promoted` or passed,
and the root worktree remains untouched.

`target_advanced` is the distinct recovery state for a target ref that has
advanced away from the recorded candidate merge after the CAS. It too produces
`reconciliation_required`, but it is not a reason to repeat the promotion CAS
or manufacture another merge. Recovery first performs a read-only inspection
of the immutable candidate-keyed receipt. A missing receipt, or a missing
governed inspector for a sealed V3 candidate, blocks recovery before it selects
any mutation-capable promotion API; recovery never synthesizes a replacement
receipt from history.

Both states keep root-worktree mutation blocked. No root-checkout
reconciliation action or operator command is implemented or exposed yet, so a
normal post-CAS promotion remains suspended. A future explicit reconciliation
path must first validate the root is clean, based on the expected commit, and
still attached to the signed target branch. A rejected promotion decision, a
historical unbound decision, or a reconciliation record without those checks
cannot create a new merge-producing result.

## Contracts and tape

The closed V1 contracts live in `@buildplane/kernel` and have additive native
ledger payloads:

- `DispatchEnvelopeV1`
- `CandidateArtifactV1`
- `CandidateCompletionRecordedV1`
- `ReviewVerdictV1`
- `PromotionApprovalRequestedV1`
- `PromotionDecisionV1`
- `PromotionExecutionClaimedV1` and `PromotionExecutionLeaseBindingV1`
- action, worker, context, attempt, and sandbox manifests

### Governed source-packet contracts

`parseUnitPacket` remains the compatibility compiler for legacy and explicit
raw inputs. It deliberately does not turn reserved metadata into authority.
`parseGovernedUnitPacket`, by contrast, accepts a closed top-level packet and
two closed nested records before any governed packet digest can be calculated:

```json
{
  "acceptance_contract": {
    "schemaVersion": 1,
    "contract_version": "v0",
    "diff_scope": { "allowed_globs": ["src/**"] },
    "checks": [{ "command": "pnpm test" }]
  },
  "trust_scope": {
    "schemaVersion": 1,
    "lane": "governed",
    "principal": "operator-or-kernel-identity",
    "scope": "repository-task-scope"
  }
}
```

Unknown fields, alternate schema versions, malformed checks, duplicate allowed
globs or checks, an unversioned trust scope, or a non-governed lane fail
admission.
The acceptance digest is calculated only from the normalized closed V1 source
contract; the full normalized packet digest separately binds both records.
The V2 graph compiler applies the same strict packet parser to every node
after removing only graph-local `dependsOn`, so it cannot sign a graph digest
over arbitrary nested governance JSON. These checks are structural admission
requirements, not a substitute for signed tape, host authority, or sandbox
verification.

`DispatchEnvelopeV1` remains readable for historical tapes, but its nested
signature reference cannot be the authoritative proof because it is part of
the signed object. New authority work uses additive `DispatchEnvelopeV2`:
`DispatchEnvelopeBodyV2` excludes both the digest and inner signature, and the
ledger calculates `sha256("buildplane.dispatch-envelope.v2\0" || canonical
body bytes)`. The exact body digest and the detached kernel event signature are
therefore non-circular. TypeScript may parse V2 only for preview; it does not
mint a digest or execution authority. V1 and V2 dispatches cannot substitute
for one another during replay, and no historical tape is reinterpreted.
The CLI accepts both its camelCase V2 proposal and the native ledger's
externally tagged snake_case `DispatchEnvelopeV2` payload for inspection, but
labels either result `verification: "structural_only"`; a preview is never a
signature, digest, or admission proof.

The native tape defines additive payloads for dispatch, candidate, candidate
acceptance, review, promotion-approval request, promotion decision/result,
reconciliation resolution, and workflow terminal events. A
`PromotionApprovalRequestedV1` is kernel-signed, candidate-bound evidence that
an operator decision is pending; it cannot mutate a target ref, and it is not
an operator-root event. The subsequent operator decision must name the exact
request event and repeat its candidate, base, target, acceptance, review, and
idempotency bindings. Recovery exposes a `promotion_approval_pending` state
only as read-only evidence; it never retries or infers a promotion. These are replay contracts, not proof that an active
CLI dispatcher emits the complete signed effect workflow. `bp-replay` consumes
these append-only events into a reducer projection only after detached event
signatures verify and an explicit authority registry grants that exact
actor/key/hash identity the required kernel, reviewer, or operator purpose.
Supplying a public key alone grants no V1 or V2 workflow authority. The default
reader keeps legacy/non-trust-spine replay readable but refuses unverified or
unauthorized workflow transitions. Existing tapes remain readable and are not
backfilled.

`WorkflowGraphDeclaredV1` is an additive, kernel-signed topology declaration
for one run, workflow, and revision. Its canonical digest binds strictly
ordered nodes, dependencies, and concurrency; invalid ordering, duplicate,
self, unknown, cyclic, digest-mismatched, or envelope-run-mismatched graphs
are rejected before public append persistence. Replay stores it in a defaulted
top-level graph projection so historical snapshots remain readable. A repeated
physical declaration is an exact-event no-op; conflicting or late declarations
become replay blockers without replacing the projection. This is intentionally
not dispatch gating yet: `DispatchEnvelopeV3` has no graph-digest binding, so
the reducer must not treat graph membership or dependencies as execution
authority.

For governed runs, effect activities are also a strict write-ahead bracket:
`activity_started` must precede a matching `activity_completed`, and a completed
result is immutable. Orphan, cross-run, or divergent duplicate completions are
recorded as replay issues and do not change the recovered activity state. This
restriction is scoped to governed dispatches so historical legacy tapes remain
readable with their original semantics.

### Retry lineage

`AttemptContextRecordedV1` is an additive, kernel-signed replay contract for a
replacement governed `sealed_v3` attempt. It does not alter
`DispatchEnvelopeV3` bytes. Instead, it names the exact next envelope and
dispatch idempotency key, the same-run prior dispatch, its failed terminal
event and canonical event digest, one failed activity/receipt pair, and an
immutable feedback artifact. The reducer accepts a governed `sealed_v3`
attempt greater than one only after it has projected that one exact context.

The context also supplies a distinct retry action namespace. Every
`ActionRequestedV2` in the replacement attempt must use both an action ID and
an idempotency key of the form `${retry_action_namespace}:<non-empty suffix>`.
This prevents a failed attempt's effect identity from being reused. Exact
replay of the same context event is idempotent; a second physical context or a
conflicting retry lineage is a replay blocker. V1, V2, and `sealed-v2` tapes
remain readable without this contract.

This is deliberately a reducer and wire-contract milestone, not activation of
live governed retries. The kernel continues to block `retry-run` for sealed V3
work until the isolated authority broker can issue the signed context and the
OCI ActionGateway/worker path can consume its namespace without reissuing an
effect from process memory.

The native `ledger governed-verifier-v1` control is a deliberately narrow
lease protocol for a future fixed read-only reviewer runner, not a generic
worker command endpoint. Its claim operation accepts only a signed reviewer
`process` action reference, an immutable target project root, and a bounded
lease. Its result operation accepts only the opaque lease and terminal
evidence. The native host derives the workspace, signer, action identity, and
idempotency key from the protected realm and signature-verified tape. A fixed
verifier claim carries an explicit signed `governed_verifier_v1` purpose; the
result endpoint rejects generic reviewer leases and rechecks the dispatch,
action, and realm chain at the original signed claim time. It does not execute
the verifier process, grant promotion authority, or make a reviewer lane
available from `buildplane run` yet.

`ledger governed-model-intent-v1 issue` is likewise a deliberately narrow,
native-only preparation control. It accepts only a run ID plus the exact signed
V3 dispatch and `ActionRequestedV2` IDs; it accepts no workspace, signer,
provider request, prompt, role, or evidence descriptor. Under the protected
host realm, it verifies the kernel-signed governed/atomic/sealed-V3
implementer action, loads the action's strict raw-CAS canonical input, and
derives the credential-free model-request and trust-scope evidence itself.
Both canonical documents are written to protected CAS, re-read by raw digest,
and semantically cross-checked against the replayed dispatch, action,
acceptance contract, manifests, and signed role before it appends exactly one
parented `ModelActionIntentV1` per action request. Reissuing that same action
returns the existing signed intent only after the tape and evidence verify
again. For a new intent, it re-samples and revalidates dispatch liveness
immediately before signing, so CAS or lock delay cannot backdate an expired
authority window. A terminal receipt, sealed receipt set, or incompatible prior model
authorization closes the action lifecycle and blocks a new intent, so native
issuance cannot append an event that the reducer would reject for ordering.
The control creates no model lease, no provider idempotency claim, no
credential exposure, and no worker execution; a later native
authorize-and-consume transaction is still required before an API worker can
run.

That later **storage primitive now exists**, but remains intentionally
host-private: `authorize_and_claim_governed_model_action_v1` accepts only the
same signed dispatch/action IDs and a bounded lease. Under one `BEGIN
IMMEDIATE` transaction it derives (or verifies) the protected-CAS intent,
creates the parented `ModelActionAuthorizedV2`, derives a stable provider
idempotency reference from the protected realm and tape identities, and
creates the explicit `governed_model_action_v1` activity lease. The intent,
V2 record, lease projection, and their detached signatures either all commit
or all roll back. Exact retries return pending/recorded/expired state without
another lease token; an orphaned V2, intent, claim, or projection blocks for
reconciliation. The corresponding native result operation resolves only the
opaque lease and permits post-expiry `unknown`, not a replacement provider
call. This primitive is not yet a CLI or stdin control and does not make a
same-user worker trustworthy: an OS-isolated broker must still hold the key
and hand the capability directly to the credential-holding provider gateway.

## Reviewer and operator signing roots

The closed `provision-governed-*-authority-v1 --confirm` parsers pin the
kernel, reviewer, and operator identities (`kernel/kernel-main`,
`reviewer/reviewer-main`, and `operator/operator-main`) without accepting a
workspace, key, path, or signer override. Their fixture implementation keeps
the parent realm/public-key binding, write-ahead provisioning state, redacted
projections, and cross-role key uniqueness checks testable.

In a production binary those commands and every local file-backed authority
load return `GOVERNED_AUTHORITY_BROKER_REQUIRED` before opening the invoking
user's authority directory. Provisioning a local 0600 file does not count as
operator authentication and must not create a usable trust root. No generic
event-append or promotion command is enabled.

Normal kernel-realm loading remains role-root optional so historical
pre-review and pre-promotion tapes stay readable. A governed resolver first
detects whether the selected run contains a reviewer verdict or an
operator-owned promotion decision/reconciliation and consults only the needed
local root. A final role key or pending provision record without its final
authority config is an incomplete transaction and blocks that role-bound run
rather than being treated as legacy. Reviewer or operator evidence without its
pinned root becomes an authority/replay blocker, never an omitted review or
promotion.
This provisions a trust root only. It does not enable a generic review-event
append path, model authorization, candidate promotion, or ambient reviewer
execution.

### Authority-isolation gate

The current file-backed realm implementation is a test primitive, not the GA
authority broker. Owner-only files under the invoking user's home directory do
not isolate a signing key from an ambient host-shell worker running as that
same user. Consequently, production code rejects the realm/provision paths;
they do **not** make raw Claude Code or Codex execution trustworthy, and they
do not enable governed worker execution or promotion.

Before a governed worker lane can leave preview/block-only mode, signing must
move behind an operator-controlled broker with a distinct OS identity (or an
equivalent hardware/OS-backed boundary), a worker-inaccessible mount and
socket, and no host shell/native authority binary in the worker environment.
The broker must hold private keys; the kernel and workers receive only closed
requests and redacted projections. This is a release gate, not a best-effort
hardening option.

## Action boundary

`ActionGateway` is an immutable per-run authorization seam for typed process
and filesystem actions. It clones capability bundles, rejects malformed action
objects before execution, treats receipt emission as observational, and denies
reviewer/adversary/judge mutations in governed mode. Governed implementer and
candidate actions additionally require a closed rootless-OCI attestation and a
separate `GovernedActionExecutor`; the gateway never constructs or falls back
to host `runCommand`/`writeFile` tools. Governed candidate execution likewise
requires a dedicated OCI/ActionGateway worker port, never the generic legacy
runtime. The legacy CLI router uses an async-scoped immutable command gateway
instead of swapping a shared executor, preventing concurrent ledger/tool
cross-wiring.

The OCI provider action plane is deliberately fail-closed: the feasibility
probe requires Linux/WSL, rootless Podman, user namespaces, read-only mounts,
network controls, dropped capabilities, and security options. The production
executor also launches a bounded, no-mount, `--pull=never` canary using the
same read-only, no-network, capability, user-namespace, resource, and scrubbed
environment baseline as an action before it emits its OCI attestation. A
runtime that merely advertises those flags but cannot launch the isolated image
is therefore blocked before worker execution. A missing probe or executor does
not permit host-shell fallback.

A governed dispatch's `maxComputeTimeMs` is enforced as one immutable absolute
deadline: `min(expiresAt, issuedAt + maxComputeTimeMs)`. The worker rejects an
expired deadline before it writes action intent, the gateway repeats the check
before it authorizes the action, and the Podman runner receives at most the
remaining time (and never more than its fixed operational cap). A retry or a
second action never receives a new budget window. Missing compute budget is
still bounded by the signed dispatch expiry.

The governed Podman argv explicitly disables proxy inheritance and host-derived
container topology (`--http-proxy=false`, `--no-hosts`, and `--no-hostname`),
and its feasibility probe rejects runtimes that lack those options. Private
read snapshots and writable overlays reject symbolic links and hard-linked
regular files, preventing an allowed workspace scope from aliasing unrelated
host content into a worker mount.

The published tools package intentionally does not export a production
rootless-OCI executor constructor. Its profile types and digest helper remain
available for manifests, but construction stays an internal host integration
detail until an OS-authenticated broker can verify dispatch/reducer state and
initialize it. This avoids treating a same-process factory call as broker
authority.

The OCI/ActionGateway implementation is not yet wired into `buildplane run`; it
is an integration seam and fail-closed feasibility boundary, not an available
governed worker lane.

`ModelActionAuthorizedV1` is now an additive native tape record. It binds one
V3 model write-ahead request to the exact dispatch, packet, canonical input,
model request, trust scope, context, policy, sandbox, role, and—when reviewing
—the immutable candidate/view. Replay requires that record and its exact
authorization reference before it accepts a successful model receipt. The
provider adapter also recomputes its domain-separated digest before it enters
the host gateway.

Before `ActionRequestedV2`, the provider worker creates a closed,
content-addressed `ModelInputEvidenceV1`. It recomputes the credential-free
model-input digest and the role/constraint-bound model-request digest from the
exact gateway request, then derives the evidence digest and CAS reference from
those values plus its redactions. A syntactically valid record for a different
request blocks before either the write-ahead action record or provider gateway.

The provider worker seals only a content-addressed `ModelResultEvidenceV1`.
Its implementer result digest is recomputed from the closed completion, and
its review result digest is recomputed from the closed candidate-bound verdict.
The evidence record also binds the action request, canonical provider request,
native authorization reference and digest; both result and evidence references
are deterministic CAS addresses derived from those digests. A substituted,
well-formed result or reference is therefore an unknown effect rather than a
successful receipt. A future native-signed evidence record remains required to
prove CAS persistence across process boundaries.

Provider effects receive the same immutable budget boundary as OCI actions.
The adapter derives `min(expiresAt, issuedAt + maxComputeTimeMs)` once from the
signed dispatch, binds that absolute deadline and the complete
prompt-plus-completion `maxTokens` allowance into the canonical gateway
request, and checks the deadline before and after the provider effect. A host
gateway must preflight the provider-specific input-token count, reserve an
output cap no greater than the signed remainder, configure the provider with
that cap, and leave receipt-persistence margin; a late response is an unknown
effect rather than a successful result. Post-response accounting alone is not
authorization. When a token budget is present, a provider response must report
both input and output token counts. Missing, malformed, or over-budget usage
is terminal failure and cannot form a candidate.

Those counts are persisted in the signed action receipt and replayed as one
checked aggregate for the sealed V3 dispatch attempt. A metered failed call
still consumes the allowance; a `model-token-usage-missing` failure blocks a
later model success because the aggregate would no longer be knowable.

Until the native authority owns transactional token reservations, it permits
exactly one provider-model intent per sealed V3 dispatch attempt. Retries reuse
that same durable action identity; an unknown result must reconcile rather than
authorize a second call. This prevents a second external effect from consuming
the same signed allowance while reservation accounting is completed.

The provider request also carries a deterministic, role-derived closed output
schema digest: implementers use `ImplementerCompletionV1`; reviewers,
adversaries, and judges use `ReviewVerdictV1`. Structured output is mandatory
at the host gateway, and the adapter parses the returned value again as an
independent receipt gate. It does not treat process health or an exit code as a
semantic approval. Model-visible tools are intentionally empty in the governed
lane today. Factory-injected capability declarations are rejected until a
future action definition is derived exclusively from the signed capability
bundle and each proposed call can become its own typed, claimed activity.

The generic TypeScript governed-evidence port is a test/compatibility seam, not
the cross-process action authority. It can serialize one process-local port but
cannot atomically reserve an action identity across fresh broker clients. GA
requires an isolated authority broker operation that reserves-or-recovers one
`ActionRequestedV2` under the ledger transaction, returns the original event
reference for an exact retry, rejects a conflicting fingerprint, and makes
duplicate historical request records block recovery rather than collapse into a
single in-memory projection.

This does not make the JavaScript adapter a signature verifier. The entire
`governed-api-worker.ts` implementation is source-internal and is not exported
from `@buildplane/adapters-models` until a usable native authority composition
surface exists. Its model-authority resolver is likewise an internal
host-composition seam only, and the CLI does not construct it. A generic
`ledger serve --sign` process signs caller-supplied events but cannot validate
an existing dispatch/request or atomically resolve an existing authority.
`ledger serve-governed-v1` now opens only a realm-pinned, run-bound activity
session: it requires protected signing, rejects every caller-supplied event,
and accepts only closed claim, heartbeat, and result controls whose run ID
equals the handshake run. It is not an admission, dispatch, action-request,
candidate, review, or promotion issuer. The TypeScript launcher remains
intentionally unavailable because it cannot prove an external broker owns the
session; a realm-pinned key must not make a caller-controlled stdin stream
authoritative.
Governed API-worker execution remains blocked until an OS-isolated broker
exposes the native, same-ledger-process `resolve-or-authorize` transaction to
the credential-holding provider boundary, replays against configured trusted
kernel authorities, and hands the original signed capability directly to that
gateway. The storage primitive already appends or returns the exact V2
authority under the ledger lock and reconciles a post-lease crash as unknown;
the remaining release gate is making that capability unforgeable to ambient
same-user workers. Authority expiry bounds the governed completion: the gateway needs an effect deadline with
receipt-persistence margin plus provider-specific input preflight and an
output-token reservation before it sends a request. The adapter records an
unknown effect rather than a success if a provider response arrives at or after
expiry. The current native model-authority control endpoint explicitly returns
`trusted_replay_authority_unconfigured`; signing configuration alone cannot
turn it into an authorizer. Generic activity claims also reject `model` actions
because only the internal native transaction may mint the exact V2-bound model
lease.

The provider-effect gateway has the same nominal provenance requirement as the
command action plane. Until an isolated host composition exists, the runtime
provenance predicates reject every resolver and gateway: a frozen structural
`authorizeAndComplete` callback is not authority and cannot receive a verified
model-action grant. There is no shipped registration primitive or test-only
runtime export that callers can use to bless a gateway; focused tests mock the
module-local predicates instead. A future native host must provide an
unforgeable external capability, not reopen a JavaScript registration API.

## Redacted OpenTelemetry projection

`projectTrustedTapeToOtelV1` is a pure, local OpenTelemetry-shaped formatter
over `TrustedTapeOtelProjectionInputV1`. It structurally validates a closed
subset of caller-supplied governed-shape facts, but it does **not** open or
verify a signed tape, checkpoint chain, or provenance proof. It therefore
cannot be used as the authoritative tape export required for governed receipts.
It accepts the governed shape only and rejects raw labels, unknown fields,
accessors, sparse arrays, malformed identifiers, and out-of-window timestamps
before constructing a trace. The fixed output allowlist contains only IDs,
canonical digests, timestamps, counts, closed event/action/decision vocabularies,
and manifest/policy outcome identifiers. It does not accept or export prompts,
tool arguments/results, secrets, messages, reasons, artifact locations,
provider/model values, metadata, or arbitrary references.

The local formatter contains `authority: { tape: "unverified", export: "none"
}`, `buildplane.governance=governed-unverified`, and the
`buildplane.local-governed-facts-otel.v1` schema. A future native projection
must derive facts from a fully verified tape root before it may emit the
canonical authoritative schema. The signed tape remains the authority for
recovery and promotion; telemetry cannot add authority, prove a governed
receipt, or perform any I/O. The CLI's separate local inspector export is explicitly
`governance: "unsafe"`, carries `buildplane.authority=none`, and uses the
`buildplane.local-inspector-trace.v1` schema. It is a compatibility view, not
a signed-tape projection, trusted receipt, telemetry transport, or trust
boundary.

## Deliberate non-GA boundaries

The operator-facing [Trust Spine compatibility matrix](../operations/trust-spine-compatibility-matrix.md)
lists every supported, raw, historical, shadow, and deliberately blocked
surface. It is a compatibility reference, not an authority source.

The current implementation does not claim that ambient Claude Code, Codex CLI,
the legacy generic SDK model executor, or the legacy command runtime are
sandboxed. They reject packets carrying governed authority fields before
spawning a host process, delegating a raw command, or opening a provider
stream, and remain raw-only. The shipped governed CLI remains preview/block-only
until an external same-ledger authority host provisions the opaque candidate
session capability.
Network/secret/MCP/A2A effects and API-provider workers must join the same
typed action plane before they can be governed. `incremental` and `saga`
remain closed schema values but are not accepted for governed promotion.

## Provenance-grounded memory (shadow only)

The kernel now has closed, content-addressed `MemoryEvidenceV1`,
`MemoryClaimV1`, and `MemoryClaimLinkV1` contracts. An observation is stored
before a claim; claims cite immutable evidence digests and separately collected
verification digests. Link records retain support, contradiction, supersession,
and revocation relationships rather than overwriting history.

`evaluateMemoryRoutingEligibility` returns eligible only for a `verified` claim
that has active governed observations, at least one independent governed
verification source, and a non-empty promoted-outcome reference. Tainted
external content defaults to `quarantined`; it cannot become a routing fact by
being cited or by a worker's self-report. Revoked, contradicted, or superseded
claims are similarly ineligible.

This is intentionally a shadow-only foundation. It does not upgrade the legacy
memory-injection path, grant authority, or publish routing decisions. A future
governed routing integration must persist the evidence and promotion records on
the signed tape and use this eligibility projection before exposing a claim to a
worker.

## Skill supply-chain quarantine (shadow only)

`SkillManifestV1` records a closed, content-addressed skill declaration with a
publisher identity, signature-artifact digest, declared capability metadata,
repository/tool/model compatibility, deterministic-test digest, and measured
utility-report digest. Manifests are always born `quarantined`; unknown fields,
digest drift, duplicate capabilities, or malformed compatibility values fail
closed.

`evaluateSkillActivationEligibility` checks independently supplied scan and
revocation evidence plus exact compatibility, but it still returns
`authority: "none"` and `activation: "shadow-only"` for a clean skill. A
skill's own declaration never grants authority. A future native, signed-tape
projection must make any activation decision and route resulting actions through
the ActionGateway.

## Quarantined remote interchange (beta foundation)

`@buildplane/adapters-tools` now exposes a read-only MCP/A2A quarantine
boundary. `quarantineRemoteInterchange` accepts only closed plain-data wrapper
shapes, freezes the result, marks every remote artifact and action draft as
tainted/quarantined, and computes a canonical UTF-8 content digest for each
artifact. It rejects unknown fields, inherited values, accessors, symbols, and
any remote attempt to declare a role, capability, command, endpoint, or
authority.

A local verifier may turn a locally branded proposal into an
`ActionDefinition`, but only by returning the literal boolean `true`. The
result intentionally remains `authority: "none"` and
`status: "non-authoritative"`; it is a reviewed description for a future local
action definition registry, not a dispatch token or executable tool. The
adapter performs no network I/O and cannot bypass admission, the ActionGateway,
or the future tape-backed activity path.

## Live-evaluation release gate

`eval/trust-spine-release-gate.ts` is a pure report and gate for the held-out
live-model campaign. It accepts explicit trial evidence and reports `pass@1`,
`pass@3`, and `pass^3` separately for every provider/trust-tier group, along
with cost, latency, tokens, tool calls, candidate count, reviewer disagreement,
false approvals, duplicate effects, safety violations, recovery correctness,
and illegitimate success.

Raw-lane trials are counted separately and excluded from governed capability
and safety metrics. The gate requires complete three-trial coverage for each
expected provider/trust tier, one identical held-out task cohort in every
expected group, the configured task minimum (30 for the GA campaign), zero
false approvals/unauthorized effects/duplicate effects/safety violations/
illegitimate successes, 100% recovery correctness, target-branch immutability,
backward replay compatibility, no unresolved required checks, and no more than
the fixed five-point `pass@1` or `pass^3` regression from baseline (a signed
policy may be stricter, never weaker). A
missing week-2 baseline for any required provider/trust-tier group is itself a
release blocker; the gate never treats missing capability evidence as a waiver.
It is reporting logic only: actual provider calls and crash-injection evidence
must be supplied by the isolated governed host.
