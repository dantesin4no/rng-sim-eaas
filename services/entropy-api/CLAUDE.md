# @entropy/api — service conventions

- The contract is `contracts/entropy-api.yaml`. Code follows contract, never
  the reverse. Contract change = separate, flagged change.
- Zero deps beyond @entropy/core and node builtins. No express, no fastify.
- Every request injects arrival jitter as ambient entropy — keep this.
- Error semantics: 503 with a JSON body when the DRBG isn't seeded or health
  has failed. Never block a request waiting for entropy; never serve raw or
  pool bytes as a fallback.
- MAX_BYTES_PER_REQUEST = 4096. Rate limiting is plan 004; don't improvise it.
