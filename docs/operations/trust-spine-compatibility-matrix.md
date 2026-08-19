# Trust Spine compatibility matrix

This is the operator-facing compatibility contract for the Trust Spine. It
distinguishes a format Buildplane can *read* from one that can start a governed
effect. Readability never upgrades historical or caller-supplied data into
authority.

The governing rule is unchanged: a target branch may change only after a
candidate-bound acceptance and review, a signed promotion decision, and one
native compare-and-swap promotion result all bind the same immutable candidate.

## Execution lanes

| Surface | Current status | May execute effects? | May produce governed evidence or mutate target? | Migration / operator action |
| --- | --- | ---: | ---: | --- |
| `buildplane run --packet <file>` | Supported governed preview | No | No | Supply a complete governed source packet to validate and preview it. |
| `buildplane run --packet <file> --approve` | Fixed protected-host candidate and reviewer clients integrated; deployment gated | Only when the enrolled host proves authority and returns verified candidate and review receipts | Candidate/review evidence and an approved review's promotion-request reference; never target mutation | Deploy/enroll the protected authority host and OCI action plane; use the emitted request reference for the separate operator decision. |
| `buildplane run --resume <opaque-ref> --approve` | Fixed protected-host candidate recovery and review integrated; deployment gated | Only on a deployed protected host; never a local retry | Only the exact verified candidate/review result; never target mutation | Preserve the opaque reference and use the enrolled protected host to reconcile the existing workflow; never submit a replacement packet. |
| `buildplane run --resume <promotion-request-event> --approve --decision promote\|reject` | Protected decision and separate promotion-execution clients integrated; deployment gated | Reject records a lease-free terminal result and no Git effect; promote may enter one native replay-derived CAS | Signed decision plus a sealed rejected or completed workflow terminal; target mutation only for the exact sealed promote decision in a headless protected repository | Deploy both role-specific sockets and hosts from the protected bundle. Only signed `completed` or `rejected` is terminal; reconcile every other execution status and never resubmit blindly. |
| `buildplane run --raw ...` | Explicit raw compatibility lane | Yes, legacy only | No; output is `governance: "unsafe"` | Use only for local diagnostics. Never use it to bypass a governed block. |
| `run-graph --raw`, `replay --raw`, `fork --raw`, `demo --raw` | Explicit raw compatibility lane | Varies by command | No | Treat all resulting evidence as unsafe/untrusted. |
| Raw implement-then-review strategy | Rejected | No | No | A future raw review workflow must use a shared immutable candidate view; it cannot finalize before review. |
| `planforge dry-run`, `plan` | Supported planning views | No | No | Use as compiler/planning inputs only. |
| `planforge authorize-envelope` | Unbuilt; the command throws unconditionally | No | No | Not a planning view. `runPlanForgeAuthorizeEnvelopeCommand` ignores its arguments and throws `GOVERNED_AUTHORITY_BROKER_REQUIRED` on every invocation, on every platform, with or without an enrolled host. A V0 CLI-generated envelope is deliberately not an externally verified V3 dispatch authority. |
| `planforge admit`, `dispatch`, `resume`, `recover`, normal `loop` | Unbuilt at the protocol level | No | No | **Not deployment-gated.** The protected governed session protocol defines no PlanForge operation: `bp-authority-broker` contains no PlanForge surface at all, and the CLI broker binds `admitPlanForge` and `openPlanForgeCandidateSession` to a throw that fires *after* a successful host probe. Deploying and enrolling a protected host does not enable these commands. Enabling them requires first designing what a PlanForge task is as a candidate plus a promotion transaction, then building that on both the native and CLI sides. |
| Legacy programmatic `runPacket` | Compatibility-only | Only explicit `trustLane: "unsafe"` | No governed receipt; auto-merge otherwise rejected | Replace with a governed host session or keep the caller explicitly raw. |
| `bp web` Mission Control approval inbox — `POST /api/runs/:runId/decision` | **Retired by operator decision (2026-08-15).** Every approve/reject returns HTTP 501 `operator_decision_surface_retired` with a stated reason and applies no side effect. | No | No | **Source/dev-only; retired, fail-closed.** `operator_decision_recorded` and `run_completed` are caller-supplied authority kinds the signed protocol refuses (`reject_caller_supplied_authority_event`, `native/crates/bp-ledger/src/serve.rs:324` and `:309`), so the ledger-backed writers this route depended on could only ever throw. They are no longer default-wired: `run-cli.ts` now supplies `createRetiredOperatorDecisionPort()` / `createRetiredRunCompletionPort()` (`apps/cli/src/retired-decision-ports.ts`), whose `retired` marker makes `orchestrator.recordOperatorDecision` throw `OperatorDecisionSurfaceRetiredError` BEFORE validation, the Tier-2 emit, the Tier-1 shadow row and the side effect; the router maps that to 501 rather than the opaque 500 the denylist rejection previously produced. The surface is retired as one unit — either retired port fails the whole decision closed, so a live decision can never be emitted without a completion event it can never have. **Startup recovery is no longer recurring.** A historical decided-but-unexecuted terminal record used to re-fail on every boot: the completion emit threw, the execution marker was never written, and the record stayed in the pending feed forever. Against a retired completion port the terminal emit is skipped, so the Tier-1 side effect and its marker complete exactly once and the record leaves the feed; each such record is reported in `PendingDecisionRecovery.completionEventsSkipped` and logged at boot, so the missing signed terminal event is disclosed, never silent. **Not a repair of the write path** — no `operator_decision_recorded` or `run_completed` is emitted by any surface. Restoring a live operator-decision write path requires a dedicated native control that derives those records from trusted state (`serve.rs:246-250`); removing either kind from the denylist is not a fix, it reopens the hole the denylist exists to close. History: regressed by #281 (`a53519b`), which added this denylist and, in the same commit, deleted the three `ledger-integration` tests that had covered these writers (`operator-decision-merge`, `operator-decision-resume`, `run-completed-emit`) — neither the break nor the coverage loss was disclosed in the PR description or its changeset. Coverage: `test/ledger-integration/operator-decision-writers.test.ts` drives the REAL ledger-backed ports directly and still pins the native rejection and the empty-tape fail-closed property (it is unaffected by the default-wiring swap, and must be updated rather than deleted if this surface is ever restored); `apps/cli/test/retired-decision-ports.test.ts` pins the retired ports and the default wiring; `packages/mission-control-server/test/router.test.ts` pins the 501. |

## Packets, envelopes, and tape data

| Artifact | Read / validate | Governed admission or effect authority | Notes |
| --- | ---: | ---: | --- |
| Legacy `UnitPacket` | Yes | No | It is compiler input only. Missing role, provenance, capability, acceptance, trust scope, manifests, or preauthorization are never inferred. |
| Governed source `UnitPacket` | Yes | Only through protected host | Requires closed V1 governance fields, matching digests, supported role, provenance, and `atomic` commit mode. |
| Display `--envelope` JSON | Yes | No | It is a preview artifact; it cannot create a session, signer, activity, or promotion handle. |
| Signed `DispatchEnvelopeV3` / V4 | Yes, including replay | Only after fresh protected verification | A valid shape or digest is not a host capability. V4 additionally binds the graph declaration. |
| Historical V1 / sealed-V2 candidate and tape records | Yes | No new promotion authority | Retained for backward replay. Buildplane does not backfill or relabel historical runs. |
| Sealed-V3 candidate / activity records | Yes | Only with verified host snapshot | Candidate, acceptance, review, decision, lease, and result must remain digest-bound. |
| Local SQLite projections and checkpoints | Yes | No | Evidence storage and caches are not detached-signature or tape-root verification. |
| `plan_admitted` tape event | Yes, including replay | No | **No production writer, and no lane can create one.** Both generic-ingest lanes now refuse it before anything is persisted: signed ingest fails in `reject_caller_supplied_authority_event` with `caller_supplied_authority_event` (`native/crates/bp-ledger/src/serve.rs:312`), and unsigned ingest fails one layer down in `SqliteStore::validate_external_append`, reported by the serve loop as `storage_failure`. Reading and replaying historical events is unaffected. `createPlanAdmissionPort` remains a quarantined write surface with no production callers (operator decision 2026-08-15). Restoring a write path requires the dedicated native mint control designed in `docs/superpowers/specs/2026-08-17-plan-admitted-native-mint-control-design.md` (that design document lands in its own PR), which is **not built** — this row is its slice S1, closing the append hole ahead of the mint so the mint's exclusivity claim is never false; removing the kind from either denylist is not a fix. Coverage: `native/crates/bp-ledger/tests/plan_lifecycle.rs` pins both typed rejections and the empty tape; `test/ledger-integration/planforge-plan-admission.test.ts` pins the same wall end to end through the real emitter. Test-only exception: `SqliteStore::insert_event_bypassing_external_validation_for_tests`, gated behind `cfg(test)`/`test-support` so replay fixtures can still reconstruct historical tapes. |

## Candidates, review, and promotion

| Artifact or role | Read / inspect | Write candidate overlay | Review / verification | Promotion |
| --- | ---: | ---: | ---: | ---: |
| Implementer | Candidate overlay only | Yes, through ActionGateway | No | No |
| Reviewer, adversary, judge | Read-only candidate view | No | Yes, verification-only | No |
| Candidate role | Read-only/candidate-scoped as signed | Only as specifically signed | No | No |
| Operator authority | Decision record only | No | Approves/rejects candidate | Signs decision, not Git mutation |
| Native promotion executor | Candidate/decision evidence only | No arbitrary writes | Revalidates bindings | One private target CAS, then signed result/reconciliation |
| Generic TypeScript promotion adapter | Compatibility diagnostics only | No governed mutation | No | Explicit unsafe mode only |

`approve`, `request_changes`, `reject`, `abstain`, malformed verdicts, failed
acceptance, cancellation, a stale target base, an expired lease, or an unknown
effect all block promotion. Any candidate edit creates a new digest and
invalidates prior acceptance, review, and promotion decisions.

## Workers, tools, and integrations

| Worker or integration | Governed status | Authority boundary | Compatibility status |
| --- | --- | --- | --- |
| Anthropic/OpenAI API worker contracts | Schema and evidence contracts implemented | Protected credential-holding host plus typed ActionGateway required | Blocked until the native host issues an unforgeable model-action grant. |
| Claude Code / Codex CLI adapters | Not governed | None; ambient shells are not sandboxes | Raw-only and labelled unsafe. |
| Filesystem, process, Git actions | Typed ActionGateway contract | Rootless OCI, signed capability, sealed activity identity, and receipts | Governed gateway fails closed without a minted OCI executor. |
| Network, secret, MCP, A2A, external service actions | Reserved typed action families | Future local verified action definition plus host gateway | Denied today; no fallback to an ambient transport. |
| MCP/A2A remote metadata and artifacts | Quarantined beta foundation | Local, data-only quarantine | Tainted and `authority: "none"`; never a tool or dispatch token. |
| Skills | Quarantined shadow foundation | Future signed-tape activation decision | Content-addressed manifests remain `authority: "none"`; own declarations grant nothing. |
| Provenance memory | Shadow-only | Future verified tape projection | Evidence/claims can be stored and inspected but cannot route a governed worker. |
| Local OpenTelemetry projection | Local diagnostics only | None | Explicitly unverified; the tape remains authoritative. |

## Commit modes and failure policy

| Mode / condition | Governed behavior |
| --- | --- |
| `atomic` | The only admitted governed commit mode. |
| `incremental` or `saga` | Closed schema values but rejected with `UNSUPPORTED_COMMIT_MODE`; no authority or effect is persisted. |
| Missing authority, signed tape, sandbox, capability, or required provenance | Block before any worker starts. |
| Ledger or telemetry initialization failure | Block governed startup; telemetry loss never expands authority. |
| Unknown or post-effect crash state | Reconcile the same activity identity or remain blocked; never blindly retry. |
| Raw output | Cannot be exported as a trusted receipt, promotion proof, or routing fact. |

## Operator upgrade path

1. Start with a governed preview and correct all closed source-packet fields.
2. Deploy a separate OS/hardware-protected host with rootless OCI, protected
   authority/tape keys, CAS access, credential broker, and native recovery.
3. Enroll the host and separate event/checkpoint signing keys in the pinned
   release trust root through the independent root-owner process.
4. Use the host to run the exact candidate, acceptance, review, promotion, and
   recovery transaction. Do not substitute raw lanes, local SQLite, or a
   callback-backed JavaScript host.
5. Complete the signed 30-task, three-trial release campaign for the exact
   release commit and provision its immutable bundle to the release runner.

See [the governed-run runbook](trust-spine-governed-runbook.md) for the
operational stop conditions and recovery procedure, and
[the architecture](../architecture/trust-spine.md) for the detailed trust
boundaries.
