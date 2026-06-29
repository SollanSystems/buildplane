import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createToolRegistry } from "@buildplane/adapters-tools";
import {
	bundleDigest,
	type CapabilityBundleV0,
} from "@buildplane/capability-broker";
import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitCapabilityDenied } from "../../apps/cli/src/ledger-capability-denied.ts";
import { spawnLedgerSubprocess } from "../../apps/cli/src/ledger-emit.ts";
import { resolveNativeBinaryForLedgerTests } from "./fixtures.ts";

// M6-S10 — a REAL end-to-end capability_denied: the demo's out-of-scope packet
// grants fsWrite ONLY to src/** and test/**, then attempts write_file to
// docs/out-of-scope.txt. Driven through the REAL createToolRegistry (the same
// broker path M3 enforces) over a REAL kernel-signed events.db. Asserts the
// three load-bearing things: (a) a signed capability_denied row is on the tape
// and verifies under the kernel key, (b) the write is denied + quarantined (no
// file on disk), (c) the denial carries the attempted path + the violated
// fsWrite scope. Mirrors operator-envelope.test.ts: a kernel ed25519 seed under
// a temp HOME drives `serve --sign`; no process.chdir. This slice closes a test
// gap only — it changes no production code.

const FIXTURE_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../fixtures/demo-repo/out-of-scope-packet.json",
);

const RUN_ID = "01919000-0000-7000-8000-0000000000ca";

interface OutOfScopePacket {
	readonly capability_bundle: CapabilityBundleV0;
	readonly capability_bundle_digest: string;
	readonly outOfScopeWrite: { readonly path: string; readonly content: string };
}

function loadPacket(): OutOfScopePacket {
	return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as OutOfScopePacket;
}

interface DenyEnv {
	dir: string;
	home: string;
	eventsDbPath: string;
	emitter: TapeEmitter;
	cleanup: () => Promise<void>;
}

// Provision a temp workspace + temp HOME (with a kernel signing key), then spawn
// the real `ledger serve --sign` subprocess and a tape emitter against it. HOME
// is set BEFORE the spawn so `serve --sign` resolves the key during handshake.
async function makeDenyEnv(): Promise<DenyEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-capdenied-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-capdenied-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	// Raw 32-byte ed25519 seed; the value is irrelevant — only that the kernel
	// key resolves so `serve --sign` produces real detached signatures.
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));
	process.env.HOME = home;

	const binary = resolveNativeBinaryForLedgerTests();
	const ledger = spawnLedgerSubprocess(binary, RUN_ID, dir, { sign: true });

	let childDead = false;
	ledger.child.on("exit", () => {
		childDead = true;
	});

	const emitter = await createTapeEmitter({
		childStdin: ledger.stdin as Writable,
		childStderr: ledger.stderr as Readable,
		childExit: ledger.exit,
		workspacePath: dir,
		runId: RUN_ID,
		handshakeTimeoutMs: 5_000,
	});

	const cleanup = async () => {
		if (!childDead) {
			try {
				await emitter.close();
			} catch {
				// tolerate an already-closed/failed emitter
			}
		}
		if (!childDead) {
			ledger.child.kill("SIGTERM");
			await new Promise<void>((r) => ledger.child.on("exit", () => r()));
		}
		await rm(dir, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	};

	return {
		dir,
		home,
		eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
		emitter,
		cleanup,
	};
}

interface DeniedRow {
	id: string;
	payload: string;
}
interface SignatureRow {
	event_id: string;
	actor_id: string;
	key_id: string;
	algorithm: string;
}

async function readTape(eventsDbPath: string): Promise<{
	denials: DeniedRow[];
	signatures: SignatureRow[];
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const denials = db
			.prepare(
				"SELECT id, payload FROM events WHERE kind = 'capability_denied'",
			)
			.all() as unknown as DeniedRow[];
		const signatures = db
			.prepare(
				"SELECT event_id, actor_id, key_id, algorithm FROM event_signatures",
			)
			.all() as unknown as SignatureRow[];
		return { denials, signatures };
	} finally {
		db.close();
	}
}

describe.sequential("capability_denied — real broker + signed tape (M6-S10)", () => {
	let env: DenyEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		env = await makeDenyEnv();
	});

	afterEach(async () => {
		await env.cleanup();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalNativeBin === undefined) {
			delete process.env.BUILDPLANE_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		}
	});

	it("denies + quarantines an out-of-scope write and signs the denial on the tape", async () => {
		const packet = loadPacket();

		// The fixture is a faithful, internally-consistent packet: its declared
		// digest is the canonical digest of its bundle (the same invariant
		// packet.ts enforces at parse time).
		expect(packet.capability_bundle_digest).toBe(
			bundleDigest(packet.capability_bundle),
		);
		expect(packet.capability_bundle.fsWrite).toEqual(["src/**", "test/**"]);
		expect(packet.outOfScopeWrite.path).toBe("docs/out-of-scope.txt");

		// Emit a real run root so the denial lands on a genuine run's tape.
		env.emitter.emit("run_started", {
			RunStartedV1: {
				packet_hash: `sha256:${"a".repeat(64)}`,
				git_head: "deadbeef",
				workspace_path: env.dir,
				config: {},
				parent_run_id: null,
			},
		});

		// Wire the REAL ToolRegistry exactly as run-cli does: the broker bundle
		// confines write_file, and onCapabilityDenied appends a signed
		// capability_denied quarantine event referencing the bundle digest.
		const digest = packet.capability_bundle_digest;
		const registry = createToolRegistry(env.dir, {
			capabilityBundle: packet.capability_bundle,
			onCapabilityDenied: (detail) => {
				emitCapabilityDenied(env.emitter, {
					runId: RUN_ID,
					bundleDigest: digest,
					...detail,
				});
			},
		});

		const result = registry.write_file({
			path: packet.outOfScopeWrite.path,
			content: packet.outOfScopeWrite.content,
		});

		// (b) the write is DENIED and quarantined — nothing on disk.
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
		expect(result.error).toMatch(/fsWrite/i);
		expect(existsSync(join(env.dir, "docs", "out-of-scope.txt"))).toBe(false);

		// Flush the tape so the quarantine event is durable before we read it.
		await env.emitter.flush();

		const { denials, signatures } = await readTape(env.eventsDbPath);

		// (a) exactly one signed capability_denied row on the tape.
		expect(denials).toHaveLength(1);
		const payload = JSON.parse(denials[0].payload).CapabilityDeniedV1;
		expect(payload.run_id).toBe(RUN_ID);
		expect(payload.tool).toBe("write_file");
		expect(payload.bundle_digest).toBe(digest);

		// (c) the denial carries the attempted path + the violated fsWrite scope.
		expect(payload.target).toBe("docs/out-of-scope.txt");
		expect(payload.reason).toMatch(/docs\/out-of-scope\.txt/);
		expect(payload.reason).toMatch(/fsWrite/i);

		// (a, cont.) it verifies under the kernel key.
		const sig = signatures.find((s) => s.event_id === denials[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");
	}, 30_000);
});
