#!/usr/bin/env node
import { assertSupportedNodeVersion } from "./version-guard.js";

assertSupportedNodeVersion();

const cli = await import("./cli-main.js");

export const getBootstrapBanner = cli.getBootstrapBanner;
export const runCli = cli.runCli;

const isDirectRun =
	typeof process !== "undefined" &&
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
	void cli.runCli(process.argv.slice(2)).then((exitCode: number) => {
		process.exitCode = exitCode;
	});
}
