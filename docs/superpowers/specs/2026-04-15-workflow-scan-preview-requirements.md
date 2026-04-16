# Workflow Scan Preview — Requirements

**Date:** 2026-04-15
**Scope:** Phase 4 / Slice 4A — workflow import for Claude Code / Codex configs

## Goal

Give operators a zero-mutation way to see which Claude Code / Codex workflow conventions Buildplane can recognize before any install/apply/import flows exist.

## Problem

Buildplane’s roadmap promises workflow import from existing Claude Code / Codex setups, but the repo currently has no import surface at all. That leaves a habit-friction gap:

- users cannot point Buildplane at an existing Claude/Codex workspace and see what it understands
- there is no low-risk preview step before later apply/bootstrap work
- the next meaningful step risks ballooning into installer/bootstrap or storage-mutation work unless the scan seam is established first

## In scope

- add a read-only CLI command:
  - `buildplane workflow scan [--json]`
- support running the scan before `buildplane init`
- scan a bounded allowlist of high-confidence workflow surfaces only
- classify findings by provider/source and kind
- produce deterministic human and JSON preview output
- add focused scanner and CLI tests

## Out of scope

- writing imported workflow data into `.buildplane`
- storage schema changes
- native `buildplane-native` work
- published bootstrap / installer / npm packaging changes
- bootstrap doctor or environment-prerequisite checks
- recursive home-directory crawling
- importing auth tokens, session history, logs, sqlite state, or other secrets/stateful files
- deep translation of every Claude/Codex config knob into Buildplane settings

## Allowed scan targets for the first slice

The first slice should stay small and only scan explicit, human-authored workflow surfaces:

- `CLAUDE.md`
- `AGENTS.md`
- `.claude/settings.json`
- `.claude/settings.local.json`
- `.claude/hooks/*`
- `.codex/config.toml`
- `.codex/AGENTS.md`

The slice may classify files under these targets, but it must not attempt broad or heuristic scanning outside them.

## Functional requirements

1. `workflow scan` must work in any directory, including before `.buildplane` initialization.
2. `workflow scan` must not create or modify files.
3. Human output must clearly state that the command is a preview only.
4. JSON output must provide deterministic structured findings.
5. Findings must include at least:
   - source path
   - source family/provider (`claude`, `codex`, `shared`)
   - finding kind (`instructions`, `config`, `hooks`)
6. Scan order must be deterministic.
7. Known secret/state files under provider directories must be ignored.
8. Top-level help must advertise the new workflow scan command.

## Acceptance criteria

- `buildplane workflow scan --json` returns a deterministic preview in a temp workspace with Claude/Codex fixtures
- `buildplane workflow scan` prints a compact preview and an explicit no-mutation note
- the scan succeeds before `buildplane init`
- ignored auth/log/state files are not surfaced as import candidates
- focused tests pass
