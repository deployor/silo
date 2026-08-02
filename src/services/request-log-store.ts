type ClickHouseJson<T> = {
	data: T[];
	rows: number;
};

export type RequestLogFilters = {
	limit: number;
	offset: number;
	search?: string | null;
	bucket?: string | null;
	method?: string | null;
	status?: number;
	ip?: string | null;
	region?: string | null;
	storageRegion?: string | null;
	action?: string | null;
	sortBy:
		| "createdAt"
		| "latencyMs"
		| "ingressBytes"
		| "egressBytes"
		| "statusCode";
	sortOrder: "asc" | "desc";
};

export type RequestLogRow = {
	id: string;
	requestId: string;
	method: string;
	path: string;
	statusCode: number;
	latencyMs: number;
	createdAt: string;
	bucketName: string | null;
	ownerId: string | null;
	ownerEmail?: string | null;
	ipAddress: string | null;
	ingressBytes: number;
	egressBytes: number;
	userAgent: string | null;
	requesterId: string | null;
	region: string;
	storageRegion: string;
	action: string;
};

export type BucketRequestAggregate = {
	bucketName: string;
	totalRequests: number;
	getRequests: number;
	putRequests: number;
	deleteRequests: number;
	headRequests: number;
	ingressBytes: number;
	egressBytes: number;
};

const SORT_COLUMNS: Record<RequestLogFilters["sortBy"], string> = {
	createdAt: "event_time",
	latencyMs: "latency_ms",
	ingressBytes: "ingress_bytes",
	egressBytes: "egress_bytes",
	statusCode: "status_code",
};

class RequestLogStore {
	configured(): boolean {
		return this.endpoints().length > 0;
	}

	async list(
		filters: RequestLogFilters,
	): Promise<{ logs: RequestLogRow[]; total: number }> {
		const clauses = ["1"];
		const parameters: Record<string, string> = {};
		if (filters.search) {
			clauses.push(`positionCaseInsensitiveUTF8(concat(
				method, ' ', path, ' ', bucket_name, ' ', user_agent, ' ',
				ip_address, ' ', requester_id, ' ', toString(status_code)
			), {search:String}) > 0`);
			parameters.search = filters.search;
		}
		if (filters.bucket) {
			clauses.push("bucket_name = {bucket:String}");
			parameters.bucket = filters.bucket;
		}
		if (filters.method) {
			clauses.push("method = {method:String}");
			parameters.method = filters.method;
		}
		if (filters.status !== undefined) {
			clauses.push("status_code = {status:UInt16}");
			parameters.status = String(filters.status);
		}
		if (filters.ip) {
			clauses.push("ip_address = {ip:String}");
			parameters.ip = filters.ip;
		}
		if (filters.region) {
			clauses.push("region = {region:String}");
			parameters.region = filters.region;
		}
		if (filters.storageRegion) {
			clauses.push("storage_region = {storageRegion:String}");
			parameters.storageRegion = filters.storageRegion;
		}
		if (filters.action) {
			clauses.push("action = {action:String}");
			parameters.action = filters.action;
		}
		const where = clauses.join(" AND ");
		const order = SORT_COLUMNS[filters.sortBy];
		const direction = filters.sortOrder === "asc" ? "ASC" : "DESC";
		const [rows, count] = await Promise.all([
			this.query<Record<string, unknown>>(
				`SELECT
					toString(request_id) AS id,
					method,
					path,
					status_code AS statusCode,
					latency_ms AS latencyMs,
					concat(toString(event_time, 'UTC'), 'Z') AS createdAt,
					nullIf(bucket_name, '') AS bucketName,
					nullIf(owner_id, '') AS ownerId,
					nullIf(ip_address, '') AS ipAddress,
					ingress_bytes AS ingressBytes,
					egress_bytes AS egressBytes,
					nullIf(user_agent, '') AS userAgent,
					nullIf(requester_id, '') AS requesterId,
					region,
					storage_region AS storageRegion,
					action
				FROM silo_logs.request_logs FINAL
				WHERE ${where}
				ORDER BY ${order} ${direction}, request_id ${direction}
				LIMIT {limit:UInt32} OFFSET {offset:UInt64}`,
				{
					...parameters,
					limit: String(filters.limit),
					offset: String(filters.offset),
				},
			),
			this.query<{ total: string | number }>(
				`SELECT count() AS total
				 FROM silo_logs.request_logs FINAL
				 WHERE ${where}`,
				parameters,
			),
		]);
		return {
			logs: rows.map(normalizeLogRow),
			total: Number(count[0]?.total || 0),
		};
	}

	async bucketAggregates(): Promise<Map<string, BucketRequestAggregate>> {
		const rows = await this.query<Record<string, unknown>>(`
			SELECT
				bucket_name AS bucketName,
				count() AS totalRequests,
				countIf(method = 'GET') AS getRequests,
				countIf(method = 'PUT') AS putRequests,
				countIf(method = 'DELETE') AS deleteRequests,
				countIf(method = 'HEAD') AS headRequests,
				sum(ingress_bytes) AS ingressBytes,
				sum(egress_bytes) AS egressBytes
			FROM silo_logs.request_logs FINAL
			WHERE bucket_name != ''
			GROUP BY bucket_name
		`);
		return new Map(
			rows.map((row) => {
				const aggregate = {
					bucketName: String(row.bucketName),
					totalRequests: Number(row.totalRequests || 0),
					getRequests: Number(row.getRequests || 0),
					putRequests: Number(row.putRequests || 0),
					deleteRequests: Number(row.deleteRequests || 0),
					headRequests: Number(row.headRequests || 0),
					ingressBytes: Number(row.ingressBytes || 0),
					egressBytes: Number(row.egressBytes || 0),
				};
				return [aggregate.bucketName, aggregate] as const;
			}),
		);
	}

	async health(): Promise<
		Array<{ endpoint: string; ok: boolean; error?: string }>
	> {
		return Promise.all(
			this.endpoints().map(async (endpoint) => {
				try {
					await this.queryAt<{ ok: number }>(endpoint, "SELECT 1 AS ok", {});
					return { endpoint: redactEndpoint(endpoint), ok: true };
				} catch (error) {
					return {
						endpoint: redactEndpoint(endpoint),
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
	}

	private endpoints(): string[] {
		return (process.env.CLICKHOUSE_QUERY_URLS || "")
			.split(",")
			.map((value) => value.trim().replace(/\/$/, ""))
			.filter((value) => value.startsWith("https://"));
	}

	private async query<T>(
		query: string,
		parameters: Record<string, string> = {},
	): Promise<T[]> {
		const endpoints = this.endpoints();
		if (!endpoints.length)
			throw new Error("ClickHouse request log store is not configured");
		const failures: string[] = [];
		// Keep offset pagination pinned to the preferred replica. The replicas are
		// independently ingested and can differ briefly, so round-robin reads can
		// otherwise skip or duplicate rows between successive pages. Fall through
		// to the next region only when the preferred query endpoint fails.
		for (const endpoint of endpoints) {
			try {
				return await this.queryAt<T>(endpoint, query, parameters);
			} catch (error) {
				failures.push(
					`${redactEndpoint(endpoint)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		throw new Error(
			`all ClickHouse log replicas failed (${failures.join("; ")})`,
		);
	}

	private async queryAt<T>(
		endpoint: string,
		query: string,
		parameters: Record<string, string>,
	): Promise<T[]> {
		const url = new URL(endpoint);
		url.searchParams.set("database", "silo_logs");
		url.searchParams.set("date_time_output_format", "iso");
		url.searchParams.set("output_format_json_quote_64bit_integers", "0");
		for (const [name, value] of Object.entries(parameters))
			url.searchParams.set(`param_${name}`, value);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8_000);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Basic ${btoa(`${process.env.CLICKHOUSE_QUERY_USER || "silo_query"}:${process.env.CLICKHOUSE_QUERY_PASSWORD || ""}`)}`,
					"Content-Type": "text/plain; charset=utf-8",
				},
				body: `${query}\nFORMAT JSON`,
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = (await response.text()).slice(0, 500);
				throw new Error(`HTTP ${response.status}: ${body}`);
			}
			return ((await response.json()) as ClickHouseJson<T>).data;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function normalizeLogRow(row: Record<string, unknown>): RequestLogRow {
	return {
		id: String(row.id),
		requestId: String(row.id),
		method: String(row.method),
		path: String(row.path),
		statusCode: Number(row.statusCode),
		latencyMs: Number(row.latencyMs),
		createdAt: String(row.createdAt),
		bucketName: row.bucketName ? String(row.bucketName) : null,
		ownerId: row.ownerId ? String(row.ownerId) : null,
		ipAddress: row.ipAddress ? String(row.ipAddress) : null,
		ingressBytes: Number(row.ingressBytes || 0),
		egressBytes: Number(row.egressBytes || 0),
		userAgent: row.userAgent ? String(row.userAgent) : null,
		requesterId: row.requesterId ? String(row.requesterId) : null,
		region: String(row.region || "unknown"),
		storageRegion: String(row.storageRegion || ""),
		action: String(row.action || ""),
	};
}

function redactEndpoint(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "invalid-endpoint";
	}
}

export const requestLogStore = new RequestLogStore();
