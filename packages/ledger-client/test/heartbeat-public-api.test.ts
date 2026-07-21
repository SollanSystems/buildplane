import { describe, expect, it } from "vitest";
import { buildHeartbeatActivityV1 } from "../src/index.js";

describe("heartbeat public API", () => {
	it("exports the authority-owned activity-heartbeat wire builder", () => {
		expect(typeof buildHeartbeatActivityV1).toBe("function");
	});
});
