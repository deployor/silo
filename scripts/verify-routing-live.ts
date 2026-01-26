
import { spawn } from "bun";

async function runTest() {
    console.log("Starting server for verification...");
    
    const serverProc = spawn({
        cmd: ["bun", "run", "src/index.ts"],
        env: {
            ...process.env,
            PORT: "3001",
            S3_DOMAIN: "localhost:3001", // Match the test port
            DATABASE_URL: "postgres://user:pass@localhost:5432/db", // Dummy
            S3_ACCESS_KEY_ID: "test",
            S3_SECRET_ACCESS_KEY: "test",
            S3_ENDPOINT: "http://localhost:9000",
            S3_BUCKET_NAME: "test-bucket",
            HC_AUTH_CLIENT_ID: "test",
            HC_AUTH_CLIENT_SECRET: "test",
            HC_AUTH_REDIRECT_URI: "http://localhost:3001/auth/callback",
            SLACK_BOT_TOKEN: "test",
            SLACK_SIGNING_SECRET: "test",
            DISABLE_S3_STATS: "1"
        },
        stdout: "pipe",
        stderr: "pipe"
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log("Sending request to http://localhost:3001/ysws");
    try {
        const res = await fetch("http://localhost:3001/ysws");
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log(`Response Start: ${text.substring(0, 100)}...`);
        
        if (res.status === 302 && res.headers.get("location")?.includes("/auth/login")) {
             console.log("SUCCESS: Redirected to login (means it hit the app handler, not S3)");
        } else if (text.includes("Ship to Earn")) {
             console.log("SUCCESS: Rendered YSWS page");
        } else if (text.includes("<Error>")) {
             console.log("FAILURE: Received S3 Error XML");
        } else {
             console.log("UNKNOWN RESPONSE");
        }

    } catch (e) {
        console.error("Request failed:", e);
    } finally {
        serverProc.kill();
    }
}

runTest();
