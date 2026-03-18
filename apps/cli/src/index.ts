import { runCli } from "./run-cli.js";

/**
 * Return the Buildplane bootstrap banner.
 */
export function getBootstrapBanner(): string {
	return "Buildplane by SollanSystems";
}

export { runCli } from "./run-cli.js";

const isDirectRun =
	typeof process !== "undefined" &&
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
	void runCli(process.argv.slice(2)).then((exitCode) => {
		process.exitCode = exitCode;
	});
}
