#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGsd2 } from "./gsd2.js";
import { assertSupportedNodeVersion } from "./version-guard.js";

assertSupportedNodeVersion();

if (isExecutedDirectly(import.meta.url, process.argv[1])) {
	void runGsd2(process.argv.slice(2)).then((exitCode) => {
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
