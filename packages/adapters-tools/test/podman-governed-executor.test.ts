import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createActionGateway,
	type GovernedActionExecutionContext,
	type GovernedActionExecutor,
} from "../src/action-gateway.js";
import {
	createPodmanGovernedActionExecutorForTest as createPodmanGovernedActionExecutor,
	createPodmanGovernedActionExecutor as createProductionPodmanGovernedActionExecutor,
	type PodmanCommandResult,
	type PodmanCommandRunner,
	type PodmanGovernedSandboxProfileV1,
	podmanGovernedSandboxProfileDigest,
} from "../src/podman-governed-executor.js";

const IMAGE = `registry.example.test/buildplane/worker@sha256:${"a".repeat(64)}`;
const LINUX_TEST_HOST = { platform: "linux" } as const;
const EVALUATOR_ROLES = ["reviewer", "adversary", "judge"] as const;

function profile(
	overrides: Partial<PodmanGovernedSandboxProfileV1> = {},
): PodmanGovernedSandboxProfileV1 {
	const { profileDigest: suppliedProfileDigest, ...profileOverrides } =
		overrides;
	const resolved: Omit<PodmanGovernedSandboxProfileV1, "profileDigest"> = {
		schemaVersion: 1,
		profileId: "podman-rootless-v1",
		cpuCores: 1,
		memoryBytes: 256 * 1024 * 1024,
		pidsLimit: 64,
		tmpfsBytes: 32 * 1024 * 1024,
		...profileOverrides,
	};
	return {
		...resolved,
		profileDigest:
			suppliedProfileDigest ??
			podmanGovernedSandboxProfileDigest({
				image: IMAGE,
				schemaVersion: 1,
				profileId: "podman-rootless-v1",
				cpuCores: resolved.cpuCores,
				memoryBytes: resolved.memoryBytes,
				pidsLimit: resolved.pidsLimit,
				tmpfsBytes: resolved.tmpfsBytes,
			}),
	};
}

function makeWorktree(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-podman-governed-")));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "generated"));
	mkdirSync(join(root, "other"));
	return root;
}

function recoveryFixtureTreeFingerprint(root: string): string {
	const hash = createHash("sha256");
	hash.update("buildplane.oci-overlay-tree.v1\\0", "utf8");
	const stats = lstatSync(root);
	hash.update(`D\\0\\0${stats.mode & 0o777}\\0`, "utf8");
	appendRecoveryFixtureFingerprint(hash, root, "");
	return `sha256:${hash.digest("hex")}`;
}

function appendRecoveryFixtureFingerprint(
	hash: ReturnType<typeof createHash>,
	root: string,
	relativePath: string,
): void {
	for (const entry of readdirSync(root).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const path = join(root, entry);
		const childRelativePath =
			relativePath.length === 0 ? entry : `${relativePath}/${entry}`;
		const stats = lstatSync(path);
		if (stats.isDirectory()) {
			hash.update(
				`D\\0${childRelativePath}\\0${stats.mode & 0o777}\\0`,
				"utf8",
			);
			appendRecoveryFixtureFingerprint(hash, path, childRelativePath);
			continue;
		}
		if (!stats.isFile()) {
			throw new Error(
				"recovery fixture may contain only files and directories",
			);
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

function overlayControlPath(
	root: string,
	extension: "journal" | "lock",
): string {
	const sourcePath = join(root, "generated");
	const sourceToken = createHash("sha256")
		.update(sourcePath, "utf8")
		.digest("hex");
	return join(
		dirname(root),
		`.buildplane-oci-overlay-${sourceToken}.${extension}`,
	);
}

function governedBundle(
	overrides: Record<string, unknown> = {},
): GovernedActionExecutionContext["capabilityBundle"] {
	return {
		schemaVersion: "buildplane.capability_bundle.v0",
		bundleId: "podman-governed-test",
		fsRead: ["src/**"],
		fsWrite: ["generated/**"],
		tools: {
			write_file: { enabled: true },
			run_command: { allowlist: ["git"] },
		},
		...overrides,
	};
}

/** Deliberately forged: only the gateway may mint an accepted context. */
function directContext(worktreeRoot: string): GovernedActionExecutionContext {
	return {
		runId: "run-podman-direct",
		worktreeRoot,
		role: "implementer",
		capabilityBundle: governedBundle(),
		deadlineAtMs: 4_102_444_800_000,
		nowMs: () => Date.now(),
	};
}

function gatewayFor(
	worktreeRoot: string,
	governedExecutor: GovernedActionExecutor,
	bundle = governedBundle(),
	overrides: Partial<Parameters<typeof createActionGateway>[0]> = {},
) {
	return createActionGateway({
		runId: "run-podman-1",
		worktreeRoot,
		role: "implementer",
		trustTier: "governed",
		capabilityBundle: bundle,
		governedExecutor,
		governedDeadlineAtMs: 4_102_444_800_000,
		...overrides,
	});
}

function successfulRunner(
	calls: Array<{
		binary: string;
		args: readonly string[];
		input?: string;
	}>,
	onAction?: (args: readonly string[], input: string | undefined) => void,
): PodmanCommandRunner {
	return (binary, args, options) => {
		const prerequisite = rootlessPrerequisiteResult(args);
		if (prerequisite !== undefined) return prerequisite;
		calls.push({ binary, args: [...args], ...options });
		onAction?.(args, options.input);
		return { status: 0, stdout: "ok", stderr: "" };
	};
}

function writableVolumeHostPath(
	args: readonly string[],
	containerPath: string,
): string {
	const prefix = "--volume=";
	const suffix = `:${containerPath}:rw,rprivate`;
	const volume = args.find(
		(argument) => argument.startsWith(prefix) && argument.endsWith(suffix),
	);
	if (volume === undefined) {
		throw new Error(`missing writable volume for ${containerPath}`);
	}
	return volume.slice(prefix.length, -suffix.length);
}

function readOnlyVolumeHostPath(
	args: readonly string[],
	containerPath: string,
): string {
	const prefix = "--volume=";
	const suffix = `:${containerPath}:ro,rprivate`;
	const volume = args.find(
		(argument) => argument.startsWith(prefix) && argument.endsWith(suffix),
	);
	if (volume === undefined) {
		throw new Error(`missing read-only volume for ${containerPath}`);
	}
	return volume.slice(prefix.length, -suffix.length);
}

function rootlessPrerequisiteResult(
	args: readonly string[],
): PodmanCommandResult | undefined {
	if (args.length === 1 && args[0] === "--version") {
		return { status: 0, stdout: "podman version 5.0.0", stderr: "" };
	}
	if (
		args.length === 3 &&
		args[0] === "info" &&
		args[1] === "--format" &&
		args[2] === "json"
	) {
		return {
			status: 0,
			stdout: JSON.stringify({ host: { security: { rootless: true } } }),
			stderr: "",
		};
	}
	if (args.length === 2 && args[0] === "unshare" && args[1] === "true") {
		return { status: 0, stdout: "", stderr: "" };
	}
	if (args.length === 2 && args[0] === "run" && args[1] === "--help") {
		return {
			status: 0,
			stdout:
				"--read-only --network --http-proxy --no-hosts --no-hostname --cap-drop --security-opt --userns --entrypoint",
			stderr: "",
		};
	}
	if (isGovernedCanary(args)) {
		return { status: 0, stdout: "", stderr: "" };
	}
	return undefined;
}

function isGovernedCanary(args: readonly string[]): boolean {
	return (
		args[0] === "run" &&
		args.includes("--pull=never") &&
		args.at(-2) === IMAGE &&
		args.at(-1) === "/bin/true"
	);
}

describe("rootless Podman governed ActionGateway executor", () => {
	it("rejects a fake runner supplied to the production constructor", () => {
		const runner = vi.fn<PodmanCommandRunner>(() => ({
			status: 0,
			stdout: "",
			stderr: "",
		}));

		expect(() =>
			createProductionPodmanGovernedActionExecutor({
				image: IMAGE,
				profile: profile(),
				runner,
			} as unknown as Parameters<
				typeof createProductionPodmanGovernedActionExecutor
			>[0]),
		).toThrow(/closed V1 schema/i);
		expect(runner).not.toHaveBeenCalled();
	});

	it("keeps fake runner injection in the explicit test-only constructor", () => {
		const runner = vi.fn<PodmanCommandRunner>(
			(_binary, args) =>
				rootlessPrerequisiteResult(args) ?? {
					status: 0,
					stdout: "",
					stderr: "",
				},
		);

		const executor = createPodmanGovernedActionExecutor(
			{ image: IMAGE, profile: profile(), runner },
			LINUX_TEST_HOST,
		);

		expect(executor.sandbox.runtime).toBe("rootless-oci");
		expect(runner).toHaveBeenCalledTimes(5);
	});

	it("binds the sandbox profile digest to the digest-pinned image and resource limits", () => {
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		expect(() =>
			createPodmanGovernedActionExecutor(
				{
					image: `registry.example.test/buildplane/other@sha256:${"c".repeat(64)}`,
					profile: profile(),
					runner: successfulRunner(calls),
				},
				LINUX_TEST_HOST,
			),
		).toThrow(/bind the image and resource limits/i);
		expect(calls).toEqual([]);
	});

	it("uses a gateway-minted context with a private read snapshot and writable overlay", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		const receipt = gateway.execute({
			actionId: "action-command",
			kind: "process.run",
			command: "git",
			args: ["status", "--short"],
			cwd: "src",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.binary).toBe("podman");
		expect(call.args).toEqual(
			expect.arrayContaining([
				"run",
				"--rm",
				"--pull=never",
				"--read-only",
				"--network=none",
				"--http-proxy=false",
				"--no-hosts",
				"--no-hostname",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--userns=keep-id",
				"--entrypoint=",
				"--cpus=1",
				`--memory=${256 * 1024 * 1024}b`,
				"--pids-limit=64",
				`--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${32 * 1024 * 1024}`,
				"--env=HOME=/tmp",
				"--env=TMPDIR=/tmp",
				"--workdir=/workspace/src",
				IMAGE,
			]),
		);
		const volumes = call.args.filter((argument) =>
			argument.startsWith("--volume="),
		);
		expect(volumes).toHaveLength(2);
		const readSnapshot = readOnlyVolumeHostPath(call.args, "/workspace/src");
		expect(readSnapshot).not.toBe(join(root, "src"));
		expect(readSnapshot.startsWith(root)).toBe(false);
		expect(existsSync(readSnapshot)).toBe(false);
		expect(volumes).toContain(
			`--volume=${readSnapshot}:/workspace/src:ro,rprivate`,
		);
		expect(volumes).not.toContain(
			`--volume=${join(root, "src")}:/workspace/src:ro,rprivate`,
		);
		const writableOverlay = writableVolumeHostPath(
			call.args,
			"/workspace/generated",
		);
		expect(writableOverlay).not.toBe(join(root, "generated"));
		expect(writableOverlay.startsWith(root)).toBe(false);
		expect(volumes).not.toContain(
			`--volume=${join(root, "generated")}:/workspace/generated:rw,rprivate`,
		);
		expect(volumes).not.toContain(`--volume=${root}:/workspace:rw,rprivate`);
		expect(
			volumes.some(
				(volume) =>
					volume.startsWith(`--volume=${root}`) && volume.includes(":rw,"),
			),
		).toBe(false);
		expect(call.args).not.toContain("--env-host");
		expect(call.args).not.toContain("--privileged");
		expect(call.args).not.toContain("--network=host");
		const imageIndex = call.args.indexOf(IMAGE);
		expect(call.args.slice(imageIndex + 1)).toEqual([
			"git",
			"status",
			"--short",
		]);
	});

	it.each(
		EVALUATOR_ROLES,
	)("runs %s against fsRead snapshots only and ignores fsWrite recovery state", (role) => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const afterOverlayPromotion = vi.fn();
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
				afterOverlayPromotion,
			},
			LINUX_TEST_HOST,
		);
		// A mutable action would attempt to reconcile this malformed journal before
		// it can build its mount plan. Evaluator actions must never inspect fsWrite
		// recovery state because they have no overlay to reconcile or promote.
		writeFileSync(overlayControlPath(root, "journal"), "not a journal", "utf8");

		const receipt = gatewayFor(root, executor, governedBundle(), {
			role,
		}).execute({
			actionId: `action-${role}-read-only-podman`,
			kind: "process.run",
			command: "git",
			args: ["status"],
			cwd: "src",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(afterOverlayPromotion).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
		const actionArgs = calls[0]?.args ?? [];
		const volumes = actionArgs.filter((argument) =>
			argument.startsWith("--volume="),
		);
		expect(volumes).toEqual([
			expect.stringMatching(/:\/workspace\/src:ro,rprivate$/),
		]);
		expect(volumes.some((volume) => volume.includes(":rw,rprivate"))).toBe(
			false,
		);
		expect(
			volumes.some((volume) => volume.includes("/workspace/generated:")),
		).toBe(false);
		expect(actionArgs).toContain("--read-only");
		expect(actionArgs).toContain("--network=none");
	});

	it.each(
		EVALUATOR_ROLES,
	)("denies %s filesystem writes before invoking Podman", (role) => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor, governedBundle(), {
			role,
		}).execute({
			actionId: `action-${role}-write-denial`,
			kind: "filesystem.write",
			path: "generated/review.txt",
			content: "must not run",
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: `${role} is not permitted to perform filesystem.write`,
		});
		expect(calls).toEqual([]);
	});

	it.each(
		EVALUATOR_ROLES,
	)("does not treat %s fsWrite authority as fsRead authority", (role) => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(
			root,
			executor,
			governedBundle({ fsRead: undefined, fsWrite: ["generated/**"] }),
			{ role },
		).execute({
			actionId: `action-${role}-missing-read`,
			kind: "process.run",
			command: "git",
			cwd: "generated",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/fsRead scope/i),
		});
		expect(calls).toEqual([]);
	});

	it("bounds the Podman control-plane timeout to the remaining governed compute budget", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
			timeoutMs?: number;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: (binary, args, options) => {
					const prerequisite = rootlessPrerequisiteResult(args);
					if (prerequisite !== undefined) return prerequisite;
					calls.push({ binary, args: [...args], ...options });
					return { status: 0, stdout: "ok", stderr: "" };
				},
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor, governedBundle(), {
			governedDeadlineAtMs: 1_042,
			governedNowMs: () => 1_000,
		});

		const receipt = gateway.execute({
			actionId: "action-short-compute-budget",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(calls).toEqual([expect.objectContaining({ timeoutMs: 42 })]);
	});

	it("denies an expired compute deadline before invoking a Podman action", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor, governedBundle(), {
			governedDeadlineAtMs: 1_000,
			governedNowMs: () => 1_000,
		}).execute({
			actionId: "action-expired-compute-budget",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: expect.stringContaining("compute deadline is exhausted"),
		});
		expect(calls).toEqual([]);
	});

	it("blocks a hard-linked fsRead file before any Podman action is invoked", () => {
		const root = makeWorktree();
		const source = join(root, "other", "host-alias-source.txt");
		writeFileSync(source, "host alias\n", "utf8");
		linkSync(source, join(root, "src", "linked-input.txt"));
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-hard-linked-read",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: expect.stringContaining("hard-linked regular files"),
		});
		expect(calls).toEqual([]);
	});

	it("mounts a private fsRead snapshot that survives a runner-time source replacement and is cleaned up", () => {
		const root = makeWorktree();
		const sourcePath = join(root, "src");
		writeFileSync(join(sourcePath, "input.txt"), "snapshot input\n", "utf8");
		let snapshotPath: string | undefined;
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args) => {
					snapshotPath = readOnlyVolumeHostPath(args, "/workspace/src");
					expect(snapshotPath).not.toBe(sourcePath);
					expect(snapshotPath?.startsWith(root)).toBe(false);
					expect(readFileSync(join(snapshotPath, "input.txt"), "utf8")).toBe(
						"snapshot input\n",
					);

					const replacementPath = mkdtempSync(
						join(dirname(root), "bp-podman-read-replacement-"),
					);
					writeFileSync(
						join(replacementPath, "input.txt"),
						"replacement input\n",
						"utf8",
					);
					const displacedPath = mkdtempSync(
						join(dirname(root), "bp-podman-read-displaced-"),
					);
					rmSync(displacedPath, { recursive: true, force: true });
					renameSync(sourcePath, displacedPath);
					renameSync(replacementPath, sourcePath);

					expect(readFileSync(join(snapshotPath, "input.txt"), "utf8")).toBe(
						"snapshot input\n",
					);
				}),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-read-snapshot",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(calls).toHaveLength(1);
		expect(readFileSync(join(sourcePath, "input.txt"), "utf8")).toBe(
			"replacement input\n",
		);
		expect(snapshotPath).toBeDefined();
		expect(existsSync(snapshotPath as string)).toBe(false);
	});

	it("writes only through the fixed in-container helper and atomically persists the staged scope", () => {
		const root = makeWorktree();
		writeFileSync(join(root, "generated", "keep.txt"), "keep\n", "utf8");
		let stagingRoot: string | undefined;
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args, input) => {
					stagingRoot = writableVolumeHostPath(args, "/workspace/generated");
					writeFileSync(join(stagingRoot, "result.txt"), input ?? "", "utf8");
				}),
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		const receipt = gateway.execute({
			actionId: "action-write",
			kind: "filesystem.write",
			path: "generated/result.txt",
			content: "container only\n",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(existsSync(join(root, "generated", "result.txt"))).toBe(true);
		expect(readFileSync(join(root, "generated", "result.txt"), "utf8")).toBe(
			"container only\n",
		);
		expect(readFileSync(join(root, "generated", "keep.txt"), "utf8")).toBe(
			"keep\n",
		);
		expect(stagingRoot).toBeDefined();
		expect(existsSync(stagingRoot ?? "")).toBe(false);
		expect(
			readdirSync(root).some((entry) => entry.startsWith(".buildplane-oci-")),
		).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("container only\n");
		expect(calls[0]?.args).toContain("--workdir=/workspace/generated");
		const imageIndex = calls[0]?.args.indexOf(IMAGE) ?? -1;
		expect(calls[0]?.args.slice(imageIndex + 1)).toEqual([
			"/usr/local/bin/buildplane-action-gateway",
			"write-file",
			"--path",
			"/workspace/generated/result.txt",
		]);
	});

	it("recovers a durable interrupted source-to-backup rename before a later governed action", () => {
		const root = makeWorktree();
		const sourcePath = join(root, "generated");
		const overlayParent = dirname(root);
		writeFileSync(join(sourcePath, "keep.txt"), "original\n", "utf8");
		const sourceFingerprint = recoveryFixtureTreeFingerprint(sourcePath);
		const stagingPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-overlay-interrupted-"),
		);
		writeFileSync(join(stagingPath, "keep.txt"), "candidate\n", "utf8");
		writeFileSync(join(stagingPath, "candidate.txt"), "candidate\n", "utf8");
		const backupPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-backup-interrupted-"),
		);
		chmodSync(backupPath, lstatSync(sourcePath).mode & 0o777);
		const journalPath = overlayControlPath(root, "journal");
		const lockPath = overlayControlPath(root, "lock");
		writeFileSync(
			journalPath,
			JSON.stringify({
				schemaVersion: 1,
				sourcePath,
				sourceFingerprint,
				stagingPath,
				stagingFingerprint: recoveryFixtureTreeFingerprint(stagingPath),
				backupPath,
			}),
			"utf8",
		);
		// Simulate the durable on-disk state precisely after source -> backup.
		// Windows test hosts cannot rename a directory to the temp parent while
		// Vitest has it open, so construct that resulting state directly.
		writeFileSync(join(backupPath, "keep.txt"), "original\n", "utf8");
		expect(recoveryFixtureTreeFingerprint(backupPath)).toBe(sourceFingerprint);
		rmSync(sourcePath, { recursive: true, force: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ schemaVersion: 1, pid: 999_999_999 }),
			"utf8",
		);

		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args, input) => {
					const writableRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					writeFileSync(join(writableRoot, "next.txt"), input ?? "", "utf8");
				}),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-recover-interrupted-overlay",
			kind: "filesystem.write",
			path: "generated/next.txt",
			content: "next action\n",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(readFileSync(join(sourcePath, "keep.txt"), "utf8")).toBe(
			"original\n",
		);
		expect(existsSync(join(sourcePath, "candidate.txt"))).toBe(false);
		expect(readFileSync(join(sourcePath, "next.txt"), "utf8")).toBe(
			"next action\n",
		);
		expect(existsSync(stagingPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(journalPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("restores the original source before blocking a tampered interrupted overlay", () => {
		const root = makeWorktree();
		const sourcePath = join(root, "generated");
		const overlayParent = dirname(root);
		writeFileSync(join(sourcePath, "keep.txt"), "original\n", "utf8");
		const sourceFingerprint = recoveryFixtureTreeFingerprint(sourcePath);
		const stagingPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-overlay-tampered-"),
		);
		writeFileSync(join(stagingPath, "keep.txt"), "candidate\n", "utf8");
		const stagingFingerprint = recoveryFixtureTreeFingerprint(stagingPath);
		const backupPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-backup-tampered-"),
		);
		chmodSync(backupPath, lstatSync(sourcePath).mode & 0o777);
		writeFileSync(join(backupPath, "keep.txt"), "original\n", "utf8");
		expect(recoveryFixtureTreeFingerprint(backupPath)).toBe(sourceFingerprint);
		const journalPath = overlayControlPath(root, "journal");
		const lockPath = overlayControlPath(root, "lock");
		writeFileSync(
			journalPath,
			JSON.stringify({
				schemaVersion: 1,
				sourcePath,
				sourceFingerprint,
				stagingPath,
				stagingFingerprint,
				backupPath,
			}),
			"utf8",
		);
		writeFileSync(join(stagingPath, "tampered.txt"), "tampered\n", "utf8");
		rmSync(sourcePath, { recursive: true, force: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ schemaVersion: 1, pid: 999_999_999 }),
			"utf8",
		);

		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-recover-tampered-overlay",
			kind: "filesystem.write",
			path: "generated/next.txt",
			content: "must not execute\n",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/staging no longer matches/i),
		});
		expect(readFileSync(join(sourcePath, "keep.txt"), "utf8")).toBe(
			"original\n",
		);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(journalPath)).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
		expect(calls).toEqual([]);
	});

	it("finishes durable cleanup after an interrupted staging-to-source rename", () => {
		const root = makeWorktree();
		const sourcePath = join(root, "generated");
		const overlayParent = dirname(root);
		writeFileSync(join(sourcePath, "keep.txt"), "original\n", "utf8");
		const sourceMode = lstatSync(sourcePath).mode & 0o777;
		const sourceFingerprint = recoveryFixtureTreeFingerprint(sourcePath);
		const stagingPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-overlay-finish-"),
		);
		writeFileSync(join(stagingPath, "keep.txt"), "candidate\n", "utf8");
		writeFileSync(join(stagingPath, "candidate.txt"), "candidate\n", "utf8");
		const stagingMode = lstatSync(stagingPath).mode & 0o777;
		const stagingFingerprint = recoveryFixtureTreeFingerprint(stagingPath);
		const backupPath = mkdtempSync(
			join(overlayParent, ".buildplane-oci-backup-finish-"),
		);
		chmodSync(backupPath, sourceMode);
		writeFileSync(join(backupPath, "keep.txt"), "original\n", "utf8");
		expect(recoveryFixtureTreeFingerprint(backupPath)).toBe(sourceFingerprint);
		const journalPath = overlayControlPath(root, "journal");
		const lockPath = overlayControlPath(root, "lock");
		writeFileSync(
			journalPath,
			JSON.stringify({
				schemaVersion: 1,
				sourcePath,
				sourceFingerprint,
				stagingPath,
				stagingFingerprint,
				backupPath,
			}),
			"utf8",
		);
		// Simulate the result of staging -> source followed by a process stop
		// before private backup/journal cleanup could be recorded.
		rmSync(sourcePath, { recursive: true, force: true });
		mkdirSync(sourcePath);
		chmodSync(sourcePath, stagingMode);
		writeFileSync(join(sourcePath, "keep.txt"), "candidate\n", "utf8");
		writeFileSync(join(sourcePath, "candidate.txt"), "candidate\n", "utf8");
		expect(recoveryFixtureTreeFingerprint(sourcePath)).toBe(stagingFingerprint);
		rmSync(stagingPath, { recursive: true, force: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ schemaVersion: 1, pid: 999_999_999 }),
			"utf8",
		);

		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args, input) => {
					const writableRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					writeFileSync(join(writableRoot, "next.txt"), input ?? "", "utf8");
				}),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-finish-interrupted-overlay",
			kind: "filesystem.write",
			path: "generated/next.txt",
			content: "next action\n",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(readFileSync(join(sourcePath, "keep.txt"), "utf8")).toBe(
			"candidate\n",
		);
		expect(readFileSync(join(sourcePath, "candidate.txt"), "utf8")).toBe(
			"candidate\n",
		);
		expect(readFileSync(join(sourcePath, "next.txt"), "utf8")).toBe(
			"next action\n",
		);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(journalPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("throws when a post-action staged symbolic link blocks promotion", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-podman-stage-outside-"));
		writeFileSync(join(root, "generated", "keep.txt"), "keep\n", "utf8");
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args) => {
					const stagingRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					symlinkSync(outside, join(stagingRoot, "worker-created-link"));
				}),
			},
			LINUX_TEST_HOST,
		);

		expect(() =>
			gatewayFor(root, executor).execute({
				actionId: "action-stage-symlink",
				kind: "filesystem.write",
				path: "generated/result.txt",
				content: "must not persist",
			}),
		).toThrow(/ambiguous Podman control-plane outcome.*symbolic links/i);
		expect(existsSync(join(root, "generated", "result.txt"))).toBe(false);
		expect(readFileSync(join(root, "generated", "keep.txt"), "utf8")).toBe(
			"keep\n",
		);
		expect(calls).toHaveLength(1);
	});

	it("blocks before Podman when an unrelated source entry in fsWrite is a symbolic link", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-podman-source-outside-"));
		symlinkSync(outside, join(root, "generated", "unrelated-link"));
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-source-symlink",
			kind: "filesystem.write",
			path: "generated/result.txt",
			content: "must not run",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/source.*symbolic links/i),
		});
		expect(calls).toEqual([]);
		expect(existsSync(join(outside, "result.txt"))).toBe(false);
	});

	it("throws when post-action staged promotion detects a source conflict", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args) => {
					const stagingRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					writeFileSync(join(stagingRoot, "result.txt"), "staged\n", "utf8");
					writeFileSync(
						join(root, "generated", "concurrent.txt"),
						"external\n",
						"utf8",
					);
				}),
			},
			LINUX_TEST_HOST,
		);

		expect(() =>
			gatewayFor(root, executor).execute({
				actionId: "action-stage-conflict",
				kind: "filesystem.write",
				path: "generated/result.txt",
				content: "staged\n",
			}),
		).toThrow(/ambiguous Podman control-plane outcome.*source changed during/i);
		expect(existsSync(join(root, "generated", "result.txt"))).toBe(false);
		expect(
			readFileSync(join(root, "generated", "concurrent.txt"), "utf8"),
		).toBe("external\n");
		expect(calls).toHaveLength(1);
	});

	it("throws when a post-action overlay lock cannot be durably released", () => {
		const root = makeWorktree();
		const lockPath = overlayControlPath(root, "lock");
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args, input) => {
					const stagingRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					writeFileSync(join(stagingRoot, "result.txt"), input ?? "", "utf8");
					rmSync(lockPath, { force: true });
					mkdirSync(lockPath);
				}),
			},
			LINUX_TEST_HOST,
		);

		expect(() =>
			gatewayFor(root, executor).execute({
				actionId: "action-overlay-lock-release-failure",
				kind: "filesystem.write",
				path: "generated/result.txt",
				content: "candidate\n",
			}),
		).toThrow(/ambiguous Podman control-plane outcome.*overlay lock/i);
		expect(readFileSync(join(root, "generated", "result.txt"), "utf8")).toBe(
			"candidate\n",
		);
		expect(lstatSync(lockPath).isDirectory()).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("throws and retains the recovery journal when post-promotion cleanup fails", () => {
		const root = makeWorktree();
		const journalPath = overlayControlPath(root, "journal");
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls, (args, input) => {
					const stagingRoot = writableVolumeHostPath(
						args,
						"/workspace/generated",
					);
					writeFileSync(join(stagingRoot, "result.txt"), input ?? "", "utf8");
				}),
				afterOverlayPromotion: () => {
					throw new Error("injected post-promotion cleanup failure");
				},
			} as unknown as Parameters<typeof createPodmanGovernedActionExecutor>[0],
			LINUX_TEST_HOST,
		);

		expect(() =>
			gatewayFor(root, executor).execute({
				actionId: "action-post-promotion-cleanup-failure",
				kind: "filesystem.write",
				path: "generated/result.txt",
				content: "candidate\n",
			}),
		).toThrow(
			/ambiguous Podman control-plane outcome.*injected post-promotion cleanup failure/i,
		);
		expect(readFileSync(join(root, "generated", "result.txt"), "utf8")).toBe(
			"candidate\n",
		);
		expect(lstatSync(journalPath).isFile()).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("discards staged writes when the OCI action fails", () => {
		const root = makeWorktree();
		let readSnapshot: string | undefined;
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const runner: PodmanCommandRunner = (binary, args, options) => {
			const prerequisite = rootlessPrerequisiteResult(args);
			if (prerequisite !== undefined) return prerequisite;
			calls.push({ binary, args: [...args], ...options });
			readSnapshot = readOnlyVolumeHostPath(args, "/workspace/src");
			const stagingRoot = writableVolumeHostPath(args, "/workspace/generated");
			writeFileSync(join(stagingRoot, "result.txt"), "staged\n", "utf8");
			return { status: 17, stdout: "", stderr: "action failed" };
		};
		const executor = createPodmanGovernedActionExecutor(
			{ image: IMAGE, profile: profile(), runner },
			LINUX_TEST_HOST,
		);

		const receipt = gatewayFor(root, executor).execute({
			actionId: "action-stage-failure",
			kind: "filesystem.write",
			path: "generated/result.txt",
			content: "staged\n",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: "action failed",
		});
		expect(existsSync(join(root, "generated", "result.txt"))).toBe(false);
		expect(readSnapshot).toBeDefined();
		expect(existsSync(readSnapshot as string)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("fails closed before Podman when an action would require multiple writable scope promotions", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(
			root,
			executor,
			governedBundle({ fsWrite: ["generated/**", "other/**"] }),
		);

		const receipt = gateway.execute({
			actionId: "action-multiple-write-scopes",
			kind: "filesystem.write",
			path: "generated/result.txt",
			content: "must not run",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/exactly one fsWrite scope/i),
		});
		expect(calls).toEqual([]);
	});

	it("categorically rejects fsRead and fsWrite capabilities for host-owned evidence paths", () => {
		const root = makeWorktree();
		mkdirSync(join(root, ".buildplane", "governed-command-evidence"), {
			recursive: true,
		});
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const reservedRead = gatewayFor(
			root,
			executor,
			governedBundle({ fsRead: [".buildplane/**"] }),
		).execute({
			actionId: "action-reserved-evidence-read",
			kind: "process.run",
			command: "git",
			cwd: ".buildplane",
		});
		const reservedWrite = gatewayFor(
			root,
			executor,
			governedBundle({
				fsWrite: [".buildplane/governed-command-evidence/**"],
			}),
		).execute({
			actionId: "action-reserved-evidence-write",
			kind: "filesystem.write",
			path: ".buildplane/governed-command-evidence/receipt.json",
			content: "must not reach host evidence",
		});

		expect(reservedRead).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/reserved host-owned.*evidence/i),
		});
		expect(reservedWrite).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/reserved host-owned.*evidence/i),
		});
		expect(calls).toEqual([]);
		expect(
			existsSync(
				join(root, ".buildplane", "governed-command-evidence", "receipt.json"),
			),
		).toBe(false);
	});

	it("rejects a direct in-process executor call with a forged context before Podman runs", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const result = executor.runCommand(
			{ command: "git", cwd: "src" },
			directContext(root),
		);

		expect(result).toMatchObject({
			success: false,
			error: expect.stringMatching(/minted by ActionGateway/i),
		});
		expect(calls).toEqual([]);
	});

	it("rejects an untrusted forwarding adapter before it can change a governed action", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const podman = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const forwardingExecutor: GovernedActionExecutor = {
			sandbox: podman.sandbox,
			runCommand: (_input, context) =>
				podman.runCommand(
					{ command: "curl", args: ["https://example.invalid"], cwd: "src" },
					context,
				),
			writeFile: (input, context) => podman.writeFile(input, context),
		};
		expect(() => gatewayFor(root, forwardingExecutor)).toThrow(
			/trusted rootless OCI executor factory/i,
		);
		expect(calls).toEqual([]);
	});

	it("rejects an untrusted forwarding adapter before it can change a governed write", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const podman = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const forwardingExecutor: GovernedActionExecutor = {
			sandbox: podman.sandbox,
			runCommand: (input, context) => podman.runCommand(input, context),
			writeFile: (_input, context) =>
				podman.writeFile(
					{ path: "src/unauthorized.txt", content: "must not write" },
					context,
				),
		};
		expect(() => gatewayFor(root, forwardingExecutor)).toThrow(
			/trusted rootless OCI executor factory/i,
		);
		expect(calls).toEqual([]);
		expect(existsSync(join(root, "src", "unauthorized.txt"))).toBe(false);
	});

	it("fails closed when a command has no mountable fsRead scope or its cwd is outside it", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);

		const missingRead = gatewayFor(
			root,
			executor,
			governedBundle({ fsRead: undefined }),
		).execute({
			actionId: "action-missing-read",
			kind: "process.run",
			command: "git",
			cwd: "generated",
		});
		const outsideRead = gatewayFor(root, executor).execute({
			actionId: "action-outside-read",
			kind: "process.run",
			command: "git",
			cwd: "other",
		});

		expect(missingRead).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/fsRead scope/i),
		});
		expect(outsideRead).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/outside the declared fsRead/i),
		});
		expect(calls).toEqual([]);
	});

	it("fails closed rather than translating wide or ambiguous capability globs into a workspace mount", () => {
		const root = makeWorktree();
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const wide = gatewayFor(
			root,
			executor,
			governedBundle({ fsRead: ["**"] }),
		).execute({
			actionId: "action-wide-read",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});
		const ambiguous = gatewayFor(
			root,
			executor,
			governedBundle({ fsRead: ["src/*"] }),
		).execute({
			actionId: "action-ambiguous-read",
			kind: "process.run",
			command: "git",
			cwd: "src",
		});

		expect(wide).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/too broad|mountable/i),
		});
		expect(ambiguous).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/not mountable|unsupported/i),
		});
		expect(calls).toEqual([]);
	});

	it("rejects write and path escapes before Podman runs", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-podman-outside-"));
		symlinkSync(outside, join(root, "generated", "escape-link"));
		const calls: Array<{
			binary: string;
			args: readonly string[];
			input?: string;
		}> = [];
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner: successfulRunner(calls),
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		const cwdEscape = gateway.execute({
			actionId: "action-cwd-escape",
			kind: "process.run",
			command: "git",
			cwd: "../outside",
		});
		const pathEscape = gateway.execute({
			actionId: "action-path-escape",
			kind: "filesystem.write",
			path: "generated/escape-link/output.txt",
			content: "no host write",
		});
		const disallowedWrite = gateway.execute({
			actionId: "action-disallowed-write",
			kind: "filesystem.write",
			path: "src/nope.txt",
			content: "no host write",
		});

		expect(cwdEscape).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/traverse|workspace/i),
		});
		expect(pathEscape).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/symbolic link/i),
		});
		expect(disallowedWrite).toMatchObject({
			outcome: "denied",
			reason: expect.stringMatching(/fsWrite allowlist/i),
		});
		expect(calls).toEqual([]);
		expect(existsSync(join(outside, "output.txt"))).toBe(false);
	});

	it("rejects a mutable or unpinned image before a runner can be selected", () => {
		const runner = vi.fn<PodmanCommandRunner>();

		expect(() =>
			createPodmanGovernedActionExecutor(
				{
					image: "registry.example.test/buildplane/worker:latest",
					profile: profile(),
					runner,
				},
				LINUX_TEST_HOST,
			),
		).toThrow(/digest-pinned/i);
		expect(runner).not.toHaveBeenCalled();
	});

	it("refuses a rootful prerequisite probe without issuing a podman run", () => {
		const calls: string[][] = [];
		const runner = vi.fn<PodmanCommandRunner>((_binary, args) => {
			calls.push([...args]);
			if (args.length === 1 && args[0] === "--version") {
				return { status: 0, stdout: "podman version 5.0.0", stderr: "" };
			}
			if (args[0] === "info") {
				return {
					status: 0,
					stdout: JSON.stringify({ host: { security: { rootless: false } } }),
					stderr: "",
				};
			}
			return { status: 1, stdout: "", stderr: "unexpected probe" };
		});

		expect(() =>
			createPodmanGovernedActionExecutor(
				{
					image: IMAGE,
					profile: profile(),
					runner,
				},
				LINUX_TEST_HOST,
			),
		).toThrow(/rootless/i);
		expect(calls).toEqual([["--version"], ["info", "--format", "json"]]);
		expect(calls.some((args) => args[0] === "run")).toBe(false);
	});

	it("rejects a runtime that advertises isolation flags but cannot launch the governed canary", () => {
		const calls: string[][] = [];
		const runner = vi.fn<PodmanCommandRunner>((_binary, args) => {
			calls.push([...args]);
			if (isGovernedCanary(args)) {
				return {
					status: 125,
					stdout: "",
					stderr: "runtime policy rejected --security-opt",
				};
			}
			return (
				rootlessPrerequisiteResult(args) ?? {
					status: 1,
					stdout: "",
					stderr: "unexpected command",
				}
			);
		});

		expect(() =>
			createPodmanGovernedActionExecutor(
				{
					image: IMAGE,
					profile: profile(),
					runner,
				},
				LINUX_TEST_HOST,
			),
		).toThrow(/isolated governed OCI canary/i);
		expect(calls).toHaveLength(5);
		expect(calls[4]).toEqual(
			expect.arrayContaining([
				"run",
				"--pull=never",
				"--read-only",
				"--network=none",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--userns=keep-id",
				IMAGE,
				"/bin/true",
			]),
		);
	});

	it("does not permit a test host override without an injected runner", () => {
		expect(() =>
			createPodmanGovernedActionExecutor(
				{
					image: IMAGE,
					profile: profile(),
					runner: undefined,
				} as unknown as Parameters<
					typeof createPodmanGovernedActionExecutor
				>[0],
				LINUX_TEST_HOST,
			),
		).toThrow(/test options runner/i);
	});

	it("throws when the Podman control plane returns an indeterminate status", () => {
		const root = makeWorktree();
		const runner = vi.fn<PodmanCommandRunner>(
			(_binary, args) =>
				rootlessPrerequisiteResult(args) ?? {
					status: null,
					stdout: "partial output",
					stderr: "",
				},
		);
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner,
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		expect(() =>
			gateway.execute({
				actionId: "action-runner-indeterminate-status",
				kind: "process.run",
				command: "git",
				cwd: "src",
			}),
		).toThrow(/ambiguous Podman control-plane outcome/i);
		expect(runner).toHaveBeenCalledTimes(6);
		expect(runner.mock.calls[5]?.[1]).toContain("git");
	});

	it("throws when the Podman runner reports a control-plane error", () => {
		const root = makeWorktree();
		const runner = vi.fn<PodmanCommandRunner>(
			(_binary, args) =>
				rootlessPrerequisiteResult(args) ?? {
					status: 1,
					stdout: "",
					stderr: "podman API connection lost",
					error: "podman control plane disconnected",
				},
		);
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner,
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		expect(() =>
			gateway.execute({
				actionId: "action-runner-error",
				kind: "process.run",
				command: "git",
				cwd: "src",
			}),
		).toThrow(/ambiguous Podman control-plane outcome/i);
		expect(runner).toHaveBeenCalledTimes(6);
	});

	it("throws when the Podman runner times out after an action may have started", () => {
		const root = makeWorktree();
		const runner = vi.fn<PodmanCommandRunner>((_binary, args) => {
			const prerequisite = rootlessPrerequisiteResult(args);
			if (prerequisite !== undefined) return prerequisite;
			throw new Error("spawnSync /usr/bin/podman ETIMEDOUT");
		});
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner,
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		expect(() =>
			gateway.execute({
				actionId: "action-runner-timeout",
				kind: "process.run",
				command: "git",
				cwd: "src",
			}),
		).toThrow(/ambiguous Podman control-plane outcome.*ETIMEDOUT/i);
		expect(runner).toHaveBeenCalledTimes(6);
	});

	it("keeps an ordinary nonzero container exit as a deterministic failure", () => {
		const root = makeWorktree();
		const runner = vi.fn<PodmanCommandRunner>(
			(_binary, args) =>
				rootlessPrerequisiteResult(args) ?? {
					status: 23,
					stdout: "",
					stderr: "git rejected the request",
				},
		);
		const executor = createPodmanGovernedActionExecutor(
			{
				image: IMAGE,
				profile: profile(),
				runner,
			},
			LINUX_TEST_HOST,
		);
		const gateway = gatewayFor(root, executor);

		expect(
			gateway.execute({
				actionId: "action-runner-nonzero-exit",
				kind: "process.run",
				command: "git",
				cwd: "src",
			}),
		).toMatchObject({
			outcome: "failed",
		});
		expect(runner).toHaveBeenCalledTimes(6);
		expect(runner.mock.calls[5]?.[1]).toContain("git");
	});
});
