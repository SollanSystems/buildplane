# Buildplane Workflow Automation Design

**Date:** 2026-03-17
**Product:** Buildplane
**Branch:** `feat/workflow-automation`

## Goal

Establish a strict-but-lean developer workflow for Buildplane that keeps local iteration fast, enforces consistency before code reaches `main`, and provides safe release/dependency automation without overbuilding the project’s tooling stack.

## Decisions

- **Workflow posture:** strict but lean
- **Lint / format tool:** Biome
- **Local hooks:** Husky
- **Commit conventions:** Conventional Commits enforced with Commitlint
- **Release model:** Changesets
- **Dependency automation:** Dependabot
- **CI philosophy:** mirror local commands exactly
- **Autopublish:** disabled for now; release PR flow only

## Rationale

Buildplane is an operator-first infrastructure product. Its workflow should reflect that: boring, explicit, reliable, and easy to inspect. The project should avoid a sprawling JavaScript tooling stack and instead use a small number of opinionated tools that cover the key control points:

- formatting and linting
- commit discipline
- local verification before push
- explicit release intent
- low-maintenance dependency updates
- CI parity with local commands

## Local Developer Workflow

### Canonical root commands

The repo standardizes on these root commands:

- `pnpm lint`
- `pnpm format`
- `pnpm check`
- `pnpm test`
- `pnpm build`
- `pnpm typecheck`

### Command behavior

- `lint` runs `biome check .`
- `format` runs `biome format --write .`
- `test` runs the Vitest suite
- `build` runs the TypeScript composite build
- `typecheck` runs TypeScript in no-emit mode across the project graph
- `check` is the trust gate for local verification before push

### `check` contract

For the current repo stage, `check` runs:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`

This is intentionally stricter than a minimal fast-check command because Buildplane is still small enough for the full gate to remain cheap.

## Lint and Format

### Tool choice

Use **Biome** as the single lint + format tool.

### Why Biome

- replaces the ESLint + Prettier split with one tool
- lower configuration and maintenance burden
- fast local execution
- good fit for a new TypeScript monorepo

### Configuration posture

Keep Biome configuration intentionally small:

- formatter enabled
- linter enabled
- import organization enabled
- project defaults preferred over early rule customization

Custom rules should be added only when a real Buildplane-specific need appears.

## Git Hooks

### Tool choice

Use **Husky**.

### Hook behavior

#### `pre-commit`

Run a fast whole-repo validation step:

- `pnpm lint`

Biome is fast enough on the current Buildplane repo that we can avoid staged-file filtering complexity and extra tooling such as `lint-staged`.

#### `commit-msg`

Run commit message validation:

- `commitlint --edit "$1"`

#### `pre-push`

Run the full verification gate:

- `pnpm check`

This makes push the meaningful local trust boundary while keeping each commit lightweight.

## Commit Conventions

### Convention

Use Conventional Commits with the following allowed types:

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `build`
- `chore`
- `ci`

### Enforcement

Use **Commitlint** with the conventional config baseline.

### Purpose

This keeps history readable, aligns with future release notes, and makes automation easier without creating a heavyweight process.

## Pull Request Expectations

Every PR should answer:

- what changed
- why it changed
- how it was verified
- whether a changeset was added

### PR checklist

- [ ] `pnpm check` passes
- [ ] changeset added if release-worthy and the release track is active
- [ ] docs updated if needed

## Release Automation

### Tool choice

Use **Changesets**.

### Release model

Changesets should be enabled now, but publishing remains disabled until Buildplane is intentionally ready for npm release.

### Activation posture

The repo should be configured for Changesets immediately, but changesets are only required for release-worthy changes once Buildplane has at least one intentionally publishable package or public release track. Before that point, the tooling exists but the process burden stays light.

### Expected workflow

For release-worthy changes:

1. add a changeset in the PR
2. merge to `main`
3. GitHub Actions creates or updates the release PR
4. version bumps and changelog changes accumulate in the release PR
5. publishing is enabled later by policy, not assumed now

### Why this model

- explicit release intent
- good fit for monorepo evolution
- clean changelog path
- avoids accidental public release while the repo is still stabilizing

### `release.yml` purpose

The initial `release.yml` workflow exists to create or update the Changesets release PR only. It does not publish packages to npm in this slice.

## Dependency Automation

### Tool choice

Use **Dependabot**.

### Scope

Configure updates for:

- pnpm / npm dependencies
- GitHub Actions workflows

### Cadence

- weekly dependency update checks
- weekly GitHub Actions update checks

### Activation posture

Dependabot should be configured now so the repo starts with a predictable dependency hygiene path, but updates remain manually reviewed until CI and release confidence mature.

### Automerge policy

Do **not** enable automerge yet.

Dependabot PRs should remain human-reviewed until CI and release confidence are more mature.

## CI Workflow

### Philosophy

CI should mirror the local commands exactly. Avoid CI-only special scripts unless the repo later has a concrete need for them.

### Baseline runner setup

CI should use:

- `actions/checkout`
- `pnpm/action-setup`
- `actions/setup-node` with the pinned Node version and pnpm cache enabled

The repo should also declare its supported Node version in both root `package.json` (`engines.node`) and a local version file such as `.node-version`.

### Required jobs

On pull requests and pushes to `main`, CI should run:

1. install dependencies
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`

### Future additions (not part of this slice)

Possible later enhancements:

- changeset validation
- release workflow publish step
- branch protection assumptions documented in repo settings
- selective Dependabot automerge policy

## Files To Add In This Slice

- `biome.json`
- `.husky/pre-commit`
- `.husky/commit-msg`
- `.husky/pre-push`
- `commitlint.config.cjs`
- `.changeset/config.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/dependabot.yml`
- `.github/pull_request_template.md`
- `.node-version`
- updates to root `package.json`

## Non-Goals

This slice does not include:

- repository-wide branch protection changes via API
- npm publishing enablement
- release drafter / semantic-release setup
- Renovate
- custom ESLint rule stacks
- large contributor governance docs

## Success Criteria

This workflow slice is successful when:

- local contributors can run one obvious verification command (`pnpm check`)
- code formatting and linting are consistent by default
- pushes are blocked on failing verification locally
- PRs clearly indicate verification and release intent
- dependency updates arrive automatically with low maintenance
- release intent is explicit but publication remains safely gated
