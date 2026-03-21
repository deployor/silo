CREATE TABLE "bucket_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"invitee_user_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"permissions" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"accepted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bucket_collaborator_bucket_user_idx" ON "bucket_collaborators" USING btree ("bucket_id","invitee_user_id");
--> statement-breakpoint
CREATE INDEX "bucket_collaborator_invitee_idx" ON "bucket_collaborators" USING btree ("invitee_user_id","status");
--> statement-breakpoint
CREATE INDEX "bucket_collaborator_inviter_idx" ON "bucket_collaborators" USING btree ("invited_by_user_id");
--> statement-breakpoint
CREATE INDEX "bucket_collaborator_status_idx" ON "bucket_collaborators" USING btree ("status");
