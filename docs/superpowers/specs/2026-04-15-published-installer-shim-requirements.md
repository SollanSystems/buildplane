# Published Installer Shim — Requirements

**Date:** 2026-04-15
**Scope:** Phase 4 / Slice 4B — one-line installer / published CLI hardening

## Goal

Provide a real one-line installer path that wraps the already-verified published `npm install -g buildplane` contract without widening into bootstrap-doctor or packaging changes.

## Problem

Buildplane already has strong published-bootstrap machinery:
- staged publish artifact generation
- tarball inspection
- packed-install smoke verification
- published README derivation

But the user-facing install path is still just raw `npm install -g buildplane`. The roadmap asks for a zero/low-friction install path, and there is not yet a repo-owned one-line installer wrapper to point users at.

## In scope

- add a thin installer script under `scripts/published-bootstrap/`
- make the script wrap the existing npm global-install contract
- support test-only environment overrides so the script can be smoke-tested against a local packed tarball and isolated npm prefix
- update repo and published README distribution guidance to include the one-line installer and keep `npm install -g buildplane` as explicit fallback/reference
- update published bootstrap verification to exercise the installer path
- add focused workflow tests for the installer shim

## Out of scope

- bootstrap doctor or prerequisite remediation beyond minimal fail-fast checks
- Windows PowerShell installer support
- publishing to npm or release automation
- package/runtime graph refactors unless required by a failing installer smoke
- bundling or provisioning `buildplane-native`
- changing the published memory contract
- workflow import/apply changes beyond already-shipped Slice 4A preview

## Functional requirements

1. The installer script must be a thin wrapper over the published npm install contract, not a parallel bootstrap path.
2. The installer script must support a test-only package/spec override so local smoke tests can install from a packed tarball.
3. The installer script must support a test-only isolated install prefix override.
4. The installer script must fail fast with clear messages if required commands are missing.
5. The installer script must print the next-step command surface after installation.
6. The repo README Distribution section must advertise the installer one-liner.
7. The derived published README must advertise the installer one-liner.
8. `verify-positive` must exercise the installer path for the packed-install smoke.
9. The installer path must not require `pnpm`, `tsx`, or repo-local layout.

## Acceptance criteria

- a focused workflow test can run the installer script against a local packed tarball in an isolated prefix and then execute `buildplane`
- README Distribution section includes the one-line installer and keeps `npm install -g buildplane` fallback/reference
- derived published README includes the same install guidance
- published bootstrap verification still passes through the installer path
- focused workflow tests pass
