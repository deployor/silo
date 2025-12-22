export const config = {
	s3Domain: process.env.S3_DOMAIN || "localhost:3000",
	databaseUrl: process.env.DATABASE_URL,
	s3: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
		endpoint: process.env.S3_ENDPOINT,
		bucket: process.env.S3_BUCKET_NAME,
		region: process.env.S3_REGION || "auto",
	},
	hcAuth: {
		clientId: process.env.HC_AUTH_CLIENT_ID as string,
		clientSecret: process.env.HC_AUTH_CLIENT_SECRET as string,
		redirectUri: process.env.HC_AUTH_REDIRECT_URI as string,
	},
	slack: {
		botToken: process.env.SLACK_BOT_TOKEN as string,
		signingSecret: process.env.SLACK_SIGNING_SECRET as string,
	},
};
