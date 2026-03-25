import { config } from "../../config";

export async function postMessage(
	channel: string,
	text: string,
	threadTs?: string,
) {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			channel,
			text,
			thread_ts: threadTs,
			unfurl_links: false,
			unfurl_media: false,
		}),
	});
}

export async function postBlocks(
	channel: string,
	blocks: unknown[],
	threadTs?: string,
	username?: string,
	icon_url?: string,
	text: string = "Silo Notification",
	unfurl: boolean = true,
) {
	const formattedBlocks = blocks.map((b) => {
		if (
			b &&
			typeof b === "object" &&
			"build" in b &&
			typeof (b as { build: unknown }).build === "function"
		) {
			try {
				return (b as { build: () => unknown }).build();
			} catch (e) {
				console.error("Failed to build block:", e);
				return b;
			}
		}

		return b;
	});

	const res = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			channel,
			blocks: formattedBlocks,
			thread_ts: threadTs,
			text,
			unfurl_links: unfurl,
			unfurl_media: unfurl,
			username,
			icon_url,
		}),
	});

	if (!res.ok) {
		console.error(
			"Slack API Error (chat.postMessage):",
			res.status,
			res.statusText,
		);
		const responseText = await res.text();
		console.error("Response body:", responseText);
		return;
	}

	const data = await res.json();
	if (!data.ok) {
		console.error("Slack API Error (chat.postMessage):", data.error);
		if (data.errors) {
			console.error(
				"Block validation errors:",
				JSON.stringify(data.errors, null, 2),
			);
		}
	}
}
