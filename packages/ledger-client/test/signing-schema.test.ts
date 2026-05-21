import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type EventSignatureV1,
	SignatureAlgorithm,
} from "../src/generated/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSignatureFixture(): EventSignatureV1 {
	const path = join(__dirname, "..", "fixtures", "event-signature-v1.json");
	return JSON.parse(readFileSync(path, "utf8")) as EventSignatureV1;
}

describe("signed tape schema", () => {
	it("models detached Ed25519 event signatures without changing event envelopes", () => {
		const signature = loadSignatureFixture();

		expect(signature.algorithm).toBe(SignatureAlgorithm.Ed25519);
		expect(signature.signer.actor_id).toBe("kernel");
		expect(Object.keys(signature).sort()).toEqual([
			"algorithm",
			"canonical_event_hash",
			"event_id",
			"signature",
			"signed_at",
			"signer",
		]);
	});
});
