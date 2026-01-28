import { readFileSync } from "node:fs";
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
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	GIT_COMMIT_SHA: z.string().optional(),
	GIT_COMMIT_DATE: z.string().optional(),
});

const env = envSchema.parse(process.env);

let gitSha = env.GIT_COMMIT_SHA;
let gitDate = env.GIT_COMMIT_DATE;
let gitMessage: string | undefined;
let buildDate: string | undefined;

if (!gitSha || !gitDate) {
	// 1. Try file first (production build artifact)
	try {
		const gitInfo = JSON.parse(readFileSync("src/git-info.json", "utf-8"));
		if (!gitSha) gitSha = gitInfo.sha;
		if (!gitDate) gitDate = gitInfo.date;
		gitMessage = gitInfo.message;
		buildDate = gitInfo.buildDate;
	} catch {
		// 2. If file fails (local dev), try git command directly
		try {
			const shaProc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
			if (shaProc.success) gitSha = shaProc.stdout.toString().trim();

			const dateProc = Bun.spawnSync([
				"git",
				"show",
				"-s",
				"--format=%cI",
				"HEAD",
			]);
			if (dateProc.success) gitDate = dateProc.stdout.toString().trim();

			const msgProc = Bun.spawnSync([
				"git",
				"show",
				"-s",
				"--format=%s",
				"HEAD",
			]);
			if (msgProc.success) gitMessage = msgProc.stdout.toString().trim();
		} catch {
			// ignore
		}
	}
}

export const config = {
	env: env.NODE_ENV === "production" ? "PROD" : "DEV",
	git: {
		sha: gitSha,
		shortSha: gitSha?.substring(0, 7),
		date: gitDate,
		message: gitMessage,
		buildDate,
	},
	isProduction: env.NODE_ENV === "production",
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
