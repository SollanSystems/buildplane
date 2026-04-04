# Dev Bootstrap Design

**Date:** 2026-03-18
**Status:** Proposed
**Related milestone:** Milestone 1 local operator loop

## Goal

Make the merged local Buildplane CLI usable from a fresh repo checkout after:

```bash
pnpm install
```

without requiring a prior `pnpm build`.

The approved developer-facing command is:

```bash
pnpm buildplane <subcommand>
```

for the existing local loop:

1. `pnpm buildplane init`
2. `pnpm buildplane run --packet <path>`
3. `pnpm buildplane status --json`
4. `pnpm buildplane inspect <run-id> --json`

This is a **repo-local developer experience improvement**. It does not replace the in-repo built CLI path or change any future distribution story.

## Why this slice next

The merged worktree-isolation slice proves the local control-plane loop works once the repo is bootstrapped and built. The remaining friction is developer bootstrap and operator guidance:

- README presents the local loop as ready to use
- a real smoke run on `main` succeeded after `pnpm install && pnpm build`
- the source CLI entrypoint itself resolves after `pnpm install`, but the repo-local developer command is not yet blessed or documented
- ad-hoc examples that place packet files inside the repo can trip the clean-worktree gate and make the failure look like a bootstrap problem

That gap is small but important. It slows iteration, makes the local developer story less honest than the README implies, and creates confusion between “the product is broken” and “the repo-local workflow is underspecified.”

## In scope

### Developer entrypoint

Add one blessed root-level dev command:

```bash
pnpm buildplane ...
```

This command must execute the CLI from source in the repo workspace after `pnpm install`, without requiring a separate build step.

### Source-run compatibility

Preserve the already-verified source-run behavior needed by the repo-local CLI command after install.

The requirement is practical, not ideological:

- source CLI execution from the repo root must be able to import the workspace packages it depends on
- the repo-local command must not depend on a prior `pnpm build`
- the built path must continue to work unchanged
- if validation shows a package export inconsistency, fix it narrowly; do not assume a package-wide export rewrite without a current repro

### Documentation

Update the repo documentation so it clearly distinguishes:

- **repo development flow** — `pnpm install` then `pnpm buildplane ...`
- **in-repo built CLI path** — `pnpm build` then `node apps/cli/dist/index.js ...`
- **distribution/published install usage (not changed by this slice)** — if and when Buildplane is published, bare `buildplane ...` is a separate contract from repo bootstrap and is not part of this slice’s verification

The current top-level README install guidance must be removed, relabeled, or clearly caveated if it presents bare `buildplane ...` as current repo-bootstrap behavior. No top-level repo doc should present global-install usage as the current local development path.

## Out of scope

This slice does **not** change:

- the public CLI subcommand surface
- packet format
- worktree isolation behavior
- runtime, policy, or storage semantics
- packaging/publishing strategy
- automatic hidden builds inside the dev command
- global install UX beyond existing documentation

## Desired developer flow

### Fresh checkout flow

From a clean checkout of the repo:

```bash
pnpm install
pnpm buildplane init
pnpm buildplane run --packet /absolute/path/to/packet.json
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

The packet used for bootstrap verification should preferably be outside the repo. If it lives inside the repo, it must be committed and intentionally tracked, or written under an ignored path that does not trigger the clean-worktree gate.

Expected properties:

- no `pnpm build` required before the first local run
- no manual path to `apps/cli/dist/index.js`
- same behavior and output shape as the built CLI
- `pnpm buildplane run ...` assumes a clean git working tree aside from generated `.buildplane` state that Buildplane itself is allowed to ignore

### Built flow remains valid

The existing in-repo built CLI path still matters:

```bash
pnpm build
node apps/cli/dist/index.js ...
```

This slice keeps that path as regression-protected behavior alongside the new repo-local source entrypoint.

## Implementation approach

### 1. Add a root script alias

Add a root `package.json` script that becomes the blessed repo-local entrypoint. The approved shape is:

```json
"buildplane": "node --import tsx ./apps/cli/src/index.ts"
```

Why this shape:

- it is short and memorable
- it is explicit about running source code
- it works from the workspace root after dependencies are installed
- it avoids relying on the package `bin` being built first

This command is for developers working in the repo, not for published/global use.

This slice must not retarget package metadata for published/package execution to repo-only source execution.

### 2. Preserve or narrowly repair source-run imports

The first implementation step must validate the current source-run path behind the new root script. If `pnpm buildplane ...` works after `pnpm install`, no broader package-entrypoint refactor is needed.

If that validation exposes a real import failure, fix only the packages involved in the repro.

Constraints:

- prefer one consistent resolution story across the CLI-facing workspace packages
- avoid speculative package-wide export churn without a current failing repro
- avoid special-casing `run-cli.ts` with fallback import ladders if package metadata or adjacent runtime files can solve it cleanly
- keep the built import path stable so the already-working built smoke path does not regress
- do not make any future built/distribution behavior depend on repo-only tooling or monorepo source layout

### 3. Do not hide builds behind the script

`pnpm buildplane` should not silently run `pnpm build` first.

Reasons:

- it hides expensive work behind a simple command
- it makes first-run latency worse and less predictable
- it obscures whether the source-run path actually works
- it weakens the contract we are trying to establish

If a developer wants the built artifacts, they should still run `pnpm build` explicitly.

### 4. Update README to match reality

README should present the local run loop in three layers:

#### Repo development

```bash
pnpm install
pnpm buildplane init
pnpm buildplane run --packet /absolute/path/to/packet.json
```

Use a packet path that does not dirty the repo unexpectedly during the bootstrap example. Repo-dev examples must also state that `buildplane run` expects a clean git working tree aside from generated `.buildplane` state.

#### In-repo built CLI path

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet /absolute/path/to/packet.json
```

#### Distribution/published install note

Document separately that any future bare `buildplane ...` install flow is not the repo bootstrap contract and is not being changed or re-verified in this slice.

This prevents a fresh reader from inferring that repo-local usage is identical to either the in-repo built artifact path or a future published install.

## Package boundary expectations

### Root workspace

Owns:

- the dev-only convenience script
- developer-facing documentation for repo-local usage

Must not own:

- CLI orchestration logic
- runtime behavior changes unrelated to bootstrap

### `apps/cli`

Owns:

- source CLI entrypoint execution
- command parsing and formatting

Must not absorb bootstrap-only fallback logic if package metadata can handle resolution cleanly.

### Workspace packages

Own the consistency of their own entrypoints. If a package claims it can be imported from source-run CLI code, its exports and adjacent runtime files must support that claim after install.

## Risks and tradeoffs

### Risk: source and built resolution diverge

If the source-run path and built path use different import assumptions, the repo can drift into a state where one works and the other breaks.

Mitigation:

- keep one clear import story for top-level package entrypoints
- verify both fresh-install dev usage and built usage in the same slice

### Risk: overfitting to one package

Fixing only the first missing package import would create a brittle chain of follow-up failures.

Mitigation:

- inspect all CLI-facing workspace dependencies together
- normalize the entrypoint pattern across them where needed

### Tradeoff: developer convenience vs package purity

The dev script intentionally privileges repo ergonomics. That is acceptable because it is an explicit root script, not a claim that the published binary is source-executed.

## Verification

This slice is not done until all of the following pass.

### 1. Fresh-install developer smoke

In a fresh worktree or checkout, isolated from the built-path verification state:

```bash
pnpm install --frozen-lockfile
pnpm buildplane init
pnpm buildplane run --packet <absolute-or-safe-ignored-packet>
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

Expected proof points:

- init succeeds
- run succeeds for a valid packet
- status reports the completed run
- inspect reports workspace/artifact state correctly
- no prior `pnpm build` was required
- build outputs in the CLI dependency path are absent before the smoke and are not created or updated by the dev command, including `apps/cli/dist` and any `packages/*/dist` directories for CLI-facing workspace packages

### 2. Built-path smoke

Run this in a separate fresh worktree/checkout, or after an explicit cleanup that removes generated `.buildplane/project.json`, `.buildplane/state.db`, `.buildplane/artifacts`, `.buildplane/evidence`, `.buildplane/runs`, `.buildplane/logs`, `.buildplane/workspaces`, packet outputs, and prior run state from the dev smoke while preserving any intentionally tracked packet fixtures.

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet <absolute-or-safe-ignored-packet>
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js inspect <run-id> --json
```

Expected proof points:

- built CLI still works exactly as before
- status and inspect still report the expected run state
- no regressions in the already-working in-repo built CLI path

### 3. Repo verification

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Verification must include:

- an automated source-run import-closure check for the exact source entrypoint behind `pnpm buildplane`, or for all direct runtime workspace dependencies declared by `apps/cli`, after install and before build
- a dedicated fresh-install repo-dev smoke script or CI step, run after `pnpm install` and before `pnpm build`, that executes the actual blessed contract (`pnpm buildplane init`, `pnpm buildplane run --packet ...`, `pnpm buildplane status --json`, `pnpm buildplane inspect <run-id> --json`) in an unbuilt checkout without creating `dist` outputs
- a root-tooling contract assertion that `package.json` contains `scripts.buildplane` with the approved command shape
- a package-metadata non-regression check that `apps/cli/package.json` keeps `bin.buildplane` pointed at `./dist/index.js`

Expanding the existing import and root-tooling tests is acceptable if they cover the lightweight contract checks. The full fresh-install repo-dev proof does not need to run inside `pnpm test`.

Verification must also include a docs contract check that README clearly distinguishes:

- repo-dev flow using `pnpm buildplane ...`
- repo-dev precondition that `buildplane run` expects a clean git working tree aside from generated `.buildplane` state
- in-repo built flow using `node apps/cli/dist/index.js ...`
- a separately labeled distribution/published-install note that is not presented as the repo bootstrap path
- any existing global-install guidance is removed, relabeled, or clearly caveated so it is not mistaken for the repo-dev bootstrap contract

## Open questions resolved by this design

### Should the dev command be `pnpm exec buildplane`?

No. That is not the repo-local contract for this slice. The explicit developer contract is `pnpm buildplane ...` from the workspace root.

### Should the dev command auto-build?

No. That would mask the bootstrap problem instead of solving it.

### Should we optimize both source and distribution flows equally in this slice?

No. The target of this slice is the **repo developer bootstrap story**. The built path only needs regression protection.

## Definition of done

This slice is done when:

- `pnpm buildplane ...` is the documented repo-local entrypoint
- a fresh checkout works after `pnpm install` alone
- built CLI usage still works after `pnpm build`
- lint, typecheck, and tests remain green
