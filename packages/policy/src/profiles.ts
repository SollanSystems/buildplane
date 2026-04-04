import type { PolicyProfile } from "@buildplane/kernel";

export interface ProfileRegistry {
	resolve(name: string): PolicyProfile;
}

const DEFAULT_PROFILE: PolicyProfile = {
	name: "default",
};

/**
 * Create a profile registry from a list of named profiles.
 *
 * Always includes a "default" profile with no constraints.
 * If a custom "default" is provided, it overrides the built-in one.
 * Throws on resolve() with an unknown profile name.
 */
export function createProfileRegistry(
	profiles?: readonly PolicyProfile[],
): ProfileRegistry {
	const map = new Map<string, PolicyProfile>();
	map.set("default", DEFAULT_PROFILE);

	if (profiles) {
		for (const profile of profiles) {
			map.set(profile.name, profile);
		}
	}

	return {
		resolve(name: string): PolicyProfile {
			const profile = map.get(name);
			if (!profile) {
				const available = Array.from(map.keys()).join(", ");
				throw new Error(
					`Unknown policy profile: "${name}". Available profiles: ${available}`,
				);
			}
			return profile;
		},
	};
}
