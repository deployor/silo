import { createHmac } from "node:crypto";

/** Shared Bun/Rust derivation contract for temporary read-only export keys. */
export function deriveOffboardingExportSecretWithKey(
	accessKey: string,
	derivationSecret: string,
) {
	return createHmac("sha256", derivationSecret)
		.update(`offboarding-export:${accessKey}`)
		.digest("hex");
}
