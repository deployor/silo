import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config";

export async function verifySlackRequest(req: Request): Promise<boolean> {
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!signature || !timestamp) {
    return false;
  }

  // Check if timestamp is too old (replay attack protection)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    return false;
  }

  const body = await req.clone().text();
  const sigBasestring = `v0:${timestamp}:${body}`;

  const mySignature =
    "v0=" +
    createHmac("sha256", config.slack.signingSecret)
      .update(sigBasestring)
      .digest("hex");

  // Timing safe comparison
  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(mySignature),
  );
}
