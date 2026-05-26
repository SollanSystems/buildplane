# Phase 1 Memory Contract (frozen 2026-05-26, rev. post-Codex-gate)

> Authority: ADR 0001 (revised). **This revision corrects two factual errors the
> Codex gate caught in the first draft:** a `memory` CLI already exists, and a
> manual promote bridge already exists. All symbols verified against the
> `origin/main` reference worktree.
>
> **Scope stance:** Phase 1 adds **no new port methods**, but it is NOT
> "behavior-frozen everywhere" — Task B *extends* the existing `memory` command and
> Task C *modifies* reviewer-packet construction. Worktrees cut from `origin/main`.

## Unchanged port surface (frozen — DO NOT add to or modify)

```ts
// packages/kernel/src/ports.ts — BuildplaneStoragePort
upsertRepoFact(input: UpsertRepoFactInput): RepoFact;            // :90  (Task A writes)
listRepoFacts(options?): readonly RepoFact[];                    // :98  (Task B reads)
listProcedures(options?: { taskType?: string }): readonly ProcedureMemory[]; // :120 (Task B)
inspectTarget(id: string): InspectSnapshot;                     // :152
getStatusSnapshot(): StatusSnapshot;                            // :151
// BuildplaneMemoryPort
fetchLearnings(options?): readonly StoredLearning[];            // :246 (Task B reads)
fetchLearningById(id: string): StoredLearning | undefined;      // :261 (Task B reads)
// memory-types.ts: UpsertRepoFactInput (factKey, factValue, valueType, scopeType?,
//   confidence?, createdBy, sourceRunId?, branch?, commitSha?, validFrom/ToCommit?) // :96
```

## Existing surface Phase 1 EXTENDS or MODIFIES (do NOT recreate)

```ts
// apps/cli/src/run-cli.ts
//   `memory` command dispatch (:3392) — has list/inspect/promote subcommands.
//   Task B ADDS `facts`/`procedures` subcommands HERE. Not a new file.
//   promoteMemoryFromReceipt (:1612-1782) — the manual promote bridge.
//   UNCHANGED in Phase 1: do not touch promotion logic or its conservatism.

// apps/cli/src/strategy-wrapper.ts
//   buildModelReviewer (:7) / buildCommandReviewer (:33) build reviewer packets that
//   currently OMIT `intent`. wrapAsStrategy (:66) assembles implement-then-review.
//   Task C MODIFIES reviewer-packet construction to carry an `intent`.

// apps/cli/src/packet-enrichment.ts
//   preparePacketMemoryEnrichment (:412) early-exits when !p.intent (:421-423);
//   enrichPacketWithMemories (:470). REUSED by Task C once reviewer packets carry intent.
```

## Added by Phase 1 (all NEW — symbol names verified collision-free)

**Task A — repo-fact seeding** (new caller of existing `upsertRepoFact`; no port change)
```ts
NEW const REPO_FACT_KEYS = {
  primaryLanguage: "repo.primary-language", testRunner: "repo.test-runner",
  buildCommand: "repo.build-command", typecheckCommand: "repo.typecheck-command",
  lintCommand: "repo.lint-command",
} as const;
// COLLISION RISK (ADR 0001): factKey collisions between seeded and promote-derived
// facts are UNLIKELY but POSSIBLE, and NOT automatically safe:
//   - promote-derived keys = normalizeReceiptLearningFactKey(title) = a sanitized
//     learning title (run-cli.ts:1527). It does NOT namespace, so a learning titled
//     "repo.primary-language" can sanitize to a colliding key.
//   - upsertRepoFact is LAST-WRITER-WINS: it supersedes any active same-(key,scope)
//     fact then inserts a new active row (store.ts:2531-2545). It has NO conservatism.
//     (The promote *caller* skips on conflict; direct seeding does not.)
// Task-A verify-first MUST: (1) inspect sanitizeVerifiedMemoryText to confirm whether
// it can realistically emit a `repo.`-prefixed key; if it can, pick a namespace it
// cannot produce. (2) Treat seeding as idempotent last-writer-wins for `repo.*` keys,
// and document that inspection-seeded facts are authoritative for that namespace.
NEW function seedRepoFactsFromInspection(
  port: Pick<BuildplaneStoragePort, "upsertRepoFact">,
  signals: { primaryLanguage?: string; testRunner?: string; buildCommand?: string;
             typecheckCommand?: string; lintCommand?: string },
  provenance: { branch?: string; commitSha?: string },
): RepoFact[];
// Each non-empty signal -> upsertRepoFact({ factKey: REPO_FACT_KEYS[x], factValue,
//   valueType:"string", scopeType:"repo", createdBy:"system", ...provenance }).
// Input binding (which inspection output feeds `signals`) = Task-A verify-first.
```

**Task B — extend the existing `memory` command** (no port change, no new file)
```ts
// In apps/cli/src/run-cli.ts `memory` dispatch (:3392), ADD:
NEW subcommand `memory facts [--scope --json]`      -> listRepoFacts(...)
NEW subcommand `memory procedures [--task-type --json]` -> listProcedures(...)
// `memory episodes`: NEEDS a new read path — getStatusSnapshot()/inspectTarget() do
//   not list events. Phase 1 options: (a) scope `episodes` shallow over inspectTarget,
//   or (b) DEFER episodes. Decide in Task-B verify-first; do NOT silently add a port method.
// Reuse apps/cli/src/formatters.ts for output. Existing list/inspect/promote UNCHANGED.
```

**Task C — reviewer memory injection** (modifies reviewer construction; no port change)
```ts
// 1. strategy-wrapper.ts buildModelReviewer/buildCommandReviewer: give the reviewer
//    packet an `intent` (objective = "review <unit>", taskType: "review") so
//    preparePacketMemoryEnrichment no longer early-exits on it.
// 2. Run reviewer-packet enrichment (existing enrichPacketWithMemories) with
//    taskType:"review" and PERSIST its injected-memory records (recordInjectedMemories).
// This is a real construction change, NOT free wiring (ADR 0001).
```

## Behavioral rules (from ADR 0001)

1. Promotion stays **manual / receipt-gated / fact-only / no-overwrite** in Phase 1. Do not automate it.
2. Task A keys live under `repo.*`, collision-safe vs promote-derived keys; `createdBy:"system"`.
3. Task B extends the existing `memory` command; never a parallel CLI.
4. Task C must make reviewer packets carry `intent` and persist reviewer injected memories.

## Deferred to Phase 2 (out of Phase-1 scope — record, don't fix)

- Cross-layer dedup/precedence at injection (`packet-enrichment.ts:428-446`).
- Commit/branch validity filtering of `repo_facts` retrieval (`store.ts:1081-1121`).
- Promotion automation + richer learnings→structured graduation policy.

## Off-limits (Phase 1 must NOT touch)

- Any `BuildplaneStoragePort` / `BuildplaneMemoryPort` signature.
- Table DDL; `memory-retrieval.ts` ranking; `extractLearnings()`; `learning-store.ts`.
- `promoteMemoryFromReceipt` logic and its conservatism.
- The Phase-2 deferred items above.
