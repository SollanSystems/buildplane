import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readPlanForgeDispatchManifests,
	writePlanForgeDispatchManifest,
} from "../src/run-cli.js";

describe("planforge dispatch manifest", () => {
	let ws: string;
	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bp-manifest-"));
	});
	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("round-trips a manifest and lists it", () => {
		const m = {
			runId: "00000000-0000-8000-8000-000000000001",
			inputPath: "/abs/goal.md",
			planId: "pf-plan-95d7132e",
			idempotencyKey: "idem-1",
			createdAt: "2026-06-22T00:00:00.000Z",
		};
		writePlanForgeDispatchManifest(ws, m);
		const onDisk = JSON.parse(
			readFileSync(
				join(ws, ".buildplane", "planforge", "dispatch", `${m.runId}.json`),
				"utf8",
			),
		);
		expect(onDisk).toEqual(m);
		expect(readPlanForgeDispatchManifests(ws)).toEqual([m]);
	});

	it("returns [] when no dispatch dir exists", () => {
		expect(readPlanForgeDispatchManifests(ws)).toEqual([]);
	});
});
