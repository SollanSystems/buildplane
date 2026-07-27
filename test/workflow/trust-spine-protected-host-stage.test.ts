import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const protectedHostBinaryNames = [
	"buildplane-authority-client",
	"buildplane-authority-host",
	"buildplane-governed-session-client",
	"buildplane-governed-session-host",
	"buildplane-promotion-execution-host",
	"buildplane-v5-dispatch-admission-client",
	"buildplane-v5-dispatch-admission-host",
] as const;

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Trust Spine protected-host bundle staging", () => {
	it("publishes the protected-host staging command from the workspace scripts", () => {
		const packageManifest = JSON.parse(
			readFileSync(join(process.cwd(), "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };

		expect(packageManifest.scripts?.["stage:trust-spine:protected-host"]).toBe(
			"node ./scripts/trust-spine/stage-protected-host.mjs --bin-dir ./native/target/release",
		);
	});

	it("stages immutable host binaries and hardened systemd units with a canonical hash manifest", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-protected-host-"));
		temporaryRoots.push(root);
		const binaryDirectory = join(root, "bin");
		const outputDirectory = join(root, "bundle");
		mkdirSync(binaryDirectory);

		for (const name of protectedHostBinaryNames) {
			const path = join(binaryDirectory, name);
			writeFileSync(
				path,
				Buffer.concat([
					Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
					Buffer.from(name),
				]),
			);
			chmodSync(path, 0o755);
		}

		const { stageProtectedHostBundleV1 } = await import(
			"../../scripts/trust-spine/stage-protected-host.mjs"
		);
		const result = stageProtectedHostBundleV1({
			binaryDirectory,
			outputDirectory,
		});

		expect(result).toEqual({
			bundleDirectory: outputDirectory,
			manifestPath: join(outputDirectory, "manifest.json"),
		});
		const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
			schemaVersion: number;
			artifact: string;
			files: Array<{
				path: string;
				installPath: string;
				mode: string;
				sha256: string;
			}>;
		};
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.artifact).toBe("buildplane-protected-trust-spine-host");
		expect(manifest.files.map(({ path }) => path)).toEqual([
			"libexec/buildplane-authority-client",
			"libexec/buildplane-authority-host",
			"libexec/buildplane-governed-session-client",
			"libexec/buildplane-governed-session-host",
			"libexec/buildplane-promotion-execution-host",
			"libexec/buildplane-v5-dispatch-admission-client",
			"libexec/buildplane-v5-dispatch-admission-host",
			"systemd/buildplane-authority-host.service",
			"systemd/buildplane-authority-host.socket",
			"systemd/buildplane-governed-session-host.service",
			"systemd/buildplane-governed-session-host.socket",
			"systemd/buildplane-promotion-execution-host.service",
			"systemd/buildplane-promotion-execution-host.socket",
			"systemd/buildplane-v5-dispatch-admission-host.service",
			"systemd/buildplane-v5-dispatch-admission-host.socket",
		]);
		expect(
			manifest.files.map(({ installPath, mode }) => [installPath, mode]),
		).toEqual([
			["/usr/libexec/buildplane/buildplane-authority-client", "0755"],
			["/usr/libexec/buildplane/buildplane-authority-host", "0755"],
			["/usr/libexec/buildplane/buildplane-governed-session-client", "0755"],
			["/usr/libexec/buildplane/buildplane-governed-session-host", "0755"],
			["/usr/libexec/buildplane/buildplane-promotion-execution-host", "0755"],
			[
				"/usr/libexec/buildplane/buildplane-v5-dispatch-admission-client",
				"0755",
			],
			["/usr/libexec/buildplane/buildplane-v5-dispatch-admission-host", "0755"],
			["/usr/lib/systemd/system/buildplane-authority-host.service", "0644"],
			["/usr/lib/systemd/system/buildplane-authority-host.socket", "0644"],
			[
				"/usr/lib/systemd/system/buildplane-governed-session-host.service",
				"0644",
			],
			[
				"/usr/lib/systemd/system/buildplane-governed-session-host.socket",
				"0644",
			],
			[
				"/usr/lib/systemd/system/buildplane-promotion-execution-host.service",
				"0644",
			],
			[
				"/usr/lib/systemd/system/buildplane-promotion-execution-host.socket",
				"0644",
			],
			[
				"/usr/lib/systemd/system/buildplane-v5-dispatch-admission-host.service",
				"0644",
			],
			[
				"/usr/lib/systemd/system/buildplane-v5-dispatch-admission-host.socket",
				"0644",
			],
		]);
		for (const file of manifest.files) {
			const stagedPath = join(outputDirectory, ...file.path.split("/"));
			expect(statSync(stagedPath).isFile()).toBe(true);
			expect(file.sha256).toBe(
				createHash("sha256").update(readFileSync(stagedPath)).digest("hex"),
			);
		}
		expect(
			readFileSync(
				join(
					outputDirectory,
					"systemd",
					"buildplane-governed-session-host.service",
				),
				"utf8",
			),
		).toContain("NoNewPrivileges=true");
		expect(
			readFileSync(
				join(
					outputDirectory,
					"systemd",
					"buildplane-governed-session-host.socket",
				),
				"utf8",
			),
		).toContain(
			"ListenStream=/run/buildplane/authority-host/governed-session-v1.sock",
		);
		const promotionExecutionService = readFileSync(
			join(
				outputDirectory,
				"systemd",
				"buildplane-promotion-execution-host.service",
			),
			"utf8",
		);
		expect(promotionExecutionService).toContain(
			"ReadWritePaths=/var/lib/buildplane/authority/repository",
		);
		expect(promotionExecutionService).toContain(
			"InaccessiblePaths=/var/lib/buildplane/authority/keys/operator",
		);
		expect(promotionExecutionService).toContain("PrivateNetwork=true");
		expect(promotionExecutionService).toContain("ProtectProc=invisible");
		expect(promotionExecutionService).toContain("ProcSubset=pid");
		expect(
			readFileSync(
				join(
					outputDirectory,
					"systemd",
					"buildplane-promotion-execution-host.socket",
				),
				"utf8",
			),
		).toContain(
			"ListenStream=/run/buildplane/authority-host/promotion-execution-v1.sock",
		);
	});

	it("rejects a non-ELF native binary before creating the bundle", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-protected-host-"));
		temporaryRoots.push(root);
		const binaryDirectory = join(root, "bin");
		const outputDirectory = join(root, "bundle");
		mkdirSync(binaryDirectory);
		for (const name of protectedHostBinaryNames) {
			const path = join(binaryDirectory, name);
			writeFileSync(
				path,
				Buffer.concat([
					Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
					Buffer.from(name),
				]),
			);
			chmodSync(path, 0o755);
		}
		writeFileSync(
			join(binaryDirectory, "buildplane-governed-session-host"),
			"not-an-elf-binary",
		);

		const { stageProtectedHostBundleV1 } = await import(
			"../../scripts/trust-spine/stage-protected-host.mjs"
		);
		expect(() =>
			stageProtectedHostBundleV1({ binaryDirectory, outputDirectory }),
		).toThrow(/ELF/i);
		expect(existsSync(outputDirectory)).toBe(false);
	});

	it("accepts the pnpm argument separator in the documented staging command", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-protected-host-"));
		temporaryRoots.push(root);
		const binaryDirectory = join(root, "bin");
		const outputDirectory = join(root, "bundle");
		mkdirSync(binaryDirectory);
		for (const name of protectedHostBinaryNames) {
			const path = join(binaryDirectory, name);
			writeFileSync(
				path,
				Buffer.concat([
					Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
					Buffer.from(name),
				]),
			);
			chmodSync(path, 0o755);
		}

		const result = spawnSync(
			process.execPath,
			[
				join(
					process.cwd(),
					"scripts",
					"trust-spine",
					"stage-protected-host.mjs",
				),
				"--bin-dir",
				binaryDirectory,
				"--",
				"--out",
				outputDirectory,
			],
			{ encoding: "utf8" },
		);

		expect(result).toMatchObject({ status: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({
			bundleDirectory: outputDirectory,
			manifestPath: join(outputDirectory, "manifest.json"),
		});
	});

	it("snapshots Cargo hard-linked binaries into single-link bundle files", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-protected-host-"));
		temporaryRoots.push(root);
		const binaryDirectory = join(root, "bin");
		const outputDirectory = join(root, "bundle");
		mkdirSync(binaryDirectory);
		for (const name of protectedHostBinaryNames) {
			const path = join(binaryDirectory, name);
			writeFileSync(
				path,
				Buffer.concat([
					Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
					Buffer.from(name),
				]),
			);
			chmodSync(path, 0o755);
		}
		linkSync(
			join(binaryDirectory, "buildplane-governed-session-client"),
			join(binaryDirectory, "cargo-hardlink"),
		);

		const { stageProtectedHostBundleV1 } = await import(
			"../../scripts/trust-spine/stage-protected-host.mjs"
		);
		stageProtectedHostBundleV1({ binaryDirectory, outputDirectory });

		expect(
			statSync(
				join(outputDirectory, "libexec", "buildplane-governed-session-client"),
			).nlink,
		).toBe(1);
	});
});
