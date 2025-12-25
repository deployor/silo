import { validateOrigin } from "../src/lib/security";
import { config } from "../src/config";

// Mock Request
function createRequest(headers: Record<string, string>): Request {
    return {
        headers: {
            get: (key: string) => headers[key] || null
        }
    } as unknown as Request;
}

console.log("Testing Origin Validation...");

// Test 1: No Origin or Referer (Allowed for non-browser clients)
const req1 = createRequest({});
if (validateOrigin(req1) === true) {
    console.log("✅ Test 1 Passed: No headers allowed");
} else {
    console.error("❌ Test 1 Failed");
}

// Test 2: Valid Origin
const req2 = createRequest({ "Origin": `https://${config.s3Domain}` });
if (validateOrigin(req2) === true) {
    console.log("✅ Test 2 Passed: Valid Origin allowed");
} else {
    console.error("❌ Test 2 Failed");
}

// Test 3: Invalid Origin
const req3 = createRequest({ "Origin": "https://evil.com" });
if (validateOrigin(req3) === false) {
    console.log("✅ Test 3 Passed: Invalid Origin blocked");
} else {
    console.error("❌ Test 3 Failed");
}

// Test 4: Valid Referer
const req4 = createRequest({ "Referer": `https://${config.s3Domain}/dashboard` });
if (validateOrigin(req4) === true) {
    console.log("✅ Test 4 Passed: Valid Referer allowed");
} else {
    console.error("❌ Test 4 Failed");
}

// Test 5: Invalid Referer
const req5 = createRequest({ "Referer": "https://evil.com/dashboard" });
if (validateOrigin(req5) === false) {
    console.log("✅ Test 5 Passed: Invalid Referer blocked");
} else {
    console.error("❌ Test 5 Failed");
}

// Test 6: Localhost (Development)
const req6 = createRequest({ "Origin": "http://localhost:3000" });
if (validateOrigin(req6) === true) {
    console.log("✅ Test 6 Passed: Localhost allowed");
} else {
    console.error("❌ Test 6 Failed");
}
