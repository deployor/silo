import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const config = {
    endpoint: "https://silo.deployor.dev",
    region: "auto",
    credentials: {
        accessKeyId: "SILO_P_AK_856F8AFD9B57D232B94F",
        secretAccessKey: "SILO_P_SK_2ad9f66fc8f305916284b516daecd99b6d7990d3"
    },
    bucket: "testingbucketforredis",
    key: "stress-test-file.png"
};

const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
    // Increase max sockets for stress testing
    maxAttempts: 3,
});

// Test Configuration
const TEST_DURATION_MS = 10000; // Run for 10 seconds
const CONCURRENCY = 50; // Number of concurrent requests

async function measure(name: string, fn: () => Promise<any>) {
    const start = performance.now();
    try {
        const result = await fn();
        const end = performance.now();
        const duration = end - start;
        return { success: true, duration, result };
    } catch (error) {
        return { success: false, duration: 0, error };
    }
}

function calculateStats(durations: number[]) {
    if (durations.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    durations.sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = sum / durations.length;
    const min = durations[0];
    const max = durations[durations.length - 1];
    const p50 = durations[Math.floor(durations.length * 0.50)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];
    return { min, max, avg, p50, p95, p99 };
}

async function run() {
    console.log("🚀 Starting Heavy Duty S3 Cache Performance Verification...");
    console.log(`Endpoint: ${config.endpoint}`);
    console.log(`Bucket: ${config.bucket}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Duration: ${TEST_DURATION_MS}ms`);

    // Generate random buffer
    // Use > 10MB to bypass Redis cache and force Disk Cache
    const body = new Uint8Array(1024 * 1024 * 15); // 15MB
    for(let i=0; i<body.length; i++) body[i] = Math.floor(Math.random() * 255);

    // 1. Prime Cache (PUT)
    console.log("\n📦 Priming cache (PUT)...");
    await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
        Body: body,
        ContentType: "image/png"
    }));
    console.log("✅ Cache primed.");

    // 2. Warmup (ensure it's in cache)
    console.log("\n🔥 Warming up (GET)...");
    await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: config.key }));
    await new Promise(r => setTimeout(r, 1000)); // wait a bit

    // 3. Stress Test
    console.log("\n⚡ Starting Stress Test...");
    const latencies: number[] = [];
    let errors = 0;
    let completed = 0;
    const startTime = performance.now();
    let isRunning = true;

    // Worker function for concurrency
    const worker = async () => {
        while (isRunning) {
            if (performance.now() - startTime > TEST_DURATION_MS) {
                break;
            }

            const { success, duration } = await measure("GET", async () => {
                const response = await client.send(new GetObjectCommand({
                    Bucket: config.bucket,
                    Key: config.key
                }));
                // Fully consume the body to measure actual transfer time
                await response.Body?.transformToByteArray();
            });

            if (success) {
                latencies.push(duration);
            } else {
                errors++;
            }
            completed++;
        }
    };

    // Launch workers
    const workers = Array(CONCURRENCY).fill(null).map(() => worker());
    
    // Timer to stop test
    setTimeout(() => {
        isRunning = false;
    }, TEST_DURATION_MS);

    await Promise.all(workers);
    
    const endTime = performance.now();
    const totalTime = endTime - startTime;
    const rps = (completed / (totalTime / 1000)).toFixed(2);
    const stats = calculateStats(latencies);

    console.log("\n📊 Results:");
    console.log(`Total Requests: ${completed}`);
    console.log(`Successful: ${latencies.length}`);
    console.log(`Failed: ${errors}`);
    console.log(`Throughput: ${rps} req/sec`);
    console.log(`\n⏱️ Latency Distribution (ms):`);
    console.log(`Min: ${stats.min.toFixed(2)}`);
    console.log(`Max: ${stats.max.toFixed(2)}`);
    console.log(`Avg: ${stats.avg.toFixed(2)}`);
    console.log(`P50 (Median): ${stats.p50.toFixed(2)}`);
    console.log(`P95: ${stats.p95.toFixed(2)}`);
    console.log(`P99: ${stats.p99.toFixed(2)}`);

}

run().catch(console.error);
