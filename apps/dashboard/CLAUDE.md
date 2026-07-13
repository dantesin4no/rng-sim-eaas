# dashboard — app conventions

- Runs its own in-browser pipeline AND consumes @entropy/api via the
  "Live service" panel (plan 003, done). The panel's default URL is baked in
  at build time from VITE_API_URL.
- `npm run e2e -w dashboard` drives the hosted demo's Connect button with
  headless Chromium (plan 006). Network-dependent, on-demand — not part of
  `npm test`.
- Visual language: dark instrument panel, per-arm channel colors
  (amber/cyan/magenta), monospace metrics. Keep it.
- No localStorage/sessionStorage. React state only.
- There is no standalone.html anymore — the hosted Pages demo is the
  no-install path. Don't reintroduce hand-copied variants of the component.
