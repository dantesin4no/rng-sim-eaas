import http from "node:http";
import { pathToFileURL } from "node:url";
import { EntropySource } from "@entropy/core";

/**
 * Entropy-as-a-service HTTP API. Implements contracts/entropy-api.yaml.
 * Zero dependencies: node:http + @entropy/core only.
 *
 * Exported as buildServer(source, opts) for HTTP-level tests; listens on
 * PORT only when run directly.
 */

const MAX_BYTES_PER_REQUEST = 4096;

/* ---------------- per-IP token-bucket rate limiter ---------------- */

export class RateLimiter {
  constructor({ reqPerMin = 120, bytesPerMin = 262144, now = () => Date.now() } = {}) {
    this.reqCap = reqPerMin;
    this.byteCap = bytesPerMin;
    this.now = now;
    this.buckets = new Map(); // ip -> {req, bytes, ts}
  }

  _bucket(ip) {
    const t = this.now();
    let b = this.buckets.get(ip);
    if (!b) {
      b = { req: this.reqCap, bytes: this.byteCap, ts: t };
      this.buckets.set(ip, b);
    }
    const dt = (t - b.ts) / 60000; // continuous refill
    b.req = Math.min(this.reqCap, b.req + dt * this.reqCap);
    b.bytes = Math.min(this.byteCap, b.bytes + dt * this.byteCap);
    b.ts = t;
    if (this.buckets.size > 10000) {
      for (const [k, v] of this.buckets)
        if (t - v.ts > 300000) this.buckets.delete(k);
    }
    return b;
  }

  /** Returns null if allowed (and debits), or retry_after_ms if limited. */
  take(ip, bytes) {
    const b = this._bucket(ip);
    if (b.req < 1) return Math.ceil(((1 - b.req) / this.reqCap) * 60000);
    if (b.bytes < bytes) return Math.ceil(((bytes - b.bytes) / this.byteCap) * 60000);
    b.req -= 1;
    b.bytes -= bytes;
    return null;
  }
}

/* ---------------- server ---------------- */

let reqCounter = 0;

/** JSON-lines structured logger. Never logs entropy values or response bodies. */
export function defaultLogger(entry) {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export function buildServer(source, opts = {}) {
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:5173";
  const log = opts.log ?? defaultLogger;
  const limiter =
    opts.limiter ??
    new RateLimiter({
      reqPerMin: Number(process.env.RATE_REQ_PER_MIN || 120),
      bytesPerMin: Number(process.env.RATE_BYTES_PER_MIN || 262144),
    });

  function injectRequestJitter(req) {
    const t = new Float64Array([performance.now()]);
    const bytes = new Uint8Array(t.buffer).slice(0, 4);
    const addr = req.socket.remotePort || 0;
    source.injectAmbient([...bytes, addr & 0xff, (addr >> 8) & 0xff]);
  }

  function cors(res) {
    res.setHeader("access-control-allow-origin", corsOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "600");
  }

  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj, null, 2));
  }

  const server = http.createServer(async (req, res) => {
    const id = `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
    const t0 = performance.now();
    res.setHeader("x-request-id", id);
    res.on("finish", () => {
      // structured, greppable, and entropy-free: no response bodies, ever
      log({
        ts: new Date().toISOString(),
        id,
        method: req.method,
        path: (req.url || "").split("?")[0],
        status: res.statusCode,
        ms: Math.round((performance.now() - t0) * 10) / 10,
        ip: req.socket.remoteAddress || "unknown",
      });
    });
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    injectRequestJitter(req);
    const url = new URL(req.url, "http://localhost");
    const ip = req.socket.remoteAddress || "unknown";

    try {
      if (req.method === "GET" && url.pathname === "/v1/health") {
        const st = source.status();
        return json(res, st.healthy ? 200 : 503, st);
      }

      if (req.method === "GET" && url.pathname === "/v1/random") {
        const n = Math.min(
          MAX_BYTES_PER_REQUEST,
          Math.max(1, Number(url.searchParams.get("bytes") || 32))
        );
        const wait = limiter.take(ip, n);
        if (wait !== null)
          return json(res, 429, { error: "rate limit exceeded", retry_after_ms: wait });
        if (!source.status().healthy)
          return json(res, 503, { error: "entropy source health failure", detail: source.status().failure });
        const bytes = await source.drbgBytes(n);
        if (!bytes)
          return json(res, 503, { error: "DRBG not yet seeded — pool still filling", retry_after_ms: 500 });
        return json(res, 200, {
          bytes: n,
          encoding: "hex",
          data: Buffer.from(bytes).toString("hex"),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/int") {
        // debit 8 bytes: rejection sampling draws >1 uint32 in ~2^-32..0.5 of
        // cases depending on max; 2x covers the expected worst case honestly
        const wait = limiter.take(ip, 8);
        if (wait !== null)
          return json(res, 429, { error: "rate limit exceeded", retry_after_ms: wait });
        const max = Math.max(2, Math.min(1e9, Number(url.searchParams.get("max") || 100)));
        const v = await source.randInt(max);
        if (v === null)
          return json(res, 503, { error: "DRBG not yet seeded", retry_after_ms: 500 });
        return json(res, 200, { max, value: v });
      }

      if (req.method === "POST" && url.pathname === "/v1/ambient") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const hex = (body || "").trim().slice(0, 512);
        if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
          return json(res, 400, { error: "body must be hex" });
        source.injectAmbient(Buffer.from(hex, "hex"));
        return json(res, 202, { accepted: hex.length / 2 });
      }

      if (req.method === "GET" && url.pathname === "/v1/metrics") {
        const st = source.status();
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(
          [
            `entropy_pool_bytes ${st.poolCount}`,
            `entropy_conditioned_bytes_total ${st.condBytes ?? 0}`,
            `entropy_raw_samples_total ${st.rawTotal ?? 0}`,
            `entropy_min_entropy_bits_per_byte ${st.minEntropy.toFixed(4)}`,
            `entropy_healthy ${st.healthy ? 1 : 0}`,
            `drbg_ready ${st.drbgReady ? 1 : 0}`,
            `drbg_reseeds_total ${st.drbgReseeds ?? 0}`,
            `drbg_bytes_out_total ${st.drbgBytesOut ?? 0}`,
          ].join("\n") + "\n"
        );
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: String(err?.message || err) });
    }
  });

  return server;
}

/* ---------------- main ---------------- */

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
  const source = new EntropySource();
  const tick = setInterval(() => source.step(4), 16);
  const server = buildServer(source);

  server.listen(PORT, () => {
    console.log(`entropy-api listening on http://localhost:${PORT}`);
    console.log("endpoints: GET /v1/random?bytes=N  GET /v1/int?max=N  GET /v1/health  GET /v1/metrics  POST /v1/ambient");
  });

  const shutdown = (sig) => {
    console.log(`${sig} received — draining connections`);
    clearInterval(tick);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
