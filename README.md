# Entropy-as-a-Service — Agentic Engineering Starter Kit

A chaotic triple-pendulum RNG platform scaled from a single-page demo into a
tested monorepo, structured per NIST SP 800-90A/B, and instrumented for
agentic development with Claude Code (CLAUDE.md files, skills, hooks,
subagents, plans, contracts).

## Live demo

**▶ [Run the simulator in your browser](https://dantesin4no.github.io/rng-sim-eaas/)**

No install, no API key, nothing to run locally. The entire pipeline executes
client-side in the tab: the triple pendulum integrates at 240 Hz, your pointer
and keystrokes get folded in as ambient entropy, the SP 800-90B health tests
run continuously on the raw samples, and every coin flip, D20 roll, and 64 KB
.bin export you pull comes out of the HMAC-DRBG at the end of the chain. Watch
the pool fill and the min-entropy estimate settle in real time.

The **Live service** panel in the demo talks to a real deployed backend: hit
**Connect** and the page polls `GET /v1/health` on the hosted `@entropy/api`,
draws coins/D20s/128-bit hex through `GET /v1/random` and `GET /v1/int`, and
forwards your pointer and keyboard events into *the service's* entropy pool via
`POST /v1/ambient` — your browser becomes one of its noise sources. So the demo
exercises both paths: the whole pipeline client-side in the tab, and the same
pipeline as a network service.

Two caveats worth knowing before you click:

- The backend is a free-tier instance. If it has gone idle, the first
  **Connect** can take a few seconds to wake, and `/v1/random` answers 503
  while the pool is still crediting min-entropy — the panel shows this rather
  than hiding it.
- Must be served over HTTPS. `crypto.subtle` (the SHA-256 conditioner and
  HMAC-DRBG) does not exist in an insecure context, so the pipeline stalls at
  the conditioner if you open the page over plain HTTP.

The demo is the dashboard build, deployed to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main` — it can't drift from
the source, because it *is* the source. Enable it once under
**Settings → Pages → Source: GitHub Actions**.

## Quick start

Requires Node.js 18+ (repo verified on 22).

```bash
npm install            # links workspaces; installs dashboard's vite/react
npm test               # 36 tests: physics invariants, health trips, DRBG, e2e
npm run start:api      # entropy service on http://localhost:8787
npm run dev:dashboard  # the v2 UI (still self-contained; see plans/003)
```

Try the service:

```bash
curl "localhost:8787/v1/random?bytes=32"
curl "localhost:8787/v1/int?max=20"
curl "localhost:8787/v1/health"
curl "localhost:8787/v1/metrics"
```

Validate output quality:

```bash
# draw a sample, then:
npm run check -w @entropy/validation -- sample.bin
# real assurance: dieharder -a -g 201 -f sample.bin  (use >= 10 MB)
```

## Run in Docker

```bash
docker compose up --build     # service on :8787, container healthcheck = /v1/health
```

An RCT/APT health-test failure marks the container unhealthy — the SP 800-90B
state is visible to your orchestrator.

## Live dashboard mode (plan 003)

Start the API, then `npm run dev -w dashboard`, open the dashboard, and hit
**Connect** in the "Live service" panel. It polls /v1/health, draws through
the service, and forwards your pointer/keyboard/motion events into the
service's entropy pool via POST /v1/ambient. CORS origin is configured with
the CORS_ORIGIN env var (default: the Vite dev server).

The hosted demo does the same thing against the deployed API
(`render.yaml`, which sets CORS_ORIGIN to the Pages origin). The endpoint the
Pages build ships with comes from the **`API_URL` repository variable**, injected
as `VITE_API_URL` — it is deliberately *not* in the repo, so it is the one piece
of config you cannot discover by reading the source:

```
gh variable set API_URL --body https://rng-sim-entropy-api.onrender.com
```

If it is unset, `pages.yml` fails the build on this repo rather than shipping a
dashboard that silently points at the visitor's own localhost. Forks still build;
their Live service panel renders as NOT CONFIGURED with the URL field editable.

## CI

`.github/workflows/ci.yml` runs the full test suite on every push/PR.
`nightly-battery.yml` boots the service, draws 10 MB, runs the smoke gate and
a full dieharder battery, and uploads the report as an artifact.
`pages.yml` runs the tests, then builds and deploys the dashboard to the live
demo — a red suite blocks the deploy.

## Layout

```
CLAUDE.md                     agent operating manual (conventions, loop rules)
.claude/
  settings.json               hook wiring (PreToolUse bash guard, PostToolUse test gate)
  hooks/                      guard-bash.sh, test-gate.sh (deterministic enforcement)
  skills/                     entropy-validation, drbg-conventions (procedures)
  agents/                     crypto-reviewer, physics-engineer, api-engineer
plans/                        written plans; 001-002 done, 003-004 open
contracts/entropy-api.yaml    API source of truth — code follows contract
packages/entropy-core/        physics + health + conditioner + pool + DRBG (+25 tests)
packages/validation/          statistical smoke gate for .bin files
services/entropy-api/         zero-dependency HTTP service (+11 tests)
apps/dashboard/               the v2 React UI (Vite) — also the live demo
```

## The loop this repo is built around

gather context → plan (plans/) → act → **verify** → iterate. Verification is
layered: unit tests on invariants (energy conservation, health trip points,
DRBG determinism), an end-to-end pipeline test, a statistical smoke gate, and
hooks that make the test gate unskippable during agent sessions. Open work is
staged in plans/003 and plans/004 as ready-to-run agent loops.

## Honest scope

Verified in this environment: all 36 tests green; every endpoint exercised;
128 KB drawn from the live service passed the five-check smoke gate
(monobit z=0.56, chi-square 246/df 255, Shannon 7.9987 b/B, |scc| 0.0006).
Still an uncertified software entropy source — see plans/004 for the
hardware-adapter path and CAVP vector task.
