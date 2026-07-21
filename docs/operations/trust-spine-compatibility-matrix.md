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
| `buildplane run --packet <file> --approve` | Blocked pending protected host | No, until host capability is available | No | Deploy/enroll the protected authority host and OCI action plane; see the governed-run runbook. |
| `buildplane run --resume <opaque-ref> --approve` | Blocked host-only recovery | No local retry | No | Preserve the opaque reference and ask the protected host to reconcile the existing workflow. |
| `buildplane run --raw ...` | Explicit raw compatibility lane | Yes, legacy only | No; output is `governance: "unsafe"` | Use only for local diagnostics. Never use it to bypass a governed block. |
| `run-graph --raw`, `replay --raw`, `fork --raw`, `demo --raw` | Explicit raw compatibility lane | Varies by command | No | Treat all resulting evidence as unsafe/untrusted. |
| Raw implement-then-review strategy | Rejected | No | No | A future raw review workflow must use a shared immutable candidate view; it cannot finalize before review. |
| `planforge dry-run`, `plan`, `authorize-envelope` | Supported planning views | No | No | Use as compiler/planning inputs only. |
| `planforge admit`, `dispatch`, `resume`, `recover`, normal `loop` | Blocked pending unified transaction | No | No | Migrate only when these commands resolve the same protected workflow as `buildplane run`. |
| Legacy programmatic `runPacket` | Compatibility-only | Only explicit `trustLane: "unsafe"` | No governed receipt; auto-merge otherwise rejected | Replace with a governed host session or keep the caller explicitly raw. |

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
