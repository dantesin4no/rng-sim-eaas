import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makePendulum,
  HealthMonitor,
  EntropyPool,
  HmacDrbg,
  EntropySource,
  minEntropyMCV,
} from "../src/index.js";

/* ---------------- physics ---------------- */

test("mass matrix is symmetric and positive on the diagonal", () => {
  const p = makePendulum();
  const th = [2.9, 2.1, 3.4];
  const A = p.massMatrix(th);
  for (let i = 0; i < 3; i++) {
    assert.ok(A[i][i] > 0, `A[${i}][${i}] must be positive`);
    for (let j = 0; j < 3; j++)
      assert.ok(Math.abs(A[i][j] - A[j][i]) < 1e-12, "symmetry");
  }
});

test("RK4 conserves energy (frictionless invariant)", () => {
  const p = makePendulum();
  let s = [Math.PI - 0.3, Math.PI + 0.5, Math.PI - 0.7, 0.1, -0.05, 0.08];
  const E0 = p.energy(s);
  const dt = 1 / 240;
  for (let i = 0; i < 5000; i++) s = p.rk4Step(s, dt);
  const E1 = p.energy(s);
  const rel = Math.abs(E1 - E0) / (Math.abs(E0) + 1);
  assert.ok(rel < 1e-4, `energy drift ${rel} exceeds 1e-4 over 5000 steps`);
});

test("sensitive dependence: 1e-9 rad perturbation fully diverges", () => {
  const p = makePendulum();
  let a = [Math.PI - 0.3, Math.PI + 0.5, Math.PI - 0.7, 0.1, -0.05, 0.08];
  let b = a.slice();
  b[0] += 1e-9;
  const dt = 1 / 240;
  for (let i = 0; i < 20000; i++) {
    a = p.rk4Step(a, dt);
    b = p.rk4Step(b, dt);
  }
  const sep = Math.abs(a[2] - b[2]);
  assert.ok(sep > 1e-2, `trajectories should diverge, got separation ${sep}`);
});

/* ---------------- health tests ---------------- */

test("RCT trips on a stuck source at the cutoff, not before", () => {
  const h = new HealthMonitor({ rctCutoff: 12 });
  for (let i = 0; i < 11; i++) h.check(0x42);
  assert.equal(h.failure, null, "must not trip below cutoff");
  h.check(0x42);
  assert.equal(h.failure, "RCT");
});

test("RCT does not trip on varied input", () => {
  const h = new HealthMonitor();
  for (let i = 0; i < 10000; i++) h.check(i & 0xff);
  assert.equal(h.failure, null);
});

test("APT trips on a heavily biased stream", () => {
  const h = new HealthMonitor({ aptWindow: 512, aptCutoff: 84 });
  // 1-in-4 occurrence of the window's first value: far above H>=4 expectation.
  for (let i = 0; i < 512; i++) h.check(i % 4 === 0 ? 7 : (i * 37) & 0xff);
  assert.equal(h.failure, "APT");
});

test("failure latches until reset", () => {
  const h = new HealthMonitor({ rctCutoff: 3 });
  h.check(1); h.check(1); h.check(1);
  assert.equal(h.failure, "RCT");
  h.check(2); h.check(3);
  assert.equal(h.failure, "RCT", "latched");
  h.reset();
  assert.equal(h.failure, null);
});

/* ---------------- pool ---------------- */

test("pool reads what was written, refuses underflow", () => {
  const pool = new EntropyPool(16);
  pool.write(new Uint8Array([1, 2, 3, 4]));
  assert.equal(pool.count, 4);
  assert.equal(pool.read(8), null, "underflow must return null");
  const out = pool.read(4);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4]);
  assert.equal(pool.count, 0);
});

test("pool folds (XOR) when full rather than discarding", () => {
  const pool = new EntropyPool(4);
  pool.write(new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]));
  pool.write(new Uint8Array([0x55, 0x55, 0x55, 0x55])); // full: folds
  const out = pool.read(4);
  assert.deepEqual(Array.from(out), [0xff, 0xff, 0xff, 0xff]);
});

/* ---------------- DRBG ---------------- */

test("DRBG is deterministic given identical seed (audit property)", async () => {
  const seed = new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff);
  const a = new HmacDrbg();
  const b = new HmacDrbg();
  await a.instantiate(seed);
  await b.instantiate(seed);
  const x = await a.generate(64);
  const y = await b.generate(64);
  assert.deepEqual(Array.from(x), Array.from(y));
});

test("DRBG output diverges after differing additional input", async () => {
  const seed = new Uint8Array(48).fill(9);
  const a = new HmacDrbg();
  const b = new HmacDrbg();
  await a.instantiate(seed);
  await b.instantiate(seed);
  const x = await a.generate(32, new Uint8Array([1]));
  const y = await b.generate(32, new Uint8Array([2]));
  assert.notDeepEqual(Array.from(x), Array.from(y));
});

test("DRBG enforces seed length and instantiation order", async () => {
  const d = new HmacDrbg();
  await assert.rejects(() => d.instantiate(new Uint8Array(16)));
  await assert.rejects(() => d.generate(8));
});

test("DRBG output passes a monobit smoke test", async () => {
  const d = new HmacDrbg();
  await d.instantiate(new Uint8Array(48).map((_, i) => i));
  const out = await d.generate(4096);
  let ones = 0;
  for (const byte of out) {
    let b = byte;
    while (b) { ones += b & 1; b >>= 1; }
  }
  const frac = ones / (4096 * 8);
  assert.ok(Math.abs(frac - 0.5) < 0.02, `bit balance ${frac} outside 48-52%`);
});

/* ---------------- end-to-end source ---------------- */

test("EntropySource seeds its DRBG and serves bytes", async () => {
  const src = new EntropySource();
  // ~240 samples * 6 raw bytes -> ~22 conditioning blocks -> plenty for 48 B seed
  for (let i = 0; i < 240; i++) {
    src.step(2);
    // conditioning is async: yield the microtask queue so digests land
    await new Promise((r) => setImmediate(r));
  }
  const st = src.status();
  assert.equal(st.healthy, true);
  assert.ok(st.condBytes >= 64, `conditioned ${st.condBytes} bytes`);
  assert.ok(st.drbgReady, "DRBG should be seeded");
  const bytes = await src.drbgBytes(32);
  assert.equal(bytes.length, 32);
  const v = await src.randInt(6);
  assert.ok(v >= 0 && v < 6);
});

test("EntropySource stops crediting entropy on health failure", async () => {
  const src = new EntropySource({ health: new HealthMonitor({ rctCutoff: 3 }) });
  for (let i = 0; i < 5; i++) src.health.check(0x11); // inject stuck fault
  assert.equal(src.health.failure, "RCT");
  const before = src.raw.length;
  src.step(2);
  await new Promise((r) => setImmediate(r));
  assert.equal(src.raw.length, before, "no raw bytes credited while unhealthy");
});

test("min-entropy estimator sane on uniform bytes", () => {
  const counts = new Uint32Array(256).fill(100);
  const h = minEntropyMCV(counts, 25600);
  assert.ok(h > 6 && h <= 8, `uniform stream should estimate near 8, got ${h}`);
});
