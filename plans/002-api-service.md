# Plan 002 — entropy-api service  [DONE]

Done: /v1/random, /v1/int, /v1/health, /v1/metrics, /v1/ambient per contract;
request-jitter ambient injection; 503 refusal semantics.

Hardening (closed in the plan-003/004 sprint):
- [x] HTTP-level tests spawning the server on an ephemeral port
- [x] Graceful shutdown draining in-flight draws (SIGTERM/SIGINT verified)
- [x] Structured logging: JSON lines with request id / method / path /
      status / latency / ip; x-request-id response header; tested to never
      contain entropy values
