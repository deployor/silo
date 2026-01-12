import { z } from "zod";

const envSchema = z.object({
	S3_DOMAIN: z.string().default("localhost:3000"),
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID is required"),
	S3_SECRET_ACCESS_KEY: z.string().min(1, "S3_SECRET_ACCESS_KEY is required"),
	S3_ENDPOINT: z.string().min(1, "S3_ENDPOINT is required"),
	S3_BUCKET_NAME: z.string().min(1, "S3_BUCKET_NAME is required"),
	S3_REGION: z.string().default("auto"),
	HC_AUTH_CLIENT_ID: z.string().min(1, "HC_AUTH_CLIENT_ID is required"),
	HC_AUTH_CLIENT_SECRET: z.string().min(1, "HC_AUTH_CLIENT_SECRET is required"),
	HC_AUTH_REDIRECT_URI: z.string().min(1, "HC_AUTH_REDIRECT_URI is required"),
	SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
	SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
	SLACK_FILE_UPLOAD_CHANNEL_ID: z.string().optional(),
	DEV_ACCESS_CODE: z.string().optional(),
});

const env = envSchema.parse(process.env);

export const config = {
	s3Domain: env.S3_DOMAIN,
	databaseUrl: env.DATABASE_URL,
	s3: {
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		endpoint: env.S3_ENDPOINT,
		bucket: env.S3_BUCKET_NAME,
		region: env.S3_REGION,
	},
	hcAuth: {
		clientId: env.HC_AUTH_CLIENT_ID,
		clientSecret: env.HC_AUTH_CLIENT_SECRET,
		redirectUri: env.HC_AUTH_REDIRECT_URI,
	},
	slack: {
		botToken: env.SLACK_BOT_TOKEN,
		signingSecret: env.SLACK_SIGNING_SECRET,
		fileUploadChannelId: env.SLACK_FILE_UPLOAD_CHANNEL_ID,
	},
	devAccessCode: env.DEV_ACCESS_CODE,
};
