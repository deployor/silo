import { describe, expect, test } from "bun:test";
import { type DatabaseProbe, promotionEligible } from "./database-ha";

const replica: DatabaseProbe = {
	region: "us-east",
	reachable: true,
	role: "replica",
	inRecovery: true,
	walLsn: "0/200",
	receiveLsn: "0/200",
	replayLsn: "0/200",
	replayAgeSeconds: 1,
	generation: 4,
	activeRegion: "eu-central",
	replication: [],
};

describe("database promotion gate", () => {
	test("allows only a current, fully replayed, fresh replica", () => {
		expect(promotionEligible(replica, 4)).toBe(true);
	});

	test("rejects stale, divergent, unreachable, and wrong-generation replicas", () => {
		expect(promotionEligible({ ...replica, replayAgeSeconds: 16 }, 4)).toBe(
			false,
		);
		expect(promotionEligible({ ...replica, receiveLsn: "0/201" }, 4)).toBe(
			false,
		);
		expect(promotionEligible({ ...replica, reachable: false }, 4)).toBe(false);
		expect(promotionEligible(replica, 5)).toBe(false);
		expect(promotionEligible({ ...replica, role: "primary" }, 4)).toBe(false);
	});
});
