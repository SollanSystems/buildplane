// Kept as a compatibility import path for CLI integrations. The implementation
// lives in the kernel because authority-window ordering is an effect boundary,
// not a renderer or CLI concern.
export type { NativeRfc3339UtcTimestamp } from "@buildplane/kernel";
export {
	addNativeRfc3339UtcMilliseconds,
	isNativeRfc3339Utc,
	parseNativeRfc3339Utc,
} from "@buildplane/kernel";
