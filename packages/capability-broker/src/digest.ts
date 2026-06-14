import { digest } from "@buildplane/planforge";
import type { CapabilityBundleV0 } from "./schema.js";

export function bundleDigest(bundle: CapabilityBundleV0): string {
	return digest(bundle);
}
