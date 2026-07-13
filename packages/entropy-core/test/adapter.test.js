import { test } from "node:test";
import assert from "node:assert/strict";
import { EntropySource, CombinedSource, HealthMonitor } from "../src/index.js";

async function pump(src, frames = 240) {
  for (let i = 0; i < frames; i++) {
    src.step(2);
    await new Promise((r) => setImmediate(r));
  }
}

/* ---------------- sampler injection (hardware adapter seam) ---------------- */

test("custom sampler replaces the simulation as the raw source", async () => {
  let calls = 0;
  // stub "hardware": varied bytes so health tests stay green
  const sampler = () => {
    calls++;
    const base = (calls * 37) & 0xff;
    return [base, base ^ 0x5a, (base + 91) & 0xff, base ^ 0xc3, (base + 17) & 0xff, base ^ 0x2f];
  };
  const src = new EntropySource({ sampler });
  await pump(src);
  assert.ok(calls > 200, "sampler must be invoked per step");
  const st = src.status();
  assert.equal(st.healthy, true);
  assert.ok(st.drbgReady, "pipeline downstream of sampler unchanged and seeded");
  const bytes = await src.drbgBytes(16);
  assert.equal(bytes.length, 16);
});

test("a stuck hardware sampler trips RCT exactly like the sim path", async () => {
  const src = new EntropySource({
    sampler: () => [7, 7, 7, 7, 7, 7],
    health: new HealthMonitor({ rctCutoff: 12 }),
  });
  src.step(1);
  src.step(1);
  assert.equal(src.status().healthy, false);
  assert.equal(src.status().failure, "RCT");
});

/* ---------------- CombinedSource (multi-source XOR) ---------------- */

test("combined output is the XOR of component outputs and needs all seeded", async () => {
  const a = new EntropySource();
  const b = new EntropySource();
  const combo = new CombinedSource([a, b]);
  assert.equal(await combo.drbgBytes(8), null, "null before components are seeded");
  await pump(combo, 300);
  assert.ok(combo.status().drbgReady, "both components seeded");
  const out = await combo.drbgBytes(32);
  assert.equal(out.length, 32);
});

test("combined health is the AND of component health", async () => {
  const good = new EntropySource();
  const bad = new EntropySource({ health: new HealthMonitor({ rctCutoff: 3 }) });
  for (let i = 0; i < 5; i++) bad.health.check(0x42);
  const combo = new CombinedSource([good, bad]);
  const st = combo.status();
  assert.equal(st.healthy, false);
  assert.equal(st.failure, "RCT");
});

test("CombinedSource rejects fewer than two sources", () => {
  assert.throws(() => new CombinedSource([new EntropySource()]));
});
