# Buildplane Trust-Readiness V1 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace brittle exact Node patch enforcement with range/feature-based readiness, expose Buildplane capability truth through doctor output, and make CI's deterministic trust gate explicit.

**Architecture:** Add a small CLI-local `capabilities.ts` module that owns Node range evaluation, runtime feature checks, command probes, and capability reports. Wire `version-guard.ts`, `bootstrap-doctor.ts`, `formatters.ts`, `run-cli.ts`, README contracts, and CI around that shared truth source. Keep scope bounded to readiness/capability reporting and CI visibility; do not implement policy/sandbox, agent manifests, replay bundles, or broad CLI refactors.

**Tech Stack:** TypeScript, Node.js 24, `node:module`, `node:child_process`, `node:fs`, Vitest, Biome, GitHub Actions, Rust/Cargo for CI native tests.

---

## Context packet

- Base worktree for this plan: `/tmp/buildplane-trust-readiness-spec.1Edf8U`.
- Current branch: `docs/trust-readiness-v1-design`.
- Current design commit: `c4fa6f9 docs: design trust-readiness v1`.
- Approved design: `docs/superpowers/specs/2026-04-26-trust-readiness-v1-design.md`.
- Live main at planning time: `origin/main` = `a9b8c5630ff1396235ed15c2b1415b3b697245d5`.
- Existing exact Node guard: `apps/cli/src/version-guard.ts` exports `SUPPORTED_NODE_VERSION = "24.13.1"` and rejects every other version.
- Existing doctor: `apps/cli/src/bootstrap-doctor.ts` checks Node/npm/git and emits the published memory limitation note.
- Existing doctor dispatch: `apps/cli/src/run-cli.ts:1674-1698` supports only `bootstrap doctor` and `bootstrap doctor --json`.
- Existing human formatter: `apps/cli/src/formatters.ts:262-290` formats bootstrap doctor checks.
- Existing CI: `.github/workflows/ci.yml` runs bootstrap smoke and `pnpm verify:published-bootstrap`, plus a wrong-Node job using Node `24.13.0`.

## Task envelope

**Allowed product paths:**

- `apps/cli/src/capabilities.ts`
- `apps/cli/src/version-guard.ts`
- `apps/cli/src/bootstrap-doctor.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/src/run-cli.ts`
- `apps/cli/test/capabilities.test.ts`
- `apps/cli/test/version-guard.test.ts`
- `apps/cli/test/bootstrap-doctor.test.ts`
- `apps/cli/test/run-cli.test.ts`
- `test/workflow/readme-contract.test.ts`
- `test/workflow/ci-contract.test.ts`
- `README.md`
- `.github/workflows/ci.yml`
- the spec/plan docs already created for this slice

**Out of scope:** policy profiles, command sandboxing, network policy, `agent.yaml`, replay bundle export, run lineage redesign, native binary bundling, npm publication, broad `run-cli.ts` decomposition.

**Required verification at the end:**

```bash
pnpm exec vitest --run \
  apps/cli/test/capabilities.test.ts \
  apps/cli/test/version-guard.test.ts \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  test/workflow/readme-contract.test.ts \
  test/workflow/ci-contract.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
. "$HOME/.cargo/env" && cargo test --manifest-path native/Cargo.toml
git diff --check
```

**Side-effect warning:** `pnpm test` runs native-backed test paths in this repo. Run the implementation in a disposable `/tmp` worktree and inspect both `git status` and `git log` before committing/pushing.

---

### Task 1: Add failing capability-range tests

**Objective:** Define the shared Node compatibility contract before implementation.

**Files:**

- Create: `apps/cli/test/capabilities.test.ts`
- Create later: `apps/cli/src/capabilities.ts`

**Step 1: Write failing tests**

Create `apps/cli/test/capabilities.test.ts` with this first block:

```ts
import { describe, expect, it } from "vitest";
import {
	SUPPORTED_NODE_RANGE,
	isSupportedNodeVersion,
	formatUnsupportedNodeVersionMessage,
} from "../src/capabilities";

describe("Buildplane capability primitives", () => {
	it("uses a Node 24 runtime range instead of an exact patch", () => {
		expect(SUPPORTED_NODE_RANGE).toBe(">=24.13.1 <25");
		expect(isSupportedNodeVersion("24.13.1")).toBe(true);
		expect(isSupportedNodeVersion("24.13.2")).toBe(true);
		expect(isSupportedNodeVersion("24.14.0")).toBe(true);
		expect(isSupportedNodeVersion("24.13.0")).toBe(false);
		expect(isSupportedNodeVersion("23.11.0")).toBe(false);
		expect(isSupportedNodeVersion("25.0.0")).toBe(false);
		expect(isSupportedNodeVersion("not-a-version")).toBe(false);
	});

	it("formats unsupported Node messages with the range and detected version", () => {
		expect(formatUnsupportedNodeVersionMessage("25.0.0")).toBe(
			"Buildplane requires Node >=24.13.1 <25. Detected 25.0.0.",
		);
	});
});
```

**Step 2: Run the test to verify failure**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts
```

Expected: FAIL because `../src/capabilities` does not exist.

**Step 3: Do not implement yet**

Stop after the failing test. The next task creates the helper.

**Step 4: Commit**

Do not commit yet if using TDD micro-commits is too noisy. Prefer committing Task 1 + Task 2 together after the red/green cycle.

---

### Task 2: Create the capability primitive module

**Objective:** Add the minimal shared range helper needed by tests and later guard/doctor wiring.

**Files:**

- Create: `apps/cli/src/capabilities.ts`
- Test: `apps/cli/test/capabilities.test.ts`

**Step 1: Implement minimal range support**

Create `apps/cli/src/capabilities.ts` with this initial code:

```ts
export const SUPPORTED_NODE_RANGE = ">=24.13.1 <25";

interface SemverParts {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

function parseNodeVersion(version: string): SemverParts | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
	if (!match) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function compareSemver(a: SemverParts, b: SemverParts): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

export function isSupportedNodeVersion(version: string): boolean {
	const parsed = parseNodeVersion(version);
	if (!parsed) {
		return false;
	}
	return (
		compareSemver(parsed, { major: 24, minor: 13, patch: 1 }) >= 0 &&
		parsed.major < 25
	);
}

export function formatUnsupportedNodeVersionMessage(version: string): string {
	return `Buildplane requires Node ${SUPPORTED_NODE_RANGE}. Detected ${version}.`;
}
```

**Step 2: Run the focused test**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts
```

Expected: PASS for the initial capability primitives.

**Step 3: Commit**

```bash
git add apps/cli/src/capabilities.ts apps/cli/test/capabilities.test.ts
git commit -m "feat(cli): add capability primitives"
```

---

### Task 3: Add failing version-guard range tests

**Objective:** Prove the published CLI guard accepts compatible Node 24 releases and rejects only out-of-range versions.

**Files:**

- Modify: `apps/cli/test/version-guard.test.ts`
- Modify later: `apps/cli/src/version-guard.ts`

**Step 1: Update version-guard imports**

In `apps/cli/test/version-guard.test.ts`, keep existing imports and add:

```ts
import { SUPPORTED_NODE_RANGE } from "../src/capabilities";
```

**Step 2: Replace exact-patch expectations**

Replace the first four Node-version tests with:

```ts
it("allows compatible Node 24 versions", () => {
	expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
	expect(() => assertSupportedNodeVersion("24.13.2")).not.toThrow();
	expect(() => assertSupportedNodeVersion("24.14.0")).not.toThrow();
});

it("rejects versions below the supported range with a clear error", () => {
	expect(() => assertSupportedNodeVersion("24.13.0")).toThrow(
		new RegExp(`Node ${SUPPORTED_NODE_RANGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*24\\.13\\.0`, "i"),
	);
	expect(() => assertSupportedNodeVersion("20.11.0")).toThrow(
		new RegExp(`Node ${SUPPORTED_NODE_RANGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*20\\.11`, "i"),
	);
});

it("rejects newer major versions until explicitly blessed", () => {
	expect(() => assertSupportedNodeVersion("25.6.1")).toThrow(
		new RegExp(`Node ${SUPPORTED_NODE_RANGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*25\\.6\\.1`, "i"),
	);
});

it("rejects malformed node versions", () => {
	expect(() => assertSupportedNodeVersion("not-a-version")).toThrow(
		/Node >=24\.13\.1 <25.*not-a-version/i,
	);
});
```

If the regex escaping feels too noisy during implementation, add a tiny local helper in the test file:

```ts
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

Then use `escapeRegExp(SUPPORTED_NODE_RANGE)`.

**Step 3: Expand doctor bypass tests for capability forms**

In the existing `bypasses the hard node guard only...` test, add true cases:

```ts
expect(
	shouldBypassNodeVersionGuardForArgv([
		"bootstrap",
		"doctor",
		"--capabilities",
	]),
).toBe(true);
expect(
	shouldBypassNodeVersionGuardForArgv([
		"bootstrap",
		"doctor",
		"--capabilities",
		"--json",
	]),
).toBe(true);
expect(
	shouldBypassNodeVersionGuardForArgv([
		"bootstrap",
		"doctor",
		"--json",
		"--capabilities",
	]),
).toBe(true);
```

Add false cases:

```ts
expect(
	shouldBypassNodeVersionGuardForArgv([
		"bootstrap",
		"doctor",
		"--capabilities",
		"--capabilities",
	]),
).toBe(false);
expect(
	shouldBypassNodeVersionGuardForArgv([
		"bootstrap",
		"doctor",
		"--capabilities",
		"unexpected",
	]),
).toBe(false);
```

**Step 4: Run the test to verify failure**

Run:

```bash
pnpm exec vitest --run apps/cli/test/version-guard.test.ts
```

Expected: FAIL because `version-guard.ts` still uses exact `SUPPORTED_NODE_VERSION` equality and does not bypass `--capabilities` forms.

---

### Task 4: Wire version guard to capability primitives

**Objective:** Make the published CLI guard range-based while preserving the narrow doctor bypass.

**Files:**

- Modify: `apps/cli/src/version-guard.ts`
- Test: `apps/cli/test/version-guard.test.ts`

**Step 1: Replace exact-version export with compatibility export**

At the top of `apps/cli/src/version-guard.ts`, replace:

```ts
export const SUPPORTED_NODE_VERSION = "24.13.1";
```

with:

```ts
import {
	SUPPORTED_NODE_RANGE,
	formatUnsupportedNodeVersionMessage,
	isSupportedNodeVersion,
} from "./capabilities.js";

export { SUPPORTED_NODE_RANGE };
export const SUPPORTED_NODE_VERSION = "24.13.1";
```

Keep `SUPPORTED_NODE_VERSION` temporarily for existing tests/docs that still mean `.node-version` baseline. New compatibility decisions must use `SUPPORTED_NODE_RANGE` and `isSupportedNodeVersion()`.

**Step 2: Add a doctor-flag helper**

Add this helper near `shouldBypassNodeVersionGuardForArgv()`:

```ts
function hasOnlySupportedBootstrapDoctorFlags(flags: readonly string[]): boolean {
	const allowed = new Set(["--json", "--capabilities"]);
	const seen = new Set<string>();
	for (const flag of flags) {
		if (!allowed.has(flag) || seen.has(flag)) {
			return false;
		}
		seen.add(flag);
	}
	return true;
}
```

**Step 3: Replace bypass logic**

Replace the current exact two-form return with:

```ts
export function shouldBypassNodeVersionGuardForArgv(
	argv: readonly string[] = process.argv.slice(2),
): boolean {
	if (argv[0] !== "bootstrap" || argv[1] !== "doctor") {
		return false;
	}
	return hasOnlySupportedBootstrapDoctorFlags(argv.slice(2));
}
```

**Step 4: Replace the hard equality check**

Replace:

```ts
if (current !== SUPPORTED_NODE_VERSION) {
	throw new Error(
		`Buildplane requires Node ${SUPPORTED_NODE_VERSION}. Detected ${current}.`,
	);
}
```

with:

```ts
if (!isSupportedNodeVersion(current)) {
	throw new Error(formatUnsupportedNodeVersionMessage(current));
}
```

**Step 5: Run focused tests**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts apps/cli/test/version-guard.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/cli/src/version-guard.ts apps/cli/test/version-guard.test.ts
git commit -m "fix(cli): accept compatible Node 24 runtimes"
```

---

### Task 5: Add failing capability report tests

**Objective:** Define the JSON capability report contract before wiring doctor output.

**Files:**

- Modify: `apps/cli/test/capabilities.test.ts`
- Modify later: `apps/cli/src/capabilities.ts`

**Step 1: Add probe result helper to the test**

Append to `apps/cli/test/capabilities.test.ts`:

```ts
import type { CapabilityProbeResult } from "../src/capabilities";

function createProbe(
	results: Record<string, CapabilityProbeResult>,
): (command: string, args: readonly string[]) => CapabilityProbeResult {
	return (command) => {
		const result = results[command];
		if (!result) {
			throw new Error(`Unexpected probe: ${command}`);
		}
		return result;
	};
}
```

If this creates an import conflict, fold it into the existing import block.

**Step 2: Add capability report tests**

Add these tests inside the existing describe block:

```ts
import { inspectCapabilities } from "../src/capabilities";

it("reports required runtime capabilities and optional native limitations", () => {
	const report = inspectCapabilities({
		currentNodeVersion: "24.13.2",
		cwd: "/repo",
		detectNodeSqlite: () => ({
			ok: true,
			available: true,
			message: "node:sqlite import available",
		}),
		probeCommand: createProbe({
			npm: {
				ok: true,
				available: true,
				command: "npm --version",
				detected: "10.0.0",
				message: "npm 10.0.0",
			},
			git: {
				ok: true,
				available: true,
				command: "git --version",
				detected: "git version 2.49.0",
				message: "git version 2.49.0",
			},
		}),
		resolveNativeBinary: () => undefined,
	});

	expect(report.ok).toBe(true);
	expect(report.environment).toEqual({
		detectedNodeVersion: "24.13.2",
		supportedNodeRange: ">=24.13.1 <25",
	});
	expect(report.capabilities.map((capability) => capability.id)).toEqual([
		"node",
		"node_sqlite",
		"npm",
		"git",
		"published_run",
		"native_binary",
		"repo_local_memory",
		"published_memory",
	]);
	expect(report.capabilities.find((capability) => capability.id === "node")).toMatchObject({
		ok: true,
		required: true,
		available: true,
		expected: ">=24.13.1 <25",
		detected: "24.13.2",
	});
	expect(
		report.capabilities.find((capability) => capability.id === "published_memory"),
	).toMatchObject({
		ok: true,
		required: false,
		available: false,
	});
});

it("fails the capability report when a required feature is missing", () => {
	const report = inspectCapabilities({
		currentNodeVersion: "24.13.2",
		cwd: "/repo",
		detectNodeSqlite: () => ({
			ok: false,
			available: false,
			message: "node:sqlite import failed",
		}),
		probeCommand: createProbe({
			npm: { ok: true, available: true, command: "npm --version", message: "10.0.0" },
			git: { ok: true, available: true, command: "git --version", message: "git version 2.49.0" },
		}),
		resolveNativeBinary: () => undefined,
	});

	expect(report.ok).toBe(false);
	expect(report.capabilities.find((capability) => capability.id === "node_sqlite")).toMatchObject({
		ok: false,
		required: true,
		available: false,
	});
});
```

**Step 3: Run the test to verify failure**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts
```

Expected: FAIL because `CapabilityProbeResult` and `inspectCapabilities()` do not exist yet.

---

### Task 6: Implement capability report inspection

**Objective:** Make capability reports deterministic, injectable in tests, and safe for doctor usage.

**Files:**

- Modify: `apps/cli/src/capabilities.ts`
- Test: `apps/cli/test/capabilities.test.ts`

**Step 1: Add capability types**

Append to `apps/cli/src/capabilities.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface CapabilityProbeResult {
	readonly ok: boolean;
	readonly available: boolean;
	readonly command?: string;
	readonly detected?: string;
	readonly message: string;
}

export interface CapabilityCheck {
	readonly id:
		| "node"
		| "node_sqlite"
		| "npm"
		| "git"
		| "published_run"
		| "native_binary"
		| "repo_local_memory"
		| "published_memory";
	readonly label: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly available: boolean;
	readonly expected?: string;
	readonly detected?: string;
	readonly command?: string;
	readonly message: string;
}

export interface CapabilityReport {
	readonly ok: boolean;
	readonly environment: {
		readonly detectedNodeVersion: string;
		readonly supportedNodeRange: string;
	};
	readonly capabilities: readonly CapabilityCheck[];
	readonly notes: readonly string[];
}

export interface InspectCapabilitiesOptions {
	readonly currentNodeVersion?: string;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly probeCommand?: (
		command: string,
		args: readonly string[],
	) => CapabilityProbeResult;
	readonly detectNodeSqlite?: () => CapabilityProbeResult;
	readonly resolveNativeBinary?: (cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
}
```

If imports must remain at the top of the file for Biome, move them above the constants.

**Step 2: Add default probes**

Add:

```ts
const requireFromHere = createRequire(import.meta.url);

function defaultProbeCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): CapabilityProbeResult {
	const invocation = [command, ...args].join(" ");
	const result = spawnSync(command, [...args], { encoding: "utf8", env });
	if (result.error) {
		const error = result.error as NodeJS.ErrnoException;
		return {
			ok: false,
			available: false,
			command: invocation,
			message: error.code === "ENOENT" ? "command not available" : error.message,
		};
	}
	if (result.status !== 0) {
		const detected = result.stderr.trim() || result.stdout.trim() || undefined;
		return {
			ok: false,
			available: false,
			command: invocation,
			detected,
			message: `exited with status ${result.status}`,
		};
	}
	const detected = result.stdout.trim() || result.stderr.trim() || undefined;
	return {
		ok: true,
		available: true,
		command: invocation,
		detected,
		message: detected || `${command} is available`,
	};
}

function defaultDetectNodeSqlite(): CapabilityProbeResult {
	try {
		requireFromHere("node:sqlite");
		return {
			ok: true,
			available: true,
			message: "node:sqlite import available",
		};
	} catch (error) {
		return {
			ok: false,
			available: false,
			message: error instanceof Error ? error.message : "node:sqlite import failed",
		};
	}
}

function defaultResolveNativeBinary(
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (env.BUILDPLANE_NATIVE_BIN && existsSync(env.BUILDPLANE_NATIVE_BIN)) {
		return env.BUILDPLANE_NATIVE_BIN;
	}
	for (const candidate of [
		resolve(cwd, "native", "target", "debug", "buildplane-native"),
		resolve(cwd, "native", "target", "release", "buildplane-native"),
	]) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
```

**Step 3: Add `inspectCapabilities()`**

Add:

```ts
function requiredCommandCapability(
	id: "npm" | "git",
	label: string,
	command: string,
	probeCommand: NonNullable<InspectCapabilitiesOptions["probeCommand"]>,
): CapabilityCheck {
	const probe = probeCommand(command, ["--version"]);
	return {
		id,
		label,
		ok: probe.ok,
		required: true,
		available: probe.available,
		command: probe.command,
		detected: probe.detected,
		message: probe.message,
	};
}

export function inspectCapabilities(
	options: InspectCapabilitiesOptions = {},
): CapabilityReport {
	const currentNodeVersion = options.currentNodeVersion ?? process.versions.node;
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const probeCommand =
		options.probeCommand ??
		((command: string, args: readonly string[]) =>
			defaultProbeCommand(command, args, env));
	const detectNodeSqlite = options.detectNodeSqlite ?? defaultDetectNodeSqlite;
	const resolveNativeBinary = options.resolveNativeBinary ?? defaultResolveNativeBinary;
	const nativeBinary = resolveNativeBinary(cwd, env);
	const nodeOk = isSupportedNodeVersion(currentNodeVersion);
	const nodeSqlite = detectNodeSqlite();

	const capabilities: CapabilityCheck[] = [
		{
			id: "node",
			label: "Node.js",
			ok: nodeOk,
			required: true,
			available: nodeOk,
			expected: SUPPORTED_NODE_RANGE,
			detected: currentNodeVersion,
			message: nodeOk
				? `detected ${currentNodeVersion}; supports ${SUPPORTED_NODE_RANGE}`
				: formatUnsupportedNodeVersionMessage(currentNodeVersion),
		},
		{
			id: "node_sqlite",
			label: "node:sqlite",
			ok: nodeSqlite.ok,
			required: true,
			available: nodeSqlite.available,
			message: nodeSqlite.message,
		},
		requiredCommandCapability("npm", "npm", "npm", probeCommand),
		requiredCommandCapability("git", "git", "git", probeCommand),
		{
			id: "published_run",
			label: "Published run contract",
			ok: true,
			required: true,
			available: true,
			message: "verified published/global run contract is available when required checks pass",
		},
		{
			id: "native_binary",
			label: "Native binary",
			ok: true,
			required: false,
			available: Boolean(nativeBinary),
			detected: nativeBinary,
			message: nativeBinary
				? `native binary found at ${nativeBinary}`
				: "native binary not found in BUILDPLANE_NATIVE_BIN or local native target paths",
		},
		{
			id: "repo_local_memory",
			label: "Repo-local memory",
			ok: true,
			required: false,
			available: Boolean(nativeBinary),
			message: nativeBinary
				? "repo-local/native memory commands can use the discovered native binary"
				: "repo-local memory requires a separately built or supplied native binary",
		},
		{
			id: "published_memory",
			label: "Published memory",
			ok: true,
			required: false,
			available: false,
			message: "published/global installs do not yet include a verified buildplane memory contract",
		},
	];

	return {
		ok: capabilities.every((capability) => capability.ok || !capability.required),
		environment: {
			detectedNodeVersion: currentNodeVersion,
			supportedNodeRange: SUPPORTED_NODE_RANGE,
		},
		capabilities,
		notes: [
			".node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.",
			"Published/global installs do not yet include a verified `buildplane memory ...` contract.",
		],
	};
}
```

**Step 4: Run focused tests**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/capabilities.ts apps/cli/test/capabilities.test.ts
git commit -m "feat(cli): report install capabilities"
```

---

### Task 7: Update bootstrap doctor tests for range and capabilities

**Objective:** Prove doctor output uses the shared capability truth and supports `--capabilities` mode.

**Files:**

- Modify: `apps/cli/test/bootstrap-doctor.test.ts`
- Modify later: `apps/cli/src/bootstrap-doctor.ts`

**Step 1: Update imports**

Replace `SUPPORTED_NODE_VERSION` usage with both baseline and range where needed:

```ts
import { SUPPORTED_NODE_RANGE } from "../src/capabilities";
import { SUPPORTED_NODE_VERSION } from "../src/version-guard";
```

Keep `SUPPORTED_NODE_VERSION` only for tests that intentionally refer to the `.node-version` baseline.

**Step 2: Update passing doctor expectations**

Change the deterministic passing report test so the node check expects:

```ts
expect(report.checks).toEqual([
	expect.objectContaining({
		id: "node",
		ok: true,
		required: true,
		expected: SUPPORTED_NODE_RANGE,
		detected: "24.13.2",
	}),
	expect.objectContaining({
		id: "node_sqlite",
		ok: true,
		required: true,
	}),
	expect.objectContaining({ id: "npm", ok: true }),
	expect.objectContaining({ id: "git", ok: true }),
]);
```

Use `currentNodeVersion: "24.13.2"` in the call to prove future compatible patches pass.

**Step 3: Add a missing-feature failure test**

Add:

```ts
it("returns a failing report when node:sqlite is unavailable", () => {
	const report = inspectBootstrapDoctor({
		currentNodeVersion: "24.13.2",
		detectNodeSqlite: () => ({
			ok: false,
			available: false,
			message: "node:sqlite import failed",
		}),
		probeCommand: createProbe({
			npm: { ok: true, available: true, command: "npm --version", message: "10.0.0" },
			git: { ok: true, available: true, command: "git --version", message: "git version 2.49.0" },
		}),
	});

	expect(report.ok).toBe(false);
	expect(report.checks.find((check) => check.id === "node_sqlite")).toMatchObject({
		ok: false,
		required: true,
		message: "node:sqlite import failed",
	});
});
```

**Step 4: Run to verify failure**

Run:

```bash
pnpm exec vitest --run apps/cli/test/bootstrap-doctor.test.ts
```

Expected: FAIL because `inspectBootstrapDoctor()` does not yet accept `detectNodeSqlite` and does not include `node_sqlite`.

---

### Task 8: Wire bootstrap doctor to capabilities

**Objective:** Make normal doctor reports use range-based Node and required feature checks without changing `.buildplane` behavior.

**Files:**

- Modify: `apps/cli/src/bootstrap-doctor.ts`
- Test: `apps/cli/test/bootstrap-doctor.test.ts`

**Step 1: Replace imports and types**

At the top of `bootstrap-doctor.ts`, replace the exact-version import with:

```ts
import {
	type CapabilityProbeResult,
	SUPPORTED_NODE_RANGE,
	formatUnsupportedNodeVersionMessage,
	inspectCapabilities,
	isSupportedNodeVersion,
} from "./capabilities.js";
```

Update `BootstrapDoctorProbeResult` to match the capability probe shape:

```ts
export type BootstrapDoctorProbeResult = CapabilityProbeResult;
```

Expand `BootstrapDoctorCheck.id` to include `"node_sqlite"`.

**Step 2: Extend options**

Add to `BootstrapDoctorOptions`:

```ts
readonly detectNodeSqlite?: () => BootstrapDoctorProbeResult;
readonly cwd?: string;
readonly resolveNativeBinary?: (cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
```

**Step 3: Update command probe returns**

In `defaultProbeCommand()`, add `available: false` to failing returns and `available: true` to passing returns.

**Step 4: Replace `createNodeCheck()`**

Use range-based logic:

```ts
function createNodeCheck(currentNodeVersion: string): BootstrapDoctorCheck {
	const ok = isSupportedNodeVersion(currentNodeVersion);
	return {
		id: "node",
		label: "Node.js",
		ok,
		required: true,
		expected: SUPPORTED_NODE_RANGE,
		detected: currentNodeVersion,
		message: ok
			? `detected ${currentNodeVersion}; supports ${SUPPORTED_NODE_RANGE}`
			: formatUnsupportedNodeVersionMessage(currentNodeVersion),
	};
}
```

**Step 5: Add `createNodeSqliteCheck()`**

```ts
function createNodeSqliteCheck(
	detectNodeSqlite: () => BootstrapDoctorProbeResult,
): BootstrapDoctorCheck {
	const probe = detectNodeSqlite();
	return {
		id: "node_sqlite",
		label: "node:sqlite",
		ok: probe.ok,
		required: true,
		detected: probe.detected,
		command: probe.command,
		message: probe.message,
	};
}
```

**Step 6: Reuse `inspectCapabilities()` for default feature detection**

Inside `inspectBootstrapDoctor()`, create a capabilities report first:

```ts
const capabilitiesReport = inspectCapabilities({
	currentNodeVersion,
	cwd: options.cwd,
	env,
	probeCommand,
	detectNodeSqlite: options.detectNodeSqlite,
	resolveNativeBinary: options.resolveNativeBinary,
});
```

Then construct the doctor checks from the required capability subset:

```ts
const capabilityById = new Map(
	capabilitiesReport.capabilities.map((capability) => [capability.id, capability]),
);
const checks = ["node", "node_sqlite", "npm", "git"].map((id) => {
	const capability = capabilityById.get(id);
	if (!capability) throw new Error(`Missing capability check: ${id}`);
	return {
		id: capability.id as BootstrapDoctorCheck["id"],
		label: capability.label,
		ok: capability.ok,
		required: true,
		expected: capability.expected,
		detected: capability.detected,
		command: capability.command,
		message: capability.message,
	};
});
```

If the type conversion becomes awkward, implement the four checks directly but keep Node/range and sqlite detection delegated to `capabilities.ts`.

**Step 7: Run focused tests**

Run:

```bash
pnpm exec vitest --run apps/cli/test/capabilities.test.ts apps/cli/test/bootstrap-doctor.test.ts
```

Expected: PASS.

**Step 8: Commit**

```bash
git add apps/cli/src/bootstrap-doctor.ts apps/cli/test/bootstrap-doctor.test.ts
git commit -m "feat(cli): check runtime features in bootstrap doctor"
```

---

### Task 9: Add failing formatter tests through run-cli doctor output

**Objective:** Prove human and JSON command surfaces expose capability truth deterministically.

**Files:**

- Modify: `apps/cli/test/run-cli.test.ts`
- Modify later: `apps/cli/src/formatters.ts`
- Modify later: `apps/cli/src/run-cli.ts`

**Step 1: Update `createBootstrapDoctorReport()` fixture**

At the top helper section of `apps/cli/test/run-cli.test.ts`, update the bootstrap report fixture to include `node_sqlite` and range wording:

```ts
{
	id: "node",
	label: "Node.js",
	ok,
	required: true,
	expected: ">=24.13.1 <25",
	detected: "24.13.2",
	message: "detected 24.13.2; supports >=24.13.1 <25",
},
{
	id: "node_sqlite",
	label: "node:sqlite",
	ok,
	required: true,
	message: ok ? "node:sqlite import available" : "node:sqlite import failed",
},
```

**Step 2: Add a capability report fixture**

Add:

```ts
function createCapabilityReport(ok = true) {
	return {
		ok,
		environment: {
			detectedNodeVersion: "24.13.2",
			supportedNodeRange: ">=24.13.1 <25",
		},
		capabilities: [
			{
				id: "node",
				label: "Node.js",
				ok: true,
				required: true,
				available: true,
				expected: ">=24.13.1 <25",
				detected: "24.13.2",
				message: "detected 24.13.2; supports >=24.13.1 <25",
			},
			{
				id: "published_memory",
				label: "Published memory",
				ok: true,
				required: false,
				available: false,
				message: "published/global installs do not yet include a verified buildplane memory contract",
			},
		],
		notes: [
			".node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.",
		],
	};
}
```

**Step 3: Add CLI tests for capabilities mode**

Add near the existing bootstrap doctor tests:

```ts
it("bootstrap doctor --capabilities prints deterministic human capability truth", async () => {
	const root = mkdtempSync(join(tmpdir(), "buildplane-cli-capabilities-human-"));
	const result = await runCliCapture(root, ["bootstrap", "doctor", "--capabilities"], {
		inspectCapabilities: () => createCapabilityReport(true),
	} as unknown as RunCliDependencies);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toEqual([]);
	expect(result.stdout).toContain("capabilities: pass");
	expect(result.stdout.join("\n")).toContain("node");
	expect(result.stdout.join("\n")).toContain("published_memory");
	expect(existsSync(join(root, ".buildplane"))).toBe(false);
});

it("bootstrap doctor --capabilities --json returns capability report", async () => {
	const root = mkdtempSync(join(tmpdir(), "buildplane-cli-capabilities-json-"));
	const report = createCapabilityReport(true);
	const result = await runCliCapture(
		root,
		["bootstrap", "doctor", "--capabilities", "--json"],
		{ inspectCapabilities: () => report } as unknown as RunCliDependencies,
	);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toEqual([]);
	expect(JSON.parse(result.stdout.join("\n"))).toEqual(report);
	expect(existsSync(join(root, ".buildplane"))).toBe(false);
});

it("bootstrap doctor --capabilities rejects unsupported extra arguments", async () => {
	const root = mkdtempSync(join(tmpdir(), "buildplane-cli-capabilities-invalid-"));
	const result = await runCliCapture(root, [
		"bootstrap",
		"doctor",
		"--capabilities",
		"unexpected",
	]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr.join("\n")).toContain(
		"Unsupported bootstrap doctor arguments: --capabilities unexpected",
	);
	expect(existsSync(join(root, ".buildplane"))).toBe(false);
});
```

**Step 4: Run to verify failure**

Run:

```bash
pnpm exec vitest --run apps/cli/test/run-cli.test.ts --testNamePattern='bootstrap doctor|capabilities|top-level help'
```

Expected: FAIL because `runCli` does not yet accept `--capabilities` or expose `inspectCapabilities` dependency.

---

### Task 10: Add capability formatter and CLI dispatch

**Objective:** Implement `bootstrap doctor --capabilities [--json]` without broad CLI refactoring.

**Files:**

- Modify: `apps/cli/src/formatters.ts`
- Modify: `apps/cli/src/run-cli.ts`
- Test: `apps/cli/test/run-cli.test.ts`

**Step 1: Add formatter interfaces**

In `apps/cli/src/formatters.ts`, near bootstrap doctor formatter types, add:

```ts
interface CapabilityCheckLike {
	readonly id: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly available: boolean;
	readonly message: string;
}

interface CapabilityReportLike {
	readonly ok: boolean;
	readonly capabilities: readonly CapabilityCheckLike[];
	readonly notes: readonly string[];
}
```

**Step 2: Add `formatCapabilityReport()`**

```ts
export function formatCapabilityReport(report: CapabilityReportLike): string[] {
	const lines = [`capabilities: ${report.ok ? "pass" : "fail"}`];
	for (const capability of report.capabilities) {
		const status = capability.ok ? "pass" : "fail";
		const required = capability.required ? "required" : "optional";
		const availability = capability.available ? "available" : "unavailable";
		lines.push(
			`  - [${status}] ${sanitizeTerminalText(capability.id)} (${required}, ${availability}): ${sanitizeTerminalText(capability.message)}`,
		);
	}
	if (report.notes.length > 0) {
		lines.push("notes:");
		for (const note of report.notes) {
			lines.push(`  - ${sanitizeTerminalText(note)}`);
		}
	}
	return lines;
}
```

**Step 3: Update run-cli imports**

In `apps/cli/src/run-cli.ts`, import `inspectCapabilities` and `formatCapabilityReport`.

**Step 4: Extend `RunCliDependencies`**

Find the dependencies interface and add:

```ts
readonly inspectCapabilities?: typeof inspectCapabilities;
```

If the dependency interface does not reference imported function types cleanly, use a structural type matching `() => CapabilityReport`.

**Step 5: Update top-level help**

Change the help line:

```ts
"    bootstrap doctor      Check published CLI prerequisites",
```

To:

```ts
"    bootstrap doctor      Check published CLI prerequisites and capabilities",
```

**Step 6: Replace doctor argument validation**

In the `command === "bootstrap"` block, replace current `hasOnlySupportedDoctorArgs` logic with:

```ts
const supportedDoctorFlags = new Set(["--json", "--capabilities"]);
const seenDoctorFlags = new Set<string>();
const hasOnlySupportedDoctorArgs = doctorArgs.every((arg) => {
	if (!supportedDoctorFlags.has(arg) || seenDoctorFlags.has(arg)) {
		return false;
	}
	seenDoctorFlags.add(arg);
	return true;
});
const json = seenDoctorFlags.has("--json");
const capabilities = seenDoctorFlags.has("--capabilities");
```

Keep the existing unsupported-argument error string exactly:

```ts
`Unsupported bootstrap doctor arguments: ${doctorArgs.join(" ")}`
```

**Step 7: Dispatch capabilities mode before normal doctor**

Inside `if (subcommand === "doctor")`, after validation:

```ts
if (capabilities) {
	const report = deps?.inspectCapabilities?.() ?? inspectCapabilities({ cwd });
	if (json) {
		stdout(formatJson(report));
	} else {
		for (const line of formatCapabilityReport(report)) {
			stdout(line);
		}
	}
	return report.ok ? 0 : 1;
}
```

Keep existing normal doctor logic unchanged except for the updated report shape.

**Step 8: Run focused CLI tests**

Run:

```bash
pnpm exec vitest --run apps/cli/test/run-cli.test.ts --testNamePattern='bootstrap doctor|capabilities|top-level help'
```

Expected: PASS.

**Step 9: Commit**

```bash
git add apps/cli/src/formatters.ts apps/cli/src/run-cli.ts apps/cli/test/run-cli.test.ts
git commit -m "feat(cli): expose capability doctor output"
```

---

### Task 11: Update source-entrypoint doctor tests

**Objective:** Prove source entrypoint behavior stays pre-init and guard-safe for new doctor forms.

**Files:**

- Modify: `apps/cli/test/bootstrap-doctor.test.ts`
- Modify if needed: `apps/cli/test/version-guard.test.ts`

**Step 1: Update status expectation for current compatible Node**

In the source entrypoint test, replace:

```ts
expect(result.status).toBe(
	process.versions.node === SUPPORTED_NODE_VERSION ? 0 : 1,
);
```

with:

```ts
expect(result.status).toBe(isSupportedNodeVersion(process.versions.node) ? 0 : 1);
```

Import `isSupportedNodeVersion` from `../src/capabilities`.

**Step 2: Add capabilities source-entrypoint test**

Add:

```ts
it("source entrypoint runs bootstrap doctor --capabilities --json before init", () => {
	const workspaceRoot = mkdtempSync(
		join(tmpdir(), "buildplane-bootstrap-capabilities-entry-"),
	);
	cleanupPaths.push(workspaceRoot);

	const result = spawnSync(
		process.execPath,
		[
			"--conditions",
			"source",
			"--import",
			tsxLoaderEntrypoint,
			cliSourceEntrypoint,
			"bootstrap",
			"doctor",
			"--capabilities",
			"--json",
		],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);

	expect(result.stderr).toBe("");
	expect(result.status).toBe(isSupportedNodeVersion(process.versions.node) ? 0 : 1);
	const payload = JSON.parse(result.stdout);
	expect(payload.environment.supportedNodeRange).toBe(">=24.13.1 <25");
	expect(payload.capabilities.map((check: { id: string }) => check.id)).toContain(
		"published_memory",
	);
	expect(existsSync(join(workspaceRoot, ".buildplane"))).toBe(false);
});
```

**Step 3: Run focused tests**

Run:

```bash
pnpm exec vitest --run apps/cli/test/bootstrap-doctor.test.ts apps/cli/test/version-guard.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add apps/cli/test/bootstrap-doctor.test.ts apps/cli/test/version-guard.test.ts
git commit -m "test(cli): cover capability doctor entrypoint"
```

---

### Task 12: Add README contract tests for trust-readiness truth

**Objective:** Lock the operator-facing contract before editing README.

**Files:**

- Modify: `test/workflow/readme-contract.test.ts`
- Modify later: `README.md`

**Step 1: Add README expectations**

Append these tests to `test/workflow/readme-contract.test.ts`:

```ts
it("documents the Node baseline and published runtime range", () => {
	expect(readme).toContain(".node-version");
	expect(readme).toContain("24.13.1");
	expect(readme).toContain(">=24.13.1 <25");
	expect(readme).toContain(
		".node-version pins the tested development baseline",
	);
});

it("documents capability doctor output for published/global installs", () => {
	expect(distributionSection).toContain(
		"buildplane bootstrap doctor --capabilities --json",
	);
	expect(distributionSection).toContain("node:sqlite");
	expect(distributionSection).toContain("published/global native memory");
});

it("documents the explicit deterministic CI trust gate", () => {
	for (const command of [
		"pnpm lint",
		"pnpm typecheck",
		"pnpm test",
		"pnpm build",
		"cargo test --manifest-path native/Cargo.toml",
		"pnpm verify:published-bootstrap",
	]) {
		expect(readme).toContain(command);
	}
});
```

**Step 2: Run to verify failure**

Run:

```bash
pnpm exec vitest --run test/workflow/readme-contract.test.ts
```

Expected: FAIL because README does not yet document the new range/capability/CI contract.

---

### Task 13: Update README trust-readiness sections

**Objective:** Make operator-facing docs match the new executable truth surface.

**Files:**

- Modify: `README.md`
- Test: `test/workflow/readme-contract.test.ts`

**Step 1: Add runtime-range note near Getting started**

In `README.md`, in or near `## Getting started (repo development)`, add:

```md
Repo development uses `.node-version` (`24.13.1`) as the tested baseline. The published CLI runtime guard accepts compatible Node 24 runtimes in the range `>=24.13.1 <25`; use the doctor commands below to inspect the current host instead of guessing from the pinned development baseline.
```

**Step 2: Add capabilities command to distribution section**

In `## Distribution`, add `buildplane bootstrap doctor --capabilities --json` to the command block:

```bash
npm install -g buildplane
buildplane bootstrap doctor --json
buildplane bootstrap doctor --capabilities --json
buildplane init
buildplane run --packet <path-to-packet.json>
buildplane status --json
buildplane inspect <run-id> --json
```

**Step 3: Preserve memory limitation language**

Update the existing limitation paragraph so it explicitly says:

```md
Published/global native memory remains outside the verified package contract unless you separately supply a discoverable `buildplane-native` binary. The capability doctor reports this as optional/unavailable rather than failing the published run contract.
```

**Step 4: Add CI trust-gate note**

Add a short section near Distribution or Status:

```md
## Verification contract

CI keeps the deterministic trust gate explicit. The required local equivalents are:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

Model-backed evals remain opt-in until a deterministic local suite is promoted into the required gate.
```

Do not duplicate this section if README already has a suitable verification section by implementation time.

**Step 5: Run README contract test**

Run:

```bash
pnpm exec vitest --run test/workflow/readme-contract.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add README.md test/workflow/readme-contract.test.ts
git commit -m "docs: document trust-readiness contract"
```

---

### Task 14: Add CI workflow contract test

**Objective:** Prove CI names the deterministic trust-gate steps before changing workflow YAML.

**Files:**

- Create: `test/workflow/ci-contract.test.ts`
- Modify later: `.github/workflows/ci.yml`

**Step 1: Create the failing test**

Create `test/workflow/ci-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflow = readFileSync(
	join(process.cwd(), ".github/workflows/ci.yml"),
	"utf8",
);

describe("CI trust gate contract", () => {
	it("runs explicit deterministic verification steps", () => {
		for (const step of [
			"Run lint",
			"Run typecheck",
			"Run tests",
			"Run build",
			"Run Rust tests",
			"Verify published bootstrap",
		]) {
			expect(ciWorkflow).toContain(`name: ${step}`);
		}
	});

	it("keeps the wrong-Node guard job", () => {
		expect(ciWorkflow).toContain("verify-wrong-node");
		expect(ciWorkflow).toContain("24.13.0");
		expect(ciWorkflow).toContain("Verify wrong-Node guard");
	});
});
```

**Step 2: Run to verify failure**

Run:

```bash
pnpm exec vitest --run test/workflow/ci-contract.test.ts
```

Expected: FAIL because the workflow does not yet name lint/typecheck/test/build/Rust steps explicitly.

---

### Task 15: Make CI trust gate explicit

**Objective:** Add visible CI steps for deterministic verification without removing existing smoke/published checks.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: `test/workflow/ci-contract.test.ts`

**Step 1: Add named steps after cleanup and before published bootstrap**

In `.github/workflows/ci.yml`, after `Clean Buildplane state before build`, add:

```yaml
      - name: Run lint
        run: pnpm lint

      - name: Run typecheck
        run: pnpm typecheck

      - name: Run tests
        run: pnpm test

      - name: Run build
        run: pnpm build

      - name: Run Rust tests
        run: cargo test --manifest-path native/Cargo.toml
```

Leave the existing `Verify published bootstrap` step after these steps.

**Step 2: Confirm no redundant native build assumption breaks tests**

`pnpm test` already runs `pnpm native:build && vitest --run`, so `Run Rust tests` may reuse compiled artifacts but must still execute `cargo test` explicitly.

**Step 3: Run CI contract test**

Run:

```bash
pnpm exec vitest --run test/workflow/ci-contract.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml test/workflow/ci-contract.test.ts
git commit -m "ci: make trust gate explicit"
```

---

### Task 16: Update published bootstrap wrong-node expectations if needed

**Objective:** Keep wrong-node verification aligned with the new range contract.

**Files:**

- Inspect: `scripts/published-bootstrap/verify-wrong-node.mjs`
- Modify only if needed: `scripts/published-bootstrap/verify-wrong-node.mjs`
- Modify only if needed: related published bootstrap tests under `test/workflow/`

**Step 1: Inspect wrong-node verifier**

Use the file-reading tool to inspect:

```text
scripts/published-bootstrap/verify-wrong-node.mjs
```

**Step 2: Update expected error text only if exact patch text is pinned**

If the script asserts `24.13.1`, update it to assert `>=24.13.1 <25`.

Expected code pattern:

```js
if (!combined.includes("Buildplane requires Node >=24.13.1 <25")) {
  throw new Error("wrong-Node verification did not report the supported range");
}
```

**Step 3: Run relevant verification**

Run:

```bash
BUILDPLANE_EXPECT_UNSUPPORTED_NODE=1 node ./scripts/published-bootstrap/verify-wrong-node.mjs
```

Expected under current Node `24.13.1`: this may SKIP or behave according to the script's own simulation. If it requires a wrong runtime and cannot be simulated locally, rely on unit/contract coverage and CI for this exact path.

**Step 4: Commit if modified**

```bash
git add scripts/published-bootstrap/verify-wrong-node.mjs test/workflow
git commit -m "test: align wrong-node guard with runtime range"
```

If no files changed, record this task as inspected/no-op in the final evidence summary.

---

### Task 17: Run focused verification bundle

**Objective:** Verify the slice's direct acceptance tests before broad repo checks.

**Files:**

- No edits expected.

**Step 1: Run focused Vitest bundle**

Run:

```bash
pnpm exec vitest --run \
  apps/cli/test/capabilities.test.ts \
  apps/cli/test/version-guard.test.ts \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  test/workflow/readme-contract.test.ts \
  test/workflow/ci-contract.test.ts
```

Expected: PASS.

**Step 2: If failures occur**

Fix only failures inside the allowed paths. Do not broaden into policy/sandbox/agent-manifest work.

**Step 3: Commit any focused-test fixes**

```bash
git add <exact-fixed-paths>
git commit -m "fix: stabilize trust-readiness tests"
```

Skip commit if no files changed.

---

### Task 18: Run full local verification

**Objective:** Prove the slice still satisfies repo-level TypeScript, Rust, and build gates.

**Files:**

- No edits expected.

**Step 1: Ensure dependencies exist**

In a fresh `/tmp` worktree, run:

```bash
pnpm install --frozen-lockfile
```

Expected: dependencies installed; no lockfile changes.

**Step 2: Run repo checks**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: PASS.

**Step 3: Run Rust tests**

Run:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml
```

Expected: PASS.

**Step 4: Run diff check**

Run:

```bash
git diff --check
```

Expected: PASS / no output.

**Step 5: Inspect side effects**

Run:

```bash
git status --short --branch
git log --oneline --decorate -n 8
```

Expected: only intended source/docs/test/CI changes are present; no synthetic Buildplane run commits were added by tests. If synthetic commits appear, preserve a backup ref and recover from a clean commit before publishing.

---

### Task 19: Manual CLI smoke after build

**Objective:** Prove the actual built CLI surfaces match docs/tests.

**Files:**

- No edits expected.

**Step 1: Run built doctor JSON**

Run:

```bash
node apps/cli/dist/index.js bootstrap doctor --json
```

Expected: JSON contains `node`, `node_sqlite`, `npm`, and `git` checks; exit code 0 on the supported local Node/runtime.

**Step 2: Run built capability JSON**

Run:

```bash
node apps/cli/dist/index.js bootstrap doctor --capabilities --json
```

Expected: JSON contains `environment.supportedNodeRange` set to `>=24.13.1 <25` and a `published_memory` capability marked optional/unavailable.

**Step 3: Run built human capability output**

Run:

```bash
node apps/cli/dist/index.js bootstrap doctor --capabilities
```

Expected: terminal-safe human output beginning with `capabilities: pass` or `capabilities: fail` depending on required local features; optional unavailable native memory must not fail the report.

---

### Task 20: Final review and handoff prep

**Objective:** Prepare the branch for review without pushing unless explicitly authorized.

**Files:**

- No edits expected unless review finds a defect.

**Step 1: Review diff scope**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Expected changed paths are only the allowed paths listed in the task envelope.

**Step 2: Run final status check**

Run:

```bash
git status --short --branch
```

Expected: clean worktree on the implementation branch.

**Step 3: Prepare PR-ready summary**

Include:

- changed: Node guard, capability report, doctor command, README/CI contracts
- verified: exact commands and pass/fail state
- risks/not run: published registry publication not performed; model-backed evals not required; native bundling not expanded
- next step: review, squash, push/open PR if authorized

**Step 4: Optional squash after review**

If the branch has many task commits and review is complete, use the existing review-stack-then-squash workflow:

```bash
git branch backup/trust-readiness-v1-before-squash-$(date -u +%Y%m%dT%H%M%SZ)
BASE=$(git merge-base HEAD origin/main)
git reset --soft "$BASE"
git commit -m "feat(cli): harden trust readiness surface"
```

Then rerun focused verification before any push.

---

## Final acceptance checklist

- [ ] `apps/cli/src/capabilities.ts` exists and owns `SUPPORTED_NODE_RANGE = ">=24.13.1 <25"`.
- [ ] `assertSupportedNodeVersion()` accepts compatible Node 24 patch/minor releases and rejects outside-range versions.
- [ ] `bootstrap doctor` reports range-based Node compatibility and required `node:sqlite` availability.
- [ ] `bootstrap doctor --capabilities` and `--capabilities --json` work before project init and do not create `.buildplane`.
- [ ] Capability report distinguishes required capabilities from optional unavailable capabilities.
- [ ] Published/global native memory remains explicitly not verified unless separately supplied.
- [ ] README explains `.node-version` baseline versus published runtime range.
- [ ] CI has explicit named deterministic trust-gate steps.
- [ ] Focused Vitest bundle passes.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo test --manifest-path native/Cargo.toml`, and `git diff --check` pass.
- [ ] No policy/sandbox, `agent.yaml`, replay, native bundling, publication, or broad CLI refactor work entered the diff.
