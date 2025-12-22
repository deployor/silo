import { db } from "../../db";
import { users, buckets, bucketKeys } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { publishView, openModal } from "./client";
import { homeView, createBucketModal, manageKeysModal, deleteBucketWarningModal } from "./views";
import { config } from "../../config";

export async function handleAppHomeOpened(event: any) {
  const slackId = event.user;

  // Find user by Slack ID
  const user = await db
    .select()
    .from(users)
    .where(eq(users.slackId, slackId))
    .limit(1);

  if (user.length === 0) {
    // User not found, show welcome/login message
    await publishView(slackId, {
      type: "home",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Welcome to Cargo!* :wave:\n\nPlease <https://${config.s3Domain}/auth/login|log in via the dashboard> first to link your Slack account.`,
          },
        },
      ],
    });
    return;
  }

  const userBuckets = await db
    .select()
    .from(buckets)
    .where(eq(buckets.userId, user[0].id));

  await publishView(slackId, homeView(user[0], userBuckets));
}

export async function handleInteraction(payload: any) {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.slackId, payload.user.id))
    .limit(1);

  if (user.length === 0) return; // Should not happen if they are interacting

  const action = payload.actions?.[0];
  let actionId = action?.action_id;
  let actionValue = action?.value;

  // Handle Overflow Menu
  if (actionId === "bucket_overflow_action") {
      const parts = action.selected_option.value.split(":");
      actionId = parts[0];
      actionValue = parts[1];
  }

  // 1. Open Create Bucket Modal
  if (actionId === "open_create_bucket_modal") {
    await openModal(payload.trigger_id, createBucketModal());
  }

  // 2. Handle Create Bucket Submission
  if (payload.type === "view_submission" && payload.view.callback_id === "create_bucket_submission") {
    const bucketName = payload.view.state.values.bucket_name_block.bucket_name_input.value;

    if (!bucketName || !/^[a-z0-9-]+$/.test(bucketName)) {
        // We should return an error to the modal, but for simplicity we'll just let it fail silently or log
        // Ideally we return a response_action: "errors"
        return {
            response_action: "errors",
            errors: {
                bucket_name_block: "Invalid name. Use lowercase letters, numbers, and hyphens."
            }
        };
    }

    // Check limit
    const userBuckets = await db.select().from(buckets).where(eq(buckets.userId, user[0].id));
    if (userBuckets.length >= 50) {
         return {
            response_action: "errors",
            errors: {
                bucket_name_block: "Bucket limit reached (50)."
            }
        };
    }

    // Check global uniqueness
    const existing = await db.select().from(buckets).where(eq(buckets.name, bucketName)).limit(1);
    if (existing.length > 0) {
        return {
            response_action: "errors",
            errors: {
                bucket_name_block: "Bucket name already taken."
            }
        };
    }

    // Create bucket
    const newBucket = await db.insert(buckets).values({
        name: bucketName,
        userId: user[0].id,
        isPublic: false
    }).returning();

    // Create initial keys
    const accessKey = "CK" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const secretKey = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

    await db.insert(bucketKeys).values({
        bucketId: newBucket[0].id,
        accessKey,
        secretKey
    });

    // Refresh Home
    // We can't await this because we need to return the ack immediately for the modal to close
    // But we can fire and forget
    handleAppHomeOpened({ user: payload.user.id });
    
    // Show the keys immediately
    const keys = await db.select().from(bucketKeys).where(eq(bucketKeys.bucketId, newBucket[0].id));
    const newKeyObj = { accessKey, secretKey };

    return {
        response_action: "push",
        view: manageKeysModal(newBucket[0], keys, newKeyObj)
    };
  }

  // 3. Open Manage Keys Modal
  if (actionId === "manage_keys") {
      const bucketId = actionValue;
      const bucket = await db.select().from(buckets).where(and(eq(buckets.id, bucketId), eq(buckets.userId, user[0].id))).limit(1);
      
      if (bucket.length > 0) {
          const keys = await db.select().from(bucketKeys).where(eq(bucketKeys.bucketId, bucketId));
          await openModal(payload.trigger_id, manageKeysModal(bucket[0], keys));
      }
  }

  // 4. Generate New Key (inside modal)
  if (actionId === "generate_key") {
      const bucketId = actionValue;
      // Verify ownership
      const bucket = await db.select().from(buckets).where(and(eq(buckets.id, bucketId), eq(buckets.userId, user[0].id))).limit(1);
      
      if (bucket.length > 0) {
        const accessKey = "CK" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
        const secretKey = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

        await db.insert(bucketKeys).values({
            bucketId: bucketId,
            accessKey,
            secretKey
        });

        // Update the modal
        const keys = await db.select().from(bucketKeys).where(eq(bucketKeys.bucketId, bucketId));
        const newKeyObj = { accessKey, secretKey };
        
        // We need to update the view using response_action or views.update
        // Since this is a button click, we should use views.update
        // But we don't have the view_id easily here unless we pass it or use the payload
        // Actually, for button clicks in modals, we can return a "update" action? No, that's for block actions.
        // We should call views.update
        
        const response = await fetch(`https://slack.com/api/views.update`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.slack.botToken}`,
            },
            body: JSON.stringify({
                view_id: payload.view.id,
                view: manageKeysModal(bucket[0], keys, newKeyObj)
            })
        });
      }
  }

  // 5. Delete Key (inside modal)
  if (actionId === "delete_key") {
      const keyId = actionValue;
      const bucketId = payload.view.private_metadata; // We stored bucketId here

      // Verify ownership via bucket
      const bucket = await db.select().from(buckets).where(and(eq(buckets.id, bucketId), eq(buckets.userId, user[0].id))).limit(1);
      
      if (bucket.length > 0) {
          await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

          // Update modal
          const keys = await db.select().from(bucketKeys).where(eq(bucketKeys.bucketId, bucketId));
          
          await fetch(`https://slack.com/api/views.update`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.slack.botToken}`,
            },
            body: JSON.stringify({
                view_id: payload.view.id,
                view: manageKeysModal(bucket[0], keys)
            })
        });
      }
  }

  // 6. Delete Bucket Attempt (Home Tab)
  if (actionId === "delete_bucket") {
      await openModal(payload.trigger_id, deleteBucketWarningModal());
  }

  // 7. Toggle Bucket Public/Private
  if (actionId === "toggle_public") {
      const bucketId = actionValue;
      const bucket = await db.select().from(buckets).where(and(eq(buckets.id, bucketId), eq(buckets.userId, user[0].id))).limit(1);

      if (bucket.length > 0) {
          await db.update(buckets)
              .set({ isPublic: !bucket[0].isPublic })
              .where(eq(buckets.id, bucketId));

          // Refresh Home
          await handleAppHomeOpened({ user: payload.user.id });
      }
  }

}
