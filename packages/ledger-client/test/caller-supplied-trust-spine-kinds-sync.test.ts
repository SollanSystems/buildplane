import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CALLER_SUPPLIED_TRUST_SPINE_KINDS,
	createTapeEmitter,
} from "../src/emitter.js";

// Cross-language drift guard for the client-side authority denylist.
//
// `CALLER_SUPPLIED_TRUST_SPINE_KINDS` is a hand-maintained TypeScript mirror of
// the native *always-blocked* denylist in `reject_caller_supplied_authority_event`
// (native/crates/bp-ledger/src/serve.rs). Nothing structural kept the two in step:
// the one known drift (`promotion_execution_claimed_v1`) was closed by hand, and
// the native-side pin added alongside it (`authority_ingest_denylist_tests`) has
// zero reach into TypeScript.
//
// This test reads the Rust source live on every run, so there is no generated
// artifact to regenerate and no freshness gate to forget. It deliberately parses
// the `#[cfg(test)]` mirror arrays rather than the `matches!` block itself: those
// arrays are flat, one-entry-per-line, and are already proven equivalent to the
// real guard by the Rust suite (`disposition_table_covers_every_event_kind_exactly_once`),
// whereas the match block uses multi-line union patterns with interleaved doc
// comments.

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_SRC = join(
	__dirname,
	"..",
	"..",
	"..",
	"native",
	"crates",
	"bp-ledger",
	"src",
);
const SERVE_RS = join(NATIVE_SRC, "serve.rs");
const KIND_RS = join(NATIVE_SRC, "kind.rs");

const ALWAYS_BLOCKED_ANCHOR =
	"const REJECTED_SIGNED_OR_UNSIGNED: &[EventKind] = &[";
const SIGNED_ONLY_ANCHOR = "const REJECTED_ONLY_WHEN_SIGNED: &[EventKind] = &[";
const AS_WIRE_ANCHOR = "pub fn as_wire(&self) -> &'static str {";

/**
 * Extract the `EventKind::` variant names from one of the flat mirror arrays in
 * `serve.rs`. Every failure mode is loud: a moved anchor, an unterminated block,
 * an empty extraction, and a partial extraction (fewer parsed variants than
 * entry-shaped lines) each throw with the reason, so a silent empty result can
 * never make the equality assertion vacuous.
 */
function extractDenylistVariants(anchor: string): string[] {
	const source = readFileSync(SERVE_RS, "utf8");
	const anchorAt = source.indexOf(anchor);
	if (anchorAt === -1) {
		throw new Error(
			`anchor ${JSON.stringify(anchor)} not found in ${SERVE_RS}. ` +
				"The native denylist mirror was renamed or moved — re-point this parser at it. " +
				"Do not delete this test: it is the only guard keeping " +
				"CALLER_SUPPLIED_TRUST_SPINE_KINDS in step with the native denylist.",
		);
	}
	const bodyStart = anchorAt + anchor.length;
	const bodyEnd = source.indexOf("];", bodyStart);
	if (bodyEnd === -1) {
		throw new Error(
			`unterminated array after ${JSON.stringify(anchor)} in ${SERVE_RS} ` +
				"(no closing `];` found).",
		);
	}
	const body = source.slice(bodyStart, bodyEnd);
	const variants = [...body.matchAll(/EventKind::(\w+)/g)].map(
		(match) => match[1],
	);
	if (variants.length === 0) {
		throw new Error(
			`parsed zero EventKind entries from ${JSON.stringify(anchor)} in ${SERVE_RS}. ` +
				"The array shape changed; fix the parser rather than accepting an empty set.",
		);
	}
	const entryLines = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"));
	if (variants.length !== entryLines.length) {
		throw new Error(
			`partial parse of ${JSON.stringify(anchor)} in ${SERVE_RS}: matched ` +
				`${variants.length} EventKind entries across ${entryLines.length} non-comment lines. ` +
				"Some entry uses a shape this parser does not recognise.",
		);
	}
	const duplicates = variants.filter(
		(name, index) => variants.indexOf(name) !== index,
	);
	if (duplicates.length > 0) {
		throw new Error(
			`duplicate EventKind entries in ${JSON.stringify(anchor)}: ${duplicates.join(", ")}.`,
		);
	}
	return variants;
}

/**
 * Build the `EventKind` variant → wire-string table from `as_wire()`'s own match
 * arms.
 *
 * The mapping must be read, never computed: `PlanReceiptRecorded => "plan_receipt"`
 * is irregular, so a mechanical PascalCase→snake_case transform would silently
 * mis-map. The arm regex also has to accept the one braced multi-line arm
 * (`GovernedDispatchV5AdmissionRecordedV1`) alongside the common single-line form.
 */
function extractWireNames(): Map<string, string> {
	const source = readFileSync(KIND_RS, "utf8");
	const anchorAt = source.indexOf(AS_WIRE_ANCHOR);
	if (anchorAt === -1) {
		throw new Error(
			`anchor ${JSON.stringify(AS_WIRE_ANCHOR)} not found in ${KIND_RS}. ` +
				"EventKind::as_wire changed shape — re-point this parser at it.",
		);
	}
	// Stop at the crate's test module so no other match arms can leak in.
	const testModuleAt = source.indexOf("\n#[cfg(test)]", anchorAt);
	const region = source.slice(
		anchorAt,
		testModuleAt === -1 ? undefined : testModuleAt,
	);
	const arms = [...region.matchAll(/Self::(\w+)\s*=>\s*\{?\s*"([a-z0-9_]+)"/g)];
	const armCount = (region.match(/Self::\w+\s*=>/g) ?? []).length;
	if (arms.length === 0 || arms.length !== armCount) {
		throw new Error(
			`partial parse of as_wire() in ${KIND_RS}: matched ${arms.length} wire ` +
				`strings across ${armCount} match arms. Some arm uses a shape this parser ` +
				'does not recognise (both `Self::X => "y",` and the braced multi-line ' +
				"form must be handled).",
		);
	}
	const table = new Map<string, string>();
	for (const [, variant, wire] of arms) {
		table.set(variant, wire);
	}
	if (table.size !== arms.length) {
		throw new Error(
			`duplicate EventKind arms in as_wire() (${arms.length} arms, ${table.size} distinct variants).`,
		);
	}
	return table;
}

function toWireKinds(variants: string[]): string[] {
	const table = extractWireNames();
	return variants.map((variant) => {
		const wire = table.get(variant);
		if (wire === undefined) {
			throw new Error(
				`EventKind::${variant} has no as_wire() arm in ${KIND_RS}. This parser ` +
					"refuses to guess a wire string: the mapping is irregular " +
					'(PlanReceiptRecorded => "plan_receipt").',
			);
		}
		return wire;
	});
}

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
	end() {}
}
class MockReadable extends EventEmitter {
	push(line: string) {
		this.emit("data", Buffer.from(line));
	}
}

const RUN_ID = "01919000-0000-7000-8000-000000000000";

/** Event kinds actually handed to the pipe, in write order (handshake excluded). */
function written(stdin: MockWritable): string[] {
	return stdin.writes
		.map((line) => /"kind":"([a-z0-9_]+)"/.exec(line)?.[1])
		.filter((kind): kind is string => kind !== undefined);
}

async function createHealthyEmitter() {
	const stdin = new MockWritable();
	const stderr = new MockReadable();
	const childExit = new Promise<number>(() => {});
	const emitterP = createTapeEmitter({
		childStdin: stdin as unknown as Writable,
		childStderr: stderr as unknown as Readable,
		childExit,
		workspacePath: "/tmp/ws",
		runId: RUN_ID,
	});
	setImmediate(() =>
		stderr.push(
			`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
		),
	);
	return { emitter: await emitterP, stdin };
}

describe("CALLER_SUPPLIED_TRUST_SPINE_KINDS vs the native denylists", () => {
	it("mirrors the native always-blocked denylist exactly", () => {
		const rustTruth = toWireKinds(
			extractDenylistVariants(ALWAYS_BLOCKED_ANCHOR),
		);
		expect([...rustTruth].sort()).toEqual(
			[...CALLER_SUPPLIED_TRUST_SPINE_KINDS].sort(),
		);
	});

	it("throws at the call site for every always-blocked kind", async () => {
		const { emitter, stdin } = await createHealthyEmitter();
		const rustTruth = toWireKinds(
			extractDenylistVariants(ALWAYS_BLOCKED_ANCHOR),
		);
		for (const kind of rustTruth) {
			expect(() => emitter.emit(kind, { forged: true })).toThrow(
				"authority-owned control",
			);
		}
		// Writes are queued, so drain the chain before asserting nothing landed —
		// otherwise the negative assertion would pass on timing alone.
		await new Promise((resolve) => setImmediate(resolve));
		expect(written(stdin)).toEqual([]);
	});

	it("lets every signed-only kind through the client-side guard", async () => {
		// The documented asymmetry, pinned as behavior: `emit()` has no signing
		// context, so the native second denylist is structurally unenforceable here.
		// Widening this guard to cover those kinds would break the unsigned lane the
		// native side deliberately keeps open — the rejection must stay native-side.
		const signedOnly = toWireKinds(extractDenylistVariants(SIGNED_ONLY_ANCHOR));
		expect(signedOnly).toEqual(
			expect.arrayContaining([
				"plan_admitted",
				"operator_decision_recorded",
				"acceptance_recorded",
				"result_ready",
			]),
		);

		const { emitter, stdin } = await createHealthyEmitter();
		for (const kind of signedOnly) {
			expect(CALLER_SUPPLIED_TRUST_SPINE_KINDS.has(kind)).toBe(false);
			expect(() => emitter.emit(kind, {})).not.toThrow();
		}
		await new Promise((resolve) => setImmediate(resolve));
		expect(written(stdin).sort()).toEqual([...signedOnly].sort());
	});
});
