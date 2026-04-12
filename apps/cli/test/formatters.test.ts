import { describe, expect, it } from "vitest";
import {
	formatLearningDetail,
	formatLearningsList,
} from "../src/formatters.js";

const sampleLearning = {
	id: "abc-123",
	runId: "run-1",
	scope: "workspace" as const,
	kind: "constraint" as const,
	title: "Run rejected",
	body: "Rejected: exit code 1",
	status: "active" as const,
	createdAt: "2026-04-12T01:00:00Z",
	seenCount: 3,
};

describe("formatLearningsList", () => {
	it("formats a table with header and rows", () => {
		const lines = formatLearningsList([sampleLearning]);
		expect(lines[0]).toContain("ID");
		expect(lines[0]).toContain("Scope");
		expect(lines[0]).toContain("Kind");
		expect(lines[0]).toContain("Seen");
		expect(lines[0]).toContain("Title");
		expect(lines.length).toBeGreaterThanOrEqual(3); // header + separator + 1 row
		const dataLine = lines[2];
		expect(dataLine).toContain("abc-123");
		expect(dataLine).toContain("workspace");
		expect(dataLine).toContain("constraint");
		expect(dataLine).toContain("3");
		expect(dataLine).toContain("Run rejected");
	});

	it("returns 'No learnings found.' for empty array", () => {
		const lines = formatLearningsList([]);
		expect(lines).toEqual(["No learnings found."]);
	});
});

describe("formatLearningDetail", () => {
	it("formats full detail for a learning", () => {
		const lines = formatLearningDetail(sampleLearning);
		expect(lines).toContainEqual(expect.stringContaining("ID:"));
		expect(lines).toContainEqual(expect.stringContaining("abc-123"));
		expect(lines).toContainEqual(expect.stringContaining("Title:"));
		expect(lines).toContainEqual(expect.stringContaining("Run rejected"));
		expect(lines).toContainEqual(expect.stringContaining("Scope:"));
		expect(lines).toContainEqual(expect.stringContaining("workspace"));
		expect(lines).toContainEqual(expect.stringContaining("Kind:"));
		expect(lines).toContainEqual(expect.stringContaining("constraint"));
		expect(lines).toContainEqual(expect.stringContaining("Status:"));
		expect(lines).toContainEqual(expect.stringContaining("active"));
		expect(lines).toContainEqual(expect.stringContaining("Seen:"));
		expect(lines).toContainEqual(expect.stringContaining("3"));
		expect(lines).toContainEqual(expect.stringContaining("Run:"));
		expect(lines).toContainEqual(expect.stringContaining("run-1"));
		expect(lines).toContainEqual(expect.stringContaining("Body:"));
		expect(lines).toContainEqual(
			expect.stringContaining("Rejected: exit code 1"),
		);
	});
});
