# Plan 006 — Browser e2e smoke: drive the real Connect button  [DONE]

## Why

Plans 003 and 005 both had to record the same caveat: the Live service panel
was verified by replaying the exact HTTP requests it makes, not by a browser
actually clicking Connect. This closes that gap with a headless-Chromium
smoke test that loads the hosted demo, clicks the real button, draws through
the real service, and proves server-side DRBG state moved.

## Constraints

- **Not part of `npm test`.** It depends on the network, the deployed Pages
  site, and a free-tier backend that cold-starts and recycles
  (plans/005 caveats). A required check that flaky would block every merge.
  It is an on-demand script: `npm run e2e -w dashboard`.
- **Playwright lands in `apps/dashboard` devDependencies only.**
  `@entropy/core` stays dependency-free (CLAUDE.md rule 4); the service and
  core workspaces are untouched.
- **No dashboard source changes.** The test targets the panel's existing
  text ("Connect", "HEALTHY", "SEEDED", the draw buttons) — if the UI copy
  changes, the test is *supposed* to notice.
- Counter assertions must tolerate the Render free tier: read
  `drbgBytesOut` before/after and assert the delta, never absolute values;
  if the counter went *backwards*, report "service recycled mid-test" as the
  failure reason instead of a bare number mismatch.
- The draw happens only after the panel shows SEEDED — `/v1/random` 503s
  during pool fill by design (CLAUDE.md rule 2) and the test must not treat
  that as failure.

## Steps

1. [x] `plans/006` (this file), reviewed before code.
2. [x] Playwright devDep + chromium binary; `e2e` script in the dashboard
       workspace. Test file `apps/dashboard/e2e/live-demo.e2e.mjs` using
       node:test + the playwright library (matches the repo's node:test
       style; no extra test-runner). The `playwright` package has no
       postinstall, so CI's `npm install` does not download browsers.
3. [x] Test flow: fetch `/v1/health` (before) → load the demo
       (`E2E_URL`, default the Pages site) → assert the URL input is
       pre-filled with the deployed API (not localhost, not empty) → click
       Connect → wait HEALTHY + SEEDED (generous timeout for cold start) →
       click "128-bit hex" → assert a hex value appears in the service log →
       fetch `/v1/health` (after) → assert `drbgBytesOut` advanced ≥ 16.
       Every locator is scoped to the Live service panel — the local-sim
       panel renders its own SEEDED stat and 128-bit hex button, and
       unscoped locators match both (found the hard way, twice).
4. [x] Fold in: `apps/dashboard/CLAUDE.md` still says "currently
       self-contained; plan 003 migrates" — correct it (same close-out as
       the root docs in plan 005).
5. [x] Verified 2026-07-13 against the live demo from a headless container:
       `drbgBytesOut 64 -> 80` (exactly +16 for the one draw), drawn hex
       `408844c10da92ae655828e9c0fcde8e2` rendered in the panel's service
       log. `npm test` unchanged, 36 green, without Playwright installed
       browsers being touched.

## Acceptance criteria

- `npm run e2e -w dashboard` passes against the live Pages demo with no
  local server running, and its output shows the before/after
  `drbgBytesOut` values.
- `npm test` still green (36) — the suite neither runs nor requires
  Playwright.
- No changes under `packages/` or `services/`.

## Honest caveats

- This proves the *happy path* through a real browser. It does not exercise
  the UNREACHABLE / NOT CONFIGURED / 429 panel states (the HTTP-level tests
  from plans 003–005 cover those semantics server-side).
- A pass requires the free-tier backend to be awake enough to seed within
  the timeout; a cold start can make the run slow. That is the deployment
  being honest, not the test being flaky — rerun once before suspecting a
  regression.
