import { XMLParser } from "fast-xml-parser";

const s3XmlOptions = {
	processEntities: true,
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
