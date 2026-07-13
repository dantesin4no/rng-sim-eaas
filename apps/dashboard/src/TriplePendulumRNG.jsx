import React, { useRef, useEffect, useState, useCallback } from "react";

/* ================================================================
   TRIPLE PENDULUM RNG — v2 "product architecture"

   NIST SP 800-90 style pipeline, no physical device required:

   [ Noise sources ]  chaotic 3-link pendulum (amplifier) +
                      ambient entropy: pointer / keys / frame
                      jitter / device motion — injected as
                      nanoradian perturbations AND raw bytes
        │
   [ Health tests ]   SP 800-90B: Repetition Count Test +
                      Adaptive Proportion Test on raw samples
        │
   [ Conditioner ]    SHA-256 over 64 raw bytes + ambient buffer
                      + timing jitter  →  32 conditioned bytes
        │
   [ Entropy pool ]   8 KB ring buffer, min-entropy accounting
        │
   [ HMAC-DRBG ]      SP 800-90A HMAC-DRBG (SHA-256), seeded from
                      pool, fresh pool bytes mixed in per draw,
                      periodic reseed
        │
   [ Consumers ]      coin / dice / ranges / hex / .bin export
   ================================================================ */

const VERSION = "v2.1";
const BUILD = "2026-07-06";

const G = 9.81;
const N = 3;
const MASS = [1.0, 1.0, 1.0];
const LEN = [1.0, 0.9, 0.8];
const DT = 1 / 240;
const POOL_SIZE = 8192;
const TICKER_BITS = 96;
const COND_BLOCK = 64;      // raw bytes per SHA-256 conditioning block
const RCT_CUTOFF = 12;      // ~ alpha 2^-30 at H >= 4 bits/sample
const APT_WINDOW = 512;
const APT_CUTOFF = 84;      // ~ alpha 2^-30 at H >= 4 bits/sample
const RESEED_AFTER = 4096;  // DRBG output bytes between full reseeds

const subtle =
  typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;

// Where the "Live service" panel points by default. The Pages build injects the
// deployed API (VITE_API_URL). In dev there is no such env, so we fall back to
// the service you'd be running yourself. A *production* build with no
// VITE_API_URL gets an empty string rather than that localhost fallback: a
// hosted page pointing at the visitor's own machine can never work, and shipping
// it silently is what broke the Pages demo once already. Empty renders an
// explicit "not configured" state instead. Connecting stays a manual click
// either way — the demo must not auto-hammer the API on load.
const DEFAULT_SVC_URL =
  import.meta.env?.VITE_API_URL ||
  (import.meta.env?.DEV ? "http://localhost:8787" : "");

/* ---------------- physics: 3-link Lagrangian ---------------- */

function csum(k) {
  let s = 0;
  for (let i = k; i < N; i++) s += MASS[i];
  return s;
}

function solve3(A, b) {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [
    M[0][3] / (M[0][0] || 1e-12),
    M[1][3] / (M[1][1] || 1e-12),
    M[2][3] / (M[2][2] || 1e-12),
  ];
}

function derivs(s) {
  const th = [s[0], s[1], s[2]];
  const w = [s[3], s[4], s[5]];
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++)
      A[i][j] = csum(Math.max(i, j)) * LEN[i] * LEN[j] * Math.cos(th[i] - th[j]);
    let acc = 0;
    for (let j = 0; j < 3; j++)
      acc -= csum(Math.max(i, j)) * LEN[i] * LEN[j] * Math.sin(th[i] - th[j]) * w[j] * w[j];
    acc -= G * LEN[i] * csum(i) * Math.sin(th[i]);
    b[i] = acc;
  }
  const a = solve3(A, b);
  return [w[0], w[1], w[2], a[0], a[1], a[2]];
}

function rk4(s, dt) {
  const k1 = derivs(s);
  const s2 = s.map((v, i) => v + (dt / 2) * k1[i]);
  const k2 = derivs(s2);
  const s3 = s.map((v, i) => v + (dt / 2) * k2[i]);
  const k3 = derivs(s3);
  const s4 = s.map((v, i) => v + dt * k3[i]);
  const k4 = derivs(s4);
  return s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/* ---------------- byte utilities ---------------- */

function mix32(h) {
  h |= 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

const _f64 = new Float64Array(1);
const _u8 = new Uint8Array(_f64.buffer);
function f64bytes(x, n = 8) {
  _f64[0] = x;
  return _u8.slice(0, n);
}
function mantissaByte(x) {
  _f64[0] = x;
  return _u8[0];
}
function concatBytes(arrs) {
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

function makeInitialState() {
  const t = typeof performance !== "undefined" ? performance.now() : Date.now();
  let seed = mix32(Math.floor(t * 1000) ^ 0x9e3779b9);
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

/* ---------------- HMAC-DRBG (SP 800-90A, SHA-256) ---------------- */

async function hmac(keyBytes, data) {
  const key = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await subtle.sign("HMAC", key, data));
}

function makeDrbg() {
  return {
    K: new Uint8Array(32),
    V: new Uint8Array(32).fill(0x01),
    ready: false,
    reseeds: 0,
    bytesOut: 0,
    sinceReseed: 0,
    busy: false,
  };
}

async function drbgUpdate(d, provided) {
  d.K = await hmac(d.K, concatBytes([d.V, new Uint8Array([0x00]), provided]));
  d.V = await hmac(d.K, d.V);
  if (provided.length) {
    d.K = await hmac(d.K, concatBytes([d.V, new Uint8Array([0x01]), provided]));
    d.V = await hmac(d.K, d.V);
  }
}

async function drbgInstantiate(d, entropy) {
  await drbgUpdate(d, entropy);
  d.ready = true;
  d.reseeds = 1;
}

async function drbgGenerate(d, n, additional) {
  if (additional.length) await drbgUpdate(d, additional);
  const chunks = [];
  let got = 0;
  while (got < n) {
    d.V = await hmac(d.K, d.V);
    chunks.push(d.V);
    got += d.V.length;
  }
  await drbgUpdate(d, additional);
  d.bytesOut += n;
  d.sinceReseed += n;
  return concatBytes(chunks).slice(0, n);
}

/* ---------------- UI atoms ---------------- */

const T = {
  bg: "#0c0f16",
  panel: "#131826",
  panelEdge: "#232c42",
  ink: "#e6ecf7",
  dim: "#7c88a3",
  faint: "#4a5470",
  ch1: "#ffb454",
  ch2: "#57c7ff",
  ch3: "#ff6e9c",
  ok: "#7ee08a",
  bad: "#ff5d5d",
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, monospace',
};

function Panel({ title, right, children, style }) {
  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.panelEdge}`,
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          borderBottom: `1px solid ${T.panelEdge}`,
          fontFamily: T.mono,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: T.dim,
        }}
      >
        <span>{title}</span>
        {right}
      </div>
      <div style={{ padding: 14, flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

function Btn({ children, onClick, disabled, accent }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: accent ? "rgba(87,199,255,0.12)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${accent ? "rgba(87,199,255,0.45)" : T.panelEdge}`,
        color: disabled ? T.faint : accent ? T.ch2 : T.ink,
        borderRadius: 7,
        padding: "7px 12px",
        fontFamily: T.mono,
        fontSize: 12.5,
        cursor: disabled ? "default" : "pointer",
        transition: "border-color 120ms",
      }}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "0.1em", color: T.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 18, color: color || T.ink, marginTop: 2, whiteSpace: "nowrap" }}>
        {value}
        {sub && <span style={{ fontSize: 11, color: T.dim, marginLeft: 4 }}>{sub}</span>}
      </div>
    </div>
  );
}

function Led({ on, warn }) {
  const c = warn ? T.bad : on ? T.ok : T.faint;
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        background: c,
        boxShadow: on || warn ? `0 0 6px ${c}` : "none",
        marginRight: 6,
        verticalAlign: "baseline",
      }}
    />
  );
}

/* ---------------- main app ---------------- */

export default function TriplePendulumRNGv2() {
  const trailRef = useRef(null);
  const armsRef = useRef(null);
  const wrapRef = useRef(null);

  const eng = useRef({
    state: makeInitialState(),
    running: true,
    speed: 1,
    // raw noise
    raw: [],                    // pending raw bytes -> conditioner
    ambient: [],                // ambient entropy bytes -> conditioner
    digesting: false,
    // health tests (SP 800-90B)
    rctLast: -1, rctRun: 0,
    aptFirst: -1, aptCount: 0, aptIdx: 0,
    healthFail: null,           // null | "RCT" | "APT"
    // raw stats (min-entropy, MCV estimator)
    rawCounts: new Uint32Array(256),
    rawTotal: 0,
    // conditioned pool
    pool: new Uint8Array(POOL_SIZE),
    poolWrite: 0, poolRead: 0, poolCount: 0,
    condBytes: 0,
    byteCounts: new Uint32Array(256),
    ones: 0, totalBits: 0,
    ticker: [],
    rate: 0,
    // sources
    src: { sim: 0, pointer: 0, keys: 0, motion: 0, timing: 0 },
    // drbg
    drbg: makeDrbg(),
    drbgInitStarted: false,
    perturbAccum: 0,
    liveBuf: [],
  }).current;

  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [stats, setStats] = useState({
    poolCount: 0, rate: 0, totalBits: 0, ones: 0,
    minEnt: 0, shannon: 0, health: null,
    src: { sim: 0, pointer: 0, keys: 0, motion: 0, timing: 0 },
    drbgReady: false, reseeds: 0, bytesOut: 0, sinceReseed: 0,
    condBytes: 0,
  });
  const [ticker, setTicker] = useState("");
  const [nibbles, setNibbles] = useState(new Array(16).fill(0));
  const [rangeMax, setRangeMax] = useState(100);
  const [log, setLog] = useState([]);
  const [motionOn, setMotionOn] = useState(false);

  /* ---- live service mode (plan 003): poll the entropy-api ---- */
  const [svcUrl, setSvcUrl] = useState(DEFAULT_SVC_URL);
  const [svcOn, setSvcOn] = useState(false);
  const [svc, setSvc] = useState(null); // {ok, code, body} | {error}
  const [svcLog, setSvcLog] = useState([]);
  const svcConfigured = svcUrl.trim() !== "";

  // One-shot liveness probe, before you connect. The streaming loop below stays
  // behind Connect so idle visitors never put a 1 Hz poll on the service — but a
  // panel that shows OFFLINE and sends nothing is indistinguishable from a broken
  // one, and read as broken by two people in a row. A single /v1/health on load
  // proves the backend is alive and puts one visible request in the network tab;
  // the sustained load still costs a click.
  useEffect(() => {
    if (svcOn || !svcUrl.trim()) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${svcUrl}/v1/health`, { cache: "no-store" });
        const body = await r.json();
        if (alive) setSvc({ ok: r.ok, code: r.status, body });
      } catch (e) {
        if (alive) setSvc({ error: String((e && e.message) || e) });
      }
    }, 500); // debounce, so editing the URL doesn't probe on every keystroke
    return () => { alive = false; clearTimeout(t); };
  }, [svcOn, svcUrl]);

  useEffect(() => {
    if (!svcOn || !svcUrl.trim()) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${svcUrl}/v1/health`, { cache: "no-store" });
        const body = await r.json();
        if (alive) setSvc({ ok: r.ok, code: r.status, body });
      } catch (e) {
        if (alive) setSvc({ error: String(e && e.message || e) });
      }
    };
    const flushAmbient = async () => {
      if (!eng.liveBuf.length) return;
      const bytes = eng.liveBuf.splice(0, 128);
      const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      try {
        await fetch(`${svcUrl}/v1/ambient`, { method: "POST", body: hex });
      } catch (_) { /* service unreachable; polling surfaces it */ }
    };
    poll();
    const p = setInterval(poll, 1000);
    const f = setInterval(flushAmbient, 2000);
    return () => { alive = false; clearInterval(p); clearInterval(f); };
  }, [svcOn, svcUrl, eng]);

  const pushSvcLog = (kind, value) =>
    setSvcLog((prev) => [{ kind, value, id: Math.random() }, ...prev].slice(0, 6));

  const svcGen = async (kind) => {
    try {
      let r;
      if (kind === "coin") r = await fetch(`${svcUrl}/v1/random?bytes=1`);
      else if (kind === "d20") r = await fetch(`${svcUrl}/v1/int?max=20`);
      else if (kind === "int100") r = await fetch(`${svcUrl}/v1/int?max=100`);
      else r = await fetch(`${svcUrl}/v1/random?bytes=16`);
      const body = await r.json();
      if (!r.ok) return pushSvcLog(kind, `HTTP ${r.status}: ${body.error || "refused"}`);
      if (kind === "coin") pushSvcLog("coin", parseInt(body.data, 16) & 1 ? "HEADS" : "TAILS");
      else if (kind === "d20" || kind === "int100") pushSvcLog(kind, String(body.value));
      else pushSvcLog("hex128", body.data);
    } catch (e) {
      pushSvcLog(kind, "unreachable: " + String(e && e.message || e));
    }
  };

  eng.running = running;
  eng.speed = speed;

  /* ---- ambient entropy ingestion + physical perturbation ---- */
  const ingestAmbient = useCallback(
    (bytes, srcKey, perturbScale) => {
      for (const b of bytes) eng.ambient.push(b & 0xff);
      if (eng.ambient.length > 1024) eng.ambient.splice(0, eng.ambient.length - 1024);
      for (const b of bytes) eng.liveBuf.push(b & 0xff);
      if (eng.liveBuf.length > 128) eng.liveBuf.splice(0, eng.liveBuf.length - 128);
      eng.src[srcKey]++;
      if (perturbScale > 0) {
        // Fold event bytes into a nanoradian kick; chaos amplifies it.
        let h = 0x9e3779b9;
        for (const b of bytes) h = mix32(h ^ b);
        const k = (h / 4294967296 - 0.5) * perturbScale;
        eng.state[0] += k;
        eng.state[1] -= k * 0.7;
        eng.state[2] += k * 1.3;
      }
    },
    [eng]
  );

  useEffect(() => {
    let lastMove = 0;
    const onPointer = (e) => {
      const now = performance.now();
      if (now - lastMove < 16) return; // ~60 Hz cap
      lastMove = now;
      ingestAmbient(
        [e.clientX & 0xff, e.clientY & 0xff, ...f64bytes(now, 4)],
        "pointer",
        2e-9
      );
    };
    const onKey = (e) => {
      ingestAmbient([e.keyCode & 0xff, ...f64bytes(performance.now(), 4)], "keys", 2e-9);
    };
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      ingestAmbient(
        [mantissaByte(a.x || 0), mantissaByte(a.y || 0), mantissaByte(a.z || 0)],
        "motion",
        5e-9
      );
      setMotionOn(true);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("devicemotion", onMotion);
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("devicemotion", onMotion);
    };
  }, [ingestAmbient]);

  const requestMotion = async () => {
    try {
      if (typeof DeviceMotionEvent !== "undefined" && DeviceMotionEvent.requestPermission) {
        const p = await DeviceMotionEvent.requestPermission();
        if (p === "granted") setMotionOn(true);
      } else {
        setMotionOn(true);
      }
    } catch (_) {
      /* permission denied — motion stays off */
    }
  };

  /* ---- health tests on each raw sample ---- */
  const healthCheck = useCallback(
    (b) => {
      // Repetition Count Test
      if (b === eng.rctLast) {
        eng.rctRun++;
        if (eng.rctRun >= RCT_CUTOFF) eng.healthFail = "RCT";
      } else {
        eng.rctLast = b;
        eng.rctRun = 1;
      }
      // Adaptive Proportion Test
      if (eng.aptIdx === 0) {
        eng.aptFirst = b;
        eng.aptCount = 1;
        eng.aptIdx = 1;
      } else {
        if (b === eng.aptFirst) {
          eng.aptCount++;
          if (eng.aptCount >= APT_CUTOFF) eng.healthFail = "APT";
        }
        eng.aptIdx++;
        if (eng.aptIdx >= APT_WINDOW) eng.aptIdx = 0;
      }
    },
    [eng]
  );

  /* ---- raw sampling from simulation ---- */
  const sampleSim = useCallback(() => {
    const s = eng.state;
    for (let i = 0; i < 6; i++) {
      const b = mantissaByte(s[i]);
      healthCheck(b);
      eng.rawCounts[b]++;
      eng.rawTotal++;
      if (!eng.healthFail) eng.raw.push(b);
    }
    eng.src.sim++;
  }, [eng, healthCheck]);

  /* ---- SHA-256 conditioning: 64 raw + ambient + timing -> 32 pool bytes ---- */
  const conditionIfReady = useCallback(() => {
    if (eng.digesting || eng.healthFail || eng.raw.length < COND_BLOCK || !subtle) return;
    eng.digesting = true;
    const rawBlock = new Uint8Array(eng.raw.splice(0, COND_BLOCK));
    const amb = new Uint8Array(eng.ambient.splice(0, Math.min(eng.ambient.length, 256)));
    const timing = f64bytes(performance.now(), 8);
    eng.src.timing++;
    subtle
      .digest("SHA-256", concatBytes([rawBlock, amb, timing]))
      .then((buf) => {
        const out = new Uint8Array(buf);
        for (const byte of out) {
          if (eng.poolCount < POOL_SIZE) {
            eng.pool[eng.poolWrite] = byte;
            eng.poolWrite = (eng.poolWrite + 1) % POOL_SIZE;
            eng.poolCount++;
          } else {
            eng.pool[eng.poolWrite] ^= byte; // fold, never discard
            eng.poolWrite = (eng.poolWrite + 1) % POOL_SIZE;
          }
          eng.byteCounts[byte]++;
          eng.condBytes++;
          eng.totalBits += 8;
          let b = byte;
          while (b) { eng.ones += b & 1; b >>= 1; }
        }
        for (let i = 0; i < 12; i++)
          for (let bit = 7; bit >= 0; bit--) eng.ticker.push((out[i] >> bit) & 1);
        if (eng.ticker.length > TICKER_BITS)
          eng.ticker.splice(0, eng.ticker.length - TICKER_BITS);
      })
      .finally(() => {
        eng.digesting = false;
      });
  }, [eng]);

  /* ---- pool ops ---- */
  const takeBytes = useCallback(
    (n) => {
      if (eng.poolCount < n) return null;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = eng.pool[eng.poolRead];
        eng.poolRead = (eng.poolRead + 1) % POOL_SIZE;
        eng.poolCount--;
      }
      return out;
    },
    [eng]
  );

  /* ---- DRBG lifecycle ---- */
  const maybeInitDrbg = useCallback(() => {
    if (!subtle || eng.drbg.ready || eng.drbgInitStarted || eng.poolCount < 48) return;
    eng.drbgInitStarted = true;
    const seed = takeBytes(48); // 32 entropy + 16 nonce
    drbgInstantiate(eng.drbg, seed).catch(() => {
      eng.drbgInitStarted = false;
    });
  }, [eng, takeBytes]);

  const drbgBytes = useCallback(
    async (n) => {
      const d = eng.drbg;
      if (!d.ready || d.busy) return null;
      d.busy = true;
      try {
        if (d.sinceReseed >= RESEED_AFTER && eng.poolCount >= 32) {
          const seed = takeBytes(32);
          await drbgUpdate(d, seed);
          d.reseeds++;
          d.sinceReseed = 0;
        }
        // prediction resistance: fold in fresh pool bytes per draw when available
        const fresh = eng.poolCount >= 16 ? takeBytes(16) : new Uint8Array(0);
        return await drbgGenerate(d, n, fresh);
      } finally {
        d.busy = false;
      }
    },
    [eng, takeBytes]
  );

  const randInt = useCallback(
    async (max) => {
      const limit = Math.floor(4294967296 / max) * max;
      for (let tries = 0; tries < 16; tries++) {
        const b = await drbgBytes(4);
        if (!b) return null;
        const v = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        if (v < limit) return v % max;
      }
      return null;
    },
    [drbgBytes]
  );

  const pushLog = useCallback((kind, value, cost) => {
    setLog((prev) =>
      [{ kind, value, cost, id: Math.random() }, ...prev].slice(0, 8)
    );
  }, []);

  /* ---- animation / physics loop ---- */
  useEffect(() => {
    let raf;
    let last = performance.now();
    let lastStat = 0;

    const resize = () => {
      const wrap = wrapRef.current, trail = trailRef.current, arms = armsRef.current;
      if (!wrap || !trail || !arms) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth, h = wrap.clientHeight;
      for (const c of [trail, arms]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = w + "px";
        c.style.height = h + "px";
      }
      const tctx = trail.getContext("2d");
      tctx.fillStyle = T.bg;
      tctx.fillRect(0, 0, trail.width, trail.height);
    };
    resize();
    window.addEventListener("resize", resize);

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dtReal = Math.min((now - last) / 1000, 0.05);
      last = now;

      const trail = trailRef.current, arms = armsRef.current;
      if (!trail || !arms) return;
      const tctx = trail.getContext("2d");
      const actx = arms.getContext("2d");
      const W = arms.width, H = arms.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const totalL = LEN[0] + LEN[1] + LEN[2];
      const scale = (Math.min(W, H) / 2 / totalL) * 0.92;
      const cx = W / 2, cy = H / 2;
      const project = (s) => {
        const pts = [[cx, cy]];
        let px = cx, py = cy;
        for (let i = 0; i < 3; i++) {
          px += LEN[i] * scale * Math.sin(s[i]);
          py += LEN[i] * scale * Math.cos(s[i]);
          pts.push([px, py]);
        }
        return pts;
      };

      if (eng.running) {
        // frame-jitter perturbation: scheduler noise -> nanoradian kicks
        const jb = f64bytes(now, 2);
        eng.state[0] += ((jb[0] / 255) - 0.5) * 1e-11;
        eng.state[2] += ((jb[1] / 255) - 0.5) * 1e-11;

        const substeps = Math.max(1, Math.round((dtReal / DT) * eng.speed));
        const prevTip = project(eng.state)[3];
        for (let i = 0; i < Math.min(substeps, 40); i++)
          eng.state = rk4(eng.state, DT);

        sampleSim();
        conditionIfReady();
        maybeInitDrbg();
        eng.rate = eng.rate * 0.95 + (48 / Math.max(dtReal, 1e-4)) * 0.05 * (eng.healthFail ? 0 : 1);

        tctx.fillStyle = "rgba(12,15,22,0.045)";
        tctx.fillRect(0, 0, W, H);
        const tip = project(eng.state)[3];
        tctx.strokeStyle = T.ch3;
        tctx.globalAlpha = 0.85;
        tctx.lineWidth = 1.4 * dpr;
        tctx.lineCap = "round";
        tctx.beginPath();
        tctx.moveTo(prevTip[0], prevTip[1]);
        tctx.lineTo(tip[0], tip[1]);
        tctx.stroke();
        tctx.globalAlpha = 1;
      }

      actx.clearRect(0, 0, W, H);
      const pts = project(eng.state);
      const colors = [T.ch1, T.ch2, T.ch3];
      actx.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        actx.strokeStyle = colors[i];
        actx.lineWidth = 2.2 * dpr;
        actx.beginPath();
        actx.moveTo(pts[i][0], pts[i][1]);
        actx.lineTo(pts[i + 1][0], pts[i + 1][1]);
        actx.stroke();
      }
      actx.fillStyle = T.dim;
      actx.beginPath();
      actx.arc(pts[0][0], pts[0][1], 3.4 * dpr, 0, Math.PI * 2);
      actx.fill();
      for (let i = 1; i <= 3; i++) {
        actx.fillStyle = colors[i - 1];
        actx.beginPath();
        actx.arc(pts[i][0], pts[i][1], (i === 3 ? 5.4 : 4.4) * dpr, 0, Math.PI * 2);
        actx.fill();
      }

      if (now - lastStat > 200) {
        lastStat = now;
        // min-entropy: most-common-value estimator on raw samples
        let minEnt = 0;
        if (eng.rawTotal > 256) {
          let maxC = 0;
          for (let i = 0; i < 256; i++) if (eng.rawCounts[i] > maxC) maxC = eng.rawCounts[i];
          const p = maxC / eng.rawTotal;
          const pUb = Math.min(1, p + 2.576 * Math.sqrt((p * (1 - p)) / eng.rawTotal));
          minEnt = -Math.log2(pUb);
        }
        let shannon = 0;
        const totalB = eng.totalBits / 8;
        if (totalB > 32) {
          for (let i = 0; i < 256; i++) {
            const c = eng.byteCounts[i];
            if (c > 0) {
              const p = c / totalB;
              shannon -= p * Math.log2(p);
            }
          }
        }
        setStats({
          poolCount: eng.poolCount,
          rate: eng.running && !eng.healthFail ? eng.rate : 0,
          totalBits: eng.totalBits,
          ones: eng.ones,
          minEnt,
          shannon,
          health: eng.healthFail,
          src: { ...eng.src },
          drbgReady: eng.drbg.ready,
          reseeds: eng.drbg.reseeds,
          bytesOut: eng.drbg.bytesOut,
          sinceReseed: eng.drbg.sinceReseed,
          condBytes: eng.condBytes,
        });
        setTicker(eng.ticker.join(""));
        const nib = new Array(16).fill(0);
        for (let i = 0; i < 256; i++) nib[i >> 4] += eng.byteCounts[i];
        setNibbles(nib);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [eng, sampleSim, conditionIfReady, maybeInitDrbg]);

  /* ---- controls ---- */
  const reset = () => {
    eng.state = makeInitialState();
    eng.healthFail = null;
    eng.rctLast = -1; eng.rctRun = 0;
    eng.aptIdx = 0; eng.aptFirst = -1; eng.aptCount = 0;
    const trail = trailRef.current;
    if (trail) {
      const ctx = trail.getContext("2d");
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, trail.width, trail.height);
    }
  };

  const simulateStuckSource = () => {
    // Fault injection: feed the health tester a stuck value
    for (let i = 0; i < RCT_CUTOFF + 2; i++) healthCheck(0x42);
  };

  const gen = async (kind) => {
    if (!stats.drbgReady) return pushLog(kind, "— DRBG not yet seeded", 0);
    if (kind === "coin") {
      const b = await drbgBytes(1);
      pushLog("coin", b ? (b[0] & 1 ? "HEADS" : "TAILS") : "— busy", 8);
    } else if (kind === "d6") {
      const v = await randInt(6);
      pushLog("d6", v === null ? "— busy" : String(v + 1), 32);
    } else if (kind === "d20") {
      const v = await randInt(20);
      pushLog("d20", v === null ? "— busy" : String(v + 1), 32);
    } else if (kind === "range") {
      const m = Math.max(2, Math.min(1000000000, Math.floor(rangeMax) || 2));
      const v = await randInt(m);
      pushLog(`0–${m - 1}`, v === null ? "— busy" : String(v), 32);
    } else if (kind === "hex") {
      const b = await drbgBytes(16);
      pushLog(
        "hex128",
        b ? Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("") : "— busy",
        128
      );
    }
  };

  const exportBin = async () => {
    if (!stats.drbgReady) return pushLog("export", "— DRBG not yet seeded", 0);
    const KB = 64;
    const parts = [];
    for (let i = 0; i < KB; i++) {
      const b = await drbgBytes(1024);
      if (!b) return pushLog("export", "— busy, try again", 0);
      parts.push(b);
    }
    const blob = new Blob(parts, { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pendulum-entropy-64kb.bin";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    pushLog("export", "64 KB .bin downloaded — feed to dieharder / NIST STS", 64 * 8192);
  };

  const balance = stats.totalBits > 0 ? (stats.ones / stats.totalBits) * 100 : 50;
  const maxNib = Math.max(1, ...nibbles);
  const healthy = !stats.health;

  const stages = [
    { label: "Noise", on: running, warn: false },
    { label: "Health 90B", on: healthy && running, warn: !healthy },
    { label: "SHA-256", on: healthy && running && !!subtle, warn: !subtle },
    { label: "Pool", on: stats.poolCount > 0, warn: false },
    { label: "HMAC-DRBG", on: stats.drbgReady, warn: false },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        color: T.ink,
        fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif",
        padding: "18px clamp(12px, 3vw, 32px) 32px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Triple-Pendulum RNG</h1>
        <span
          title={`Build ${BUILD} — SP 800-90 architecture, ambient-entropy injected`}
          style={{
            fontFamily: T.mono,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: T.ch2,
            background: "rgba(87,199,255,0.12)",
            border: "1px solid rgba(87,199,255,0.45)",
            borderRadius: 999,
            padding: "3px 10px",
            alignSelf: "center",
          }}
        >
          {VERSION}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.dim }}>
          SP 800-90 architecture, ambient-entropy injected
        </span>
        <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11, color: healthy ? T.ok : T.bad }}>
          ● {stats.health ? `HEALTH FAIL: ${stats.health}` : running ? "HARVESTING" : "PAUSED"}
        </span>
      </div>

      {/* pipeline strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          fontFamily: T.mono,
          fontSize: 11,
          color: T.dim,
          background: T.panel,
          border: `1px solid ${T.panelEdge}`,
          borderRadius: 8,
          padding: "8px 12px",
          marginBottom: 14,
        }}
      >
        {stages.map((s, i) => (
          <React.Fragment key={s.label}>
            <span style={{ whiteSpace: "nowrap" }}>
              <Led on={s.on} warn={s.warn} />
              {s.label}
            </span>
            {i < stages.length - 1 && <span style={{ color: T.faint }}>→</span>}
          </React.Fragment>
        ))}
        <span style={{ marginLeft: "auto", color: T.faint }}>
          conditioned {(stats.condBytes / 1024).toFixed(1)} KB · DRBG out {(stats.bytesOut / 1024).toFixed(1)} KB · reseeds {stats.reseeds}
        </span>
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.25fr) minmax(300px, 1fr)", gap: 14 }}
        className="tp-grid"
      >
        <style>{`
          @media (max-width: 880px) { .tp-grid { grid-template-columns: 1fr !important; } }
          button:hover:not(:disabled) { border-color: rgba(255,255,255,0.35) !important; }
          input[type=range] { accent-color: ${T.ch2}; }
        `}</style>

        {/* left: emulation */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel
            title="Noise source — chaotic amplifier + ambient injection"
            right={
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>
                θ₁ <span style={{ color: T.ch1 }}>■</span>&nbsp; θ₂ <span style={{ color: T.ch2 }}>■</span>&nbsp; θ₃ <span style={{ color: T.ch3 }}>■</span>
              </span>
            }
            style={{ flex: 1 }}
          >
            <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "min(48vh, 420px)", minHeight: 280 }}>
              <canvas ref={trailRef} style={{ position: "absolute", inset: 0, borderRadius: 6 }} />
              <canvas ref={armsRef} style={{ position: "absolute", inset: 0 }} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <Btn accent onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Resume"}</Btn>
              <Btn onClick={reset}>Reset {stats.health ? "(clear health fail)" : ""}</Btn>
              <Btn onClick={simulateStuckSource}>Inject fault</Btn>
              {!motionOn && typeof DeviceMotionEvent !== "undefined" && (
                <Btn onClick={requestMotion}>Enable motion sensor</Btn>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", fontFamily: T.mono, fontSize: 11.5, color: T.dim }}>
                speed ×{speed.toFixed(1)}
                <input type="range" min="0.2" max="3" step="0.1" value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))} style={{ width: 110 }} />
              </label>
            </div>
            <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 10.5, color: T.faint, lineHeight: 1.6 }}>
              Move the cursor / type / tilt the device: events land as nanoradian kicks on the
              pendulum and as raw bytes in the conditioner — the simulation becomes an
              amplifier of real environmental entropy, not a fixed replay.
            </div>
          </Panel>

          <Panel title="Ambient entropy sources — events ingested">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10 }}>
              <Stat label="Simulation" value={stats.src.sim.toLocaleString()} sub="samples" />
              <Stat label="Pointer" value={stats.src.pointer.toLocaleString()} sub="events" />
              <Stat label="Keys" value={stats.src.keys.toLocaleString()} sub="events" />
              <Stat label="Motion" value={stats.src.motion.toLocaleString()} sub="events" />
              <Stat label="Frame jitter" value={stats.src.timing.toLocaleString()} sub="blocks" />
            </div>
          </Panel>

          <Panel title="Conditioned bit stream — SHA-256 output, last 96 bits">
            <div style={{ fontFamily: T.mono, fontSize: 13, lineHeight: 1.7, letterSpacing: "0.18em", wordBreak: "break-all", minHeight: 44 }}>
              {ticker.split("").map((b, i) => (
                <span key={i} style={{ color: b === "1" ? T.ch2 : T.faint }}>{b}</span>
              ))}
            </div>
          </Panel>
        </div>

        {/* right: suite */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel
            title="Entropy pool & health"
            right={
              <span style={{ fontFamily: T.mono, fontSize: 11 }}>
                <Led on={healthy} warn={!healthy} />
                <span style={{ color: healthy ? T.ok : T.bad }}>
                  RCT / APT {healthy ? "PASS" : `FAIL (${stats.health})`}
                </span>
              </span>
            }
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "13px 10px" }}>
              <Stat label="Pool level" value={stats.poolCount.toLocaleString()} sub={`/ ${POOL_SIZE} B`} />
              <Stat label="Throughput" value={Math.round(stats.rate).toLocaleString()} sub="raw bits/s" />
              <Stat label="Min-entropy (raw)" value={stats.minEnt > 0 ? stats.minEnt.toFixed(2) : "—"} sub="bits/byte, MCV" />
              <Stat label="Shannon (cond.)" value={stats.shannon > 0 ? stats.shannon.toFixed(3) : "—"} sub="bits/byte" />
              <Stat label="Bit balance" value={balance.toFixed(2) + "%"} sub="ideal 50%" />
              <Stat label="Reseed in" value={Math.max(0, RESEED_AFTER - stats.sinceReseed).toLocaleString()} sub="bytes" />
            </div>
            <div style={{ marginTop: 12, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div style={{
                width: `${(stats.poolCount / POOL_SIZE) * 100}%`, height: "100%",
                background: healthy ? `linear-gradient(90deg, ${T.ch2}, ${T.ok})` : T.bad,
                transition: "width 200ms linear",
              }} />
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "0.1em", color: T.faint, textTransform: "uppercase", marginBottom: 6 }}>
                Conditioned byte distribution
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 42 }}>
                {nibbles.map((c, i) => (
                  <div key={i} title={`0x${i.toString(16)}0–0x${i.toString(16)}f: ${c}`}
                    style={{
                      flex: 1, height: `${Math.max(4, (c / maxNib) * 100)}%`,
                      background: "rgba(87,199,255,0.45)", borderRadius: "2px 2px 0 0",
                      transition: "height 200ms linear",
                    }} />
                ))}
              </div>
            </div>
          </Panel>

          <Panel
            title="HMAC-DRBG output — SP 800-90A"
            right={
              <span style={{ fontFamily: T.mono, fontSize: 11, color: stats.drbgReady ? T.ok : T.dim }}>
                <Led on={stats.drbgReady} />
                {stats.drbgReady ? "SEEDED" : "AWAITING 48 B SEED"}
              </span>
            }
            style={{ flex: 1 }}
          >
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn onClick={() => gen("coin")} disabled={!stats.drbgReady}>Coin</Btn>
              <Btn onClick={() => gen("d6")} disabled={!stats.drbgReady}>D6</Btn>
              <Btn onClick={() => gen("d20")} disabled={!stats.drbgReady}>D20</Btn>
              <Btn onClick={() => gen("hex")} disabled={!stats.drbgReady}>128-bit hex</Btn>
              <Btn onClick={exportBin} disabled={!stats.drbgReady}>Export 64 KB .bin</Btn>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <Btn accent onClick={() => gen("range")} disabled={!stats.drbgReady}>Integer in 0 –</Btn>
              <input
                value={rangeMax}
                onChange={(e) => setRangeMax(e.target.value.replace(/[^0-9]/g, ""))}
                style={{
                  width: 100, background: "rgba(255,255,255,0.04)",
                  border: `1px solid ${T.panelEdge}`, borderRadius: 7, color: T.ink,
                  fontFamily: T.mono, fontSize: 12.5, padding: "7px 10px", outline: "none",
                }}
              />
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>(exclusive)</span>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {log.length === 0 && (
                <div style={{ fontFamily: T.mono, fontSize: 12, color: T.faint }}>
                  Draws appear here. Each draw folds 16 fresh pool bytes into the DRBG
                  (prediction resistance) when available.
                </div>
              )}
              {log.map((e) => (
                <div key={e.id} style={{
                  display: "flex", gap: 10, alignItems: "baseline", fontFamily: T.mono,
                  fontSize: 12.5, borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: 5,
                }}>
                  <span style={{ color: T.faint, width: 62, flexShrink: 0 }}>{e.kind}</span>
                  <span style={{ color: T.ink, wordBreak: "break-all" }}>{e.value}</span>
                  {e.cost > 0 && <span style={{ color: T.faint, marginLeft: "auto", flexShrink: 0 }}>{e.cost}b</span>}
                </div>
              ))}
            </div>
          </Panel>


          <Panel
            title="Live service — @entropy/api"
            right={
              <span style={{ fontFamily: T.mono, fontSize: 11 }}>
                <Led on={svc && svc.ok} warn={(svc && !svc.ok && !svc.error) || !svcConfigured} />
                <span style={{ color: !svcConfigured ? T.bad : !svc ? T.dim : svc.ok ? T.ok : T.bad }}>
                  {!svcConfigured ? "NOT CONFIGURED" : !svc ? "PROBING" : svc.error ? "UNREACHABLE" : svc.ok ? "HEALTHY" : `HTTP ${svc.code}`}
                </span>
              </span>
            }
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={svcUrl}
                onChange={(e) => setSvcUrl(e.target.value)}
                disabled={svcOn}
                placeholder="https://your-entropy-api.example.com"
                style={{
                  flex: 1, minWidth: 180, background: "rgba(255,255,255,0.04)",
                  border: `1px solid ${svcConfigured ? T.panelEdge : T.bad}`, borderRadius: 7, color: T.ink,
                  fontFamily: T.mono, fontSize: 12, padding: "7px 10px", outline: "none",
                }}
              />
              <Btn accent disabled={!svcConfigured} onClick={() => setSvcOn((v) => !v)}>
                {svcOn ? "Disconnect" : "Connect"}
              </Btn>
            </div>
            {!svcConfigured && (
              <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 11, color: T.bad, lineHeight: 1.5 }}>
                This build shipped without an API endpoint (VITE_API_URL was unset
                at build time). Paste a URL above to point the panel at a running
                @entropy/api, or set the API_URL repository variable and redeploy.
              </div>
            )}
            {svc && svc.body && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px 10px", marginTop: 12 }}>
                <Stat label="Service pool" value={(svc.body.poolCount ?? 0).toLocaleString()} sub={`/ ${svc.body.poolSize ?? "—"} B`} />
                <Stat label="Min-entropy" value={svc.body.minEntropy ? svc.body.minEntropy.toFixed(2) : "—"} sub="bits/byte" />
                <Stat label="DRBG" value={svc.body.drbgReady ? "SEEDED" : "SEEDING"} color={svc.body.drbgReady ? T.ok : T.dim} />
                <Stat label="Reseeds" value={String(svc.body.drbgReseeds ?? 0)} />
              </div>
            )}
            {svc && svc.error && (
              <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 11, color: T.bad }}>
                {svc.error} — is the service reachable? locally: npm run start:api
              </div>
            )}
            {svcConfigured && !svcOn && (
              <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 11, color: T.dim, lineHeight: 1.5 }}>
                Not streaming yet. <strong style={{ color: T.ch2 }}>Connect</strong> to poll the
                service live, draw coins/D20s/hex through its DRBG, and forward your pointer and
                keystrokes into its entropy pool.
              </div>
            )}
            {svcOn && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <Btn onClick={() => svcGen("coin")}>Coin</Btn>
                  <Btn onClick={() => svcGen("d20")}>D20</Btn>
                  <Btn onClick={() => svcGen("int100")}>0–99</Btn>
                  <Btn onClick={() => svcGen("hex")}>128-bit hex</Btn>
                </div>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                  {svcLog.map((e) => (
                    <div key={e.id} style={{ display: "flex", gap: 10, fontFamily: T.mono, fontSize: 12, borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: 4 }}>
                      <span style={{ color: T.faint, width: 58, flexShrink: 0 }}>{e.kind}</span>
                      <span style={{ color: T.ink, wordBreak: "break-all" }}>{e.value}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 10, color: T.faint, lineHeight: 1.5 }}>
                  Your pointer/keys/motion events are forwarded to the service pool via
                  POST /v1/ambient — this browser is now one of its entropy sources.
                </div>
              </>
            )}
          </Panel>

          <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint, lineHeight: 1.6 }}>
            Triple-Pendulum RNG {VERSION} (build {BUILD}). Architecture mirrors SP 800-90A/B: raw noise → continuous health tests →
            SHA-256 conditioner (64 raw + ambient bytes in, 32 out) → pool →
            HMAC-DRBG with reseeding. Ambient injection makes output non-reproducible in
            practice, but this remains an uncertified software source — validate exported
            .bin files with dieharder or NIST STS, and use audited hardware entropy for
            production cryptography.
          </div>
        </div>
      </div>
    </div>
  );
}
