import { AwsClient } from "aws4fetch";
import { config } from "../config";

const S3_TIMEOUT_MS = Number(process.env.S3_TIMEOUT_MS ?? "30000");

export class HetznerS3Client {
	private client: AwsClient;
	private endpoint: string;
	private bucket: string;

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
		// Circuit breaker: fail fast if upstream is consistently failing
		if (this.consecutiveFailures >= HetznerS3Client.CIRCUIT_THRESHOLD) {
			if (Date.now() < this.circuitOpenUntil) {
				throw new Error("S3 upstream circuit breaker open — failing fast");
			}
			// Half-open: allow one probe request through
			this.consecutiveFailures = HetznerS3Client.CIRCUIT_THRESHOLD; // keep at threshold
		}

		const baseUrl = new URL(`https://${this.bucket}.${this.endpoint}`);

		if (pathAndQuery.startsWith("?")) {
			baseUrl.search = pathAndQuery;
		} else {
			const relative = pathAndQuery.startsWith("/")
				? pathAndQuery.slice(1)
				: pathAndQuery;
			const rewrittenUrl = new URL(relative, baseUrl.toString());

			baseUrl.pathname = rewrittenUrl.pathname;
			baseUrl.search = rewrittenUrl.search;
		}

		let lastError: unknown;
		for (let i = 0; i < retries; i++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);

				const headersObj: Record<string, string> = {};
				if (init?.headers) {
					if (init.headers instanceof Headers) {
						init.headers.forEach((v, k) => {
							headersObj[k] = v;
						});
					} else if (Array.isArray(init.headers)) {
						init.headers.forEach(([k, v]) => {
							headersObj[k] = v;
						});
					} else {
						Object.assign(headersObj, init.headers);
					}
				}

				const res = await this.client.fetch(baseUrl.toString(), {
					...init,
					headers: headersObj,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

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
					console.error("Upstream S3 request timed out");
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
			}
		}
		throw lastError;
	}

	async sign(url: string, init?: RequestInit): Promise<Request> {
		return this.client.sign(url, init);
	}

	async getPresignedUrl(
		path: string,
		_expiresIn: number = 3600,
	): Promise<string> {
		const baseUrl = new URL(`https://${this.bucket}.${this.endpoint}`);
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
