import { makePendulum } from "./physics.js";
import { HealthMonitor, minEntropyMCV } from "./health.js";
import { EntropyPool, condition, HmacDrbg } from "./pipeline.js";

const _f64 = new Float64Array(1);
const _u8 = new Uint8Array(_f64.buffer);
function mantissaByte(x) {
  _f64[0] = x;
  return _u8[0];
}

function mix32(h) {
  h |= 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

export function defaultInitialState(seedMs = Date.now()) {
  let seed = mix32(Math.floor(seedMs * 1000) ^ 0x9e3779b9);
  const r = () => {
    seed = mix32(seed + 0x6d2b79f5);
    return seed / 4294967296;
  };
  return [
    Math.PI - 0.4 + r() * 0.8,
    Math.PI - 0.6 + r() * 1.2,
    Math.PI - 0.6 + r() * 1.2,
    (r() - 0.5) * 0.2,
    (r() - 0.5) * 0.2,
    (r() - 0.5) * 0.2,
  ];
}

/** Default sampler: low mantissa byte of each of the 6 simulated state vars. */
export function pendulumSampler(state) {
  const out = new Array(6);
  for (let i = 0; i < 6; i++) out[i] = mantissaByte(state[i]);
  return out;
}

/**
 * Full noise-source pipeline. Drive it with step(); read via drbgBytes().
 *
 *   const src = new EntropySource();
 *   setInterval(() => src.step(4), 16);      // ~240 Hz physics
 *   const bytes = await src.drbgBytes(32);   // null until seeded
 *
 * Hardware adapter: pass a custom `sampler(state) -> byte[]` that reads a
 * physical sensor (encoder angles, camera centroid, ADC noise). Everything
 * downstream — health tests, conditioner, pool, DRBG — is unchanged.
 */
export class EntropySource {
  constructor({
    dt = 1 / 240,
    condBlock = 64,
    poolSize = 8192,
    reseedAfter = 4096,
    health,
    initialState,
    sampler = pendulumSampler,
  } = {}) {
    this.pendulum = makePendulum();
    this.sampler = sampler;
    this.state = initialState || defaultInitialState();
    this.dt = dt;
    this.condBlock = condBlock;
    this.reseedAfter = reseedAfter;
    this.health = health || new HealthMonitor();
    this.pool = new EntropyPool(poolSize);
    this.drbg = new HmacDrbg();
    this.raw = [];
    this.ambient = [];
    this.rawCounts = new Uint32Array(256);
    this.rawTotal = 0;
    this.condBytes = 0;
    this._conditioning = false;
    this._seeding = false;
    this._drbgBusy = false;
  }

  /** External entropy (timestamps, sensor bytes, request jitter, ...). */
  injectAmbient(bytes, perturbScale = 2e-9) {
    for (const b of bytes) this.ambient.push(b & 0xff);
    if (this.ambient.length > 1024) this.ambient.splice(0, this.ambient.length - 1024);
    if (perturbScale > 0) {
      let h = 0x9e3779b9;
      for (const b of bytes) h = mix32(h ^ b);
      const k = (h / 4294967296 - 0.5) * perturbScale;
      this.state[0] += k;
      this.state[1] -= k * 0.7;
      this.state[2] += k * 1.3;
    }
  }

  /** Advance n physics substeps, harvest one 6-byte raw sample, condition/seed. */
  step(substeps = 4) {
    for (let i = 0; i < substeps; i++)
      this.state = this.pendulum.rk4Step(this.state, this.dt);

    for (const sample of this.sampler(this.state)) {
      const b = sample & 0xff;
      this.health.check(b);
      this.rawCounts[b]++;
      this.rawTotal++;
      if (this.health.healthy) this.raw.push(b);
    }

    this._conditionIfReady();
    this._seedIfReady();
  }

  _conditionIfReady() {
    if (this._conditioning || !this.health.healthy || this.raw.length < this.condBlock)
      return;
    this._conditioning = true;
    const rawBlock = new Uint8Array(this.raw.splice(0, this.condBlock));
    const amb = new Uint8Array(this.ambient.splice(0, Math.min(this.ambient.length, 256)));
    condition(rawBlock, amb)
      .then((out) => {
        this.pool.write(out);
        this.condBytes += out.length;
      })
      .finally(() => {
        this._conditioning = false;
      });
  }

  _seedIfReady() {
    if (this.drbg.ready || this._seeding || this.pool.count < 48) return;
    this._seeding = true;
    const seed = this.pool.read(48);
    this.drbg.instantiate(seed).catch(() => {
      this._seeding = false; // allow retry
    });
  }

  /**
   * Draw n conditioned-random bytes via the DRBG.
   * Folds 16 fresh pool bytes per draw when available; full reseed every
   * `reseedAfter` output bytes. Returns null if DRBG not yet seeded/busy.
   */
  async drbgBytes(n) {
    if (!this.drbg.ready || this._drbgBusy) return null;
    this._drbgBusy = true;
    try {
      if (this.drbg.sinceReseed >= this.reseedAfter && this.pool.count >= 32) {
        await this.drbg.reseed(this.pool.read(32));
      }
      const fresh = this.pool.count >= 16 ? this.pool.read(16) : new Uint8Array(0);
      return await this.drbg.generate(n, fresh);
    } finally {
      this._drbgBusy = false;
    }
  }

  /** Unbiased integer in [0, max) via rejection sampling. Null if unavailable. */
  async randInt(max) {
    const limit = Math.floor(4294967296 / max) * max;
    for (let tries = 0; tries < 16; tries++) {
      const b = await this.drbgBytes(4);
      if (!b) return null;
      const v = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      if (v < limit) return v % max;
    }
    return null;
  }

  status() {
    return {
      healthy: this.health.healthy,
      failure: this.health.failure,
      poolCount: this.pool.count,
      poolSize: this.pool.size,
      condBytes: this.condBytes,
      rawTotal: this.rawTotal,
      minEntropy: minEntropyMCV(this.rawCounts, this.rawTotal),
      drbgReady: this.drbg.ready,
      drbgReseeds: this.drbg.reseeds,
      drbgBytesOut: this.drbg.bytesOut,
    };
  }
}
