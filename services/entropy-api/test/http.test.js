import { test } from "node:test";
import assert from "node:assert/strict";
import { EntropySource } from "@entropy/core";
import { buildServer, RateLimiter } from "../src/server.js";

async function seededSource() {
  const src = new EntropySource();
  for (let i = 0; i < 300; i++) {
    src.step(2);
    await new Promise((r) => setImmediate(r));
  }
  return src;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/* ---------------- RateLimiter unit ---------------- */

test("rate limiter: request cap trips, refills over time", () => {
  let t = 0;
  const rl = new RateLimiter({ reqPerMin: 3, bytesPerMin: 1e9, now: () => t });
  assert.equal(rl.take("a", 1), null);
  assert.equal(rl.take("a", 1), null);
  assert.equal(rl.take("a", 1), null);
  assert.ok(rl.take("a", 1) > 0, "4th request limited");
  t += 60000; // full refill
  assert.equal(rl.take("a", 1), null);
  assert.equal(rl.take("b", 1), null, "different IP has its own bucket");
});

test("rate limiter: byte cap trips independently", () => {
  let t = 0;
  const rl = new RateLimiter({ reqPerMin: 1000, bytesPerMin: 100, now: () => t });
  assert.equal(rl.take("a", 80), null);
  assert.ok(rl.take("a", 80) > 0, "byte budget exhausted");
});

/* ---------------- HTTP: CORS, endpoints, 429 ---------------- */

test("HTTP: CORS headers present, OPTIONS preflight returns 204", async () => {
  const src = await seededSource();
  const server = buildServer(src, { corsOrigin: "http://example.test" });
  const port = await listen(server);
  try {
    const pre = await fetch(`http://127.0.0.1:${port}/v1/random`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://example.test");
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://example.test");
  } finally {
    server.close();
  }
});

test("HTTP: /v1/random serves hex per contract; /v1/int in range", async () => {
  const src = await seededSource();
  const server = buildServer(src);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/random?bytes=32`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.bytes, 32);
    assert.match(body.data, /^[0-9a-f]{64}$/);
    const i = await (await fetch(`http://127.0.0.1:${port}/v1/int?max=20`)).json();
    assert.ok(i.value >= 0 && i.value < 20);
  } finally {
    server.close();
  }
});

test("HTTP: rate limit returns 429 with retry_after_ms", async () => {
  const src = await seededSource();
  const server = buildServer(src, {
    limiter: new RateLimiter({ reqPerMin: 2, bytesPerMin: 1e9 }),
  });
  const port = await listen(server);
  try {
    await fetch(`http://127.0.0.1:${port}/v1/random?bytes=8`);
    await fetch(`http://127.0.0.1:${port}/v1/random?bytes=8`);
    const r = await fetch(`http://127.0.0.1:${port}/v1/random?bytes=8`);
    assert.equal(r.status, 429);
    const body = await r.json();
    assert.ok(body.retry_after_ms > 0);
  } finally {
    server.close();
  }
});

test("HTTP: unseeded source refuses with 503, never weaker fallback", async () => {
  const src = new EntropySource(); // not pumped: DRBG unseeded
  const server = buildServer(src);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/random?bytes=8`);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error, /not yet seeded/);
  } finally {
    server.close();
  }
});

test("HTTP: /v1/ambient accepts hex, rejects non-hex", async () => {
  const src = await seededSource();
  const server = buildServer(src);
  const port = await listen(server);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/ambient`, { method: "POST", body: "deadbeef" });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).accepted, 4);
    const bad = await fetch(`http://127.0.0.1:${port}/v1/ambient`, { method: "POST", body: "not-hex!" });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

/* ---------------- structured logging ---------------- */

test("HTTP: structured log lines carry request id, never entropy values", async () => {
  const src = await seededSource();
  const lines = [];
  const server = buildServer(src, { log: (e) => lines.push(e) });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/random?bytes=32`);
    const headerId = r.headers.get("x-request-id");
    await r.json();
    await new Promise((res) => setTimeout(res, 50)); // let finish-hook fire
    assert.equal(lines.length, 1);
    const e = lines[0];
    assert.equal(e.id, headerId, "log id matches x-request-id header");
    assert.equal(e.method, "GET");
    assert.equal(e.path, "/v1/random");
    assert.equal(e.status, 200);
    assert.ok(e.ms >= 0);
    const serialized = JSON.stringify(e);
    assert.ok(!("data" in e) && !serialized.match(/[0-9a-f]{32,}/), "no entropy in logs");
  } finally {
    server.close();
  }
});
