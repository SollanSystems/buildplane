import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	realpathSync: vi.fn(),
	lstatSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: runtime.spawnSync,
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	realpathSync: runtime.realpathSync,
	lstatSync: runtime.lstatSync,
}));

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	platform: () => "linux",
}));

import {
	createPodmanGovernedActionExecutor,
	podmanGovernedSandboxProfileDigest,
} from "../src/podman-governed-executor.js";

const IMAGE = `registry.example.test/buildplane/worker@sha256:${"a".repeat(64)}`;

function profile() {
	const limits = {
		schemaVersion: 1 as const,
		profileId: "podman-rootless-v1" as const,
		cpuCores: 1,
		memoryBytes: 256 * 1024 * 1024,
		pidsLimit: 64,
		tmpfsBytes: 32 * 1024 * 1024,
	};
	return {
		...limits,
		profileDigest: podmanGovernedSandboxProfileDigest({
			image: IMAGE,
			...limits,
		}),
	};
}

function probeResult(args: readonly string[]) {
	if (args.length === 1 && args[0] === "--version") {
		return { status: 0, stdout: "podman version 5.0.0", stderr: "" };
	}
	if (args[0] === "info") {
		return {
			status: 0,
			stdout: JSON.stringify({ host: { security: { rootless: true } } }),
			stderr: "",
		};
	}
	if (args[0] === "unshare") {
		return { status: 0, stdout: "", stderr: "" };
	}
	if (args[0] === "run" && args[1] === "--help") {
		return {
			status: 0,
			stdout:
				"--read-only --network --http-proxy --no-hosts --no-hostname --cap-drop --security-opt --userns --entrypoint",
			stderr: "",
		};
	}
	if (
		args[0] === "run" &&
		args.includes("--pull=never") &&
		args.at(-2) === IMAGE &&
		args.at(-1) === "/bin/true"
	) {
		return { status: 0, stdout: "", stderr: "" };
	}
	throw new Error(`unexpected Podman probe: ${args.join(" ")}`);
}

describe("production Podman governed executor construction", () => {
	beforeEach(() => {
		runtime.spawnSync.mockReset();
		runtime.realpathSync.mockReset();
		runtime.lstatSync.mockReset();
		runtime.realpathSync.mockReturnValue("/usr/bin/podman");
		runtime.lstatSync.mockReturnValue({
			isFile: () => true,
			isSymbolicLink: () => false,
		});
		runtime.spawnSync.mockImplementation(
			(_binary: string, args: readonly string[]) => probeResult(args),
		);
	});

	it("uses the realpath-validated Podman binary instead of a PATH lookup", () => {
		createPodmanGovernedActionExecutor({ image: IMAGE, profile: profile() });

		expect(runtime.realpathSync).toHaveBeenCalledWith("/usr/bin/podman");
		expect(runtime.lstatSync).toHaveBeenCalledWith("/usr/bin/podman");
		expect(runtime.spawnSync).toHaveBeenCalledTimes(5);
		for (const [binary, _args, options] of runtime.spawnSync.mock.calls) {
			expect(binary).toBe("/usr/bin/podman");
			expect(options).toMatchObject({
				shell: false,
				env: {
					PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				},
			});
		}
		expect(runtime.spawnSync.mock.calls[4]?.[1]).toEqual(
			expect.arrayContaining([
				"run",
				"--pull=never",
				"--read-only",
				"--network=none",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--userns=keep-id",
				IMAGE,
				"/bin/true",
			]),
		);
	});
});
