# Model Codex benchmark summary

`model-codex` is an unsafe/shadow capability benchmark. It is useful for
observing prompt and retrieval behavior, but it is not a governed execution
path, a promotion signal, or a Trust Spine release metric. Governed release
evidence is collected through `eval/trust-spine-release-gate.ts` from the
isolated host's signed activity records.

## How to rerun

The default run uses the built-in Codex eval stub and is deterministic:

```bash
npx pnpm eval --suite model-codex --json
```

Set `BUILDPLANE_EVAL_MODEL=1` only to exercise the real Codex CLI in an
explicitly unsafe eval environment. Neither variant can issue a governed
receipt.

## Current aggregate contract

The suite contains four fixtures and sixteen conditions. Its report retains
`passRate`, `memoryInjectedRate`, `memoryHelpedRate`, `strategyHelpedRate`,
`combinedHelpedRate`, and `meanDurationMs` for historical comparison.

`memoryInjectedRate` verifies whether context reached the worker. The
strategy-derived rates currently remain zero: the old raw
`implement-then-review` graph is deliberately blocked because it cannot
provide immutable-candidate review, signed evidence, or pre-promotion control.
This is a safety result, not a capability regression waiver. Raw one-shot
results may still be inspected as untrusted observations.

Duration is environment-sensitive and advisory only.

## Fixture evidence

### `hello-memory-smoke`

The raw one-shot variants remain a smoke test for the model eval harness.
Both strategy variants are blocked by the Trust Spine boundary.

### `memory-helped-path`

The `memory+raw` condition can demonstrate that injected context reaches the
unsafe worker while `nomemory+raw` does not recover the fixture. This is a
retrieval observation, not a routing fact or promotion eligibility signal.
Both strategy variants are blocked.

### `reviewer-rescue`

This historical fixture records why raw one-shot execution and an ambient
reviewer loop are insufficient. The prior raw `implement-then-review` rescue
path is blocked until a native, read-only candidate reviewer and signed review
evidence are available.

### `memory-strategy-combined-only`

This fixture preserves the former combined-only shape for regression
visibility. Its strategy arm is blocked, so it cannot claim a combined
memory-plus-strategy success in the current trust model.

## What this benchmark proves

- The model eval harness can invoke its configured unsafe/stub worker.
- Memory-on inputs are visibly injected into the eval conditions.
- Legacy raw review strategies are blocked rather than being counted as
  trustworthy strategy help.

It does not prove provider quality, semantic review correctness, sandboxing,
authorization, promotion eligibility, recovery correctness, or GA readiness.
Use the signed-tape governed campaign for those claims.
