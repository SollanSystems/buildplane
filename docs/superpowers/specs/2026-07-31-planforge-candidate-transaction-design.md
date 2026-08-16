# PlanForge as a candidate plus a promotion transaction

> Design spec. No implementation. Written against `main` @ `c094145`.
>
> Every claim about current behaviour below was verified by reading the file cited.
> Where a claim is reported but unverified, it is marked *(unverified)*.

## 1. Problem

PlanForge is unbuilt at the protocol level — not deployment-gated:

- `native/crates/bp-authority-broker/` contains **zero** `planforge` references.
- `apps/cli/src/governed-authority-broker-host.ts:395-404` binds `admitPlanForge` and
  `openPlanForgeCandidateSession` to a `Promise<never>` throw, and that binding is installed
  *after* a successful host probe at `:393`. Deploying and enrolling a host does not enable them.
- `planforge authorize-envelope` throws unconditionally
  (`planforge-authorize-envelope.ts:324-335` ignores all three arguments).

`buildplane run --packet <file> --approve` already drives **one** task through the full
invariant. The question this spec answers is what PlanForge adds, and how it is expressed
in terms of primitives the Trust Spine already owns.

## 2. The invariant (non-negotiable)

```
signed dispatch -> isolated execution -> frozen candidate
  -> candidate-bound acceptance -> structured review
  -> kernel-signed approval request -> operator-signed promotion decision
  -> compare-and-swap promotion
```

No option in this document permits the CLI to mint authority, hold a signer, or reach a
promotion handle.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | A plan yields **N candidates and N promotions**, admitted once | Multi-task autonomy is PlanForge's reason to exist post-Trust-Spine; a single atomic promotion is option O3 below |
| D2 | Admission grants a **bounded envelope** of standing authority | Unbounded execution grants are what the Trust Spine exists to prevent |
| D3 | `dependsOn` chains; independent tasks execute concurrently from the admitted base | Uses a roadmap field that already exists; see §6 for the cost this actually carries |
| D4 | First failure **halts the plan, retains evidence** | Returns the operator to a clean, diagnosable boundary |
| D5 | Promotions are **serial with re-cut** (option O1) | Adds no trust surface; see §7 |
| D6 | The design does **not** depend on the OCI/Podman plane | That work is deliberately deferred; depending on it would make this spec unbuildable |

## 4. What already exists

The survey that grounds this spec found the design mostly pre-modelled.

**The preauthorization seam exists and is deliberately closed.**
`CandidateApprovalV1` (`governed_session_client.rs:51-56`) has three variants:

```rust
pub(crate) enum CandidateApprovalV1 {
    OperatorRequested,
    PreauthorizationRef(String),
    PreauthorizedEnvelopeSource(String),
}
```

`open_candidate_session` rejects all but the first
(`governed_session_protected_host.rs:187-189`):

```rust
if !matches!(approval, CandidateApprovalV1::OperatorRequested) {
    return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
}
```

Immediately after, it calls `resolve_governed_v5_candidate_authority_v1` keyed on
`(run_id, packet_source)` (`:193-201`), which scans sealed V5 admissions already on the tape,
requires the dispatch window live, and errors unless **exactly one** admission binds that
packet *(sqlite.rs:9209-9268, unverified)*.

**The admission event kind exists.** `EventKind::PlanAdmitted` sits under the comment
`// PlanForge lifecycle (M2)` at `native/crates/bp-ledger/src/kind.rs:20`, with payload
`PlanAdmittedV1` (`payload/plan_lifecycle.rs:11-28`) carrying `plan_id`, `plan_digest`,
`input_digest`, `trusted_base`, `decided_by`, `decided_at`, `idempotency_key`, and
`authorized_next_step`. `PlanReceiptRecorded` (wire `plan_receipt`) follows at `kind.rs:21-22`.

**It has consumers but no producer.** `packages/kernel/src/admitted-plan-reader.ts` and the
orchestrator's `plan-not-admitted` gate both read it; `buildPlanAdmittedPayload`
(`packages/planforge/src/admit.ts:63`) is referenced only by its own test.

## 5. Architecture

**The envelope is not a new object. It is a batch of pre-minted dispatch admissions.**

Admitting a plan emits one `plan_admitted` and mints N sealed V5 dispatch admissions — one
per task — each carrying that admission's event id as its `provenance_ref`. The bounds are
then enforced by construction rather than by a new checker:

| Bound | Enforced by |
|---|---|
| Task count | Exactly N admissions exist; no further admission can appear under the plan |
| Path globs / side effects | Each envelope's capability-bundle and diff-scope digests |
| Expiry | Each admission's dispatch window |
| Target immunity | Unchanged — promotion remains separately operator-gated |

Each task then runs the **existing** `open_candidate_session` path with
`PreauthorizationRef` in place of `OperatorRequested`.

**New L0 event kinds required: zero.** `plan_admitted`, `plan_receipt`, the V5 envelope
family, and the candidate/acceptance/review/decision/promotion kinds all exist. This unlocks
a closed seam; it does not extend the tape.

### 5.1 Data flow

```
plan.md --compile--> N tasks --> plan_admitted (1)
                                      | provenance_ref
                        +-------------+-------------+
                     admission     admission     admission
                      task1         task2         task3 (dependsOn t1)
                        |             |             |
                   base=B        base=B        base=cand(t1)
                        |             |             |
              open_candidate_session (PreauthorizationRef)
                        |             |             |
                    candidate     candidate     candidate
                        |
                  acceptance --> review --> operator decision
                        |
                   CAS promote t1 --> target advances
                        |
                   t2, t3 stale --> re-admit remainder at new base
```

### 5.2 Components

| Component | Change |
|---|---|
| `packages/planforge` | `PlanForgeTask` -> packet-source derivation; topological ordering from `dependsOn` (parsed today, read nowhere — `dispatch.ts:140-141` punts it to the caller). Remains a zero-dependency leaf. |
| Caller (CLI/kernel) | Recomputes acceptance-contract and capability-bundle digests in the **trust-spine domain**. Load-bearing: see §8. |
| `bp-authority-broker` | Accept `PreauthorizationRef`, verifying the referenced `plan_admitted` is kernel-signed, unexpired, and equal to the resolved admission's `provenance_ref`. |
| Orchestrator | Make `provenance_ref` mandatory-non-empty for PlanForge dispatches — closes the fail-open at §8.2. |

## 6. The promotion constraint (the crux)

Promotion refuses a stale base (`promotion_git.rs:272-275`):

```rust
let target_head = self.resolve_target(&capability.target_ref)?;
if target_head != capability.base_commit {
    return Err(PromotionGitError::ReconciliationRequired);
}
```

and additionally requires the candidate commit to have **exactly one parent, which must be
the base** (`promotion_git.rs:332-334`):

```rust
if !has_exact_parents(&candidate.parents, &[capability.base_commit.as_str()]) {
    return Err(PromotionGitError::ReconciliationRequired);
}
```

The promotion itself builds a **merge commit** carrying the candidate's tree, then advances
`target_ref` and creates a promotion receipt ref in one atomic `update-ref` transaction.

Three consequences follow, and they are the reason this section exists:

1. **The primitive natively supports exactly one promotion per admitted base.** Once task 1
   promotes, every sibling candidate cut from that base is stale — and must be refused,
   because promoting a sibling's *tree* would revert task 1.
2. **A chained candidate is structurally unpromotable as built.** Its sole parent is
   `cand(t1)`, but the post-promotion target is a *merge* commit, never `cand(t1)` itself.
   Chaining buys speculative execution, not a promotable artifact.
3. Therefore **every task after the first promotion in a round must be re-cut** before it can
   promote. Concurrency across tasks is real, but its benefit lands in the first promotion
   round only.

This is a genuine cost, not an implementation detail. §7 is how it is paid.

## 7. Options considered

### O1 — Serial promotion with re-cut *(chosen, D5)*

Tasks execute concurrently. Promotions are serial. After each promotion, remaining candidates
are re-cut onto the new target, producing new digests that require fresh acceptance and fresh
review.

- **New L0 kinds:** 0
- **Invariant:** untouched. The promoted artifact is always exactly the reviewed artifact.
- **Fails closed:** a stale candidate is refused by the existing `target_head != base_commit`
  check; no new refusal logic is required.
- **Cost:** re-review of every not-yet-promoted candidate after each promotion. For a plan of
  N tasks this is O(N²) review work in the worst case.

**Re-cut need not re-run the model.** The prior candidate's patch can be replayed onto the new
base in a fresh workspace and re-frozen, so re-cut costs a re-verification (automated: the
acceptance checks re-run) plus a re-review. Model re-execution is only required when the patch
does not apply. This is new machinery and is scoped as a later slice, not the first one.

**How re-cut stays honest.** Re-cut needs new dispatch admissions, which superficially looks
like minting authority after admission. It is not, because **the operator is already present
at every promotion**: a promotion decision carries a re-admission of the plan remainder at the
new target. The existing identity scheme accommodates this for free —
`idempotencyKey = planforge:v0:buildplane:${normalizedTrustedBase}:${planFingerprint}`
(`preview.ts:61`), so a new base is naturally a new admission generation. One operator action,
not two, and no standing authority is created without a human.

### O2 — Ancestor-base replay mode in promotion

Permit promotion when `base_commit` is an ancestor of `target_ref`, replaying the candidate's
patch rather than imposing its tree, failing closed on conflict, and re-verifying the merged
result before the CAS.

- **New L0 kinds:** likely 1 (a signed record binding the re-verified merged result).
- **Invariant:** weakened unless the re-verification is itself signed and candidate-bound —
  the promoted tree is no longer the reviewed tree.
- **Cost:** removes the O(N²) review burden entirely, at the price of a new trust surface on
  the single most safety-critical operation in the system.

Rejected for now. Worth its own spec once O1 has proven the shape and the review cost is
measured rather than estimated.

### O3 — Atomic batch: one promotion per plan

N tasks execute into a single accumulating candidate; the target moves once, all-or-nothing.

- **New L0 kinds:** 0
- **Invariant:** holds most literally — one decision naming one immutable candidate digest.
- **Cost:** no partial progress; a late failure discards reviewed work; the operator loses
  per-task promotion granularity.

This is the option the promotion primitive was actually built for. Rejected under D1 in favour
of per-task granularity; recorded here because that trade is real and was made deliberately.

### O4 — Authoring surface only

PlanForge stays a compiler emitting one packet at a time for the existing front door.
Zero new operations, zero new kinds, and `admit`/`dispatch`/`loop` stay retired. Rejected
under D1, but it remains the cheapest honest fallback if O1's review cost proves intolerable.

### Comparison

| | O1 (chosen) | O2 | O3 | O4 |
|---|---|---|---|---|
| New L0 kinds | 0 | ~1 | 0 | 0 |
| Invariant | untouched | weakened without new binding | most literal | untouched |
| Per-task promotion | yes | yes | no | n/a |
| Unattended multi-task | yes | yes | yes | no |
| Review cost | O(N²) worst case | O(N) | O(1) | O(N) manual |
| New trust surface | none | promotion path | none | none |

## 8. Constraints discovered in code

### 8.1 Digest domains are not interchangeable

PlanForge derives an acceptance contract and digest (`acceptance-contract.ts:26-60`) using
undomained canonical-JSON sha256. The trust spine uses domain-separated, declaration-ordered
serde bytes *(trust_spine.rs:812-825, unverified)*. **No code currently connects PlanForge's
digest to an envelope's `acceptance_contract_digest`.** Because `packages/planforge` is a
zero-dependency leaf by policy, the binding must happen at the caller, and the caller must
produce the trust-spine digest. A test asserting cross-domain equality is mandatory.

### 8.2 The provenance gate currently fails open

`packages/kernel/src/orchestrator.ts` reads:

```ts
const provenanceRef = ctx.validatedPacket.provenance_ref;
if (provenanceRef) {
```

An empty `provenance_ref` skips the `plan-not-admitted` check entirely. This design depends on
that check, so making the field mandatory-non-empty for PlanForge dispatches is in scope.

### 8.3 Other constraints

- **Adding a kind is a workspace-wide change.** `bp-replay` transition matches are exhaustive
  with no wildcard; `kind.rs`, `payload/mod.rs`, and `canonicalize.rs` must stay 1:1, plus a
  hand-edited TS union and regenerated byte-stable fixtures. O1 needs none of this.
- **The plan fingerprint is frozen** and deliberately excludes task content
  (`preview.ts:26-32` forbids canonicalising it). Consequence: two plans with identical goal,
  base, and policy but *different tasks* share a `planId`. Task identity must therefore come
  from the per-task dispatch envelope digest, never from `planId`.
- **Candidate identity is keyed on the dispatch envelope digest**
  (`candidate_workspace.rs:913-918`): `candidate_id = "c-{digest_hex}"`, with
  `candidate_ref = {prefix}{candidate_id}/{run_id}/{attempt}`. N tasks therefore share one
  `run_id` and still yield N distinct candidates — **no host-config change is required for
  fan-out**, which is what makes O1 buildable without touching startup configuration.
- **The compiler drops tasks silently** when Objective, Assignee-hint, or Workspace is missing,
  or Verification-commands is empty (`parse-tasks.ts:72,99-101`). An admission built from a
  compiled plan can therefore silently omit declared work. Admission must fail loudly on drop.
- **Approval and effect vocabularies are closed**; effects are write-ahead-claimed and consumed
  once, and a post-effect record failure is reconciliation-only, never a retry signal.

## 9. First slice

**One task, preauthorized.** A plan with N=1 flows: `plan_admitted` -> one sealed V5 admission
carrying `provenance_ref` -> `open_candidate_session` with `PreauthorizationRef` -> candidate
-> acceptance -> promotion.

No chaining, no re-cut, no fan-out, no `plan_receipt`. It proves the only genuinely new thing —
that preauthorized dispatch works end to end — and every other decision here is additive on top.
Sized for one PR.

**Acceptance for the slice:**

1. `open_candidate_session` accepts `PreauthorizationRef` when the referenced `plan_admitted`
   is kernel-signed, unexpired, and matches the resolved admission's `provenance_ref`.
2. It still rejects `PreauthorizationRef` when the plan admission is absent, expired,
   unsigned, or bound to a different packet — each with its own negative test.
3. A dispatch carrying an empty `provenance_ref` is rejected rather than silently skipped.
4. PlanForge's acceptance-contract digest equals the trust-spine digest the envelope carries,
   asserted by test.
5. `scripts/verify-signed-tape.mjs` exits 0 over the resulting tape.

**Review tier:** this touches admission authority, so it is an L0 change — full four-role
ceremony per `CLAUDE.md`.

## 10. Dogfooding

The first slice is `planforge admit` doing real work through the real admission path. Buildplane
is currently **not** built using Buildplane, which falsifies its own thesis; the M6-S6 workaround
used envelope globs byte-identical to the proposal, so admission-gated self-modification has
never run on a non-rigged input. If the slice lands, the second slice should be authored as a
PlanForge plan and admitted through this path — making it the first honest instance of the tool
building itself.

## 11. Open questions for the operator

1. ~~**Who writes `dispatch_envelope_v5` + `governed_dispatch_v5_admission_recorded_v1`?**~~
   **RESOLVED — the producer must be native, by design.** Three independent enforcements:
   - `packages/ledger-client/src/emitter.ts:30-36` lists the kind in
     `CALLER_SUPPLIED_TRUST_SPINE_KINDS`, documented as kinds that "can advance governed
     authority or record an effect, so they must be issued by a dedicated native control
     rather than caller-provided JSON." The TS emitter refuses it.
   - `native/crates/bp-ledger/src/serve.rs:1658-1662` calls
     `reject_caller_supplied_authority_event` for the kind — the wire refuses it too.
   - The real writer is a **two-phase native operation**:
     `record_governed_dispatch_v5_admission_v1` (`storage/sqlite.rs:6867`) followed by
     `seal_governed_dispatch_v5_admission_v1` (`:6986`), with
     `validate_governed_dispatch_v5_admission_record_signer` (`:14645`) gating the signer.

   **Consequence for implementation:** minting N per-task admissions is Rust inside the native
   ledger/broker. It cannot be done from `packages/planforge`, from the CLI, or by emitting
   JSON over the wire. The TypeScript side derives packet sources and digests; the native side
   records and seals. Any plan that plans TS-side admission minting is wrong.
2. **Are the two broker protocols converging?** `admission_protocol.rs:19-35` carries a dead
   `admit` / `lookup_preauthorized` vocabulary alongside the live `governed_session_*` family.
   If they are meant to converge, the plan admission belongs in the former.
3. **Is `plan_admitted` the intended admission record, or M2-era vocabulary superseded by V5
   admission?** Both exist; only V5 is resolvable by the host. This spec assumes `plan_admitted`
   is the plan-level record and V5 admissions are the per-task records. Nothing in code decides
   it.
4. **What is the acceptable review cost?** O1 is O(N²) in the worst case. If that is intolerable
   at realistic plan sizes, O2 becomes the priority rather than a follow-up.
5. **Should re-cut ever re-run the model,** or fail closed when the patch does not apply?
