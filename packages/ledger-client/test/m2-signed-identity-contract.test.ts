import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Wire-boundary half of the M2 signed-identity digest contract. The Rust source
// guard lives in native/crates/bp-ledger/tests/m2_digest_contract.rs; this
// asserts the bytes TS consumers actually receive carry no numeric field, so a
// future Rust `u64` (which typeshare would emit as a precision-lossy TS
// `number`) cannot slip into a signed admission/receipt identity unnoticed.
// See docs/architecture/canonical-digest-contract.md.

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixtures(): Record<string, unknown>[] {
	const path = join(__dirname, "..", "fixtures", "payload-variants.json");
	return JSON.parse(readFileSync(path, "utf8"));
}

function variant(name: string): Record<string, unknown> {
	const fx = loadFixtures().find(
		(f) => typeof f === "object" && f !== null && name in f,
	);
	if (!fx) {
		throw new Error(`fixture missing variant ${name}`);
	}
	return fx[name] as Record<string, unknown>;
}

function numericPaths(value: unknown, path: string, out: string[]): void {
	if (typeof value === "number") {
		out.push(path || "<root>");
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			numericPaths(value[i], `${path}[${i}]`, out);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			numericPaths(v, path ? `${path}.${k}` : k, out);
		}
	}
}

describe("M2 signed-identity digest contract (wire boundary)", () => {
	it("admit / receipt / activity-start payloads carry no numeric field", () => {
		for (const name of [
			"PlanAdmittedV1",
			"PlanReceiptRecordedV1",
			"ActivityStartedV1",
		]) {
			const found: string[] = [];
			numericPaths(variant(name), "", found);
			expect(
				found,
				`${name} has a numeric field (u64->number hazard) at: ${found.join(", ")}`,
			).toEqual([]);
		}
	});

	it("activity-completed typed fields carry no numeric field (result is opaque)", () => {
		const payload = { ...variant("ActivityCompletedV1") };
		// `result` is an opaque recorded model/tool output, not a typed wire
		// field; the precision contract covers the typed fields only.
		delete payload.result;
		const found: string[] = [];
		numericPaths(payload, "", found);
		expect(found).toEqual([]);
	});
});
