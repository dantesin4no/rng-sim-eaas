import { test } from "node:test";
import assert from "node:assert/strict";
import { EntropySource } from "@entropy/core";

// Contract-level tests on the source the server wraps. Full HTTP tests can
// spawn the server on an ephemeral port; kept in-process here for speed.

async function pump(src, frames = 240) {
  for (let i = 0; i < frames; i++) {
    src.step(2);
    await new Promise((r) => setImmediate(r));
  }
}

test("service source reaches seeded state and serves /v1/random-sized draws", async () => {
  const src = new EntropySource();
  await pump(src);
  assert.ok(src.status().drbgReady);
  const b = await src.drbgBytes(4096); // MAX_BYTES_PER_REQUEST
  assert.equal(b.length, 4096);
});

test("ambient injection perturbs state (non-reproducibility path)", async () => {
  const init = [3.0, 2.6, 2.8, 0.05, -0.02, 0.03];
  const a = new EntropySource({ initialState: init.slice() });
  const b = new EntropySource({ initialState: init.slice() });
  b.injectAmbient([1, 2, 3, 4], 2e-9);
  for (let i = 0; i < 6000; i++) {
    a.step(1);
    b.step(1);
  }
  assert.ok(
    Math.abs(a.state[2] - b.state[2]) > 1e-3,
    "identical seeds must diverge once ambient entropy is injected"
  );
});

test("unhealthy source refuses to credit entropy (503 path)", async () => {
  const src = new EntropySource();
  await pump(src, 60);
  // simulate stuck-source fault
  for (let i = 0; i < 20; i++) src.health.check(0x00);
  assert.equal(src.status().healthy, false);
  const before = src.raw.length;
  src.step(2);
  assert.equal(src.raw.length, before);
});
