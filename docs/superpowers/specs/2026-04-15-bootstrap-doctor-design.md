# Buildplane Bootstrap Doctor Design

## Slice name

Phase 4 / Slice 4C: bootstrap doctor for host/tool prerequisites

## Why this slice

Slice 4A added read-only workflow scan preview.
Slice 4B added a thin published installer shim.
The next smallest useful adoption slice is a report-only doctor that explains whether the published CLI host prerequisites are actually satisfied.

This keeps the scope narrow:

- no remediation
- no installer rewrite
- no package graph changes
- no native bundling
- no workflow mutation/import

## Chosen behavior

Add a new CLI namespace:

- `bootstrap doctor`

The command reports only three required checks:

- Node exact version
- npm availability
- git availability

It also surfaces one informational note about the current published/global limitation around `buildplane memory ...`.

## Architecture

### 1. New lightweight bootstrap-doctor module

Create a new helper module in the CLI package, for example:

- `apps/cli/src/bootstrap-doctor.ts`

Responsibilities:

- compute a deterministic bootstrap report
- probe required commands using `spawnSync`
- return a structured report object with stable ids and fields

Proposed report shape:

```ts
export interface BootstrapDoctorCheck {
  readonly id: "node" | "npm" | "git";
  readonly label: string;
  readonly ok: boolean;
  readonly required: true;
  readonly expected?: string;
  readonly detected?: string;
  readonly command?: string;
  readonly message: string;
}

export interface BootstrapDoctorReport {
  readonly ok: boolean;
  readonly checks: readonly BootstrapDoctorCheck[];
  readonly notes: readonly string[];
}
```

Implementation should sort checks in a fixed order:

1. node
2. npm
3. git

### 2. Formatter support

Extend `apps/cli/src/formatters.ts` with a dedicated human formatter.

Human output should be compact and deterministic, e.g.:

- `bootstrap-doctor: pass|fail`
- `  - [pass] node: detected 24.13.1 (requires 24.13.1)`
- `  - [fail] npm: command not available`
- `notes:`
- `  - Published/global installs do not yet include a verified `buildplane memory ...` contract.`

Use the existing terminal sanitization helper for any dynamic text.

### 3. CLI dispatch before orchestrator loading

Add `bootstrap doctor` handling in `runCli()` near the existing pre-init surfaces such as:

- `memory list`
- `workflow scan`
- `workspace list`

This command should not load the orchestrator or require `.buildplane`.

### 4. Doctor-only Node-guard bypass plus source-safe command path

Today `apps/cli/src/index.ts` always calls `assertSupportedNodeVersion()` before importing the rest of the CLI.

That makes a doctor command useless on unsupported Node unless the guard and the source import path are both narrowed carefully.

Add helpers in `version-guard.ts`:

```ts
export function shouldBypassNodeVersionGuardForArgv(argv: readonly string[]): boolean
export function assertPublishedCliNodeVersion(argv: readonly string[], current = process.versions.node): void
```

Rules:

- return / bypass only for `bootstrap doctor` with or without `--json`
- return false / throw normally for everything else
- keep the published wrapper contract strict for all non-doctor commands

Implementation note from this slice:

- keep the published `dist/index.js` wrapper shape as close as possible to the existing contract
- put the bypass logic inside the version guard rather than inventing a second published wrapper flow
- keep `runCli()` source-safe by lazy-loading `packet-enrichment` only inside the commands that actually need it, so `bootstrap doctor` can run from source without requiring prebuilt structured-memory package outputs

## Testing strategy

### RED first

1. Add focused unit/integration tests for the new doctor module and CLI command.
2. Add guard tests proving only `bootstrap doctor` bypasses the hard Node gate.
3. Add a smoke/integration test proving the source entrypoint can run `bootstrap doctor --json` under an unsupported Node simulation while `--help` still fails.

### Suggested test files

- create: `apps/cli/test/bootstrap-doctor.test.ts`
- modify: `apps/cli/test/run-cli.test.ts`
- modify: `apps/cli/test/version-guard.test.ts`
- modify: `test/workflow/readme-contract.test.ts`
- modify only if staged/published contract coverage needs alignment:
  - `test/workflow/published-bootstrap-stage.test.ts`
  - `test/workflow/published-bootstrap-install.test.ts`

## Verification set

Run focused tests first:

```bash
npx vitest run \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  apps/cli/test/version-guard.test.ts \
  test/workflow/readme-contract.test.ts
```

If staged/published contract assertions need updates, expand to:

```bash
npx vitest run \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  apps/cli/test/version-guard.test.ts \
  test/workflow/readme-contract.test.ts \
  test/workflow/published-bootstrap-stage.test.ts \
  test/workflow/published-bootstrap-install.test.ts
```

Then repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

Optional manual smoke:

```bash
node apps/cli/dist/index.js bootstrap doctor --json
```

## Explicit non-goals

- no host auto-fix
- no repo doctor
- no installer transport doctor
- no auth/provider checks
- no native contract expansion
- no broad command-routing refactor
