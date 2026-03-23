import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const ROOT_README_PATH = join(REPO_ROOT, "README.md");
const DISTRIBUTION_HEADING = "## Distribution";
const OMITTED_SECTION_HEADINGS = new Set([
	"## Status",
	"## Getting started (repo development)",
	"## In-repo built CLI path",
	"## Local run loop",
]);
const REPO_ONLY_SECTION_PATTERNS = Object.freeze([
	/\bpnpm buildplane\b/i,
	/\bpnpm install\b/i,
	/\bpnpm build\b/i,
	/\btsx\b/i,
	/node apps\/cli\/dist\/index\.js/i,
	/^##\s+Status\b|\bMilestone\s+\d+\b/im,
]);
const PUBLISHED_DISTRIBUTION_BODY = [
	"Install Buildplane with npm, then use the published CLI directly:",
	"",
	"```bash",
	"npm install -g buildplane",
	"buildplane init",
	"buildplane run --packet /absolute/path/to/packet.json",
	"buildplane status --json",
	"buildplane inspect <run-id> --json",
	"```",
	"",
	"> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.",
].join("\n");

function readRootReadme() {
	return readFileSync(ROOT_README_PATH, "utf8");
}

function trimTrailingBlankLines(text) {
	return text.replace(/\s+$/, "").trimEnd();
}

function splitReadmeSections(sourceReadme) {
	const headingMatches = [...sourceReadme.matchAll(/^## .+$/gm)];
	if (headingMatches.length === 0) {
		return {
			preamble: trimTrailingBlankLines(sourceReadme),
			sections: [],
		};
	}

	const firstSectionStart = headingMatches[0].index ?? sourceReadme.length;
	const sections = headingMatches.map((match, index) => {
		const sectionStart = match.index ?? 0;
		const sectionEnd = headingMatches[index + 1]?.index ?? sourceReadme.length;
		const sectionText = trimTrailingBlankLines(
			sourceReadme.slice(sectionStart, sectionEnd),
		);
		const heading = match[0];
		const body = trimTrailingBlankLines(
			sectionText.slice(heading.length).replace(/^\r?\n/, ""),
		);

		return {
			body,
			heading,
		};
	});

	return {
		preamble: trimTrailingBlankLines(sourceReadme.slice(0, firstSectionStart)),
		sections,
	};
}

function shouldOmitSection(section) {
	if (OMITTED_SECTION_HEADINGS.has(section.heading)) {
		return true;
	}

	const sectionText = `${section.heading}\n\n${section.body}`;
	return REPO_ONLY_SECTION_PATTERNS.some((pattern) =>
		pattern.test(sectionText),
	);
}

function serializeSection(section) {
	return section.body
		? `${section.heading}\n\n${section.body}`
		: section.heading;
}

function serializeReadme(preamble, sections) {
	return `${[preamble, ...sections.map(serializeSection)]
		.filter(Boolean)
		.map(trimTrailingBlankLines)
		.join("\n\n")
		.trimEnd()}\n`;
}

export function derivePublishedReadme(sourceReadme = readRootReadme()) {
	const { preamble, sections } = splitReadmeSections(sourceReadme);
	const publishedSections = [];
	let replacedDistribution = false;

	for (const section of sections) {
		if (shouldOmitSection(section)) {
			continue;
		}

		if (section.heading === DISTRIBUTION_HEADING) {
			publishedSections.push({
				body: PUBLISHED_DISTRIBUTION_BODY,
				heading: DISTRIBUTION_HEADING,
			});
			replacedDistribution = true;
			continue;
		}

		publishedSections.push(section);
	}

	if (!replacedDistribution) {
		publishedSections.push({
			body: PUBLISHED_DISTRIBUTION_BODY,
			heading: DISTRIBUTION_HEADING,
		});
	}

	return serializeReadme(preamble, publishedSections);
}
