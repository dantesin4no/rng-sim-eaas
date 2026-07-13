# Entropy-as-a-Service — Agent Operating Manual

Chaotic triple-pendulum entropy platform, structured per NIST SP 800-90A/B:
noise source → continuous health tests → SHA-256 conditioner → pool → HMAC-DRBG.

## Architecture map

| Path | Package | Role |
|---|---|---|
| `packages/entropy-core` | `@entropy/core` | Physics, health tests, conditioner, pool, DRBG. UI-free, isomorphic (Node + browser). |
| `services/entropy-api` | `@entropy/api` | HTTP service. Implements `contracts/entropy-api.yaml`. Zero deps beyond core. |
| `packages/validation` | `@entropy/validation` | Statistical smoke tests for exported .bin files. |
| `apps/dashboard` | — | Vite/React UI. Local sim plus a "Live service" panel that consumes the API (plan 003, done). |
| `contracts/` | — | API contracts. **Source of truth. Never change code and contract in the same PR without saying so.** |
| `plans/` | — | Written plans. Write the plan BEFORE the code; get it reviewed. |

## Commands

- `npm test` — all workspace tests (must pass before any "done" claim)
- `npm test -w @entropy/core` — core only
- `npm run start -w @entropy/api` — run the service on :8787
- `npm run check -w @entropy/validation -- <file.bin>` — smoke-test entropy output
- `npm run dev -w dashboard` — dashboard dev server

## Non-negotiable conventions

1. **Never weaken a verification to make it pass.** If a health-test cutoff,
   energy tolerance, or statistical bound fails, the code is wrong until
   proven otherwise. Changing cutoffs requires the derivation written in
   `.claude/skills/entropy-validation/SKILL.md` and explicit human sign-off.
2. **Crediting ratio is sacred:** ≥ 64 raw bytes in per 32 conditioned bytes
   out. Anything that increases output rate must increase input rate first.
3. **Consumers only ever read from the DRBG** — never from the pool, never
   from raw samples. See `.claude/skills/drbg-conventions/SKILL.md`.
4. `@entropy/core` stays dependency-free and isomorphic. No Node-only APIs
   outside `crypto-shim.js`.
5. Every new module gets tests in the same change. Test the invariant
   (energy conservation, trip points, determinism), not the implementation.
6. Contract changes: update `contracts/entropy-api.yaml` first, then code.

## Definition of done

`npm test` green + the specific plan's acceptance criteria met + no contract
drift. If you cannot verify, say so explicitly — do not claim done.

## Where instructions live (don't mix layers)

- Persistent context / conventions → this file and per-package CLAUDE.md
- Reusable procedures → `.claude/skills/`
- Deterministic enforcement → `.claude/hooks/` (test gate, bash guard)
- Isolated side-work → `.claude/agents/` (reviewer, physics, api)
