import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const INDEX_TS = "src/index.ts";
const INDEX_DTS = "src/index.d.ts";

const RE_EXPORT_CLAUSE =
	/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"\s*;/g;
const RELATIVE_RE_EXPORT = /from\s*"\.\//g;

function normalizeSpecifier(specifier: string): string {
	return specifier.replace(/\.(?:ts|js)$/, "");
}

function parseClauseNames(clause: string): string[] {
	return clause
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => entry.replace(/^type\s+/, ""))
		.map((entry) => {
			const segments = entry.split(/\s+as\s+/);
			return segments[segments.length - 1].trim();
		});
}

interface ParsedReExports {
	readonly byModule: ReadonlyMap<string, ReadonlySet<string>>;
	readonly clauseCount: number;
	readonly relativeReExportCount: number;
}

function parseReExports(source: string): ParsedReExports {
	const byModule = new Map<string, Set<string>>();
	let clauseCount = 0;

	for (const match of source.matchAll(RE_EXPORT_CLAUSE)) {
		clauseCount += 1;
		const specifier = normalizeSpecifier(match[2]);
		const names = byModule.get(specifier) ?? new Set<string>();
		for (const name of parseClauseNames(match[1])) {
			names.add(name);
		}
		byModule.set(specifier, names);
	}

	return {
		byModule,
		clauseCount,
		relativeReExportCount: source.match(RELATIVE_RE_EXPORT)?.length ?? 0,
	};
}

function readParsed(relativePath: string): ParsedReExports {
	const fileName = relativePath.slice("src/".length);
	return parseReExports(readFileSync(resolve(srcDir, fileName), "utf8"));
}

function sortedNames(names: ReadonlySet<string>): string[] {
	return [...names].sort();
}

function difference(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): string[] {
	return sortedNames(left).filter((name) => !right.has(name));
}

describe("kernel index.ts vs hand-maintained index.d.ts", () => {
	const implementation = readParsed(INDEX_TS);
	const declaration = readParsed(INDEX_DTS);

	it("parses every relative re-export statement in both files", () => {
		// Non-vacuity guard: if a re-export form slips past the clause regex
		// (for example `export * from`), the drift assertions below would pass
		// by simply not seeing the drifting statement.
		expect({
			file: INDEX_TS,
			parsed: implementation.clauseCount,
			relative: implementation.relativeReExportCount,
		}).toEqual({
			file: INDEX_TS,
			parsed: implementation.relativeReExportCount,
			relative: implementation.relativeReExportCount,
		});
		expect({
			file: INDEX_DTS,
			parsed: declaration.clauseCount,
			relative: declaration.relativeReExportCount,
		}).toEqual({
			file: INDEX_DTS,
			parsed: declaration.relativeReExportCount,
			relative: declaration.relativeReExportCount,
		});
		expect(implementation.byModule.size).toBeGreaterThan(20);
		expect(declaration.byModule.size).toBeGreaterThan(20);
	});

	it("re-exports the same set of module specifiers", () => {
		const inImplementation = new Set(implementation.byModule.keys());
		const inDeclaration = new Set(declaration.byModule.keys());

		const drift = [
			...difference(inImplementation, inDeclaration).map(
				(specifier) =>
					`${specifier}: re-exported by ${INDEX_TS}, absent from ${INDEX_DTS}`,
			),
			...difference(inDeclaration, inImplementation).map(
				(specifier) =>
					`${specifier}: re-exported by ${INDEX_DTS}, absent from ${INDEX_TS}`,
			),
		];

		expect(drift).toEqual([]);
	});

	it("re-exports the same names from every shared module", () => {
		const drift: string[] = [];

		for (const [specifier, implementationNames] of implementation.byModule) {
			const declarationNames = declaration.byModule.get(specifier);
			if (declarationNames === undefined) {
				continue;
			}

			for (const name of difference(implementationNames, declarationNames)) {
				drift.push(`${specifier}: ${name} missing from ${INDEX_DTS}`);
			}
			for (const name of difference(declarationNames, implementationNames)) {
				drift.push(`${specifier}: ${name} missing from ${INDEX_TS}`);
			}
		}

		expect(drift).toEqual([]);
	});
});
