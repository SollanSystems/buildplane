import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./run-cli.js";

/**
 * Return the Buildplane bootstrap banner.
 */
export function getBootstrapBanner(): string {
	return "Buildplane by SollanSystems";
}

export { runCli };

export function runCliIfExecutedDirectly(
	entryUrl: string,
	argv = process.argv,
): void {
	if (!isExecutedDirectly(entryUrl, argv[1])) {
		return;
	}

	void runCli(argv.slice(2)).then((exitCode: number) => {
		process.exitCode = exitCode;
	});
}

function isExecutedDirectly(
	entryUrl: string,
	argv1: string | undefined,
): boolean {
	if (typeof process === "undefined" || !argv1) {
		return false;
	}

	try {
		return (
			realpathSync.native(resolve(argv1)) ===
			realpathSync.native(fileURLToPath(entryUrl))
		);
	} catch {
		return false;
	}
}
