# Buildplane Package Architecture

Date: 2026-04-24
Status: Current architectural direction for umbrella system and pack model

This document defines how Buildplane, SuperClaude, and SuperCodex fit together as one system.

## Product model

Buildplane is the umbrella system.

SuperClaude and SuperCodex are packs inside Buildplane.

That means:
- Buildplane owns the runtime, memory, policy, storage, operator UX, and public CLI
- SuperClaude owns Claude-oriented workflow defaults and heuristics
- SuperCodex owns Codex-oriented workflow defaults and heuristics
- hosts own reusable local session/auth surfaces such as Claude Code and Codex
- providers own direct API transport such as Anthropic and OpenAI

Central separation rule:

- Pack != Host != Provider

This rule prevents Buildplane from collapsing into a provider wrapper.

## Layer model

### Buildplane

Owns:
- CLI command surface
- runtime orchestration
- memory scopes and retrieval
- policy and trust gates
- durable storage
- inspection and operator controls
- pack loading and selection

### Packs

Own:
- workflow personality
- default modes and commands
- provider-specific heuristics
- pack-scoped memory
- prompt and plan scaffolding

Examples:
- `superclaude`
- `supercodex`

### Hosts

Own:
- local host/session reuse
- host detection
- auth/session state checks
- bridge planning to an installed local host environment

Examples:
- Claude host
- Codex host

### Providers

Own:
- direct API transport
- model request/response adapters
- provider-specific error handling
- streaming contracts

Examples:
- Anthropic provider
- OpenAI provider

## Current repo reality

Buildplane currently has two parallel architecture tracks.

### 1. Active shipping TypeScript workspace

This is still the live product path.

```text
apps/
  cli/
packages/
  kernel/
  storage/
  runtime/
  policy/
  ui-tui/
  adapters-git/
  adapters-models/
  adapters-tools/
  adapters-codex/
  adapters-honcho/
  ledger-client/
  compat-gsd/
```

Current responsibilities:
- `apps/cli` — operator-facing command surface
- `packages/kernel` — typed units, orchestration, packet/run loop primitives
- `packages/storage` — durable state and run evidence
- `packages/runtime` — bounded worker execution lifecycle
- `packages/policy` — budgets, trust gates, retry and decision policy
- `packages/ui-tui` — terminal operator surfaces
- `packages/adapters-*` — model, git, tool, and compatibility integrations

### 2. Rust-first native workspace under `native/`

This native workspace is no longer only a future scaffold. It is the host-aware runtime track for pack inspection, memory, ledger/replay, and fork-planning primitives while the TypeScript workspace remains the main product surface.

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

The native workspace is where the clean pack/host/provider split should harden first. It also now owns native ledger, replay, fork-planning, and memory-storage primitives that the TypeScript CLI can bridge to when repo-local native commands are available.

## Recommended ownership by crate/package

### Native core crates

- `bp-core`
  - core domain types
  - ids, shared models, run context, pack ids, host/provider route types
  - no filesystem, CLI, or SQLite knowledge

- `bp-config`
  - explicit settings
  - profile loading and overrides
  - no learned memory

- `bp-memory`
  - scope resolution
  - retrieval ranking
  - promotion and forget rules
  - explanation generation

- `bp-storage-sqlite`
  - SQLite schema
  - migrations
  - repository implementations for memory and runtime state

- `bp-runtime`
  - run assembly
  - route selection
  - orchestration across pack, host, provider, policy, and storage

### Native pack/route crates

- `bp-pack-manifest`
  - parse and validate `pack.toml`

- `bp-pack-loader`
  - discover installed packs
  - load manifests and assets

- `bp-pack-inspection`
  - explain chosen route, memory visibility, and bridge plan before execution

- `bp-host-sdk`
  - host contracts

- `bp-host-registry`
  - detected host registry and route helpers

- `bp-host-claude`
  - Claude host detection/status

- `bp-host-codex`
  - Codex host detection/status

- `bp-provider-sdk`
  - provider transport interfaces

- `bp-provider-anthropic`
  - Anthropic transport adapter

- `bp-provider-openai`
  - OpenAI transport adapter

### Native delivery and recovery crates

- `bp-ui-terminal`
  - human-readable terminal rendering

- `bp-ledger`
  - native event ledger persistence, serve, replay, and schema behavior

- `bp-ledger-macros`
  - compile-time support for ledger schema/event contracts

- `bp-replay`
  - replay-oriented native state hydration and event streaming helpers

- `bp-fork`
  - fork planning from ledger events and parent run context

- `bp-cli`
  - command wiring and public native CLI contract

- `bp-test-support`
  - shared fixtures and test helpers

## Pack model

Each pack should be declarative first.

Pack manifests already exist at:
- `native/packs/superclaude/pack.toml`
- `native/packs/supercodex/pack.toml`

A pack should declare at least:
- pack identity
- default provider
- memory sharing flags
- modes
- commands
- host preferences

This keeps pack behavior inspectable and versionable.

## Memory boundaries across packs

Buildplane should have one memory platform with layered scopes:
- user
- workspace
- pack
- session

Packs should share the user and workspace layers, but keep pack-specific heuristics separate.

That means:
- SuperClaude and SuperCodex can both benefit from repo conventions and user preferences
- SuperClaude-specific tactics do not automatically pollute SuperCodex
- promotion into broader scopes should be explicit or rule-based

## Dependency rule

The dependency rule should be enforced in both the TypeScript and Rust worlds:
- domain and policy inward
- infrastructure and delivery outward

Recommended native dependency direction:

```text
bp-cli
  -> bp-ui-terminal
  -> bp-runtime
  -> bp-ledger
  -> bp-replay
  -> bp-fork

bp-runtime
  -> bp-core
  -> bp-config
  -> bp-memory
  -> bp-pack-loader
  -> bp-pack-inspection
  -> bp-host-registry
  -> bp-provider-sdk

bp-memory
  -> bp-core

bp-storage-sqlite
  -> bp-core
  -> bp-memory

bp-pack-loader
  -> bp-pack-manifest
  -> bp-core

bp-pack-inspection
  -> bp-core
  -> bp-memory
  -> bp-host-registry

bp-host-claude / bp-host-codex
  -> bp-host-sdk
  -> bp-core

bp-provider-anthropic / bp-provider-openai
  -> bp-provider-sdk
  -> bp-core
```

Invalid dependency examples:
- `bp-core` importing CLI or terminal rendering code
- pack logic writing SQLite directly
- provider adapters deciding memory promotion policy
- host crates owning pack semantics
- config owning learned memory

## Route selection model

Buildplane should select routes in this order:

1. explicit host override
2. explicit provider override
3. detected preferred host from the active pack
4. pack default provider
5. standalone fallback path

This matches the current native design direction and keeps route choice inspectable.

## Public command model

User-facing commands should stay under the Buildplane umbrella:

```bash
buildplane run --packet ./packet.json
buildplane status --json
buildplane history --json
buildplane inspect <run-id> --json
buildplane replay <run-id> --json
buildplane memory list
buildplane memory inspect <learning-id>
buildplane pack show superclaude
buildplane pack show supercodex
```

Native-backed recovery and ledger commands remain under the same `buildplane` umbrella when a repo-local, supplied, or packaged `buildplane-native` binary is available; they should not become separate product CLIs. Published packaging ships Linux x64 native memory first and reports other platforms as unavailable until matching artifacts are staged.

## Migration guidance

Near-term rule:
- keep the TypeScript control plane shipping
- grow the native workspace as the clean architecture target
- replace one subsystem at a time when the native slice is objectively better

Good first native vertical slices:
1. pack loading and route inspection
2. memory store and retrieval inspection
3. ledger/replay/fork primitives for recoverable runs
4. route-aware execution bridge
5. operator-facing memory and pack inspection commands

## Non-goals for now

Do not do these yet:
- create a separate repo for each pack
- merge pack and provider concepts
- make memory provider-global by default
- introduce cloud sync before local inspectability is solid
- bypass the umbrella `buildplane` CLI with competing top-level CLIs

## Architecture summary

Buildplane is the system.
SuperClaude and SuperCodex are packs.
Hosts are local session surfaces.
Providers are API transports.
Memory is shared by scope, not as one undifferentiated blob.

That separation is what lets Buildplane become a real platform instead of a one-provider wrapper.
