#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeVersion } from "./version-guard.js";

assertSupportedNodeVersion();

const cli = await import("./cli-main.js");

export const getBootstrapBanner = cli.getBootstrapBanner;
export const runCli = cli.runCli;

function isExecutedDirectly() {
	if (typeof process === "undefined" || !process.argv[1]) {
		return false;
	}

	try {
		return (
			realpathSync.native(resolve(process.argv[1])) ===
			realpathSync.native(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isExecutedDirectly()) {
	void cli.runCli(process.argv.slice(2)).then((exitCode: number) => {
		process.exitCode = exitCode;
	});
}
