# ADR 0001: Memory Model Reconciliation

## Status

Accepted — **revised 2026-05-26 after the Phase-0 Codex gate failed the first draft.**
The original draft claimed "no promotion bridge exists" and "no `memory` CLI exists";
both were false. This revision is grounded in the verified `run-cli.ts` implementation.

## Context

Buildplane's `origin/main` carries two memory subsystems:

1. **Learnings** — `run_learnings` + `BuildplaneMemoryPort`, auto-extracted by
   `extractLearnings()`, scopes `session|workspace|user|pack`, seen-count promotion
   *within the learnings table*. Written by the orchestrator
   (`orchestrator.ts:840/928/1539`).
2. **Structured** — `repo_facts` / `procedures` / `searchable_documents`(+FTS5) +
   `BuildplaneStoragePort`. Curated, keyed, ranked retrieval.

**A promotion bridge already exists** (corrected via Codex gate, verified in
`apps/cli/src/run-cli.ts`):

- `memory promote --receipt <run-id>` (`run-cli.ts:3427`, impl
  `promoteMemoryFromReceipt` `:1612-1782`) graduates learnings into `repo_facts`
  via `upsertRepoFact`.
- It is **manual** (operator-invoked), **receipt-gated** (only `verdict === "PASSED"`),
  **`fact`-kind only** (all other kinds skipped), and **conservative**: it skips
  derived learnings, learnings changed after receipt capture, empty keys, and —
  critically — **never overwrites** an existing `repo_fact` of the same `factKey`
  from different provenance (`run-cli.ts:1740-1758`).
- `factKey` is derived from the learning `title` via
  `normalizeReceiptLearningFactKey`; promoted facts get `scopeType:"repo"`,
  `createdBy:"system"`, `confidence:1`, plus `branch`/`commitSha` provenance.

**A `memory` CLI already exists** (`run-cli.ts:3392`): `memory list [--scope --kind]`,
`memory inspect <id>`, `memory promote --receipt`. No `facts`/`procedures`/`episodes`
subcommands yet.

Both layers are also **dual-injected at runtime** with no cross-layer reconciliation
(`packet-enrichment.ts:428-446`).

## Decision

**For Phase 1: keep the two layers as they are — dual-injected at runtime, connected
only by the EXISTING manual, receipt-gated, fact-only promote bridge. Do NOT automate
promotion and do NOT build a second bridge.** Promotion-automation and a richer
learnings→structured graduation policy are **Phase 2** decisions.

The reconciliation question is therefore *resolved by the shipped reality*: the layers
are neither fully merged nor fully separate — they are distinct stores with a narrow,
conservative, operator-triggered bridge. Phase 1 builds on that as-is.

## Consequences

- **Promotion stays manual in Phase 1.** Operators run `memory promote --receipt` to
  graduate `fact`-kind learnings; the conservative no-overwrite behavior is retained.
- **Phase 1 — Task A (seed repo_facts from inspection):** Write via the existing
  `upsertRepoFact` with `createdBy:"system"`, `scopeType:"repo"`, keys from a stable
  `repo.*` registry. **Constraint:** the `repo.*` namespace must not collide with
  promote-derived factKeys (which come from `normalizeReceiptLearningFactKey(title)`),
  so inspection-seeded facts and receipt-promoted facts never clobber each other.
- **Phase 1 — Task B (memory inspection CLI):** **EXTEND the existing `memory`
  command** (`run-cli.ts:3392`) with `facts` / `procedures` subcommands (reusing
  `listRepoFacts`/`listProcedures`). `episodes` requires a new read path —
  `getStatusSnapshot()`/`inspectTarget()` do not list events — so `episodes` is either
  scoped shallow in Phase 1 or deferred. Do **not** create a parallel `memory-cli.ts`.
- **Phase 1 — Task C (reviewer injection):** Larger than wiring. Default reviewer
  packets are built after implementer enrichment and **do not carry `intent`**, and
  enrichment exits early without it (`strategy-wrapper.ts:51-124`,
  `packet-enrichment.ts:420-423`). Phase 1 must change reviewer-packet construction (or
  run strategy-level enrichment post-wrap) **and** persist reviewer injected-memory
  records. "No new symbols / composition unchanged" is withdrawn.
- **Known hazards deferred to Phase 2 (recorded, not fixed in Phase 1):**
  - *Cross-layer dedup/precedence* — both layers are concatenated into prompts with no
    dedup or precedence (`packet-enrichment.ts:428-446`); the same fact can appear in
    both, or conflict. Phase 2 defines precedence (structured authoritative over
    learning hints) and dedup.
  - *Stale-fact retrieval* — `repo_facts` retrieval does not filter by
    `valid_from_commit`/`valid_to_commit` or branch (`store.ts:1081-1121`), so stale
    facts stay injectable. Phase 2 adds commit/branch validity filtering. The earlier
    "commit-versioned curated truth" claim is corrected: the columns exist but are not
    enforced at read time.

## Rejected alternatives

- **Automate promotion now / build a richer bridge in Phase 1:** Rejected. The manual
  bridge is sufficient and safe; automation needs the dedup/precedence + validity model
  (Phase 2) to avoid amplifying the known hazards.
- **Collapse to one layer (learnings-only or structured-only):** Rejected. Discards
  either the ranked exact-recall retrieval or the auto-telemetry signal; high cost/risk.
- **Original draft "separate, no bridge, defer bridge to Phase 2":** Rejected as
  factually wrong — a bridge already ships.
