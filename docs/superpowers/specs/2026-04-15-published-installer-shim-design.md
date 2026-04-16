# Published Installer Shim — Design

**Date:** 2026-04-15
**Scope:** Phase 4 / Slice 4B — one-line installer / published CLI hardening

## Summary

The smallest useful Slice 4B is a repo-owned installer shim:

- `scripts/published-bootstrap/install.sh`

This script is not a new packaging system. It is a thin wrapper over the existing, already-verified published contract:

```bash
npm install -g buildplane
```

For development and verification, the script also accepts test-only environment overrides so it can install a locally packed tarball into an isolated npm prefix.

## Why this slice

This is the smallest step that satisfies the “zero/low-friction install path exists” part of Phase 4 without widening into 4C bootstrap-doctor work.

It is smaller and safer than:
- changing package structure
- adding install lifecycle hooks
- publishing native binaries
- adding doctor/remediation logic

## Proposed behavior

### Installer script

Add:
- `scripts/published-bootstrap/install.sh`

Default behavior:
- require `npm`
- optionally require `git` as a fail-fast check because the runtime contract assumes git repos
- install `buildplane` globally via npm
- print next-step commands like:
  - `buildplane init`
  - `buildplane run --packet /absolute/path/to/packet.json`

Test-only env overrides:
- `BUILDPLANE_INSTALL_SPEC`
  - default: `buildplane`
  - test value: packed tarball path
- `BUILDPLANE_INSTALL_PREFIX`
  - when set, pass `--prefix <value>` to npm install
- `BUILDPLANE_INSTALL_NPM`
  - optional npm binary override for tests if needed

This keeps production usage simple while making local smoke verification deterministic.

### README contract

Update the repo Distribution section and the derived published README to present:
1. the one-line installer as the primary low-friction path
2. `npm install -g buildplane` as explicit fallback/reference

The README must remain honest that:
- the packaged memory contract is still limited
- repo-dev and in-repo built paths remain separate

### Verification change

Update `scripts/published-bootstrap/verify-positive.mjs` so the packed-install smoke uses the installer shim instead of open-coding `npm install -g --prefix ...` directly.

This keeps the positive verifier aligned with the actual user-facing install path.

## Likely files

- `scripts/published-bootstrap/install.sh` (new)
- `scripts/published-bootstrap/readme.mjs`
- `scripts/published-bootstrap/verify-positive.mjs`
- `README.md`
- `test/workflow/readme-contract.test.ts`
- `test/workflow/published-bootstrap-contract.test.ts`
- `test/workflow/published-bootstrap-stage.test.ts`
- `test/workflow/published-bootstrap-install.test.ts` (new)

## Non-goals

- PowerShell installer
- host prerequisite doctoring
- `buildplane-native` bundling
- npm publish automation
- package runtime closure changes unless forced by a real failing smoke
