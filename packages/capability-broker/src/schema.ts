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
	tools?: CapabilityBundleToolsV0;
}
