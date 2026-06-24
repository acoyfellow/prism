# prism

> Archived 2026-06-24.

Prism was a Cloudflare-native fan-out spike: one task split into parallel beams executed in separate Sandboxes, then aggregated. It proved a useful execution topology but had no repository/revision identity, no qualification semantics, and no tests.

The execution topology is being carried forward into repository revision qualification work and dogfooded through My AX. Prism is archived rather than maintained as a separate demo.

## What survived

- Worker + Workers AI + Agent sub-agents + per-run Sandbox topology;
- bounded runner count, output limits, and timeouts;
- fail-closed bearer auth shape.

## What did not

- standalone product;
- the overstated durable-recovery/polling claims in the prior README.
