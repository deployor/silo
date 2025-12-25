import { config } from "../../config";

const SLACK_API_URL = "https://slack.com/api";

export async function publishView(userId: string, view: unknown) {
	const response = await fetch(`${SLACK_API_URL}/views.publish`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			user_id: userId,
			view: view,
		}),
	});

	const data = await response.json();
	if (!data.ok) {
		console.error("Slack API Error (views.publish):", data);
		throw new Error(`Slack API Error: ${data.error}`);
	}

	return data;
}

export async function openModal(triggerId: string, view: unknown) {
	const response = await fetch(`${SLACK_API_URL}/views.open`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			trigger_id: triggerId,
			view: view,
		}),
	});

	const data = await response.json();
	if (!data.ok) {
		console.error("Slack API Error (views.open):", data);
		throw new Error(`Slack API Error: ${data.error}`);
	}

	return data;
}
