# Structured Memory Injection — Requirements

**Date:** 2026-04-13
**Scope:** Phase 1 / Slice 1B — repo fact + procedure injection

## Goal

Make `buildplane run` inject ranked structured memories from repo facts and procedures into `TaskIntent.context.memories` before execution, without changing renderer-specific formatting.

## In scope

- consume the Slice 1A retrieval APIs for repo facts and procedures
- derive deterministic retrieval inputs from the packet intent plus current git branch when available
- inject the top-ranked repo facts and procedures into `TaskIntent.context.memories`
- preserve the existing local run-learning and Honcho memory injection behavior
- keep output provider-neutral by injecting plain strings, not provider-specific prompt sections
- add focused tests proving ordering and injection behavior

## Out of scope

- searchable document injection (Slice 1C)
- operator-visible inspect/history reasons (Slice 1D)
- renderer format changes in `packages/adapters-models/*`
- schema changes or new storage tables
- promotion logic between run learnings and structured memory

## Functional requirements

1. If a packet has no `intent`, enrichment must remain a no-op.
2. If no memory sources are available, enrichment must remain a no-op.
3. Structured retrieval must use the existing ranked APIs:
   - `retrieveRepoFacts(...)`
   - `retrieveProcedures(...)`
4. Repo-fact retrieval must be deterministic and scope-aware.
5. Procedure retrieval must prefer exact `taskType` matches and then fuzzy objective/file/verification matches.
6. The enriched packet must keep using `intent.context.memories: string[]` so existing renderers continue to work unchanged.
7. Existing local run learnings must still be injected.
8. Existing Honcho memories must still be injected when configured.
9. Structured memories must be concise enough for prompt injection and stable across providers.
10. Duplicate structured memories must not be injected twice.

## Determinism requirements

- build scope candidates in a fixed order
- build search terms in a fixed order
- deduplicate using the ranked-result IDs
- apply fixed per-category limits before final formatting
- keep final memory ordering stable across runs given the same DB contents and packet

## Acceptance criteria

- packet enrichment injects ranked repo facts when relevant matches exist
- packet enrichment injects ranked procedures when relevant matches exist
- existing run learnings still appear in the enriched packet
- existing Honcho memories still appear in the enriched packet
- formatting remains renderer-agnostic because only plain memory strings are added
- focused tests prove deterministic ordering, no-op behavior, and mixed-source injection
- `npx pnpm typecheck` passes
- `npx pnpm build` passes
