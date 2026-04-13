import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("searchable document storage", () => {
	it("stores and lists searchable documents for the current repo", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-searchable-documents-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const document = storage.createSearchableDocument({
			documentKind: "run-summary",
			title: "Backtest replay summary",
			bodyText: "NQ replay showed mean reversion around VWAP and the Kalman spread.",
			metadata: { tags: ["nq", "replay"] },
			sourceTable: "runs",
			sourceId: "run-1",
		});

		const documents = storage.listSearchableDocuments();

		expect(document.documentKind).toBe("run-summary");
		expect(document.title).toBe("Backtest replay summary");
		expect(document.repoId).toBe(root);
		expect(documents).toHaveLength(1);
		expect(documents[0]?.sourceTable).toBe("runs");
		expect(documents[0]?.sourceId).toBe("run-1");
		expect(documents[0]?.metadata).toEqual({ tags: ["nq", "replay"] });
	});

	it("filters searchable documents by kind", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-searchable-documents-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		storage.createSearchableDocument({
			sourceTable: "runs",
			sourceId: "run-1",
			documentKind: "run-summary",
			title: "Replay summary",
			bodyText: "A replay result",
		});
		storage.createSearchableDocument({
			sourceTable: "notes",
			sourceId: "note-1",
			documentKind: "operator-note",
			title: "Manual note",
			bodyText: "Operator approved the replay configuration.",
		});

		const documents = storage.listSearchableDocuments({
			documentKind: "operator-note",
		});

		expect(documents).toHaveLength(1);
		expect(documents[0]?.documentKind).toBe("operator-note");
		expect(documents[0]?.title).toBe("Manual note");
	});

	it("searches searchable documents by title and body text", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-searchable-documents-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const matching = storage.createSearchableDocument({
			sourceTable: "runs",
			sourceId: "run-1",
			documentKind: "run-summary",
			title: "Kalman spread replay",
			bodyText: "The Kalman spread tightened after the FOMC event.",
		});
		storage.createSearchableDocument({
			sourceTable: "notes",
			sourceId: "note-1",
			documentKind: "operator-note",
			title: "Bookmap checklist",
			bodyText: "Remember to export the DOM snapshot before shutdown.",
		});

		const results = storage.searchSearchableDocuments("kalman");

		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe(matching.id);
		expect(results[0]?.title).toBe("Kalman spread replay");
	});
});
