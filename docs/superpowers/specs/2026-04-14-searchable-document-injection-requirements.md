# Searchable Document Injection — Requirements

**Date:** 2026-04-14
**Scope:** Phase 1 / Slice 1C — searchable document lookup and injection

## Goal

Extend packet enrichment so `buildplane run` can retrieve relevant searchable documents and inject them into `TaskIntent.context.memories` after repo facts and procedures.

## In scope

- consume the existing ranked searchable-document retrieval API
- support exact-source lookup when the packet carries explicit searchable-document source refs
- support exact-title lookup when the task objective matches a document title
- support full-text fallback using deterministic search terms
- inject searchable documents as provider-neutral plain strings
- add focused tests proving exact-first ordering and mixed-source memory order

## Out of scope

- new storage schema or new searchable-document tables
- new renderer sections or provider-specific formatting
- operator-visible injection-reason surfaces (Slice 1D)
- promotion/extraction of new searchable documents from run outcomes
- broad packet schema redesign

## Functional requirements

1. Packet enrichment must remain a no-op when `intent` is absent.
2. Searchable document injection must reuse `retrieveSearchableDocuments(...)`.
3. Exact source lookup must run before title/FTS fallback when a packet contains explicit source refs.
4. Exact title lookup must run before FTS fallback when the task objective exactly matches a document title.
5. FTS fallback must use deterministic search terms derived from the task intent.
6. Searchable documents must be appended as plain memory strings, not rendered sections.
7. Existing ordering must remain stable:
   - local run learnings
   - repo facts
   - procedures
   - searchable documents
   - Honcho memories
8. Duplicate searchable documents must not be injected twice even if matched by multiple exact/FTS queries.
9. Searchable document strings must be concise and deterministic.

## Source-ref contract for this slice

To enable exact-source lookup without changing storage contracts, packet enrichment may interpret explicit source refs from `packet.unit.inputRefs` using these forms:

- `runs:run-123`
- `notes:note-9`
- `runs/run-123`
- `notes/note-9`

Unknown ref shapes must be ignored rather than treated as errors.

## Acceptance criteria

- exact-source searchable-document hits are injected ahead of title/FTS matches
- exact-title searchable-document hits are injected ahead of FTS matches
- mixed-source memory ordering stays deterministic
- focused packet-enrichment tests prove ranking/dedup behavior
- `npx pnpm lint` passes
- `npx pnpm typecheck` passes
- `npx pnpm build` passes
