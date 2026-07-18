import { describe, expect, test } from "bun:test";
import { __test } from "./index";

const registryJson = JSON.stringify([
	{
		id: "eu-central",
		label: "Europe — Germany",
		flag: "🇩🇪",
		origin: "https://eu-origin.onsilo.dev",
		endpointHosts: ["onsilo.dev", "eu.onsilo.dev"],
		default: true,
		backends: [
			{
				id: "primary",
				label: "EU primary",
				provider: "Backblaze B2",
				role: "primary",
				canaryRef: "eu-primary",
			},
			{
				id: "replica-1",
				label: "EU replica",
				provider: "S3 compatible",
				role: "replica",
				canaryRef: "eu-replica",
			},
		],
	},
	{
		id: "us-east",
		label: "United States — US East",
		flag: "🇺🇸",
		origin: "https://us-origin.onsilo.dev",
		endpointHosts: ["us.onsilo.dev"],
		default: false,
		backends: [
			{
				id: "primary",
				label: "US primary",
				provider: "Backblaze B2",
				role: "primary",
				canaryRef: "us-primary",
			},
		],
	},
]);

function readiness(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		region: "eu-central",
		postgres: true,
		regionalSchema: true,
		redis: false,
		diskCache: {
			enabled: true,
			writable: true,
			totalBytes: 1024,
			maxTotalBytes: 4096,
		},
		accounting: { durable: true, pending: 0, unsafe: false },
		storageRegions: { "eu-central": true },
		failoverRegions: [] as string[],
		activeWriterRegions: { "eu-central": 4 },
		activeStorageBackends: { "eu-central": "primary" },
		backendGenerations: { "eu-central": 1 },
		storageBackends: { "eu-central": { primary: true } },
		replication: {},
		...overrides,
	};
}

function checks(ok: boolean) {
	return {
		configured: true,
		authentication: ok,
		upload: ok,
		download: ok,
		delete: ok,
	};
}

describe("regional status safety contracts", () => {
	test("provider canaries support path, virtual-host, and temporary credentials", () => {
		const credentials = __test.parseCredentialMap({
			path: {
				endpoint: "https://s3.us-west-004.backblazeb2.com",
				bucket: "silo-status-us",
				accessKeyId: "key",
				secretAccessKey: "secret",
				sessionToken: "temporary-token",
				signingRegion: "us-west-004",
				prefix: "health",
			},
			virtual: {
				endpoint: "https://s3.example.com",
				bucket: "silo-status-eu",
				accessKeyId: "key",
				secretAccessKey: "secret",
				signingRegion: "eu-central-1",
				addressingStyle: "virtual",
			},
		});
		expect(credentials.path.addressingStyle).toBe("path");
		expect(credentials.path.sessionToken).toBe("temporary-token");
		expect(
			__test.s3RequestUrl(
				credentials.path,
				credentials.path.endpoint,
				"health/object",
			).href,
		).toBe(
			"https://s3.us-west-004.backblazeb2.com/silo-status-us/health/object",
		);
		expect(
			__test.s3RequestUrl(
				credentials.virtual,
				credentials.virtual.endpoint,
				"health/object",
			).href,
		).toBe("https://silo-status-eu.s3.example.com/health/object");
	});

	test("provider canaries reject unsafe endpoints and ambiguous virtual TLS", () => {
		const base = {
			bucket: "silo.status.eu",
			accessKeyId: "key",
			secretAccessKey: "secret",
			signingRegion: "eu-central-1",
		};
		expect(() =>
			__test.parseCredentialMap({
				bad: { ...base, endpoint: "http://s3.example.com" },
			}),
		).toThrow("clean HTTPS origin");
		expect(() =>
			__test.parseCredentialMap({
				bad: {
					...base,
					endpoint: "https://s3.example.com",
					addressingStyle: "virtual",
				},
			}),
		).toThrow("cannot contain dots");
	});

	test("registry supports additional regions and physical providers", () => {
		const value = JSON.parse(registryJson);
		value.push({
			id: "ap-south",
			label: "Asia Pacific",
			flag: "🌏",
			origin: "https://ap-origin.onsilo.dev",
			endpointHosts: ["ap.onsilo.dev"],
			default: false,
			backends: [
				{
					id: "primary",
					label: "AP primary",
					provider: "S3 compatible",
					role: "primary",
					canaryRef: "ap-primary",
				},
			],
		});
		const registry = __test.parseRegistry(JSON.stringify(value));
		expect(registry).toHaveLength(3);
		expect(registry[0].backends.map((backend) => backend.id)).toEqual([
			"primary",
			"replica-1",
		]);
	});

	test("registry rejects ambiguous or insecure routing", () => {
		const duplicateHost = JSON.parse(registryJson);
		duplicateHost[1].endpointHosts = ["onsilo.dev"];
		expect(() => __test.parseRegistry(JSON.stringify(duplicateHost))).toThrow(
			"more than one home region",
		);

		const insecureOrigin = JSON.parse(registryJson);
		insecureOrigin[1].origin = "http://us-origin.onsilo.dev";
		expect(() => __test.parseRegistry(JSON.stringify(insecureOrigin))).toThrow(
			"clean HTTPS origin",
		);
	});

	test("Dragonfly is optional but durable accounting and Aiven are not", () => {
		expect(
			__test.dataplaneAvailable({
				health: true,
				readiness: readiness(),
			} as never),
		).toBe(true);
		expect(
			__test.dataplaneAvailable({
				health: true,
				readiness: readiness({
					accounting: { durable: true, pending: 0, unsafe: true },
				}),
			} as never),
		).toBe(false);
		expect(
			__test.dataplaneAvailable({
				health: true,
				readiness: readiness({ postgres: false }),
			} as never),
		).toBe(false);
	});

	test("remote serving requires explicit failover authorization", () => {
		const remote = readiness({
			region: "us-east",
			storageRegions: { "eu-central": true, "us-east": true },
		});
		expect(__test.readinessCanServe(remote as never, "eu-central", true)).toBe(
			false,
		);
		remote.failoverRegions = ["eu-central"];
		expect(__test.readinessCanServe(remote as never, "eu-central", true)).toBe(
			true,
		);
	});

	test("provider promotion candidate needs every replication gate", () => {
		const registry = __test.parseRegistry(registryJson);
		const region = registry[0];
		const runtime = {
			activeDataplane: "eu-central",
			activeBackend: "primary",
		};
		const snapshot = {
			dataplanes: {
				"eu-central": {
					health: true,
					readiness: readiness({
						replication: {
							"eu-central": {
								"replica-1": {
									caughtUp: true,
									fresh: true,
									authorized: true,
									checkpoint: "42",
								},
							},
						},
					}),
				},
			},
			backends: {
				"eu-central": {
					"replica-1": { operational: true, checks: checks(true) },
				},
			},
		};
		expect(
			__test.chooseBackendCandidate(
				region,
				runtime as never,
				snapshot as never,
			),
		).toBe("replica-1");
		(
			snapshot.dataplanes["eu-central"].readiness.replication as Record<
				string,
				Record<string, { authorized: boolean }>
			>
		)["eu-central"]["replica-1"].authorized = false;
		expect(
			__test.chooseBackendCandidate(
				region,
				runtime as never,
				snapshot as never,
			),
		).toBeUndefined();
	});

	test("successful regional takeover is degraded, not a global outage", () => {
		const registry = __test.parseRegistry(registryJson);
		const state = {
			regions: {
				"eu-central": {
					activeDataplane: "us-east",
					activeBackend: "primary",
					phase: "active",
					providerPhase: "normal",
				},
				"us-east": {
					activeDataplane: "us-east",
					activeBackend: "primary",
					phase: "normal",
					providerPhase: "normal",
				},
			},
		};
		const usReadiness = readiness({
			region: "us-east",
			redis: true,
			storageRegions: { "eu-central": true, "us-east": true },
			failoverRegions: ["eu-central"],
		});
		const snapshot = {
			dashboard: true,
			database: {
				"eu-central": {
					region: "eu-central",
					reachable: true,
					role: "primary",
					generation: 1,
					activeRegion: "eu-central",
					replication: [
						{
							applicationName: "silo_us",
							state: "streaming",
							syncState: "sync",
						},
					],
				},
				"us-east": {
					region: "us-east",
					reachable: true,
					role: "replica",
					generation: 1,
					activeRegion: "eu-central",
					replication: [],
				},
			},
			clickhouse: {
				"eu-central": {
					reachable: true,
					recentRows: 20,
					latestEventAt: "2026-07-18T20:00:00Z",
				},
				"us-east": {
					reachable: true,
					recentRows: 20,
					latestEventAt: "2026-07-18T20:00:00Z",
				},
			},
			dataplanes: {
				"eu-central": {
					health: false,
					readiness: readiness({
						postgres: false,
						diskCache: { enabled: true, writable: false },
					}),
				},
				"us-east": { health: true, readiness: usReadiness },
			},
			backends: {
				"eu-central": {
					primary: { checks: checks(true), operational: true },
					"replica-1": { checks: checks(true), operational: true },
				},
				"us-east": {
					primary: { checks: checks(true), operational: true },
				},
			},
			logical: { "eu-central": checks(true), "us-east": checks(true) },
			homeReadOnly: { "eu-central": false, "us-east": true },
		};
		const components = __test.deriveComponents(
			registry,
			state as never,
			snapshot as never,
		);
		expect(components["dataplane:eu-central"]).toBe("outage");
		expect(components["pgdog:eu-central"]).toBe("outage");
		expect(components["cache:eu-central"]).toBe("degraded");
		expect(components["cache:us-east"]).toBe("operational");
		expect(components["disk-cache:eu-central"]).toBe("outage");
		expect(components["disk-cache:us-east"]).toBe("operational");
		expect(components["postgresql:eu-central"]).toBe("operational");
		expect(components["postgresql:us-east"]).toBe("operational");
		expect(components["clickhouse:eu-central"]).toBe("operational");
		expect(components["clickhouse:us-east"]).toBe("operational");
		expect(components["storage:eu-central"]).toBe("operational");
		expect(components["global-s3"]).toBe("degraded");
		expect(__test.deriveOverall(registry, components)).toBe("degraded");
	});
});
