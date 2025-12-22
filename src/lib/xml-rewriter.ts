import { XMLBuilder, XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
	ignoreAttributes: false,
	parseTagValue: false,
});

const builder = new XMLBuilder({
	ignoreAttributes: false,
	format: false,
});

export function rewriteListObjectsV2Response(
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

			if (result.Prefix) {
				result.Prefix = stripPrefix(result.Prefix);
			}
			if (result.StartAfter) {
				result.StartAfter = stripPrefix(result.StartAfter);
			}

			if (result.Contents) {
				const contents = Array.isArray(result.Contents)
					? result.Contents
					: [result.Contents];

				for (const item of contents) {
					if (item.Key) {
						item.Key = stripPrefix(item.Key);
					}
				}
			}

			if (result.CommonPrefixes) {
				const commonPrefixes = Array.isArray(result.CommonPrefixes)
					? result.CommonPrefixes
					: [result.CommonPrefixes];

				for (const item of commonPrefixes) {
					if (item.Prefix) {
						item.Prefix = stripPrefix(item.Prefix);
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
				for (const item of deleted) {
					if (item.Key) {
						item.Key = stripPrefix(item.Key);
					}
				}
			}

			if (result.Error) {
				const errors = Array.isArray(result.Error)
					? result.Error
					: [result.Error];
				for (const item of errors) {
					if (item.Key) {
						item.Key = stripPrefix(item.Key);
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
				for (const item of commonPrefixes) {
					if (item.Prefix) {
						item.Prefix = stripPrefix(item.Prefix);
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
