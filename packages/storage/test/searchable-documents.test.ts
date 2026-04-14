import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("searchable document storage", () => {
	it("stores and lists searchable documents for the current repo", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-searchable-documents-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const document = storage.createSearchableDocument({
			documentKind: "run-summary",
			title: "Backtest replay summary",
			bodyText:
				"NQ replay showed mean reversion around VWAP and the Kalman spread.",
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
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-searchable-documents-"),
		);
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
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-searchable-documents-"),
		);
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

	it("retrieves ranked searchable documents with exact source and title matches ahead of full-text results", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-searchable-documents-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const exactSource = storage.createSearchableDocument({
			sourceTable: "runs",
			sourceId: "run-1",
			documentKind: "run-summary",
			title: "Build failure summary",
			bodyText: "The branch replay failed during typecheck.",
		});
		const exactTitle = storage.createSearchableDocument({
			sourceTable: "notes",
			sourceId: "note-9",
			documentKind: "operator-note",
			title: "Build failure summary",
			bodyText: "Operator note about the same branch replay.",
		});
		const fullTextOnly = storage.createSearchableDocument({
			sourceTable: "notes",
			sourceId: "note-2",
			documentKind: "operator-note",
			title: "Checklist",
			bodyText: "Capture the branch replay logs before cleanup.",
		});

		const results = storage.retrieveSearchableDocuments({
			title: "Build failure summary",
			sourceTable: "runs",
			sourceId: "run-1",
			searchText: "branch",
			limit: 10,
		});

		expect(results.map((result) => result.item.id)).toEqual([
			exactSource.id,
			exactTitle.id,
			fullTextOnly.id,
		]);
		expect(results.map((result) => result.reason)).toEqual([
			"exact-source",
			"exact-title",
			"full-text-document",
		]);
		expect(new Set(results.map((result) => result.item.id)).size).toBe(
			results.length,
		);
	});

	it("accepts slash-containing full-text queries without throwing", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-searchable-documents-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const matching = storage.createSearchableDocument({
			sourceTable: "notes",
			sourceId: "note-7",
			documentKind: "operator-note",
			title: "Changed file note",
			bodyText: "Investigate apps/cli/src/run-cli.ts before changing imports.",
		});

		const results = storage.retrieveSearchableDocuments({
			searchText: "apps/cli/src/run-cli.ts",
			limit: 10,
		});

		expect(results.map((result) => result.item.id)).toContain(matching.id);
		expect(results.map((result) => result.reason)).toContain(
			"full-text-document",
		);
	});
});
