import { AwsClient } from "aws4fetch";
import { config } from "../config";
import {
	getMaintenanceStatus,
	MAINTENANCE_ERROR,
} from "../services/maintenance-service";

const S3_TIMEOUT_MS = Number(process.env.S3_TIMEOUT_MS ?? "30000");
const S3_MULTIPART_UPLOAD_TIMEOUT_MS = Number(
	process.env.S3_MULTIPART_UPLOAD_TIMEOUT_MS ?? "300000",
);

function encodeS3Path(path: string) {
	return path
		.split("/")
		.map((segment) =>
			segment.replace(
				/(%[0-9A-Fa-f]{2})|([^/%]+)/g,
				(match, pctEncoded) => pctEncoded || encodeURIComponent(match),
			),
		)
		.join("/");
}

export class HetznerS3Client {
	private client: AwsClient;
	private endpoint: string;
	private bucket: string;
	private bucketBaseUrl: string;

	private consecutiveFailures = 0;
	private circuitOpenUntil = 0;
	private static readonly CIRCUIT_THRESHOLD = 5;
	private static readonly CIRCUIT_RESET_MS = 30000;

	constructor() {
		const { accessKeyId, secretAccessKey, endpoint, bucket, region } =
			config.s3;

		if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
			throw new Error("Missing S3 configuration environment variables");
		}

		this.endpoint = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
		this.bucket = bucket;
		this.bucketBaseUrl = `https://${this.bucket}.${this.endpoint}`;

		this.client = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: "s3",
			region,
			// Allow passing options like forcePathStyle if needed later, but aws4fetch doesn't use it directly
		});
	}

	async fetch(
		pathAndQuery: string,
		init?: RequestInit,
		retries = 3,
	): Promise<Response> {
		const maintenance = await getMaintenanceStatus();
		if (maintenance.s3MaintenanceMode || maintenance.fullMaintenanceMode) {
			throw new Error(MAINTENANCE_ERROR);
		}
		// Circuit breaker: fail fast if upstream is consistently failing
		if (this.consecutiveFailures >= HetznerS3Client.CIRCUIT_THRESHOLD) {
			if (Date.now() < this.circuitOpenUntil) {
				throw new Error("S3 upstream circuit breaker open — failing fast");
			}
			// Half-open: allow one probe request through
			this.consecutiveFailures = HetznerS3Client.CIRCUIT_THRESHOLD; // keep at threshold
		}

		const baseUrl = new URL(this.bucketBaseUrl);

		if (pathAndQuery.startsWith("?")) {
			baseUrl.search = pathAndQuery;
		} else {
			const queryStart = pathAndQuery.indexOf("?");
			const rawPath =
				queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
			const rawQuery = queryStart === -1 ? "" : pathAndQuery.slice(queryStart);
			const relative = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;

			baseUrl.pathname = `/${encodeS3Path(relative)}`;
			baseUrl.search = rawQuery;
		}

		const url = baseUrl.toString();
		const isMultipartUploadRequest =
			init?.method === "PUT" &&
			baseUrl.searchParams.has("uploadId") &&
			baseUrl.searchParams.has("partNumber");
		const timeoutMs = isMultipartUploadRequest
			? S3_MULTIPART_UPLOAD_TIMEOUT_MS
			: S3_TIMEOUT_MS;
		const headersObj = normalizeHeaders(init?.headers);

		let lastError: unknown;
		for (let i = 0; i < retries; i++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await this.client.fetch(url, {
					...init,
					headers: headersObj,
					signal: controller.signal,
				});

				if (res.status >= 500) {
					throw new Error(`Server error: ${res.status}`);
				}

				if (res.status === 403 || res.status === 404) {
					this.consecutiveFailures = 0;
					return res;
				}

				this.consecutiveFailures = 0;
				return res;
			} catch (e: unknown) {
				lastError = e;
				const error = e as Error;
				if (error.name === "AbortError") {
					console.error("Upstream S3 request timed out", {
						method: init?.method,
						pathAndQuery,
					});
				}

				if (i < retries - 1) {
					const baseDelay = 2 ** i * 100;
					const jitter = Math.floor(Math.random() * 100);
					await new Promise((r) => setTimeout(r, baseDelay + jitter));
				}

				this.consecutiveFailures++;
				if (this.consecutiveFailures >= HetznerS3Client.CIRCUIT_THRESHOLD) {
					this.circuitOpenUntil = Date.now() + HetznerS3Client.CIRCUIT_RESET_MS;
					console.error(
						`S3 circuit breaker opened after ${this.consecutiveFailures} consecutive failures`,
					);
				}
			} finally {
				clearTimeout(timeoutId);
			}
		}
		throw lastError;
	}

	async sign(url: string, init?: RequestInit): Promise<Request> {
		const maintenance = await getMaintenanceStatus();
		if (maintenance.s3MaintenanceMode || maintenance.fullMaintenanceMode) {
			throw new Error(MAINTENANCE_ERROR);
		}
		return this.client.sign(url, init);
	}

	async getPresignedUrl(
		path: string,
		_expiresIn: number = 3600,
	): Promise<string> {
		const maintenance = await getMaintenanceStatus();
		if (maintenance.s3MaintenanceMode || maintenance.fullMaintenanceMode) {
			throw new Error(MAINTENANCE_ERROR);
		}
		const baseUrl = new URL(this.bucketBaseUrl);
		const relative = path.startsWith("/") ? path.slice(1) : path;
		const url = new URL(relative, baseUrl.toString());

		return url.toString();
	}

	getEndpoint(): string {
		return this.endpoint;
	}

	getBucket(): string {
		return this.bucket;
	}

	getCircuitState(): {
		state: "closed" | "open" | "half-open";
		failures: number;
	} {
		if (this.consecutiveFailures >= HetznerS3Client.CIRCUIT_THRESHOLD) {
			if (Date.now() < this.circuitOpenUntil) {
				return { state: "open", failures: this.consecutiveFailures };
			}
			return { state: "half-open", failures: this.consecutiveFailures };
		}
		return { state: "closed", failures: this.consecutiveFailures };
	}
}

export const s3Client = new HetznerS3Client();

function normalizeHeaders(
	headers: HeadersInit | undefined,
): Record<string, string> {
	if (!headers) return {};
	if (headers instanceof Headers) {
		const normalized: Record<string, string> = {};
		headers.forEach((value, key) => {
			normalized[key] = value;
		});
		return normalized;
	}
	if (Array.isArray(headers)) {
		const normalized: Record<string, string> = {};
		for (const [key, value] of headers) {
			normalized[key] = value;
		}
		return normalized;
	}
	return { ...headers };
}
