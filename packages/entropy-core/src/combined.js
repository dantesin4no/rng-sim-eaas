/**
 * CombinedSource — XOR of N independent EntropySources.
 *
 * XOR combining preserves security: if ANY component source's output is
 * unpredictable, the combined output is unpredictable. A compromised or
 * degraded source cannot weaken the others (it would need to know their
 * output to cancel it). Standard belt-and-braces design for entropy
 * appliances (SP 800-90C conditioning-function composition spirit).
 */
export class CombinedSource {
  constructor(sources) {
    if (!sources || sources.length < 2)
      throw new Error("CombinedSource needs >= 2 sources");
    this.sources = sources;
  }

  step(substeps = 4) {
    for (const s of this.sources) s.step(substeps);
  }

  injectAmbient(bytes, perturbScale) {
    // fan ambient entropy to every component source
    for (const s of this.sources) s.injectAmbient(bytes, perturbScale);
  }

  /** Null until EVERY component DRBG is seeded — no partial trust. */
  async drbgBytes(n) {
    const outs = [];
    for (const s of this.sources) {
      const b = await s.drbgBytes(n);
      if (!b) return null;
      outs.push(b);
    }
    const combined = new Uint8Array(n);
    for (const o of outs) for (let i = 0; i < n; i++) combined[i] ^= o[i];
    return combined;
  }

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
    const parts = this.sources.map((s) => s.status());
    return {
      sources: parts.length,
      healthy: parts.every((p) => p.healthy),
      failure: parts.find((p) => p.failure)?.failure ?? null,
      drbgReady: parts.every((p) => p.drbgReady),
      poolCount: Math.min(...parts.map((p) => p.poolCount)),
      poolSize: parts[0].poolSize,
      minEntropy: Math.min(...parts.map((p) => p.minEntropy)),
      perSource: parts,
    };
  }
}
