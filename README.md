# Entropy-as-a-Service — Agentic Engineering Starter Kit

A chaotic triple-pendulum RNG platform scaled from a single-page demo into a
tested monorepo, structured per NIST SP 800-90A/B, and instrumented for
agentic development with Claude Code (CLAUDE.md files, skills, hooks,
subagents, plans, contracts).

## Quick start

Requires Node.js 18+ (repo verified on 22).

```bash
npm install            # links workspaces; installs dashboard's vite/react
npm test               # 19 tests: physics invariants, health trips, DRBG, e2e
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

## CI

`.github/workflows/ci.yml` runs the full test suite on every push/PR.
`nightly-battery.yml` boots the service, draws 10 MB, runs the smoke gate and
a full dieharder battery, and uploads the report as an artifact.

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
packages/entropy-core/        physics + health + conditioner + pool + DRBG (+16 tests)
packages/validation/          statistical smoke gate for .bin files
services/entropy-api/         zero-dependency HTTP service (+3 tests)
apps/dashboard/               the v2 React UI (Vite)
```

## The loop this repo is built around

gather context → plan (plans/) → act → **verify** → iterate. Verification is
layered: unit tests on invariants (energy conservation, health trip points,
DRBG determinism), an end-to-end pipeline test, a statistical smoke gate, and
hooks that make the test gate unskippable during agent sessions. Open work is
staged in plans/003 and plans/004 as ready-to-run agent loops.

## Honest scope

Verified in this environment: all 19 tests green; every endpoint exercised;
128 KB drawn from the live service passed the five-check smoke gate
(monobit z=0.56, chi-square 246/df 255, Shannon 7.9987 b/B, |scc| 0.0006).
Still an uncertified software entropy source — see plans/004 for the
hardware-adapter path and CAVP vector task.
