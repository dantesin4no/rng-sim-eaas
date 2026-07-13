# Plan 004 — Production hardening  [DONE]

- [x] Rate limiting: per-IP token bucket (req/min + bytes/min, env-tunable),
      429 with retry_after_ms, continuous refill, bucket GC. Unit + HTTP tests.
- [x] Docker: node:22-slim image, no npm install (zero-dep service),
      HEALTHCHECK wired to /v1/health -> RCT/APT failure marks the container
      unhealthy. docker-compose.yml with env config.
- [x] CI: .github/workflows/ci.yml (npm test on push/PR) +
      nightly-battery.yml (boot service, draw 10 MB, smoke gate, full
      dieharder run, artifacts uploaded).
- [x] KAT vectors: HMAC-DRBG generalized over SHA-256/384/512; 4 published
      NIST-procedure vectors (fetched from isaracorp/test-vectors) pass
      exactly; SHA-256 additionally cross-verified against an independent
      Python SP 800-90A implementation. Remaining: import official NIST
      SHA-256 .rsp (drbgvectors_pr_false/HMAC_DRBG.rsp) in CI — file too
      large to inline.
- [x] Multi-source: CombinedSource XORs N independent EntropySources;
      null until all seeded; health = AND. Tests included.
- [x] Hardware adapter seam: EntropySource accepts sampler(state)->bytes;
      stub-sampler and stuck-sampler tests prove downstream unchanged.
- [x] Structured logging with request ids (see plan 002)
- [x] Official NIST SHA-256 .rsp KATs: cavp-runner.mjs parses the CAVP
      format (runner validated end-to-end against known-good vectors in
      .rsp syntax); nightly CI downloads the official file and runs every
      SHA-256 case, failing the build on any mismatch
