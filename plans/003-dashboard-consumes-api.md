# Plan 003 — Dashboard consumes the API  [DONE]

1. [x] Contract: CORS (CORS_ORIGIN env, OPTIONS preflight) + 429 rate-limit
       semantics documented in contracts/entropy-api.yaml. Human sign-off:
       given via "resume plan 3 and 4".
2. [x] Dashboard v2.1: "Live service" panel — connect to any @entropy/api URL,
       poll /v1/health @1 Hz, render pool/min-entropy/DRBG/reseeds, draw via
       service endpoints, surface 429/503/unreachable states verbatim.
       Browser ambient events (pointer/keys/motion) forwarded to the service
       pool via POST /v1/ambient every 2 s — the browser becomes one of the
       service's entropy sources. Local sim retained as demo mode.
3. [x] Reviewer checklist pass: no key material exposed; refusals surfaced
       honestly; rejection sampling intact; /v1/int rate-debit corrected to
       8 bytes to cover rejection redraws.

Verified: 35 tests green (25 core + 10 api incl. HTTP-level CORS/429/503);
live curl smoke: CORS header, 204 preflight, exact 429 trip at cap,
SIGTERM clean drain. Browser-path smoke gate on drawn bytes: run manually
via npm run dev + Connect (not automatable headlessly here).
