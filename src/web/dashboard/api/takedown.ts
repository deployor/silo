import { postMessage } from "../../../integrations/slack/message-handler";
import {
	errorResponse,
	getClientIp,
	jsonResponse,
} from "../../../lib/api-utils";
import { takedownReportSchema } from "../../../lib/validation";

const TAKEDOWN_REPORT_RECIPIENT = "U078PH0GBEH";
const REPORT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 3;

const reportRateLimitStore = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const existing = reportRateLimitStore.get(ip) || [];
	const recent = existing.filter((ts) => now - ts < REPORT_WINDOW_MS);

	if (recent.length >= MAX_REPORTS_PER_WINDOW) {
		reportRateLimitStore.set(ip, recent);
		return true;
	}

	recent.push(now);
	reportRateLimitStore.set(ip, recent);
	return false;
}

function shorten(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen - 3)}...`;
}

export async function handleTakedownReport(req: Request): Promise<Response> {
	if (req.method !== "POST") {
		return errorResponse("Method not allowed", 405);
	}

	const ip = getClientIp(req);
	if (isRateLimited(ip)) {
		return errorResponse("Too many reports. Please try again later.", 429);
	}

	const body = await req.json().catch(() => null);
	const parsed = takedownReportSchema.safeParse(body);
	if (!parsed.success) {
		return errorResponse(
			parsed.error.issues[0]?.message || "Invalid report",
			400,
		);
	}

	const { url, title, description, email, website } = parsed.data;

	// Honeypot field: silently accept bot submissions without forwarding.
	if (website && website.trim().length > 0) {
		return jsonResponse({ ok: true });
	}

	const slackText = [
		":rotating_light: *New takedown report submitted*",
		`*URL:* ${shorten(url, 500)}`,
		`*Title:* ${shorten(title, 300)}`,
		`*Reporter Email:* ${shorten(email, 320)}`,
		`*Source IP:* ${shorten(ip, 80)}`,
		"*Description:*",
		shorten(description, 3000),
	].join("\n");

	try {
		await postMessage(TAKEDOWN_REPORT_RECIPIENT, slackText);
	} catch (error) {
		console.error("Failed to forward takedown report to Slack", error);
		return errorResponse("Failed to submit report", 500);
	}

	return jsonResponse({ ok: true });
}
