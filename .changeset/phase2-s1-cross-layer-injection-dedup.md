---
"buildplane": minor
---

Phase 2 · S1 — cross-layer injection dedup/precedence: introduce a pure `dedupeAcrossLayers` helper and apply it at the packet-enrichment injection assembly so a memory surfacing in more than one layer (structured repo-facts/procedures/documents, run_learnings, honcho) is injected once instead of concatenated verbatim. Cross-layer identity keys on normalized display text (layer tag stripped, whitespace/case folded) because only display strings survive to the assembly. Documented precedence is source-order `structured (repo-fact ≻ procedure ≻ document) ≻ run_learnings ≻ honcho`; the higher-precedence copy wins and distinct memories are preserved in stable order. Finer confidence/recency tie-breaks fall back to source order (the contract's documented fallback) because that data is not available at the assembly. Only `packet-enrichment.ts` (+ its test) changed; no port or DDL change.
