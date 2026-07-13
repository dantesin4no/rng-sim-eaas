// Browser e2e smoke (plan 006): drive the REAL hosted demo's Connect button
// with headless Chromium and prove server-side DRBG state moved.
//
// On-demand, network-dependent — NOT part of `npm test`:
//   npm run e2e -w dashboard
//
// Env:
//   E2E_URL  — page to drive (default: the GitHub Pages demo)

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const PAGE_URL = process.env.E2E_URL || "https://dantesin4no.github.io/rng-sim-eaas/";

// The free-tier backend cold-starts and the pool must credit min-entropy
// before the DRBG seeds, so waits are generous by design (plans/005).
const SEED_TIMEOUT_MS = 120_000;

async function drbgBytesOut(apiUrl) {
  const r = await fetch(`${apiUrl}/v1/health`, { cache: "no-store" });
  assert.equal(r.status, 200, `GET /v1/health -> ${r.status}`);
  const body = await r.json();
  assert.equal(typeof body.drbgBytesOut, "number", "health has drbgBytesOut");
  return body.drbgBytesOut;
}

test("hosted demo: Connect draws through the live service", { timeout: 300_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // The bundle must ship pointing at a real https API — a localhost or
    // empty value here is exactly the shipped-dead-panel failure this repo
    // has already had once (see pages.yml's API_URL guard).
    const input = page.getByPlaceholder("https://your-entropy-api.example.com");
    const apiUrl = (await input.inputValue()).replace(/\/+$/, "");
    assert.match(apiUrl, /^https:\/\//, `panel URL is https (got "${apiUrl}")`);
    assert.doesNotMatch(apiUrl, /localhost|127\.0\.0\.1/, "panel URL is not localhost");

    const before = await drbgBytesOut(apiUrl);

    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // The local-sim panel renders its own HEALTHY/SEEDED stats, so scope to
    // the service panel: the innermost div that contains both the panel
    // title and the status text we're waiting for.
    const svcPanelWith = (text) =>
      page
        .locator("div")
        .filter({ has: page.getByText("Live service — @entropy/api") })
        .filter({ hasText: text })
        .last();
    await svcPanelWith("HEALTHY").waitFor({ timeout: SEED_TIMEOUT_MS });
    const svcPanel = svcPanelWith("SEEDED");
    await svcPanel.waitFor({ timeout: SEED_TIMEOUT_MS });

    // Draw 16 bytes through the service. Success logs under the kind label
    // "hex128", which nothing else in the UI renders; the error path logs
    // under "hex" instead, so a refusal cannot satisfy this wait. The local
    // sim panel has its own 128-bit hex button, hence the panel scope.
    await svcPanel.getByRole("button", { name: "128-bit hex", exact: true }).click();
    const entry = svcPanel.getByText("hex128", { exact: true });
    await entry.waitFor({ timeout: 15_000 });
    const hex = (await entry.locator("xpath=following-sibling::span[1]").textContent()).trim();
    assert.match(hex, /^[0-9a-f]{32}$/, `service log shows 16 drawn bytes (got "${hex}")`);

    const after = await drbgBytesOut(apiUrl);
    assert.ok(
      after >= before + 16 || before > after,
      `drbgBytesOut ${before} -> ${after}: expected +16 or more`
    );
    if (before > after) {
      // Counters are in-memory and the free tier recycles/redeploys; a
      // backwards counter means a fresh process, not a lost draw. The hex
      // assertion above already proved the draw itself succeeded.
      console.log(`note: service recycled mid-test (drbgBytesOut ${before} -> ${after}); ` +
        `draw verified via the panel's hex128 entry instead of the counter delta`);
    } else {
      console.log(`drbgBytesOut ${before} -> ${after} (draw of 16 visible server-side)`);
    }
    console.log(`page: ${PAGE_URL}\napi:  ${apiUrl}\ndrawn: ${hex}`);
  } finally {
    await browser.close();
  }
});
