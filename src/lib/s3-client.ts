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
      } catch (e: any) {
        lastError = e;
        if (e.name === "AbortError") {
          console.error("Upstream S3 request timed out");
        }

        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, Math.pow(2, i) * 100));
        }
      }
    }
    throw lastError;
  }

  async sign(url: string, init?: RequestInit): Promise<Request> {
    return this.client.sign(url, init);
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  getBucket(): string {
    return this.bucket;
  }
}

export const s3Client = new HetznerS3Client();
