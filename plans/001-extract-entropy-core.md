# Plan 001 — Extract entropy-core from the dashboard component  [DONE]

Goal: UI-free, isomorphic pipeline package with tests as the loop oracle.

Acceptance criteria (all met):
- [x] physics.js with energy() invariant; conservation < 1e-4 rel over 5000 steps
- [x] health.js RCT/APT with latch semantics + trip-point tests
- [x] pipeline.js pool (fold-when-full), SHA-256 conditioner, HMAC-DRBG
- [x] source.js facade with ambient injection and refusal-when-unhealthy
- [x] 16 tests green via `npm test -w @entropy/core`
