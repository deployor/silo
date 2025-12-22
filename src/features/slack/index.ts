import { verifySlackRequest } from "./verify";
import { handleAppHomeOpened, handleInteraction } from "./handlers";

export async function handleSlackRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Verify request signature
  const isValid = await verifySlackRequest(req);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const contentType = req.headers.get("content-type");

  if (contentType === "application/json") {
    // Event Subscription
    const body = await req.json();

    // URL Verification Challenge
    if (body.type === "url_verification") {
      return new Response(body.challenge, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Event Callback
    if (body.type === "event_callback") {
      const event = body.event;
      if (event.type === "app_home_opened") {
        // Handle App Home Opened
        // We don't await this to return 200 OK quickly to Slack
        handleAppHomeOpened(event).catch(console.error);
      }
    }

    return new Response("OK", { status: 200 });
  } else if (contentType === "application/x-www-form-urlencoded") {
    // Interactivity (Block Actions, Modal Submissions)
    const formData = await req.formData();
    const payloadStr = formData.get("payload");

    if (typeof payloadStr === "string") {
      const payload = JSON.parse(payloadStr);
      
      // Handle Interaction
      const result = await handleInteraction(payload);

      if (result) {
          return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" }
          });
      }
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Bad Request", { status: 400 });
}
