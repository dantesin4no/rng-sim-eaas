---
name: entropy-validation
description: Validate RNG output quality and derive health-test cutoffs. Use when exporting entropy, running or interpreting dieharder / NIST STS results, investigating statistical anomalies (bit balance, chi-square, min-entropy), or when any change touches health-test cutoffs, the conditioner, or the crediting ratio.
---

# Entropy validation procedure

## Fast local gate (always run after pipeline changes)

1. Generate a sample: start the API (`npm run start -w @entropy/api`), wait for
   `drbg_ready 1` on `/v1/metrics`, then pull >= 1 MB:
   `for i in $(seq 256); do curl -s "localhost:8787/v1/random?bytes=4096" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(Buffer.from(JSON.parse(d).data,"hex")))'; done > sample.bin`
2. Run the smoke test: `npm run check -w @entropy/validation -- sample.bin`
3. All five checks must PASS. Any FAIL: stop, bisect the pipeline stage
   (raw → conditioned → DRBG) by sampling at each tap point.

## Real assurance (before any release claim)

- dieharder: `dieharder -a -g 201 -f sample.bin` on >= 10 MB. Many tests
  rewind small files; small samples give false confidence.
- NIST STS on the same sample.
- Record results in plans/ under the release plan.

## Cutoff derivation (required to change RCT/APT parameters)

- Estimate min-entropy H per sample with the MCV estimator on >= 1M raw
  samples (`minEntropyMCV`).
- RCT cutoff: C = 1 + ceil(-log2(alpha) / H), alpha = 2^-30.
- APT cutoff: critical value of Binomial(W=512, p=2^-H) at 1 - alpha
  (normal approximation acceptable; document the calculation).
- Update health.js constants AND this file AND the tests in the same change.
  Human sign-off required (see root CLAUDE.md rule 1).
