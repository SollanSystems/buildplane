import { describe, expect, it, vi } from "vitest";
import { emitCapabilityDenied } from "../src/ledger-capability-denied.js";

describe("emitCapabilityDenied", () => {
	it("emits capability_denied with CapabilityDeniedV1 payload", () => {
		const emit = vi.fn();
		const emitter = { emit, flush: vi.fn() } as never;
		emitCapabilityDenied(emitter, {
			runId: "run-1",
			bundleDigest: "sha256:aa",
			tool: "write_file",
			reason: "outside allowlist",
			target: "docs/x.md",
		});
		expect(emit).toHaveBeenCalledWith("capability_denied", {
			CapabilityDeniedV1: {
				run_id: "run-1",
				bundle_digest: "sha256:aa",
				tool: "write_file",
				reason: "outside allowlist",
				target: "docs/x.md",
			},
		});
	});
});
