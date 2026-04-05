# Buildplane Rust-first host-aware runtime scaffold

Date: 2026-04-01

This document captures the approved starter architecture for a Rust-first Buildplane runtime that can eventually sit under the broader SuperClaude + Buildplane stack.

Why this starts under `native/`:
- the current TypeScript workspace remains the active product and release surface
- we want a real compiling Rust workspace without destabilizing the live pnpm root
- this creates a clean seam for gradual migration instead of forcing a rewrite-in-place

Core separation rules:
- Pack != Host != Provider
- packs own workflow/personality/defaults
- hosts own reusable session/auth surfaces such as Claude/Codex
- providers own direct API transport
- runtime chooses the best route in this order: explicit host, explicit provider, detected preferred host, pack default provider, standalone

Initial native workspace layout:

```text
native/
  Cargo.toml
  crates/
    bp-core/
    bp-config/
    bp-memory/
    bp-storage-sqlite/
    bp-pack-manifest/
    bp-pack-loader/
    bp-pack-inspection/
    bp-host-sdk/
    bp-host-registry/
    bp-host-claude/
    bp-host-codex/
    bp-provider-sdk/
    bp-provider-anthropic/
    bp-provider-openai/
    bp-runtime/
    bp-ui-terminal/
    bp-cli/
    bp-test-support/
  packs/
    superclaude/pack.toml
    supercodex/pack.toml
```

What is concrete in this scaffold:
- `bp-pack-manifest` parses and validates declarative `pack.toml`
- `bp-pack-loader` discovers and loads pack manifests
- `bp-pack-inspection` owns route and bridge-plan inspection helpers
- `bp-host-sdk` defines the host contract and selection helpers
- `bp-host-registry` aggregates detected host state and route candidates
- `bp-host-claude` and `bp-host-codex` provide detection/status stubs for future OAuth/session reuse
- `bp-runtime` contains the first transport-resolution helper
- `buildplane-native pack show <pack-id>` is the inspection seam for validating host-aware routing, real detected hosts, `--detected-host` route-selection overrides, and bridge-plan shape on a real machine before live execution exists
- example `pack.toml` manifests exist for SuperClaude and SuperCodex

What is intentionally still stubbed:
- no live Claude/Codex execution bridge yet
- no provider transport yet
- no SQLite write path yet
- no production CLI command surface yet

Migration intent:
- keep the current TS control plane shipping
- grow the native workspace until a vertical slice can replace one subsystem at a time
- only promote native code into the main product path when it wins on reliability and operator UX

Related docs:
- `docs/architecture/buildplane-package-architecture.md`
- `docs/architecture/buildplane-memory-schema.md`
- `docs/architecture/buildplane-memory-cli.md`
