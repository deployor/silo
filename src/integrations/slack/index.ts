import { handleAppHomeOpened, handleInteraction } from "./handlers";
import { handleMessage } from "./message-handler";
import { verifySlackRequest } from "./verify";

export async function handleSlackRequest(req: Request): Promise<Response> {
	if (req.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const isValid = await verifySlackRequest(req);
	if (!isValid) {
		return new Response("Invalid signature", { status: 401 });
	}

	const contentType = req.headers.get("content-type");

	if (contentType === "application/json") {
		const body = await req.json();

		if (body.type === "url_verification") {
			return new Response(body.challenge, {
				headers: { "Content-Type": "text/plain" },
			});
		}

		if (body.type === "event_callback") {
			const event = body.event;
			if (event.type === "app_home_opened") {
				handleAppHomeOpened(event).catch(console.error);
			}
			if (event.type === "message") {
				handleMessage(event).catch(console.error);
			}
		}

		return new Response("OK", { status: 200 });
	} else if (contentType === "application/x-www-form-urlencoded") {
		const formData = await req.formData();
		const payloadStr = formData.get("payload");

		if (typeof payloadStr === "string") {
			const payload = JSON.parse(payloadStr);

			const result = await handleInteraction(payload);

			if (result) {
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		return new Response("OK", { status: 200 });
	}

	return new Response("Bad Request", { status: 400 });
}
