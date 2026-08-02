import { describe, expect, test } from "bun:test";
import { classifyControlPlaneRoute, traceIdFromTraceparent } from "./telemetry";

describe("control-plane telemetry privacy contracts", () => {
	test("collapses bucket/object paths into a bounded S3 route", () => {
		expect(
			classifyControlPlaneRoute("/private-bucket/private/object.txt", false),
		).toBe("s3.misdirected");
	});

	test("collapses dynamic admin provider paths", () => {
		expect(
			classifyControlPlaneRoute(
				"/api/admin/storage/backends/eu-central/secret-provider/promote",
				true,
			),
		).toBe("/api/admin/storage/*");
	});

	test("accepts a valid W3C parent and rejects invalid identifiers", () => {
		expect(
			traceIdFromTraceparent(
				"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			),
		).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(
			traceIdFromTraceparent(
				"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
			),
		).toBeNull();
	});
});
