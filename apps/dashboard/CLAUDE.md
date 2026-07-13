# dashboard — app conventions

- Currently self-contained (runs its own in-browser pipeline). Plan 003
  migrates it to consume @entropy/api and render fleet/service state.
- Visual language: dark instrument panel, per-arm channel colors
  (amber/cyan/magenta), monospace metrics. Keep it.
- No localStorage/sessionStorage. React state only.
- Keep `standalone.html` regenerable: if you change the component, note that
  standalone.html is a build artifact derived from it.
