export const CAPABILITY_BUNDLE_SCHEMA_VERSION =
	"buildplane.capability_bundle.v0" as const;

export type CapabilityBundleSchemaVersion =
	typeof CAPABILITY_BUNDLE_SCHEMA_VERSION;

export interface CapabilityBundleWriteFileToolV0 {
	enabled?: boolean;
}

export interface CapabilityBundleRunCommandToolV0 {
	allowlist?: string[];
}

export interface CapabilityBundleToolsV0 {
	write_file?: CapabilityBundleWriteFileToolV0;
	run_command?: CapabilityBundleRunCommandToolV0;
}

export interface CapabilityBundleV0 {
	schemaVersion: CapabilityBundleSchemaVersion;
	bundleId: string;
	fsRead?: string[];
	fsWrite?: string[];
	/**
	 * Declarative network-egress allowlist (host names). v0 is declarative-only:
	 * the field is parsed, validated, surfaced on the plan preview, and covered by
	 * the bundle digest — but NOT yet enforced at the worker boundary (no verified
	 * Claude Code subprocess network-restriction flag exists; see
	 * docs/architecture/capability-broker.md `net_egress`). An empty array is the
	 * explicit default-deny posture: "this bundle declares zero network egress".
	 */
	netEgress?: string[];
	tools?: CapabilityBundleToolsV0;
}
