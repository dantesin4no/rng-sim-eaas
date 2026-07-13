# Plan 005 — Public demo API (make the Live service panel work on Pages)  [DONE]

## Why

The dashboard is deployed to GitHub Pages (plan: README "Live demo"). Its
"Live service" panel — built in plan 003 — points at `http://localhost:8787`,
which does not exist for a visitor. So the one panel that demonstrates the
*service* architecture reads as broken to everyone who isn't running the repo
locally. Hosting `@entropy/api` behind public HTTPS closes that gap.

Nothing about the entropy pipeline changes. This is deployment config plus a
default URL. The contract is untouched.

## Constraints

- **HTTPS is mandatory, not a preference.** Pages is HTTPS; a call to an
  `http://` API is blocked as mixed content, and the browser's own
  `crypto.subtle` (local sim path) needs a secure context regardless.
- `CORS_ORIGIN` must be exactly the Pages *origin* (`https://dantesin4no.github.io`),
  no path. The server already reads it (`server.js:64`).
- The service is genuinely zero-dependency and already containerized with a
  `HEALTHCHECK` on `/v1/health`. No Dockerfile change should be needed.
- Public endpoint = untrusted callers. The per-IP token bucket from plan 004
  is the only thing standing between the demo and abuse; keep it conservative.

## Steps

1. [x] `render.yaml` blueprint: docker runtime against the existing
       `Dockerfile`, `healthCheckPath: /v1/health`, env for `CORS_ORIGIN` and
       the rate-limit caps. Free plan. Deployed by hand from the dashboard
       (Blueprints → connect repo): https://rng-sim-entropy-api.onrender.com
2. [x] Dashboard default service URL becomes build-configurable
       (`VITE_API_URL`, falling back to `http://localhost:8787` so the local
       dev flow is unchanged). `pages.yml` passes the deployed URL at build
       time — and hard-fails on this repo if the `API_URL` variable is unset,
       so a silently-dead panel can't ship twice. Connect stays a manual
       click — the demo must not auto-hammer a free-tier box on page load.
3. [x] README: document the deploy, and be honest about cold starts.
4. [x] Verify against the *deployed* service, not localhost — all passed
       2026-07-13: preflight `OPTIONS /v1/random` → 204 with
       `access-control-allow-origin: https://dantesin4no.github.io`;
       `/v1/health` 200 healthy (pool 8192/8192, min-entropy ~7.75 b/B);
       `/v1/random?bytes=64` returned bytes and moved the server's
       `drbgBytesOut` counter by exactly 64; burst of `/v1/int` tripped 429
       (`retry_after_ms` in body) at request 68 — >60 because the bucket
       refills continuously. Deployed Pages bundle verified to contain the
       Render URL. Caveat: the Connect button itself was exercised as the
       exact requests the panel makes (same origin header, same endpoints),
       not via a headless browser — same limitation plan 003 recorded.
5. [x] Doc close-out folded in here: README layout line still said
       "003-004 open" and the dev-command comment still called the dashboard
       "self-contained"; CLAUDE.md's architecture map likewise. All three now
       state plans 003/004 are done and the dashboard consumes the API.

## Acceptance criteria

- `curl -H 'Origin: https://dantesin4no.github.io' <api>/v1/health` returns
  200 with `access-control-allow-origin` echoing that origin.
- The hosted dashboard, with no local server running, connects and draws
  through the service.
- `npm test` stays green (36) — no service code is modified.

## Honest caveats

- **Cold start.** Render's free tier idles the container after ~15 min. The
  first request after a lull pays a container boot *and* the entropy pool
  refill — the service correctly refuses with 503 until the pool has credited
  enough min-entropy, so an early visitor may see "refused" before "ok". That
  is the health/crediting logic working as designed (CLAUDE.md rule 2), not a
  bug, and must not be "fixed" by lowering the crediting ratio.
- A public demo endpoint is not a production entropy service. It remains an
  uncertified software source (see plan 004's hardware-adapter seam).
- **Observed once, 2026-07-13:** for a stretch after the first deploy the
  Render edge answered most requests `404` + `x-render-routing: no-server`
  (container absent), interleaved with correct 200s. A manual restart from
  the dashboard cleared it; a 5-minute watch afterwards was 30/30 green at
  ~0.1 s. If it recurs, check the service's Logs tab for a boot loop before
  suspecting the code — the app itself answered correctly whenever it was up.
