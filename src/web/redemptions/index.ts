import type { users } from "../../db/schema";
import { getClientIp } from "../../lib/api-utils";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import * as RedemptionService from "../../services/redemption-service";

export async function handleAdminRedemptionsRequest(
	req: Request,
	user: typeof users.$inferSelect,
): Promise<Response> {
	const url = new URL(req.url);

	if (!user.isAdmin) {
		return new Response("Forbidden", { status: 403 });
	}

	// List Programs
	if (url.pathname === "/admin/redemptions") {
		const programs = await RedemptionService.getPrograms();
		return new Response(
			await render("admin-redemptions", {
				title: "Redemption Programs",
				user,
				programs,
				layout: "main",
			}),
			{
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	// Create Program
	if (url.pathname === "/admin/redemptions/create" && req.method === "POST") {
		const formData = await req.formData();

		const amount = Number(formData.get("amount"));
		const unit = Number(formData.get("unit"));
		const quotaCreditBytes = Math.floor(amount * unit);

		await RedemptionService.createProgram({
			name: formData.get("name") as string,
			prefix: formData.get("prefix") as string,
			description: formData.get("description") as string,
			quotaCreditBytes,
		});
		return new Response(null, {
			status: 302,
			headers: { Location: "/admin/redemptions" },
		});
	}

	// Program Details / Codes
	const detailsMatch = url.pathname.match(
		/\/admin\/redemptions\/([a-f0-9-]+)$/,
	);
	if (detailsMatch && req.method === "GET") {
		const programId = detailsMatch[1];
		const page = Number(url.searchParams.get("page") || 1);
		const program = await RedemptionService.getProgramById(programId);

		if (!program) return new Response("Program not found", { status: 404 });

		const { data: codes, pagination } = await RedemptionService.getCodes(
			programId,
			page,
		);
		const { data: transactions, pagination: transactionPagination } =
			await RedemptionService.getTransactions(programId, 1, 50);

		return new Response(
			await render("admin-redemption-details", {
				title: `Manage: ${program.name}`,
				user,
				program,
				codes,
				pagination,
				transactions,
				transactionPagination,
				layout: "main",
			}),
			{
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	// Generate Codes
	const generateMatch = url.pathname.match(
		/\/admin\/redemptions\/([a-f0-9-]+)\/generate$/,
	);
	if (generateMatch && req.method === "POST") {
		const programId = generateMatch[1];
		const formData = await req.formData();
		const count = Number(formData.get("count"));
		const customCodes = String(formData.get("customCodes") || "")
			.split(/\r?\n|,/)
			.map((code) => code.trim())
			.filter(Boolean);
		const amount = Number(formData.get("amount"));
		const unit = Number(formData.get("unit"));
		const quotaCreditBytes =
			amount > 0 && unit > 0 ? Math.floor(amount * unit) : undefined;

		const newCodes = await RedemptionService.generateCodes(
			programId,
			count,
			user.id,
			16,
			customCodes,
			quotaCreditBytes,
		);
		const program = await RedemptionService.getProgramById(programId);

		return new Response(
			await render("admin-redemption-generated", {
				title: "Codes Generated",
				user,
				program,
				codes: newCodes,
				layout: "main",
			}),
			{
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	const apiKeyMatch = url.pathname.match(
		/\/admin\/redemptions\/([a-f0-9-]+)\/api-key$/,
	);
	if (apiKeyMatch && req.method === "POST") {
		const programId = apiKeyMatch[1];
		const { program, apiKey } =
			await RedemptionService.rotateProgramApiKey(programId);
		const { data: codes, pagination } = await RedemptionService.getCodes(
			programId,
			1,
		);
		const { data: transactions, pagination: transactionPagination } =
			await RedemptionService.getTransactions(programId, 1, 50);

		return new Response(
			await render("admin-redemption-details", {
				title: `Manage: ${program.name}`,
				user,
				program,
				codes,
				pagination,
				transactions,
				transactionPagination,
				newApiKey: apiKey,
				layout: "main",
			}),
			{
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	const grantMatch = url.pathname.match(
		/\/admin\/redemptions\/([a-f0-9-]+)\/grant$/,
	);
	if (grantMatch && req.method === "POST") {
		const programId = grantMatch[1];
		const formData = await req.formData();
		const amount = Number(formData.get("amount"));
		const unit = Number(formData.get("unit"));

		await RedemptionService.grantProgramStorage({
			programId,
			userId: String(formData.get("userId") || "") || undefined,
			email: String(formData.get("email") || "") || undefined,
			slackId: String(formData.get("slackId") || "") || undefined,
			amountBytes: Math.floor(amount * unit),
			source: "admin",
			actorUserId: user.id,
			reason: String(formData.get("reason") || "") || undefined,
			ipAddress: getClientIp(req),
		});

		return new Response(null, {
			status: 302,
			headers: { Location: `/admin/redemptions/${programId}` },
		});
	}

	// Export Codes (CSV)
	const exportMatch = url.pathname.match(
		/\/admin\/redemptions\/([a-f0-9-]+)\/export$/,
	);
	if (exportMatch && req.method === "POST") {
		const programId = exportMatch[1];
		const program = await RedemptionService.getProgramById(programId);
		if (!program) return new Response("Not found", { status: 404 });

		// Get ALL codes for export (ignoring pagination)
		// We'll need a service method for full dump or loop pages.
		// For simplicity/perf, let's just grab a large batch or add a 'limit: -1' to service.
		// Or just use the getCodes with a large limit.
		const { data: codes } = await RedemptionService.getCodes(
			programId,
			1,
			10000,
		); // Hard limit 10k for now

		let csv = "Code,Link,CreditBytes,Status,RedeemedBy,RedeemedAt\n";
		for (const c of codes) {
			const link = `https://silo.deployor.dev/redeem?code=${c.code}`;
			const creditBytes = c.quotaCreditBytes || program.quotaCreditBytes;
			const status = c.isRedeemed ? "REDEEMED" : "AVAILABLE";
			const redeemedBy = c.redeemedBy || "";
			const redeemedAt = c.redeemedAt ? c.redeemedAt.toISOString() : "";
			csv += `${c.code},${link},${creditBytes},${status},${redeemedBy},${redeemedAt}\n`;
		}

		return new Response(csv, {
			headers: {
				"Content-Type": "text/csv",
				"Content-Disposition": `attachment; filename="${program.prefix}_codes.csv"`,
			},
		});
	}

	return new Response("Not Found", { status: 404 });
}

export async function handleRedeemRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const user = await getCurrentUser(req);

	if (!user) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`,
			},
		});
	}

	if (req.method === "GET") {
		const code = url.searchParams.get("code") || "";
		return new Response(
			await render("redeem", {
				title: "Redeem Code",
				user,
				code,
				layout: "main", // Using main layout which includes nav
			}),
			{
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	if (req.method === "POST") {
		const formData = await req.formData();
		const code = formData.get("code") as string;
		const ip = getClientIp(req);

		try {
			const result = await RedemptionService.redeemCode(code, user.id, ip);

			return new Response(
				await render("redeem", {
					title: "Redeem Code",
					user,
					success: true,
					credits: result.credits,
					programName: result.programName,
					layout: "main",
				}),
				{
					headers: { "Content-Type": "text/html" },
				},
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Redemption failed.";
			return new Response(
				await render("redeem", {
					title: "Redeem Code",
					user,
					error: message,
					code,
					layout: "main",
				}),
				{
					headers: { "Content-Type": "text/html" },
				},
			);
		}
	}

	return new Response("Not Found", { status: 404 });
}
