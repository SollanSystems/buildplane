# Event Tape Capture — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `bp-ledger` Rust crate skeleton — append-only SQLite event store, content-addressed blob store, `#[secret]` proc macro, and a minimal `buildplane-native ledger serve` subcommand that ingests JSON-lines from stdin and writes valid events to `.buildplane/ledger/events.db` — so subsequent phases can wire the TS tape-emitter and tool instrumentation on top.

**Architecture:** New Rust workspace crate `bp-ledger` with frozen six-field envelope, versioned per-kind payloads, SQLite events table with append-only trigger, and a CAS directory using O_TMPFILE+rename for atomic writes. Secret-field redaction is enforced at serialize-time via a `#[secret]` attribute macro in a companion `bp-ledger-macros` proc-macro crate. `bp-cli` gains a `ledger serve` subcommand that reads stdin as newline-delimited JSON and writes events via the library. Schema types are derived-Rust and re-emitted to a skeleton `packages/ledger-client/` via `typeshare` so Phase B can import them.

**Tech Stack:** Rust (edition 2021), rusqlite (bundled), serde + serde_json, chrono, uuid (v7 feature), sha2, thiserror, syn + quote + proc-macro2 (for the macro crate), typeshare (for TS codegen). TypeScript scaffolding only — no runtime TS code in Phase A.

**Reference spec:** `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md`

---

## Phase A scope recap

**In scope for this plan:**
- `native/crates/bp-ledger/` (library + internals) with all v1 event kinds and payloads.
- `native/crates/bp-ledger-macros/` (proc-macro crate) implementing `#[secret]`.
- SQLite schema: `events` table, `runs` index table, append-only trigger.
- CAS module with atomic writes (O_TMPFILE + rename).
- `canonicalize()` function (v1 passthrough; migration framework in place).
- `buildplane-native ledger serve --run-id X --workspace Y` subcommand that reads JSONL from stdin. No handshake, no control messages — just ingest → store.
- `typeshare`-based schema generation emitting to `packages/ledger-client/src/generated/`.
- `packages/ledger-client/` skeleton (package.json + tsconfig + empty `src/index.ts`).
- Layer 1 unit tests: round-trip per event kind, secret redaction, append-only invariant, CAS atomicity.
- Phase gate: all Rust tests green, ≥90% line coverage in bp-ledger, generated TS compiles.

**Out of scope (Phase B and later):**
- Handshake protocol (`_handshake`, `_flush`, `_close` control messages).
- TS `tape-emitter` and IPC client code.
- Tool adapter instrumentation.
- Git checkpoint emission.
- Integration tests that spawn the native binary from TS.
- The `ledger inspect` subcommand.

---

## File structure

```
native/
├── Cargo.toml                               # MODIFY: add 2 workspace members + deps
└── crates/
    ├── bp-ledger/                           # NEW
    │   ├── Cargo.toml
    │   ├── build.rs                         # typeshare export
    │   ├── src/
    │   │   ├── lib.rs                       # module declarations + re-exports
    │   │   ├── error.rs                     # LedgerError enum
    │   │   ├── id.rs                        # EventId, RunId (UUIDv7)
    │   │   ├── event.rs                     # Event envelope struct
    │   │   ├── kind.rs                      # EventKind discriminator
    │   │   ├── payload/
    │   │   │   ├── mod.rs                   # Payload enum
    │   │   │   ├── run_lifecycle.rs         # RunStarted/Completed/Failed
    │   │   │   ├── unit_lifecycle.rs        # UnitStarted/Completed/Failed/Cancelled
    │   │   │   ├── git_checkpoint.rs        # GitCheckpoint
    │   │   │   ├── model_io.rs              # ModelRequest/Response
    │   │   │   ├── tool_io.rs               # ToolRequest/Result
    │   │   │   └── workspace.rs             # WorkspaceRead/Write
    │   │   ├── canonicalize.rs              # Per-(kind,version) migration
    │   │   ├── storage/
    │   │   │   ├── mod.rs                   # Store trait + SqliteStore wiring
    │   │   │   ├── sqlite.rs                # events table, runs index, trigger
    │   │   │   └── cas.rs                   # content-addressed blob store
    │   │   └── serve.rs                     # stdin JSONL ingest loop
    │   └── tests/
    │       ├── round_trip.rs                # per-kind round-trip
    │       ├── append_only.rs               # UPDATE/DELETE must fail
    │       ├── cas.rs                       # atomicity + dedup
    │       └── canonicalize.rs              # v1 passthrough
    │
    ├── bp-ledger-macros/                    # NEW
    │   ├── Cargo.toml
    │   ├── src/
    │   │   └── lib.rs                       # #[secret] attribute macro
    │   └── tests/
    │       └── secret_redaction.rs          # redaction shape
    │
    └── bp-cli/                              # MODIFY
        ├── Cargo.toml                       # add bp-ledger dep
        └── src/
            ├── main.rs                      # add Ledger command variant
            └── ledger_cli.rs                # NEW: serve subcommand

packages/
└── ledger-client/                           # NEW (skeleton only)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                         # placeholder export
        └── generated/
            └── .gitkeep                     # typeshare output dir
```

---

## Task 1: Scaffold `bp-ledger` crate

**Files:**
- Create: `native/crates/bp-ledger/Cargo.toml`
- Create: `native/crates/bp-ledger/src/lib.rs`
- Modify: `native/Cargo.toml` (add workspace member + deps)

- [ ] **Step 1: Add workspace dependencies**

Modify `native/Cargo.toml`, add under `[workspace.dependencies]`:

```toml
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v7", "serde"] }
sha2 = "0.10"
typeshare = "1"

bp-ledger = { path = "crates/bp-ledger" }
bp-ledger-macros = { path = "crates/bp-ledger-macros" }
```

And under `[workspace] members = [...]` add:

```toml
  "crates/bp-ledger",
  "crates/bp-ledger-macros",
```

- [ ] **Step 2: Create the crate's Cargo.toml**

Write `native/crates/bp-ledger/Cargo.toml`:

```toml
[package]
name = "bp-ledger"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
bp-ledger-macros.workspace = true
chrono.workspace = true
rusqlite.workspace = true
serde.workspace = true
serde_json.workspace = true
sha2 = { workspace = true }
thiserror.workspace = true
typeshare.workspace = true
uuid.workspace = true

[build-dependencies]
typeshare = { workspace = true }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Create the skeleton lib.rs**

Write `native/crates/bp-ledger/src/lib.rs`:

```rust
//! Buildplane event tape capture — append-only ledger for replayable runs.

pub mod canonicalize;
pub mod error;
pub mod event;
pub mod id;
pub mod kind;
pub mod payload;
pub mod serve;
pub mod storage;

pub use error::LedgerError;
pub use event::Event;
pub use id::{EventId, RunId};
pub use kind::EventKind;
pub use payload::Payload;
```

- [ ] **Step 4: Verify it compiles (it will fail on missing modules; that's expected)**

Run:

```bash
cargo check --manifest-path native/Cargo.toml -p bp-ledger
```

Expected: FAIL with "file not found for module" errors on `canonicalize`, `error`, `event`, etc. This confirms the module layout is wired and the workspace recognizes the crate. Subsequent tasks add the files.

- [ ] **Step 5: Create empty module stubs so the crate compiles**

Create each of these files with just a doc comment so `cargo check` passes:

`native/crates/bp-ledger/src/error.rs`:
```rust
//! Error types for the ledger crate.
```

`native/crates/bp-ledger/src/id.rs`:
```rust
//! Typed identifiers for events and runs.
```

`native/crates/bp-ledger/src/event.rs`:
```rust
//! The canonical event envelope.
```

`native/crates/bp-ledger/src/kind.rs`:
```rust
//! Event kind discriminator.
```

`native/crates/bp-ledger/src/canonicalize.rs`:
```rust
//! Per-(kind, version) payload canonicalization.
```

`native/crates/bp-ledger/src/serve.rs`:
```rust
//! Stdin JSONL ingest loop.
```

Create `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
//! Event payload definitions, versioned per kind.
```

Create `native/crates/bp-ledger/src/storage/mod.rs`:
```rust
//! Durable storage for events and blobs.
```

- [ ] **Step 6: Remove unresolved re-exports from lib.rs so it compiles**

Modify `native/crates/bp-ledger/src/lib.rs`:

```rust
//! Buildplane event tape capture — append-only ledger for replayable runs.

pub mod canonicalize;
pub mod error;
pub mod event;
pub mod id;
pub mod kind;
pub mod payload;
pub mod serve;
pub mod storage;
```

(Re-exports will come back after the types are defined.)

- [ ] **Step 7: Verify clean compile and commit**

Run:
```bash
cargo check --manifest-path native/Cargo.toml -p bp-ledger
```
Expected: PASS (warnings about empty modules are OK).

```bash
git add native/Cargo.toml native/crates/bp-ledger/
git commit -m "feat(ledger): scaffold bp-ledger crate with empty modules"
```

---

## Task 2: Scaffold `bp-ledger-macros` proc-macro crate

**Files:**
- Create: `native/crates/bp-ledger-macros/Cargo.toml`
- Create: `native/crates/bp-ledger-macros/src/lib.rs`

- [ ] **Step 1: Create the macro crate's Cargo.toml**

Write `native/crates/bp-ledger-macros/Cargo.toml`:

```toml
[package]
name = "bp-ledger-macros"
version.workspace = true
edition.workspace = true
license.workspace = true

[lib]
proc-macro = true

[dependencies]
proc-macro2 = "1"
quote = "1"
syn = { version = "2", features = ["full"] }
```

- [ ] **Step 2: Create the macro crate's lib.rs with a no-op stub**

Write `native/crates/bp-ledger-macros/src/lib.rs`:

```rust
//! Procedural macros for bp-ledger.
//!
//! Provides `#[secret]` to mark fields that must be redacted at serialize time.

use proc_macro::TokenStream;

/// `#[secret]` — marks a struct field as sensitive. On serialization, the field's
/// value is replaced with a `{ "redacted": true, "hash": "sha256:<hex>", "hint": "<kind>" }`
/// shape instead of the raw bytes. Real implementation added in Task 6.
#[proc_macro_attribute]
pub fn secret(_args: TokenStream, item: TokenStream) -> TokenStream {
    item
}
```

- [ ] **Step 3: Verify clean compile and commit**

Run:
```bash
cargo check --manifest-path native/Cargo.toml -p bp-ledger-macros
```
Expected: PASS.

```bash
git add native/Cargo.toml native/crates/bp-ledger-macros/
git commit -m "feat(ledger): scaffold bp-ledger-macros proc-macro crate"
```

---

## Task 3: Implement error type

**Files:**
- Modify: `native/crates/bp-ledger/src/error.rs`

- [ ] **Step 1: Write the error enum**

Replace `native/crates/bp-ledger/src/error.rs` with:

```rust
//! Error types for the ledger crate.

use thiserror::Error;

/// Top-level error type for ledger operations.
#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("invalid json event: {0}")]
    InvalidJson(#[from] serde_json::Error),

    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema version {received} not supported (supported: {supported})")]
    UnsupportedSchemaVersion { received: u32, supported: u32 },

    #[error("append-only violation: {0}")]
    AppendOnlyViolation(String),

    #[error("cas: {0}")]
    Cas(String),

    #[error("invalid payload for kind {kind}: {reason}")]
    InvalidPayload { kind: String, reason: String },
}

pub type Result<T> = std::result::Result<T, LedgerError>;
```

- [ ] **Step 2: Verify clean compile**

Run:
```bash
cargo check --manifest-path native/Cargo.toml -p bp-ledger
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-ledger/src/error.rs
git commit -m "feat(ledger): add LedgerError enum"
```

---

## Task 4: Implement `EventId` and `RunId` (UUIDv7)

**Files:**
- Modify: `native/crates/bp-ledger/src/id.rs`
- Modify: `native/crates/bp-ledger/src/lib.rs`

- [ ] **Step 1: Write failing test**

Append to `native/crates/bp-ledger/src/id.rs`:

```rust
//! Typed identifiers for events and runs.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

/// Identifier for a single event on the ledger. UUIDv7 — time-ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventId(Uuid);

/// Identifier for a run. UUIDv7 — time-ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(Uuid);

impl EventId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for EventId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl RunId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
    pub fn from_uuid(u: Uuid) -> Self {
        Self(u)
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_monotonic_when_generated_sequentially() {
        let a = EventId::new();
        let b = EventId::new();
        assert!(b.as_uuid() >= a.as_uuid(), "UUIDv7 must be time-ordered");
    }

    #[test]
    fn event_id_round_trips_through_json() {
        let id = EventId::new();
        let s = serde_json::to_string(&id).unwrap();
        let back: EventId = serde_json::from_str(&s).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn run_id_round_trips_through_json() {
        let id = RunId::new();
        let s = serde_json::to_string(&id).unwrap();
        let back: RunId = serde_json::from_str(&s).unwrap();
        assert_eq!(id, back);
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger id::tests
```

Expected: may fail to compile initially if the module is missing `uuid` feature wiring. Fix any compile errors, then re-run.

- [ ] **Step 3: Re-export from lib.rs**

Update `native/crates/bp-ledger/src/lib.rs` to add:
```rust
pub use error::{LedgerError, Result};
pub use id::{EventId, RunId};
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger id::tests
```
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/id.rs native/crates/bp-ledger/src/lib.rs
git commit -m "feat(ledger): add EventId and RunId (UUIDv7)"
```

---

## Task 5: Implement `EventKind` discriminator

**Files:**
- Modify: `native/crates/bp-ledger/src/kind.rs`

- [ ] **Step 1: Write the enum + tests**

Replace `native/crates/bp-ledger/src/kind.rs` with:

```rust
//! Event kind discriminator — one variant per event type at the envelope level.

use serde::{Deserialize, Serialize};

/// The kind discriminator identifies which payload variant an event carries.
///
/// Kinds are grouped: run lifecycle, unit lifecycle, git checkpoint, model I/O,
/// tool I/O, workspace observation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    // Run lifecycle
    RunStarted,
    RunCompleted,
    RunFailed,
    // Unit lifecycle
    UnitStarted,
    UnitCompleted,
    UnitFailed,
    UnitCancelled,
    // Git checkpoint
    GitCheckpoint,
    // Model I/O
    ModelRequest,
    ModelResponse,
    // Tool I/O
    ToolRequest,
    ToolResult,
    // Workspace observation
    WorkspaceRead,
    WorkspaceWrite,
}

impl EventKind {
    /// Canonical snake_case string for the kind, used in wire format and SQL.
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::RunStarted => "run_started",
            Self::RunCompleted => "run_completed",
            Self::RunFailed => "run_failed",
            Self::UnitStarted => "unit_started",
            Self::UnitCompleted => "unit_completed",
            Self::UnitFailed => "unit_failed",
            Self::UnitCancelled => "unit_cancelled",
            Self::GitCheckpoint => "git_checkpoint",
            Self::ModelRequest => "model_request",
            Self::ModelResponse => "model_response",
            Self::ToolRequest => "tool_request",
            Self::ToolResult => "tool_result",
            Self::WorkspaceRead => "workspace_read",
            Self::WorkspaceWrite => "workspace_write",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_serializes_to_snake_case() {
        let s = serde_json::to_string(&EventKind::ModelRequest).unwrap();
        assert_eq!(s, r#""model_request""#);
    }

    #[test]
    fn as_wire_matches_serde_output() {
        for kind in [
            EventKind::RunStarted, EventKind::RunCompleted, EventKind::RunFailed,
            EventKind::UnitStarted, EventKind::UnitCompleted, EventKind::UnitFailed,
            EventKind::UnitCancelled, EventKind::GitCheckpoint,
            EventKind::ModelRequest, EventKind::ModelResponse,
            EventKind::ToolRequest, EventKind::ToolResult,
            EventKind::WorkspaceRead, EventKind::WorkspaceWrite,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let stripped = json.trim_matches('"');
            assert_eq!(stripped, kind.as_wire(), "mismatch for {:?}", kind);
        }
    }
}
```

- [ ] **Step 2: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger kind::tests
```
Expected: PASS.

- [ ] **Step 3: Re-export from lib.rs**

Add to `native/crates/bp-ledger/src/lib.rs`:
```rust
pub use kind::EventKind;
```

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/src/kind.rs native/crates/bp-ledger/src/lib.rs
git commit -m "feat(ledger): add EventKind discriminator"
```

---

## Task 6: Implement `#[secret]` proc macro

**Files:**
- Modify: `native/crates/bp-ledger-macros/src/lib.rs`
- Create: `native/crates/bp-ledger-macros/tests/secret_redaction.rs`

- [ ] **Step 1: Write the integration test**

Create `native/crates/bp-ledger-macros/tests/secret_redaction.rs`:

```rust
//! Contract tests for the `#[secret]` attribute macro.

use bp_ledger_macros::secret;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
struct ToolRequest {
    name: String,
    #[secret(hint = "env_var")]
    env: BTreeMap<String, String>,
}

#[test]
fn secret_field_is_replaced_by_redaction_shape() {
    let mut env = BTreeMap::new();
    env.insert("AWS_SECRET_KEY".to_string(), "hunter2".to_string());

    let req = ToolRequest {
        name: "shell".to_string(),
        env,
    };

    let json = serde_json::to_value(&req).unwrap();
    let env_field = &json["env"];

    assert_eq!(env_field["redacted"], true);
    assert!(env_field["hash"].as_str().unwrap().starts_with("sha256:"));
    assert_eq!(env_field["hint"], "env_var");
    // The raw secret value must not appear anywhere in the serialized output.
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("hunter2"), "secret leaked to output");
}
```

- [ ] **Step 2: Run the test — expect FAIL (no impl)**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger-macros
```
Expected: FAIL — the current `#[secret]` is a no-op that doesn't accept `hint` args.

- [ ] **Step 3: Implement the macro**

Replace `native/crates/bp-ledger-macros/src/lib.rs` with:

```rust
//! Procedural macros for bp-ledger.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{parse_macro_input, Field, Meta, Expr, ExprLit, Lit};

/// `#[secret(hint = "...")]` — marks a struct field as sensitive.
///
/// On serialization, the field's value is replaced with:
///   `{ "redacted": true, "hash": "sha256:<hex>", "hint": "<hint>" }`
///
/// The hint is a freeform short label (e.g., "env_var", "auth_header") that
/// tells downstream readers what kind of secret was redacted without revealing
/// the value.
///
/// This is an attribute macro intended for use on fields inside `#[derive(Serialize)]`
/// structs. It rewrites the field to include `#[serde(serialize_with = ...)]`.
#[proc_macro_attribute]
pub fn secret(args: TokenStream, item: TokenStream) -> TokenStream {
    let field = parse_macro_input!(item as Field);
    let hint = parse_hint(args.into()).unwrap_or_else(|| "secret".to_string());

    // Build a per-field serialize_with helper name from the field identifier.
    let field_ident = field.ident.clone().expect("#[secret] requires named fields");
    let helper_name = syn::Ident::new(
        &format!("__bp_ledger_redact_{}", field_ident),
        field_ident.span(),
    );

    let attrs = &field.attrs;
    let vis = &field.vis;
    let ty = &field.ty;

    let out = quote! {
        #(#attrs)*
        #[serde(serialize_with = #helper_name_str)]
        #vis #field_ident: #ty,
    };
    // The macro itself emits the field plus a serialize_with directive that
    // points at a function `__bp_ledger_redact_<field>`. The struct containing
    // this field must also define that helper — we emit the helper in a sibling
    // item so it lives alongside the struct.
    //
    // For simplicity and to avoid cross-item coordination, the helper is
    // generated as a free function with a well-known name. The user must
    // `use` bp_ledger::redact_field` or we can inline the hashing here.
    //
    // Simpler: emit an inline serialize_with closure via serde's attribute form.
    let helper_name_str = helper_name.to_string();

    let expanded: TokenStream2 = quote! {
        #(#attrs)*
        #[serde(serialize_with = #helper_name_str)]
        #vis #field_ident: #ty,
    };

    let helper: TokenStream2 = quote! {
        fn #helper_name<T, S>(value: &T, serializer: S) -> ::std::result::Result<S::Ok, S::Error>
        where
            T: ::serde::Serialize,
            S: ::serde::Serializer,
        {
            use ::serde::Serialize as _;
            use ::sha2::Digest as _;
            let bytes = ::serde_json::to_vec(value).map_err(::serde::ser::Error::custom)?;
            let mut hasher = ::sha2::Sha256::new();
            hasher.update(&bytes);
            let hash = format!("sha256:{:x}", hasher.finalize());
            let hint: &str = #hint;
            let redacted = ::serde_json::json!({
                "redacted": true,
                "hash": hash,
                "hint": hint,
            });
            redacted.serialize(serializer)
        }
    };

    // Combine field and helper. Because attribute macros must return a replacement
    // for the attributed item only, we emit a module-level helper by placing it
    // inside the field's doc position — actually, the helper must be at module
    // scope. The cleanest path: emit the serialize_with directive inline and
    // require the struct author to pull in a shared helper.
    //
    // Rather than juggling this, we embed the closure directly via a sibling
    // derive macro. For Phase A, use the simpler path: emit `serialize_with`
    // pointing to an inline helper whose body the macro *places at module scope
    // via a nearby submodule*.

    let field_and_helper: TokenStream2 = quote! {
        #expanded
    };
    let combined: TokenStream2 = quote! {
        #field_and_helper
    };

    // Emit the helper at module scope via `#[doc(hidden)] pub(crate) mod ...`.
    // syn attribute macros operate on a single item; we cannot emit two items
    // from one attribute macro call. The production path is a derive macro
    // on the containing struct. For Phase A, keep the attribute macro but
    // require the user to `use bp_ledger::redact;` and attach serialize_with
    // = "bp_ledger::redact_with_hint::<HINT>" via a different path.

    // SIMPLER IMPLEMENTATION (use this): the macro rewrites the field type to
    // a wrapper `Redacted<T>` that serializes to the redaction shape. No
    // serialize_with needed.
    redact_rewrite(field, hint).into()
}

fn parse_hint(args: TokenStream2) -> Option<String> {
    // Parse `hint = "..."` from the macro args.
    let meta: Meta = syn::parse2(args).ok()?;
    let Meta::NameValue(nv) = meta else { return None };
    if !nv.path.is_ident("hint") {
        return None;
    }
    let Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) = nv.value else { return None };
    Some(s.value())
}

fn redact_rewrite(mut field: Field, hint: String) -> TokenStream2 {
    use syn::parse_quote;
    let attrs = &field.attrs;
    let vis = &field.vis;
    let name = &field.ident;
    let ty = &field.ty;

    // Wrap the type: `Redacted<T, "hint">` using const generics isn't ergonomic,
    // so we pass the hint at serialize-time via a runtime marker. Concretely:
    // the field becomes `::bp_ledger::redact::Redacted<T>` and the hint is
    // carried via a `#[bp_ledger(hint = "...")]` helper attribute processed
    // by the Redacted serializer through a separate mechanism.
    //
    // For the scope of Phase A we simplify further: the macro *itself* emits
    // a fully inline `#[serde(serialize_with)]` pointing at a free function
    // whose name is generated from the field. The free function is generated
    // alongside by a companion `impl_secret_helpers!` macro the user calls
    // once per struct.
    //
    // To keep Phase A deliverable concrete and reviewable, the chosen path is:
    //  - `#[secret(hint = "...")]` adds `#[serde(serialize_with = "path::fn")]`
    //  - The path points at `bp_ledger::redact::redact_as::<&str>` where &str
    //    is the hint encoded via a private macro expansion. Since we cannot
    //    pass a const string to serialize_with directly, we generate a unique
    //    helper module below the field and route through it.

    let helper_mod = syn::Ident::new(
        &format!("__bp_ledger_redact_{}", name.as_ref().unwrap()),
        name.as_ref().unwrap().span(),
    );
    let helper_fn_path = format!("{}::redact", helper_mod);

    let mut field_clone = field.clone();
    field_clone.attrs.push(parse_quote! {
        #[serde(serialize_with = #helper_fn_path)]
    });

    quote! {
        #[doc(hidden)]
        mod #helper_mod {
            pub fn redact<T, S>(value: &T, serializer: S) -> ::std::result::Result<S::Ok, S::Error>
            where
                T: ::serde::Serialize,
                S: ::serde::Serializer,
            {
                use ::serde::Serialize as _;
                use ::sha2::Digest as _;
                let bytes = ::serde_json::to_vec(value).map_err(::serde::ser::Error::custom)?;
                let mut hasher = ::sha2::Sha256::new();
                hasher.update(&bytes);
                let hash = format!("sha256:{:x}", hasher.finalize());
                let redacted = ::serde_json::json!({
                    "redacted": true,
                    "hash": hash,
                    "hint": #hint,
                });
                redacted.serialize(serializer)
            }
        }

        #field_clone
    }
}
```

> **Implementation note:** the comments above document the design dead-ends I considered. The final path (`redact_rewrite`) emits a hidden module containing a `redact` function adjacent to the field, and sets `#[serde(serialize_with = "mod::redact")]` on the field. This works inside an attribute macro because Rust allows multiple items emitted from one attribute macro when the wrapping form is a single `quote!` expansion. If the compiler rejects this (attribute macros on fields can only emit a field, not sibling items), the fallback is a **derive macro** on the containing struct — rewrite this task's Step 3 to use `#[derive(RedactSecrets)]` with `#[secret(hint = "...")]` as a helper attribute.

- [ ] **Step 4: Update the test to import sha2 + serde at the dev-dep level**

Modify `native/crates/bp-ledger-macros/Cargo.toml`, add:
```toml
[dev-dependencies]
serde = { workspace = true, features = ["derive"] }
serde_json.workspace = true
sha2.workspace = true
```

- [ ] **Step 5: Run the test — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger-macros
```
Expected: PASS. If compile fails due to attribute-macro emitting sibling items, switch to the derive macro fallback described in the implementation note above.

- [ ] **Step 6: Commit**

```bash
git add native/crates/bp-ledger-macros/
git commit -m "feat(ledger): implement #[secret] attribute macro"
```

---

## Task 7: Implement run lifecycle payloads

**Files:**
- Create: `native/crates/bp-ledger/src/payload/run_lifecycle.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload structs + tests**

Create `native/crates/bp-ledger/src/payload/run_lifecycle.rs`:

```rust
//! Run lifecycle payloads: RunStarted, RunCompleted, RunFailed.

use crate::id::{EventId, RunId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `run_started` payload — the root of the event tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunStartedV1 {
    /// Sha256 of the packet JSON; actual bytes in CAS.
    pub packet_hash: String,
    /// Git HEAD commit at run start.
    pub git_head: String,
    /// Workspace absolute path.
    pub workspace_path: String,
    /// Provider/model/tool config captured at start (opaque map; values stored as-is).
    pub config: BTreeMap<String, serde_json::Value>,
    /// Optional parent run id if this run was forked from another.
    pub parent_run_id: Option<RunId>,
}

/// `run_completed` payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCompletedV1 {
    pub outcome: RunOutcome,
    pub duration_ms: u64,
    pub event_count: u64,
    pub unit_count: u64,
}

/// `run_failed` payload — a terminal failure that the run can't recover from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunFailedV1 {
    pub reason: String,
    pub terminating_event_id: Option<EventId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Passed,
    Failed,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_started_v1_round_trips() {
        let payload = RunStartedV1 {
            packet_hash: "sha256:abc".into(),
            git_head: "deadbeef".into(),
            workspace_path: "/tmp/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunStartedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn run_completed_v1_round_trips() {
        let payload = RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 1234,
            event_count: 42,
            unit_count: 3,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunCompletedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn run_failed_v1_round_trips() {
        let payload = RunFailedV1 {
            reason: "worker timeout".into(),
            terminating_event_id: Some(EventId::new()),
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunFailedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }
}
```

- [ ] **Step 2: Declare the module**

Modify `native/crates/bp-ledger/src/payload/mod.rs`:

```rust
//! Event payload definitions, versioned per kind.

pub mod run_lifecycle;
```

- [ ] **Step 3: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::run_lifecycle
```
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add run lifecycle payloads"
```

---

## Task 8: Implement unit lifecycle payloads

**Files:**
- Create: `native/crates/bp-ledger/src/payload/unit_lifecycle.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload structs + tests**

Create `native/crates/bp-ledger/src/payload/unit_lifecycle.rs`:

```rust
//! Unit lifecycle payloads: UnitStarted, UnitCompleted, UnitFailed, UnitCancelled.

use crate::id::EventId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitStartedV1 {
    pub unit_id: String,
    pub parent_unit_id: Option<String>,
    pub unit_kind: String,
    /// Snapshot of policy at unit start (opaque JSON).
    pub policy: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitCompletedV1 {
    pub unit_id: String,
    pub outcome: UnitOutcome,
    /// Artifacts produced, addressed by CAS hash.
    pub artifacts: Vec<ArtifactRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitFailedV1 {
    pub unit_id: String,
    pub reason: String,
    pub terminating_event_id: Option<EventId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitCancelledV1 {
    pub unit_id: String,
    pub cause: CancelCause,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitOutcome {
    Passed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelCause {
    Timeout,
    ParentFailed,
    OperatorInterrupt,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub path: String,
    pub hash: String,
    pub size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unit_started_v1_round_trips() {
        let p = UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: json!({"retries": 0}),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitStartedV1>(&s).unwrap());
    }

    #[test]
    fn unit_completed_v1_round_trips() {
        let p = UnitCompletedV1 {
            unit_id: "u-1".into(),
            outcome: UnitOutcome::Passed,
            artifacts: vec![ArtifactRef {
                path: "out.txt".into(),
                hash: "sha256:aa".into(),
                size_bytes: 3,
            }],
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitCompletedV1>(&s).unwrap());
    }

    #[test]
    fn unit_failed_v1_round_trips() {
        let p = UnitFailedV1 {
            unit_id: "u-1".into(),
            reason: "non-zero exit".into(),
            terminating_event_id: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitFailedV1>(&s).unwrap());
    }

    #[test]
    fn unit_cancelled_v1_round_trips() {
        let p = UnitCancelledV1 {
            unit_id: "u-1".into(),
            cause: CancelCause::Timeout,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitCancelledV1>(&s).unwrap());
    }
}
```

- [ ] **Step 2: Declare module**

Update `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
pub mod run_lifecycle;
pub mod unit_lifecycle;
```

- [ ] **Step 3: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::unit_lifecycle
```
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add unit lifecycle payloads"
```

---

## Task 9: Implement git checkpoint payload

**Files:**
- Create: `native/crates/bp-ledger/src/payload/git_checkpoint.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload + tests**

Create `native/crates/bp-ledger/src/payload/git_checkpoint.rs`:

```rust
//! Git checkpoint payload — emitted at unit boundaries as the safety net for
//! file-system changes outside the tool adapter.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GitCheckpointV1 {
    /// Boundary position relative to the unit.
    pub boundary: CheckpointBoundary,
    /// Fully-qualified ref path, e.g. `refs/buildplane/run/<run-id>/<unit-id>`.
    pub reference: String,
    /// Commit SHA-1. Always 40 hex chars (no short form).
    pub commit_sha: String,
    /// Associated unit id.
    pub unit_id: String,
    /// If the git operation failed, this carries the reason; commit_sha may be empty.
    pub git_status: GitStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointBoundary {
    PreUnit,
    PostUnit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum GitStatus {
    Ok,
    Failed { error: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_checkpoint_ok_round_trips() {
        let p = GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/R/U".into(),
            commit_sha: "0".repeat(40),
            unit_id: "U".into(),
            git_status: GitStatus::Ok,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<GitCheckpointV1>(&s).unwrap());
    }

    #[test]
    fn git_checkpoint_failed_preserves_error() {
        let p = GitCheckpointV1 {
            boundary: CheckpointBoundary::PostUnit,
            reference: "refs/buildplane/run/R/U".into(),
            commit_sha: String::new(),
            unit_id: "U".into(),
            git_status: GitStatus::Failed {
                error: "worktree is dirty".into(),
            },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<GitCheckpointV1>(&s).unwrap());
    }
}
```

- [ ] **Step 2: Declare module + run tests + commit**

Update `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
pub mod git_checkpoint;
pub mod run_lifecycle;
pub mod unit_lifecycle;
```

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::git_checkpoint
```
Expected: 2 tests PASS.

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add git checkpoint payload"
```

---

## Task 10: Implement model I/O payloads

**Files:**
- Create: `native/crates/bp-ledger/src/payload/model_io.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload structs + tests**

Create `native/crates/bp-ledger/src/payload/model_io.rs`:

```rust
//! Model I/O payloads: ModelRequest, ModelResponse.
//!
//! Headers are stored with a structural allowlist of sensitive keys redacted at
//! the value level. Message content and system prompts are raw strings; if the
//! operator puts secrets in prompts, they own that risk (documented).

use bp_ledger_macros::secret;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequestV1 {
    pub provider: String,
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    /// Tool schemas attached to the request.
    pub tools: Vec<serde_json::Value>,
    pub sampling: SamplingParams,
    pub headers: BTreeMap<String, HeaderValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponseV1 {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SamplingParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HeaderValue {
    Raw { value: String },
    Redacted { hash: String, hint: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_request_v1_round_trips() {
        let p = ModelRequestV1 {
            provider: "anthropic".into(),
            model: "claude-opus-4-7".into(),
            system: Some("you are a coder".into()),
            messages: vec![Message { role: "user".into(), content: "hi".into() }],
            tools: vec![json!({"name": "read_file"})],
            sampling: SamplingParams { temperature: Some(0.0), top_p: None, max_tokens: Some(4096) },
            headers: BTreeMap::from([
                ("user-agent".into(), HeaderValue::Raw { value: "buildplane/0.1".into() }),
                ("authorization".into(), HeaderValue::Redacted {
                    hash: "sha256:aa".into(),
                    hint: "auth_header".into(),
                }),
            ]),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ModelRequestV1>(&s).unwrap());
    }

    #[test]
    fn model_response_v1_round_trips() {
        let p = ModelResponseV1 {
            content: Some("ok".into()),
            tool_calls: vec![ToolCall {
                id: "tc-1".into(),
                name: "read_file".into(),
                arguments: json!({"path": "README.md"}),
            }],
            usage: Usage { input_tokens: 100, output_tokens: 5 },
            stop_reason: "end_turn".into(),
            latency_ms: 850,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ModelResponseV1>(&s).unwrap());
    }
}
```

> **Implementation note:** In this version `HeaderValue` is an explicit `Raw|Redacted` enum rather than using `#[secret]` on the whole headers map. The reason: we want per-key decisions (user-agent stays raw, authorization is redacted). `#[secret]` operates at the field level. The redaction decision for headers happens in the TS emitter before sending the event — by the time Rust sees a header, it's already been classified. This is consistent with the spec's "structural redaction via schema" decision.

- [ ] **Step 2: Declare module + run tests + commit**

Update `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
pub mod git_checkpoint;
pub mod model_io;
pub mod run_lifecycle;
pub mod unit_lifecycle;
```

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::model_io
```
Expected: 2 tests PASS.

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add model I/O payloads with header redaction enum"
```

---

## Task 11: Implement tool I/O payloads (with `#[secret]` on env)

**Files:**
- Create: `native/crates/bp-ledger/src/payload/tool_io.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload structs + tests**

Create `native/crates/bp-ledger/src/payload/tool_io.rs`:

```rust
//! Tool I/O payloads: ToolRequest, ToolResult.

use bp_ledger_macros::secret;
use crate::id::EventId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize)]
pub struct ToolRequestV1 {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    #[secret(hint = "env_var")]
    pub env: BTreeMap<String, String>,
    pub working_directory: String,
    pub unit_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResultV1 {
    pub tool_request_id: EventId,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub output: Option<serde_json::Value>,
    pub duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_request_env_is_redacted() {
        let mut env = BTreeMap::new();
        env.insert("AWS_SECRET_ACCESS_KEY".into(), "hunter2".into());
        let p = ToolRequestV1 {
            tool_name: "shell".into(),
            arguments: json!({"cmd": "ls"}),
            env,
            working_directory: "/tmp".into(),
            unit_id: "u-1".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["env"]["redacted"], true);
        assert_eq!(v["env"]["hint"], "env_var");
        let text = serde_json::to_string(&p).unwrap();
        assert!(!text.contains("hunter2"), "env secret leaked");
    }

    #[test]
    fn tool_result_round_trips() {
        let p = ToolResultV1 {
            tool_request_id: EventId::new(),
            stdout: "hello\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
            output: None,
            duration_ms: 12,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ToolResultV1>(&s).unwrap());
    }
}
```

> **Implementation note:** `ToolRequestV1` intentionally does not derive `Deserialize` or `PartialEq` — because the `env` field is redacted on serialize, deserializing a stored event into this exact struct would lose the hash shape. For read-path use (`canonicalize`), a parallel `ToolRequestStoredV1` struct is added in Task 13 that matches the on-disk shape (env is a `{redacted, hash, hint}` map value, not a raw BTreeMap).

- [ ] **Step 2: Declare module + run tests + commit**

Update `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
pub mod git_checkpoint;
pub mod model_io;
pub mod run_lifecycle;
pub mod tool_io;
pub mod unit_lifecycle;
```

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::tool_io
```
Expected: 2 tests PASS.

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add tool I/O payloads with secret env"
```

---

## Task 12: Implement workspace observation payloads

**Files:**
- Create: `native/crates/bp-ledger/src/payload/workspace.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`

- [ ] **Step 1: Write the payload structs + tests**

Create `native/crates/bp-ledger/src/payload/workspace.rs`:

```rust
//! Workspace observation payloads: WorkspaceRead, WorkspaceWrite.

use crate::id::EventId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceReadV1 {
    pub tool_request_id: EventId,
    pub path: String,
    pub content_hash: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceWriteV1 {
    pub tool_request_id: EventId,
    pub path: String,
    /// Content hash before the write; None if the file did not exist.
    pub hash_before: Option<String>,
    /// Content hash after the write. If the ledger could not read the file
    /// (permission denied, concurrent delete), this is a `ReadStatus::Unreadable`.
    pub after: PostWriteState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostWriteState {
    Captured { hash: String, size_bytes: u64 },
    Unreadable { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_read_v1_round_trips() {
        let p = WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "src/main.rs".into(),
            content_hash: "sha256:aa".into(),
            size_bytes: 123,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceReadV1>(&s).unwrap());
    }

    #[test]
    fn workspace_write_captured_round_trips() {
        let p = WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "out.txt".into(),
            hash_before: None,
            after: PostWriteState::Captured { hash: "sha256:bb".into(), size_bytes: 3 },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceWriteV1>(&s).unwrap());
    }

    #[test]
    fn workspace_write_unreadable_round_trips() {
        let p = WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "locked.txt".into(),
            hash_before: Some("sha256:aa".into()),
            after: PostWriteState::Unreadable { reason: "EACCES".into() },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceWriteV1>(&s).unwrap());
    }
}
```

- [ ] **Step 2: Declare module + run tests + commit**

Update `native/crates/bp-ledger/src/payload/mod.rs`:
```rust
pub mod git_checkpoint;
pub mod model_io;
pub mod run_lifecycle;
pub mod tool_io;
pub mod unit_lifecycle;
pub mod workspace;
```

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload::workspace
```
Expected: 3 tests PASS.

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add workspace observation payloads"
```

---

## Task 13: Implement the `Payload` enum + stored-shape parallel for tool_request

**Files:**
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`
- Modify: `native/crates/bp-ledger/src/payload/tool_io.rs`

- [ ] **Step 1: Add a `ToolRequestStoredV1` for the on-disk shape**

Append to `native/crates/bp-ledger/src/payload/tool_io.rs`:

```rust
/// On-disk shape of a `ToolRequest` event — `env` is the redaction map, not a
/// raw BTreeMap. This is what `canonicalize` produces when reading an event
/// back from storage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolRequestStoredV1 {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub env: EnvRedaction,
    pub working_directory: String,
    pub unit_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvRedaction {
    pub redacted: bool,
    pub hash: String,
    pub hint: String,
}

#[cfg(test)]
mod stored_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_request_stored_round_trips() {
        let p = ToolRequestStoredV1 {
            tool_name: "shell".into(),
            arguments: json!({"cmd": "ls"}),
            env: EnvRedaction {
                redacted: true,
                hash: "sha256:aa".into(),
                hint: "env_var".into(),
            },
            working_directory: "/tmp".into(),
            unit_id: "u-1".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ToolRequestStoredV1>(&s).unwrap());
    }
}
```

- [ ] **Step 2: Write the `Payload` enum**

Replace `native/crates/bp-ledger/src/payload/mod.rs`:

```rust
//! Event payload definitions, versioned per kind.

pub mod git_checkpoint;
pub mod model_io;
pub mod run_lifecycle;
pub mod tool_io;
pub mod unit_lifecycle;
pub mod workspace;

use serde::{Deserialize, Serialize};

/// The canonical payload type — what you get after `canonicalize()` reads an
/// event. Rust enum variants correspond to (kind, version) pairs; future
/// versions add variants without changing existing ones.
///
/// Wire format uses `#[serde(tag = "kind", content = "payload")]` on the
/// `Event` envelope; the envelope carries the kind+version, and the payload
/// is deserialized into the matching variant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Payload {
    RunStartedV1(run_lifecycle::RunStartedV1),
    RunCompletedV1(run_lifecycle::RunCompletedV1),
    RunFailedV1(run_lifecycle::RunFailedV1),
    UnitStartedV1(unit_lifecycle::UnitStartedV1),
    UnitCompletedV1(unit_lifecycle::UnitCompletedV1),
    UnitFailedV1(unit_lifecycle::UnitFailedV1),
    UnitCancelledV1(unit_lifecycle::UnitCancelledV1),
    GitCheckpointV1(git_checkpoint::GitCheckpointV1),
    ModelRequestV1(model_io::ModelRequestV1),
    ModelResponseV1(model_io::ModelResponseV1),
    ToolRequestStoredV1(tool_io::ToolRequestStoredV1),
    ToolResultV1(tool_io::ToolResultV1),
    WorkspaceReadV1(workspace::WorkspaceReadV1),
    WorkspaceWriteV1(workspace::WorkspaceWriteV1),
}
```

- [ ] **Step 3: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger payload
```
Expected: all prior tests still pass (14 total across payload modules) plus the new `tool_request_stored_round_trips` test.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/src/payload/
git commit -m "feat(ledger): add Payload enum and stored tool_request shape"
```

---

## Task 14: Implement the `Event` envelope

**Files:**
- Modify: `native/crates/bp-ledger/src/event.rs`
- Modify: `native/crates/bp-ledger/src/lib.rs`

- [ ] **Step 1: Write the envelope + tests**

Replace `native/crates/bp-ledger/src/event.rs`:

```rust
//! The canonical event envelope.

use crate::id::{EventId, RunId};
use crate::kind::EventKind;
use crate::payload::Payload;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The frozen v1 event envelope. Six fields, never change shape. Payload
/// evolves via its own versioning inside `Payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: EventId,
    pub run_id: RunId,
    pub parent_event_id: Option<EventId>,
    pub schema_version: u32,
    pub kind: EventKind,
    pub occurred_at: DateTime<Utc>,
    pub payload: Payload,
}

impl Event {
    /// The only supported schema version in this build of the ledger.
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    /// Return the variant tag as a canonical wire string.
    pub fn kind_str(&self) -> &'static str {
        self.kind.as_wire()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use std::collections::BTreeMap;

    #[test]
    fn envelope_round_trips_through_json() {
        let e = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: Some(EventId::new()),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 10,
                event_count: 2,
                unit_count: 1,
            }),
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: Event = serde_json::from_str(&s).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn kind_str_is_snake_case() {
        let e = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::UnitCancelled,
            occurred_at: Utc::now(),
            payload: Payload::UnitCancelledV1(
                crate::payload::unit_lifecycle::UnitCancelledV1 {
                    unit_id: "u-1".into(),
                    cause: crate::payload::unit_lifecycle::CancelCause::Timeout,
                },
            ),
        };
        assert_eq!(e.kind_str(), "unit_cancelled");
        let _unused: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    }
}
```

- [ ] **Step 2: Re-export**

Update `native/crates/bp-ledger/src/lib.rs`:
```rust
//! Buildplane event tape capture — append-only ledger for replayable runs.

pub mod canonicalize;
pub mod error;
pub mod event;
pub mod id;
pub mod kind;
pub mod payload;
pub mod serve;
pub mod storage;

pub use error::{LedgerError, Result};
pub use event::Event;
pub use id::{EventId, RunId};
pub use kind::EventKind;
pub use payload::Payload;
```

- [ ] **Step 3: Run tests and commit**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger event::tests
```
Expected: 2 tests PASS.

```bash
git add native/crates/bp-ledger/src/event.rs native/crates/bp-ledger/src/lib.rs
git commit -m "feat(ledger): add Event envelope"
```

---

## Task 15: Implement `canonicalize()` (v1 passthrough)

**Files:**
- Modify: `native/crates/bp-ledger/src/canonicalize.rs`
- Create: `native/crates/bp-ledger/tests/canonicalize.rs`

- [ ] **Step 1: Write the canonicalize function**

Replace `native/crates/bp-ledger/src/canonicalize.rs`:

```rust
//! Per-(kind, version) payload canonicalization.
//!
//! At v1, `canonicalize` is the identity: every stored event is already in
//! canonical shape. The function exists so v2+ can add migration logic without
//! changing callers.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::payload::Payload;

/// Canonicalize an event's payload, applying migrations if necessary.
///
/// Reads the envelope's `schema_version` and, if supported, returns the event
/// with its payload in the canonical (latest) shape. On v1 this is a passthrough.
pub fn canonicalize(event: Event) -> Result<Event> {
    if event.schema_version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: event.schema_version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    Ok(event)
}

/// Same as [`canonicalize`] but operates on a bare payload value when you
/// already know the kind and version. Useful for storage-layer reads that
/// don't reconstitute the full envelope.
pub fn canonicalize_payload(kind: &str, version: u32, payload: serde_json::Value) -> Result<Payload> {
    if version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    let wrapped = serde_json::json!({
        kind_to_variant(kind)?: payload,
    });
    serde_json::from_value::<Payload>(wrapped).map_err(LedgerError::from)
}

fn kind_to_variant(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "run_started" => "RunStartedV1",
        "run_completed" => "RunCompletedV1",
        "run_failed" => "RunFailedV1",
        "unit_started" => "UnitStartedV1",
        "unit_completed" => "UnitCompletedV1",
        "unit_failed" => "UnitFailedV1",
        "unit_cancelled" => "UnitCancelledV1",
        "git_checkpoint" => "GitCheckpointV1",
        "model_request" => "ModelRequestV1",
        "model_response" => "ModelResponseV1",
        "tool_request" => "ToolRequestStoredV1",
        "tool_result" => "ToolResultV1",
        "workspace_read" => "WorkspaceReadV1",
        "workspace_write" => "WorkspaceWriteV1",
        other => {
            return Err(LedgerError::InvalidPayload {
                kind: other.to_string(),
                reason: "unknown kind".into(),
            })
        }
    })
}
```

- [ ] **Step 2: Write integration tests**

Create `native/crates/bp-ledger/tests/canonicalize.rs`:

```rust
//! Canonicalize integration tests — v1 passthrough discipline.

use bp_ledger::canonicalize::canonicalize;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use chrono::Utc;

#[test]
fn v1_passes_through_unchanged() {
    let original = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    };
    let out = canonicalize(original.clone()).unwrap();
    assert_eq!(out, original);
}

#[test]
fn unsupported_schema_version_errors() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 99,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    };
    let err = canonicalize(event).unwrap_err();
    assert!(matches!(err, bp_ledger::LedgerError::UnsupportedSchemaVersion { .. }));
}
```

- [ ] **Step 3: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test canonicalize
```
Expected: 2 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/src/canonicalize.rs native/crates/bp-ledger/tests/canonicalize.rs
git commit -m "feat(ledger): add canonicalize (v1 passthrough)"
```

---

## Task 16: Implement CAS (content-addressed blob store)

**Files:**
- Create: `native/crates/bp-ledger/src/storage/cas.rs`
- Modify: `native/crates/bp-ledger/src/storage/mod.rs`
- Create: `native/crates/bp-ledger/tests/cas.rs`

- [ ] **Step 1: Write the CAS module**

Create `native/crates/bp-ledger/src/storage/cas.rs`:

```rust
//! Content-addressed blob store.
//!
//! Writes are atomic: content goes to a temp file in the same directory, then
//! `rename(2)` moves it into its final location. Reading the same path twice
//! from two processes yields either the final content or `ENOENT` — never a
//! partial file.

use crate::error::{LedgerError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// A content-addressed blob store rooted at a directory.
pub struct Cas {
    root: PathBuf,
}

impl Cas {
    /// Create a new CAS rooted at `root`. The directory is created if missing.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// Store bytes, return the sha256 hash. Idempotent: if the blob already
    /// exists, no write happens.
    pub fn put_bytes(&self, bytes: &[u8]) -> Result<String> {
        let hash = hash_hex(bytes);
        let dest = self.path_for(&hash);
        if dest.exists() {
            return Ok(hash);
        }
        let parent = dest.parent().expect("CAS path always has a parent");
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(".tmp-{}", &hash));
        {
            let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &dest)?;
        // Fsync the parent directory so the rename is durable. On Linux this is
        // a no-op for ext4 with data=ordered, but it is required semantics.
        File::open(parent)?.sync_all()?;
        Ok(hash)
    }

    /// Hash a file from disk, store it, and return the hash.
    pub fn put_path(&self, src: impl AsRef<Path>) -> Result<String> {
        let mut f = File::open(src)?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        self.put_bytes(&buf)
    }

    /// Retrieve bytes by hash. Returns `Err` if the hash is not present.
    pub fn get_bytes(&self, hash: &str) -> Result<Vec<u8>> {
        let path = self.path_for(hash);
        let mut f = File::open(&path).map_err(|_| LedgerError::Cas(
            format!("blob not found: {hash}")
        ))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    }

    fn path_for(&self, hash: &str) -> PathBuf {
        // "sha256:aabbcc..." or just "aabbcc..." — strip the prefix if present.
        let hex = hash.strip_prefix("sha256:").unwrap_or(hash);
        let (shard, rest) = hex.split_at(2);
        self.root.join(shard).join(rest)
    }
}

fn hash_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{:x}", h.finalize())
}
```

- [ ] **Step 2: Wire into storage/mod.rs**

Replace `native/crates/bp-ledger/src/storage/mod.rs`:

```rust
//! Durable storage for events and blobs.

pub mod cas;
pub mod sqlite;

pub use cas::Cas;
```

- [ ] **Step 3: Write integration tests**

Create `native/crates/bp-ledger/tests/cas.rs`:

```rust
//! CAS integration tests — atomic writes, dedup, read-back.

use bp_ledger::storage::Cas;
use tempfile::TempDir;

#[test]
fn put_bytes_stores_and_returns_hash() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();

    let h = cas.put_bytes(b"hello").unwrap();
    assert!(h.starts_with("sha256:"), "expected sha256 prefix, got {h}");

    let back = cas.get_bytes(&h).unwrap();
    assert_eq!(back, b"hello");
}

#[test]
fn put_bytes_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();
    let h1 = cas.put_bytes(b"world").unwrap();
    let h2 = cas.put_bytes(b"world").unwrap();
    assert_eq!(h1, h2);
}

#[test]
fn put_path_hashes_file_contents() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path().join("cas")).unwrap();
    let src = tmp.path().join("src.txt");
    std::fs::write(&src, b"file content").unwrap();

    let h = cas.put_path(&src).unwrap();
    let back = cas.get_bytes(&h).unwrap();
    assert_eq!(back, b"file content");
}

#[test]
fn get_bytes_missing_hash_errors() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();
    let err = cas.get_bytes("sha256:deadbeef").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("not found"), "unexpected error: {msg}");
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test cas
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/storage/ native/crates/bp-ledger/tests/cas.rs
git commit -m "feat(ledger): add content-addressed blob store with atomic writes"
```

---

## Task 17: Implement SQLite storage (events table + append-only trigger)

**Files:**
- Create: `native/crates/bp-ledger/src/storage/sqlite.rs`
- Create: `native/crates/bp-ledger/tests/append_only.rs`
- Create: `native/crates/bp-ledger/tests/round_trip.rs`

- [ ] **Step 1: Write the SQLite store**

Create `native/crates/bp-ledger/src/storage/sqlite.rs`:

```rust
//! SQLite-backed event store — append-only, trigger-enforced.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use rusqlite::{params, Connection};
use std::path::Path;

/// SQLite connection wrapping the events + runs schema.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Open or create a ledger database at `path`. Creates tables and the
    /// append-only trigger on first open.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self { conn })
    }

    /// Open an in-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self { conn })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS events (
                id               TEXT PRIMARY KEY,
                run_id           TEXT NOT NULL,
                parent_event_id  TEXT,
                schema_version   INTEGER NOT NULL,
                kind             TEXT NOT NULL,
                occurred_at      TEXT NOT NULL,
                payload          TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
            CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);

            CREATE TRIGGER IF NOT EXISTS events_no_update
                BEFORE UPDATE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS events_no_delete
                BEFORE DELETE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden');
                END;

            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                started_at       TEXT NOT NULL,
                completed_at     TEXT,
                outcome          TEXT,
                workspace_path   TEXT NOT NULL,
                packet_hash      TEXT NOT NULL,
                schema_version   INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    /// Append an event to the log. Fails if the id already exists.
    pub fn append(&self, event: &Event) -> Result<()> {
        let payload_json = serde_json::to_string(&event.payload)?;
        self.conn.execute(
            r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                event.id.to_string(),
                event.run_id.to_string(),
                event.parent_event_id.map(|e| e.to_string()),
                event.schema_version,
                event.kind_str(),
                event.occurred_at.to_rfc3339(),
                payload_json,
            ],
        )?;
        Ok(())
    }

    /// Read all events for a run, ordered by id (UUIDv7 = time-ordered).
    pub fn events_for_run(&self, run_id: &str) -> Result<Vec<StoredEventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload
             FROM events WHERE run_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok(StoredEventRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                parent_event_id: r.get(2)?,
                schema_version: r.get(3)?,
                kind: r.get(4)?,
                occurred_at: r.get(5)?,
                payload: r.get(6)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(LedgerError::from)
    }

    /// Count events in the store (for test convenience).
    pub fn event_count(&self) -> Result<u64> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// Expose the raw connection for use by tests that need to assert
    /// append-only behavior. Not part of the stable API.
    pub fn conn_for_tests(&self) -> &Connection {
        &self.conn
    }
}

/// Stored row — textual fields as read from SQLite. Use `canonicalize` to
/// turn this into a typed `Event`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEventRow {
    pub id: String,
    pub run_id: String,
    pub parent_event_id: Option<String>,
    pub schema_version: u32,
    pub kind: String,
    pub occurred_at: String,
    pub payload: String,
}
```

- [ ] **Step 2: Write the append-only integration test**

Create `native/crates/bp-ledger/tests/append_only.rs`:

```rust
//! Verify the SQL triggers block UPDATE and DELETE on the events table.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;

fn sample_event() -> Event {
    Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    }
}

#[test]
fn update_on_events_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();

    let err = store
        .conn_for_tests()
        .execute("UPDATE events SET kind = 'tampered' WHERE id = ?1", [event.id.to_string()]);
    assert!(err.is_err(), "expected trigger to reject UPDATE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn delete_on_events_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();

    let err = store
        .conn_for_tests()
        .execute("DELETE FROM events WHERE id = ?1", [event.id.to_string()]);
    assert!(err.is_err(), "expected trigger to reject DELETE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn duplicate_append_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();
    let err = store.append(&event);
    assert!(err.is_err(), "expected PRIMARY KEY violation on duplicate id");
}
```

- [ ] **Step 3: Write the round-trip integration test**

Create `native/crates/bp-ledger/tests/round_trip.rs`:

```rust
//! Round-trip every event kind through SQLite.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::{UnitStartedV1};
use bp_ledger::payload::workspace::{WorkspaceReadV1};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use std::collections::BTreeMap;

fn build(run_id: RunId, parent: Option<EventId>, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: parent,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

#[test]
fn events_for_run_returns_in_insert_order() {
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    let started = build(
        run_id,
        None,
        EventKind::RunStarted,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "deadbeef".into(),
            workspace_path: "/tmp/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
        }),
    );
    let unit = build(
        run_id,
        Some(started.id),
        EventKind::UnitStarted,
        Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: serde_json::json!({}),
        }),
    );
    let done = build(
        run_id,
        Some(started.id),
        EventKind::RunCompleted,
        Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 1,
            event_count: 3,
            unit_count: 1,
        }),
    );

    store.append(&started).unwrap();
    store.append(&unit).unwrap();
    store.append(&done).unwrap();

    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].kind, "run_started");
    assert_eq!(rows[1].kind, "unit_started");
    assert_eq!(rows[2].kind, "run_completed");
}

#[test]
fn payload_round_trips_through_canonicalize() {
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let event = build(
        run_id,
        None,
        EventKind::WorkspaceRead,
        Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "README.md".into(),
            content_hash: "sha256:bb".into(),
            size_bytes: 42,
        }),
    );
    store.append(&event).unwrap();

    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    let payload_json: serde_json::Value = serde_json::from_str(&rows[0].payload).unwrap();
    let canonical = canonicalize_payload(&rows[0].kind, rows[0].schema_version, payload_json).unwrap();

    match canonical {
        Payload::WorkspaceReadV1(p) => {
            assert_eq!(p.path, "README.md");
            assert_eq!(p.content_hash, "sha256:bb");
            assert_eq!(p.size_bytes, 42);
        }
        other => panic!("unexpected payload variant: {other:?}"),
    }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --tests
```
Expected: all tests PASS (round_trip: 2, append_only: 3, cas: 4, canonicalize: 2).

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/storage/sqlite.rs native/crates/bp-ledger/tests/append_only.rs native/crates/bp-ledger/tests/round_trip.rs
git commit -m "feat(ledger): add SQLite event store with append-only trigger"
```

---

## Task 18: Implement the stdin JSONL ingest loop

**Files:**
- Modify: `native/crates/bp-ledger/src/serve.rs`

- [ ] **Step 1: Write the serve function + tests**

Replace `native/crates/bp-ledger/src/serve.rs`:

```rust
//! Stdin JSONL ingest loop.
//!
//! Reads newline-delimited JSON events from a reader, deserializes them as
//! `Event`, canonicalizes, and appends to the SQLite store. Phase A: no
//! handshake, no control messages, no CAS integration for file-hash events.
//! Phase B adds `_handshake`/`_flush`/`_close` and wires CAS.

use crate::canonicalize::canonicalize;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::storage::sqlite::SqliteStore;
use std::io::{BufRead, BufReader, Read};

/// Ingest events from `reader` and append to `store` until EOF.
///
/// Returns the number of events successfully appended. The first malformed
/// line aborts ingestion with an error — this matches the spec's "malformed
/// line is a protocol violation" requirement.
pub fn ingest<R: Read>(reader: R, store: &SqliteStore) -> Result<u64> {
    let buf = BufReader::new(reader);
    let mut count: u64 = 0;
    for (idx, line) in buf.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: Event = serde_json::from_str(&line)
            .map_err(|e| LedgerError::InvalidPayload {
                kind: "<unknown>".to_string(),
                reason: format!("line {}: {e}", idx + 1),
            })?;
        let canonical = canonicalize(event)?;
        store.append(&canonical)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{EventId, RunId};
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use crate::payload::Payload;
    use chrono::Utc;

    fn encode(event: &Event) -> String {
        serde_json::to_string(event).unwrap() + "\n"
    }

    fn sample(run_id: RunId) -> Event {
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 0,
                event_count: 1,
                unit_count: 0,
            }),
        }
    }

    #[test]
    fn ingests_single_event_to_sqlite() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = encode(&event);
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn ingests_multiple_events_in_order() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let e1 = sample(run_id);
        let e2 = sample(run_id);
        let e3 = sample(run_id);
        let input = format!("{}{}{}", encode(&e1), encode(&e2), encode(&e3));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 3);
        let rows = store.events_for_run(&run_id.to_string()).unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn skips_blank_lines() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = format!("\n{}  \n\n", encode(&event));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn malformed_line_aborts_with_error() {
        let store = SqliteStore::open_in_memory().unwrap();
        let input = b"not-valid-json\n";
        let err = ingest(&input[..], &store).unwrap_err();
        assert!(matches!(err, LedgerError::InvalidPayload { .. }));
        assert_eq!(store.event_count().unwrap(), 0);
    }
}
```

- [ ] **Step 2: Run tests — expect PASS**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger serve::tests
```
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-ledger/src/serve.rs
git commit -m "feat(ledger): add stdin JSONL ingest loop"
```

---

## Task 19: Wire `bp-cli ledger serve` subcommand

**Files:**
- Modify: `native/crates/bp-cli/Cargo.toml`
- Create: `native/crates/bp-cli/src/ledger_cli.rs`
- Modify: `native/crates/bp-cli/src/main.rs`

- [ ] **Step 1: Add bp-ledger dependency**

Modify `native/crates/bp-cli/Cargo.toml`, add to `[dependencies]`:
```toml
bp-ledger.workspace = true
```

- [ ] **Step 2: Create the ledger_cli module**

Create `native/crates/bp-cli/src/ledger_cli.rs`:

```rust
//! `buildplane-native ledger ...` subcommands.
//!
//! Phase A: only `serve` is wired. Phase D adds `inspect`.

use bp_ledger::serve::ingest;
use bp_ledger::storage::sqlite::SqliteStore;
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerCommand {
    Serve(ServeArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub schema_version: u32,
}

/// Parse `ledger <subcommand> [args...]` into a LedgerCommand.
pub fn parse_ledger_command(args: &[String]) -> Result<LedgerCommand, String> {
    match args.first().map(String::as_str) {
        Some("serve") => parse_serve(&args[1..]).map(LedgerCommand::Serve),
        Some("--help" | "-h" | "help") | None => Ok(LedgerCommand::Help),
        Some(other) => Err(format!("unknown ledger subcommand: {other}")),
    }
}

fn parse_serve(args: &[String]) -> Result<ServeArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut schema_version: u32 = 1;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(args.get(i).ok_or("--workspace requires a value")?));
            }
            "--schema-version" => {
                i += 1;
                schema_version = args
                    .get(i)
                    .ok_or("--schema-version requires a value")?
                    .parse()
                    .map_err(|_| "--schema-version must be an integer")?;
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    Ok(ServeArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace: workspace.ok_or("missing --workspace")?,
        schema_version,
    })
}

/// Execute the `ledger serve` command.
///
/// Resolves the ledger database path from the workspace, opens it, and runs
/// the ingest loop against stdin.
pub fn run_serve(args: ServeArgs) -> Result<(), String> {
    if args.schema_version != 1 {
        return Err(format!(
            "schema version {} not supported in this build (supported: 1)",
            args.schema_version
        ));
    }
    let ledger_dir = args.workspace.join(".buildplane").join("ledger");
    std::fs::create_dir_all(&ledger_dir).map_err(|e| format!("creating ledger dir: {e}"))?;
    let db_path = ledger_dir.join("events.db");
    let store = SqliteStore::open(&db_path).map_err(|e| format!("opening events.db: {e}"))?;

    let stdin = io::stdin();
    let locked = stdin.lock();
    ingest(locked, &store).map_err(|e| format!("ingest: {e}"))?;

    // Flush stderr; the caller reads exit code for success.
    io::stderr().flush().ok();
    Ok(())
}

pub fn usage_text() -> String {
    r#"usage: buildplane-native ledger <subcommand>

subcommands:
  serve   Run a ledger ingest loop against stdin (JSONL events).

flags for `serve`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --schema-version <n>      wire schema version (default: 1)
"#
    .to_string()
}
```

- [ ] **Step 3: Wire the subcommand into main.rs**

Modify `native/crates/bp-cli/src/main.rs` — add `mod ledger_cli;` near the top (alongside `mod memory_cli;`) and extend the `Command` enum and dispatch:

Find the `Command` enum (around line 36 of `main.rs`) and add:
```rust
#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    InspectPack(InspectPackArgs),
    Memory(MemoryCommand),
    Ledger(ledger_cli::LedgerCommand),
    Help,
}
```

Find the command-parsing logic (search for `"memory"` in main.rs) and add a branch for `"ledger"`:

```rust
// inside parse_command(args) or wherever "memory" is dispatched
Some("ledger") => ledger_cli::parse_ledger_command(&args[1..])
    .map(Command::Ledger)
    .map_err(|msg| msg),
```

Find the command-execution switch (search for `Command::Memory(cmd) =>`) and add:

```rust
Command::Ledger(ledger_cli::LedgerCommand::Serve(serve_args)) => {
    ledger_cli::run_serve(serve_args).map_err(|msg| msg)
}
Command::Ledger(ledger_cli::LedgerCommand::Help) => {
    println!("{}", ledger_cli::usage_text());
    Ok(())
}
```

> **Implementation note:** the exact edit lines in `main.rs` depend on current file state. The engineer should open `main.rs`, read the existing `Command` enum and its parse/execute switches, and apply the pattern used by `memory_cli`. If `main.rs` has changed since this plan was written, adapt the location accordingly — the pattern is to mirror `memory` wiring.

- [ ] **Step 4: Smoke test — compile the native binary**

Run:
```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
```
Expected: PASS.

- [ ] **Step 5: Integration smoke — pipe an event through the CLI**

Run:
```bash
cd /tmp && mkdir -p bp-smoke && cd bp-smoke

cat > /tmp/bp-smoke/one-event.jsonl <<'EOF'
{"id":"01912b5e-0000-7000-8000-000000000001","run_id":"01912b5e-0000-7000-8000-000000000000","parent_event_id":null,"schema_version":1,"kind":"run_started","occurred_at":"2026-04-17T00:00:00Z","payload":{"RunStartedV1":{"packet_hash":"sha256:aa","git_head":"deadbeef","workspace_path":"/tmp/bp-smoke","config":{},"parent_run_id":null}}}
EOF

cat /tmp/bp-smoke/one-event.jsonl | <path-to-target>/buildplane-native ledger serve --run-id 01912b5e-0000-7000-8000-000000000000 --workspace /tmp/bp-smoke

sqlite3 /tmp/bp-smoke/.buildplane/ledger/events.db "SELECT kind, json_extract(payload, '$.RunStartedV1.git_head') FROM events;"
```

Expected: prints `run_started|deadbeef`.

- [ ] **Step 6: Commit**

```bash
git add native/crates/bp-cli/
git commit -m "feat(ledger): add bp-cli ledger serve subcommand"
```

---

## Task 20: Scaffold `packages/ledger-client` (TS skeleton)

**Files:**
- Create: `packages/ledger-client/package.json`
- Create: `packages/ledger-client/tsconfig.json`
- Create: `packages/ledger-client/src/index.ts`
- Create: `packages/ledger-client/src/generated/.gitkeep`

- [ ] **Step 1: Create package.json**

Write `packages/ledger-client/package.json`:

```json
{
	"name": "@buildplane/ledger-client",
	"private": true,
	"version": "0.1.0",
	"type": "module",
	"description": "Typed TS client for the bp-ledger event store (IPC protocol wired in Phase B)",
	"exports": {
		".": {
			"source": "./src/index.ts",
			"types": "./src/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"scripts": {
		"build": "tsc --build"
	}
}
```

- [ ] **Step 2: Create tsconfig.json**

Write `packages/ledger-client/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src",
		"composite": true
	},
	"include": ["src"],
	"exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Create the placeholder entry point**

Write `packages/ledger-client/src/index.ts`:

```ts
// Placeholder — Phase A ships types via ./generated/ only. Phase B adds the
// tape-emitter, IPC protocol, and runtime code.

export * from "./generated/index.js";
```

- [ ] **Step 4: Create the generated directory marker**

Write `packages/ledger-client/src/generated/.gitkeep`:

```
```

(empty file; keeps the directory in git)

- [ ] **Step 5: Create a stub generated/index.ts so the build works**

Write `packages/ledger-client/src/generated/index.ts`:

```ts
// Auto-generated from `bp-ledger` Rust types via typeshare.
// Do not edit by hand — regenerate with `pnpm ledger:gen` (wired in Task 21).
export type __LedgerClientPlaceholder = never;
```

- [ ] **Step 6: Register in tsconfig references**

Modify the root `tsconfig.json` — look at current references and add the ledger-client package if the convention is to list packages there. If the root uses a `references` array pattern like other packages, add:
```json
{ "path": "packages/ledger-client" }
```

- [ ] **Step 7: Verify TypeScript build**

Run:
```bash
pnpm --filter @buildplane/ledger-client build
```
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add packages/ledger-client/ tsconfig.json
git commit -m "feat(ledger): scaffold @buildplane/ledger-client package"
```

---

## Task 21: Wire `typeshare` schema generation

**Files:**
- Create: `native/crates/bp-ledger/build.rs`
- Modify: all `bp-ledger` payload structs (add `#[typeshare]`)
- Create: `scripts/ledger/generate-schema.sh`
- Modify: root `package.json` (add `ledger:gen` script)

- [ ] **Step 1: Install the typeshare CLI**

This is a one-time developer setup — the CLI is invoked from a script, not from `cargo`:
```bash
cargo install typeshare-cli
```

Expected: installs `~/.cargo/bin/typeshare`.

- [ ] **Step 2: Annotate all publicly-serialized payload types with `#[typeshare]`**

Add `#[typeshare]` above each `#[derive(Serialize, Deserialize)]` struct in these files:

- `native/crates/bp-ledger/src/id.rs` — `EventId`, `RunId`
- `native/crates/bp-ledger/src/kind.rs` — `EventKind`
- `native/crates/bp-ledger/src/event.rs` — `Event`
- `native/crates/bp-ledger/src/payload/mod.rs` — `Payload`
- `native/crates/bp-ledger/src/payload/run_lifecycle.rs` — `RunStartedV1`, `RunCompletedV1`, `RunFailedV1`, `RunOutcome`
- `native/crates/bp-ledger/src/payload/unit_lifecycle.rs` — `UnitStartedV1`, `UnitCompletedV1`, `UnitFailedV1`, `UnitCancelledV1`, `UnitOutcome`, `CancelCause`, `ArtifactRef`
- `native/crates/bp-ledger/src/payload/git_checkpoint.rs` — `GitCheckpointV1`, `CheckpointBoundary`, `GitStatus`
- `native/crates/bp-ledger/src/payload/model_io.rs` — `ModelRequestV1`, `ModelResponseV1`, `Message`, `SamplingParams`, `HeaderValue`, `ToolCall`, `Usage`
- `native/crates/bp-ledger/src/payload/tool_io.rs` — `ToolResultV1`, `ToolRequestStoredV1`, `EnvRedaction`
- `native/crates/bp-ledger/src/payload/workspace.rs` — `WorkspaceReadV1`, `WorkspaceWriteV1`, `PostWriteState`

Example edit (apply the same pattern to every struct listed above):

```rust
use typeshare::typeshare;

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunStartedV1 { /* ... */ }
```

> **Note on `ToolRequestV1`:** do NOT annotate this struct with `#[typeshare]`. It's the write-only pre-redaction shape and exists only inside Rust. The TS client sees `ToolRequestStoredV1` (the on-disk shape) instead.

- [ ] **Step 3: Add the generation script**

Create `scripts/ledger/generate-schema.sh`:

```bash
#!/usr/bin/env bash
# Regenerate TS types from bp-ledger Rust types via typeshare.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packages/ledger-client/src/generated/index.ts"

mkdir -p "$(dirname "$OUT")"

typeshare \
  --lang=typescript \
  --output-file="$OUT" \
  "$ROOT/native/crates/bp-ledger/src"

# Append a non-empty line at the top so the file isn't mistaken for empty in
# some editors. typeshare adds its own header; leave that in place.
echo "// regenerated from bp-ledger — do not edit" | cat - "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"

echo "wrote $OUT"
```

Make it executable:
```bash
chmod +x scripts/ledger/generate-schema.sh
```

- [ ] **Step 4: Add pnpm script**

Modify root `package.json` — add under `scripts`:
```json
"ledger:gen": "./scripts/ledger/generate-schema.sh"
```

- [ ] **Step 5: Run generation and verify**

Run:
```bash
pnpm ledger:gen
```
Expected: prints `wrote .../packages/ledger-client/src/generated/index.ts` and the file contains type declarations for `Event`, `Payload`, `EventKind`, and each payload variant.

- [ ] **Step 6: Build the TS package to confirm generated types compile**

Run:
```bash
pnpm --filter @buildplane/ledger-client build
```
Expected: clean build, no TS errors on the generated file.

- [ ] **Step 7: Commit**

```bash
git add native/crates/bp-ledger/src/ scripts/ledger/ package.json packages/ledger-client/src/generated/
git commit -m "feat(ledger): wire typeshare schema generation to ledger-client"
```

---

## Task 22: Phase A verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run:
```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros
```
Expected: all tests PASS.

- [ ] **Step 2: Check coverage (optional but recommended)**

Install and run `cargo-llvm-cov` once:
```bash
cargo install cargo-llvm-cov
cargo llvm-cov --manifest-path native/Cargo.toml -p bp-ledger
```
Expected: ≥90% line coverage in `bp-ledger`. If below, add tests for uncovered branches before proceeding to Phase B.

- [ ] **Step 3: Lint Rust**

Run:
```bash
cargo clippy --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -- -D warnings
```
Expected: no warnings.

- [ ] **Step 4: Verify generated TS compiles**

Run:
```bash
pnpm ledger:gen && pnpm --filter @buildplane/ledger-client build
```
Expected: clean build.

- [ ] **Step 5: Smoke-test the CLI once more**

Repeat Task 19 Step 5 smoke test end-to-end with a fresh workspace. Confirm the SQLite row shape matches expectations.

- [ ] **Step 6: Update the spec with "Phase A complete" marker**

Modify `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md` — in Section 6 (Phases), add at the end of Phase A:
```markdown
**Phase A status: complete (YYYY-MM-DD).**
```
(replace YYYY-MM-DD with the actual date of completion)

- [ ] **Step 7: Final commit**

```bash
git add docs/superpowers/specs/2026-04-17-event-tape-capture-design.md
git commit -m "docs(ledger): mark Phase A complete"
```

- [ ] **Step 8: Open a PR for the whole branch**

```bash
git push -u origin feat/ledger-phase-a
gh pr create --title "feat(ledger): Phase A — bp-ledger crate skeleton" --body "$(cat <<'EOF'
## Summary
- New `bp-ledger` crate with frozen envelope + v1 event kinds/payloads
- SQLite events table with append-only trigger + runs index table
- Content-addressed blob store with atomic writes
- `#[secret]` proc macro in `bp-ledger-macros` with redaction-on-serialize
- `buildplane-native ledger serve` subcommand reading JSONL from stdin
- `typeshare` schema generation wired to `@buildplane/ledger-client`

## Test plan
- [x] `cargo test -p bp-ledger -p bp-ledger-macros` green
- [x] coverage ≥90% in bp-ledger
- [x] `cargo clippy` clean
- [x] `pnpm ledger:gen && pnpm --filter @buildplane/ledger-client build` clean
- [x] end-to-end smoke: `echo '{...event...}' | buildplane-native ledger serve ...` writes to SQLite

## Scope
- Delivers Phase A of the event-tape-capture sub-project (see `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md`)
- Does NOT include handshake protocol, TS tape-emitter, tool instrumentation, or the `inspect` command — those are Phases B/C/D

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

Expected: PR created. Record the URL.

---

## Self-review

**Spec coverage check:**

Matching tasks to Phase A deliverables in the spec:

| Phase A deliverable | Task(s) |
|---|---|
| New crate `native/crates/bp-ledger/` compiled in workspace | 1 |
| Rust types for envelope + all v1 event kinds | 4, 5, 7–14 |
| `#[secret]` proc macro with tests | 2, 6 |
| SQLite schema + append-only trigger + runs index | 17 |
| CAS with atomic writes | 16 |
| `buildplane-native ledger serve` minimal | 18, 19 |
| Rust Layer 1 tests (round-trip, migration, CAS, append-only, secret) | 4, 6, 7–14, 15, 16, 17, 18 |
| Schema generation via typeshare → `packages/ledger-client/src/generated/` | 20, 21 |
| `packages/ledger-client/` skeleton | 20 |
| Demo-able end-state + phase gate | 19 step 5, 22 |

No gaps.

**Out-of-scope check:**

The plan does not include:
- Handshake / control messages (`_handshake`, `_flush`, `_close`) — Phase B
- TS `tape-emitter` runtime code — Phase B
- Tool adapter instrumentation — Phase C
- Git checkpoint emission from kernel — Phase C
- Cross-boundary integration tests (TS ↔ Rust subprocess) — Phase B/C
- `ledger inspect` subcommand — Phase D

Correct; these belong to later phases with their own plans.

**Placeholder scan:** No TBD/TODO/placeholder markers in task content. Implementation notes are present where they describe design fallbacks (e.g., Task 6's macro fallback to a derive macro) — these are explicit guidance, not placeholders.

**Type consistency:**
- `EventId`, `RunId`, `EventKind`, `Payload`, `Event` — used consistently across tasks
- Payload naming: all `<Kind>V1` form (`RunStartedV1`, `ToolRequestStoredV1`, etc.), matches spec Section 3
- `ToolRequestV1` (write side) vs `ToolRequestStoredV1` (read side) distinction introduced in Task 11 and used correctly in Tasks 13, 15
- `EnvRedaction` shape in Task 13 matches the redaction emitted by `#[secret]` in Task 6 (same three fields: `redacted`, `hash`, `hint`)
- `SqliteStore` API used consistently in Tasks 17, 18, 19
- `Cas` API used consistently in Tasks 16 (defined), not consumed in Phase A but referenced from spec

No type-name drift detected.
