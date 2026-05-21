# Buildplane Native Workspace

This subtree is the Rust-first workspace for the next Buildplane runtime and the current home of the active memory implementation.

Why it lives under `native/` instead of the repo root:
- the current TypeScript workspace is still the live product surface
- we do not want a speculative runtime rewrite to destabilize the existing pnpm workflow
- the native host-aware runtime can evolve and compile independently until it is ready to replace or absorb parts of the current stack

Initial goals:
- keep Pack != Host != Provider explicit in code
- support host-aware execution through Claude/Codex when possible
- preserve direct-provider and standalone execution as fallbacks
- move pack configuration into declarative `pack.toml` manifests

`buildplane-native pack show <pack-id>` is now the inspection seam for this scaffold. It loads the pack manifest, inspects real Claude/Codex host availability from the current environment, optionally applies `--detected-host` overrides only to route selection, resolves the runtime route with manifest preferences, and prints a bridge plan only when the selected host route is also truly detected/auth-available. It does not execute Claude/Codex or any provider transport yet.

The native workspace contains the active memory implementation today. The main TypeScript CLI dispatches `buildplane memory ...` into this binary from `apps/cli/src/run-cli.ts`, so the Rust memory runner is the current source of truth for:
- layered memory scopes: user, workspace, pack, session
- split SQLite storage: global db + workspace db
- memory links
- FTS-backed search
- memory maintenance commands like `doctor`, `export`, `import`, and `prune`

That bridge is verified for repo-local source, in-repo built CLI flows, and the published/global Linux x64 package. Windows and macOS published packages currently report native memory as unavailable instead of trying to execute an unsupported binary.

Useful commands:

```bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
cargo fmt --all --manifest-path native/Cargo.toml
cargo check --manifest-path native/Cargo.toml
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
CLAUDE_CODE=1 cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --detected-host codex --workspace-root /tmp/workspace
cargo run --manifest-path native/Cargo.toml -p bp-cli -- memory doctor --json
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane memory doctor --json
```

Native memory binary discovery for the repo-local/in-repo CLI bridge in `apps/cli/src/run-cli.ts`:
- `BUILDPLANE_NATIVE_BIN` if set
- packaged `vendor/native/linux-x64/buildplane-native` when running on Linux x64
- `native/target/debug/buildplane-native` relative to the current working directory
- `native/target/release/buildplane-native` relative to the current working directory
- `buildplane-native` on `PATH`

Use `BUILDPLANE_NATIVE_BIN` whenever you want deterministic integration against a specific compiled binary, especially in tests, packaging checks, or when multiple native builds exist on the machine.

Typical inspection behavior:
- no host markers detected: expect provider fallback for `superclaude` and `bridge plan: none`
- `CLAUDE_CODE=1`: expect `selected route: host:claude` plus a Claude bridge plan
- `--detected-host codex`: deterministic route-selection override for that invocation; host status still reports real Claude/Codex availability and bridge planning still requires a truly detected/auth-available host
