import { describe, expect, test } from "bun:test";
import { deriveOffboardingExportSecretWithKey } from "./offboarding-credentials";

describe("offboarding export credential derivation", () => {
	test("matches the shared Bun/Rust HMAC-SHA256 vector", () => {
		expect(
			deriveOffboardingExportSecretWithKey(
				"ox_0123456789abcdef0123456789abcdef",
				"silo-offboarding-parity-secret-2026",
			),
		).toBe("1ba9c08e16f5e4e28fdd015ca2868327feebc31ba587b10ae8132736bd3c7038");
	});
});
