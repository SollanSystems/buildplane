import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../src/profiles";

describe("profile registry", () => {
	it("resolves the built-in default profile with no budgets", () => {
		const registry = createProfileRegistry();
		const profile = registry.resolve("default");

		expect(profile.name).toBe("default");
		expect(profile.budgets).toBeUndefined();
	});

	it("resolves a custom profile by name", () => {
		const registry = createProfileRegistry([
			{ name: "strict", budgets: { maxTokens: 100 } },
		]);

		const profile = registry.resolve("strict");
		expect(profile.name).toBe("strict");
		expect(profile.budgets?.maxTokens).toBe(100);
	});

	it("allows overriding the default profile", () => {
		const registry = createProfileRegistry([
			{ name: "default", budgets: { maxTokens: 500 } },
		]);

		const profile = registry.resolve("default");
		expect(profile.name).toBe("default");
		expect(profile.budgets?.maxTokens).toBe(500);
	});

	it("throws on unknown profile name with available list", () => {
		const registry = createProfileRegistry([
			{ name: "strict", budgets: { maxTokens: 100 } },
		]);

		expect(() => registry.resolve("nonexistent")).toThrow(
			/Unknown policy profile: "nonexistent"/,
		);
		expect(() => registry.resolve("nonexistent")).toThrow(/default, strict/);
	});

	it("resolves multiple custom profiles", () => {
		const registry = createProfileRegistry([
			{ name: "strict", budgets: { maxTokens: 50 } },
			{ name: "relaxed", budgets: { maxTokens: 10000 } },
			{ name: "timed", budgets: { maxComputeTimeMs: 30000 } },
		]);

		expect(registry.resolve("strict").budgets?.maxTokens).toBe(50);
		expect(registry.resolve("relaxed").budgets?.maxTokens).toBe(10000);
		expect(registry.resolve("timed").budgets?.maxComputeTimeMs).toBe(30000);
		expect(registry.resolve("default").budgets).toBeUndefined();
	});
});
