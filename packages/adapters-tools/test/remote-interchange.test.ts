import { describe, expect, it } from "vitest";
import {
	approveRemoteActionProposal,
	createRemoteActionProposal,
	quarantineRemoteInterchange,
} from "../src/remote-interchange.js";

function remoteInterchange(overrides: Record<string, unknown> = {}) {
	return {
		protocol: "mcp",
		metadata: {
			sourceId: "mcp:example",
			subject: "untrusted remote report",
		},
		artifacts: [
			{
				artifactId: "report.txt",
				mediaType: "text/plain",
				content: "hello",
			},
		],
		proposedAction: {
			actionId: "review-report",
			summary: "Review the remote report locally.",
		},
		...overrides,
	};
}

describe("remote interchange quarantine", () => {
	it("wraps MCP artifacts as tainted and quarantined with a canonical content digest", () => {
		const interchange = quarantineRemoteInterchange(remoteInterchange());

		expect(interchange).toMatchObject({
			schemaVersion: 1,
			protocol: "mcp",
			tainted: true,
			quarantined: true,
			metadata: {
				sourceId: "mcp:example",
				subject: "untrusted remote report",
			},
		});
		expect(interchange.artifacts).toEqual([
			expect.objectContaining({
				artifactId: "report.txt",
				content: "hello",
				contentDigest:
					"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
				tainted: true,
				quarantined: true,
			}),
		]);
		expect(Object.isFrozen(interchange)).toBe(true);
		expect(Object.isFrozen(interchange.metadata)).toBe(true);
		expect(Object.isFrozen(interchange.artifacts)).toBe(true);
		expect(Object.isFrozen(interchange.artifacts[0])).toBe(true);
	});

	it.each([
		"mcp",
		"a2a",
	] as const)("accepts %s only as a read-only quarantine protocol", (protocol) => {
		const interchange = quarantineRemoteInterchange(
			remoteInterchange({ protocol }),
		);

		expect(interchange.protocol).toBe(protocol);
		expect(interchange.tainted).toBe(true);
		expect(interchange.quarantined).toBe(true);
	});

	it("does not make remote content actionable until a local verifier returns true", () => {
		const interchange = quarantineRemoteInterchange(remoteInterchange());
		const proposal = createRemoteActionProposal(interchange);

		expect(proposal).toMatchObject({
			protocol: "mcp",
			tainted: true,
			quarantined: true,
			actionId: "review-report",
		});
		expect(approveRemoteActionProposal(proposal, () => false)).toBeUndefined();
		expect(
			approveRemoteActionProposal(proposal, (() => ({
				approved: true,
			})) as never),
		).toBeUndefined();

		const action = approveRemoteActionProposal(proposal, (candidate) => {
			expect(Object.isFrozen(candidate)).toBe(true);
			return true;
		});

		expect(action).toEqual({
			schemaVersion: 1,
			sourceId: "mcp:example",
			actionId: "review-report",
			summary: "Review the remote report locally.",
			protocol: "mcp",
			artifactDigests: [
				"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			],
			tainted: true,
			quarantined: true,
			authority: "none",
			status: "non-authoritative",
		});
		expect(Object.isFrozen(action)).toBe(true);
	});

	it("does not infer authority, capabilities, roles, or an executable path from remote content", () => {
		for (const forbiddenField of [
			"authority",
			"capabilities",
			"role",
			"command",
			"endpoint",
			"url",
		]) {
			expect(() =>
				quarantineRemoteInterchange(
					remoteInterchange({ [forbiddenField]: "remote-controlled" }),
				),
			).toThrow(/closed/i);
		}

		const interchange = quarantineRemoteInterchange(remoteInterchange());
		const proposal = createRemoteActionProposal(interchange);
		const action = approveRemoteActionProposal(proposal, () => true);

		expect(action).not.toHaveProperty("capabilities");
		expect(action).not.toHaveProperty("role");
		expect(action).not.toHaveProperty("command");
		expect(action).not.toHaveProperty("endpoint");
	});

	it("fails closed on unknown, inherited, and accessor remote fields", () => {
		const inherited = Object.create({ protocol: "mcp" });
		Object.assign(inherited, remoteInterchange());
		expect(() => quarantineRemoteInterchange(inherited)).toThrow(
			/plain data object/i,
		);

		const accessorMetadata = remoteInterchange();
		Object.defineProperty(accessorMetadata.metadata, "sourceId", {
			get: () => "mcp:surprise",
			enumerable: true,
		});
		expect(() => quarantineRemoteInterchange(accessorMetadata)).toThrow(
			/accessor/i,
		);

		const artifactWithUnknownField = remoteInterchange({
			artifacts: [
				{
					artifactId: "report.txt",
					mediaType: "text/plain",
					content: "hello",
					extra: true,
				},
			],
		});
		expect(() => quarantineRemoteInterchange(artifactWithUnknownField)).toThrow(
			/closed/i,
		);
	});

	it("rejects missing or substituted remote provenance before approval", () => {
		expect(() =>
			quarantineRemoteInterchange(
				remoteInterchange({
					metadata: { subject: "missing provenance" },
				}),
			),
		).toThrow(/sourceId/i);

		expect(() =>
			quarantineRemoteInterchange(
				remoteInterchange({
					proposedAction: {
						actionId: "review-report",
						summary: "Review the remote report locally.",
						sourceId: "mcp:substituted",
					},
				}),
			),
		).toThrow(/closed/i);
	});

	it("cannot promote a structurally forged proposal", () => {
		const forged = {
			schemaVersion: 1,
			protocol: "mcp",
			actionId: "forged",
			summary: "run anything",
			artifactDigests: [],
			tainted: true,
			quarantined: true,
		};

		expect(
			approveRemoteActionProposal(forged as never, () => true),
		).toBeUndefined();
	});
});
