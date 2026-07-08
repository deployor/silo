import { getClientIp } from "../../lib/api-utils";
import * as RedemptionService from "../../services/redemption-service";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function bearerToken(req: Request) {
	const header = req.headers.get("authorization") || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || "";
}

function grantBytes(body: Record<string, unknown>) {
	if (typeof body.bytes === "number") return Math.floor(body.bytes);
	if (typeof body.amount !== "number") return 0;

	const unit = String(body.unit || "GB").toUpperCase();
	const multiplier =
		unit === "B"
			? 1
			: unit === "KB"
				? 1024
				: unit === "MB"
					? 1024 ** 2
					: unit === "TB"
						? 1024 ** 4
						: 1024 ** 3;

	return Math.floor(body.amount * multiplier);
}

export async function handleYswsApiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (
		!["/api/ysws/grants", "/api/ysws/codes"].includes(url.pathname) ||
		req.method !== "POST"
	) {
		return json({ error: "Not found" }, 404);
	}

	const apiKey = bearerToken(req);
	if (!apiKey) return json({ error: "Missing bearer token" }, 401);

	const program = await RedemptionService.authenticateProgramApiKey(apiKey);
	if (!program) return json({ error: "Invalid program API key" }, 401);

	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}

	if (url.pathname === "/api/ysws/codes") {
		try {
			const customCodes = Array.isArray(body.codes)
				? body.codes.filter((code): code is string => typeof code === "string")
				: typeof body.code === "string"
					? [body.code]
					: [];
			const amountBytes =
				body.bytes !== undefined || body.amount !== undefined
					? grantBytes(body)
					: undefined;
			const codes = await RedemptionService.generateCodes(
				program.id,
				typeof body.count === "number" ? Math.floor(body.count) : 0,
				null,
				16,
				customCodes,
				amountBytes,
			);

			return json({
				ok: true,
				program: {
					id: program.id,
					name: program.name,
					prefix: program.prefix,
				},
				codes: codes.map((code) => ({
					code: code.code,
					creditBytes: code.quotaCreditBytes ?? program.quotaCreditBytes,
					url: `https://silo.deployor.dev/redeem?code=${encodeURIComponent(code.code)}`,
				})),
			});
		} catch (error) {
			return json(
				{
					error:
						error instanceof Error ? error.message : "Code creation failed",
				},
				400,
			);
		}
	}

	try {
		const result = await RedemptionService.grantProgramStorage({
			programId: program.id,
			userId: typeof body.userId === "string" ? body.userId : undefined,
			email: typeof body.email === "string" ? body.email : undefined,
			slackId: typeof body.slackId === "string" ? body.slackId : undefined,
			amountBytes: grantBytes(body),
			source: "api",
			externalId:
				typeof body.externalId === "string" ? body.externalId : undefined,
			reason: typeof body.reason === "string" ? body.reason : undefined,
			ipAddress: getClientIp(req),
			apiKeySuffix: program.apiKeySuffix,
			userAgent: req.headers.get("user-agent"),
		});

		return json({
			ok: true,
			status: result.status,
			duplicate: result.duplicate,
			program: {
				id: result.program.id,
				name: result.program.name,
				prefix: result.program.prefix,
			},
			user: result.user
				? {
						id: result.user.id,
						email: result.user.email,
						slackId: result.user.slackId,
					}
				: null,
			pendingFor:
				result.status === "pending"
					? {
							userId: result.transaction.targetUserId,
						}
					: null,
			grant: {
				id: result.transaction.id,
				bytes: result.transaction.amountBytes,
				externalId: result.transaction.externalId,
				createdAt: result.transaction.createdAt,
				fulfilledAt: result.transaction.fulfilledAt,
			},
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : "Grant failed" },
			400,
		);
	}
}
