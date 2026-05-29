import { XMLBuilder, XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
	ignoreAttributes: false,
	parseTagValue: false,
});

const builder = new XMLBuilder({
	ignoreAttributes: false,
	format: false,
});

export function rewriteListObjectsResponse(
	xmlBody: string,
	internalPrefix: string,
): string {
	if (!xmlBody) return xmlBody;

	try {
		const parsed = parser.parse(xmlBody);

		if (parsed.ListBucketResult) {
			const result = parsed.ListBucketResult;

			const stripPrefix = (str: string) => {
				if (typeof str === "string" && str.startsWith(internalPrefix)) {
					return str.slice(internalPrefix.length);
				}
				return str;
			};

			for (const field of [
				"Prefix",
				"Marker",
				"NextMarker",
				"StartAfter",
				"ContinuationToken",
				"NextContinuationToken",
			] as const) {
				if (result[field]) result[field] = stripPrefix(result[field]);
			}

			if (result.Contents) {
				const contents = Array.isArray(result.Contents)
					? result.Contents
					: [result.Contents];

				for (const contentItem of contents) {
					if (contentItem.Key) {
						contentItem.Key = stripPrefix(contentItem.Key);
					}
				}
			}

			if (result.CommonPrefixes) {
				const commonPrefixes = Array.isArray(result.CommonPrefixes)
					? result.CommonPrefixes
					: [result.CommonPrefixes];

				for (const prefixItem of commonPrefixes) {
					if (prefixItem.Prefix) {
						prefixItem.Prefix = stripPrefix(prefixItem.Prefix);
					}
				}
			}
		}

		return builder.build(parsed);
	} catch (error) {
		console.error("Error rewriting XML response:", error);
		return xmlBody;
	}
}

export function rewriteDeleteObjectsResponse(
	xmlBody: string,
	internalPrefix: string,
): string {
	if (!xmlBody) return xmlBody;

	try {
		const parsed = parser.parse(xmlBody);

		if (parsed.DeleteResult) {
			const result = parsed.DeleteResult;

			const stripPrefix = (str: string) => {
				if (typeof str === "string" && str.startsWith(internalPrefix)) {
					return str.slice(internalPrefix.length);
				}
				return str;
			};

			if (result.Deleted) {
				const deleted = Array.isArray(result.Deleted)
					? result.Deleted
					: [result.Deleted];
				for (const deletedItem of deleted) {
					if (deletedItem.Key) {
						deletedItem.Key = stripPrefix(deletedItem.Key);
					}
				}
			}

			if (result.Error) {
				const errors = Array.isArray(result.Error)
					? result.Error
					: [result.Error];
				for (const errorItem of errors) {
					if (errorItem.Key) {
						errorItem.Key = stripPrefix(errorItem.Key);
					}
				}
			}
		}

		return builder.build(parsed);
	} catch (error) {
		console.error("Error rewriting DeleteObjects XML response:", error);
		return xmlBody;
	}
}

export function rewriteMultipartUploadResponse(
	xmlBody: string,
	internalPrefix: string,
): string {
	if (!xmlBody) return xmlBody;

	try {
		const parsed = parser.parse(xmlBody);

		const stripPrefix = (str: string) => {
			if (typeof str === "string" && str.startsWith(internalPrefix)) {
				return str.slice(internalPrefix.length);
			}
			return str;
		};

		if (parsed.InitiateMultipartUploadResult) {
			const result = parsed.InitiateMultipartUploadResult;
			if (result.Key) {
				result.Key = stripPrefix(result.Key);
			}
		}

		if (parsed.CompleteMultipartUploadResult) {
			const result = parsed.CompleteMultipartUploadResult;
			if (result.Key) {
				result.Key = stripPrefix(result.Key);
			}
		}

		if (parsed.ListMultipartUploadsResult) {
			const result = parsed.ListMultipartUploadsResult;
			if (result.KeyMarker) {
				result.KeyMarker = stripPrefix(result.KeyMarker);
			}
			if (result.Prefix) {
				result.Prefix = stripPrefix(result.Prefix);
			}

			if (result.Upload) {
				const uploads = Array.isArray(result.Upload)
					? result.Upload
					: [result.Upload];
				for (const upload of uploads) {
					if (upload.Key) {
						upload.Key = stripPrefix(upload.Key);
					}
				}
			}

			if (result.CommonPrefixes) {
				const commonPrefixes = Array.isArray(result.CommonPrefixes)
					? result.CommonPrefixes
					: [result.CommonPrefixes];
				for (const prefixItem of commonPrefixes) {
					if (prefixItem.Prefix) {
						prefixItem.Prefix = stripPrefix(prefixItem.Prefix);
					}
				}
			}
		}

		if (parsed.ListPartsResult) {
			const result = parsed.ListPartsResult;
			if (result.Key) {
				result.Key = stripPrefix(result.Key);
			}
		}

		return builder.build(parsed);
	} catch (error) {
		console.error("Error rewriting MultipartUpload XML response:", error);
		return xmlBody;
	}
}
