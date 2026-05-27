# Run Inspector Evidence Slice

**Date:** 2026-05-02
**Status:** Docs/evidence contract for the first Mission Control surface
**Scope:** Read-only forensic run inspection built from current Buildplane evidence surfaces

## Decision

Mission Control remains the umbrella product direction. The first shippable surface is narrower: **Run Inspector**.

Run Inspector is a forensic evidence viewer for completed or halted Buildplane runs. It must prove what happened from persisted runtime emissions before it tries to orchestrate, animate, or intervene. The MVP is limited to three panels:

1. **Event Timeline**
2. **Evidence Pane**
3. **Outcome Strip**

This slice is intentionally evidence-first, not cockpit-first. It should make a BLOCKED or FAILED run more trustworthy by showing why Buildplane stopped, what evidence exists, and which criteria remain unverified.

## Source-of-truth contract

Run Inspector may only render fields that come from current Buildplane runtime records or generated ledger schema. No panel may invent synthetic reasoning events, speculative summaries, or cinematic state that is not backed by stored data.

| Panel | Runtime source | What it may show | What it must not show |
| --- | --- | --- | --- |
| Event Timeline | `InspectSnapshot.eventTape` in `packages/kernel/src/run-loop.ts`; persisted ledger events read by storage; generated `EventKind` values in `packages/ledger-client/src/generated/index.ts` | event id, timestamp/window, event kind, event summary, event metadata, kind counts, terminal status, parent/fork lineage when present | model thoughts, inferred intent, fake orchestration graph edges, unrecorded live activity |
| Evidence Pane | `InspectSnapshot.evidence`, `InspectSnapshot.decisions`, `InspectSnapshot.artifacts`; `EvidenceRecord`, `DecisionRecord`, and `ArtifactRecord` in `packages/storage/src/contracts.ts`; ledger event payloads and artifact refs | raw command/test result status, decision kind/outcome/reasons, artifact location/type, tool stdout/stderr references, workspace read/write hashes where captured | prose that claims verification without a stored evidence record, hidden pass/fail inference, fabricated artifact previews |
| Outcome Strip | `InspectSnapshot.run.status`, `InspectSnapshot.eventTape.terminalStatus`, evidence statuses, decisions, artifacts, and run/workspace failure records | PASSED / BLOCKED / FAILED style verdict, changed/artifact count when known, verified vs unverified criteria when explicitly recorded, blockers/failure reason | merge-ready or proof-complete language unless verification records and acceptance criteria support it |

## Event Timeline

The timeline is a dense single-column history. It is not a replay scrubber and not a live-control graph.

Minimum row fields:

- event id
- occurred-at timestamp or run-relative time
- closed event kind
- actor/source when present in metadata
- target when present in metadata
- verification badge derived from evidence/terminal state, not from optimistic wording
- evidence/artifact link count when present

Use jump-to-event behavior rather than a cinematic scrubber. Selecting an event populates the Evidence Pane with only the event payload, related evidence records, decisions, artifacts, and captured stdout/stderr/blob references that actually exist.

### Closed v1 event kinds

Run Inspector's event vocabulary starts from the generated ledger `EventKind` enum:

- `run_started`
- `run_completed`
- `run_failed`
- `run_admission_recorded`
- `unit_started`
- `unit_completed`
- `unit_failed`
- `unit_cancelled`
- `git_checkpoint`
- `model_request`
- `model_response`
- `tool_request`
- `tool_result`
- `workspace_read`
- `workspace_write`
- `tape_checkpoint`

If a new visual state needs a new kind, add it to the ledger/runtime schema first and verify it through storage/tests. Do not add UI-only event kinds for model reasoning, vibes, confidence, or inferred progress.

## Evidence Pane

The Evidence Pane answers: "What raw record supports the selected event?"

Allowed evidence classes:

- ledger event payload JSON with redacted secrets preserved as hashes/hints
- tool request/result details, including command, cwd, duration, exit code, stdout/stderr references, and structured output where captured
- workspace read/write content hashes and sizes
- git checkpoint refs and commit SHAs
- Buildplane evidence records such as command-exit or test-result status
- policy decisions with outcome and reasons
- artifact records with type and location

Rendering rules:

- Prefer raw excerpts and links over paraphrase.
- Redact secrets and preserve hashes/hints rather than displaying raw credentials.
- Make missing evidence visible as missing; do not fill gaps with summaries.
- When stdout/stderr or blobs are large, show bounded previews plus the durable reference.

## Outcome Strip

The Outcome Strip is a compact verdict area, not a marketing card.

Required fields:

- terminal verdict: PASSED, BLOCKED, FAILED, CANCELLED, or UNKNOWN
- run id
- event count and terminal event kind when available
- evidence counts grouped by pass/fail/inconclusive when available
- artifact count and changed-file count only when backed by records
- blockers or failure reason when available
- unverified criteria count when criteria exist but no passing evidence exists

Verdict mapping must fail closed:

- PASSED requires a passed run status plus supporting verification/evidence records.
- BLOCKED is the right demo posture when a run halted because evidence is missing, tests failed, approval was required, or merge readiness is unproven.
- FAILED is reserved for explicit failed run/unit/tool/test states.
- UNKNOWN is allowed when legacy or partial records do not contain enough data.

## Demo posture

The first demo should lead with a BLOCKED run rather than a success story:

1. show a real autonomous run timeline
2. click the failing or halted event
3. show raw evidence in the Evidence Pane
4. show the Outcome Strip stopping merge/readiness because verification or acceptance is not green
5. close with: Buildplane made the stop condition legible instead of hiding it behind a confident summary

This is the strongest proof of the product thesis: evidence over confidence.

## Explicit non-goals for this slice

- live cockpit controls
- orchestration graph
- intake parser
- replay scrubber
- agent persona cards
- generic chat UI
- synthetic chain-of-thought display
- cryptographic proof or signing claims beyond existing hashes/refs
- public/global install claims stronger than the verified package contract

## Acceptance criteria

This docs/evidence slice is complete when:

- the README points operators to Run Inspector as the evidence-first Mission Control slice
- architecture docs define Event Timeline, Evidence Pane, and Outcome Strip against current Buildplane records
- the closed v1 event vocabulary is copied from the generated ledger schema, not invented in prose
- the plan records Run Inspector as a read-only forensic slice with broader cockpit controls deferred
- local verification proves the documentation contract and the normal CI gate remains green
