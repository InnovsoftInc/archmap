There is no map yet, or it is thin. Discover everything in the code, layer by
layer (overview, parts, data, people and flows), and write one map file for each
thing you find.

Work through this checklist:

- **What's deployed:** manifests and entry points (`package.json`,
  `*.csproj`, `pyproject.toml`, `go.mod`), Dockerfiles and compose files,
  infrastructure code, pipelines.
- **How things talk:** HTTP clients and base URLs (by env var name), SDKs,
  queue and topic names, connection strings by name, webhooks; follow each to
  its other end.
- **What they hold and serve:** schemas and migrations, routes, scheduled jobs.
- **Who uses it:** auth roles and policies, existing docs and READMEs.

Write `README.md` last: what the product is, who it's for, a short tour of the
map, and links.

When the map is in place, offer the hosting step: run `brief --task hosting`.
