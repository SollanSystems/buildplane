# Published Bootstrap Design

**Date:** 2026-03-19
**Status:** Proposed
**Related milestone:** Milestone 1 operator bootstrap outside the repo

## Goal

Make Buildplane usable for an operator standing in an arbitrary git repo after:

```bash
npm install -g buildplane
```

with no Buildplane monorepo checkout and no repo-local toolchain assumptions beyond:

- Node `24.13.1` with bundled `npm`
- `git`

The published CLI must enforce the Node `24.13.1` contract at startup with a clear error when the version does not match.

The published operator-facing command is:

```bash
buildplane <subcommand>
```

for the existing local loop:

1. `buildplane init`
2. `buildplane run --packet <path>`
3. `buildplane status --json`
4. `buildplane inspect <run-id> --json`

This slice defines the **real published/distribution contract**. It does not replace the repo-local developer contract (`pnpm buildplane ...`) and it does not collapse the distinction between internal monorepo development and external operator installation.

## Why this slice next

The repo-local developer bootstrap story is now solid:

- contributors can run `pnpm buildplane ...` after `pnpm install`
- CI proves the repo-dev path before build
- README now clearly says published distribution is not available yet

That leaves one remaining ambiguity in the product surface: what `buildplane` means for a real operator outside this repo.

Right now the gap is explicit but unresolved:

- `apps/cli/package.json` is still `private: true`
- the current package graph relies on workspace dependencies (`workspace:*`)
- repo-local execution still assumes the monorepo layout exists
- the README correctly avoids promising a global-install path, but the product eventually needs one

This next slice should turn “future distribution” from a note into a concrete operator contract.

## In scope

### Operator install contract

Support this first-class user path:

```bash
npm install -g buildplane
buildplane init
buildplane run --packet /absolute/path/to/packet.json
buildplane status --json
buildplane inspect <run-id> --json
```

The operator should be able to do this in an arbitrary git repo without cloning the Buildplane monorepo and without installing workspace-local tools like `pnpm` or `tsx`. The only required local tools are Node `24.13.1` with bundled `npm` and `git`.

### Packaging model

Publish a **single self-contained CLI package** named `buildplane`.

The published CLI must:

- ship compiled runtime artifacts only
- resolve its runtime pieces without workspace links
- avoid source imports at install-time and run-time
- preserve the current operator-visible CLI behavior for `init`, `run`, `status`, and `inspect`

### Metadata and distribution boundary

Define which package in the repo becomes the publish target and how its metadata differs from repo-dev tooling.

At minimum, the design must settle:

- what is published
- what remains private/internal
- what package metadata is authoritative for the public binary
- what repo-only scripts and assumptions must not leak into the published path

### Verification model

Define how to prove the published bootstrap path works **without actually publishing to npm during development**.

The verification must exercise the real install shape closely enough that success is meaningful for the eventual `npm install -g buildplane` contract.

## Out of scope

This slice does **not** include:

- actual npm publication to a public registry
- release automation changes beyond what is required to support packaging later
- multi-package public distribution of `@buildplane/*`
- native executable packaging
- support for Node versions other than `24.13.1`
- non-git repositories
- new CLI subcommands
- changes to runtime, storage, policy, or worktree semantics unrelated to packaging/installability

## Desired operator flow

### Installed operator path

From an arbitrary git repo on a machine with Node `24.13.1` and `git`:

```bash
npm install -g buildplane
buildplane init
buildplane run --packet /absolute/path/to/packet.json
buildplane status --json
buildplane inspect <run-id> --json
```

Expected properties:

- no Buildplane repo checkout required
- no `pnpm` required
- no `tsx` required
- no workspace packages present on disk
- same CLI surface and output shape as the current repo-local and built paths
- same clean-git precondition for `run`, aside from Buildplane-managed `.buildplane` state

### Repo-dev path remains valid

The current contributor path still matters:

```bash
pnpm install
pnpm buildplane init
pnpm buildplane run --packet /absolute/path/to/packet.json
```

This slice must not break that path.

### In-repo built CLI path remains valid

The current built-artifact path still matters:

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet /absolute/path/to/packet.json
```

This slice must not break that path either.

## Packaging approach

### 1. Publish one package: `buildplane`

The published install should remain a single-package contract.

Recommended shape:

- the repo continues to use a private monorepo for development
- `apps/cli/package.json` remains repo-private and is never packed directly
- `apps/cli` remains the source of truth for the public CLI entrypoint and the metadata fields that feed publishing
- the actual npm artifact is produced from a **staged publish directory** with a derived manifest, not by packing the raw `apps/cli/` source tree directly
- the staged publish manifest is the only manifest consumed by `npm pack` and by global-install verification
- internal `@buildplane/*` packages remain development-time structure unless there is a compelling reason to publish them later

This keeps the operator story simple:

- install one package
- invoke one binary
- do not think about internal package boundaries

It also keeps the repo implementation honest: today `apps/cli/package.json` is still private and workspace-linked, so the publish artifact must be assembled deliberately rather than inferred from the raw source package.

### 2. Ship a self-contained compiled runtime

The published `buildplane` package must be self-contained at runtime.

That means the installed package cannot depend on workspace links or repo-only source layout assumptions.

The staged publish directory must contain the exact built runtime closure needed by the CLI. The publish smoke must pack and install that real staged artifact, not a hand-assembled approximation.

The required staged artifact shape for this repo is:

```text
<staged-publish-dir>/
  package.json
  README.md
  dist/
    index.js
    ...compiled runtime closure used by the CLI
```

Rules for that staged artifact:

- `package.json` is the derived publish manifest
- `README.md` is the publish-facing README
- `dist/` contains compiled runtime assets only
- no `src/` or `test/` directories are present in the tarball
- no runtime import in the staged artifact resolves outside the staged package root

The operator contract is fixed:

- compiled artifacts only
- no TypeScript source execution
- no `workspace:*` resolution at runtime
- no imports that require sibling monorepo packages to exist outside the published package

A practical way to think about the boundary:

- monorepo package boundaries remain useful for development
- the published package is an assembled runtime artifact, not a mirror of the monorepo’s source layout

### 3. Keep the public binary pointed at built output

The public binary contract should remain:

```json
"bin": {
  "buildplane": "./dist/index.js"
}
```

The published `./dist/index.js` entrypoint must preserve a Node shebang and executable mode so a bare `buildplane` invocation works after global install.

This is important for two reasons:

- it keeps published execution boring and predictable
- it prevents repo-only source execution techniques from leaking into public install behavior

### 4. Do not make global install depend on repo-only tooling

The published package must not require:

- `pnpm`
- `tsx`
- the monorepo root `package.json`
- sibling workspace packages on disk
- repo-local scripts such as `pnpm buildplane`

Those remain contributor-only concerns.

## Package and metadata boundaries

### Root workspace

Owns:

- developer scripts
- monorepo-only tooling
- CI verification for development and packaging readiness

Must not own:

- the public global-install contract
- runtime requirements for the published package

### `apps/cli`

Owns:

- the source-of-truth metadata for the public `buildplane` package
- the public CLI entrypoint
- the packaging assembly rules needed to make the staged publish artifact self-contained

The staged publish manifest derived from `apps/cli` must declare:

- the public package name
- version
- `bin.buildplane = ./dist/index.js`
- the Node `24.13.1` engine contract
- `files` / packaged asset boundaries
- only publish-safe runtime dependencies and metadata

Must not require:

- workspace links at runtime in the published install
- repo-root scripts or source loaders in the published install

### Internal `@buildplane/*` packages

Own:

- development-time code organization
- internal boundaries and testability

Need not become public packages in this slice.

If they remain private, the published CLI package must assemble what it needs from them into a runtime form that no longer depends on the monorepo package graph.

## Documentation contract

README and any user-facing install docs must clearly distinguish three paths:

1. **Repo development**
   - `pnpm install`
   - `pnpm buildplane ...`

2. **In-repo built CLI path**
   - `pnpm build`
   - `node apps/cli/dist/index.js ...`

3. **Published/global install path**
   - `npm install -g buildplane`
   - `buildplane ...`

Once this slice is implemented, top-level docs should stop describing published install as future-only. They should instead document the real operator contract while preserving the distinction from repo-dev usage.

## Risks and tradeoffs

### Risk: published artifact accidentally depends on monorepo structure

This is the main failure mode.

Examples:

- `workspace:*` dependencies survive into the published package
- published code imports source files that only exist inside the repo
- runtime resolution still expects sibling `@buildplane/*` packages to be present

Mitigation:

- verify install and execution from outside the repo
- inspect the packed artifact, not just the repo tree
- keep the public binary tied to built output only

### Risk: repo-dev and published behavior drift apart

If the repo-dev path and published path use different wiring or assumptions, one can silently break while the other still passes.

Mitigation:

- preserve the same operator-visible CLI behavior across all three paths
- verify repo-dev, built, and published-like smoke flows in the same slice

### Tradeoff: single-package simplicity vs internal purity

A self-contained published CLI is the cleanest operator story, but it means the published artifact is not a naive reflection of the monorepo structure.

That is acceptable here.

The operator contract matters more than preserving internal package purity in the published tarball.

## Verification

This slice is not done until all of the following pass.

### 1. Repo-dev path regression

Use a committed repo-owned smoke packet fixture under `test/fixtures/` or another clean-git-safe location.

```bash
pnpm install --frozen-lockfile
pnpm buildplane init
pnpm buildplane run --packet test/fixtures/<published-smoke-packet>.json
pnpm buildplane status --json
pnpm buildplane inspect <captured-run-id> --json
```

Expected proof points:

- repo-dev path still works after packaging changes
- no hidden dependency on published-only assembly

### 2. In-repo built path regression

Use the same committed repo-owned smoke packet fixture and capture the emitted run id before calling `inspect`.

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet test/fixtures/<published-smoke-packet>.json
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js inspect <captured-run-id> --json
```

Expected proof points:

- built path still works exactly as before
- no regressions in the compiled in-repo CLI path

### 3. Published-package smoke in an external repo

This proof should simulate the eventual public install without requiring an actual public npm publish.

Recommended shape:

1. build the staged publish directory
2. create the publishable tarball from that exact staged directory (`npm pack`)
3. create a fresh arbitrary git repo outside the monorepo with at least one commit so `HEAD` is resolved
4. write a smoke packet outside that repo (or in another clean-git-safe location) so `buildplane run --packet ...` does not fail the clean-worktree gate for the wrong reason
5. install the tarball globally into an isolated npm prefix
6. run the smoke in a sanitized environment where:
   - that prefix's `bin` directory is prepended to `PATH`
   - `command -v buildplane` resolves there
   - `pnpm` is unavailable
   - `tsx` is unavailable
   - no monorepo-local PATH/script leakage is present
7. run `buildplane init`
8. run `buildplane run --packet /absolute/path/to/packet.json` and capture the emitted run id
9. run:

```bash
buildplane status --json
buildplane inspect <captured-run-id> --json
```

Expected proof points:

- the installed binary runs outside the monorepo
- the operator repo is a real git repo with a resolved `HEAD`
- `buildplane` resolves from the isolated global-install prefix used by the smoke
- no workspace links are involved
- no `tsx` or source execution is involved
- the operator-visible behavior matches the repo-dev and built paths

### 4. Packed artifact inspection

Verification must also confirm the packed/publishable artifact itself is sane.

At minimum, inspect that:

- the public package is not marked `private: true`
- the published package metadata declares the Node `24.13.1` engine contract
- `bin.buildplane` points at `./dist/index.js`
- there are no registry-resolved runtime `@buildplane/*` dependencies in the published contract unless they are physically bundled inside the tarball
- published runtime dependencies contain no `workspace:`, `file:`, `link:`, or absolute-path specifiers
- there are no published runtime entrypoints resolving to `src/**` or `.ts` files
- the tarball contains the built runtime files it actually needs and does not ship source/test payloads as runtime requirements
- the tarball preserves a shebang and executable mode on the `bin.buildplane -> ./dist/index.js` entrypoint
- the package does not depend on repo-root scripts or monorepo-only metadata at runtime

### 5. Named publish verification entrypoint

This slice must add one canonical root `package.json` script named `verify:published-bootstrap`, and CI must invoke that exact script.

That script performs the real published-bootstrap proof end to end. It must execute or invoke all required checks for this slice, not just the packed-install subset:

- repo-dev path regression
- in-repo built path regression
- the staged publish build and tarball creation
- the external-repo packed-install smoke in a sanitized environment
- docs and contract checks
- repo verification (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`)
- the negative Node-version guard case

Within the packed-install proof specifically, it must:

- create the tarball with `npm pack`
- install it into an isolated npm prefix
- run the external-repo smoke in a sanitized environment
- capture the emitted run id from `buildplane run --packet ...`
- machine-check exit codes for `init`, `run`, `status`, and `inspect`
- parse `status --json` and `inspect --json`
- verify this minimum JSON contract at a minimum:
  - `status.initialized === true`
  - `status.latestRun.id === <captured-run-id>`
  - `status.latestRun.status === "passed"`
  - `inspect.kind === "run"`
  - `inspect.run.id === <captured-run-id>`
  - `inspect.run.status === "passed"`
  - `inspect.evidence` is an array
  - `inspect.decisions` is an array
- inspect the packed artifact for metadata/runtime isolation requirements

This must be more than a manual checklist. The published-bootstrap contract needs one named local rerun command (`pnpm verify:published-bootstrap`) that CI also executes.

### 6. Docs and contract verification

Verification must also assert that:

- README clearly documents all three paths separately:
  - repo-dev via `pnpm buildplane ...`
  - in-repo built via `node apps/cli/dist/index.js ...`
  - published/global install via `npm install -g buildplane` then `buildplane ...`
- root `scripts.buildplane` remains the repo-dev entrypoint
- the public package binary remains `bin.buildplane = ./dist/index.js`
- published install docs are no longer future-only once this slice lands, but they remain clearly distinct from repo-dev and in-repo built usage

### 7. Repo verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Verification must also include one negative case on a non-`24.13.1` Node runtime to prove the published CLI fails fast with a clear version error. The required mechanism for this slice is a repo-owned CI or script step that invokes the packed CLI under `npx -y node@24.13.0` (or another explicitly pinned non-`24.13.1` version) and asserts the version guard fails before normal execution.

## Open questions resolved by this design

### Should the published install optimize for end users or CI first?

End users first. CI can use the same install shape later.

### Should the primary install contract be `npm install -g buildplane` or `npx buildplane`?

`npm install -g buildplane` is the primary contract for this slice.

### Should the published CLI be self-contained or depend on separately published internal packages?

Self-contained. The operator should install one package.

### Should the published CLI support a broader Node range now?

No. The contract is Node `24.13.1` only in this slice.

## Definition of done

This slice is done when:

- `buildplane` can be installed globally from a publishable package artifact outside the monorepo
- the installed binary works in an arbitrary git repo with only Node `24.13.1` and `git` available
- repo-dev and in-repo built paths still work
- documentation distinguishes repo-dev, built, and published usage honestly
- repo verification remains green
