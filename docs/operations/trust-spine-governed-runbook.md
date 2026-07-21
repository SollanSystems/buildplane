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
successful governed promotion. When the GA authority host is enabled, its
native decision-bound Git executor will own that final compare-and-swap and
its durable result. The shipped CLI remains containment/pre-GA mode and does
not invoke that executor.

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
  secrets.
- Native candidate-view issuer for reviewer/adversary/judge roles and a
  credential-holding Anthropic/OpenAI provider gateway with typed tools and
  strict outputs.
- Native decision-bound Git promotion executor with target-base observation,
  compare-and-swap merge, signed result recording, and crash reconciliation.
- Governed checkpoint cadence/finalization and durable candidate lookup or an
  explicitly bounded verified scan.
- Crash-injection evidence for every write-ahead/result boundary, including
  duplicate delivery and crash-after-merge cases.
- Held-out 30-task, three-trial campaign across both GA providers and each
  trust tier, meeting the Trust Spine release gate with no unauthorized or
  duplicated effects and no false approvals.

Until every item is verified, Buildplane is in containment/pre-GA mode. The
existing preview and replay surfaces remain valuable diagnostics but do not
provide governed execution authority.

## Fail-closed GA activation and release handoff

Treat this as one gate: an unavailable, unsigned, unpinned, stale, or
unverifiable input means **block**, not a manual exception or a raw-lane
substitute.

### Enforcement already implemented

- The governed CLI does not invoke the legacy JavaScript `openSession` or
  `admit` candidate/admission callbacks. Those structural callbacks would hand
  an untrusted host a writable checkout, so they stop before invocation until a
  native capability-bound host contract is available.
- A governed host must own the capability, trusted-tape projection, opaque
  recovery identity, and rootless OCI action plane. Missing native authority,
  signed-tape/root proof, or OCI feasibility blocks before worker execution;
  there is no host-shell, ambient-model, or generic-callback fallback.
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
