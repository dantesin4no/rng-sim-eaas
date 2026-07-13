# @entropy/core — package conventions

This is the trust boundary of the whole platform. Rules here are strict.

- Isomorphic: must run in Node 18+ and evergreen browsers. WebCrypto only,
  accessed exclusively through `src/crypto-shim.js`.
- Zero runtime dependencies. If you think you need one, you don't.
- Module map: `physics.js` (EOM/RK4/energy), `health.js` (RCT/APT/min-entropy),
  `pipeline.js` (pool/conditioner/HMAC-DRBG), `source.js` (facade).
- `energy()` exists FOR THE TESTS. Frictionless dynamics conserve energy;
  the test tolerance (1e-4 relative over 5000 steps @ dt=1/240) is the
  integrator's quality gate. If you touch rk4Step and this fails, the
  integrator is broken — do not loosen the tolerance.
- Health cutoffs (RCT 12, APT 84/512) assume >= 4 bits/sample min-entropy at
  alpha ~ 2^-30. Changing them requires re-derivation + human sign-off.
- DRBG: do not expose K or V. Do not add a "skip reseed" path. Determinism
  under fixed seed is an intentional, tested audit property.
- TODO an agent may pick up: add NIST CAVP known-answer vectors for
  HMAC_DRBG SHA-256 to the test suite (fetch from NIST, do not invent).
