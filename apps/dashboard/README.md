# Triple-Pendulum RNG — v2.0

A chaotic-dynamics random number generator built on an emulated 3-link pendulum,
structured after the NIST SP 800-90 entropy-source architecture:

```
[ Noise sources ]   chaotic triple pendulum (Lagrangian EOM, RK4 @ 240 Hz)
                    + ambient entropy: pointer, keystrokes, frame-timing
                    jitter, device motion — injected as nanoradian
                    perturbations AND as raw conditioner input
       |
[ Health tests ]    SP 800-90B continuous tests on raw samples:
                    Repetition Count Test + Adaptive Proportion Test
       |
[ Conditioner ]     SHA-256 over 64 raw bytes + ambient buffer + timing
                    -> 32 conditioned bytes (conservative 2:1+ crediting)
       |
[ Entropy pool ]    8 KB ring buffer, min-entropy (MCV) accounting
       |
[ HMAC-DRBG ]       SP 800-90A HMAC-DRBG (SHA-256), 48-byte seed,
                    16 fresh pool bytes folded in per draw, full reseed
                    every 4 KB of output
       |
[ Consumers ]       coin / D6 / D20 / arbitrary ranges (rejection-sampled,
                    unbiased) / 128-bit hex / 64 KB .bin export
```

## Run it (dev server)

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open http://localhost:5173. `localhost` is a secure context, so WebCrypto
(SHA-256 conditioner, HMAC-DRBG) is fully available.

## Production build

```bash
npm run build     # outputs static site to dist/
npm run preview   # serve the build locally
```

Deploy `dist/` to any static host. Must be served over HTTPS in production —
`crypto.subtle` is unavailable in insecure contexts.

## Zero-build fallback

`standalone.html` is a single-file variant using React UMD + Babel from a CDN.
Open it directly in a browser (needs internet for the three CDN scripts on
first load). The Vite project above is the primary, recommended path.

## Testing the motion sensor (mobile)

Plain `http://<lan-ip>:5173` is not a secure context, so WebCrypto and
DeviceMotion won't work over LAN HTTP. Either:

- tunnel: `npx localtunnel --port 5173`, or
- local HTTPS: `npm i -D @vitejs/plugin-basic-ssl` and add it to
  `vite.config.js`, then `npm run dev -- --host`.

On iOS, tap "Enable motion sensor" in the app to trigger the permission prompt.

## Validating the output

Use the "Export 64 KB .bin" button, then run a statistical battery:

```bash
dieharder -a -g 201 -f pendulum-entropy-64kb.bin
```

or the NIST Statistical Test Suite. Note: 64 KB is enough for a smoke test
only; grow the export (bump `KB` in `exportBin` in
`src/TriplePendulumRNG.jsx`) to several MB for meaningful results — many
dieharder tests rewind small files, which weakens their verdicts.

## Honest scope

Ambient-entropy injection makes the output non-reproducible in practice, and
the pipeline mirrors certified-product architecture — but this remains an
uncertified software source. For production cryptography, replace
`sampleSim()` with reads from audited physical hardware; every downstream
stage (health tests, conditioner, pool, DRBG) carries over unchanged.

## Project layout

```
pendulum-rng/
├── index.html                 # Vite entry
├── package.json
├── vite.config.js
├── standalone.html            # no-build CDN variant
└── src/
    ├── main.jsx               # mounts the app
    └── TriplePendulumRNG.jsx  # physics + entropy pipeline + UI (v2.0)
```
