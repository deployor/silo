import { XMLParser } from "fast-xml-parser";

const s3XmlOptions = {
	processEntities: false,
};

export function createS3XmlParser(options: Record<string, unknown> = {}) {
	return new XMLParser({
		...s3XmlOptions,
		...options,
	});
}

export const s3XmlParser = createS3XmlParser();

export function parseS3Xml<T = Record<string, unknown>>(xml: string): T {
	return s3XmlParser.parse(xml) as T;
}

/** Rejects malformed/incorrect 2xx S3 payloads before callers dereference. */
export function requireS3XmlElement<T extends object>(
	value: T | null | undefined,
	elementName: string,
): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Malformed S3 response: missing ${elementName}`);
	}
	return value;
}
