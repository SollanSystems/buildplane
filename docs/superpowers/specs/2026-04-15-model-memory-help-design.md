# Model Memory-Help Fixture Design

## Slice name

Phase 5 / Slice 5A2: first memory-helped Codex fixture

## Why this slice

Slice 5A1 proved the model-backed path runs at all.
The next smallest high-leverage step is to prove a behavioral delta: memory-on should outperform memory-off for at least one model-backed fixture.

This keeps the scope narrow:

- no new suite id
- no new provider
- no report redesign
- no CI integration
- no raw-agent comparison suite yet

## Architecture

### 1. Add one second fixture under `model-codex`

Create one new fixture directory such as:

- `eval/suites/model-codex/memory-helped-path/`

The fixture should use a two-run pattern:

- `run-1.json`: command packet that fails because a required output path is missing
- `run-2.json`: model packet that must recover by creating that same output path

The key trick is that the exact output path should appear in memory only, not directly in the run-2 objective.

### 2. Reuse rejection learnings from run 1

A failing run already produces deterministic constraint learnings such as:

- `Verification failed: output/<path>`
- `Run rejected: ... required output missing: output/<path>`

That makes run 1 ideal for this slice:

- no new memory extraction logic is needed
- the injected memory block naturally contains the exact path needed by run 2
- the path can stay hidden from the run-2 objective and verification text rendered to the implementer

### 3. Keep runtime/harness logic unchanged if possible

`eval/report.ts` already computes `memoryHelpedRate` as:

- memory strategy passes while no-memory strategy fails, or
- memory strategy uses fewer rounds

So if the new fixture makes:

- `memory+strategy = pass`
- `nomemory+strategy = fail`

then the existing aggregate logic is sufficient.

Prefer not to modify:

- `eval/runner.ts`
- `eval/report.ts`
- `apps/cli/src/strategy-wrapper.ts`

unless a tiny supporting change is truly required.

One narrow runtime adjustment is acceptable here if needed for cross-platform determinism: preserving multiline Codex prompts on Windows when `codex` resolves through an npm-generated `codex.cmd` shim. If that issue appears, fix it only inside `packages/adapters-codex/src/codex-executor.ts` without widening any other provider/runtime behavior.

### 4. Make the test Codex stub prompt-sensitive

Extend the existing stub in `test/eval/model-codex-suite.test.ts` so it behaves differently by prompt content.

Proposed behavior:

- reviewer prompts: succeed only if a matching JS artifact already exists in `output/`
- implementer prompts containing `output/hello.js`: write `output/hello.js`
- implementer prompts containing the new memory-help fixture path: write that file
- implementer prompts with neither explicit target: exit non-zero

This gives deterministic behavior:

- `hello-memory-smoke` still passes because its objective names `output/hello.js`
- the new fixture passes with memory because the `<memories>` block includes the hidden target path
- the new fixture fails without memory because the implementer prompt lacks the path entirely

### 5. Update the suite test to assert behavioral proof

Extend `test/eval/model-codex-suite.test.ts` so the opt-in suite test asserts:

- `suiteId === "model-codex"`
- `aggregates.totalFixtures === 2`
- `aggregates.totalConditions === 8`
- `aggregates.memoryHelpedRate > 0`
- the new fixture shows:
  - `memory+strategy` passed
  - `nomemory+strategy` failed (or at minimum underperformed)

## Likely files

### New
- `eval/suites/model-codex/memory-helped-path/meta.json`
- `eval/suites/model-codex/memory-helped-path/run-1.json`
- `eval/suites/model-codex/memory-helped-path/run-2.json`

### Modified
- `packages/adapters-codex/src/codex-executor.ts`
- `packages/adapters-codex/test/codex-executor.test.ts`
- `test/eval/model-codex-suite.test.ts`
- `docs/superpowers/specs/2026-04-15-model-memory-help-requirements.md`
- `docs/superpowers/specs/2026-04-15-model-memory-help-design.md`
- `docs/superpowers/plans/2026-04-15-model-memory-help-tasks.md`

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

- no raw-agent comparison suite
- no benchmark publication work
- no multi-provider model fixture expansion
- no CI eval workflow
- no report-format redesign
