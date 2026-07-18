import { describe, expect, test } from "bun:test";
import { parseS3Xml, requireS3XmlElement } from "./s3-xml";

describe("S3 XML response guards", () => {
	test("returns a present ListBucketResult", () => {
		const parsed = parseS3Xml<{
			ListBucketResult?: { Name?: string };
		}>("<ListBucketResult><Name>bucket</Name></ListBucketResult>");
		expect(
			requireS3XmlElement(parsed.ListBucketResult, "ListBucketResult").Name,
		).toBe("bucket");
	});

	test("rejects an S3 error document in place of a list result", () => {
		const parsed = parseS3Xml<{ ListBucketResult?: object }>(
			"<Error><Code>SlowDown</Code></Error>",
		);
		expect(() =>
			requireS3XmlElement(parsed.ListBucketResult, "ListBucketResult"),
		).toThrow("Malformed S3 response: missing ListBucketResult");
	});

	test("rejects primitive elements", () => {
		expect(() =>
			requireS3XmlElement("bad" as unknown as object, "ListBucketResult"),
		).toThrow("Malformed S3 response: missing ListBucketResult");
	});
});
