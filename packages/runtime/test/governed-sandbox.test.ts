import { describe, expect, it, vi } from "vitest";
import {
	probeGovernedSandbox,
	type SandboxCommandRunner,
} from "../src/governed-sandbox";

function commandResult(input: {
	readonly status?: number | null;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly error?: string;
}) {
	return {
		status: input.status ?? 0,
		stdout: input.stdout ?? "",
		stderr: input.stderr ?? "",
		...(input.error === undefined ? {} : { error: input.error }),
	};
}

function rootlessPodmanRunner(options?: {
	readonly help?: string;
}): SandboxCommandRunner {
	return (binary, args) => {
		expect(binary).toBe("podman");
		if (args.join(" ") === "--version") {
			return commandResult({ stdout: "podman version 5.1.2\n" });
		}
		if (args.join(" ") === "info --format json") {
			return commandResult({
				stdout: JSON.stringify({ host: { security: { rootless: true } } }),
			});
		}
		if (args.join(" ") === "unshare true") {
			return commandResult({});
		}
		if (args.join(" ") === "run --help") {
			return commandResult({
				stdout:
					options?.help ??
					"--read-only --network --cap-drop --security-opt --userns\n",
			});
		}
		return commandResult({ status: 1, stderr: `unexpected args: ${args}` });
	};
}

describe("governed sandbox feasibility probe", () => {
	it("blocks a Windows host without probing or falling back to host execution", () => {
		const runCommand = vi.fn<SandboxCommandRunner>();

		const result = probeGovernedSandbox({
			platform: "win32",
			release: "10.0.26100",
			runCommand,
		});

		expect(result).toMatchObject({
			schemaVersion: 1,
			state: "blocked",
			governedWorkerExecution: "not_implemented",
			host: { platform: "win32", environment: "windows", isWsl: false },
			checks: {
				linuxHost: false,
				ociRuntime: false,
				rootless: false,
				userNamespace: false,
				isolationFlags: false,
			},
			failures: [
				{
					code: "NON_LINUX_HOST",
				},
			],
		});
		expect(runCommand).not.toHaveBeenCalled();
	});

	it("accepts WSL Linux only after rootless Podman and isolation prerequisites are proven", () => {
		const result = probeGovernedSandbox({
			platform: "linux",
			release: "5.15.146.1-microsoft-standard-WSL2",
			runCommand: rootlessPodmanRunner(),
		});

		expect(result).toEqual({
			schemaVersion: 1,
			state: "feasible",
			governedWorkerExecution: "not_implemented",
			host: { platform: "linux", environment: "wsl", isWsl: true },
			runtime: {
				binary: "podman",
				version: "5.1.2",
				rootless: true,
				userNamespace: true,
				isolationFlags: true,
			},
			checks: {
				linuxHost: true,
				ociRuntime: true,
				rootless: true,
				userNamespace: true,
				isolationFlags: true,
			},
			failures: [],
		});
	});

	it("blocks a rootful OCI runtime even when the binary is available", () => {
		const result = probeGovernedSandbox({
			platform: "linux",
			release: "6.8.0",
			runCommand: (binary, args) => {
				expect(binary).toBe("podman");
				if (args.join(" ") === "--version") {
					return commandResult({ stdout: "podman version 5.1.2\n" });
				}
				if (args.join(" ") === "info --format json") {
					return commandResult({
						stdout: JSON.stringify({ host: { security: { rootless: false } } }),
					});
				}
				return commandResult({ status: 1, stderr: "unexpected command" });
			},
		});

		expect(result).toMatchObject({
			state: "blocked",
			checks: {
				linuxHost: true,
				ociRuntime: true,
				rootless: false,
			},
			failures: [{ code: "OCI_ROOTLESS_NOT_PROVEN" }],
		});
	});

	it("reports a missing OCI runtime as a structured block", () => {
		const result = probeGovernedSandbox({
			platform: "linux",
			release: "6.8.0",
			runCommand: () =>
				commandResult({ status: null, error: "spawn podman ENOENT" }),
		});

		expect(result).toMatchObject({
			state: "blocked",
			checks: {
				linuxHost: true,
				ociRuntime: false,
			},
			failures: [{ code: "OCI_RUNTIME_UNAVAILABLE" }],
		});
	});

	it("blocks when a rootless runtime cannot prove the required isolation flags", () => {
		const result = probeGovernedSandbox({
			platform: "linux",
			release: "6.8.0",
			runCommand: rootlessPodmanRunner({
				help: "--read-only --network --cap-drop --security-opt\n",
			}),
		});

		expect(result).toMatchObject({
			state: "blocked",
			checks: {
				linuxHost: true,
				ociRuntime: true,
				rootless: true,
				userNamespace: true,
				isolationFlags: false,
			},
			failures: [{ code: "OCI_ISOLATION_FLAGS_UNAVAILABLE" }],
		});
	});
});
