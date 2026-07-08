import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import {
	segmentGlobIsSubset,
	segmentGlobMatches,
} from "../src/segment-glob.js";

/** The enforcement reference: broker evaluate.ts uses exactly these options. */
function referenceMatch(path: string, pattern: string): boolean {
	return minimatch(path, pattern, { dot: true, matchBase: false });
}

describe("segmentGlobMatches — minimatch-equivalent for the shipped vocabulary", () => {
	it("matches the M6-S4 code-edit vocabulary the way the broker does", () => {
		expect(segmentGlobMatches("src/kernel/loop.ts", "src/**")).toBe(true);
		expect(
			segmentGlobMatches(
				"packages/kernel/src/orchestrator.ts",
				"packages/**/src/**",
			),
		).toBe(true);
		expect(
			segmentGlobMatches(
				"native/crates/bp-ledger/src/kind.rs",
				"native/crates/**/src/**",
			),
		).toBe(true);
		expect(
			segmentGlobMatches(
				"packages/kernel/test/loop.test.ts",
				"packages/**/src/**",
			),
		).toBe(false);
	});

	it("treats ** as zero-or-more segments (minimatch globstar)", () => {
		expect(segmentGlobMatches("a/b", "a/**/b")).toBe(true);
		expect(segmentGlobMatches("a/x/b", "a/**/b")).toBe(true);
		expect(segmentGlobMatches("a/x/y/b", "a/**/b")).toBe(true);
		expect(segmentGlobMatches("a/b/c", "a/**/b")).toBe(false);
	});

	it("does not match the bare prefix directory itself for trailing /**", () => {
		expect(segmentGlobMatches("src", "src/**")).toBe(false);
	});

	it("keeps single * within one segment", () => {
		expect(segmentGlobMatches("docs/readme.md", "docs/*.md")).toBe(true);
		expect(segmentGlobMatches("docs/sub/readme.md", "docs/*.md")).toBe(false);
	});

	it("agrees with real minimatch across an enumerated pattern/path space", () => {
		const segments = ["a", "b", "**", "*", "a*"];
		const pathSegments = ["a", "b", "c", "ab"];
		const patterns: string[] = [];
		for (const s1 of segments) {
			patterns.push(s1);
			for (const s2 of segments) {
				patterns.push(`${s1}/${s2}`);
				for (const s3 of segments) {
					patterns.push(`${s1}/${s2}/${s3}`);
				}
			}
		}
		const paths: string[] = [];
		for (const p1 of pathSegments) {
			paths.push(p1);
			for (const p2 of pathSegments) {
				paths.push(`${p1}/${p2}`);
				for (const p3 of pathSegments) {
					paths.push(`${p1}/${p2}/${p3}`);
					for (const p4 of pathSegments) {
						paths.push(`${p1}/${p2}/${p3}/${p4}`);
					}
				}
			}
		}
		const disagreements: string[] = [];
		for (const pattern of patterns) {
			for (const path of paths) {
				const ours = segmentGlobMatches(path, pattern);
				const reference = referenceMatch(path, pattern);
				if (ours !== reference) {
					disagreements.push(
						`path=${path} pattern=${pattern} ours=${ours} minimatch=${reference}`,
					);
				}
			}
		}
		expect(disagreements).toEqual([]);
	});
});

describe("segmentGlobIsSubset — language inclusion under the same semantics", () => {
	it("covers a concrete proposal under a middle-wildcard envelope glob", () => {
		expect(
			segmentGlobIsSubset("packages/kernel/src/**", "packages/**/src/**"),
		).toBe(true);
		expect(
			segmentGlobIsSubset("packages/kernel/test/**", "packages/**/src/**"),
		).toBe(false);
	});

	it("keeps exact-equal and universal-parent coverage", () => {
		expect(segmentGlobIsSubset("src/**", "src/**")).toBe(true);
		expect(segmentGlobIsSubset("anything/at/all/**", "**")).toBe(true);
	});

	it("covers a narrower double-wildcard child", () => {
		// every path of packages/<**>/src/lib/<**> is a path of packages/<**>/src/<**>
		expect(
			segmentGlobIsSubset("packages/**/src/lib/**", "packages/**/src/**"),
		).toBe(true);
	});

	it("rejects a child wildcard broader than the parent", () => {
		// child matches packages/x/main.ts which escapes packages/**/src/**
		expect(segmentGlobIsSubset("packages/**", "packages/**/src/**")).toBe(
			false,
		);
		expect(segmentGlobIsSubset("**", "packages/**")).toBe(false);
	});

	it("zero-segment globstar: packages/**/src/** covers packages/src/**", () => {
		// minimatch globstar matches zero segments, so the parent's language
		// includes packages/src/<...> — the child is a subset.
		expect(segmentGlobIsSubset("packages/src/**", "packages/**/src/**")).toBe(
			true,
		);
	});

	it("covers literal file children under wildcard parents", () => {
		expect(
			segmentGlobIsSubset(
				"packages/policy/src/segment-glob.ts",
				"packages/**/src/**",
			),
		).toBe(true);
		expect(
			segmentGlobIsSubset("packages/policy/readme.md", "packages/**/src/**"),
		).toBe(false);
	});

	it("is conservative for single-star segments (exact equality only)", () => {
		expect(segmentGlobIsSubset("docs/*.md", "docs/*.md")).toBe(true);
		// a/*.md ⊆ a/** is genuinely true, but * segments only participate via
		// exact equality unless the parent covers them with a globstar.
		expect(segmentGlobIsSubset("docs/*.md", "docs/**")).toBe(true);
		expect(segmentGlobIsSubset("docs/**", "docs/*.md")).toBe(false);
	});

	it("fails closed on traversal/absolute inputs", () => {
		expect(segmentGlobIsSubset("../x/**", "**")).toBe(false);
		expect(segmentGlobIsSubset("/etc/**", "**")).toBe(false);
		expect(segmentGlobIsSubset("src/**", "../src/**")).toBe(false);
	});

	it("fails closed on bare/interior/trailing dot and dot-dot segments (never admits them)", () => {
		// Adversarial finding 2026-07-08: a `.`/`..` segment survived the old
		// normalization and was treated as an ordinary literal a `*`/`**` parent
		// accepts, so a traversal-looking proposal auto-admitted without pause.
		// minimatch (the enforcement matcher) self-matches these as literals but
		// refuses them under any wildcard, so admitting them over-admits.
		expect(segmentGlobIsSubset("..", "**")).toBe(false);
		expect(segmentGlobIsSubset(".", "**")).toBe(false);
		expect(segmentGlobIsSubset("..", "*")).toBe(false);
		expect(segmentGlobIsSubset("src/.", "src/**")).toBe(false);
		expect(
			segmentGlobIsSubset("packages/kernel/src/.", "packages/**/src/**"),
		).toBe(false);
		expect(segmentGlobIsSubset("a/./b", "a/*/b")).toBe(false);
		expect(segmentGlobIsSubset("a/b/.", "a/b/*")).toBe(false);
	});

	it("does not strip a leading ./ into a broader glob (minimatch keeps it literal)", () => {
		// The enforcement matcher does NOT strip `./`: `minimatch(p, "./src/**")`
		// matches nothing. Stripping it at admission would admit `src/**`-broad
		// coverage the broker never grants — so a `./`-prefixed glob fails closed.
		expect(segmentGlobIsSubset("src/**", "./src/**")).toBe(false);
		expect(segmentGlobIsSubset("**", "./**")).toBe(false);
		expect(segmentGlobMatches("src/x.ts", "./src/**")).toBe(false);
	});

	it("never over-admits: brute-force verification against real minimatch (enforcement truth)", () => {
		// Soundness gate: whenever segmentGlobIsSubset(c, p) says true, every
		// enumerated path matched by c under REAL minimatch (the broker's
		// enforcement matcher) must also be matched by p under real minimatch —
		// not just under our own matcher. Using minimatch on BOTH sides is what
		// makes this an enforcement-truth test rather than a self-consistency
		// test (a 2026-07-08 adversarial review found the self-consistency
		// framing hid a `.`/`..`/`./` over-admission). The alphabets include the
		// degenerate segments that surfaced the bug (`.`, `..`, `./`, `*`) plus a
		// path segment ("c") that appears in no pattern.
		const patternSegs = ["a", "b", "**", "*", ".", ".."];
		const patterns: string[] = ["./a/**", "./**", "a/./b"];
		for (const s1 of patternSegs) {
			patterns.push(s1);
			for (const s2 of patternSegs) {
				patterns.push(`${s1}/${s2}`);
				for (const s3 of patternSegs) {
					patterns.push(`${s1}/${s2}/${s3}`);
				}
			}
		}
		const pathSegs = ["a", "b", "c", ".", ".."];
		const paths: string[] = [];
		let frontier: string[] = [""];
		for (let depth = 0; depth < 4; depth++) {
			const next: string[] = [];
			for (const base of frontier) {
				for (const seg of pathSegs) {
					const path = base === "" ? seg : `${base}/${seg}`;
					paths.push(path);
					next.push(path);
				}
			}
			frontier = next;
		}
		const violations: string[] = [];
		for (const child of patterns) {
			for (const parent of patterns) {
				if (!segmentGlobIsSubset(child, parent)) {
					continue;
				}
				for (const path of paths) {
					if (referenceMatch(path, child) && !referenceMatch(path, parent)) {
						violations.push(
							`child=${child} parent=${parent} escaped path=${path}`,
						);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
