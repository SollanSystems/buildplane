import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type RunCliDependencies, runCli } from "../src/run-cli";
import {
	DEFAULT_WEB_PORT,
	executeWebCommand,
	resolveWebRoot,
	type WebCommandOptions,
	type WebCommandRuntime,
} from "../src/web-command";

interface Capture {
	readonly stdout: string[];
	readonly stderr: string[];
	readonly options: Pick<WebCommandOptions, "stdout" | "stderr">;
}

function capture(): Capture {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		options: {
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		},
	};
}

function fakeDeps() {
	return {
		orchestrator: {} as never,
		store: {} as never,
	};
}

describe("executeWebCommand — --check (no-listen self-test)", () => {
	it("returns 0 and prints ok when GET /api/status responds 200", async () => {
		const cap = capture();
		const handleApiRequest = vi.fn(async () => ({
			status: 200,
			body: { initialized: true },
		}));
		const createMissionControlServer = vi.fn();
		const runtime: WebCommandRuntime = {
			loadServerModule: async () => ({
				createMissionControlServer,
				handleApiRequest,
			}),
			loadDeps: async () => fakeDeps(),
		};

		const code = await executeWebCommand(
			{
				cwd: "/proj",
				port: DEFAULT_WEB_PORT,
				check: true,
				allowExternal: false,
				...cap.options,
			},
			runtime,
		);

		expect(code).toBe(0);
		expect(cap.stdout).toContain("ok");
		// Proves dependency wiring without binding a TCP port.
		expect(createMissionControlServer).not.toHaveBeenCalled();
		expect(handleApiRequest).toHaveBeenCalledOnce();
		const request = handleApiRequest.mock.calls[0][1];
		expect(request.method).toBe("GET");
		expect(request.pathname).toBe("/api/status");
	});

	it("returns 1 when the status endpoint does not respond 200", async () => {
		const cap = capture();
		const runtime: WebCommandRuntime = {
			loadServerModule: async () => ({
				createMissionControlServer: vi.fn(),
				handleApiRequest: async () => ({ status: 503, body: undefined }),
			}),
			loadDeps: async () => fakeDeps(),
		};

		const code = await executeWebCommand(
			{
				cwd: "/proj",
				port: DEFAULT_WEB_PORT,
				check: true,
				allowExternal: false,
				...cap.options,
			},
			runtime,
		);

		expect(code).toBe(1);
		expect(cap.stderr.join("\n")).toContain("503");
	});
});

describe("executeWebCommand — serve (listen)", () => {
	it("creates the server with the apps/web/dist root + allowExternal, listens, logs, and closes on abort", async () => {
		const cap = capture();
		const close = vi.fn(async () => {});
		const listen = vi.fn(async (port: number) => ({
			host: "127.0.0.1",
			port,
		}));
		const createMissionControlServer = vi.fn(() => ({
			server: {} as never,
			listen,
			close,
		}));
		const runtime: WebCommandRuntime = {
			loadServerModule: async () => ({
				createMissionControlServer,
				handleApiRequest: vi.fn(),
			}),
			loadDeps: async () => fakeDeps(),
		};

		const controller = new AbortController();
		const pending = executeWebCommand(
			{
				cwd: "/proj",
				port: 8080,
				check: false,
				allowExternal: true,
				signal: controller.signal,
				...cap.options,
			},
			runtime,
		);

		await vi.waitFor(() => expect(listen).toHaveBeenCalledWith(8080));
		controller.abort();
		const code = await pending;

		expect(code).toBe(0);
		expect(createMissionControlServer).toHaveBeenCalledWith(
			expect.objectContaining({
				webRoot: resolveWebRoot("/proj"),
				allowExternal: true,
			}),
		);
		expect(close).toHaveBeenCalledOnce();
		expect(cap.stderr.join("\n")).toContain("127.0.0.1:8080");
	});

	it("closes immediately when the signal is already aborted", async () => {
		const cap = capture();
		const close = vi.fn(async () => {});
		const runtime: WebCommandRuntime = {
			loadServerModule: async () => ({
				createMissionControlServer: () => ({
					server: {} as never,
					listen: async (port: number) => ({ host: "127.0.0.1", port }),
					close,
				}),
				handleApiRequest: vi.fn(),
			}),
			loadDeps: async () => fakeDeps(),
		};

		const controller = new AbortController();
		controller.abort();
		const code = await executeWebCommand(
			{
				cwd: "/proj",
				port: 4173,
				check: false,
				allowExternal: false,
				signal: controller.signal,
				...cap.options,
			},
			runtime,
		);

		expect(code).toBe(0);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("resolveWebRoot — the served UI anchors to the CLI installation, not the operator's cwd", () => {
	it("serves the CLI checkout's apps/web/dist when it exists (bp web run from a target repo)", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-webroot-"));
		try {
			const moduleDir = join(root, "apps", "cli", "dist");
			const webDist = join(root, "apps", "web", "dist");
			mkdirSync(moduleDir, { recursive: true });
			mkdirSync(webDist, { recursive: true });
			writeFileSync(join(webDist, "index.html"), "<!doctype html>");

			expect(resolveWebRoot("/some/target-repo", moduleDir)).toBe(webDist);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the cwd-relative dist when the CLI checkout has none", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-webroot-"));
		try {
			const moduleDir = join(root, "apps", "cli", "dist");
			mkdirSync(moduleDir, { recursive: true });

			expect(resolveWebRoot("/some/target-repo", moduleDir)).toBe(
				join("/some/target-repo", "apps/web/dist"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("bp web — flag parsing + routing", () => {
	async function runWeb(
		argv: string[],
		dependencies: RunCliDependencies,
		cwd = "/proj",
	) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const exitCode = await runCli(argv, {
			cwd,
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
			dependencies,
		});
		return { exitCode, stdout, stderr };
	}

	it("routes `web --check` to the runWebCommand dep with parsed defaults", async () => {
		const runWebCommand = vi.fn(async () => 0);
		const { exitCode } = await runWeb(["web", "--check"], { runWebCommand });
		expect(exitCode).toBe(0);
		expect(runWebCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/proj",
				port: DEFAULT_WEB_PORT,
				check: true,
				allowExternal: false,
			}),
		);
	});

	it("parses --port", async () => {
		const runWebCommand = vi.fn(async () => 0);
		await runWeb(["web", "--port", "8080"], { runWebCommand });
		expect(runWebCommand).toHaveBeenCalledWith(
			expect.objectContaining({ port: 8080, check: false }),
		);
	});

	it("parses --allow-external", async () => {
		const runWebCommand = vi.fn(async () => 0);
		await runWeb(["web", "--allow-external"], { runWebCommand });
		expect(runWebCommand).toHaveBeenCalledWith(
			expect.objectContaining({ allowExternal: true }),
		);
	});

	it("rejects an invalid --port without invoking the server", async () => {
		const runWebCommand = vi.fn(async () => 0);
		const { exitCode, stderr } = await runWeb(["web", "--port", "notaport"], {
			runWebCommand,
		});
		expect(exitCode).toBe(1);
		expect(runWebCommand).not.toHaveBeenCalled();
		expect(stderr.join("\n")).toMatch(/invalid .*port/i);
	});
});

describe("top-level help", () => {
	it("lists the web command", async () => {
		const stdout: string[] = [];
		await runCli([], {
			cwd: "/proj",
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});
		expect(stdout.join("\n")).toMatch(/\bweb\b.*Mission Control/i);
	});
});
