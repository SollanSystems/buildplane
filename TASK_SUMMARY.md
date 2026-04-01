# M9: TaskIntent + Renderers — Task Summary

**Branch:** `feat/multi-model-orchestration`
**Date:** 2026-04-01
**Status:** Complete — all 5 tasks implemented, typecheck clean, 477 tests pass

---

## What Was Built

Milestone 9 implements the provider-neutral task spec layer (Decision 3 from
the multi-model orchestration spec). A structured `TaskIntent` replaces raw
prompts as the canonical task description, with provider-specific renderers
translating intent into prompts at execution time.

---

## Tasks

### T1 — TaskIntent types in kernel (`0fc5ef2`)

Added to `packages/kernel/src/types.ts`:
- `TaskType` union — 8 task kinds (implement, review, diagnose, …)
- `TaskFeatures` — ambiguity, reversibility, verifierStrength, language, etc.
- `TaskIntent` — objective + taskType + context + constraints + features
- `RenderedPrompt` — system?, prompt, maxTokens?, tools?
- `TaskRenderer` — interface with `provider` + `render(intent, role)` method

Added `intent?: TaskIntent` to `UnitPacket` in `run-loop.ts`.
All types exported from `packages/kernel/src/index.ts`.

### T2 — Claude renderer (`68fe0cb`)

`packages/adapters-models/src/renderers/claude-renderer.ts`:
- `createClaudeRenderer()` returns a `TaskRenderer` with `provider: "anthropic"`
- Produces an 8-section Markdown prompt (mirrors SuperClaude DispatchBuilder):
  1. Task header (role + type + objective)
  2. Safe autonomy contract
  3. Instructions (task-type-specific, role-adapted)
  4. Codebase hints
  5. Project memories
  6. Prior work
  7. Preset (scope + verification gates)
  8. Retry context (omitted if none)
- Reviewer/adversary roles get review-focused framing; implementer/candidate
  get task-type-specific implementation guidance

### T3 — Codex renderer (`68fe0cb`)

`packages/adapters-models/src/renderers/codex-renderer.ts`:
- `createCodexRenderer()` returns a `TaskRenderer` with `provider: "openai"`
- Produces concise XML-style blocks per gpt-5-4-prompting conventions:
  `<task>`, `<context>`, `<constraints>`, `<retry>` (optional)
- `<context>` contains: files, language, framework, codebase-hints, memories,
  prior-work (reviewer/adversary get `<work-to-review>` label)
- `<constraints>` contains: scope, forbidden (optional), verification-gates
- Role adapts task instruction line; reviewer gets verdict framing

### T4 — Wire renderers into executors (`d9f393c`)

Updated three executors to check `packet.intent` first:
- `packages/adapters-models/src/claude-code-executor.ts`
- `packages/adapters-models/src/model-executor.ts`
- `packages/adapters-codex/src/codex-executor.ts`

Pattern in all three:
```
if (packet.intent && renderer) {
  rendered = renderer.render(packet.intent, "implementer")
  prompt = rendered.system ? `${system}\n\n---\n\n${prompt}` : prompt
} else if (packet.model.prompt) {
  // legacy path unchanged
} else {
  throw Error(...)
}
```

`renderer` is an optional injected option (`options?.renderer`) — testable
without spawning a real model. All existing packets without `intent` continue
to work unchanged.

### T5 — Renderer unit tests (`c4319e0`)

`packages/adapters-models/test/renderers.test.ts` — 26 tests:

**Claude renderer (13 tests):**
- provider field, 8-section structure, reviewer/adversary role adaptation
- codebase hints, memories, prior work, retry context inclusion/omission
- forbidden paths, verification commands, missing optional fields

**Codex renderer (13 tests):**
- provider field, XML block structure, role attributes
- work-to-review vs prior-work label, codebase-hints, memories
- verification-gates, retry/forbidden blocks, complexity attribute
- missing optional fields (no throw)

---

## Verification

```
pnpm typecheck   — clean (0 errors)
pnpm test        — 477 passed, 1 skipped (was 451 before M9)
```

---

## Files Changed

| File | Change |
|------|--------|
| `packages/kernel/src/types.ts` | Added TaskIntent/TaskType/TaskFeatures/TaskRenderer/RenderedPrompt |
| `packages/kernel/src/run-loop.ts` | Added `intent?: TaskIntent` to UnitPacket |
| `packages/kernel/src/index.ts` | Re-exported new types |
| `packages/adapters-models/src/renderers/claude-renderer.ts` | New |
| `packages/adapters-models/src/renderers/codex-renderer.ts` | New |
| `packages/adapters-models/src/renderers/index.ts` | New barrel |
| `packages/adapters-models/src/index.ts` | Re-exported renderers |
| `packages/adapters-models/src/claude-code-executor.ts` | Intent+renderer wiring |
| `packages/adapters-models/src/model-executor.ts` | Intent+renderer wiring |
| `packages/adapters-codex/src/codex-executor.ts` | Intent+renderer wiring |
| `packages/adapters-models/test/renderers.test.ts` | New — 26 tests |
