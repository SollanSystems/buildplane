import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { ExecutionReceipt, UnitPacket } from "@buildplane/kernel";

export function executePacket(
	packet: UnitPacket,
	executionRoot: string,
): ExecutionReceipt {
	if (!packet.execution) {
		throw new Error(
			"executePacket requires a packet with an execution block. Model packets must use a model executor.",
		);
	}

	const workspaceRoot = resolve(executionRoot);
	assertWorkspacePathWithinRoot(
		workspaceRoot,
		packet.execution.cwd,
		"execution cwd",
		{ allowWorkspaceRoot: true },
	);
	for (const outputPath of packet.verification.requiredOutputs) {
		assertWorkspacePathWithinRoot(workspaceRoot, outputPath, "required output");
	}

	const args = [...(packet.execution.args ?? [])];
	const cwd = packet.execution.cwd
		? resolve(workspaceRoot, packet.execution.cwd)
		: workspaceRoot;
	const startedAt = new Date().toISOString();
	const result = spawnSync(packet.execution.command, args, {
		cwd,
		encoding: "utf8",
	});
	const completedAt = new Date().toISOString();

	return {
		command: packet.execution.command,
		args,
		cwd,
		startedAt,
		completedAt,
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		outputChecks: packet.verification.requiredOutputs.map((path: string) => ({
			path,
			exists: existsSync(resolve(workspaceRoot, path)),
		})),
	};
}

function assertWorkspacePathWithinRoot(
	workspaceRoot: string,
	value: string | undefined,
	label: string,
	options?: {
		allowWorkspaceRoot?: boolean;
	},
): void {
	if (value === undefined) {
		return;
	}

	if (isAbsolute(value)) {
		throw new Error(`${label} must not be absolute`);
	}

	const normalizedWorkspaceRoot = realpathSync(workspaceRoot);
	const normalizedValue = normalize(value);
	const resolvedPath = resolve(normalizedWorkspaceRoot, normalizedValue);
	const relativeToWorkspaceRoot = relative(
		normalizedWorkspaceRoot,
		resolvedPath,
	);

	if (
		relativeToWorkspaceRoot.startsWith(`..${sep}`) ||
		relativeToWorkspaceRoot === ".." ||
		isAbsolute(relativeToWorkspaceRoot)
	) {
		throw new Error(`${label} is outside the workspace root`);
	}

	if (relativeToWorkspaceRoot === "" && options?.allowWorkspaceRoot !== true) {
		throw new Error(`${label} must not be the workspace root`);
	}

	let currentPath = normalizedWorkspaceRoot;
	for (const segment of normalizedValue.split(/[\\/]+/).filter(Boolean)) {
		currentPath = resolve(currentPath, segment);
		if (!existsSync(currentPath)) {
			break;
		}

		const stat = lstatSync(currentPath);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`${label} traverses a symlink and escapes the workspace root`,
			);
		}

		const realCurrentPath = realpathSync(currentPath);
		const realRelativeToWorkspaceRoot = relative(
			normalizedWorkspaceRoot,
			realCurrentPath,
		);
		if (
			realRelativeToWorkspaceRoot.startsWith(`..${sep}`) ||
			realRelativeToWorkspaceRoot === ".." ||
			isAbsolute(realRelativeToWorkspaceRoot)
		) {
			throw new Error(`${label} is outside the workspace root`);
		}
	}
}
