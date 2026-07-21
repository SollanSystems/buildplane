import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { platform as detectPlatform } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { evaluateToolInvocation } from "@buildplane/capability-broker";
import type {
	GovernedActionExecutionContext,
	GovernedActionExecutor,
	GovernedSandboxAttestationV1,
} from "./action-gateway.js";
import { isActionGatewayMintedExecutionContext } from "./action-gateway.js";
import { registerTrustedGovernedActionExecutor } from "./governed-executor-provenance.js";
import type { RunCommandInput, RunCommandResult } from "./run-command.js";
import type { WriteFileInput, WriteFileResult } from "./write-file.js";

/** The only OCI profile accepted by this first concrete governed executor. */
export const PODMAN_GOVERNED_PROFILE_ID = "podman-rootless-v1" as const;

const CONTAINER_WORKSPACE_ROOT = "/workspace";
const WRITE_FILE_HELPER = "/usr/local/bin/buildplane-action-gateway";
const PINNED_PODMAN_BINARY = "/usr/bin/podman";
const PODMAN_TIMEOUT_MS = 30_000;
const MAX_CPU_CORES = 4;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PIDS_LIMIT = 256;
const MAX_TMPFS_BYTES = 512 * 1024 * 1024;
const REQUIRED_PODMAN_ISOLATION_FLAGS = [
	"--read-only",
	"--network",
	"--http-proxy",
	"--no-hosts",
	"--no-hostname",
	"--cap-drop",
	"--security-opt",
	"--userns",
	"--entrypoint",
] as const;
const PODMAN_PROFILE_FIELDS = [
	"schemaVersion",
	"profileId",
	"profileDigest",
	"cpuCores",
	"memoryBytes",
	"pidsLimit",
	"tmpfsBytes",
] as const;
const PODMAN_OPTIONS_FIELDS = ["image", "profile"] as const;
const PODMAN_TEST_OPTIONS_FIELDS = [
	"image",
	"profile",
	"runner",
	"afterOverlayPromotion",
] as const;
const OVERLAY_RECOVERY_JOURNAL_FIELDS = [
	"schemaVersion",
	"sourcePath",
	"sourceFingerprint",
	"stagingPath",
	"stagingFingerprint",
	"backupPath",
] as const;
const OVERLAY_LOCK_FIELDS = ["schemaVersion", "pid"] as const;
/**
 * These names are owned by the host control plane, never by a governed OCI
 * worker. The evidence store now lives outside the workspace entirely, but
 * keep the legacy in-project location reserved as defense in depth so a
 * future mount or compatibility artifact cannot silently become writable.
 */
const RESERVED_HOST_EVIDENCE_SCOPE_ROOTS = new Set([
	".buildplane",
	".buildplane-host-evidence",
]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/;

/**
 * Closed, bounded container profile. It deliberately does not expose arbitrary
 * Podman arguments, mount options, environment values, or security settings.
 */
export interface PodmanGovernedSandboxProfileV1 {
	readonly schemaVersion: 1;
	readonly profileId: typeof PODMAN_GOVERNED_PROFILE_ID;
	readonly profileDigest: string;
	readonly cpuCores: number;
	readonly memoryBytes: number;
	readonly pidsLimit: number;
	readonly tmpfsBytes: number;
}

export interface PodmanCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

/**
 * Test-only runner seam. The binary is fixed to `podman`, and callers receive
 * an argv vector rather than a shell command string.
 */
export type PodmanCommandRunner = (
	binary: "podman",
	args: readonly string[],
	options: { readonly input?: string; readonly timeoutMs?: number },
) => PodmanCommandResult;

/** Closed constructor options for the rootless Podman action plane. */
export interface CreatePodmanGovernedActionExecutorOptions {
	readonly image: string;
	readonly profile: PodmanGovernedSandboxProfileV1;
}

/**
 * Test-only constructor options. This deliberately lives outside the package
 * barrel: production callers must use `createPodmanGovernedActionExecutor`,
 * which always invokes the real local Podman binary.
 */
export interface CreatePodmanGovernedActionExecutorForTestOptions
	extends CreatePodmanGovernedActionExecutorOptions {
	readonly runner: PodmanCommandRunner;
	/**
	 * Test-only fault seam invoked after staging -> source has been durably
	 * promoted and before backup/journal cleanup. It is unavailable from the
	 * production constructor and deliberately not exported from the package
	 * barrel.
	 */
	readonly afterOverlayPromotion?: () => void;
}

/** Test-only host probe injected alongside the test-only runner. */
export interface PodmanGovernedTestHostProbe {
	readonly platform: string;
}

interface NormalizedOptions {
	readonly image: string;
	readonly profile: PodmanGovernedSandboxProfileV1;
}

interface NormalizedTestOptions extends NormalizedOptions {
	readonly runner: PodmanCommandRunner;
	readonly afterOverlayPromotion?: () => void;
}

interface ResolvedWorkspacePath {
	readonly workspaceRoot: string;
	readonly hostPath: string;
	readonly containerPath: string;
	readonly relativePath: string;
}

interface CapabilityMountRoot {
	readonly relativePath: string;
	readonly hostPath: string;
	readonly containerPath: string;
}

interface CapabilityMountPlan {
	readonly workspaceRoot: string;
	/** Explicit, concrete fsRead declarations. */
	readonly readScopes: readonly CapabilityMountRoot[];
	readonly writeScopes: readonly CapabilityMountRoot[];
	/**
	 * Concrete fsRead roots which must be materialized into private per-action
	 * snapshots. A declared write scope is deliberately absent here: it is
	 * materialized as a per-action staging directory instead of ever being
	 * mounted from the candidate worktree.
	 */
	readonly readSnapshotScopes: readonly CapabilityMountRoot[];
}

interface ContainerMount {
	readonly hostPath: string;
	readonly containerPath: string;
	readonly mode: "ro" | "rw";
}

interface ActionReadSnapshots {
	readonly mounts: readonly ContainerMount[];
	dispose(): void;
}

interface ActionOverlay {
	readonly writeScope: CapabilityMountRoot;
	readonly stagingPath: string;
	/** The source tree fingerprint captured before the OCI action began. */
	readonly sourceFingerprint: string;
	promote(): void;
	dispose(): void;
}

interface OverlayControlPaths {
	readonly lockPath: string;
	readonly journalPath: string;
}

/**
 * A durable write-ahead record for the two-rename host reconciliation. It is
 * created and fsynced before `source -> backup`, then retained until either
 * the original tree is restored or the candidate tree is conclusively
 * promoted. Recovery derives the exact transition from the three paths rather
 * than trusting an in-memory flag that disappears with the worker process.
 */
interface OverlayRecoveryJournal {
	readonly schemaVersion: 1;
	readonly sourcePath: string;
	readonly sourceFingerprint: string;
	readonly stagingPath: string;
	readonly stagingFingerprint: string;
	readonly backupPath: string;
}

interface OverlayLockRecord {
	readonly schemaVersion: 1;
	readonly pid: number;
}

/**
 * A `podman run` control-plane error cannot prove whether the OCI action
 * started. It must escape the executor so the governed worker records the
 * activity as unknown and reconciles it rather than treating it as a safe
 * deterministic failure.
 */
class AmbiguousPodmanControlPlaneOutcomeError extends Error {
	constructor(reason: string) {
		super(
			`Governed Podman action has an ambiguous Podman control-plane outcome and must be reconciled before retry: ${reason}`,
		);
		this.name = "AmbiguousPodmanControlPlaneOutcomeError";
	}
}

/**
 * Creates the concrete rootless Podman implementation selected by a governed
 * ActionGateway. It has no host-tool fallback: every effect is one `podman run`
 * argv invocation against a digest-pinned image.
 */
export function createPodmanGovernedActionExecutor(
	options: CreatePodmanGovernedActionExecutorOptions,
): GovernedActionExecutor {
	const normalized = normalizeOptions(options);
	return createPodmanGovernedActionExecutorWithRuntime(
		normalized,
		defaultPodmanRunner,
		detectPlatform(),
	);
}

/**
 * Test-only dependency seam. It is intentionally not re-exported from the
 * package barrel so application code cannot select a fake host runner through
 * the governed production constructor.
 */
export function createPodmanGovernedActionExecutorForTest(
	options: CreatePodmanGovernedActionExecutorForTestOptions,
	hostProbe: PodmanGovernedTestHostProbe,
): GovernedActionExecutor {
	const normalized = normalizeTestOptions(options);
	return createPodmanGovernedActionExecutorWithRuntime(
		normalized,
		normalized.runner,
		normalizeTestHostPlatform(hostProbe),
		normalized.afterOverlayPromotion,
	);
}

function createPodmanGovernedActionExecutorWithRuntime(
	normalized: NormalizedOptions,
	runner: PodmanCommandRunner,
	hostPlatform: string,
	afterOverlayPromotion?: () => void,
): GovernedActionExecutor {
	assertRootlessPodmanPrerequisites(runner, hostPlatform);
	const sandbox: GovernedSandboxAttestationV1 = Object.freeze({
		schemaVersion: 1,
		runtime: "rootless-oci",
		rootless: true,
		readOnlyBase: true,
		writableOverlay: true,
		network: "none",
		hostFallback: false,
		profileDigest: normalized.profile.profileDigest,
	});

	return registerTrustedGovernedActionExecutor(
		Object.freeze({
			sandbox,
			runCommand(
				input: RunCommandInput,
				context: GovernedActionExecutionContext,
			) {
				try {
					assertGatewayMintedContext(context);
					const command = normalizeCommand(input);
					const workspace = resolveWorkspace(context.worktreeRoot);
					assertCapabilityAllowsCommand(context, command, workspace);
					const mountPlan = hasMutableRole(context)
						? (() => {
								reconcilePendingOverlayPromotions(
									workspace,
									context.capabilityBundle,
									normalized.profile.tmpfsBytes,
								);
								return deriveCapabilityMountPlan(
									workspace,
									context.capabilityBundle,
								);
							})()
						: deriveReadOnlyCapabilityMountPlan(
								workspace,
								context.capabilityBundle,
							);
					const cwd = resolveWorkspacePath(
						workspace,
						input.cwd ?? ".",
						"run_command cwd",
						true,
					);
					if (
						!existsSync(cwd.hostPath) ||
						!lstatSync(cwd.hostPath).isDirectory()
					) {
						return commandFailure(
							"run_command cwd must name an existing workspace directory",
						);
					}
					assertPathHasReadScope(cwd, mountPlan, "run_command cwd");
					const result = runPodman(
						normalized,
						runner,
						context,
						workspace,
						mountPlan,
						cwd.containerPath,
						[command.command, ...command.args],
						undefined,
						afterOverlayPromotion,
					);
					return toRunCommandResult(result);
				} catch (error) {
					if (error instanceof AmbiguousPodmanControlPlaneOutcomeError) {
						throw error;
					}
					return commandFailure(errorMessage(error));
				}
			},
			writeFile(
				input: WriteFileInput,
				context: GovernedActionExecutionContext,
			) {
				try {
					assertGatewayMintedContext(context);
					if (typeof input.content !== "string") {
						return writeFailure("write_file content must be a string");
					}
					assertMutableRole(context);
					const workspace = resolveWorkspace(context.worktreeRoot);
					assertCapabilityAllowsWrite(context, input.path, workspace);
					reconcilePendingOverlayPromotions(
						workspace,
						context.capabilityBundle,
						normalized.profile.tmpfsBytes,
					);
					const mountPlan = deriveCapabilityMountPlan(
						workspace,
						context.capabilityBundle,
					);
					const destination = resolveWorkspacePath(
						workspace,
						input.path,
						"write_file path",
						false,
					);
					if (
						existsSync(destination.hostPath) &&
						lstatSync(destination.hostPath).isDirectory()
					) {
						return writeFailure("write_file path must not name a directory");
					}
					const writeMount = assertPathHasWriteScope(destination, mountPlan);
					const result = runPodman(
						normalized,
						runner,
						context,
						workspace,
						mountPlan,
						writeMount.containerPath,
						[
							WRITE_FILE_HELPER,
							"write-file",
							"--path",
							destination.containerPath,
						],
						input.content,
						afterOverlayPromotion,
					);
					return toWriteFileResult(result, input.path);
				} catch (error) {
					if (error instanceof AmbiguousPodmanControlPlaneOutcomeError) {
						throw error;
					}
					return writeFailure(errorMessage(error));
				}
			},
		}),
	);
}

function normalizeOptions(input: unknown): NormalizedOptions {
	const options = readClosedRecord(
		input,
		"Podman governed executor options",
		PODMAN_OPTIONS_FIELDS,
	);
	const image = readRequiredString(
		options,
		"image",
		"Podman governed executor",
	);
	if (!DIGEST_PINNED_IMAGE.test(image)) {
		throw new TypeError(
			"Podman governed executor image must be an explicit lowercase digest-pinned OCI reference.",
		);
	}
	return Object.freeze({
		image,
		profile: normalizeProfile(options.profile, image),
	});
}

function normalizeTestOptions(input: unknown): NormalizedTestOptions {
	const options = readClosedRecord(
		input,
		"Podman governed executor test options",
		PODMAN_TEST_OPTIONS_FIELDS,
	);
	const runner = options.runner;
	if (typeof runner !== "function") {
		throw new TypeError(
			"Podman governed executor test options runner must be a function.",
		);
	}
	const afterOverlayPromotion = options.afterOverlayPromotion;
	if (
		afterOverlayPromotion !== undefined &&
		typeof afterOverlayPromotion !== "function"
	) {
		throw new TypeError(
			"Podman governed executor test options afterOverlayPromotion must be a function when provided.",
		);
	}
	const normalized = normalizeOptions({
		image: options.image,
		profile: options.profile,
	});
	return Object.freeze({
		...normalized,
		runner: runner as PodmanCommandRunner,
		...(afterOverlayPromotion === undefined
			? {}
			: { afterOverlayPromotion: afterOverlayPromotion as () => void }),
	});
}

function normalizeTestHostPlatform(
	hostProbe: PodmanGovernedTestHostProbe,
): string {
	const record = readClosedRecord(
		hostProbe,
		"Podman governed test host probe",
		["platform"],
	);
	return readRequiredString(
		record,
		"platform",
		"Podman governed test host probe",
	);
}

/**
 * Match the feasibility evidence required by the governed runtime before a
 * single `podman run` action can be constructed. `--userns=keep-id` is a
 * defense-in-depth runtime flag, not proof that the selected Podman daemon is
 * rootless.
 */
function assertRootlessPodmanPrerequisites(
	runner: PodmanCommandRunner,
	hostPlatform: string,
): void {
	if (hostPlatform !== "linux") {
		throw new Error(
			"Governed Podman execution requires a Linux or WSL Linux process; host fallback is disabled.",
		);
	}

	const version = runPodmanProbe(runner, ["--version"]);
	if (!probeSucceeded(version)) {
		throw new Error(
			"Rootless Podman prerequisite check failed: the Podman runtime is unavailable.",
		);
	}
	if (!parsePodmanVersion(version.stdout)) {
		throw new Error(
			"Rootless Podman prerequisite check failed: Podman did not report a parseable version.",
		);
	}

	const info = runPodmanProbe(runner, ["info", "--format", "json"]);
	if (!probeSucceeded(info) || !podmanReportsRootless(info.stdout)) {
		throw new Error(
			"Rootless Podman prerequisite check failed: rootless mode could not be proven.",
		);
	}

	const userNamespace = runPodmanProbe(runner, ["unshare", "true"]);
	if (!probeSucceeded(userNamespace)) {
		throw new Error(
			"Rootless Podman prerequisite check failed: user namespaces are unavailable.",
		);
	}

	const help = runPodmanProbe(runner, ["run", "--help"]);
	if (
		!probeSucceeded(help) ||
		!REQUIRED_PODMAN_ISOLATION_FLAGS.every((flag) => help.stdout.includes(flag))
	) {
		throw new Error(
			"Rootless Podman prerequisite check failed: required isolation flags are unavailable.",
		);
	}
}

function runPodmanProbe(
	runner: PodmanCommandRunner,
	args: readonly string[],
): PodmanCommandResult {
	try {
		return normalizeRunnerResult(
			runner("podman", Object.freeze([...args]), Object.freeze({})),
		);
	} catch (error) {
		return {
			status: null,
			stdout: "",
			stderr: "",
			error: errorMessage(error),
		};
	}
}

function probeSucceeded(result: PodmanCommandResult): boolean {
	return result.status === 0 && result.error === undefined;
}

function parsePodmanVersion(stdout: string): boolean {
	return /\bpodman\s+version\s+\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?/i.test(
		stdout,
	);
}

function podmanReportsRootless(stdout: string): boolean {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (!isRecord(parsed)) return false;
		const host = parsed.host;
		if (!isRecord(host)) return false;
		const security = host.security;
		return isRecord(security) && security.rootless === true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical sandbox identity. The digest deliberately covers the digest-pinned
 * worker image as well as every resource limit: a signed dispatch cannot
 * claim one sandbox profile and execute another image with the same limits.
 */
export function podmanGovernedSandboxProfileDigest(input: {
	readonly image: string;
	readonly schemaVersion: 1;
	readonly profileId: typeof PODMAN_GOVERNED_PROFILE_ID;
	readonly cpuCores: number;
	readonly memoryBytes: number;
	readonly pidsLimit: number;
	readonly tmpfsBytes: number;
}): string {
	return `sha256:${createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: input.schemaVersion,
				profileId: input.profileId,
				image: input.image,
				cpuCores: input.cpuCores,
				memoryBytes: input.memoryBytes,
				pidsLimit: input.pidsLimit,
				tmpfsBytes: input.tmpfsBytes,
			}),
			"utf8",
		)
		.digest("hex")}`;
}

function normalizeProfile(
	input: unknown,
	image: string,
): PodmanGovernedSandboxProfileV1 {
	const profile = readClosedRecord(
		input,
		"Podman governed sandbox profile",
		PODMAN_PROFILE_FIELDS,
	);
	if (profile.schemaVersion !== 1) {
		throw new TypeError(
			"Podman governed sandbox profile schemaVersion must be 1.",
		);
	}
	if (profile.profileId !== PODMAN_GOVERNED_PROFILE_ID) {
		throw new TypeError(
			`Podman governed sandbox profileId must be '${PODMAN_GOVERNED_PROFILE_ID}'.`,
		);
	}
	const profileDigest = readRequiredString(
		profile,
		"profileDigest",
		"Podman governed sandbox profile",
	);
	if (!SHA256_DIGEST.test(profileDigest)) {
		throw new TypeError(
			"Podman governed sandbox profileDigest must be a lowercase SHA-256 digest.",
		);
	}
	const cpuCores = readBoundedNumber(
		profile,
		"cpuCores",
		0,
		MAX_CPU_CORES,
		false,
	);
	const memoryBytes = readBoundedNumber(
		profile,
		"memoryBytes",
		0,
		MAX_MEMORY_BYTES,
		true,
	);
	const pidsLimit = readBoundedNumber(
		profile,
		"pidsLimit",
		0,
		MAX_PIDS_LIMIT,
		true,
	);
	const tmpfsBytes = readBoundedNumber(
		profile,
		"tmpfsBytes",
		0,
		Math.min(MAX_TMPFS_BYTES, memoryBytes),
		true,
	);
	const expectedDigest = podmanGovernedSandboxProfileDigest({
		image,
		schemaVersion: 1,
		profileId: PODMAN_GOVERNED_PROFILE_ID,
		cpuCores,
		memoryBytes,
		pidsLimit,
		tmpfsBytes,
	});
	if (profileDigest !== expectedDigest) {
		throw new TypeError(
			"Podman governed sandbox profileDigest must canonically bind the image and resource limits.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		profileId: PODMAN_GOVERNED_PROFILE_ID,
		profileDigest,
		cpuCores,
		memoryBytes,
		pidsLimit,
		tmpfsBytes,
	});
}

function normalizeCommand(input: RunCommandInput): {
	readonly command: string;
	readonly args: readonly string[];
} {
	if (typeof input.command !== "string" || input.command.length === 0) {
		throw new TypeError("run_command command must be a non-empty string");
	}
	if (input.command.includes("\0")) {
		throw new TypeError("run_command command must not contain a NUL byte");
	}
	if (input.args !== undefined && !Array.isArray(input.args)) {
		throw new TypeError("run_command args must be an array of strings");
	}
	const args = input.args ?? [];
	if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new TypeError("run_command args must be strings without NUL bytes");
	}
	return Object.freeze({ command: input.command, args: [...args] });
}

function assertGatewayMintedContext(
	context: GovernedActionExecutionContext,
): void {
	if (!isActionGatewayMintedExecutionContext(context)) {
		throw new Error(
			"Governed Podman execution context must be minted by ActionGateway; direct executor calls are denied.",
		);
	}
}

/**
 * The gateway is the primary authorization boundary, but the concrete action
 * executor repeats the broker decision before constructing a container argv.
 * This catches a compromised adapter that forwards a gateway-minted context
 * with different action input.
 */
function assertCapabilityAllowsCommand(
	context: GovernedActionExecutionContext,
	command: { readonly command: string; readonly args: readonly string[] },
	workspace: ResolvedWorkspacePath,
): void {
	const decision = evaluateToolInvocation(
		context.capabilityBundle,
		{
			tool: "run_command",
			command: command.command,
			...(command.args.length === 0 ? {} : { args: command.args }),
		},
		{ worktreeRoot: workspace.workspaceRoot },
	);
	if (decision.decision === "deny") {
		throw new Error(`capability broker: ${decision.reason}`);
	}
}

function assertCapabilityAllowsWrite(
	context: GovernedActionExecutionContext,
	path: string,
	workspace: ResolvedWorkspacePath,
): void {
	const decision = evaluateToolInvocation(
		context.capabilityBundle,
		{ tool: "write_file", path },
		{ worktreeRoot: workspace.workspaceRoot },
	);
	if (decision.decision === "deny") {
		throw new Error(`capability broker: ${decision.reason}`);
	}
}

function assertMutableRole(context: GovernedActionExecutionContext): void {
	if (!hasMutableRole(context)) {
		throw new Error(
			"Podman governed executor permits filesystem writes only for implementer and candidate roles.",
		);
	}
}

function hasMutableRole(context: GovernedActionExecutionContext): boolean {
	return context.role === "implementer" || context.role === "candidate";
}

function resolveWorkspace(worktreeRoot: string): ResolvedWorkspacePath {
	if (typeof worktreeRoot !== "string" || worktreeRoot.length === 0) {
		throw new TypeError(
			"governed worktreeRoot must be a non-empty absolute path",
		);
	}
	if (worktreeRoot.includes("\0") || !isAbsolute(worktreeRoot)) {
		throw new TypeError(
			"governed worktreeRoot must be a non-empty absolute path",
		);
	}
	if (!existsSync(worktreeRoot) || !lstatSync(worktreeRoot).isDirectory()) {
		throw new Error("governed worktreeRoot must name an existing directory");
	}
	const canonicalRoot = realpathSync(worktreeRoot);
	return {
		workspaceRoot: canonicalRoot,
		hostPath: canonicalRoot,
		containerPath: CONTAINER_WORKSPACE_ROOT,
		relativePath: "",
	};
}

function resolveWorkspacePath(
	workspace: ResolvedWorkspacePath,
	input: unknown,
	label: string,
	allowRoot: boolean,
): ResolvedWorkspacePath {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
		throw new TypeError(`${label} must be a non-empty relative path`);
	}
	if (isAbsolute(input)) {
		throw new Error(`${label} must not be an absolute path`);
	}
	const segments =
		input === "."
			? []
			: input.split(/[\\/]+/).filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === "..")) {
		throw new Error(`${label} must not traverse outside the workspace`);
	}
	if (segments.some((segment) => segment === ".")) {
		throw new Error(`${label} must not contain dot path segments`);
	}
	if (segments.length === 0 && !allowRoot) {
		throw new Error(`${label} must not be the workspace root`);
	}

	const hostPath = resolve(workspace.workspaceRoot, ...segments);
	assertContained(workspace.workspaceRoot, hostPath, label);
	assertExistingPathComponentsRemainContained(
		workspace.workspaceRoot,
		segments,
		label,
	);
	if (existsSync(hostPath)) {
		assertContained(workspace.workspaceRoot, realpathSync(hostPath), label);
	}
	return {
		workspaceRoot: workspace.workspaceRoot,
		hostPath,
		containerPath:
			segments.length === 0
				? CONTAINER_WORKSPACE_ROOT
				: `${CONTAINER_WORKSPACE_ROOT}/${segments.join("/")}`,
		relativePath: segments.join("/"),
	};
}

function assertExistingPathComponentsRemainContained(
	workspaceRoot: string,
	segments: readonly string[],
	label: string,
): void {
	let current = workspaceRoot;
	for (const segment of segments) {
		current = resolve(current, segment);
		if (!existsSync(current)) return;
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error(`${label} must not traverse a symbolic link`);
		}
	}
}

function assertContained(root: string, candidate: string, label: string): void {
	const relativePath = relative(root, candidate);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error(`${label} escapes the workspace root`);
	}
}

/**
 * v0 capability globs are expressive enough for admission, but not every
 * glob can be translated to an OCI bind mount without widening authority.
 * Governed Podman accepts only a concrete directory prefix followed by `/**`.
 * Examples: `src/**`, `packages/kernel/**`. `**`, `src/*`, braces, character
 * classes, and exact-file patterns fail closed rather than producing a broad
 * workspace mount.
 */
function deriveCapabilityMountPlan(
	workspace: ResolvedWorkspacePath,
	bundle: GovernedActionExecutionContext["capabilityBundle"],
): CapabilityMountPlan {
	const readScopes = parseCapabilityMountScopes(
		workspace,
		bundle.fsRead,
		"fsRead",
	);
	const writeScopes = parseCapabilityMountScopes(
		workspace,
		bundle.fsWrite,
		"fsWrite",
	);
	const normalizedReadScopes = collapseNestedScopes(readScopes);
	const normalizedWriteScopes = collapseNestedScopes(writeScopes);

	// A writable scope is inherently readable. Do not layer a redundant nested
	// read snapshot inside it, because that would produce an ambiguous
	// capability-to-mount translation and could silently narrow an explicitly
	// approved write surface.
	const readOnlyMounts = normalizedReadScopes.filter(
		(readScope) =>
			!normalizedWriteScopes.some((writeScope) =>
				scopeContains(writeScope, readScope),
			),
	);
	const readSnapshotScopes = Object.freeze(readOnlyMounts.sort(compareMounts));
	if (readSnapshotScopes.length === 0 && normalizedWriteScopes.length === 0) {
		throw new Error(
			"governed capability bundle must declare at least one mountable fsRead or fsWrite scope",
		);
	}
	return Object.freeze({
		workspaceRoot: workspace.workspaceRoot,
		readScopes: Object.freeze(normalizedReadScopes),
		writeScopes: Object.freeze(normalizedWriteScopes),
		readSnapshotScopes,
	});
}

/**
 * Reviewer-class processes receive only explicit fsRead snapshots. Their
 * signed bundle can contain fsWrite for other workflow roles, but it cannot
 * become read authority, an overlay source, or a recovery/reconciliation
 * input for this action.
 */
function deriveReadOnlyCapabilityMountPlan(
	workspace: ResolvedWorkspacePath,
	bundle: GovernedActionExecutionContext["capabilityBundle"],
): CapabilityMountPlan {
	const readScopes = collapseNestedScopes(
		parseCapabilityMountScopes(workspace, bundle.fsRead, "fsRead"),
	);
	if (readScopes.length === 0) {
		throw new Error(
			"run_command requires at least one mountable fsRead scope; governed Podman will not infer workspace read authority",
		);
	}
	const sortedReadScopes = Object.freeze([...readScopes].sort(compareMounts));
	return Object.freeze({
		workspaceRoot: workspace.workspaceRoot,
		readScopes: sortedReadScopes,
		writeScopes: Object.freeze([]),
		readSnapshotScopes: sortedReadScopes,
	});
}

/**
 * Recovery must run before deriving mount roots: an interrupted source ->
 * backup rename intentionally leaves the declared fsWrite directory absent,
 * and the normal mount-plan validator correctly refuses absent roots. The
 * journal is still constrained to a currently declared concrete fsWrite path.
 */
function reconcilePendingOverlayPromotions(
	workspace: ResolvedWorkspacePath,
	bundle: GovernedActionExecutionContext["capabilityBundle"],
	maximumBytes: number,
): void {
	const patterns = bundle.fsWrite;
	if (patterns === undefined || patterns.length === 0) return;
	const overlayParent = resolveOverlayParent(workspace);
	for (const [index, pattern] of patterns.entries()) {
		const label = `fsWrite[${index}]`;
		const relativePath = parseMountableDirectoryGlob(pattern, label);
		assertNotReservedHostEvidenceScope(relativePath, label);
		const path = resolveWorkspacePath(workspace, relativePath, label, false);
		const writeScope: CapabilityMountRoot = Object.freeze({
			relativePath,
			hostPath: path.hostPath,
			containerPath: path.containerPath,
		});
		const controls = overlayControlPaths(overlayParent, writeScope.hostPath);
		if (lstatIfPresent(controls.journalPath) === undefined) continue;
		const lockPath = acquireOverlayLock(overlayParent, controls);
		try {
			reconcileInterruptedOverlayPromotion(
				workspace,
				writeScope,
				overlayParent,
				controls,
				maximumBytes,
			);
		} finally {
			releaseOverlayLock(lockPath);
		}
	}
}

function parseCapabilityMountScopes(
	workspace: ResolvedWorkspacePath,
	patterns: readonly string[] | undefined,
	field: "fsRead" | "fsWrite",
): CapabilityMountRoot[] {
	if (patterns === undefined || patterns.length === 0) return [];
	const scopes = patterns.map((pattern, index) => {
		const label = `${field}[${index}]`;
		const relativePath = parseMountableDirectoryGlob(pattern, label);
		assertNotReservedHostEvidenceScope(relativePath, label);
		return resolveCapabilityMountRoot(workspace, relativePath, label);
	});
	const seen = new Set<string>();
	for (const scope of scopes) {
		if (seen.has(scope.relativePath)) {
			throw new Error(
				`${field} contains duplicate mount scope "${scope.relativePath}/**"`,
			);
		}
		seen.add(scope.relativePath);
	}
	return scopes;
}

function parseMountableDirectoryGlob(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError(
			`${label} must be a non-empty mountable directory glob`,
		);
	}
	if (value.includes("\\") || !value.endsWith("/**")) {
		throw new Error(
			`${label} is not mountable; governed Podman accepts only concrete-dir/** scopes`,
		);
	}
	const relativePath = value.slice(0, -3);
	if (relativePath.length === 0 || relativePath === ".") {
		throw new Error(
			`${label} is too broad; mounting the workspace root is not permitted`,
		);
	}
	const segments = relativePath.split("/");
	if (
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				/[?*[\]{}!]/.test(segment) ||
				!/^[A-Za-z0-9._-]+$/.test(segment),
		)
	) {
		throw new Error(
			`${label} is ambiguous or unsupported; governed Podman requires concrete directory segments`,
		);
	}
	return segments.join("/");
}

function assertNotReservedHostEvidenceScope(
	relativePath: string,
	label: string,
): void {
	const [scopeRoot] = relativePath.split("/");
	if (
		scopeRoot !== undefined &&
		RESERVED_HOST_EVIDENCE_SCOPE_ROOTS.has(scopeRoot)
	) {
		throw new Error(
			`${label} targets a reserved host-owned Buildplane evidence path; governed OCI capabilities may not mount it.`,
		);
	}
}

function resolveCapabilityMountRoot(
	workspace: ResolvedWorkspacePath,
	relativePath: string,
	label: string,
): CapabilityMountRoot {
	const path = resolveWorkspacePath(workspace, relativePath, label, false);
	if (!existsSync(path.hostPath) || !lstatSync(path.hostPath).isDirectory()) {
		throw new Error(`${label} mount root must name an existing directory`);
	}
	if (lstatSync(path.hostPath).isSymbolicLink()) {
		throw new Error(`${label} mount root must not be a symbolic link`);
	}
	if (
		/[,\r\n]/.test(path.hostPath) ||
		(detectPlatform() === "linux" && path.hostPath.includes(":"))
	) {
		throw new Error(
			`${label} mount root contains a Podman volume delimiter and cannot be safely mounted`,
		);
	}
	return Object.freeze({
		relativePath: path.relativePath,
		hostPath: path.hostPath,
		containerPath: path.containerPath,
	});
}

function collapseNestedScopes(
	scopes: readonly CapabilityMountRoot[],
): CapabilityMountRoot[] {
	return [...scopes]
		.sort((left, right) => {
			const depthDifference = scopeDepth(left) - scopeDepth(right);
			return depthDifference === 0
				? left.relativePath.localeCompare(right.relativePath)
				: depthDifference;
		})
		.filter(
			(scope, index, sorted) =>
				!sorted.slice(0, index).some((parent) => scopeContains(parent, scope)),
		);
}

function compareMounts(
	left: CapabilityMountRoot,
	right: CapabilityMountRoot,
): number {
	const depthDifference = scopeDepth(left) - scopeDepth(right);
	if (depthDifference !== 0) return depthDifference;
	return left.relativePath.localeCompare(right.relativePath);
}

function scopeDepth(scope: { readonly relativePath: string }): number {
	return scope.relativePath.split("/").length;
}

function scopeContains(
	ancestor: { readonly relativePath: string },
	descendant: { readonly relativePath: string },
): boolean {
	return (
		ancestor.relativePath === descendant.relativePath ||
		descendant.relativePath.startsWith(`${ancestor.relativePath}/`)
	);
}

function assertPathHasReadScope(
	path: ResolvedWorkspacePath,
	plan: CapabilityMountPlan,
	label: string,
): void {
	if (plan.readScopes.length === 0) {
		throw new Error(
			"run_command requires at least one mountable fsRead scope; governed Podman will not infer workspace read authority",
		);
	}
	if (!plan.readScopes.some((scope) => scopeContains(scope, path))) {
		throw new Error(`${label} is outside the declared fsRead mount scopes`);
	}
}

function assertPathHasWriteScope(
	path: ResolvedWorkspacePath,
	plan: CapabilityMountPlan,
): CapabilityMountRoot {
	const candidates = plan.writeScopes.filter((scope) =>
		scopeContains(scope, path),
	);
	if (candidates.length === 0) {
		throw new Error(
			"write_file path is outside the declared fsWrite mount scopes",
		);
	}
	// Nested write scopes have been collapsed, so this is always a single most
	// specific mount. Keep the guard as an invariant if the normalization logic
	// changes in a later schema revision.
	if (candidates.length > 1) {
		throw new Error(
			"write_file path resolves to ambiguous fsWrite mount scopes",
		);
	}
	return candidates[0];
}

/**
 * Execute one effect against private per-action directories rather than any
 * candidate-worktree bind mount. Declared fsRead scopes are copied into
 * read-only snapshots; declared fsWrite is copied into a private sibling
 * directory, mounted rw for this one OCI action, then swapped back only after
 * a successful result and a source-fingerprint recheck.
 *
 * This is deliberately stricter than a generic overlayfs implementation:
 * V1 accepts one concrete write scope only. An atomic directory replacement
 * gives that scope all-or-nothing host reconciliation. Multiple independently
 * writable scopes would require a multi-directory transaction, so they fail
 * closed instead of receiving a best-effort sequence of host writes.
 */
function runPodman(
	options: NormalizedOptions,
	runner: PodmanCommandRunner,
	context: GovernedActionExecutionContext,
	workspace: ResolvedWorkspacePath,
	mountPlan: CapabilityMountPlan,
	containerCwd: string,
	command: readonly string[],
	input?: string,
	afterOverlayPromotion?: () => void,
): PodmanCommandResult {
	let readSnapshots: ActionReadSnapshots | undefined;
	let overlay: ActionOverlay | undefined;
	let actionResult: PodmanCommandResult | undefined;
	let actionFailure: unknown;
	let actionFailed = false;
	// Reject an already exhausted signed dispatch before allocating a snapshot,
	// staging overlay, or constructing any Podman action argv.
	remainingGovernedComputeTimeMs(context);
	// Set immediately before the only runner invocation. From that point onward
	// a container may have changed its overlay, so an error cannot be encoded as
	// a retry-safe deterministic command/write failure.
	let actionMayHaveRun = false;
	try {
		readSnapshots = createActionReadSnapshots(
			workspace,
			mountPlan,
			options.profile.tmpfsBytes,
		);
		if (hasMutableRole(context)) {
			overlay = createActionOverlay(
				workspace,
				mountPlan,
				options.profile.tmpfsBytes,
				afterOverlayPromotion,
			);
		}
		const args = [
			"run",
			"--rm",
			"--pull=never",
			"--read-only",
			"--network=none",
			// Podman otherwise forwards proxy environment variables by default.
			// Governed actions must never inherit an ambient proxy configuration,
			// even when a future runner changes its own process environment.
			"--http-proxy=false",
			// Do not synthesize container /etc/hosts or /etc/hostname from host
			// topology. `--network=none` limits connectivity, but it does not by
			// itself prevent disclosure of host aliases to the worker.
			"--no-hosts",
			"--no-hostname",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--userns=keep-id",
			"--entrypoint=",
			`--cpus=${options.profile.cpuCores}`,
			`--memory=${options.profile.memoryBytes}b`,
			`--pids-limit=${options.profile.pidsLimit}`,
			`--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${options.profile.tmpfsBytes}`,
			"--env=HOME=/tmp",
			"--env=TMPDIR=/tmp",
			"--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"--env=LANG=C.UTF-8",
			"--env=LC_ALL=C.UTF-8",
			...containerMounts(readSnapshots, overlay).map(
				(mount) =>
					`--volume=${mount.hostPath}:${mount.containerPath}:${mount.mode},rprivate`,
			),
			`--workdir=${containerCwd}`,
			options.image,
			...command,
		];
		// Snapshot/overlay preparation consumes the same single immutable dispatch
		// budget. Re-check immediately before the only control-plane invocation so
		// a slow preparation step cannot launch a container after expiry.
		const timeoutMs = remainingGovernedComputeTimeMs(context);
		actionMayHaveRun = true;
		const result = runDeterminatePodmanAction(runner, args, input, timeoutMs);
		if (result.status === 0 && result.error === undefined) {
			overlay?.promote();
		}
		actionResult = result;
	} catch (error) {
		actionFailed = true;
		actionFailure = error;
	}

	try {
		disposeActionResources(overlay, readSnapshots);
	} catch (error) {
		if (actionMayHaveRun) {
			throw new AmbiguousPodmanControlPlaneOutcomeError(errorMessage(error));
		}
		throw error;
	}

	if (actionFailed) {
		if (actionFailure instanceof AmbiguousPodmanControlPlaneOutcomeError) {
			throw actionFailure;
		}
		if (actionMayHaveRun) {
			throw new AmbiguousPodmanControlPlaneOutcomeError(
				errorMessage(actionFailure),
			);
		}
		return {
			status: null,
			stdout: "",
			stderr: "",
			error: errorMessage(actionFailure),
		};
	}
	if (actionResult === undefined) {
		throw new Error("Governed Podman action completed without a result.");
	}
	return actionResult;
}

/**
 * A real nonzero container exit is a deterministic action failure. In
 * contrast, an absent exit status, a runner-reported error, malformed runner
 * output, or a thrown runner error leaves the container's disposition unknown:
 * it may have started and modified its private overlay before the control plane
 * failed. Do not compress that distinction into a normal failed result.
 */
function runDeterminatePodmanAction(
	runner: PodmanCommandRunner,
	args: readonly string[],
	input: string | undefined,
	timeoutMs: number,
): PodmanCommandResult {
	let result: PodmanCommandResult;
	try {
		result = normalizeRunnerResult(
			runner("podman", Object.freeze([...args]), {
				...(input === undefined ? {} : { input }),
				timeoutMs,
			}),
		);
	} catch (error) {
		throw new AmbiguousPodmanControlPlaneOutcomeError(errorMessage(error));
	}
	if (result.status === null) {
		throw new AmbiguousPodmanControlPlaneOutcomeError(
			result.error ?? "Podman did not report a terminal exit status",
		);
	}
	if (result.error !== undefined) {
		throw new AmbiguousPodmanControlPlaneOutcomeError(result.error);
	}
	return result;
}

/**
 * The deadline is a signed absolute point in time rather than a fresh action
 * allowance. The fixed Podman cap remains a stricter operational limit, but
 * it can never extend the remaining dispatch compute budget.
 */
function remainingGovernedComputeTimeMs(
	context: GovernedActionExecutionContext,
): number {
	if (
		!Number.isSafeInteger(context.deadlineAtMs) ||
		context.deadlineAtMs <= 0 ||
		typeof context.nowMs !== "function"
	) {
		throw new Error(
			"Governed Podman execution requires a valid gateway-minted compute deadline.",
		);
	}
	let nowMs: unknown;
	try {
		nowMs = context.nowMs();
	} catch {
		throw new Error(
			"Governed Podman execution clock failed before an OCI action could be authorized.",
		);
	}
	if (!Number.isSafeInteger(nowMs)) {
		throw new Error(
			"Governed Podman execution clock returned an invalid epoch-millisecond timestamp.",
		);
	}
	const currentTimeMs = nowMs as number;
	if (currentTimeMs < 0) {
		throw new Error(
			"Governed Podman execution clock returned an invalid epoch-millisecond timestamp.",
		);
	}
	const remaining = context.deadlineAtMs - currentTimeMs;
	if (!Number.isSafeInteger(remaining) || remaining <= 0) {
		throw new Error(
			"Governed Podman dispatch compute deadline is exhausted; no OCI action was invoked.",
		);
	}
	return Math.min(remaining, PODMAN_TIMEOUT_MS);
}

function containerMounts(
	readSnapshots: ActionReadSnapshots | undefined,
	overlay: ActionOverlay | undefined,
): readonly ContainerMount[] {
	const mounts: ContainerMount[] = [...(readSnapshots?.mounts ?? [])];
	if (overlay !== undefined) {
		mounts.push({
			hostPath: overlay.stagingPath,
			containerPath: overlay.writeScope.containerPath,
			mode: "rw",
		});
	}
	return Object.freeze(
		mounts.sort((left, right) => {
			const depthDifference = mountDepth(left) - mountDepth(right);
			if (depthDifference !== 0) return depthDifference;
			if (left.containerPath !== right.containerPath) {
				return left.containerPath.localeCompare(right.containerPath);
			}
			return left.mode.localeCompare(right.mode);
		}),
	);
}

function disposeActionResources(
	overlay: ActionOverlay | undefined,
	readSnapshots: ActionReadSnapshots | undefined,
): void {
	const errors: string[] = [];
	try {
		overlay?.dispose();
	} catch (error) {
		errors.push(errorMessage(error));
	}
	try {
		readSnapshots?.dispose();
	} catch (error) {
		errors.push(errorMessage(error));
	}
	if (errors.length > 0) {
		throw new Error(
			`governed OCI action resource cleanup failed: ${errors.join("; ")}`,
		);
	}
}

function mountDepth(mount: { readonly containerPath: string }): number {
	return mount.containerPath.split("/").filter(Boolean).length;
}

/**
 * Materialize fsRead roots into owned directories outside the candidate
 * worktree. Podman receives only those copies, never a mutable capability
 * pathname from the candidate tree. Node's pathname APIs cannot provide a
 * fully race-free openat-style traversal, so this validates identity and a
 * complete fingerprint both before and after copying and fails closed on an
 * observed mutation or symlink.
 */
function createActionReadSnapshots(
	workspace: ResolvedWorkspacePath,
	plan: CapabilityMountPlan,
	maximumBytes: number,
): ActionReadSnapshots | undefined {
	if (plan.readSnapshotScopes.length === 0) return undefined;
	if (plan.workspaceRoot !== workspace.workspaceRoot) {
		throw new Error(
			"governed OCI mount plan is bound to a different workspace",
		);
	}
	const snapshotParent = resolveOverlayParent(workspace);
	const snapshotPaths: string[] = [];
	const mounts: ContainerMount[] = [];
	try {
		for (const readScope of plan.readSnapshotScopes) {
			const snapshotPath = mkdtempSync(
				join(snapshotParent, ".buildplane-oci-read-snapshot-"),
			);
			snapshotPaths.push(snapshotPath);
			assertOwnedOverlayPath(
				snapshotParent,
				snapshotPath,
				".buildplane-oci-read-snapshot-",
				"governed OCI read snapshot directory",
			);
			assertPodmanMountPathSafe(
				snapshotPath,
				"governed OCI read snapshot directory",
			);

			const sourceLabel = `declared fsRead source ${readScope.relativePath}`;
			const snapshotLabel = `governed OCI read snapshot ${readScope.relativePath}`;
			const sourceIdentity = captureSafeDirectoryIdentity(
				readScope.hostPath,
				sourceLabel,
			);
			const sourceFingerprint = fingerprintDirectory(
				readScope.hostPath,
				sourceLabel,
				maximumBytes,
			);
			assertSafeDirectoryIdentity(
				readScope.hostPath,
				sourceIdentity,
				sourceLabel,
			);
			copyDirectoryContents(
				readScope.hostPath,
				snapshotPath,
				sourceLabel,
				maximumBytes,
				"preserve",
			);
			assertSafeDirectoryIdentity(
				readScope.hostPath,
				sourceIdentity,
				sourceLabel,
			);

			const snapshotIdentity = captureSafeDirectoryIdentity(
				snapshotPath,
				snapshotLabel,
			);
			const snapshotFingerprint = fingerprintDirectory(
				snapshotPath,
				snapshotLabel,
				maximumBytes,
			);
			assertSafeDirectoryIdentity(
				snapshotPath,
				snapshotIdentity,
				snapshotLabel,
			);
			if (snapshotFingerprint !== sourceFingerprint) {
				throw new Error(
					`${sourceLabel} changed while the governed OCI read snapshot was being prepared.`,
				);
			}
			if (
				fingerprintDirectory(readScope.hostPath, sourceLabel, maximumBytes) !==
				sourceFingerprint
			) {
				throw new Error(
					`${sourceLabel} changed while the governed OCI read snapshot was being prepared.`,
				);
			}
			assertSafeDirectoryIdentity(
				readScope.hostPath,
				sourceIdentity,
				sourceLabel,
			);
			mounts.push({
				hostPath: snapshotPath,
				containerPath: readScope.containerPath,
				mode: "ro",
			});
		}
	} catch (error) {
		try {
			removeActionReadSnapshots(snapshotParent, snapshotPaths);
		} catch (cleanupError) {
			throw new Error(
				`${errorMessage(error)} Read snapshot cleanup also failed: ${errorMessage(cleanupError)}`,
			);
		}
		throw error;
	}

	let disposed = false;
	return Object.freeze({
		mounts: Object.freeze(mounts),
		dispose() {
			if (disposed) return;
			disposed = true;
			removeActionReadSnapshots(snapshotParent, snapshotPaths);
		},
	});
}

function removeActionReadSnapshots(
	snapshotParent: string,
	snapshotPaths: readonly string[],
): void {
	const errors: string[] = [];
	for (const snapshotPath of [...snapshotPaths].reverse()) {
		try {
			removeOwnedTree(
				snapshotParent,
				snapshotPath,
				".buildplane-oci-read-snapshot-",
				"governed OCI read snapshot directory",
			);
		} catch (error) {
			errors.push(errorMessage(error));
		}
	}
	if (errors.length > 0) {
		throw new Error(
			`governed OCI read snapshot cleanup failed: ${errors.join("; ")}`,
		);
	}
}

interface SafeDirectoryIdentity {
	readonly device: number;
	readonly inode: number;
}

function captureSafeDirectoryIdentity(
	path: string,
	label: string,
): SafeDirectoryIdentity {
	const stats = requireSafeDirectory(path, label);
	return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function assertSafeDirectoryIdentity(
	path: string,
	expected: SafeDirectoryIdentity,
	label: string,
): void {
	const actual = captureSafeDirectoryIdentity(path, label);
	if (actual.device !== expected.device || actual.inode !== expected.inode) {
		throw new Error(
			`${label} changed while the governed OCI read snapshot was being prepared.`,
		);
	}
}

/**
 * Create the one narrow writable surface used by an OCI action. The staging
 * root intentionally lives outside the candidate worktree so it cannot become
 * visible through an ancestor read-only source mount. It must share a device
 * with the declared write root: otherwise promotion cannot be an atomic rename
 * and governed execution is blocked.
 */
function createActionOverlay(
	workspace: ResolvedWorkspacePath,
	plan: CapabilityMountPlan,
	maximumBytes: number,
	afterOverlayPromotion?: () => void,
): ActionOverlay | undefined {
	if (plan.writeScopes.length === 0) return undefined;
	if (plan.writeScopes.length !== 1) {
		throw new Error(
			"governed Podman V1 supports exactly one fsWrite scope per action; multiple writable scopes cannot be atomically reconciled.",
		);
	}
	const writeScope = plan.writeScopes[0];
	if (plan.workspaceRoot !== workspace.workspaceRoot) {
		throw new Error(
			"governed OCI mount plan is bound to a different workspace",
		);
	}
	const overlayParent = resolveOverlayParent(workspace);
	const scopeStats = requireSafeDirectory(
		writeScope.hostPath,
		"declared fsWrite source",
	);
	const parentStats = statSync(overlayParent);
	if (scopeStats.dev !== parentStats.dev) {
		throw new Error(
			"governed OCI writable overlay requires the staging and declared fsWrite roots to share a filesystem; cross-device promotion is blocked.",
		);
	}
	const controls = overlayControlPaths(overlayParent, writeScope.hostPath);
	const lockPath = acquireOverlayLock(overlayParent, controls);
	let stagingPath: string | undefined;
	let promoted = false;
	let disposed = false;
	try {
		reconcileInterruptedOverlayPromotion(
			workspace,
			writeScope,
			overlayParent,
			controls,
			maximumBytes,
		);
		const capturedStagingPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-overlay-"),
		);
		stagingPath = capturedStagingPath;
		assertOwnedOverlayPath(
			overlayParent,
			capturedStagingPath,
			".buildplane-oci-overlay-",
			"governed OCI staging directory",
		);
		assertPodmanMountPathSafe(
			capturedStagingPath,
			"governed OCI staging directory",
		);
		const sourceFingerprint = fingerprintDirectory(
			writeScope.hostPath,
			"declared fsWrite source",
			maximumBytes,
		);
		copyDirectoryContents(
			writeScope.hostPath,
			capturedStagingPath,
			"declared fsWrite source",
			maximumBytes,
		);
		if (
			fingerprintDirectory(
				writeScope.hostPath,
				"declared fsWrite source",
				maximumBytes,
			) !== sourceFingerprint
		) {
			throw new Error(
				"declared fsWrite source changed while the governed OCI overlay was being prepared.",
			);
		}

		return Object.freeze({
			writeScope,
			stagingPath: capturedStagingPath,
			sourceFingerprint,
			promote() {
				if (disposed) {
					throw new Error("governed OCI overlay has already been disposed");
				}
				if (promoted) {
					throw new Error("governed OCI overlay may be promoted only once");
				}
				if (
					fingerprintDirectory(
						writeScope.hostPath,
						"declared fsWrite source",
						maximumBytes,
					) !== sourceFingerprint
				) {
					throw new Error(
						"declared fsWrite source changed during a governed OCI action; staged changes were not promoted.",
					);
				}
				// Do this before any source rename. A worker-created symlink or
				// special file is never reconciled to the host candidate tree.
				assertSafeDirectoryTree(
					capturedStagingPath,
					"governed OCI staged output",
					maximumBytes,
				);
				atomicReplaceWriteScope(
					workspace,
					writeScope,
					capturedStagingPath,
					overlayParent,
					controls,
					sourceFingerprint,
					maximumBytes,
					afterOverlayPromotion,
				);
				promoted = true;
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				try {
					if (!promoted) {
						removeOwnedTree(
							overlayParent,
							capturedStagingPath,
							".buildplane-oci-overlay-",
							"governed OCI staging directory",
						);
					}
				} finally {
					releaseOverlayLock(lockPath);
				}
			},
		});
	} catch (error) {
		if (stagingPath !== undefined) {
			try {
				removeOwnedTree(
					overlayParent,
					stagingPath,
					".buildplane-oci-overlay-",
					"governed OCI staging directory",
				);
			} catch {
				// The primary construction failure is the useful error. The private
				// staging directory remains unreachable from the candidate worktree.
			}
		}
		releaseOverlayLock(lockPath);
		throw error;
	}
}

function resolveOverlayParent(workspace: ResolvedWorkspacePath): string {
	const parent = dirname(workspace.workspaceRoot);
	if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
		throw new Error(
			"governed OCI overlay parent must be an existing non-symbolic-link directory",
		);
	}
	if (lstatSync(parent).isSymbolicLink()) {
		throw new Error("governed OCI overlay parent must not be a symbolic link");
	}
	const canonicalParent = realpathSync(parent);
	assertContained(
		canonicalParent,
		workspace.workspaceRoot,
		"governed worktree",
	);
	return canonicalParent;
}

function overlayControlPaths(
	overlayParent: string,
	sourcePath: string,
): OverlayControlPaths {
	const sourceToken = createHash("sha256")
		.update(sourcePath, "utf8")
		.digest("hex");
	return Object.freeze({
		lockPath: join(
			overlayParent,
			`.buildplane-oci-overlay-${sourceToken}.lock`,
		),
		journalPath: join(
			overlayParent,
			`.buildplane-oci-overlay-${sourceToken}.journal`,
		),
	});
}

function acquireOverlayLock(
	overlayParent: string,
	controls: OverlayControlPaths,
): string {
	assertOwnedOverlayControlPath(
		overlayParent,
		controls.lockPath,
		".lock",
		"governed OCI overlay lock",
	);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeDurableOverlayControlFile(
				controls.lockPath,
				JSON.stringify({ schemaVersion: 1, pid: process.pid }),
				"governed OCI overlay lock",
			);
			return controls.lockPath;
		} catch (error) {
			if (!isExistingPathError(error) || attempt !== 0) {
				throw new Error(
					`governed OCI overlay lock could not be acquired: ${errorMessage(error)}`,
				);
			}
			if (!reclaimStaleOverlayLock(overlayParent, controls.lockPath)) {
				throw new Error(
					"governed OCI overlay is already active or requires operator recovery; concurrent access to the same fsWrite scope is blocked.",
				);
			}
		}
	}
	throw new Error(
		"governed OCI overlay lock acquisition exhausted unexpectedly",
	);
}

function reclaimStaleOverlayLock(
	overlayParent: string,
	lockPath: string,
): boolean {
	const record = readOverlayLockRecord(overlayParent, lockPath);
	if (isProcessAlive(record.pid)) return false;
	removeOwnedOverlayControlFile(
		overlayParent,
		lockPath,
		".lock",
		"governed OCI overlay lock",
	);
	return true;
}

function releaseOverlayLock(lockPath: string): void {
	const parent = dirname(lockPath);
	removeOwnedOverlayControlFile(
		parent,
		lockPath,
		".lock",
		"governed OCI overlay lock",
	);
}

function reconcileInterruptedOverlayPromotion(
	workspace: ResolvedWorkspacePath,
	writeScope: CapabilityMountRoot,
	overlayParent: string,
	controls: OverlayControlPaths,
	maximumBytes: number,
): void {
	const journal = readOverlayRecoveryJournal(
		overlayParent,
		controls.journalPath,
	);
	if (journal === undefined) return;
	if (journal.sourcePath !== writeScope.hostPath) {
		throw new Error(
			"governed OCI recovery journal is bound to a different fsWrite source; promotion is blocked.",
		);
	}
	assertOwnedOverlayPath(
		overlayParent,
		journal.stagingPath,
		".buildplane-oci-overlay-",
		"governed OCI recovery staging directory",
	);
	assertOwnedOverlayPath(
		overlayParent,
		journal.backupPath,
		".buildplane-oci-backup-",
		"governed OCI recovery backup directory",
	);
	if (journal.stagingPath === journal.backupPath) {
		throw new Error(
			"governed OCI recovery journal aliases staging and backup paths; promotion is blocked.",
		);
	}

	const sourcePath = writeScope.hostPath;
	const sourceParent = dirname(sourcePath);
	assertRecoverySourceParent(workspace, sourceParent);
	const sourceFingerprint = fingerprintRecoveryDirectoryIfPresent(
		sourcePath,
		"governed OCI recovery source directory",
		maximumBytes,
	);
	const stagingFingerprint = fingerprintRecoveryDirectoryIfPresent(
		journal.stagingPath,
		"governed OCI recovery staging directory",
		maximumBytes,
	);
	const backupFingerprint = fingerprintRecoveryDirectoryIfPresent(
		journal.backupPath,
		"governed OCI recovery backup directory",
		maximumBytes,
	);

	if (
		backupFingerprint !== undefined &&
		backupFingerprint !== journal.sourceFingerprint
	) {
		throw new Error(
			"governed OCI recovery backup no longer matches the journaled source tree; promotion is blocked.",
		);
	}
	if (sourceFingerprint === undefined && backupFingerprint !== undefined) {
		// The process stopped after source -> backup (or before it could record a
		// later phase). Restore the pre-action source; an unrecorded action must
		// never be inferred as an approved candidate promotion.
		renameSync(journal.backupPath, sourcePath);
		fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		if (
			stagingFingerprint !== undefined &&
			stagingFingerprint !== journal.stagingFingerprint
		) {
			throw new Error(
				"governed OCI recovery staging no longer matches the journaled candidate tree; the original source was restored and promotion is blocked.",
			);
		}
		if (stagingFingerprint !== undefined) {
			removeOwnedTree(
				overlayParent,
				journal.stagingPath,
				".buildplane-oci-overlay-",
				"governed OCI recovery staging directory",
			);
			fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		}
		removeOverlayRecoveryJournal(overlayParent, controls.journalPath);
		return;
	}

	if (
		stagingFingerprint !== undefined &&
		stagingFingerprint !== journal.stagingFingerprint
	) {
		throw new Error(
			"governed OCI recovery staging no longer matches the journaled candidate tree; promotion is blocked.",
		);
	}

	if (
		sourceFingerprint === journal.stagingFingerprint &&
		backupFingerprint === journal.sourceFingerprint &&
		stagingFingerprint === undefined
	) {
		// The second rename completed before the process stopped. The candidate
		// tree is provably the journaled staged tree, so only private cleanup
		// remains.
		removeOwnedTree(
			overlayParent,
			journal.backupPath,
			".buildplane-oci-backup-",
			"governed OCI recovery backup directory",
		);
		fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		removeOverlayRecoveryJournal(overlayParent, controls.journalPath);
		return;
	}

	if (
		sourceFingerprint === journal.sourceFingerprint &&
		backupFingerprint === undefined
	) {
		// No source replacement survived. This covers both a crash before the
		// first rename and a crash while restoring the original tree. Discard the
		// private candidate overlay before removing its write-ahead record.
		if (stagingFingerprint !== undefined) {
			removeOwnedTree(
				overlayParent,
				journal.stagingPath,
				".buildplane-oci-overlay-",
				"governed OCI recovery staging directory",
			);
			fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		}
		removeOverlayRecoveryJournal(overlayParent, controls.journalPath);
		return;
	}

	if (
		sourceFingerprint === journal.stagingFingerprint &&
		backupFingerprint === undefined &&
		stagingFingerprint === undefined
	) {
		// Backup cleanup completed but the journal removal did not. The promoted
		// source still matches the journaled candidate exactly.
		removeOverlayRecoveryJournal(overlayParent, controls.journalPath);
		return;
	}

	throw new Error(
		"governed OCI recovery journal describes an ambiguous overlay state; promotion is blocked pending operator recovery.",
	);
}

function assertRecoverySourceParent(
	workspace: ResolvedWorkspacePath,
	sourceParent: string,
): void {
	if (!existsSync(sourceParent) || !lstatSync(sourceParent).isDirectory()) {
		throw new Error(
			"declared fsWrite source parent disappeared during governed OCI recovery.",
		);
	}
	if (lstatSync(sourceParent).isSymbolicLink()) {
		throw new Error(
			"declared fsWrite source parent became a symbolic link during governed OCI recovery.",
		);
	}
	assertContained(
		workspace.workspaceRoot,
		sourceParent,
		"declared fsWrite source parent",
	);
}

function fingerprintRecoveryDirectoryIfPresent(
	path: string,
	label: string,
	maximumBytes: number,
): string | undefined {
	if (lstatIfPresent(path) === undefined) return undefined;
	return fingerprintDirectory(path, label, maximumBytes);
}

function writeOverlayRecoveryJournal(
	overlayParent: string,
	journalPath: string,
	journal: OverlayRecoveryJournal,
): void {
	assertOwnedOverlayControlPath(
		overlayParent,
		journalPath,
		".journal",
		"governed OCI recovery journal",
	);
	writeDurableOverlayControlFile(
		journalPath,
		JSON.stringify(journal),
		"governed OCI recovery journal",
	);
}

function readOverlayRecoveryJournal(
	overlayParent: string,
	journalPath: string,
): OverlayRecoveryJournal | undefined {
	const record = readOverlayControlRecordIfPresent(
		overlayParent,
		journalPath,
		".journal",
		"governed OCI recovery journal",
		OVERLAY_RECOVERY_JOURNAL_FIELDS,
	);
	if (record === undefined) return undefined;
	if (record.schemaVersion !== 1) {
		throw new Error("governed OCI recovery journal has an unsupported schema.");
	}
	const sourcePath = readRequiredString(
		record,
		"sourcePath",
		"governed OCI recovery journal",
	);
	const sourceFingerprint = readOverlayRecoveryDigest(
		record,
		"sourceFingerprint",
	);
	const stagingPath = readRequiredString(
		record,
		"stagingPath",
		"governed OCI recovery journal",
	);
	const stagingFingerprint = readOverlayRecoveryDigest(
		record,
		"stagingFingerprint",
	);
	const backupPath = readRequiredString(
		record,
		"backupPath",
		"governed OCI recovery journal",
	);
	return Object.freeze({
		schemaVersion: 1,
		sourcePath,
		sourceFingerprint,
		stagingPath,
		stagingFingerprint,
		backupPath,
	});
}

function removeOverlayRecoveryJournal(
	overlayParent: string,
	journalPath: string,
): void {
	removeOwnedOverlayControlFile(
		overlayParent,
		journalPath,
		".journal",
		"governed OCI recovery journal",
	);
}

function readOverlayLockRecord(
	overlayParent: string,
	lockPath: string,
): OverlayLockRecord {
	const record = readOverlayControlRecordIfPresent(
		overlayParent,
		lockPath,
		".lock",
		"governed OCI overlay lock",
		OVERLAY_LOCK_FIELDS,
	);
	if (record === undefined || record.schemaVersion !== 1) {
		throw new Error("governed OCI overlay lock is missing or malformed.");
	}
	if (
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0
	) {
		throw new Error("governed OCI overlay lock has an invalid owner pid.");
	}
	return Object.freeze({ schemaVersion: 1, pid: record.pid });
}

function readOverlayControlRecordIfPresent(
	overlayParent: string,
	path: string,
	suffix: ".journal" | ".lock",
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> | undefined {
	assertOwnedOverlayControlPath(overlayParent, path, suffix, label);
	const stats = lstatIfPresent(path);
	if (stats === undefined) return undefined;
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`${label} must be a regular non-symbolic-link file.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
	}
	return readClosedRecord(parsed, label, allowedFields);
}

function readOverlayRecoveryDigest(
	record: Record<string, unknown>,
	field: "sourceFingerprint" | "stagingFingerprint",
): string {
	const value = record[field];
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new Error(`governed OCI recovery journal ${field} is invalid.`);
	}
	return value;
}

function writeDurableOverlayControlFile(
	path: string,
	contents: string,
	label: string,
): void {
	let descriptor: number | undefined;
	let created = false;
	try {
		descriptor = openSync(path, "wx", 0o600);
		created = true;
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		fsyncOverlayDirectory(dirname(path), label);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The original durable-write failure is the useful diagnostic.
			}
		}
		if (created) {
			try {
				unlinkSync(path);
				fsyncOverlayDirectory(dirname(path), label);
			} catch {
				// If cleanup cannot be made durable, the malformed record remains and
				// blocks future governed actions rather than widening authority.
			}
		}
		throw error;
	}
}

function removeOwnedOverlayControlFile(
	overlayParent: string,
	path: string,
	suffix: ".journal" | ".lock",
	label: string,
): void {
	assertOwnedOverlayControlPath(overlayParent, path, suffix, label);
	const stats = lstatIfPresent(path);
	if (stats === undefined) return;
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`${label} must be a regular non-symbolic-link file.`);
	}
	unlinkSync(path);
	fsyncOverlayDirectory(overlayParent, label);
}

function assertOwnedOverlayControlPath(
	overlayParent: string,
	path: string,
	suffix: ".journal" | ".lock",
	label: string,
): void {
	assertContained(overlayParent, path, label);
	const name = basename(path);
	if (
		dirname(path) !== overlayParent ||
		!name.startsWith(".buildplane-oci-overlay-") ||
		!name.endsWith(suffix)
	) {
		throw new Error(`${label} is not an owned governed OCI control path.`);
	}
}

function fsyncOverlayPromotionDirectories(
	overlayParent: string,
	sourceParent: string,
): void {
	fsyncOverlayDirectory(overlayParent, "governed OCI overlay parent");
	if (sourceParent !== overlayParent) {
		fsyncOverlayDirectory(sourceParent, "governed OCI source parent");
	}
}

function fsyncOverlayDirectory(path: string, label: string): void {
	// Governed production is Linux-only. The explicit test constructor runs on
	// non-Linux hosts, where opening a directory for fsync is not portable.
	if (detectPlatform() !== "linux") return;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		throw new Error(
			`${label} could not be durably synced: ${errorMessage(error)}`,
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { readonly code?: unknown }).code === "ESRCH"
		) {
			return false;
		}
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { readonly code?: unknown }).code === "EPERM"
		) {
			return true;
		}
		throw new Error(
			`governed OCI overlay lock owner could not be checked: ${errorMessage(error)}`,
		);
	}
}

function atomicReplaceWriteScope(
	workspace: ResolvedWorkspacePath,
	writeScope: CapabilityMountRoot,
	stagingPath: string,
	overlayParent: string,
	controls: OverlayControlPaths,
	sourceFingerprint: string,
	maximumBytes: number,
	afterOverlayPromotion?: () => void,
): void {
	assertOwnedOverlayPath(
		overlayParent,
		stagingPath,
		".buildplane-oci-overlay-",
		"governed OCI staged output",
	);
	requireSafeDirectory(stagingPath, "governed OCI staged output");
	const sourcePath = writeScope.hostPath;
	const sourceParent = dirname(sourcePath);
	if (!existsSync(sourceParent) || !lstatSync(sourceParent).isDirectory()) {
		throw new Error(
			"declared fsWrite source parent disappeared before governed OCI promotion.",
		);
	}
	if (lstatSync(sourceParent).isSymbolicLink()) {
		throw new Error(
			"declared fsWrite source parent became a symbolic link before governed OCI promotion.",
		);
	}
	assertContained(
		workspace.workspaceRoot,
		sourceParent,
		"declared fsWrite source parent",
	);
	if (!existsSync(sourcePath) || !lstatSync(sourcePath).isDirectory()) {
		throw new Error(
			"declared fsWrite source must remain an existing non-symbolic-link directory before governed OCI promotion.",
		);
	}
	if (lstatSync(sourcePath).isSymbolicLink()) {
		throw new Error(
			"declared fsWrite source became a symbolic link before governed OCI promotion.",
		);
	}
	if (statSync(sourcePath).dev !== statSync(stagingPath).dev) {
		throw new Error(
			"governed OCI staged output moved across filesystems; atomic promotion is blocked.",
		);
	}

	const backupPath = join(
		overlayParent,
		`.buildplane-oci-backup-${randomUUID()}`,
	);
	assertOwnedOverlayPath(
		overlayParent,
		backupPath,
		".buildplane-oci-backup-",
		"governed OCI backup directory",
	);
	if (existsSync(backupPath)) {
		throw new Error(
			"governed OCI backup path unexpectedly exists; atomic promotion is blocked.",
		);
	}

	const stagingFingerprint = fingerprintDirectory(
		stagingPath,
		"governed OCI staged output",
		maximumBytes,
	);
	writeOverlayRecoveryJournal(overlayParent, controls.journalPath, {
		schemaVersion: 1,
		sourcePath,
		sourceFingerprint,
		stagingPath,
		stagingFingerprint,
		backupPath,
	});

	try {
		renameSync(sourcePath, backupPath);
		fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		// The pre-promotion fingerprint prevents a normal concurrent source
		// edit from being overwritten. Recheck after the source has been moved
		// aside as well: that closes the otherwise unavoidable window between
		// the last check and `renameSync`, and lets the catch path restore the
		// exact source rather than promoting over a late host mutation.
		if (
			fingerprintDirectory(
				backupPath,
				"declared fsWrite source backup",
				maximumBytes,
			) !== sourceFingerprint
		) {
			throw new Error(
				"declared fsWrite source changed immediately before governed OCI promotion; staged changes were not promoted.",
			);
		}
		renameSync(stagingPath, sourcePath);
		fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
	} catch (error) {
		let recoveryDetail = "";
		try {
			reconcileInterruptedOverlayPromotion(
				workspace,
				writeScope,
				overlayParent,
				controls,
				maximumBytes,
			);
		} catch (recoveryError) {
			recoveryDetail = ` Recovery also failed: ${errorMessage(recoveryError)}`;
		}
		throw new Error(
			`governed OCI atomic promotion failed: ${errorMessage(error)}.${recoveryDetail}`,
		);
	}

	try {
		afterOverlayPromotion?.();
		removeOwnedTree(
			overlayParent,
			backupPath,
			".buildplane-oci-backup-",
			"governed OCI backup directory",
		);
		fsyncOverlayPromotionDirectories(overlayParent, sourceParent);
		removeOverlayRecoveryJournal(overlayParent, controls.journalPath);
	} catch (error) {
		// The candidate tree may already be durable. Do not turn incomplete
		// backup/journal cleanup into a successful action: the caller must record
		// an unknown disposition and let the retained journal reconcile it. If the
		// failed operation was journal removal itself, its durability is unknown,
		// which is equally unsafe to report as completion.
		throw new Error(
			`governed OCI post-promotion cleanup requires reconciliation: ${errorMessage(error)}`,
		);
	}
}

function copyDirectoryContents(
	source: string,
	destination: string,
	label: string,
	maximumBytes: number,
	mode: "writable" | "preserve" = "writable",
): void {
	const sourceStats = requireSafeDirectory(source, label);
	chmodSync(destination, writableDirectoryMode(sourceStats.mode));
	const budget = { bytes: 0, entries: 0 };
	copyDirectoryEntries(source, destination, label, maximumBytes, budget, mode);
	chmodSync(
		destination,
		mode === "writable"
			? writableDirectoryMode(sourceStats.mode)
			: sourceStats.mode & 0o777,
	);
}

function copyDirectoryEntries(
	source: string,
	destination: string,
	label: string,
	maximumBytes: number,
	budget: { bytes: number; entries: number },
	mode: "writable" | "preserve",
): void {
	for (const entry of readdirSync(source).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const sourcePath = join(source, entry);
		const destinationPath = join(destination, entry);
		const stats = lstatSync(sourcePath);
		budget.entries += 1;
		if (budget.entries > 100_000) {
			throw new Error(`${label} exceeds the governed OCI overlay entry limit`);
		}
		if (stats.isSymbolicLink()) {
			throw new Error(`${label} must not contain symbolic links`);
		}
		if (stats.isDirectory()) {
			mkdirSync(destinationPath, { mode: writableDirectoryMode(stats.mode) });
			chmodSync(destinationPath, writableDirectoryMode(stats.mode));
			copyDirectoryEntries(
				sourcePath,
				destinationPath,
				label,
				maximumBytes,
				budget,
				mode,
			);
			chmodSync(
				destinationPath,
				mode === "writable"
					? writableDirectoryMode(stats.mode)
					: stats.mode & 0o777,
			);
			continue;
		}
		if (!stats.isFile()) {
			throw new Error(
				`${label} must contain only regular files and directories`,
			);
		}
		if (stats.nlink !== 1) {
			throw new Error(`${label} must not contain hard-linked regular files`);
		}
		budget.bytes += stats.size;
		if (budget.bytes > maximumBytes) {
			throw new Error(`${label} exceeds the governed OCI overlay byte limit`);
		}
		copyFileSync(sourcePath, destinationPath);
		chmodSync(
			destinationPath,
			mode === "writable" ? writableFileMode(stats.mode) : stats.mode & 0o777,
		);
	}
}

function fingerprintDirectory(
	root: string,
	label: string,
	maximumBytes: number,
): string {
	requireSafeDirectory(root, label);
	const hash = createHash("sha256");
	hash.update("buildplane.oci-overlay-tree.v1\\0", "utf8");
	const budget = { bytes: 0, entries: 0 };
	appendDirectoryFingerprint(hash, root, "", label, maximumBytes, budget);
	return `sha256:${hash.digest("hex")}`;
}

function assertSafeDirectoryTree(
	root: string,
	label: string,
	maximumBytes: number,
): void {
	fingerprintDirectory(root, label, maximumBytes);
}

function appendDirectoryFingerprint(
	hash: ReturnType<typeof createHash>,
	current: string,
	relativePath: string,
	label: string,
	maximumBytes: number,
	budget: { bytes: number; entries: number },
): void {
	const directoryStats = requireSafeDirectory(current, label);
	hash.update(
		`D\\0${relativePath}\\0${directoryStats.mode & 0o777}\\0`,
		"utf8",
	);
	for (const entry of readdirSync(current).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const path = join(current, entry);
		const childRelativePath =
			relativePath.length === 0 ? entry : `${relativePath}/${entry}`;
		const stats = lstatSync(path);
		budget.entries += 1;
		if (budget.entries > 100_000) {
			throw new Error(`${label} exceeds the governed OCI overlay entry limit`);
		}
		if (stats.isSymbolicLink()) {
			throw new Error(`${label} must not contain symbolic links`);
		}
		if (stats.isDirectory()) {
			appendDirectoryFingerprint(
				hash,
				path,
				childRelativePath,
				label,
				maximumBytes,
				budget,
			);
			continue;
		}
		if (!stats.isFile()) {
			throw new Error(
				`${label} must contain only regular files and directories`,
			);
		}
		if (stats.nlink !== 1) {
			throw new Error(`${label} must not contain hard-linked regular files`);
		}
		budget.bytes += stats.size;
		if (budget.bytes > maximumBytes) {
			throw new Error(`${label} exceeds the governed OCI overlay byte limit`);
		}
		const contentDigest = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
		hash.update(
			`F\\0${childRelativePath}\\0${stats.mode & 0o777}\\0${stats.size}\\0${contentDigest}\\0`,
			"utf8",
		);
	}
}

function requireSafeDirectory(path: string, label: string) {
	if (!existsSync(path)) {
		throw new Error(`${label} must name an existing directory`);
	}
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`${label} must be a non-symbolic-link directory`);
	}
	return stats;
}

function writableDirectoryMode(mode: number): number {
	return (mode & 0o777) | 0o700;
}

function writableFileMode(mode: number): number {
	return (mode & 0o777) | 0o600;
}

function assertPodmanMountPathSafe(path: string, label: string): void {
	if (
		/[,\r\n]/.test(path) ||
		(detectPlatform() === "linux" && path.includes(":"))
	) {
		throw new Error(
			`${label} contains a Podman volume delimiter and cannot be safely mounted`,
		);
	}
}

function assertOwnedOverlayPath(
	parent: string,
	path: string,
	prefix: string,
	label: string,
): void {
	assertContained(parent, path, label);
	if (dirname(path) !== parent || !basename(path).startsWith(prefix)) {
		throw new Error(`${label} is not an owned governed OCI temporary path`);
	}
}

function removeOwnedTree(
	parent: string,
	path: string,
	prefix: string,
	label: string,
): void {
	assertOwnedOverlayPath(parent, path, prefix, label);
	const stats = lstatIfPresent(path);
	if (stats === undefined) return;
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		unlinkSync(path);
		return;
	}
	makeTreeRemovable(path);
	rmSync(path, { recursive: true, force: true });
}

function lstatIfPresent(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

function isExistingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "EEXIST"
	);
}

function makeTreeRemovable(root: string): void {
	const stats = lstatSync(root);
	if (stats.isSymbolicLink()) return;
	if (stats.isDirectory()) {
		for (const entry of readdirSync(root)) {
			makeTreeRemovable(join(root, entry));
		}
		chmodSync(root, 0o700);
		return;
	}
	if (stats.isFile()) {
		chmodSync(root, 0o600);
	}
}

function defaultPodmanRunner(
	binary: "podman",
	args: readonly string[],
	options: { readonly input?: string; readonly timeoutMs?: number },
): PodmanCommandResult {
	if (binary !== "podman") {
		throw new Error("Governed Podman runner received an unsupported binary.");
	}
	const result = spawnSync(resolvePinnedPodmanBinary(), [...args], {
		encoding: "utf8",
		input: options.input,
		timeout: normalizePodmanControlPlaneTimeout(options.timeoutMs),
		shell: false,
		windowsHide: true,
		// Never leak the caller's host environment into the Podman control plane.
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		},
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error === undefined ? {} : { error: result.error.message }),
	};
}

function normalizePodmanControlPlaneTimeout(value: unknown): number {
	if (value === undefined) return PODMAN_TIMEOUT_MS;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > PODMAN_TIMEOUT_MS
	) {
		throw new Error(
			"Governed Podman control-plane timeout must be a positive safe integer no greater than the fixed Podman cap.",
		);
	}
	return value;
}

/**
 * The governed action plane never resolves Podman through PATH. The Linux
 * package location is an explicit part of the sandbox contract; a missing,
 * redirected, or non-regular binary blocks governed execution rather than
 * selecting an ambient host executable.
 */
function resolvePinnedPodmanBinary(): string {
	try {
		const configuredStats = lstatSync(PINNED_PODMAN_BINARY);
		if (configuredStats.isSymbolicLink() || !configuredStats.isFile()) {
			throw new Error("configured binary is not a regular file");
		}
		const resolved = realpathSync(PINNED_PODMAN_BINARY);
		if (resolved !== PINNED_PODMAN_BINARY) {
			throw new Error("configured binary did not resolve to its pinned path");
		}
		const resolvedStats = lstatSync(resolved);
		if (resolvedStats.isSymbolicLink() || !resolvedStats.isFile()) {
			throw new Error("resolved binary is not a regular file");
		}
		return resolved;
	} catch (error) {
		throw new Error(
			`Governed Podman execution requires the approved binary at ${PINNED_PODMAN_BINARY}: ${errorMessage(error)}`,
		);
	}
}

function normalizeRunnerResult(input: unknown): PodmanCommandResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError("Podman runner returned an invalid result");
	}
	const record = readOwnDataRecord(input, "Podman runner result");
	if (
		(record.status !== null &&
			(typeof record.status !== "number" ||
				!Number.isInteger(record.status))) ||
		typeof record.stdout !== "string" ||
		typeof record.stderr !== "string" ||
		(record.error !== undefined && typeof record.error !== "string")
	) {
		throw new TypeError("Podman runner returned an invalid result");
	}
	return {
		status: record.status as number | null,
		stdout: record.stdout,
		stderr: record.stderr,
		...(record.error === undefined ? {} : { error: record.error }),
	};
}

function toRunCommandResult(result: PodmanCommandResult): RunCommandResult {
	const exitCode = result.status ?? 1;
	return {
		success: result.status === 0 && result.error === undefined,
		exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		...(result.error === undefined ? {} : { error: result.error }),
	};
}

function toWriteFileResult(
	result: PodmanCommandResult,
	path: string,
): WriteFileResult {
	if (result.status === 0 && result.error === undefined) {
		return { success: true, path };
	}
	return writeFailure(
		result.error ??
			(result.stderr.length > 0
				? result.stderr
				: `podman exited with status ${result.status ?? "unknown"}`),
	);
}

function commandFailure(error: string): RunCommandResult {
	return {
		success: false,
		exitCode: 1,
		stdout: "",
		stderr: "",
		error,
	};
}

function writeFailure(error: string): WriteFileResult {
	return { success: false, error };
}

function readClosedRecord(
	input: unknown,
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> {
	const record = readOwnDataRecord(input, label);
	if (Object.keys(record).some((key) => !allowedFields.includes(key))) {
		throw new TypeError(`${label} must use the closed V1 schema.`);
	}
	return record;
}

function readOwnDataRecord(
	input: unknown,
	label: string,
): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError(`${label} must be a plain data object.`);
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain data object.`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const record: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string") {
			throw new TypeError(`${label} cannot contain symbol fields.`);
		}
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label} cannot contain accessor fields.`);
		}
		record[key] = descriptor.value;
	}
	return record;
}

function readRequiredString(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError(`${label} ${field} must be a non-empty string.`);
	}
	return value;
}

function readBoundedNumber(
	record: Record<string, unknown>,
	field: string,
	minimumExclusive: number,
	maximumInclusive: number,
	integer: boolean,
): number {
	const value = record[field];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= minimumExclusive ||
		value > maximumInclusive ||
		(integer && !Number.isSafeInteger(value))
	) {
		throw new TypeError(
			`Podman governed sandbox profile ${field} must be a bounded${
				integer ? " integer" : " number"
			}.`,
		);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
