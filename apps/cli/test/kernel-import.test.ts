import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("@buildplane/kernel package consumption", () => {
	it("is importable by raw Node from apps/cli", () => {
		const output = execFileSync(
			process.execPath,
			[
				"-e",
				"import('@buildplane/kernel').then((mod) => console.log(JSON.stringify(Object.keys(mod).sort())))",
			],
			{
				cwd: cliDir,
				encoding: "utf8",
			},
		).trim();

		expect(output).toBe(
			JSON.stringify([
				"createBuildplaneOrchestrator",
				"createEventBus",
				"createGraphScheduler",
				"createResourceUsageSnapshot",
				"extractLearnings",
				"parseStrategyPacket",
				"parseUnitPacket",
				"validatePacketForWorkspaceRoot",
			]),
		);
	});

	it("resolves the full CLI dependency closure from source", () => {
		const script = `
			Promise.all([
				import('@buildplane/kernel'),
				import('@buildplane/runtime'),
				import('@buildplane/policy'),
				import('@buildplane/storage'),
				import('@buildplane/adapters-git'),
			]).then(() => console.log('ok'));
		`;
		const output = execFileSync(process.execPath, ["-e", script], {
			cwd: cliDir,
			encoding: "utf8",
		}).trim();

		expect(output).toBe("ok");
	});
});
