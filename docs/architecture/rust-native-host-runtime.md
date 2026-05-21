# Buildplane Rust-first host-aware runtime

Date: 2026-04-24

This document describes the current Rust-first Buildplane runtime track under `native/`. It began as a host-aware scaffold, but it now carries real native command surfaces for pack inspection, memory, ledger/event replay, and fork planning. The TypeScript workspace remains the active product and release surface; native code is promoted into the product path only where it improves reliability, inspectability, or operator UX.

Why this lives under `native/`:
- the TypeScript workspace remains the main repo-local and published package surface
- the Rust workspace gives Buildplane a stronger host/runtime/storage foundation without forcing a rewrite-in-place
- the native seam lets Buildplane migrate one subsystem at a time while preserving the existing pnpm CLI contract

Core separation rules:
- Pack != Host != Provider
- packs own workflow/personality/defaults
- hosts own reusable session/auth surfaces such as Claude/Codex
- providers own direct API transport
- runtime chooses the best route in this order: explicit host, explicit provider, detected preferred host, pack default provider, standalone

Current native workspace layout:

```text
native/
  Cargo.toml
  crates/
    bp-cli/
    bp-config/
    bp-core/
    bp-fork/
    bp-host-claude/
    bp-host-codex/
    bp-host-registry/
    bp-host-sdk/
    bp-ledger/
    bp-ledger-macros/
    bp-memory/
    bp-pack-inspection/
    bp-pack-loader/
    bp-pack-manifest/
    bp-provider-anthropic/
    bp-provider-openai/
    bp-provider-sdk/
    bp-replay/
    bp-runtime/
    bp-storage-sqlite/
    bp-test-support/
    bp-ui-terminal/
  packs/
    superclaude/pack.toml
    supercodex/pack.toml
```

What is concrete now:
- `bp-pack-manifest` parses and validates declarative `pack.toml`
- `bp-pack-loader` discovers and loads pack manifests
- `bp-pack-inspection` owns route and bridge-plan inspection helpers
- `bp-host-sdk` defines the host contract and selection helpers
- `bp-host-registry` aggregates detected host state and route candidates
- `bp-host-claude` and `bp-host-codex` provide host detection/status surfaces
- `bp-runtime` contains transport-resolution helpers
- `bp-storage-sqlite` backs native memory and ledger storage paths
- `bp-memory` owns native memory import/inspect/explain/search/remember/forget/restore/promote/export/import/doctor/prune/link flows
- `bp-ledger` owns native event ledger persistence, serve, replay, and schema behavior
- `bp-replay` supports replay-oriented native state hydration
- `bp-fork` supports native fork planning against ledger events
- `bp-cli` exposes the native command runner used by the TypeScript CLI bridge
- example `pack.toml` manifests exist for SuperClaude and SuperCodex

Current command surfaces:
- `buildplane-native pack show <pack-id>` validates host-aware routing and bridge-plan shape on a real machine
- native `memory` subcommands support SQLite-backed local memory operations
- native `ledger` subcommands support ledger serving/replay paths used by integration tests and recovery flows
- native `fork` planning supports replay/recovery workflows that start from ledger events

Current boundaries / still narrower than the TypeScript control plane:
- no complete native replacement for the TypeScript orchestrator yet
- no live Claude/Codex execution bridge owned fully by native yet
- no direct provider transport promoted as the default production path yet
- published/global npm installs bundle `buildplane-native` for Linux x64 first; Windows and macOS published installs report native-backed memory as optional/unavailable until those binaries are staged explicitly

Migration intent:
- keep the current TypeScript control plane shipping
- grow the native workspace where Rust gives stronger storage, replay, fork, pack, or host boundaries
- only promote native code into the main product path when it wins on reliability and operator UX
- keep docs and help honest about which path is repo-local, in-repo built, native-backed, or published/global

Related docs:
- `docs/architecture/buildplane-package-architecture.md`
- `docs/architecture/buildplane-memory-schema.md`
- `docs/architecture/buildplane-memory-cli.md`
- `docs/ledger.md`
