# SuperClaude Native Host-Aware Pack Inspection Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task. Keep the slice inside `buildplane/main/native`. Do not commit unless the user explicitly asks; this checkout already contains unrelated dirty/untracked native work.

**Goal:** Turn `buildplane-native pack show <pack-id>` into a real host-aware inspection command that detects Claude/Codex from the current environment, explains the selected route for the SuperClaude pack, and prints the bridge plan when a host route wins.

**Architecture:** Keep the slice narrow and additive. Reuse the existing `pack.toml` manifests, `bp-pack-loader`, and `bp-runtime::resolve_transport` logic. Add a CLI inspection seam that builds a `DetectionContext` from the current workspace and environment, queries the Claude/Codex host adapters for status, feeds the detected hosts into runtime selection, and prints a deterministic report. Do not add live execution, provider transport, or persistence in this slice.

**Tech Stack:** Rust 2021, Cargo workspace under `native/`, async-trait host adapters, `futures::executor::block_on` (or equivalent minimal blocking helper), serde, custom CLI parser, markdown docs

---

## Planned file structure

### Native CLI wiring
- Modify: `native/Cargo.toml` — add a workspace dependency for a minimal async blocking helper if needed (`futures = "0.3"` is the simplest choice)
- Modify: `native/crates/bp-cli/Cargo.toml` — add `bp-host-claude`, `bp-host-codex`, `bp-host-sdk`, and the blocking helper dependency
- Modify: `native/crates/bp-cli/src/main.rs` — parser changes, detection-context creation, inspection orchestration, report rendering, tests

### Optional terminal rendering seam
- Modify: `native/crates/bp-ui-terminal/src/lib.rs` — only if extracting report rendering out of `bp-cli` makes the code cleaner; otherwise leave this crate untouched

### Test helpers and docs
- Modify: `native/crates/bp-test-support/src/lib.rs` — add any tiny env-map helper only if the `bp-cli` tests become noisy; otherwise leave as-is
- Modify: `native/README.md` — document the new host-aware inspection behavior and real command examples
- Modify: `docs/architecture/rust-native-host-runtime.md` — fix the documented route precedence to match the implemented/native-tested rule and mention the new inspection seam

### Design decisions locked for implementation
- Keep `pack show` as the public command for this slice. Do not add a brand-new top-level command unless implementation proves `pack show` cannot carry the inspection behavior cleanly.
- Auto-detect Claude/Codex from the current process environment when no `--detected-host` overrides are supplied.
- Preserve `--detected-host <id>` as a deterministic test/manual override. For a given invocation, explicit `--detected-host` values should replace auto-detection for route selection so tests remain deterministic.
- Add `--workspace-root <path>` so the bridge plan and detection context can be tested without depending on the caller’s current directory.
- Workspace root should default to the caller’s current directory.
- Route precedence must be: explicit host -> explicit provider -> detected preferred host from the manifest -> manifest default provider -> standalone.
- Only compute a bridge plan when the selected route is `host:<id>` and that host is actually detected/auth-available.
- API keys and direct-provider config are provider fallback inputs, not host detection signals.
- Keep `Pack != Host != Provider` explicit in code and output.

---

## Chunk 1: Lock the CLI contract and dependency seam

**Chunk acceptance criteria:** `bp-cli` can parse a workspace-root override, still supports explicit host/provider overrides, and has the dependencies needed to talk to the Claude/Codex host adapters without changing any other native crate behavior.

### Task 1: Add the minimal dependency wiring for host-aware inspection

**Files:**
- Modify: `native/Cargo.toml`
- Modify: `native/crates/bp-cli/Cargo.toml`

- [ ] **Step 1: Add a focused failing compile/test signal before changing dependencies**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli parses_pack_show_with_workspace_root
```

Expected: FAIL because the test does not exist yet.

- [ ] **Step 2: Add the minimal workspace dependency**

Update `native/Cargo.toml` under `[workspace.dependencies]` only if you need a blocking helper for async adapter calls. Prefer the smallest addition:

```toml
futures = "0.3"
```

Do not add Tokio for this inspection-only slice.

- [ ] **Step 3: Wire `bp-cli` to the host crates**

Update `native/crates/bp-cli/Cargo.toml` so `[dependencies]` includes:

```toml
bp-host-claude.workspace = true
bp-host-codex.workspace = true
bp-host-sdk.workspace = true
futures.workspace = true
```

Keep existing dependencies unchanged.

- [ ] **Step 4: Run a narrow compile check**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo check --manifest-path native/Cargo.toml -p bp-cli
```

Expected: PASS.

### Task 2: Extend the parsed command contract with `--workspace-root`

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`

- [ ] **Step 1: Write the failing parser test first**

Add a new test beside the existing parser tests:

```rust
#[test]
fn parses_pack_show_with_workspace_root() {
    let native_root = PathBuf::from("/tmp/buildplane/native");
    let command = parse_args_with_default_native_root(
        vec![
            "pack",
            "show",
            "superclaude",
            "--workspace-root",
            "/tmp/workspace",
            "--host",
            "claude",
        ],
        native_root.clone(),
    )
    .expect("command should parse");

    assert_eq!(
        command,
        Command::InspectPack(InspectPackArgs {
            pack_id: "superclaude".to_string(),
            native_root,
            workspace_root: PathBuf::from("/tmp/workspace"),
            explicit_host: Some("claude".to_string()),
            explicit_provider: None,
            detected_hosts: Vec::new(),
        })
    );
}
```

- [ ] **Step 2: Run the focused parser test to verify failure**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli parses_pack_show_with_workspace_root
```

Expected: FAIL because `InspectPackArgs` and the parser do not yet know about `workspace_root`.

- [ ] **Step 3: Extend `InspectPackArgs` and parsing**

Add the field:

```rust
workspace_root: PathBuf,
```

Initialize it from the current working directory by default and override it when `--workspace-root <path>` is supplied.

The parser loop should accept:

```rust
"--workspace-root" => {
    workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?);
}
```

Set the default before the flag loop using the process current directory already available to the CLI.

- [ ] **Step 4: Re-run the focused parser test**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli parses_pack_show_with_workspace_root
```

Expected: PASS.

- [ ] **Step 5: Re-run the full `bp-cli` parser test group**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli parse
```

Expected: PASS for the existing parser tests plus the new `workspace_root` case.

---

## Chunk 2: Add deterministic host inspection and route selection orchestration

**Chunk acceptance criteria:** `pack show` can inspect the current environment (or deterministic test overrides), collect Claude/Codex status, resolve the runtime route with the existing precedence rule, and compute a bridge plan only when a host route wins.

### Task 3: Add a pure inspection seam inside `bp-cli`

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`

- [ ] **Step 1: Introduce internal report structs before wiring behavior**

Add minimal structs local to `bp-cli`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
struct HostInspectionRow {
    host: String,
    display_name: String,
    status: HostStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackInspectionReport {
    selection: RuntimeSelection,
    host_rows: Vec<HostInspectionRow>,
    detected_hosts: Vec<String>,
    bridge_plan: Option<HostBridgePlan>,
}
```

Do not move these into another crate yet.

- [ ] **Step 2: Add the failing host-detection test for real adapter status collection**

Use the existing repo pack manifest and a deterministic env map. A minimal test shape is:

```rust
#[test]
fn inspection_detects_claude_and_builds_a_host_route_for_superclaude() {
    let report = inspect_pack_for_test(
        "superclaude",
        &[ ("CLAUDE_CODE", "1") ],
        InspectOverrides {
            workspace_root: PathBuf::from("/tmp/workspace"),
            ..InspectOverrides::default()
        },
    )
    .expect("inspection should succeed");

    assert_eq!(report.detected_hosts, vec!["claude".to_string()]);
    assert_eq!(report.selection.route, ExecutionRoute::Host("claude".to_string()));
    assert!(report.bridge_plan.is_some());
}
```

The helper can load the real `native/packs/superclaude/pack.toml` from a fixture path derived from `env!("CARGO_MANIFEST_DIR")`.

- [ ] **Step 3: Add the failing explicit-provider precedence test**

Add a second test that proves the command respects the current intended precedence even when a preferred host is detected:

```rust
#[test]
fn inspection_prefers_explicit_provider_over_detected_host() {
    let report = inspect_pack_for_test(
        "superclaude",
        &[ ("CLAUDE_CODE", "1") ],
        InspectOverrides {
            explicit_provider: Some("openai".to_string()),
            workspace_root: PathBuf::from("/tmp/workspace"),
            ..InspectOverrides::default()
        },
    )
    .expect("inspection should succeed");

    assert_eq!(
        report.selection.route,
        ExecutionRoute::Provider("openai".to_string())
    );
    assert!(report.bridge_plan.is_none());
}
```

- [ ] **Step 4: Run the focused tests to verify failure**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli inspection_
```

Expected: FAIL because the inspection seam does not exist yet.

- [ ] **Step 5: Implement a small async inspection helper and block on it from `run_inspect_pack`**

Keep the orchestration local to `bp-cli`. A workable shape is:

```rust
fn run_inspect_pack(args: InspectPackArgs) -> Result<(), String> {
    let report = futures::executor::block_on(build_pack_report(&args))?;
    println!("{}", render_pack_report(&report, &args, &loaded));
    Ok(())
}

async fn build_pack_report(args: &InspectPackArgs) -> Result<PackInspectionReport, String> {
    // 1. load manifest with bp-pack-loader
    // 2. build DetectionContext { workspace_root, env }
    // 3. collect Claude/Codex status rows via their adapters
    // 4. derive detected_hosts from either explicit --detected-host overrides or actual detections
    // 5. call resolve_transport
    // 6. if route == Host("claude"|"codex"), call plan_bridge on the winning adapter
}
```

Use a tiny generic helper for inspection to avoid duplicate Claude/Codex code:

```rust
async fn inspect_host<A>(
    adapter: &A,
    context: &DetectionContext,
) -> Result<HostInspectionRow, String>
where
    A: HostAdapter + HostBridgeAdapter,
{
    let status = adapter.status(context).await.map_err(|err| err.to_string())?;
    Ok(HostInspectionRow {
        host: adapter.id().to_string(),
        display_name: adapter.display_name().to_string(),
        status,
    })
}
```

- [ ] **Step 6: Make `--detected-host` deterministic for tests**

When `args.detected_hosts` is non-empty, use those values for `resolve_transport` instead of the live detection results. Keep the status rows truthful to the environment; only the route-selection input becomes override-driven.

Also de-duplicate and preserve stable order in the effective `detected_hosts` vector.

- [ ] **Step 7: Re-run the focused inspection tests**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli inspection_
```

Expected: PASS.

### Task 4: Cover fallback behavior and bridge-plan gating

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`

- [ ] **Step 1: Add the failing fallback test**

Add a test for no detected hosts and no overrides:

```rust
#[test]
fn inspection_falls_back_to_pack_default_provider_when_no_host_is_detected() {
    let report = inspect_pack_for_test(
        "superclaude",
        &[],
        InspectOverrides {
            workspace_root: PathBuf::from("/tmp/workspace"),
            ..InspectOverrides::default()
        },
    )
    .expect("inspection should succeed");

    assert_eq!(
        report.selection.route,
        ExecutionRoute::Provider("anthropic".to_string())
    );
    assert!(report.bridge_plan.is_none());
}
```

- [ ] **Step 2: Add the failing override test for deterministic synthetic detection**

```rust
#[test]
fn inspection_allows_detected_host_override_without_real_env_markers() {
    let report = inspect_pack_for_test(
        "superclaude",
        &[],
        InspectOverrides {
            detected_hosts: vec!["codex".to_string()],
            workspace_root: PathBuf::from("/tmp/workspace"),
            ..InspectOverrides::default()
        },
    )
    .expect("inspection should succeed");

    assert_eq!(report.detected_hosts, vec!["codex".to_string()]);
    assert_eq!(report.selection.route, ExecutionRoute::Host("codex".to_string()));
}
```

The route should follow the override, but the status row for Codex may still show `detected = false` if no real env marker exists. That tension is acceptable for deterministic tests; surface it clearly in the CLI output.

- [ ] **Step 3: Run the focused tests to verify failure**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli inspection_falls_back_to_pack_default_provider_when_no_host_is_detected inspection_allows_detected_host_override_without_real_env_markers
```

Expected: FAIL until fallback and override handling are wired.

- [ ] **Step 4: Implement the minimal fallback and override behavior**

Do not change `bp-runtime::resolve_transport`; adapt the CLI inspection inputs only.

- [ ] **Step 5: Re-run the full `bp-cli` test suite**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli
```

Expected: PASS.

---

## Chunk 3: Make the terminal output human-usable and update the docs

**Chunk acceptance criteria:** Running `buildplane-native pack show superclaude` produces a readable report with pack metadata, host status, selected route, reason, and bridge-plan details when relevant. Docs describe the behavior honestly and the architecture doc no longer disagrees with the code.

### Task 5: Render a stable, inspectable report

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`
- Modify: `native/crates/bp-ui-terminal/src/lib.rs` (optional; only if you choose to extract rendering)

- [ ] **Step 1: Add a failing output-focused unit test before changing strings**

Prefer a substring-based test instead of snapshot brittleness. Example:

```rust
#[test]
fn rendered_report_includes_host_status_and_selection_reason() {
    let output = render_pack_report_for_test(/* report with claude detected */);

    assert!(output.contains("Buildplane native host-aware pack inspection"));
    assert!(output.contains("host status:"));
    assert!(output.contains("claude: detected=true"));
    assert!(output.contains("selected route: host:claude"));
    assert!(output.contains("selection reason: detected preferred host 'claude' from pack manifest"));
    assert!(output.contains("bridge plan:"));
}
```

- [ ] **Step 2: Run the focused output test to verify failure**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli rendered_report_includes_host_status_and_selection_reason
```

Expected: FAIL because the renderer does not yet exist.

- [ ] **Step 3: Render the report with explicit sections**

Use this output shape (exact spacing can vary slightly, but keep the section names stable):

```text
Buildplane native host-aware pack inspection
pack: superclaude (SuperClaude)
version: 0.1.0
pack root: ...
manifest: ...
workspace root: ...
default mode: daily (Daily)
commands:
  - /fast -> daily (...)
  - /deep -> deep (...)
host preferences:
  - claude priority=100 transport=Host
  - codex priority=50 transport=Host
host status:
  - claude: detected=true auth=available detail=...
  - codex: detected=false auth=requires-login detail=...
effective detected hosts: claude
selected route: host:claude
selection reason: detected preferred host 'claude' from pack manifest
bridge plan:
  - host: claude
  - entrypoint: claude
  - protocol: brokered-cli
  - auth ownership: host-managed
  - mode hint: daily
```

If the selected route is a provider or standalone, print a clear line such as:

```text
bridge plan: none (selected route does not use a detected host bridge)
```

If `--detected-host` overrides are in effect, add one clarifying line such as:

```text
detection source: cli override (--detected-host)
```

- [ ] **Step 4: Re-run the focused output test**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli rendered_report_includes_host_status_and_selection_reason
```

Expected: PASS.

### Task 6: Update native docs and fix the precedence mismatch

**Files:**
- Modify: `native/README.md`
- Modify: `docs/architecture/rust-native-host-runtime.md`

- [ ] **Step 1: Add a failing docs-contract check only if it is faster than manual review**

A docs test is optional here. If you skip it, do a careful manual diff review instead.

- [ ] **Step 2: Update `native/README.md` examples**

Replace the old examples with real host-aware ones. Include the PATH prelude used on this machine:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
CLAUDE_CODE=1 cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --detected-host codex --workspace-root /tmp/workspace
```

Explain that the command now inspects current host availability, uses manifest preferences for selection, and prints a bridge plan only for a winning host route.

- [ ] **Step 3: Fix the architecture doc precedence sentence**

In `docs/architecture/rust-native-host-runtime.md`, replace the current order:

```text
explicit host, detected preferred host, explicit provider, pack default provider, standalone
```

with the implemented/native-tested order:

```text
explicit host, explicit provider, detected preferred host, pack default provider, standalone
```

Also add one short paragraph noting that `buildplane-native pack show <pack-id>` is now the inspection seam for validating host-aware routing on a real machine before live execution exists.

- [ ] **Step 4: Review the docs diff for honesty and scope**

Checklist:
- no claims of live Claude/Codex execution
- clear Pack vs Host vs Provider separation
- examples match the implemented flags
- precedence text matches tests/code

---

## Chunk 4: Verify the slice end-to-end

**Chunk acceptance criteria:** The touched crates format cleanly, targeted tests pass, the broader native tests still pass, and manual command runs show the expected host-aware inspection output.

### Task 7: Run targeted tests first, then full native verification

**Files:**
- No file edits expected unless verification exposes a bug

- [ ] **Step 1: Run the touched crate tests**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-cli -p bp-runtime -p bp-host-claude -p bp-host-codex
```

Expected: PASS.

- [ ] **Step 2: Format the native workspace**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo fmt --manifest-path native/Cargo.toml --all
```

Expected: PASS with no diff, or a formatting-only diff that you keep.

- [ ] **Step 3: Run the broader native test set**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo test --manifest-path native/Cargo.toml -p bp-pack-manifest -p bp-pack-loader -p bp-runtime -p bp-cli -p bp-host-claude -p bp-host-codex -p bp-ui-terminal -p bp-test-support
```

Expected: PASS.

- [ ] **Step 4: Run a manual no-host fallback check**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
```

Expected output should include:
- `selected route: provider:anthropic`
- `bridge plan: none`
- host status rows for both Claude and Codex

- [ ] **Step 5: Run a manual Claude-host check**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
CLAUDE_CODE=1 cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
```

Expected output should include:
- `effective detected hosts: claude`
- `selected route: host:claude`
- `bridge plan:` with Claude entrypoint/protocol/auth ownership lines

- [ ] **Step 6: Run a deterministic override check**

Run:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --detected-host codex --workspace-root /tmp/buildplane-test-workspace
```

Expected output should include:
- `detection source: cli override (--detected-host)`
- `effective detected hosts: codex`
- `selected route: host:codex`

- [ ] **Step 7: Capture a concise completion report**

Write a short report to:

```text
.hermes/reports/2026-04-01-superclaude-native-host-aware-pack-inspection-implementation.md
```

The report must include:
- files changed
- commands run
- test results
- manual verification results
- any remaining risks or follow-up work

Do not commit unless the user explicitly asks.

---

## Implementation notes and guardrails

- Prefer editing `bp-cli` over introducing a new crate or moving logic into `bp-runtime` unless implementation reveals a real reuse need.
- Keep the output readable in plain terminal text; do not add color or rich terminal dependencies in this slice.
- Avoid snapshot tests for full CLI output. Use focused `contains(...)` assertions on the contract lines.
- If the real SuperClaude manifest changes while implementing, adapt tests to the current committed manifest values rather than hardcoding stale assumptions.
- Do not change host marker semantics in `bp-host-claude` or `bp-host-codex` unless a failing test proves they are wrong.
- Do not reinterpret provider API keys as host detection.
- If `bp-ui-terminal` stays untouched, that is acceptable. Keep the implementation as small as possible.

## Done definition

This slice is done when all of the following are true:
- `buildplane-native pack show superclaude` inspects the actual environment by default
- the command prints host status for Claude and Codex
- route selection uses the tested precedence: explicit host -> explicit provider -> detected preferred host -> default provider -> standalone
- a bridge plan is shown only when a detected host route wins
- docs match the code and no longer claim the wrong precedence order
- native tests and manual checks pass
