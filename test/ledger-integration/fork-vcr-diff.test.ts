import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: VCR matching works across schema-version
 * canonicalization (parent tape written at v1, fork running with canonical
 * reader still matches tool-call equivalence).
 */
describe("fork --vcr diff [Phase F]", () => {
	it.skip("matches tool-call equivalence across schema-version canonicalization", () => {});
});
