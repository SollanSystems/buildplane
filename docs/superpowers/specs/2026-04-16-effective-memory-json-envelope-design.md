# Effective Memory JSON Envelope Design

## Slice name

Phase 6 / Slice 6C3: self-describing effective-memory JSON envelopes

## Why this slice

After 6C1 and 6C2:
- native pack inspection already exposes `effectiveMemoryPolicy`
- effective-memory execution already uses the shared native policy seam
- explicit native/workspace roots are now handled correctly

The remaining smallest trust gap is JSON shape:
- `memory inspect --effective --json` and `memory explain --effective --json` still serialize bare arrays
- automation cannot tell which roots or policy produced those arrays without separately reconstructing command context

This slice is smaller than any new native migration because it stays inside the existing memory CLI boundary.

## Architecture

### 1. Add narrow JSON envelope structs in `memory_cli.rs`

Define small serializable structs for:
- effective inspect JSON output
- effective explain JSON output

Recommended fields:
- `nativeRoot`
- `workspaceRoot`
- `packId`
- `sessionId`
- `includeForgotten`
- `effectiveMemoryPolicy`
- payload array (`items` or `explanations`)

Keep these local to the native CLI unless reuse emerges later.

### 2. Reuse the existing shared effective-memory policy seam

Do not recompute policy ad hoc.

Continue using:
- `bp_pack_inspection::effective_memory_policy_for_pack(...)`

The envelope should simply surface the already-used policy.

### 3. Keep human output unchanged

Only the `--json` effective-memory paths should change shape.

Human `memory inspect --effective` and `memory explain --effective` should remain exactly as they are today.

### 4. Focus tests on contract, not implementation detail

Add focused tests that prove:
- inspect effective JSON is an object with the expected fields
- explain effective JSON is an object with the expected fields
- a non-default pack policy is reflected in the envelope
- the envelope roots match the actual execution roots

## Likely files

### Modified
- `native/crates/bp-cli/src/memory_cli.rs`
- planning docs for this slice

## Verification set

Focused native tests:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no human-output changes
- no pack inspection JSON/schema changes
- no storage changes
- no TS CLI work
