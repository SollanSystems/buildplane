#!/usr/bin/env node
import { assertSupportedNodeVersion } from "./version-guard.js";

assertSupportedNodeVersion();

const cli = await import("./cli-main.js");

export const getBootstrapBanner = cli.getBootstrapBanner;
export const runCli = cli.runCli;

cli.runCliIfExecutedDirectly(import.meta.url, process.argv);
