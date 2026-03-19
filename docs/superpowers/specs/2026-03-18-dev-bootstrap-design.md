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

This is a **repo-local developer experience improvement**. It does not replace the built distribution path.

## Why this slice next

The merged worktree-isolation slice proves the local control-plane loop works once the repo is bootstrapped and built. The remaining friction is developer bootstrap:

- README presents the local loop as ready to use
- a real smoke run on `main` succeeded after `pnpm install && pnpm build`
- a fresh checkout could not run the CLI directly from source before bootstrap because workspace package entrypoints still assume built `.js` siblings exist

That gap is small but important. It slows iteration, makes the local developer story less honest than the README implies, and creates confusion between “the product is broken” and “the developer entrypoint is not prepared yet.”

## In scope

### Developer entrypoint

Add one blessed root-level dev command:

```bash
pnpm buildplane ...
```

This command must execute the CLI from source in the repo workspace after `pnpm install`, without requiring a separate build step.

### Source-runnable package resolution

Make the workspace package entrypoints used by the CLI resolvable in a source-run developer context after install.

The requirement is practical, not ideological:

- source CLI execution must be able to import the workspace packages it depends on
- the fix must not depend on a prior `pnpm build`
- the built path must continue to work unchanged

### Documentation

Update the repo documentation so it clearly distinguishes:

- **repo development flow** — `pnpm install` then `pnpm buildplane ...`
- **built/distributed usage** — built CLI / package binary usage

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
pnpm buildplane run --packet ./packet.json
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

Expected properties:

- no `pnpm build` required before the first local run
- no manual path to `apps/cli/dist/index.js`
- same behavior and output shape as the built CLI

### Built flow remains valid

The existing built/distribution path still matters:

```bash
pnpm build
node apps/cli/dist/index.js ...
```

and any package `bin` behavior should continue to reflect the built CLI, not the source-only dev entrypoint.

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

### 2. Normalize source-run imports

Today the source-run CLI falls over because some workspace package top-level exports point at `.js` files that only exist after build.

The fix should make the CLI’s top-level imports resolvable in a source-run context after install. That likely means normalizing export targets and runtime shims so the source path is internally consistent instead of partially build-dependent.

Constraints:

- prefer one consistent resolution story across workspace packages rather than one-off CLI hacks
- avoid special-casing `run-cli.ts` with fallback import ladders if package metadata can solve it cleanly
- keep the built import path stable so the already-working built smoke path does not regress

### 3. Do not hide builds behind the script

`pnpm buildplane` should not silently run `pnpm build` first.

Reasons:

- it hides expensive work behind a simple command
- it makes first-run latency worse and less predictable
- it obscures whether the source-run path actually works
- it weakens the contract we are trying to establish

If a developer wants the built artifacts, they should still run `pnpm build` explicitly.

### 4. Update README to match reality

README should present the local run loop in two layers:

#### Repo development

```bash
pnpm install
pnpm buildplane init
pnpm buildplane run --packet ./packet.json
```

#### Built/package usage

Use the built binary path as documented for packaged execution.

This prevents a fresh reader from inferring that repo-local usage is identical to a published install.

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

In a fresh worktree or checkout:

```bash
pnpm install --frozen-lockfile
pnpm buildplane init
pnpm buildplane run --packet <packet>
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

Expected proof points:

- init succeeds
- run succeeds for a valid packet
- status reports the completed run
- inspect reports workspace/artifact state correctly
- no prior `pnpm build` was required

### 2. Built-path smoke

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet <packet>
```

Expected proof points:

- built CLI still works exactly as before
- no regressions in the already-working packaged path

### 3. Repo verification

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Open questions resolved by this design

### Should the dev command be `pnpm exec buildplane`?

No. That still depends on binary exposure and build assumptions we do not want to make the primary repo-local path.

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
