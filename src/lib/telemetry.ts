import {
	metrics,
	propagation,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	SpanKind,
	SpanStatusCode,
	type TextMapGetter,
	trace,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "silo-control-plane";
const DEFAULT_TRACE_SAMPLE_RATIO = 0.05;
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 10_000;
const MAX_METRIC_CARDINALITY = 128;

let sdk: NodeSDK | null = null;
let enabled = false;
let requestCounter: ReturnType<
	ReturnType<typeof metrics.getMeter>["createCounter"]
> | null = null;
let requestDuration: ReturnType<
	ReturnType<typeof metrics.getMeter>["createHistogram"]
> | null = null;
let activeRequests: ReturnType<
	ReturnType<typeof metrics.getMeter>["createUpDownCounter"]
> | null = null;

const headersGetter: TextMapGetter<Headers> = {
	get(carrier, key) {
		return carrier.get(key) ?? undefined;
	},
	keys(carrier) {
		return [...carrier.keys()];
	},
};

function positiveInteger(raw: string | undefined, fallback: number) {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function traceSampleRatio() {
	const value = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
	return Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: DEFAULT_TRACE_SAMPLE_RATIO;
}

function signalEndpoint(signal: "traces" | "metrics") {
	const explicit =
		process.env[
			signal === "traces"
				? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
				: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
		];
	if (explicit) return explicit;
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!base) return null;
	const url = new URL(base);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/${signal}`;
	return url.toString();
}

function validatedEndpoint(value: string | null, signal: string) {
	if (!value) return null;
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error(`OTLP ${signal} endpoint must use HTTP or HTTPS`);
	}
	return url.toString();
}

/**
 * Starts OTLP only when an endpoint is configured. Initialization and export
 * failures are fail-open so observability can never take the control plane
 * offline. Exported application attributes are explicitly allow-listed below.
 */
export function initializeTelemetry() {
	if (sdk || enabled) return;
	const hasEndpoint = Boolean(
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
	);
	if (!hasEndpoint) return;

	try {
		const traceEndpoint = validatedEndpoint(signalEndpoint("traces"), "trace");
		const metricEndpoint = validatedEndpoint(
			signalEndpoint("metrics"),
			"metric",
		);
		if (!traceEndpoint || !metricEndpoint) {
			throw new Error("Both OTLP trace and metric endpoints must resolve");
		}
		const metricReader = new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({ url: metricEndpoint }),
			exportIntervalMillis: positiveInteger(
				process.env.OTEL_METRIC_EXPORT_INTERVAL,
				DEFAULT_METRIC_EXPORT_INTERVAL_MS,
			),
			exportTimeoutMillis: positiveInteger(
				process.env.OTEL_METRIC_EXPORT_TIMEOUT,
				5_000,
			),
			cardinalityLimits: { default: MAX_METRIC_CARDINALITY },
		});
		const configuration: ConstructorParameters<typeof NodeSDK>[0] = {
			serviceName: SERVICE_NAME,
			traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
			metricReaders: [metricReader],
		};
		// Respect any standard sampler explicitly supplied by operators. The
		// default keeps request tracing useful without tracing every hot-path hit.
		if (!process.env.OTEL_TRACES_SAMPLER) {
			configuration.sampler = new ParentBasedSampler({
				root: new TraceIdRatioBasedSampler(traceSampleRatio()),
			});
		}
		sdk = new NodeSDK(configuration);
		sdk.start();
		enabled = true;

		const meter = metrics.getMeter(SERVICE_NAME);
		requestCounter = meter.createCounter("silo.control.http.requests", {
			description: "Completed Bun control-plane HTTP requests",
		});
		requestDuration = meter.createHistogram(
			"silo.control.http.request.duration",
			{
				description: "Bun control-plane request duration",
				unit: "ms",
			},
		);
		activeRequests = meter.createUpDownCounter(
			"silo.control.http.requests.active",
			{ description: "In-flight Bun control-plane HTTP requests" },
		);
		console.log(
			JSON.stringify({
				event: "telemetry_initialized",
				service: SERVICE_NAME,
				traces: true,
				metrics: true,
			}),
		);
	} catch (error) {
		sdk = null;
		enabled = false;
		console.warn(
			JSON.stringify({
				event: "telemetry_initialization_failed",
				service: SERVICE_NAME,
				error: error instanceof Error ? error.message : "unknown error",
			}),
		);
	}
}

export function classifyControlPlaneRoute(path: string, isDashboard: boolean) {
	if (!isDashboard) return "s3.misdirected";
	if (path === "/") return "/";
	if (path === "/health") return "/health";
	if (path === "/api/maintenance-status") return "/api/maintenance-status";
	if (path.startsWith("/api/internal/dataplane/")) {
		return "/api/internal/dataplane/*";
	}
	if (path.startsWith("/api/admin/storage/")) {
		return "/api/admin/storage/*";
	}
	if (path.startsWith("/api/admin/")) return "/api/admin/*";
	if (path.startsWith("/admin/")) return "/admin/*";
	if (path.startsWith("/api/dashboard/")) return "/api/dashboard/*";
	if (path.startsWith("/dashboard/")) return "/dashboard/*";
	if (path.startsWith("/api/slack/")) return "/api/slack/*";
	if (path.startsWith("/api/ysws/")) return "/api/ysws/*";
	if (path.startsWith("/api/revocation")) return "/api/revocation";
	if (path.startsWith("/api/")) return "/api/*";
	if (path.startsWith("/auth/")) return "/auth/*";
	if (path.startsWith("/assets/")) return "/assets/*";
	if (path.startsWith("/docs")) return "/docs";
	if (path.startsWith("/account")) return "/account/*";
	if (path.startsWith("/onboarding")) return "/onboarding/*";
	if (path.startsWith("/redeem")) return "/redeem/*";
	return "dashboard.other";
}

export function traceIdFromTraceparent(traceparent: string | null) {
	const match = traceparent
		?.trim()
		.match(/^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(?:-.*)?$/i);
	if (
		!match ||
		match[1].toLowerCase() === "ff" ||
		/^0{32}$/.test(match[2]) ||
		/^0{16}$/.test(match[3])
	) {
		return null;
	}
	return match[2].toLowerCase();
}

function incomingSpanContext(req: Request): {
	context: ReturnType<typeof propagation.extract>;
	spanContext?: SpanContext;
} {
	const extracted = propagation.extract(
		ROOT_CONTEXT,
		req.headers,
		headersGetter,
	);
	return { context: extracted, spanContext: trace.getSpanContext(extracted) };
}

export function beginHttpRequestTelemetry(params: {
	req: Request;
	requestId: string;
	route: string;
}) {
	const baseAttributes = {
		"http.request.method": params.req.method,
		"http.route": params.route,
	};
	let span: Span | null = null;
	let traceId =
		traceIdFromTraceparent(params.req.headers.get("traceparent")) ||
		crypto.randomUUID().replace(/-/g, "");

	if (enabled) {
		const parent = incomingSpanContext(params.req);
		span = trace.getTracer(SERVICE_NAME).startSpan(
			`${params.req.method} ${params.route}`,
			{
				kind: SpanKind.SERVER,
				attributes: {
					...baseAttributes,
					"silo.request.id": params.requestId,
				},
			},
			parent.context,
		);
		const sdkTraceId = span.spanContext().traceId;
		if (!/^0{32}$/.test(sdkTraceId)) traceId = sdkTraceId;
		activeRequests?.add(1, baseAttributes);
	}

	let finished = false;
	return {
		traceId,
		finish(result: {
			status: number;
			durationMs: number;
			failed: boolean;
			bucketRegion?: string | null;
		}) {
			if (finished) return;
			finished = true;
			if (!enabled) return;
			const metricAttributes = {
				...baseAttributes,
				"http.response.status_code": result.status,
				"silo.bucket.storage_region": result.bucketRegion || "none",
			};
			activeRequests?.add(-1, baseAttributes);
			requestCounter?.add(1, metricAttributes);
			requestDuration?.record(result.durationMs, metricAttributes);
			span?.setAttributes({
				"http.response.status_code": result.status,
				"silo.bucket.storage_region": result.bucketRegion || "none",
			});
			span?.setStatus({
				code: result.failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
			});
			span?.end();
		},
	};
}

export async function shutdownTelemetry() {
	const current = sdk;
	sdk = null;
	enabled = false;
	if (!current) return;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			current.shutdown(),
			new Promise((resolve) => {
				timeout = setTimeout(resolve, 5_000);
			}),
		]);
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: "telemetry_shutdown_failed",
				service: SERVICE_NAME,
				error: error instanceof Error ? error.message : "unknown error",
			}),
		);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
