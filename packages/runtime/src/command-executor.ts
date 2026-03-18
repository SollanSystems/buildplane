import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecutionReceipt, UnitPacket } from "@buildplane/kernel";

export function executePacket(
	packet: UnitPacket,
	projectRoot: string,
): ExecutionReceipt {
	const args = [...(packet.execution.args ?? [])];
	const cwd = packet.execution.cwd
		? resolve(projectRoot, packet.execution.cwd)
		: projectRoot;
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
			exists: existsSync(resolve(projectRoot, path)),
		})),
	};
}
