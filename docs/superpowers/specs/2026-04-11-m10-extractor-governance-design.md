# M10 T1+T2: Sharper Extractor + Learning Governance — Design Spec

**Date:** 2026-04-11
**Scope:** Rewrite extraction rules to carry real signal; add dedup-on-write, promotion, and scope-ordered fetch
**Goal:** A second run receives high-signal memories that measurably change behavior, not noise strings

## Problem

The current extractor (`outcome-extractor.ts`, 5 rules) emits strings like `"Approved: run completed successfully"` and `"A implement task passed on this codebase"`. These get injected verbatim into the next run's prompt via `intent.context.memories`. Most learnings do not change model behavior. The fetch window (last 10 by `created_at DESC`) fills with session-scoped repeats. The `run_learnings` schema has `promoted_from_id` and `source_run_id` columns but nothing writes or reads them.

## Design

### 1. Extractor Rule Rewrite (T1)

Replace the current 5 rules in `packages/kernel/src/outcome-extractor.ts` with 5 sharper ones. Same function signature (`extractLearnings(input: OutcomeExtractionInput): ExtractedLearning[]`), same types — only the rule bodies change.

The defensive early return for `decision.outcome === "retrying"` stays.

**Dropped rules:**
- Rule 1 (approved→fact): Success is the null hypothesis. Don't store it.
- Rule 4 (taskType+outcome→decision): Aggregation, not memory.

**Kept + enriched rules:**

**Rule 2 — Rejection constraint (kept, enriched):**
- Condition: `decision.outcome === "rejected"`
- Kind: `constraint`, Scope: `session`
- Title: `"Run rejected"`
- Body: Include `receipt.exitCode` and `packet.unit.verificationContract`. If `receipt.outputChecks` has any entry with `exists === false`, include the first failing path. If no failing outputs, omit that clause. Append `decision.reasons`. Example: `"Rejected: exit code 1. Missing output: output/result.txt. Contract: exit-0-and-required-outputs. Reasons: command failed"`. When no outputs failed: `"Rejected: exit code 1. Contract: exit-0-and-required-outputs. Reasons: command failed"`

**Rule 3 — Retry heuristic (kept, sharpened):**
- Condition: `decision.outcome === "approved" && attemptCount > 0`
- Kind: `provider_heuristic`, Scope: `workspace`
- Title: `"Required retry to pass"`
- Body: Quote the `decision.reasons` that describe what was fixed. Example: `"Succeeded after 2 attempts. Feedback that helped: All checks passed"`. Uses `decision.reasons` from the approved decision (which contains the policy gate feedback from the successful attempt).

**Rule 5 — Multi-round workflow (kept, sharpened):**
- Condition: `input.strategyResult?.rounds?.length > 1`
- Kind: `workflow`, Scope: `workspace`
- Title: `"Strategy required multiple rounds"`
- Body: Include round-by-round feedback delta. Iteration logic: for each round in `strategyResult.rounds` (a `ReadonlyArray<Map<string, RunPacketResult>>`), iterate the Map values and collect `decision.reasons` from any entry whose `decision?.outcome === "rejected"`. If no rejected decisions in a round, that round is "approved". The reviewer is identified by a unit ID ending in `-reviewer` (matching the `wrapAsStrategy` convention). Example: `"Required 2 rounds. Round 1 reviewer: missing error handling. Round 2: approved."`

**New rules:**

**Rule 6 — Forbidden-path hit (new):**
- Condition: `decision.outcome === "rejected"` AND at least one entry in `receipt.outputChecks` has `exists === false`
- Kind: `constraint`, Scope: `workspace`
- Title: `"Verification failed: ${failedOutput.path}"`
- Body: `"Output '${failedOutput.path}' was expected but missing or empty. Contract: ${packet.unit.verificationContract}"`
- Note: This fires in addition to Rule 2 (Rule 2 gives the full rejection context, Rule 6 names the specific path). A single rejected run may emit both.

**Rule 7 — Verification-gate win (new):**
- Condition: `decision.outcome === "approved"` AND `attemptCount === 0` (or undefined) AND `receipt.outputChecks.length > 0` AND all output checks passed (`every check.exists === true`)
- Kind: `fact`, Scope: `workspace`
- Title: `"Verification gate passed"`
- Body: `"All expected outputs verified on first attempt: ${receipt.outputChecks.map(c => c.path).join(', ')}"`
- This teaches the codebase's acceptance shape — what a passing run looks like.

**Summary of rules after T1:**

| # | Condition | Kind | Scope | Signal |
|---|-----------|------|-------|--------|
| 2 | Rejected | `constraint` | `session` | Exit code + failing output + contract + reasons |
| 3 | Retry succeeded | `provider_heuristic` | `workspace` | What feedback helped it pass |
| 5 | Multi-round strategy | `workflow` | `workspace` | Round-by-round reviewer feedback delta |
| 6 | Output check failed | `constraint` | `workspace` | Specific path that was missing |
| 7 | All outputs verified first try | `fact` | `workspace` | Codebase acceptance shape |

### 2. Learning Governance (T2)

#### T2.a — Schema migration

Add `seen_count` column: `ALTER TABLE run_learnings ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1`

New function `ensureSeenCountColumn(database: DatabaseSync)` in `packages/storage/src/store.ts`, following the existing `ensure*Column` pattern (uses `tableHasColumn(database, "run_learnings", "seen_count")` check, then ALTER). Called from `bootstrapStorageProjectionSchema()`.

**Type updates required:**
- `LearningRow` in `learning-store.ts` (lines 11-20): add `readonly seen_count: number`
- `StoredLearning` in `ports.ts`: add `readonly seenCount: number`
- `fetchLearnings` SELECT column list: add `seen_count` to the selected columns
- Map `row.seen_count` → `seenCount` in the fetch result mapping

#### T2.b — Dedup on write

In `learning-store.ts`, before INSERT in `writeLearnings()`:

1. Query for existing active row: `SELECT id, seen_count FROM run_learnings WHERE scope = ? AND kind = ? AND title = ? AND status = 'active' LIMIT 1`
2. If found: `UPDATE run_learnings SET body = ?, updated_at = ?, seen_count = seen_count + 1 WHERE id = ?` — update body with latest content, bump count
3. If not found: INSERT as today (with `seen_count = 1`)

This prevents N identical constraint learnings from filling the fetch window.

**Note on body overwrite:** Dedup intentionally replaces the body with the latest content. For Rule 2 (`"Run rejected"`, session-scoped), this means earlier rejection details are lost when a new rejection arrives. This is acceptable: session-scoped learnings are ephemeral, and the latest rejection is most relevant. If a session constraint gets promoted to workspace (T2.c), the promoted row captures the body at promotion time — subsequent session overwrites don't affect the promoted copy.

#### T2.c — Promotion

New method on `BuildplaneMemoryPort` in `packages/kernel/src/ports.ts`:

```typescript
promoteLearnings(runId: string): void;
```

Implementation in `learning-store.ts`:

1. Find all `session`-scoped active learnings with `seen_count >= 3`
2. For each: check if a promoted row already exists (`SELECT 1 FROM run_learnings WHERE promoted_from_id = ? AND status = 'active'`). If yes, skip (idempotent).
3. If no promoted row: INSERT new row with `scope = 'workspace'`, `promoted_from_id = original.id`, `source_run_id = runId`, `seen_count = 1`, `status = 'active'`.
4. Repeat for `workspace`-scoped active learnings with `seen_count >= 5` → promote to `scope = 'user'`.

Called from `orchestrator.ts` `finalizeRun()` in BOTH the success path AND the rejection path, after `writeLearnings`, same try/catch-swallow pattern. This ensures session constraints from repeated rejections get promoted without waiting for a success run:

```typescript
if (memoryPort) {
  try {
    // ... existing writeLearnings call ...
    memoryPort.promoteLearnings(completedRun.id);
  } catch {
    // Silent
  }
}
```

#### T2.d — Scope-ordered fetch

Replace `ORDER BY created_at DESC` in `fetchLearnings()` with:

```sql
ORDER BY
  CASE WHEN scope = 'user' THEN 3 WHEN scope = 'workspace' THEN 2 ELSE 1 END DESC,
  seen_count DESC,
  created_at DESC
```

Higher scopes and higher-utility learnings surface first.

### 3. Demo Update

`buildplane demo` reads actual learnings from the database — no hardcoded strings in the narrator. After T1, a passing command packet with `output/result.txt` will produce:

- Rule 7 (verification-gate win): `[fact] Verification gate passed: All expected outputs verified on first attempt: output/result.txt`

The demo changes from showing "2 learnings found" to "1 learning found". The integration test in `apps/cli/test/demo.test.ts` needs its assertions updated to match.

The demo's `apps/cli/src/demo.ts` does NOT need code changes — it reads from `readMemoryPort.fetchLearnings()` and displays whatever comes back. Only the test assertions change.

**Verified:** The command executor at `packages/runtime/src/command-executor.ts:47-50` populates `receipt.outputChecks` from `packet.verification.requiredOutputs`, so Rule 7 will fire for the demo's passing command packet with `requiredOutputs: ["output/result.txt"]`.

## Files Changed

| File | Track | Change |
|------|-------|--------|
| `packages/kernel/src/outcome-extractor.ts` | T1 | Rewrite rule set (drop 1+4, enrich 2+3+5, add 6+7) |
| `packages/kernel/test/outcome-extractor.test.ts` | T1 | Replace all assertions for new rules |
| `packages/storage/src/store.ts` | T2 | Add `ensureSeenCountColumn()` |
| `packages/storage/src/learning-store.ts` | T2 | Dedup in `writeLearnings`, new `promoteLearnings`, scope-ordered `fetchLearnings` |
| `packages/kernel/src/ports.ts` | T2 | Add `promoteLearnings` to `BuildplaneMemoryPort` |
| `packages/kernel/src/orchestrator.ts` | T2 | Call `promoteLearnings` after `writeLearnings` in both success and rejection paths |
| `packages/storage/test/learning-store.test.ts` | T2 | Tests for dedup, promotion, fetch ordering |
| `apps/cli/test/demo.test.ts` | T1 | Update assertions for new learning content |

## Tests

| Test File | Coverage |
|-----------|----------|
| `packages/kernel/test/outcome-extractor.test.ts` | 7 test cases: rejection enriched, retry sharpened, multi-round delta, forbidden-path hit, verification-gate win, no learnings on clean approval (no outputs), early return on retrying |
| `packages/storage/test/learning-store.test.ts` | 6 new tests: dedup updates seen_count, dedup preserves ID, promotion at threshold 3 (session→workspace), promotion at threshold 5 (workspace→user), promotion is idempotent, scope-ordered fetch returns user > workspace > session |
| `apps/cli/test/demo.test.ts` | Update: narrator shows 1 learning (verification-gate win), not 2 |

## Explicitly Out of Scope

- **LLM-assisted extraction** — keep rules pure; add LLM path only if T3 eval shows pattern rules plateau
- **Honcho write path** — Honcho stays read-only; local learning is source of truth for writes
- **Rust memory bridge** — promotion stays in TS; Rust `bp-memory` crate has `promote()` but bridging is M13+ work
- **Eval harness** — that's T3, separate spec
- **Inspect surface changes** — that's T4, separate spec

## Success Criteria

1. `extractLearnings()` with an approved run + outputChecks produces a `fact` (verification-gate win), not a noise `"Run approved"` string
2. `extractLearnings()` with a rejected run produces an enriched `constraint` naming exit code + failing output
3. `writeLearnings` with duplicate `(scope, kind, title)` increments `seen_count` instead of inserting a new row
4. `promoteLearnings` creates a workspace-scoped row when session learning hits `seen_count >= 3`
5. `fetchLearnings` returns user-scoped learnings before workspace-scoped before session-scoped
6. `buildplane demo` still passes end-to-end with updated learning content
7. All existing tests pass (with assertion updates)
