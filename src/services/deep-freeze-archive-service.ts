import crypto from "node:crypto";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { compress, decompress } from "@mongodb-js/zstd";
import tar from "tar-stream";
import { config } from "../config";
import type { buckets, users } from "../db/schema";
import { executeDataplaneStorage } from "../lib/dataplane-storage-client";
import { getInternalPath } from "../lib/s3/paths";
import { parseS3Xml, requireS3XmlElement } from "../lib/s3-xml";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
type BucketRecord = typeof buckets.$inferSelect;
type UserRecord = typeof users.$inferSelect;

type S3ListBucketResult = {
	Contents?:
		| { Key: string; Size: number }
		| Array<{ Key: string; Size: number }>;
	NextContinuationToken?: string;
};

export type DeepFreezeManifestEntry = {
	key: string;
	internalKey: string;
	size: number;
	etag: string | null;
	contentType: string | null;
	lastModified: string | null;
	checksumSha256: string;
};

export type DeepFreezeArchiveBuildResult = {
	archiveKey: string;
	manifestKey: string;
	archiveBytes: number;
	checksumSha256: string;
	totalBytes: number;
	totalObjects: number;
	manifest: DeepFreezeManifestEntry[];
};

function _toNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
	const reader = stream.getReader();
	return new Readable({
		async read() {
			try {
				const { done, value } = await reader.read();
				this.push(done ? null : Buffer.from(value));
			} catch (error) {
				this.destroy(error as Error);
			}
		},
	});
}

async function listBucketObjects(owner: UserRecord, bucket: BucketRecord) {
	const internalPrefix = getInternalPath("", owner, bucket);
	const entries: Array<{ key: string; internalKey: string; size: number }> = [];
	let continuationToken: string | undefined;

	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", internalPrefix);
		if (continuationToken) query.set("continuation-token", continuationToken);

		const listRes = await executeDataplaneStorage({
			bucket,
			rootPrefix: internalPrefix,
			pathWithQuery: `?${query.toString()}`,
			method: "GET",
		});
		if (!listRes.ok) {
			throw new Error(`Failed to list bucket contents (${listRes.status})`);
		}

		const xml = await listRes.text();
		const result = requireS3XmlElement(
			parseS3Xml<{ ListBucketResult?: S3ListBucketResult }>(xml)
				.ListBucketResult,
			"ListBucketResult",
		);
		const contents = result.Contents
			? Array.isArray(result.Contents)
				? result.Contents
				: [result.Contents]
			: [];

		for (const item of contents as Array<{ Key: string; Size: number }>) {
			entries.push({
				key: item.Key.replace(internalPrefix, ""),
				internalKey: item.Key,
				size: Number(item.Size) || 0,
			});
		}

		continuationToken = result.NextContinuationToken;
	} while (continuationToken);

	return entries;
}

async function fetchObjectBuffer(params: {
	owner: UserRecord;
	bucket: BucketRecord;
	internalKey: string;
}) {
	const response = await executeDataplaneStorage({
		bucket: params.bucket,
		rootPrefix: getInternalPath("", params.owner, params.bucket),
		pathWithQuery: params.internalKey,
		method: "GET",
	});
	if (!response.ok || !response.body) {
		throw new Error(
			`Failed to fetch object ${params.internalKey} (${response.status})`,
		);
	}
	const arrayBuffer = await new Response(response.body).arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	return {
		buffer,
		headers: response.headers,
	};
}

export async function buildDeepFreezeArchive(params: {
	owner: UserRecord;
	bucket: BucketRecord;
	archiveKey: string;
	manifestKey: string;
	onProgress?: (progress: {
		processedObjects: number;
		totalObjects: number;
		processedBytes: number;
		totalBytes: number;
	}) => Promise<void> | void;
}) {
	const objects = await listBucketObjects(params.owner, params.bucket);
	const totalBytes = objects.reduce((sum, item) => sum + item.size, 0);
	const pack = tar.pack();
	const chunks: Buffer[] = [];
	const manifest: DeepFreezeManifestEntry[] = [];
	let processedObjects = 0;
	let processedBytes = 0;

	pack.on("data", (chunk: Buffer) => chunks.push(chunk));

	for (const object of objects) {
		const { buffer, headers } = await fetchObjectBuffer({
			owner: params.owner,
			bucket: params.bucket,
			internalKey: object.internalKey,
		});
		const checksumSha256 = crypto
			.createHash("sha256")
			.update(buffer)
			.digest("hex");
		manifest.push({
			key: object.key,
			internalKey: object.internalKey,
			size: object.size,
			etag: headers.get("etag"),
			contentType: headers.get("content-type"),
			lastModified: headers.get("last-modified"),
			checksumSha256,
		});
		await new Promise<void>((resolve, reject) => {
			pack.entry(
				{ name: object.key, size: buffer.length },
				buffer,
				(error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				},
			);
		});
		processedObjects += 1;
		processedBytes += object.size;
		await params.onProgress?.({
			processedObjects,
			totalObjects: objects.length,
			processedBytes,
			totalBytes,
		});
	}

	await new Promise<void>((resolve, reject) => {
		pack.finalize();
		pack.on("end", () => resolve());
		pack.on("error", reject);
	});

	const tarBuffer = Buffer.concat(chunks);
	const compressedTar = Buffer.from(await compress(tarBuffer, 10));
	const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
	const compressedManifest = await gzipAsync(manifestBuffer);
	const checksumSha256 = crypto
		.createHash("sha256")
		.update(compressedTar)
		.digest("hex");

	const archiveUpload = await executeDataplaneStorage({
		bucket: params.bucket,
		rootPrefix: params.archiveKey,
		pathWithQuery: params.archiveKey,
		method: "PUT",
		body: compressedTar,
		headers: {
			"Content-Type": "application/zstd",
			"Content-Length": String(compressedTar.length),
			"x-amz-meta-deep-freeze-checksum": checksumSha256,
		},
	});
	if (!archiveUpload.ok) {
		throw new Error(
			`Failed to write Deep Freeze archive (${archiveUpload.status})`,
		);
	}

	const manifestUpload = await executeDataplaneStorage({
		bucket: params.bucket,
		rootPrefix: params.manifestKey,
		pathWithQuery: params.manifestKey,
		method: "PUT",
		body: compressedManifest,
		headers: {
			"Content-Type": "application/gzip",
			"Content-Length": String(compressedManifest.length),
		},
	});
	if (!manifestUpload.ok) {
		throw new Error(
			`Failed to write Deep Freeze manifest (${manifestUpload.status})`,
		);
	}

	return {
		archiveKey: params.archiveKey,
		manifestKey: params.manifestKey,
		archiveBytes: compressedTar.length,
		checksumSha256,
		totalBytes,
		totalObjects: objects.length,
		manifest,
	} satisfies DeepFreezeArchiveBuildResult;
}

export async function readDeepFreezeManifest(params: {
	bucket: BucketRecord;
	manifestKey: string;
}) {
	const response = await executeDataplaneStorage({
		bucket: params.bucket,
		rootPrefix: params.manifestKey,
		pathWithQuery: params.manifestKey,
		method: "GET",
	});
	if (!response.ok || !response.body) {
		throw new Error(`Failed to read Deep Freeze manifest (${response.status})`);
	}
	const compressed = Buffer.from(
		await new Response(response.body).arrayBuffer(),
	);
	const jsonBuffer = await gunzipAsync(compressed);
	return JSON.parse(jsonBuffer.toString("utf-8")) as DeepFreezeManifestEntry[];
}

export async function extractDeepFreezeArchive(params: {
	bucket: BucketRecord;
	archiveKey: string;
}) {
	const response = await executeDataplaneStorage({
		bucket: params.bucket,
		rootPrefix: params.archiveKey,
		pathWithQuery: params.archiveKey,
		method: "GET",
	});
	if (!response.ok || !response.body) {
		throw new Error(`Failed to read Deep Freeze archive (${response.status})`);
	}
	const compressed = Buffer.from(
		await new Response(response.body).arrayBuffer(),
	);
	return Buffer.from(await decompress(compressed));
}

export async function restoreDeepFreezeArchive(params: {
	owner: UserRecord;
	bucket: BucketRecord;
	archiveKey: string;
	manifest: DeepFreezeManifestEntry[];
	onProgress?: (progress: {
		processedObjects: number;
		totalObjects: number;
		processedBytes: number;
		totalBytes: number;
	}) => Promise<void> | void;
}) {
	const tarBuffer = await extractDeepFreezeArchive({
		bucket: params.bucket,
		archiveKey: params.archiveKey,
	});
	const extract = tar.extract();
	const entries = new Map<string, Buffer>();

	await new Promise<void>((resolve, reject) => {
		extract.on("entry", (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				entries.set(header.name, Buffer.concat(chunks));
				next();
			});
			stream.on("error", reject);
		});
		extract.on("finish", () => resolve());
		extract.on("error", reject);
		extract.end(tarBuffer);
	});

	const totalBytes = params.manifest.reduce((sum, item) => sum + item.size, 0);
	let processedObjects = 0;
	let processedBytes = 0;

	for (const item of params.manifest) {
		const buffer = entries.get(item.key);
		if (!buffer) {
			throw new Error(`Missing archived entry for ${item.key}`);
		}
		const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
		if (checksum !== item.checksumSha256) {
			throw new Error(`Checksum mismatch while restoring ${item.key}`);
		}
		const liveKey = getInternalPath(item.key, params.owner, params.bucket);
		const putRes = await executeDataplaneStorage({
			bucket: params.bucket,
			rootPrefix: getInternalPath("", params.owner, params.bucket),
			pathWithQuery: liveKey,
			method: "PUT",
			body: new Uint8Array(buffer),
			headers: {
				"Content-Type": item.contentType || "application/octet-stream",
				"Content-Length": String(buffer.length),
			},
		});
		if (!putRes.ok) {
			throw new Error(`Failed to restore ${item.key} (${putRes.status})`);
		}
		processedObjects += 1;
		processedBytes += item.size;
		await params.onProgress?.({
			processedObjects,
			totalObjects: params.manifest.length,
			processedBytes,
			totalBytes,
		});
	}

	return {
		totalObjects: params.manifest.length,
		totalBytes,
	};
}

export async function deleteLiveBucketObjects(params: {
	owner: UserRecord;
	bucket: BucketRecord;
	manifest: DeepFreezeManifestEntry[];
	onProgress?: (progress: {
		processedObjects: number;
		totalObjects: number;
		processedBytes: number;
		totalBytes: number;
	}) => Promise<void> | void;
}) {
	const totalBytes = params.manifest.reduce((sum, item) => sum + item.size, 0);
	let processedObjects = 0;
	let processedBytes = 0;

	for (const item of params.manifest) {
		const deleteRes = await executeDataplaneStorage({
			bucket: params.bucket,
			rootPrefix: getInternalPath("", params.owner, params.bucket),
			pathWithQuery: item.internalKey,
			method: "DELETE",
		});
		if (!deleteRes.ok) {
			throw new Error(
				`Failed to delete live object ${item.key} (${deleteRes.status})`,
			);
		}
		processedObjects += 1;
		processedBytes += item.size;
		await params.onProgress?.({
			processedObjects,
			totalObjects: params.manifest.length,
			processedBytes,
			totalBytes,
		});
	}

	return {
		totalObjects: params.manifest.length,
		totalBytes,
	};
}

export function buildDeepFreezeStorageKeys(params: {
	bucket: BucketRecord;
	archiveFileName?: string;
}) {
	const prefix = config.deepFreeze.storagePrefix.replace(/^\/+|\/+$/g, "");
	const ownerPrefix = params.bucket.userId || "system";
	const base = `${prefix}/${ownerPrefix}/${params.bucket.name}`;
	return {
		archiveKey: `${base}/${params.archiveFileName || `${params.bucket.id}.tar.zst`}`,
		manifestKey: `${base}/${params.bucket.id}.manifest.json.gz`,
	};
}
