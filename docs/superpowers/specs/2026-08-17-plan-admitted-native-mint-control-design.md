# The native plan-admission mint control

> Design spec. No implementation.
>
> Originally written against `main` @ `8bd971c`; **every citation below was re-verified against
> `main` @ `fe74832`** during the adversarial-repair pass. The seven intervening commits are
> dependency bumps only (`git diff --stat 8bd971c..main -- native packages apps scripts test docs
> .github` touches 8 files, all version strings), so no cited source moved.
>
> Every claim about current behaviour was verified by reading the file cited. Claims carried
> forward from prior investigation without an independent read here are marked *(reported)*.
> Claims I could not establish are marked **UNVERIFIED**.
>
> Companion to `docs/superpowers/specs/2026-07-31-planforge-candidate-transaction-design.md`
> (the candidate-transaction design). That spec's §11 Q1 established that the producer must be
> native. This spec answers *what the native producer is*.

---

## 1. Problem and non-goals

### 1.1 The wall

`plan_admitted` has readers, a payload, a builder, and a gate — and no writer, **because the
protocol forbids one through the generic endpoint**:

- `reject_caller_supplied_authority_event` carries a second, signed-only denylist containing
  `EventKind::PlanAdmitted` (`native/crates/bp-ledger/src/serve.rs:312`, inside the
  `signed_append && matches!(...)` block spanning `:298-331`), applied at the single production
  call site `serve.rs:731-734` — the generic `ledger serve` stdin ingest loop.
- The comment immediately above that call site names the remedy verbatim: *"those effects must
  use a dedicated native control that replays and verifies the preceding evidence"*
  (`serve.rs:727-730`).
- The unsigned lane lands the event but cannot make it evidence:
  `scripts/verify-signed-tape.mjs` reports `[plan_admitted] -> unsigned` and exits 1
  (pinned — see §6.1). *That is today's state; S1 closes the unsigned lane too, making the wall
  total (§7 S1).*

Consequence: the candidate-transaction spec's first-slice acceptance criterion 5
(`verify-signed-tape.mjs` exits 0 over the resulting tape) is **unreachable** until this control
exists. That is recorded as the first BLOCKING obligation for the next slice at
`.loop/terminal_state.json:80` (array `:79-89`).

### 1.2 What this control is for

One thing: **turn verified state into a kernel-signed `plan_admitted` event on the tape, through a
surface that is not the generic ingest endpoint.** Everything else in PlanForge is downstream of
that and is out of scope here.

### 1.3 Non-goals (binding)

| # | Non-goal | Why |
|---|---|---|
| NG1 | **Do NOT remove `PlanAdmitted` from the signed-only denylist.** | Removing it reopens the hole the denylist exists to close: a configured append signer would again bless pipe-controlled JSON as lifecycle evidence (`serve.rs:301-307`). The mint is an *additional* surface, never a relaxation of the existing one. |
| NG2 | **Do NOT revive the quarantined TypeScript ports.** | `apps/cli/src/plan-admission-port.ts:10-39` is a quarantined write surface with no production callers (operator decision 2026-08-15, landed in #303 `e2cad50`). Its doc comment states this port "cannot reach a signed tape until one exists"; §3 recommends standing the control alongside it rather than behind it, so the quarantine holds. |
| NG3 | **The generic-ingest rejection and its executing test pin REMAIN — and may only be STRENGTHENED, never weakened.** | `test/ledger-integration/planforge-plan-admission.test.ts` (merged as #305 `8bd971c` — verified in `git log`) is the only executing check that the native rejection is still real. Test 1 (the signed-lane rejection + empty tape) stays verbatim under every slice in §7. Test 2 (the unsigned lane) is **rewritten by S1**, from *"lands unsigned"* to *"rejected on the unsigned lane too"* — a strengthening the file's own header explicitly anticipates (*"A FUTURE FIX MUST UPDATE THIS TEST, NOT DELETE IT"*, `:43-46`). See §6.1 and §7 S1. |
| NG4 | Not a general mint mechanism for the whole `REJECTED_ONLY_WHEN_SIGNED` family. | 18 kinds sit on that list (`serve.rs:1822-1841`). Generalising is a live fork, not a decision this spec takes — §8 Q5. |
| NG5 | No `plan_receipt`, no fan-out, no chaining, no re-cut. | Inherited scope discipline from the candidate-transaction spec §9. |
| NG6 | Does not tighten `OperatorRequested`. | Standing constraint — §2.4. The embargo now runs until **S5**, not S4. |

---

## 2. Authority model

### 2.1 The pattern this copies

There are two working native precedents and one reserved-but-closed one.

**The working template is the V5 dispatch admission host.** Its caller-controlled request surface
is three fields — `{ request_id, run_id, v5_envelope_digest }`
(`native/crates/bp-authority-broker/src/v5_dispatch_admission.rs:35-39`) — and its module doc
states the principle exactly: *"The caller names only a run and the canonical digest of an
already-signed V5 source dispatch. The protected ledger resolves exactly one source event,
re-derives every graph and manifest witness, records the separate host admission receipt, and
seals its exact tape prefix"* (`v5_dispatch_admission.rs:1-8`). It runs behind:

- a dedicated binary, `src/bin/buildplane-v5-dispatch-admission-host.rs`;
- a dedicated socket, `/run/buildplane/authority-host/v5-dispatch-admission-v1.sock`, on
  inherited listener FD 3 (`v5_admission_host.rs:3-5`);
- `BrokerAuthorityRoleV1::DispatchAdmission` (`confinement.rs:48-53` — whose own doc comment
  states *"Adding a broker endpoint requires extending this enum and explicitly configuring its
  worker identity boundary at host startup"*, `:43-46`);
- an injected-seam composition — resolver / backend / fresh-snapshot verifier as three traits,
  with every uncertain outcome collapsing to `ReconciliationRequired`
  (`dispatch_admission.rs:76-160`; disposition enum at `:41-44`).

**The live-proven authentication boundary is the promotion-decision socket:** SO_PEERCRED role
verification runs *before any frame bytes are read* — the peer check is the first operation inside
the bounded-frame read closure (`promotion_decision_handler.rs:161-179`, driven from `:125-155`,
rationale at `:118-123`), over a closed `#[serde(deny_unknown_fields)]` wire struct
(`promotion_decision_handler.rs:51-57`), with negative controls proven live in
`docs/operations/2026-07-29-trust-spine-first-live-host-roundtrip-receipt.md:79-81` *(reported)*.

**The counter-example to avoid** is `ControlMessage::ResolveOrAuthorizeModelActionV1`
(`serve.rs:151-169`): a fully reserved control whose runtime behaviour is an unconditional typed
rejection, `trusted_replay_authority_unconfigured` (`serve.rs:1222-1237`, invoked at `:776-782`),
because `SigningConfig` supplies an append signer but not independently configured trusted keys or
Kernel role bindings. Its doc comment is the best available statement of what a mint control needs
to be safe.

### 2.2 Who may cause a mint

**Recommended:** an OS-authenticated local peer, authenticated by SO_PEERCRED against a closed uid
allowlist for a new role, `BrokerAuthorityRoleV1::PlanAdmission`, on its own socket. Not an
operator token; not "whoever can run the CLI".

Rationale — the three candidate trust models, and why the OS boundary is the only one already
proven:

| Model | Status today |
|---|---|
| **Host enrollment (OS identity)** | The only boundary proven live end to end (2026-07-29 receipt) *(reported)*. `confinement.rs:63-95` enumerates closed denial reasons incl. `RolePolicyMismatch` (`:75`), `UidZeroNotAllowed` (`:69`), `WorkerUidAliasesBroker` (`:71`), `BrokerUidMismatch` (`:85`). Key and ledger custody begin only from a retained authority-root descriptor, accepting no path/env/CLI override (`host_key_custody.rs:1-5`, `host_ledger_custody.rs:1-21`) *(reported)*. |
| **Operator token** | No precedent for authority minting. Not proposed. |
| **CLI trust** | Explicitly refused by the invariant: *"No option in this document permits the CLI to mint authority, hold a signer, or reach a promotion handle"* (candidate-transaction spec §2). The `ledger serve-governed-v1` verb cannot even load real key material in a non-test build — `require_isolated_authority_broker(cfg!(test))` returns `Err(GOVERNED_AUTHORITY_BROKER_REQUIRED)` whenever `cfg!(test)` is false (`bp-cli/src/governed_authority.rs:507-517`) *(reported)*. |

`decided_by` therefore stops being a caller-supplied string and becomes **the authenticated peer's
uid mapped through configured role policy**; `decided_at` becomes the control's own clock. Both are
facts the control derives, not assertions it records (§4).

### 2.3 How this makes the vacuous binding real

The binding is vacuous today. `authorize_candidate_approval_v1`'s `PreauthorizationRef` arm does
exactly two string checks (`candidate_approval.rs:56-63`): non-empty, then
`resolved.provenance_ref != *reference`. Its own doc comment (`:20-49`, read in full) says why that
is nothing: resolution enforces `packet.provenance_ref == dispatch.body.provenance_ref`
(`bp-ledger/src/storage/sqlite.rs:15331`) and that same value *becomes* `resolved.provenance_ref`
(`sqlite.rs:9253`) — so the caller satisfies the arm by echoing a value out of the `packet_source`
it must supply anyway. *"Any caller able to resolve an admission at all can always satisfy this
arm."*

Making it real takes **two** changes, landing in **two different slices**, and conflating them is
the mistake this section exists to prevent.

1. **Verify the referenced event — S4.** Load the named `plan_admitted` and verify its own detached
   signature against pinned trusted keys and an expected kernel signer. The activity-claim path
   already does exactly this with `load_verified_authority_event(conn, event_id, trusted_keys,
   expected_signer, label)` (`sqlite.rs:17959-17984`).

   Two mechanical facts about that primitive that shape S4's sizing and its tests:

   - **It is a private free function** — `fn load_verified_authority_event(conn: &Connection, …)`,
     with all 61 references confined to `sqlite.rs`. `bp-authority-broker` cannot call it. So S4 is
     **not** "call the existing primitive from `candidate_approval.rs`": it needs either a new
     `pub` surface on `SqliteStore`, or the check moved inside the `bp-ledger` resolution that
     already produces `ResolvedGovernedV5CandidateAuthorityV1` (the type
     `candidate_approval.rs:2` imports). The latter is preferable — it keeps the verified fact,
     rather than the verification capability, on the broker side.
   - **Its three failure modes are not distinctly typed.** All three return the single variant
     `LedgerError::ActivityClaimAuthorityRejected { reason }`, differentiated only by free text:
     `"{label} event is missing from the tape"` (`:17968`), `"{label} event is unsigned"`
     (`:17973`), and `"{label} event signature is not verified for the configured authority"`
     (`:17980`). Note the third message covers **both** a signer mismatch and a failed
     verification — `actor_matches(...) || verify_event_signature(...) != Verified` is one `if`
     (`:17976-17982`). So §6.2's negatives must assert on reason substrings, and *wrong-signer is
     not distinguishable from bad-signature* at either the type or the message level. Splitting
     them requires new variants, which is a change to a shared error enum — call it in the slice
     or accept the merged case explicitly.

   There is **no expiry to check.** `PlanAdmittedV1` carries `decided_at` but no validity window
   (`plan_lifecycle.rs:11-28`), and there is no plan-admission analogue of the V3 path's live
   sealed authority window (`validate_governed_dispatch`, applied at `sqlite.rs:7252-7258`). Do not
   write "unexpired" into S4's acceptance; it is not implementable from the payload.

   Checkpoint coverage *is* implementable and is an available strengthening: `fully_covering_kernel_checkpoint`
   (`sqlite.rs:24021`) is the shape, but it is typed to `GovernedPromotionAuthorityV1`, so a
   plan-admission analogue would be needed — cf. `fully_covering_governed_dispatch_v5_admission_checkpoint`
   (`sqlite.rs:21780`). Whether S4 requires coverage or only signature is §8 Q13.

   **S4 discharges BLOCKING obligation #2 (`.loop/terminal_state.json:81`) and only PARTIALLY
   discharges standing disclosure #1 (`:72`).** After S4 the reference can no longer be fabricated
   — it must name a real, kernel-signed event — but **any valid admission anywhere on the tape
   still satisfies the arm.** The caller still chooses the policy input that constrains it; the
   input is merely drawn from a smaller set. That is a narrower instance of the same
   self-declared-trust-boundary class, and §2.4's embargo therefore does **not** lift at S4.

2. **Verify the *direction* of the binding — S5.** Once a real kernel-signed `plan_admitted`
   exists, a caller can set `provenance_ref` to its event id and pass a load-and-verify check that
   proves only *"this event exists and is kernel-signed"* — never *"this plan admission authorizes
   this particular dispatch."* `PlanAdmittedV1.authorized_next_step` is a single string
   (`payload/plan_lifecycle.rs:26-27`; the sole consumer expects
   `PLANFORGE_AUTHORIZED_NEXT_STEP`), not a set of authorized identities.

   **Recommendation:** establish the linkage *by construction*, not by string comparison — the
   parent link from a per-task admission back to its plan admission must be recorded natively by
   the same control that mints both, and the approval arm must verify that natively-recorded link.
   This is the candidate-transaction spec's own data flow (that spec's §S5, spec:87-127) and it converts the
   check from "a caller-echoed string matched" to "the admission I resolved was minted under this
   plan admission."

   This is S5 in §7, and S5 is **deferred and gated on §8 Q7** (whether any production path mints
   a signed `DispatchEnvelopeV5` at all — **UNVERIFIED**). The consequence is honest and must be
   stated in the slice: **the binding stays partially vacuous, and the `OperatorRequested` embargo
   stays in force, for as long as S5 is deferred.** The "verified-but-unlinked rejected" negative
   test belongs to S5 — S4 cannot honestly assert it, because before S5 there is no natively
   recorded link for "unlinked" to mean anything against (§6.2 item 6b).

### 2.4 Standing constraint (synthesis of two sources — non-negotiable)

> **`OperatorRequested` MUST NOT be tightened until the *direction* check lands (S5) — not merely
> the signature check (S4).**

The first clause is a paraphrase synthesising two sources; neither contains that sentence verbatim,
and this heading no longer claims otherwise:

- `candidate_approval.rs:45-49`: *"This arm is safe today only because `OperatorRequested` is
  itself unconditional and strictly weaker, so this grants no capability that was not already
  reachable. **Ordering hazard:** tightening `OperatorRequested` without first landing that
  signature check would silently make this the weakest path and defeat the tightening."*
- `.loop/terminal_state.json:82`: *"MUST NOT tighten OperatorRequested before that lands: doing so
  silently makes PreauthorizationRef the weakest path and defeats the tightening."*

The second clause — extending the embargo from S4 to S5 — is this spec's own amendment, and it
supersedes the literal wording of both sources. Both were written against a one-part fix ("that
signature check"). §2.3 establishes the fix is two-part: after S4 the `PreauthorizationRef` arm is
still satisfiable by naming *any* valid signed admission, so it can still become the weakest path
the moment `OperatorRequested` is tightened. Reading the embargo as lifting at S4 would satisfy the
letter of both citations while reintroducing exactly the hazard they exist to prevent.

---

## 3. Placement: trade-space

Three placements are structurally available. **The final pick is an operator gate (§8 Q1), not a
decision this spec closes.**

### 3.1 Option A — a closed `ControlMessage` on `serve.rs`'s stdin protocol

*Shape:* a new closed control variant beside `ClaimActivityV1` (`serve.rs:184-192`), field-validated
by `validate_closed_control_fields` (`serve.rs:441-466`) before deserialization, dispatched inside
`serve_with_protocol_inner`, with `seal_governed_control_prefix` (`serve.rs:1152-1162`) bracketing
the mutation.

| Pro | Con |
|---|---|
| Closed-field validation idiom already there; the claim/heartbeat/result family is a full working request→validate→derive→sign→persist precedent. | **The surface is production-inert.** `run_serve_governed_v1` cannot load real signing material in a non-test build (`governed_authority.rs:507-517`), pinned by `governed_serve_endpoint_requires_the_protected_authority_broker` (`bp-cli/src/ledger_cli.rs:3895-3907`) *(reported)*. |
| | The trust-configuration doc comment frames its own mode as being for *"a future governed dispatch bridge"* (`serve.rs:106`, in `ActivityClaimProtocolConfig::Signed`). |
| | Building here means shipping a control whose authority boundary does not exist yet — i.e. repeating the reserved-model-action pattern. |

### 3.2 Option B — a broker control (RECOMMENDED)

*Shape:* mirror the V5 admission file set — `plan_admission.rs` (private composition, injected
seams) + `plan_admission_host.rs` (listener) + `plan_admission_client.rs` +
`plan_admission_response.rs` + `plan_admission_host_config.rs`, a
`src/bin/buildplane-plan-admission-host.rs`, socket
`/run/buildplane/authority-host/plan-admission-v1.sock` on FD 3, role
`BrokerAuthorityRoleV1::PlanAdmission`. (The V5 set is `v5_dispatch_admission.rs` +
`v5_admission_{host,client,response,host_config}.rs` — five files plus two bins, not four.)

| Pro | Con |
|---|---|
| The only boundary with a live-proven OS-authenticated caller check. | Linux-only: the confinement and host modules are `#[cfg(target_os = "linux")]` with `UnsupportedPlatform` otherwise (`confinement.rs:79-81`). PlanForge on macOS/Windows fails closed — §8 Q11. |
| Independent key and ledger custody, path/env/override-proof (`host_key_custody.rs:1-5`, `host_ledger_custody.rs:1-21`) *(reported)*. | Highest surface cost: a new bin, socket, role, config loader, and deployment step. |
| The broker already calls `SqliteStore` methods directly in-process (`provider_preflight.rs:492`, `:561`), so it never touches the generic ingest lane — NG1 and NG3 hold structurally, not by convention. | The `admission_protocol.rs` three-operation vocabulary (`admit` / `lookup_preauthorized` / `open_reviewer_session`) already exists and is partly dead (`:17-35`, body enum `:48-54`), so "which broker protocol" is itself unresolved — §8 Q6. |
| `dispatch_admission.rs`'s resolver/backend/verifier trait split is directly reusable as the composition shape. | |

### 3.3 Option C — a `bp-cli` verb

Rejected on the invariant, not on cost: a CLI verb that mints would put a signer in the CLI, which
the candidate-transaction spec §2 forbids outright, and which `governed_authority.rs:507-517`
already refuses at the key-loading layer. Retained in the trade-space only so the operator sees the
option and its refusal.

### 3.4 Recommendation

**Option B, staged.** Build the private composition first (S2) with injected seams and no transport
at all, so the mint is proven end to end against a real store and the external verifier before any
socket, role, or deployment surface exists; then land the authenticated ingress (S3). This is
exactly how the V5 admission path is factored — the strict request parser
*"deliberately contains no transport, listener, startup configuration, dispatch issuance,
credential, filesystem, or process capability"* (`admission_protocol.rs:1-9`), and the composition
*"deliberately accepts only an already parsed strict broker request … A protected host must inject
the resolver, ledger backend, and fresh trusted-replay verifier before this composition can become
part of a real authenticated broker process"* (`dispatch_admission.rs:1-8` — a **different** doc
comment; the earlier draft misattributed the first quote to both files and dropped
"dispatch issuance," from it).

The reason not to take Option A even though its idioms are cheaper: a mint control whose
authentication boundary is inert is indistinguishable, in production, from no mint control — and
the codebase already carries one of those (`serve.rs:151-169`, `:1222-1237`).

---

## 4. The verification obligation

### 4.1 The problem the phrase hides

"Replays and verifies the preceding evidence" is well-defined for every existing native control
because their evidence is **already signed, on the tape**: the V5 admission resolves a signed
`DispatchEnvelopeV5` and re-derives its witnesses (`v5_dispatch_admission.rs:1-8`); activity claim
loads and verifies signed `DispatchEnvelopeV3`/V4 + `ActionRequestedV2`
(`sqlite.rs:16420-16503`) *(reported)*; a checkpoint is derived purely from already-committed rows
(`emit_checkpoint_in_transaction`, `sqlite.rs:12828-12885`) *(reported)*.

`plan_admitted` has **no such predecessor.** Verified: `grep` for
`PlanCompiled|PlanValidated|PlanPreviewed|plan_compiled|plan_validated` over
`native/crates/bp-ledger/src/kind.rs` returns **zero** matches. The digests are computed off-tape,
in TypeScript, by **three mutually incompatible canonicalization schemes**:

| Value | Scheme | Source |
|---|---|---|
| `inputDigest` | `sha256(JSON.stringify(<plan text with CRLF→LF>))` — note: over the *JSON-quoted, JS-escaped* string, **not** raw bytes | `preview.ts:62-63` + `digest.ts:11-40` |
| `planDigest` | `sha256` over a key-sorted JSON **object graph** (the whole plan minus `receiptPreview`) | `preview.ts:118-119` |
| `idempotencyKey` | `sha256` over **insertion-order** `JSON.stringify` of a hand-ordered object, truncated to 8 hex chars, then embedded in `planforge:v0:buildplane:<trustedBase>:<fingerprint>` — with an explicit "Do not 'fix'" comment because switching to `digest()` would rotate every plan's key | `preview.ts:26-61` |

None of the three is the Rust trust-spine scheme, which is domain-separated —
`canonical_struct_digest(Some(GOVERNED_UNIT_PACKET_V1_DIGEST_DOMAIN), self)` with
`b"buildplane.governed-unit-packet.v1\0"` prepended (`payload/governed_packet.rs:16`) *(reported)*.

And `admit.ts`'s builder does not re-derive anything: it consumes `planDigest`/`inputDigest` "as
computed by preview" *(reported)*.

### 4.2 The rule

> **The control's authority basis may contain only facts the control derives itself. Every other
> field is recorded as caller-asserted and explicitly non-authoritative.**

This is the same discipline that makes the V5 admission non-vacuous, applied honestly to a feature
whose upstream is off-tape. Anything else reproduces the `PreauthorizationRef` failure at a larger
scale: a signature over values the caller chose.

### 4.3 Field-by-field obligation

| Field | Origin today | Obligation | Failure |
|---|---|---|---|
| `input_digest` | `preview.ts:62-63` | **Re-derive.** The control loads the compiled plan bytes from broker-owned CAS (§4.4) and digests the bytes *it* loaded. Caller names a content ref, never a digest value. | `PlanInputDigestMismatch` |
| `plan_id` | `preview.ts` | **Re-derive** from the loaded bytes. | `PlanInputRejected` |
| `trusted_base` | caller string (`compiled.trustedBase`) | **Re-derive** from the broker's own retained repository descriptor (cf. `promotion_repository_custody.rs`), never from the request. | `TrustedBaseMismatch` |
| `decided_by` | caller string; payload doc says "Operator identity recorded as a payload field (kernel key signs the event)" (`plan_lifecycle.rs:20-21`) | **Derive** from the SO_PEERCRED-authenticated uid via configured role policy. | `PeerRejected` |
| `decided_at` | caller string | **Derive** from the control's clock. | — |
| `idempotency_key` | 3rd scheme, must stay byte-identical (`preview.ts:26-30`) | **Record, do not trust.** The control keeps its own native idempotency identity (request-id + resolved content digest), claimed/consumed once, in its own projection row (§5.2). Reproducing the JS 8-hex fingerprint in Rust is possible but buys nothing the native identity does not. | `PlanAdmissionIdempotencyConflict` |
| `plan_digest` | object-graph digest (`preview.ts:118-119`) | **Not natively re-derivable** without porting JS object canonicalization and number formatting byte-exactly. Record as asserted; the *authority* digest is a native domain-separated digest over the control's own resolved request. See §5.4. | — |
| validation status `PASS` | TS validator (`admit.ts` fails closed on non-PASS) *(reported)* | **Advisory only.** A native control cannot verify a TypeScript validator's verdict, so it must never be an authority input. The authority basis is the authenticated operator decision plus the exact bytes. Demoting a field the current builder gates on is an operator call — §8 Q10. | — |

### 4.4 Who may write the bytes the mint reads (the CAS trust root)

Every other native control roots its content trust in a **prior signed tape event**. This one
cannot (§4.1), so its trust root is the broker-owned CAS — and that shifts the question from
"is this content authentic?" to "**who was allowed to put it there?**" The design must answer that
explicitly, because the existing custody deliberately does not:

- `load_protected_v5_cas_v1` (`host_cas_custody.rs:84-132`) accepts the CAS root only if it is a
  directory, owned by `expected_owner`, mode **exactly `0o700`**, with `nlink >= 2`
  (`validate_cas_directory_facts`, `:41-53`), opened `O_NOFOLLOW|O_DIRECTORY` relative to the
  retained authority-root descriptor and re-checked for `(dev, ino)` identity after `Cas::open`
  (`:119-126`). `expected_owner` is `startup.config().broker_uid`
  (`load_governed_session_cas_v1`, `:140-149`).
- Consequence: **the only principal that can write into that CAS is the broker uid itself** (or
  root, which `UidZeroNotAllowed` forbids as a configured identity). The mint requester cannot
  stage its own bytes — `WorkerUidAliasesBroker` (`confinement.rs:71`) forbids a worker uid from
  equalling the broker uid, so **the mint-request authentication boundary and the CAS write path
  are two different principals.**
- The custody makes **no per-object claim**: *"V5 admission currently resolves only signed inline
  tape payloads and does not dereference a CAS object. This custody therefore proves the fixed CAS
  root is present, private, descriptor-bound, and retained at startup; it deliberately makes no
  per-object integrity claim until V5 evidence names a canonical CAS reference"* (`:77-83`). No
  production path stages compiled plan bytes there today.

So the staging path is a **new surface this spec does not define**, and that is an operator gate
(§8 Q12c), not an implementation detail. What the design *does* fix is the fallback position: because
the mint digests the bytes it loaded and treats that digest as the identity (§4.3), a compromised or
mis-staged object produces a *different admission identity*, not a forged one. That is containment,
not authentication — state it as such.

### 4.5 Disposition vocabulary (fail-closed)

Mirror the existing pattern exactly. Outward: `Sealed(proof)` | `ReconciliationRequired` — every
uncertainty is reconciliation evidence, never authority (`dispatch_admission.rs:41-44`, applied
throughout `admit` at `:200-241` with the rule stated at `:197-199`; `lib.rs:287-334` for the
promotion analogue). Local
handler errors stay closed and non-disclosing: `PeerRejected` | `FrameRejected` | `RequestRejected`,
deliberately not leaking signer, storage, or reconciliation detail through the wire boundary
(`v5_dispatch_admission.rs:41-54`).

Sealing means what it already means: a kernel-signed `tape_checkpoint` whose covered prefix includes
the minted event. **The correct primitive is `SqliteStore::seal_governed_signed_prefix`**
(`sqlite.rs:3310-3325`) — note it is **`pub(crate)`**, so like `insert_event` and
`load_verified_authority_event` the broker cannot call it; only a `pub fn` inside `bp-ledger` can
(§5.2). It delegates to `seal_governed_signed_prefix_in_transaction`
(`:3350-3394`) — it computes every prefix root once, calls
`verify_governed_checkpoint_chain_for_seal` (`:3442`) to re-verify every prior checkpoint before
extending the chain, returns `AlreadySealed` when the latest checkpoint already covers the exact
prefix, and otherwise emits via `emit_checkpoint_in_transaction` (`:12828`). Its outcome type
`GovernedCheckpointSealOutcome` (`:1754`) is **`pub(crate)`** — it is not broker-facing; the
broker-facing type is a per-control disposition (see §5.2).

Correcting the earlier draft: `emit_checkpoint_for_current_signed_prefix` (`:3282`, private) and
`fully_covering_kernel_checkpoint` (`:24021`, private, typed to `GovernedPromotionAuthorityV1`) are
**not** the admission-path primitives — they are the *promotion-decision* pair, and the range the
earlier draft cited (`:7847-7955`) is `seal_governed_promotion_decision_v1`, which is their sole
call site (`:7896` and `:7919`). A plan-admission mint follows the *admission* shape
(`seal_governed_signed_prefix_in_transaction` + a kind-specific coverage check like
`fully_covering_governed_dispatch_v5_admission_checkpoint`, `:21780`), not the promotion shape.
Sealing is not a second copy of the payload.

---

## 5. Wire, storage, and digest contract

### 5.1 No new event kind is required — but a new storage API is

The guard that blocks `plan_admitted` on the wire lives **only** in the ingest loop
(`serve.rs:731-734`). The storage layer does not police it *today*:
`validate_external_append` (`sqlite.rs:3062-3096`) rejects `TapeCheckpoint` and the pair
`GovernedDispatchV5AdmissionRecordedV1` | `PromotionReconciliationResolved`, enforces per-run
monotonic ordinary ids, and canonicalizes 8 declaration kinds; `EventKind::PlanAdmitted` appears
nowhere in it. It gates **both** public append paths — `append()` (`:3022-3027`, validating at
`:3023`) and `append_signed_with_checkpoint()` (`:3194-3243`, validating at `:3207`).

S1 changes that (§5.2). After S1, the mint cannot use either public append path, and the mechanism
it must use instead is already specified by the same doc comment, for checkpoints: they are
*"minted only by `Self::emit_checkpoint`, which inserts directly through the private
`insert_event`/`insert_event_signature` and so bypasses this helper"* (`sqlite.rs:3033-3035`), and
for V5 receipts: they *"are minted only by `Self::record_governed_dispatch_v5_admission_v1` after it
re-derives raw signed V5 witness evidence"* (`:3037-3040`).

**How the V5 seal API inserts an always-blocked kind (verified — this is the pattern the mint
copies).** `record_governed_dispatch_v5_admission_v1` (`sqlite.rs:6867-6981`) never calls
`validate_external_append`. It:

1. validates its own signer against the configured authority (`:6874-6878`);
2. opens **one** `Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)` (`:6880`);
3. verifies its evidence in-transaction and requires the complete source projection (`:6881-6889`);
4. resolves idempotently against any existing record before writing (`:6891-6901` — §5.3);
5. constructs and `canonicalize`s the `Event` itself (`:6945-6953`);
6. calls **`validate_new_ordinary_event_id(&tx, &event)`** (`:6954`) — the narrow monotonic-id check
   only, substituting for that one clause of the generic validator;
7. `sign_event(...)`, then the **private free functions** `insert_event(&tx, &event)` and
   `insert_event_signature(&tx, &signature)` (`:6957-6958`) — these are module-private
   `fn`s over `&Connection` (`:25754`, `:25772`), not `SqliteStore` methods, so no external crate
   can reach them;
8. inserts the immutable projection row (`:6959`, into `insert_governed_dispatch_v5_admission` at
   `:21383`);
9. commits, advances the in-process high-water mark (`record_ordinary_append`), and returns
   `AwaitingCheckpoint`.

So the always-blocked entry and the mint **coexist by construction**: the block lives in a helper
that the dedicated `pub fn` simply does not call, while the narrow invariant the block also carried
(monotonic ids) is re-asserted directly. Nothing is bypassed silently.

The mint therefore reuses the existing `EventKind::PlanAdmitted` / `Payload::PlanAdmittedV1`. The
8-field shape (`payload/plan_lifecycle.rs:11-28`) is already fixture-pinned end to end and does not
change. `parent_event_id` is `None` (there is no predecessor kind — §4.1), matching every existing
`plan_admitted` construction site.

### 5.2 The S2 deliverable, named: a two-phase `SqliteStore` API

This is the core engineering artifact and the earlier draft never named it.

**New public surface in `native/crates/bp-ledger/src/storage/sqlite.rs`, sited beside the V5 pair:**

| Symbol | Mirrors | Role |
|---|---|---|
| `pub fn record_plan_admission_v1(&self, request, authority, signing_key, signer) -> Result<PlanAdmissionDispositionV1>` | `record_governed_dispatch_v5_admission_v1` (`:6867-6981`, ~115 lines) | Phase 1. Validates the signer against the configured authority, opens one `BEGIN IMMEDIATE`, resolves idempotently against a prior record, re-derives every §4.3 field, constructs + canonicalizes the event, `validate_new_ordinary_event_id`, signs, inserts event + signature + projection row, commits. Returns `AwaitingCheckpoint`. |
| `pub fn seal_plan_admission_v1(&self, request, authority, checkpoint_signing_key, checkpoint_signer) -> Result<PlanAdmissionDispositionV1>` | `seal_governed_dispatch_v5_admission_v1` (`:6986-7062`, ~77 lines) | Phase 2. Reloads and re-verifies the projection, short-circuits if already `sealed`, calls `seal_governed_signed_prefix` (§4.5), then requires a checkpoint that covers the *current complete* signed prefix and equals the one just sealed, then marks the projection sealed. |
| `pub enum PlanAdmissionDispositionV1 { AwaitingCheckpoint {…}, Sealed {…} }` | `GovernedDispatchV5AdmissionDispositionV1` | The broker-facing return type. `GovernedCheckpointSealOutcome` (`:1754`) is `pub(crate)` and must not leak. |

**Plus the private helpers and schema the V5 pair also needs** — this is the honest size, not "two
functions":

- ~4 private helpers mirroring `seal_governed_dispatch_v5_admission_prefix` (`:7064`),
  `mark_governed_dispatch_v5_admission_sealed` (`:7095`),
  `fully_covering_governed_dispatch_v5_admission_checkpoint` (`:21780`), and
  `resolve_existing_governed_dispatch_v5_admission` (`:21586`);
- a **new projection table + migration**, mirroring `governed_dispatch_v5_admissions`
  (`sqlite.rs:2724-2793`, doc comment `:2717-2723`): `state TEXT NOT NULL CHECK(state IN ('awaiting_checkpoint','sealed'))`,
  `UNIQUE` on the admission event id, a `BEFORE DELETE` no-delete trigger (`:2797`) and a
  seal-only update trigger (`:2803`) so the projection is append-and-advance-once;
- registration in the schema-ensure path alongside
  `ensure_governed_dispatch_admission_identity_guard_v2` (`:3012`).

**Why a new API at all, rather than reusing `append_signed_with_checkpoint`:** that path calls
`validate_external_append` (`:3207`), which S1 closes for this kind; it also cannot carry an
idempotency identity or a projection row, which is what makes the mint's exclusivity checkable
downstream (§7 S1's alternative).

### 5.3 Crash recovery and idempotency (the two-phase boundary)

The two-phase split is not stylistic. It exists so the window between "signed event durably
committed" and "checkpoint seals it" is a **named, recoverable state** rather than an undefined one.
The primitives that define it, verified:

- `append_signed_with_checkpoint`'s own doc records the shape: *"Two-transaction edge: the ordinary
  event commits in its own transaction before checkpoint emission. If checkpoint emission then
  fails … the ordinary event stays committed without its (final) checkpoint. This is recoverable —
  a later signed event for the run re-triggers emission over the still-uncheckpointed prefix — and
  never breaks per-event verification, which does not depend on checkpoints"* (`:3188-3193`).
- `seal_governed_signed_prefix`'s doc states the retry contract: *"A completed control retry
  reaches this same method, allowing a prior post-commit checkpoint failure to seal its
  already-durable authority event before another success is reported"* (`:3306-3309`).
- **Idempotency-key-first resolution** is the V3 precedent, verbatim:
  `record_governed_dispatch_admission_v1` (`:7202`) looks up
  `governed_dispatch_admission_by_idempotency` (`:7220-7224`) **before** any collision check or
  insert, and on a hit returns `resolve_existing_governed_dispatch_admission` (called at `:7225`,
  defined at `:19542`) and commits — it does not error. Only *different* identities conflict
  (`GovernedDispatchAdmissionConflict`, `:7244-7247`). The V5 variant resolves source-first
  (`:6891-6901`) with idempotency as one of three conflict probes (`:6903-6928`).
- The broker-side driver states the closed outcome set: *"Retries may resolve an existing record,
  but they can yield only `Sealed` or reconciliation"* (`lib.rs:283-286`, implemented in
  `record_then_seal`, `:287-334`).

**Required semantics for the mint:**

1. `record_plan_admission_v1` resolves **idempotency-identity-first**. A legitimate retry of the
   same request after a crash returns the existing record's disposition; it never re-inserts and
   never hard-errors. Only a *different* request reusing a claimed identity is a conflict.
2. The intermediate state is `AwaitingCheckpoint`, persisted in the projection. A retry in that
   state re-enters `seal_plan_admission_v1` and reaches `AlreadySealed` or `Emitted`, never a
   permanent stall.
3. Every uncertainty (missing projection, concurrent checkpoint changing the prefix, empty prefix)
   is `ReconciliationRequired` — never authority. Mirror
   `seal_governed_dispatch_v5_admission_v1:7054-7060`, which explicitly rejects when *"a concurrent
   checkpoint changed the sealed V5 admission prefix; reopen trusted recovery before proceeding"*.

**Reconciliation with `CLAUDE.md`'s M2 crash-recovery contract — this is a real conflict, not a
footnote.** That contract says: *"`plan_admitted` but no execution → re-dispatch without
re-approval"* and *"the tape (`events.db`) is authoritative over the storage status field."* A
committed-but-unsealed admission **is** on the tape and **will** be read by that resume rule. So an
unsealed admission would become dispatch authority without ever having been sealed. Two coherent
resolutions:

- **(a) Sealed-only authority.** The resume rule additionally requires checkpoint coverage; an
  `AwaitingCheckpoint` admission resumes as "re-approval required". This changes a documented M2
  contract and needs an operator call.
- **(b) Signed-only authority, seal buys verifiability.** Resume keeps trusting the signed event
  alone; the seal makes duplicate delivery and recovery *verifiable*, not authoritative. This is
  precisely what the V5 receipt claims of itself — *"The returned record is intentionally recovery
  evidence, not effect authority"* (`:6864-6866`), reinforced by the projection table's own comment
  *"It is not effect authority on its own"* (`:2721-2723`) and by
  `dispatch_authority_material` returning `None` for V5 (`:13443`).

**Note the asymmetry either way:** `PlanAdmittedV1`'s doc calls itself *"the dispatch authority"*
(`plan_lifecycle.rs:7-8`), whereas every existing native admission control explicitly disclaims
effect authority. This mint would be the **first** native control that mints authority rather than
recovery evidence. That is a larger claim than any precedent supports and is §8 Q12b.

### 5.4 Canonicalization (do not confuse the two schemes)

Signing bytes are the **whole typed `Event` struct serialized directly**:
`canonical_event_bytes = serde_json::to_vec(&canonicalize(event))` (`canonicalize.rs:157-160`),
so frozen field order is *Rust declaration order* — `Event` is
`id, run_id, parent_event_id, schema_version, kind, occurred_at, payload` (`event.rs:14-22`) —
with the payload externally tagged as a one-key object (`canonicalize.rs:3362`, `:3432`)
*(reported)*. This is unrelated to the alphabetical `digest.ts` scheme that produces the digest
*values* placed inside that struct (§4.1). Any new authority digest should use the Rust
domain-separated idiom with its own domain constant, mirroring `governed_packet.rs:16`.

Note `canonicalize.rs`'s `validate_event_semantics` has **no** `PlanAdmittedV1` arm — the only two
`PlanAdmitted` references there are the variant-name lookup tables *(reported)*. And
`bp-replay`'s `apply_plan_admitted` (`transitions.rs:272-285`) is a pure structural copy of all 8
fields with no verification.

Correcting the earlier draft's framing: `apply_plan_admitted` taking no `signer` parameter is **the
norm for its tier, not an anomaly.** Every same-tier sibling on `REJECTED_ONLY_WHEN_SIGNED` shares
the identical `(state, event, p)` shape — `apply_run_completed` (`:220`), `apply_run_failed`
(`:224`), `apply_unit_started` (`:228`), `apply_unit_completed` (`:233`), `apply_git_checkpoint`
(`:248`), `apply_acceptance_recorded` (`:287`), `apply_activity_started` (`:301`). Only a subset of
the *harder* `REJECTED_SIGNED_OR_UNSIGNED` tier takes `signer: Option<&ActorKeyRef>` (e.g.
`apply_context_manifest_declared_v1` `:935`, `apply_dispatch_envelope_v5` `:2349`,
`apply_activity_claimed_v1` `:2945`) — and not even all of those do
(`apply_candidate_acceptance` `:5474`, `apply_promotion_decision` `:6302` also lack it).

The conclusion survives the correction intact and is the load-bearing point: **nothing downstream
re-verifies that the admission followed from verified evidence, so the mint itself is the sole
guarantor.**

### 5.5 If a V2 payload is needed

Adding an authorized-task set or a native digest field means `PlanAdmittedV2` and the full 9-step
derivation in `CLAUDE.md` §"Adding a new event kind" (kind.rs → payload → payload/mod.rs →
`canonicalize.rs` `kind_to_variant` + `payload_variant_name` arms → Rust round-trip tests →
`pnpm ledger:gen` → **hand-edit** `packages/ledger-client/src/payload.ts` →
`pnpm ledger:gen-fixtures` → byte-stable `git diff --exit-code`), plus the whole-workspace
`cargo test --manifest-path native/Cargo.toml` (**no `-p`**) exhaustive-match gate.

**u64 hazard:** currently inert, but for a narrower reason than the earlier draft stated. Every
`PlanAdmittedV1` field is `String` (`plan_lifecycle.rs:11-28`). `PlanReceiptRecordedV1`
(`plan_lifecycle.rs:33-44`) has **three** non-`String` fields, not one: `admission_event_id:
EventId` (the `#[serde(transparent)]` UUID), `outcome: PlanReceiptOutcome` (a 3-variant
snake_case enum, `:47-54`), and `side_effects: Vec<String>`. None is an integer, so no u64 hazard
exists in the plan-lifecycle payloads today. It becomes live the moment a V2 adds a count or
sequence: map `u64 → String` in typeshare and target byte-identical digest output across Rust and
TS before signing anything.

### 5.6 Fixture regeneration

`pnpm ledger:gen-fixtures` runs `scripts/ledger/gen-fixtures.sh`, which regenerates **two**
surfaces — `packages/ledger-client/fixtures/payload-variants.json` and
`test/fixtures/signed-tape/` (via `bp-ledger-gen-signed-tape`). Only the **first** is
freshness-gated, by an explicit `git diff --exit-code` in CI (`ci.yml:36-39`); the generated TS gets
its own gate at `:41-44`. `test/fixtures/signed-tape/*` has **no equivalent diff gate**, and
`gen_signed_tape.rs` already constructs a real signed `PlanAdmitted` by calling `sign_event`
directly, bypassing serve.rs entirely (`plan_cycle_events()` `:121-203`; `main()` `:265-284`). If
the design touches that generator, close the gate in the same slice.

**Gaming hazard, and why S2's acceptance is worded as it is.** The committed fixture
`test/fixtures/signed-tape/plan-cycle/tape.json` **already contains a signed, verifiable
`plan_admitted`** (verified: 6 events — `run_started`, `plan_admitted`, `activity_started`,
`activity_completed`, `plan_receipt`, `tape_checkpoint`, all signed). So *"verify-signed-tape.mjs
exits 0 over a tape containing plan_admitted"* is **already true today** and proves nothing. S2's
criterion must therefore be scoped to a tape **exported from a real store the mint wrote to** —
never to a fixture. Separately: that `plan-cycle` fixture is referenced by **zero** tests or
scripts (`grep` for `plan-cycle` over `test/`, `scripts/`, `.github/`: no matches), so it is dead
today; `verify-signed-tape.test.ts:41-81` exercises only `valid`, `tampered`, `bad-root`, and two
in-memory mutations.

### 5.7 Closed-control shape

Whichever placement wins: the request struct is closed. Broker style is
`#[serde(deny_unknown_fields)]` on a 3-field wire struct plus canonical-UUID parsing before any
authority work (`promotion_decision_handler.rs:51-57`, `:132-141`); serve.rs style is
`validate_closed_control_fields` run *before* deserialization (`serve.rs:441-466`). The
caller-controlled surface should be no larger than V5's three fields: a request id, a run id, and
one content reference.

---

## 6. Test-surface contract

### 6.1 Pins, and exactly what each slice does to them

| File | Assertion | Disposition |
|---|---|---|
| `test/ledger-integration/planforge-plan-admission.test.ts` test 1 (`:191-225`) | signed generic ingest rejects `plan_admitted`; tape stays empty (`persistedEventKinds === []`) | **Verbatim through every slice.** `reject_caller_supplied_authority_event` fires at `serve.rs:731` *before* the append at `:745`, so S1's storage change cannot alter the error code (`caller_supplied_authority_event`) this test matches on. The mint is a different surface and under §3.4 the port is not rewired. The alternative (rewire the port, rewrite test 1 to assert success) is §8 Q9. |
| same file, test 2 (`:227-291`) | unsigned lane lands the event; `verify-signed-tape.mjs` exits 1 with `[plan_admitted] -> unsigned` | **REWRITTEN BY S1 — a strengthening, not a weakening.** The unsigned lane is `store.append(&canonical)` (`serve.rs:746`), and `append()` calls `validate_external_append` first (`:3023`). Adding `PlanAdmitted` to the always-blocked set therefore closes the unsigned lane too: the emit is rejected with `storage_failure` / `CallerSuppliedTrustSpineEvent` and nothing lands. The new assertion is *"rejected on both lanes"*, and the "no third path" property becomes total. NG3 permits exactly this. |
| `serve.rs` `disposition_table_covers_every_event_kind_exactly_once` (`:1938-1970`) and the three arrays (`:1779-1856`) | `PlanAdmitted` stays in `REJECTED_ONLY_WHEN_SIGNED` (`:1827`) | These test the wire kind-classification function only, via a synthetic event built by swapping `kind` onto a reused payload — agnostic to any port, emitter, storage validator, or mint. Zero changes required, **provided** the mint reuses the existing kind and does not move it between arrays. |
| `packages/ledger-client/test/caller-supplied-trust-spine-kinds-sync.test.ts:235-257` | `plan_admitted` is on the native signed-only list, absent from the client guard, and `emit()` must not throw | **Passes unchanged after S1, but its stated rationale stops being true.** The test's comment justifies the asymmetry as protecting *"the unsigned lane the native side deliberately keeps open"* (`:236-239`). S1 closes that lane for `plan_admitted` specifically, so S1 must update this comment (the assertions still hold — the guard is client-side and `emit()` has no signing context). This is also the strongest evidence that S1 is a **tier-model change**, not a mechanical follow-up: see §7 S1 and §8 Q12a. |
| `apps/cli/test/plan-admission-port.test.ts` *(reported)* | unit behaviour of the quarantined port over a fake emitter | NG2. Leave it. |
| `test/ledger-integration/operator-decision-writers.test.ts` (`:1-66`) *(reported)* | the same native wall for `operator_decision_recorded` / `run_completed` | Names neither `PlanAdmitted` nor the plan-admission port. Zero changes for a plan-admitted-only mint. |
| `native/crates/bp-replay/tests/planforge_cycle.rs:50-67` | builds a PlanForge replay fixture with `store.append(...).unwrap()` on `EventKind::PlanAdmitted` | **BROKEN BY S1 — must be repointed in the same PR.** This answers the earlier draft's UNVERIFIED question about which tests append a `plan_admitted` through the public API: this one, and only this one. Repoint it onto a `#[cfg(any(test, feature = "test-support"))]` internal insert helper (precedent: `seal_governed_signed_prefix_for_tests`, `sqlite.rs:3327-3344`). |
| `packages/kernel/test/admitted-plan-reader.test.ts` | reads a `plan_admitted` back through the kernel's exact-8-key parser | **UNAFFECTED.** It writes with raw `INSERT INTO events` via `node:sqlite` `DatabaseSync` (`:96`, `:111`, `:223`, `:232`), bypassing `SqliteStore` entirely. Worth recording as a fourth write path no denylist covers — test-only today, and out of scope, but not covered by S1 either. |

### 6.2 New tests required

1. **Mint round trip (S2, the criterion-5 closure):** mint through the control against a **real
   store**, export that store's tape, assert `scripts/verify-signed-tape.mjs` **exits 0**. Not a
   fixture (§5.6). The verifier is kind-agnostic — `verifyEvent` branches only on signature
   presence/algorithm/hash/key/bytes and never reads `parsed.kind` *(reported)* — so it needs no
   code change; only the tape content changes from `unsigned` to verified.
2. **Negative controls, each its own test (S2):** absent content ref; content digest mismatch;
   trusted-base mismatch; unknown wire field (closed-shape rejection); **replayed request id with a
   *different* request body** (identity conflict); non-monotonic id.
3. **Idempotent crash recovery — the POSITIVE property (S2).** Distinct from (2), and the one the
   earlier draft conflated with it. After `record_plan_admission_v1` commits and **before**
   `seal_plan_admission_v1` succeeds (inject the failure), a legitimate retry of the *same* request
   must resolve to the identical sealed evidence — `AwaitingCheckpoint` → `Sealed`, never a
   permanent conflict or stall. Assert the admission event id and digest are unchanged and that
   exactly one `plan_admitted` exists for the run. Precedents to mirror in the assertion shape:
   `resolve_existing_governed_dispatch_admission` (`sqlite.rs:19542`) and
   `GovernedCheckpointSealOutcome::AlreadySealed`.
4. **Fresh-snapshot postcondition (S2):** after the seal, reopen trusted recovery and verify the
   exact sealed evidence — cached or pre-seal snapshots insufficient
   (`dispatch_admission.rs:151-160`).
5. **Peer/role negatives (S3):** wrong uid, wrong role (`RolePolicyMismatch`), uid 0, worker uid
   aliasing broker — mirroring the N1/N5/N6 negative controls in the 2026-07-29 receipt
   *(reported)*.
6. **Approval-arm tests, split across two slices:**
   - **(a) S4 —** `PreauthorizationRef` accepted only when the referenced `plan_admitted` loads and
     verifies under the pinned trusted keys and expected kernel signer; separate negatives for
     absent and unsigned. Assert on the reason substrings from `load_verified_authority_event`
     (`:17968`, `:17973`, `:17980`), not on distinct error variants — there is only one variant
     (§2.3). **Wrong-signer and bad-signature share one message**; either add variants in this
     slice or pin the merged case and say so.
   - **(b) S5 —** `verified-but-unlinked` **rejected**. This is the case that matters, and it
     cannot be written before S5 because there is no natively recorded link for "unlinked" to be
     measured against. Any attempt to assert it in S4 would be a test of a mechanism that does not
     exist.
7. **Coverage note:** the prior "zero integration coverage on the admissible path" disclosure —
   verbatim *"ZERO INTEGRATION COVERAGE on the **new** admissible path"* (`.loop/terminal_state.json:73`;
   the earlier draft's quote dropped "new") — is now at least partly stale.
   `mod candidate_approval_integration` inside `governed_session_protected_host.rs:1848` drives
   *"the real protected host, a real file-backed sealed V5 admission, a real repository binding,
   and a real digest-bound governed packet"* (`:1840-1842`). Re-baseline against it rather than
   assuming zero.

### 6.3 How S2's round-trip is actually executed (pick one — this one)

The earlier draft asserted criterion 2 without saying who runs it. Verified constraints:

- `export_signed_tape` (`bp-ledger/src/tape_export.rs:26`) is a plain `pub fn` over a
  `&SqliteStore` + keyring root. No CLI, socket, or subprocess needed.
- **No Rust code anywhere in `native/crates` shells out to node** (`grep` for
  `Command::new("node")`: zero matches). The existing round-trip is TypeScript:
  `planforge-plan-admission.test.ts:256-287` spawns the native `ledger export-signed-tape`
  (`bp-cli/src/ledger_cli.rs:5667`) and then `process.execPath scripts/verify-signed-tape.mjs
  --fixture <dir>`.
- But S2 is a **broker-private composition with no transport** (§3.4), so no TS harness can reach
  it.

**Decision: S2's round-trip is a Rust integration test in `native/crates/bp-ledger/tests/` that
drives `record_plan_admission_v1` + `seal_plan_admission_v1` against a temp store, calls
`export_signed_tape` to write `tape.json`, then invokes `node scripts/verify-signed-tape.mjs
--fixture <dir>` via `std::process::Command`.** It must be declared to the L0 ceremony reviewers as
**the repo's first Rust-test-shells-to-node pattern**, and it must skip (not fail) with an explicit
message when `node` is absent, so a bare `cargo test` outside CI stays green.

Rejected alternatives, with reasons:

- *A `#[cfg(test-support)]` `bp-cli` driver verb so the existing TS harness drives it end to end.*
  Reuses the proven chain and adds no cross-toolchain dependency — but it puts a signing path
  behind a CLI verb, which §3.3's invariant refuses even under a `cfg`. Rejected on the invariant.
- *Hand off an exported `tape.json` artifact from a Rust test to a sibling TS test.* Requires
  cross-suite artifact ordering; fragile, and vitest and cargo do not share a run boundary.

### 6.4 Replay exhaustiveness

Reusing `EventKind::PlanAdmitted` requires **no** `bp-replay` change: `apply_plan_admitted` is a
pure structural copy (`transitions.rs:272-285`), and a mint-emitted event replays identically to a
historical one. A V2 payload adds an arm to an exhaustive `match` with no catch-all — run the whole
workspace, never `-p`.

---

## 7. Slice ladder

Each slice is one PR. Review tier per `CLAUDE.md`: anything touching the tape, signing, replay, or
digest surface is **L0 — full four-role ceremony**.

### S1 — close the in-process append hole (L0, 4-role) ← FIRST SLICE

Add `EventKind::PlanAdmitted` to `validate_external_append`'s always-blocked set
(`sqlite.rs:3066-3074`), mirroring `GovernedDispatchV5AdmissionRecordedV1`.

**Why first.** `git blame -L 3066,3074` shows `GovernedDispatchV5AdmissionRecordedV1` entered that
same list in `a53519b` — *"feat(trust): implement the transactional Trust Spine (#281)"* — the very
commit that shipped the V5 admission host. That precedent closed the append hole **atomically with
the control**. Deferring it behind the mint would leave the mint's central claim ("the
authenticated `PlanAdmission` role is the only path that can mint") materially false for the whole
intervening window, which is the same vacuous-control failure this spec exists to avoid. Because
`plan_admitted` (unlike the V5 kind) already exists with a wide-open public path, the block and the
storage API are separable here in a way they were not for V5 — so front-loading is available, and
it leaves **no** window in which the claim is false.

**This slice is NOT small or self-contained.** It has four verified consequences, all of which land
in this PR:

1. **It is a tier-model change.** `validate_external_append`'s always-blocked set today contains
   `TapeCheckpoint` plus two kinds from the *always-rejected* wire tier
   (`REJECTED_SIGNED_OR_UNSIGNED`). **No `REJECTED_ONLY_WHEN_SIGNED` kind is in it.** S1 would make
   `plan_admitted` the first signed-only-tier kind that is also storage-always-blocked — an
   asymmetry across a uniform 18-kind list. Whether that asymmetry is acceptable, or whether the
   whole tier should move, is **§8 Q12a** and must be answered before S1 lands.
2. **It rewrites `planforge-plan-admission.test.ts` test 2** from "lands unsigned" to "rejected on
   the unsigned lane too" (§6.1). A strengthening, permitted by NG3 and anticipated by the file's
   own header.
3. **It breaks `native/crates/bp-replay/tests/planforge_cycle.rs:50-67`**, the only test that
   appends a `plan_admitted` through the public API. Repoint onto a
   `#[cfg(any(test, feature = "test-support"))]` internal insert helper (precedent
   `seal_governed_signed_prefix_for_tests`, `sqlite.rs:3327-3344`).
4. **It falsifies the documented rationale** in
   `caller-supplied-trust-spine-kinds-sync.test.ts:236-239` ("the unsigned lane the native side
   deliberately keeps open"). Update that comment; the assertions still pass.

Between S1 and S2, `plan_admitted` has **zero** writers outside test support. That interval is
deliberate and costs nothing: the kind has no production writer today either — standing disclosure
#5, *"The plan_admitted writer has NO production call site. It is an unwired seam."*
(`.loop/terminal_state.json:76`).

**Honest alternative, if §8 Q12a is answered "do not break tier symmetry":** leave
`validate_external_append` untouched and make the mint's exclusivity a **projection invariant**
instead — only a `plan_admitted` with a matching row in the mint's projection table (§5.2), sealed,
counts as an admission, and S4/S5 reject any event without one. This mirrors how the V5 path
actually proves "one admission per source" and how the trust-spine evidence predicates work
generally. It does not close the append hole; it makes an unprojected append inert. Weaker, but
symmetric and non-breaking.

*Acceptance:* (1) a signed *and* an unsigned generic-ingest append of `plan_admitted` are both
rejected and nothing is persisted on either lane — note the two typed errors are **different and
must both be asserted**: the signed lane keeps `LedgerError::CallerSuppliedSignedAuthorityEvent`
from `serve.rs:327-330` (which fires at `:731`, before any append), while the unsigned lane newly
raises `LedgerError::CallerSuppliedTrustSpineEvent` from `validate_external_append`
(`sqlite.rs:3071-3073`), surfaced by the serve loop as error code `storage_failure` (`:761`);
(2) `planforge-plan-admission.test.ts` test 1 passes **unmodified**; test 2 passes with its
strengthened assertion and an updated header; (3) `planforge_cycle.rs` builds its fixture through
the test-support helper and its replay assertions are unchanged; (4)
`disposition_table_covers_every_event_kind_exactly_once` and the three wire arrays pass unmodified
(`PlanAdmitted` does not move tiers on the wire); (5) whole-workspace
`cargo test --manifest-path native/Cargo.toml` (no `-p`) green; (6) a `plan_admitted` row is added
to `docs/operations/trust-spine-compatibility-matrix.md` — verified absent today (`grep` for
`plan_admitted` over that file: zero matches).

### S2 — the mint: storage API + composition (L0, 4-role)

Two halves, one PR, because neither is testable without the other:

- **Storage API** — `record_plan_admission_v1` + `seal_plan_admission_v1` +
  `PlanAdmissionDispositionV1` + ~4 private helpers + the projection table/migration/triggers,
  exactly as specified in §5.2, with the crash/idempotency semantics of §5.3.
- **Broker-private composition** — injected resolver / backend / snapshot-verifier seams
  (`dispatch_admission.rs:76-160` as the shape), **no transport, no socket, no role, no bin, no
  config loader.** Loads plan bytes from an injected content seam, re-derives
  `input_digest` / `plan_id` / `trusted_base` per §4.3, constructs `PlanAdmittedV1` with
  `parent_event_id: None`, and returns sealed recovery evidence only.

*Acceptance:* (1) a kernel-signed `plan_admitted` lands on a **real store** via the new API, with a
matching `sealed` projection row; (2) `scripts/verify-signed-tape.mjs` **exits 0** over the tape
exported from that store — the first time PlanForge criterion 5 has ever been reachable — executed
per §6.3, and explicitly **not** satisfied by the pre-existing `plan-cycle` fixture (§5.6);
(3) every §6.2(2) negative fails closed with its named disposition; (4) the §6.2(3) idempotent
crash-recovery **positive** test passes; (5) the §6.2(4) fresh-snapshot postcondition holds;
(6) `planforge-plan-admission.test.ts` still passes with only its S1 changes; (7) whole-workspace
`cargo test` green.

### S3 — authenticated ingress (L0, 4-role)

`BrokerAuthorityRoleV1::PlanAdmission` + closed wire struct +
`src/bin/buildplane-plan-admission-host.rs` + socket
`/run/buildplane/authority-host/plan-admission-v1.sock` on FD 3 + config loader
(`plan_admission_host_config.rs`). Role verification **before any frame bytes are read**
(`promotion_decision_handler.rs:161-179`). `decided_by` now derives from the authenticated peer.

*Acceptance:* peer/role negative controls per §6.2(5); socket mode and ownership match the
promotion-decision precedent; non-Linux builds fail closed with `UnsupportedPlatform`.

### S4 — verify the referenced admission (L0, 4-role) — PARTIAL discharge

Replace `candidate_approval.rs:56-63`'s two string compares with a load-and-verify of the
referenced `plan_admitted`: it exists on the tape, it is signed, and its signer matches the
configured kernel signer with a verifying signature. Requires a new `pub` `bp-ledger` surface or
moving the check into the resolution that produces `ResolvedGovernedV5CandidateAuthorityV1` —
`load_verified_authority_event` is private to `sqlite.rs` and unreachable from the broker (§2.3).
No expiry check (there is no expiry field). Checkpoint coverage optional — §8 Q13.

Correct the module doc comment at `candidate_approval.rs:39-49`.

*Acceptance:* §6.2(6a) tests green — accepted only for a real, kernel-signed, verifying reference;
absent and unsigned rejected; assertions on reason substrings, with the merged
wrong-signer/bad-signature case either split into new variants or explicitly pinned as merged.
This discharges BLOCKING obligation #2 (`.loop/terminal_state.json:81`).

**It does NOT discharge standing disclosure #1 (`:72`), and it does NOT lift §2.4's embargo.** The
reference can no longer be fabricated, but any valid admission on the tape still satisfies the arm.
Amend the disclosure text in place to record the narrowed-but-surviving form; do not delete it.
`OperatorRequested` stays untightened.

### S5 — parent-linked per-task admissions and the direction check (L0, 4-role) — DEFERRED

The candidate-transaction spec's S5 data flow: one plan admission authorizing N per-task V5
admissions, with the linkage recorded natively by the control that mints both, and the approval arm
verifying that natively-recorded link (§2.3 item 2).

**Gated on §8 Q7** — within `bp-authority-broker`'s non-test source, `grep` finds **no** production
construction site for a signed `DispatchEnvelopeV5`; the only one is inside
`mod candidate_approval_integration` (`governed_session_protected_host.rs:2285-2302`, a test
module). Whether any production path mints one is **UNVERIFIED**.

*Acceptance:* §6.2(6b) — **`verified-but-unlinked` rejected.** Only when this lands does standing
disclosure #1 fully retire, and **only then may `OperatorRequested` be tightened** (§2.4). While
S5 is deferred, both the disclosure and the embargo remain in force — state this in S4's PR
description so the deferral cannot be mistaken for closure.

### S6 — carried obligations (L1/L3)

From `.loop/terminal_state.json:83-89`: the reader discarding every binding field
(HIGH, `admitted-plan-reader.ts:183-186`); the `EmitOptions.id` "tests only" doc conflict flagged in
`packages/kernel/src/ports.ts:900-902`; `index.ts` / `index.d.ts` set-equality drift (`index.d.ts`
is hand-maintained and git-tracked, and scoped vitest cannot catch its omissions — only
typecheck/build can); and correcting the stale claim that `plan_admitted` is "deliberately NOT in
the caller-supplied denylist."

---

## 8. Open questions for the operator

1. **Placement (§3).** Broker control (recommended, live-proven boundary, highest surface cost) vs
   a closed `serve.rs` control (cheaper idioms, production-inert boundary) vs CLI verb (refused by
   the invariant). This is the one gate that changes every later slice.
2. **Evidence basis (§4).** Content-addressed bytes with native re-derivation (recommended) vs
   porting all three JS canonicalization schemes to Rust byte-exactly vs binding caller-asserted
   digests without re-deriving them (which reproduces the vacuousness class at larger scale).
3. **Is `plan_admitted` still the intended plan-level record**, or M2-era vocabulary superseded by
   V5 admissions — the per-task record the host actually resolves? Both exist; nothing in code
   decides it (candidate-transaction spec §11 Q3, unresolved). If the answer is "retire it," this
   whole spec is the wrong target.
4. **Single kernel signer vs two-phase operator-then-kernel seal.** `PlanAdmittedV1`'s doc says the
   kernel key signs and the operator identity is a payload field (`plan_lifecycle.rs:7-8, 20-21`),
   matching the single-signer `claim_activity_v1` shape; the promotion-decision path instead does
   operator-sign → kernel-seal (`lib.rs:287-334`). `CLAUDE.md` records "operator-key signing is
   deferred" for M2 events; **whether that deferral is still current is UNVERIFIED.**
5. **Scope: `plan_admitted` only, or a general mechanism?** 18 kinds share the identical wire wall
   (`serve.rs:1822-1841`), and at least `operator_decision_recorded` / `run_completed` carry the
   identical "needs a dedicated native control" framing. The most recent precedent (2026-08-15/16,
   #302/#303) was to **retire the callers rather than build the control** — so "retire
   `plan_admitted` too" is a live option this spec deliberately does not foreclose.
6. **Do the two broker protocols converge?** `admission_protocol.rs:17-35` carries the
   `admit` / `lookup_preauthorized` / `open_reviewer_session` vocabulary (body enum `:48-54`), with
   `LookupPreauthorized` an explicit fail-closed no-op in
   the admission-only slice (`dispatch_admission.rs:172-180`), alongside the live
   `governed_session_*` family. If they converge, the plan admission belongs in the former and S2's
   shape changes (candidate-transaction spec §11 Q2).
7. **Does any production path mint a signed `DispatchEnvelopeV5` today?** **UNVERIFIED** — needed
   before S5 can be scheduled (§7 S5). Until answered, the §2.4 embargo cannot lift.
8. **`PlanAdmittedV1` frozen 8-field shape vs a V2** carrying the authorized task set and/or a
   native domain-separated digest. V2 costs the 9-step derivation, a fixture rotation, and a
   `bp-replay` arm (§5.5); staying at V1 means the plan→task linkage must live outside the payload
   (in S2's projection table).
9. **Reuse the quarantined TS port, or stand alongside it?** Rewiring `createPlanAdmissionPort`
   forces a rewrite of `planforge-plan-admission.test.ts` test 1 from rejection to success (its
   header explicitly anticipates this). Standing alongside keeps test 1 verbatim — recommended,
   but it means a second write surface exists for the same kind.
10. **Demoting validation status to advisory (§4.3).** A native control cannot verify a TypeScript
    validator's verdict. Recording `PASS` as non-authoritative metadata is the honest option, but it
    weakens a gate the current builder enforces — operator ratification required.
11. **Non-Linux behaviour.** The broker confinement boundary is Linux-only
    (`confinement.rs:79-81`), and so is CAS custody (`host_cas_custody.rs:20-22`). What does
    `planforge admit` do on macOS/Windows — fail closed with guidance, or is there an intended
    second path? Fail-closed is assumed here.
12. **Three new gates surfaced by the repair pass:**
    - **(a) Tier asymmetry at the storage layer (blocks S1).** S1 makes `plan_admitted` the only
      `REJECTED_ONLY_WHEN_SIGNED` kind also present in `validate_external_append`'s always-blocked
      set, and falsifies a pinned comment describing the unsigned lane as deliberately open
      (§6.1, §7 S1). Accept the asymmetry, move the whole tier, or take the projection-invariant
      alternative in §7 S1?
    - **(b) Is this control minting authority or recovery evidence?** `PlanAdmittedV1` calls itself
      *"the dispatch authority"* (`plan_lifecycle.rs:7-8`), while every existing native admission
      control explicitly disclaims effect authority (`sqlite.rs:6864-6866`, `:2721-2723`,
      `dispatch_authority_material` → `None` for V5 at `:13443`). This would be the first native
      control to mint authority. Bound up with the M2 resume conflict in §5.3: does an
      `AwaitingCheckpoint` admission carry dispatch authority (option b) or not (option a)?
    - **(c) Who stages the compiled plan bytes into the broker-owned CAS (§4.4)?** The CAS is
      `0700` and broker-uid-owned, so the mint requester structurally cannot; and the custody makes
      no per-object integrity claim. The staging path is undefined and is a new authenticated
      surface, not an implementation detail.
13. **Does S4 require checkpoint coverage of the referenced admission, or only a verifying
    signature?** Coverage is implementable (`fully_covering_kernel_checkpoint`, `sqlite.rs:24021`)
    but needs a plan-admission-typed analogue and interacts with §8 Q12b: requiring coverage means
    an unsealed admission cannot authorize anything.

---

## 9. Dogfooding note

The candidate-transaction spec §10 observes that admission-gated self-modification has never run on
a non-rigged input. The first slice that could make it possible is **S3** — S2 has no transport, so
nothing can reach the mint through `planforge admit` until the authenticated ingress exists. S1 and
S2 must therefore be authored conventionally; the control does not exist until S2 lands, and cannot
be driven until S3 does.

The first honest dogfood candidate is the smallest slice authored **after S3**: the S6
`index.ts` / `index.d.ts` set-equality drift test, or the S6 doc corrections — small, verifiable,
and inside the `code-edit` side-effect vocabulary. Do not nominate S1 or S2: an admission-gated
self-modification cannot build its own admission gate.
