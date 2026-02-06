
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

test("Verify landing page refocus", async () => {
    const landingPath = path.join(process.cwd(), "src/views/landing.hbs");
    const content = fs.readFileSync(landingPath, "utf-8");

    assert.ok(content.includes("SHIP IT."), "Header text should be updated to 'SHIP IT.'");
    assert.ok(content.includes("YSWS object storage platform"), "Description should mention YSWS");
    assert.ok(content.includes("Start Shipping"), "Login button should be 'Start Shipping'");
});

test("Verify navigation updates", async () => {
    const layoutPath = path.join(process.cwd(), "src/views/layouts/main.hbs");
    const content = fs.readFileSync(layoutPath, "utf-8");

    assert.ok(content.includes("SHIP IT."), "Nav brand should be updated to 'SHIP IT.'");
    assert.ok(content.includes('href="/ysws"'), "YSWS link should be present");
    assert.ok(content.includes("text-white hover:text-hc-green"), "YSWS link should be highlighted");
});
