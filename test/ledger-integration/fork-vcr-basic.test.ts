import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: fork with `--vcr` replays the parent's
 * recorded tool_result bytes instead of re-executing the tool.
 */
describe("fork --vcr basic [Phase F]", () => {
	it.skip("replays recorded tool outputs from parent tape", () => {});
});
