Re-check the whole map against the repo. Run this occasionally, or when trust in
the map drops. For every map file, confirm each connection, endpoint, job,
table, column and role still exists and that its evidence still points at it;
then look for what the code has that the map doesn't. Fix what has drifted,
remove what is gone, and add what is missing.

Use this checklist to look for what is missing:

- **What's deployed:** manifests and entry points (`package.json`,
  `*.csproj`, `pyproject.toml`, `go.mod`), Dockerfiles and compose files,
  infrastructure code, pipelines.
- **How things talk:** HTTP clients and base URLs (by env var name), SDKs,
  queue and topic names, connection strings by name, webhooks; follow each to
  its other end.
- **What they hold and serve:** schemas and migrations, routes, scheduled jobs.
- **Who uses it:** auth roles and policies, existing docs and READMEs.
