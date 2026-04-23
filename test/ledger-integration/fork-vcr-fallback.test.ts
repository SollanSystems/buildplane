import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: when `--vcr` is active but the parent tape
 * lacks a recorded tool_result for a given call, the fork falls back to
 * re-execute and surfaces a ReplayIssue::ToolOutputMissing in the fork's
 * tape state.
 */
describe("fork --vcr fallback [Phase F]", () => {
	it.skip("falls back to re-execute when parent tape is missing a tool_result", () => {});
});
