# Pack Memory Visibility Boundary Design

## Slice name

Phase 6 / Slice 6C1: shared native pack memory-visibility boundary

## Why this slice

Phase 6A human pack inspection UX already exists.
Phase 6B added structured route explanation JSON.

The next smallest justified native-boundary slice is not a broad TS-to-native memory port. It is to extract the already-stable pack-defined memory visibility policy and make it first-class across native inspection and effective-memory flows.

Today, the boundary already exists, but it is effectively hidden inside native CLI memory code.

This slice keeps scope narrow by:
- reusing existing pack manifest memory flags
- extracting one shared helper/model
- wiring that helper/model into two existing native surfaces
  - `pack show`
  - `memory ... --effective`

## Architecture

### 1. Extract a shared native memory-visibility model

Move the current pack-manifest-to-effective-memory-policy mapping out of `bp-cli` command-local code into a shared native seam.

The shared model should express whether a pack can see user/workspace/pack/session memory.

Prefer a small serializable struct such as `EffectiveMemoryPolicy` or similarly named type.

### 2. Reuse it in native effective-memory command paths

Native `memory inspect --effective` and `memory explain --effective` should continue to compute the same scope filters, but by consuming the shared helper/model instead of a CLI-local manifest mapper.

### 3. Surface it in native pack inspection

Extend pack inspection data to carry the effective-memory policy.

Human rendering should add a compact `memory visibility:` section.
JSON output should add a structured field that exposes the same policy.

### 4. Keep the slice narrow

Prefer touching only:
- the shared native seam for pack memory visibility
- `bp-cli` effective-memory wiring
- `bp-pack-inspection`
- `bp-ui-terminal`

Avoid:
- TS structured memory retrieval/injection work
- provider/host route changes
- storage/schema changes

## Likely files

### New or extracted helper location
- likely `native/crates/bp-memory/src/lib.rs` or another small native shared seam if that is the cleanest home

### Modified
- `native/crates/bp-cli/src/memory_cli.rs`
- `native/crates/bp-pack-inspection/src/lib.rs`
- `native/crates/bp-ui-terminal/src/lib.rs`
- possibly one native crate `Cargo.toml` for dependency wiring

## Verification set

Focused native tests:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
```

Suggested manual smoke:

```bash
. "$HOME/.cargo/env"
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --json
cargo run --manifest-path native/Cargo.toml -p bp-cli -- memory explain --effective --pack superclaude --json
```

## Non-goals

- no TS packet-enrichment native port
- no route-selection changes
- no new pack commands
- no native execution expansion
- no published installer/provisioning work
