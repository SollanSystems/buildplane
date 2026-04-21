# Searchable Document Injection — Design

**Date:** 2026-04-14
**Scope:** Phase 1 / Slice 1C — searchable document lookup and injection

## Problem

Slice 1B injects repo facts and procedures, but searchable documents still do not influence runs even though ranked retrieval already exists. This leaves broader durable context such as run summaries and operator notes outside the prompt path.

## Design summary

Keep `TaskIntent.context.memories` as the single provider-neutral injection surface. Extend packet enrichment so it can retrieve ranked searchable documents and format them into concise plain strings after procedures.

## Retrieval strategy

### 1. Exact source refs first

Parse `packet.unit.inputRefs` for explicit searchable-document source refs using the limited forms:

- `<sourceTable>:<sourceId>`
- `<sourceTable>/<sourceId>`

Only use source tables that already make sense for current searchable documents (for example `runs`, `notes`). Ignore anything else.

For each parsed source ref, call:

- `retrieveSearchableDocuments({ sourceTable, sourceId, limit })`

This triggers Slice 1A exact-source ranking without requiring packet/schema changes.

### 2. Exact title second

If `intent.objective` is non-empty, call:

- `retrieveSearchableDocuments({ title: intent.objective, limit })`

This gives exact-title matches a deterministic path before full-text fallback.

### 3. Full-text fallback last

Reuse the existing deterministic search-term builder from Slice 1B and call:

- `retrieveSearchableDocuments({ searchText, limit })`

Merge all searchable-document results across exact-source, exact-title, and FTS calls, then use the existing kernel ranking/dedup helper before truncating.

## Formatting

Format searchable documents into concise plain strings:

- preferred: `[document] <title>: <summary>`
- if title absent: `[document] <sourceTable>/<sourceId>: <summary>`

Formatting rules:

- summarize from the first non-empty line or sentence of `bodyText`
- trim excess whitespace
- keep deterministic, provider-neutral output

## Ordering

Final memory order becomes:

1. local run learnings
2. structured repo facts
3. structured procedures
4. searchable documents
5. Honcho memories

Why this order:

- preserve the existing flywheel behavior first
- keep narrow/high-signal structured facts ahead of broader documents
- keep user/Honcho context last as before

## File-level changes

- `apps/cli/src/packet-enrichment.ts`
  - extend the structured-memory port interface with searchable-document retrieval
  - parse exact source refs from `packet.unit.inputRefs`
  - add exact-title + FTS searchable-document retrieval
  - rank/dedupe before limiting
  - format searchable documents into plain strings
- `apps/cli/test/packet-enrichment.test.ts`
  - add failing tests for exact-source-first and exact-title/FTS behavior
  - update mixed-source ordering assertions to include searchable documents

## Non-goals

- no run-cli signature changes should be needed beyond the existing structured-memory port wiring
- no renderer changes
- no inspect/history explanations yet
