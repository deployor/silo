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

	const responseData = await response.json();
	if (!responseData.ok) {
		console.error("Slack API Error (views.publish):", responseData);
		throw new Error(`Slack API Error: ${responseData.error}`);
	}

	return responseData;
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

	const responseData = await response.json();
	if (!responseData.ok) {
		console.error("Slack API Error (views.open):", responseData);
		throw new Error(`Slack API Error: ${responseData.error}`);
	}

	return responseData;
}

export async function getUserInfo(userId: string) {
	const response = await fetch(`${SLACK_API_URL}/users.info?user=${userId}`, {
		headers: {
			Authorization: `Bearer ${config.slack.botToken}`,
		},
	});

	const responseData = await response.json();
	if (!responseData.ok) {
		console.error("Slack API Error (users.info):", responseData);
		// Return null instead of throwing to handle gracefully
		return null;
	}

	return responseData.user;
}
