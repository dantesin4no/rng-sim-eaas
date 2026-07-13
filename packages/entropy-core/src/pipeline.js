import { getSubtle } from "./crypto-shim.js";

/* ---------------- entropy pool: ring buffer, folds when full ---------------- */

export class EntropyPool {
  constructor(size = 8192) {
    this.size = size;
    this.buf = new Uint8Array(size);
    this._w = 0;
    this._r = 0;
    this.count = 0;
  }

  write(bytes) {
    for (const byte of bytes) {
      if (this.count < this.size) {
        this.buf[this._w] = byte;
        this._w = (this._w + 1) % this.size;
        this.count++;
      } else {
        // Full: XOR-fold new entropy into old — never discard, never overwrite.
        this.buf[this._w] ^= byte;
        this._w = (this._w + 1) % this.size;
      }
    }
  }

  /** Returns Uint8Array(n) or null if insufficient. Destructive read. */
  read(n) {
    if (this.count < n) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this._r];
      this._r = (this._r + 1) % this.size;
      this.count--;
    }
    return out;
  }
}

/* ---------------- SHA-256 conditioner ---------------- */

export function concatBytes(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/**
 * Condition raw noise + ambient bytes + timing into 32 bytes.
 * Callers must enforce the crediting ratio (>= 64 raw bytes in per 32 out).
 */
export async function condition(rawBytes, ambientBytes = new Uint8Array(0)) {
  const subtle = await getSubtle();
  const t = new Float64Array([Date.now() + performanceNowSafe()]);
  const timing = new Uint8Array(t.buffer);
  const digest = await subtle.digest(
    "SHA-256",
    concatBytes([rawBytes, ambientBytes, timing])
  );
  return new Uint8Array(digest);
}

function performanceNowSafe() {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/* ---------------- HMAC-DRBG (SP 800-90A, SHA-256) ---------------- */

const HASH_OUTLEN = { "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

export class HmacDrbg {
  constructor({ hash = "SHA-256" } = {}) {
    const outlen = HASH_OUTLEN[hash];
    if (!outlen) throw new Error("HmacDrbg: unsupported hash " + hash);
    this.hash = hash;
    this.K = new Uint8Array(outlen);
    this.V = new Uint8Array(outlen).fill(0x01);
    this.ready = false;
    this.reseeds = 0;
    this.bytesOut = 0;
    this.sinceReseed = 0;
  }

  async _hmac(key, data) {
    const subtle = await getSubtle();
    const k = await subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: this.hash },
      false,
      ["sign"]
    );
    return new Uint8Array(await subtle.sign("HMAC", k, data));
  }

  async _update(provided) {
    this.K = await this._hmac(this.K, concatBytes([this.V, new Uint8Array([0x00]), provided]));
    this.V = await this._hmac(this.K, this.V);
    if (provided.length) {
      this.K = await this._hmac(this.K, concatBytes([this.V, new Uint8Array([0x01]), provided]));
      this.V = await this._hmac(this.K, this.V);
    }
  }

  /** entropyInput must be >= 48 bytes (32 entropy + 16 nonce). */
  async instantiate(entropyInput) {
    if (entropyInput.length < 48) throw new Error("HmacDrbg: seed must be >= 48 bytes");
    await this._update(entropyInput);
    this.ready = true;
    this.reseeds = 1;
    this.sinceReseed = 0;
  }

  async reseed(entropyInput) {
    if (entropyInput.length < 32) throw new Error("HmacDrbg: reseed needs >= 32 bytes");
    await this._update(entropyInput);
    this.reseeds++;
    this.sinceReseed = 0;
  }

  async generate(n, additional = new Uint8Array(0)) {
    if (!this.ready) throw new Error("HmacDrbg: not instantiated");
    if (additional.length) await this._update(additional);
    const chunks = [];
    let got = 0;
    while (got < n) {
      this.V = await this._hmac(this.K, this.V);
      chunks.push(this.V);
      got += this.V.length;
    }
    await this._update(additional);
    this.bytesOut += n;
    this.sinceReseed += n;
    return concatBytes(chunks).slice(0, n);
  }
}
