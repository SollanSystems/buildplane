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
	runCliFn: (argv: string[]) => Promise<number> = runCli,
): void {
	if (!isExecutedDirectly(entryUrl, argv[1])) {
		return;
	}

	// A rejection here would otherwise crash the process as an unhandled
	// promise rejection — runCli formats its own errors, so anything arriving
	// here escaped that path and gets a plain message + exit 1.
	void runCliFn(argv.slice(2)).then(
		(exitCode: number) => {
			process.exitCode = exitCode;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		},
	);
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
