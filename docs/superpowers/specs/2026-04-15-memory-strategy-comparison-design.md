# Memory-Strategy Comparison Design

## Slice name

Phase 5 / Slice 5B2: memory-guided strategy-vs-raw comparison fixture

## Why this slice

5A2 proved memory can help on a model-backed path.
5B1 proved strategy can help compared with a raw one-shot attempt.
The next smallest high-leverage step is to prove the two mechanisms work together: memory reveals the hidden target, and strategy rescues the draft into an approved artifact.

This keeps scope narrow:
- one new fixture in `model-codex`
- no new aggregate fields
- no new provider
- no CI integration
- no benchmark publication work

## Architecture

### 1. Add one fixture under `model-codex`

Create:
- `eval/suites/model-codex/memory-strategy-rescue/`

Shape:
- `run-1.json`: deterministic command packet that fails or succeeds in a way that seeds a memory with the exact hidden output path or approval hint
- `run-2.json`: model packet whose visible objective does not reveal the hidden path directly

The intended behavior:
- memory-on injects the hidden target or approval hint
- the first implementer attempt still produces a reviewer-rejected draft
- strategy retry can use reviewer feedback to produce the approved artifact

### 2. Reuse existing harness/report semantics

Prefer to reuse the current machinery unchanged:
- `memoryHelpedRate`
- `strategyHelpedRate`
- the 4-condition matrix
- the existing raw approval-check path for comparison fixtures

This slice should ideally require no new aggregate fields.

### 3. Extend the deterministic Codex stub

Add one more prompt branch in `test/eval/model-codex-suite.test.ts`:
- when the prompt contains the hidden memory-only path plus the first-round objective, write a draft artifact
- when the prompt also contains reviewer feedback, write the approved artifact
- when the prompt lacks the hidden path, fail

This should make the new fixture produce:
- `memory+strategy` => pass
- `memory+raw` => fail
- `nomemory+strategy` => fail
- `nomemory+raw` => fail

### 4. Keep the slice narrow

Prefer touching only:
- `eval/suites/model-codex/memory-strategy-rescue/*`
- `test/eval/model-codex-suite.test.ts`
- `eval/runner.ts` only if a tiny fixture-specific approval hook is required
- new slice docs

Avoid broader report/runtime changes unless strictly necessary.

## Likely files

### New
- `eval/suites/model-codex/memory-strategy-rescue/meta.json`
- `eval/suites/model-codex/memory-strategy-rescue/run-1.json`
- `eval/suites/model-codex/memory-strategy-rescue/run-2.json`

### Modified
- `test/eval/model-codex-suite.test.ts`
- `docs/superpowers/specs/2026-04-15-memory-strategy-comparison-requirements.md`
- `docs/superpowers/specs/2026-04-15-memory-strategy-comparison-design.md`
- `docs/superpowers/plans/2026-04-15-memory-strategy-comparison-tasks.md`

## Verification set

Focused tests:

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Harness checks:

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
node --import tsx ./eval/runner.ts --suite model-codex --json
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no benchmark publication/docs work
- no CI eval workflow
- no multi-provider model fixture expansion
- no broad report-format redesign
