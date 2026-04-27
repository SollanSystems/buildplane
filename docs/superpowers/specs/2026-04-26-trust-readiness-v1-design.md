# Buildplane Trust-Readiness V1 Design

## Slice name

Trust-readiness V1: Node compatibility, capability truth, and explicit CI trust gate

## Context packet

The immediate trigger is a static review that found Buildplane's product thesis strong but its operator trust/readiness surface still too thin for public-install credibility. The first bounded slice is not policy/sandbox hardening, agent version control, replay bundles, or run-cli refactoring. It is the smallest public-readiness slice that makes the existing install and verification contract less brittle and more inspectable.

Live repo context at design time:

- `origin/main` is `a9b8c5630ff1396235ed15c2b1415b3b697245d5`, merged from PR #70, `docs: harden Buildplane truth surface`.
- `.node-version` currently pins `24.13.1`.
- `apps/cli/src/version-guard.ts` currently exports `SUPPORTED_NODE_VERSION = "24.13.1"` and rejects every other Node version for non-doctor commands.
- `apps/cli/src/bootstrap-doctor.ts` currently reports Node, npm, git, and a published/global memory limitation note.
- `.github/workflows/ci.yml` currently runs dev bootstrap smoke and `pnpm verify:published-bootstrap`, plus a wrong-Node guard job.
- `package.json` already has `lint`, `typecheck`, `test`, `build`, `native:build`, `check`, `verify:published-bootstrap`, and `eval` scripts.

## Problem

Buildplane's current published CLI guard treats one exact Node patch version as the compatibility contract. That is useful for early repo determinism, but it is too brittle for a public CLI. A user on a compatible future Node 24 patch should not be rejected solely because the patch number changed.

The repo also has honest README language about repo-local versus published/global capability differences, but the CLI does not yet expose a compact capability truth surface. Operators should not have to infer whether native memory, `node:sqlite`, git, npm, and published/global run paths are available by reading source or chasing README caveats.

Finally, CI should make the deterministic trust gate explicit. A control-plane product should show boring, named verification steps for lint, typecheck, tests, build, native/Rust coverage, and published bootstrap rather than making reviewers infer trust from indirect smoke behavior.

## Goals

1. Replace exact Node patch enforcement with a Node 24 semver range plus feature checks.
2. Keep `.node-version` pinned for repo-development reproducibility while making the published guard accept compatible Node 24 patch/minor releases.
3. Make `bootstrap doctor` report the true compatibility contract in human and JSON forms.
4. Add a capability truth surface that clearly states which capabilities are available in the current install/environment.
5. Make CI's deterministic trust gate explicit and legible.
6. Preserve the current published/global limitation around native memory instead of overclaiming support.

## Non-goals

This slice must not include:

- policy profile expansion
- command sandboxing or allowlists
- network policy
- `agent.yaml`
- agent diff/version-control primitives
- replay bundle export
- run lineage redesign
- broad `run-cli.ts` decomposition
- native binary bundling for npm installs
- package publication or deployment

A tiny helper extraction is allowed only if it prevents duplication in doctor/capability detection.

## Chosen approach

Use a small CLI-local capability module as the shared source of truth for compatibility and capability reporting. Keep the implementation mostly inside `apps/cli/src` so this slice remains focused on operator truth and public install readiness.

Recommended module:

- `apps/cli/src/capabilities.ts`

Responsibilities:

- parse and evaluate Buildplane's supported Node range
- detect whether `node:sqlite` is importable
- detect npm and git availability through injected probes
- detect whether a native binary is discoverable through the same search order documented in README
- return a deterministic capability report suitable for both JSON and human output

The existing `version-guard.ts` should use the same Node compatibility helper instead of hard-coding exact patch equality.

## Node compatibility contract

Use this contract:

```text
>=24.13.1 <25
```

The guard should accept:

- `24.13.1`
- later Node 24 patch releases such as `24.13.2`
- later Node 24 minor releases such as `24.14.0`

The guard should reject:

- `24.13.0`
- earlier Node 24 minors if they are below `24.13.1`
- Node 23 and below
- Node 25 and above until explicitly blessed
- malformed version strings

The error message should name both the range and the detected version. Example:

```text
Buildplane requires Node >=24.13.1 <25. Detected 25.0.0.
```

`.node-version` should remain `24.13.1` for reproducible repo-local CI and development. The distinction is:

- `.node-version` pins the tested development baseline
- the published guard accepts the compatible runtime range

## Capability report shape

The capability report should be stable and contract-testable. It can evolve, but V1 should include at least:

```ts
export interface CapabilityReport {
  readonly ok: boolean;
  readonly environment: {
    readonly detectedNodeVersion: string;
    readonly supportedNodeRange: string;
  };
  readonly capabilities: readonly CapabilityCheck[];
  readonly notes: readonly string[];
}

export interface CapabilityCheck {
  readonly id:
    | "node"
    | "node_sqlite"
    | "npm"
    | "git"
    | "published_run"
    | "repo_local_memory"
    | "published_memory"
    | "native_binary";
  readonly label: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly available: boolean;
  readonly expected?: string;
  readonly detected?: string;
  readonly command?: string;
  readonly message: string;
}
```

V1 semantics:

- `node`: required; range-based compatibility.
- `node_sqlite`: required for supported CLI paths that use SQLite-backed state.
- `npm`: required for published/global npm install and some bootstrap paths.
- `git`: required for repo-backed run/worktree flows.
- `published_run`: required capability describing the verified published/global run contract.
- `repo_local_memory`: optional capability that is available when the repo-local/native bridge path is usable.
- `published_memory`: optional capability that remains unavailable unless a native binary is explicitly discoverable and the published path is verified.
- `native_binary`: optional capability showing whether `BUILDPLANE_NATIVE_BIN`, local native target binaries, or `buildplane-native` on `PATH` were found.

`ok` should mean every required capability passed. Optional unavailable capabilities should not make the report fail, but they must be explicit.

## CLI surfaces

Keep `bootstrap doctor` as the low-friction public entrypoint. Extend it so the existing doctor report uses the shared capability module for Node and feature checks.

Add capability output in one of these forms:

Preferred V1 surface:

```bash
buildplane bootstrap doctor --capabilities
buildplane bootstrap doctor --capabilities --json
```

Optional alias if routing remains simple:

```bash
buildplane doctor --capabilities
buildplane doctor --capabilities --json
```

The implementation should not add a top-level alias if it requires broad routing changes. In that case, the design accepts only the `bootstrap doctor --capabilities` surface for V1.

Unsupported argument handling should remain strict and deterministic. Existing exact doctor forms should continue to work:

```bash
buildplane bootstrap doctor
buildplane bootstrap doctor --json
```

Doctor forms should still run before project initialization and should not create `.buildplane`.

## Human output

Human output should be compact and terminal-safe. Example:

```text
bootstrap-doctor: pass
node: pass — detected 24.13.2; supports >=24.13.1 <25
node:sqlite: pass — node:sqlite import available
npm: pass — npm 10.0.0
git: pass — git version 2.49.0
capabilities:
  - published run: available
  - repo-local memory: available when native binary is discoverable
  - published memory: unavailable; npm package does not bundle buildplane-native
notes:
  - .node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.
```

Dynamic text must use existing terminal-sanitization helpers.

## JSON output

JSON output should be deterministic enough for tests. It should include the same check ids and the same required/optional distinction as human output.

The JSON shape can extend the existing bootstrap doctor report or include a nested `capabilities` object. The important contract is stable ids, stable booleans, stable messages, and explicit notes.

## CI design

The CI workflow should make deterministic trust gates visible with named steps. Keep the existing smoke and published-bootstrap verification, but add or preserve explicit steps for:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

The workflow may use `pnpm check` only if the named steps remain visible enough for operator/reviewer trust. Prefer separate named steps because this product's thesis depends on inspectable verification.

Keep the wrong-Node job, but update it to assert the new boundary:

- one incompatible Node below range should fail normal commands
- `bootstrap doctor` should still be able to report the mismatch
- compatible future Node 24 versions should be represented in unit tests even if CI only installs `.node-version`

Do not add model-backed evals as required CI in this slice. If a deterministic local eval suite is already stable, it can be added later as a separate trust-gate slice.

## Documentation updates

Update README/operator docs to state:

- repo development uses `.node-version` `24.13.1`
- published/global CLI accepts Node `>=24.13.1 <25`
- doctor can report exact local capabilities
- published/global native memory is still not part of the verified package contract
- CI runs an explicit deterministic gate for lint, typecheck, test, build, Rust tests, and published bootstrap

Add or update contract tests so stale README claims are caught.

## Testing strategy

Focused tests should come first.

Recommended test updates:

- `apps/cli/test/version-guard.test.ts`
  - accepts `24.13.1`, `24.13.2`, and `24.14.0`
  - rejects `24.13.0`, `23.x`, `25.x`, and malformed versions
  - error messages include `>=24.13.1 <25`
  - doctor bypass remains narrow

- `apps/cli/test/bootstrap-doctor.test.ts`
  - doctor reports supported range, detected version, and feature checks
  - capability report distinguishes required and optional unavailable capabilities
  - source entrypoint can run doctor/capabilities without creating `.buildplane`

- `apps/cli/test/run-cli.test.ts`
  - CLI rejects unsupported extra doctor/capability arguments
  - human output is deterministic and terminal-safe

- `test/workflow/readme-contract.test.ts`
  - README states the range-based published CLI contract
  - README preserves the published/global native-memory limitation
  - README names the explicit CI trust gate

- `.github/workflows/ci.yml` contract coverage, if an existing workflow contract test exists or can be added narrowly
  - required named steps are present

## Verification commands

Run focused tests first:

```bash
pnpm exec vitest --run \
  apps/cli/test/version-guard.test.ts \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  test/workflow/readme-contract.test.ts
```

Then run standard repo checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run Rust tests if CI is changed to require them explicitly:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml
```

Manual CLI smoke after build:

```bash
node apps/cli/dist/index.js bootstrap doctor --json
node apps/cli/dist/index.js bootstrap doctor --capabilities --json
```

If `pnpm test` or published-bootstrap verification runs side-effecting Buildplane flows, run them in a disposable ext4 worktree and inspect `git log`, not just `git status`, before committing or pushing.

## Acceptance criteria

The slice is accepted when all are true:

1. The published CLI guard is range-based and rejects only versions outside `>=24.13.1 <25` or missing required runtime features.
2. `bootstrap doctor` reports Node range compatibility instead of exact patch equality.
3. A capabilities report is available in human and JSON forms.
4. Capability output explicitly distinguishes required available capabilities from optional unavailable capabilities.
5. Published/global native memory remains clearly marked as not verified unless the native binary is explicitly supplied and discoverable.
6. README/docs explain the difference between `.node-version` as a development baseline and the published CLI's accepted runtime range.
7. CI contains named deterministic trust-gate steps or equivalent contract-tested visibility for lint, typecheck, test, build, Rust tests, and published bootstrap.
8. Focused tests plus repo verification commands pass.
9. No policy/sandbox, agent manifest, replay bundle, or broad run-cli refactor work is included.

## Recovery plan

If the compatibility helper becomes too broad or destabilizes published bootstrap, split the slice:

1. land Node range and doctor report updates first
2. land capability report surface second
3. land CI explicit gate third

If `node:sqlite` detection behaves differently between source and built/published paths, keep the result as a reportable failing check and do not weaken the guard until the actual runtime dependency is understood.

If CI becomes too slow after adding explicit Rust tests, keep the named CI surface but scope Rust to the native workspace command that matches the package's current CI budget, then open a separate CI-performance slice.

## Open decisions resolved for V1

- Use `>=24.13.1 <25` as the accepted published/runtime range.
- Keep `.node-version` pinned to `24.13.1`.
- Prefer `bootstrap doctor --capabilities` over adding a top-level `doctor` alias if the alias increases routing complexity.
- Do not require model-backed evals in this slice.
- Do not expand native memory support claims.
