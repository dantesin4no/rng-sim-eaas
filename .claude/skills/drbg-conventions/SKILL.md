---
name: drbg-conventions
description: Rules for touching DRBG, pool, conditioner, or any code path that produces random output. Use when modifying pipeline.js or source.js, adding new output endpoints, or reviewing changes that read random bytes.
---

# DRBG and output-path conventions

- Consumers read ONLY via `EntropySource.drbgBytes()` / `randInt()`. Never
  add an endpoint or export that serves pool or raw bytes.
- Draw path must preserve: (a) 16 fresh pool bytes folded per draw when
  available, (b) full reseed every `reseedAfter` output bytes, (c) rejection
  sampling for ranges — modulo bias is a bug, not a nitpick.
- Internal state (K, V) never leaves the class: not in logs, not in errors,
  not in metrics, not in serialized status.
- Under health failure or an unseeded DRBG the correct behavior is refusal
  (null / 503), never fallback to Math.random, node crypto, or pool reads.
- Any change here requires: existing tests green + a new test capturing the
  changed behavior + the smoke gate from entropy-validation.
- KAT policy: determinism-under-fixed-seed is tested; official NIST CAVP
  vectors are a welcome addition but must be fetched from NIST, never
  reconstructed from memory.
