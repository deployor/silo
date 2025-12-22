import { AwsClient } from "aws4fetch";
import { config } from "../config";

export class HetznerS3Client {
	private client: AwsClient;
	private endpoint: string;
	private bucket: string;

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
		});
	}

	async fetch(
		pathAndQuery: string,
		init?: RequestInit,
		retries = 3,
	): Promise<Response> {
		const baseUrl = new URL(`https://${this.bucket}.${this.endpoint}`);

		if (pathAndQuery.startsWith("?")) {
			baseUrl.search = pathAndQuery;
		} else {
			const relative = pathAndQuery.startsWith("/")
				? pathAndQuery.slice(1)
				: pathAndQuery;
			const tempUrl = new URL(relative, baseUrl.toString());

			baseUrl.pathname = tempUrl.pathname;
			baseUrl.search = tempUrl.search;
		}

		let lastError: unknown;
		for (let i = 0; i < retries; i++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 30000);

				console.log(`[S3Client] Fetching: ${baseUrl.toString()}`);

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
				console.log(`[S3Client] Headers:`, JSON.stringify(headersObj));

				const res = await this.client.fetch(baseUrl.toString(), {
					...init,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (res.status >= 500) {
					throw new Error(`Server error: ${res.status}`);
				}

				if (res.status === 403 || res.status === 404) {
					return res;
				}

				return res;
			} catch (e: unknown) {
				lastError = e;
				const error = e as Error;
				if (error.name === "AbortError") {
					console.error("Upstream S3 request timed out");
				}

				if (i < retries - 1) {
					await new Promise((r) => setTimeout(r, 2 ** i * 100));
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

		// aws4fetch doesn't have a direct presign method that returns a URL string with query params
		// We have to manually construct it or use a workaround.
		// However, since we are proxying, we might want to generate a presigned URL for OUR service,
		// not the upstream Hetzner bucket directly, if the user wants to share it.
		// But if the requirement is "allow presigned urls so private objects can be shared publicly",
		// it usually means the user generates a presigned URL using their credentials for OUR service.
		// Then our service validates it.

		// Wait, if the user asks for a presigned URL via API, we might need this.
		// But usually users generate presigned URLs locally using their SDK and keys.
		// Then they send that URL to someone. That someone requests OUR service.
		// OUR service sees the signature in the query params.
		// We validate that signature against the user's secret key.
		// If valid, we proxy to Hetzner.

		// So we don't necessarily need to generate upstream presigned URLs here unless we are redirecting.
		// But we are proxying. So we just need to handle the incoming request with query auth.
		// Which `authenticate` middleware already does!
		// It checks `X-Amz-Credential` in query params.

		return url.toString();
	}

	getEndpoint(): string {
		return this.endpoint;
	}

	getBucket(): string {
		return this.bucket;
	}
}

export const s3Client = new HetznerS3Client();
