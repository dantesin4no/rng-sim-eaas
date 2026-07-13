# Plan 005 — Public demo API (make the Live service panel work on Pages)

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

1. [ ] `render.yaml` blueprint: docker runtime against the existing
       `Dockerfile`, `healthCheckPath: /v1/health`, env for `CORS_ORIGIN` and
       the rate-limit caps. Free plan.
2. [ ] Dashboard default service URL becomes build-configurable
       (`VITE_API_URL`, falling back to `http://localhost:8787` so the local
       dev flow is unchanged). `pages.yml` passes the deployed URL at build
       time. Connect stays a manual click — the demo must not auto-hammer a
       free-tier box on page load.
3. [ ] README: document the deploy, and be honest about cold starts.
4. [ ] Verify against the *deployed* service, not localhost: preflight
       (`OPTIONS`) returns the Pages origin, `/v1/health` is `ok`,
       `/v1/random` returns bytes, and the 429 cap trips. Then drive the
       hosted dashboard's Connect button.

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
