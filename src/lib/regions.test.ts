import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STORAGE_REGION_ID,
	isRequestedBucketRegion,
	normalizeRequestedRegion,
	normalizeStorageRegion,
	resolveRequestedRegion,
} from "./regions";

describe("storage regions", () => {
	test("automatic placement resolves once to the EU default", () => {
		expect(resolveRequestedRegion("auto")).toBe(DEFAULT_STORAGE_REGION_ID);
	});

	test("explicit supported placement remains stable", () => {
		expect(resolveRequestedRegion("us-east")).toBe("us-east");
	});

	test("rejects unknown requested regions", () => {
		expect(isRequestedBucketRegion("moon-1")).toBe(false);
		expect(normalizeRequestedRegion("moon-1")).toBe("auto");
		expect(normalizeStorageRegion("moon-1")).toBe("eu-central");
	});
});
