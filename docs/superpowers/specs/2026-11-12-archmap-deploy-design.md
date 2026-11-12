# archmap: deploy and release for any CI and host

Date: 2026-11-12 · Status: approved design, awaiting spec review

## Goal

Each project's architecture map ends up where its team can read it, through
that project's own process: GitHub, Azure, AWS or anything else, in CI or from
a laptop. archmap never holds credentials, adds no runtime dependencies, and
keeps the map private unless someone chooses otherwise.

## Decisions

- **Publishing and deploying are separate steps.**
  - Publishing turns the sprint's drafts into a version. It changes
    `versions.json`, so it's a git change. An agent does it in the
    sprint-end PR with `/archmap:publish`, and the PR is reviewed like
    code. CI never publishes.
  - Deploying builds the viewer and copies it to a host. It only reads the
    repo, so CI needs no write access.
- **Unpublished drafts don't block a deploy.** `deploy` prints a warning and
  carries on. It never blocks a production release.
- **A hosted site shows published versions only.** `deploy` builds without
  the Draft by default, because a hosted site is documentation. `archmap dev`
  still shows the Draft locally.
- **Supported in the first version:**
  - Hosts: `folder`, `command`, `azure-static-web-apps`, `azure-blob`, `s3`
    and `github-pages`.
  - CI templates: GitHub Actions for every host, and Azure Pipelines for the
    Azure hosts and `command`. GitLab and Bitbucket use `command` for now.
- **bcacs stays local.** It uses `folder`, has no hosting job, and gets the
  PR check workflow.

## Configuration

`archmap.config.json` gains an optional `deploy` section:

```json
"deploy": {
  "target": "s3",
  "bucket": "acme-archmap",
  "prefix": "map/",
  "distribution": "E123ABC",
  "includeDraft": false
}
```

| `target`                | Required  | Optional                        | Runs                                                                                                                                                                        |
| ----------------------- | --------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`                | `path`    |                                 | Replaces `path` with the built site.                                                                                                                                        |
| `command`               | `run`     |                                 | `run` through the shell, with `ARCHMAP_SITE` set to the built folder.                                                                                                       |
| `azure-static-web-apps` | `app`     | `environment`                   | `npx -y @azure/static-web-apps-cli@2 deploy <site> --app-name <app> --env <environment, default production> --deployment-token $SWA_DEPLOYMENT_TOKEN`                       |
| `azure-blob`            | `account` | `prefix`                        | `az storage blob upload-batch --account-name <account> --destination '$web' --destination-path <prefix> --source <site> --overwrite --auth-mode login`                      |
| `s3`                    | `bucket`  | `prefix`, `distribution`        | `aws s3 sync <site> s3://<bucket>/<prefix> --delete`, then, with `distribution`, `aws cloudfront create-invalidation --distribution-id <distribution> --paths "/<prefix>*"` |
| `github-pages`          |           | `path` (default `archmap-site`) | Builds into `path`. The workflow's `actions/upload-pages-artifact` and `actions/deploy-pages` steps do the upload.                                                          |

Every target also accepts `includeDraft` (default `false`). `deploy --out

<dir>` overrides where the site is built. Otherwise it goes to a temporary
folder, except for `folder` and `github-pages`, which build into their
`path`.

- **No secrets in the config.** The only secret any target uses is
  `SWA_DEPLOYMENT_TOKEN`, read from the environment. `archmap check` fails
  if the `deploy` section contains a key named like a secret (`token`,
  `key`, `secret`, `password`, `connectionString`).
- **The config is validated.** `archmap check` rejects an unknown `target`,
  a missing required field, or a field of the wrong type, and names the
  field. So a typo fails in the PR check, not at release time.

## Commands

```bash
node .archmap/bin/archmap.mjs deploy [--dry-run] [--out <dir>]
node .archmap/bin/archmap.mjs release "<version name>" [--summary "..."] [--dry-run]
```

**`deploy` does these steps in order:**

1. Runs `check`, and stops on any problem.
2. Reads `deploy`. If it's missing, stops with: `No deploy target in
archmap.config.json. Add one, or run /archmap:setup hosting.`
3. If drafts exist, prints `Warning: <n> unpublished saves aren't on the
site. Publish them with /archmap:publish.` and carries on.
4. Builds the site, with or without the Draft according to `includeDraft`.
5. Checks that the target's CLI is on `PATH` (`aws`, `az`, `npx`). If it
   isn't, stops with the install link for that CLI. Then runs the target's
   commands as listed above, with no shell (except for `command`), passing
   the arguments as a list.
6. Reports what it deployed and where. If a provider command fails, it shows
   the command, its exit code and the last 20 lines of its output, and exits
   1.

**`--dry-run`** prints the steps, the build folder and every command exactly,
then runs nothing past the build.

**`release`** is for running by hand on a laptop. It runs `check`, then
`publish "<name>"` if drafts exist (otherwise it says there's nothing new),
then `deploy`. It asks for nothing, because it's run deliberately.

**Draft-free build.** `build(dir, out, { includeDraft })` writes `data.json`
with only the saves that belong to a published version when `includeDraft`
is `false`. `archmap build` keeps today's behaviour (Draft included) unless
`--no-draft` is passed.

## CI templates

They live under `templates/ci/`, and every one calls
`node .archmap/bin/archmap.mjs deploy`:

```
templates/ci/github/{azure-static-web-apps,azure-blob,s3,github-pages,command}.yml
templates/ci/azure-pipelines/{azure-static-web-apps,azure-blob,command}.yml
```

- **Shared by all of them:** checkout, Node 24, and permissions limited to
  what the host needs.
  - `id-token: write` for OIDC (Azure login, AWS role).
  - `pages: write` and `id-token: write` for Pages.
  - `contents: read` always.
- **The trigger** defaults to `push` to `main` plus `workflow_dispatch`
  (`trigger: main` in Azure Pipelines). Setup replaces it with the project's
  real production trigger. The templates have exactly two placeholders,
  which setup fills: `__BRANCH__` (the production branch) and `__DIR_FLAG__`
  (empty, or ` --dir <folder>` for a map outside `architecture/`).
  Credentials are always fixed references to CI variables and secrets, with
  the names written into the template: `vars.AZURE_CLIENT_ID`,
  `vars.AZURE_TENANT_ID`, `vars.AZURE_SUBSCRIPTION_ID`,
  `vars.AWS_ROLE_ARN`, `secrets.SWA_DEPLOYMENT_TOKEN` in GitHub, and
  `$(azureServiceConnection)` in Azure Pipelines. They're never values.
- **Logins by host:**
  - Azure: `azure/login@v2` with federated credentials on GitHub, or
    `AzureCLI@2` with a service connection in Azure Pipelines.
  - AWS: `aws-actions/configure-aws-credentials@v4` with
    `role-to-assume`.
  - Static Web Apps: the `SWA_DEPLOYMENT_TOKEN` secret.

## Setup: a "hosting" step

`/archmap:setup hosting`, also offered at the end of a full setup, does the
following:

1. Detects the CI system from `.github/workflows/`, `azure-pipelines.yml`,
   `.gitlab-ci.yml` or `bitbucket-pipelines.yml`.
2. Detects the cloud from Terraform, Bicep or CDK files (`azurerm_*`,
   `aws_*`, `Microsoft.Web/staticSites`) and from the deploy steps of
   existing workflows (`azure/login`, `aws-actions/*`,
   `Azure/static-web-apps-deploy`).
3. Detects the production trigger from existing deploy workflows (their
   `on:` and `environment: production`).
4. Proposes one plain sentence, for example "Deploy the map to a new
   private Static Web App when `main` deploys to production". The choices
   are the detected host, any other supported host, and "Keep it local".
   Private hosting is the default: the step names how to restrict access
   for each host (Entra ID for Static Web Apps, a private bucket behind
   CloudFront for S3, a private repo for Pages) and never sets up a public
   site without the person saying so.
5. On a yes, writes the `deploy` section and the filled-in template, and
   lists the variables or secrets the person must add to CI. It never
   creates cloud resources.

`init` adds one more `package.json` script: `archmap:deploy` →
`node .archmap/bin/archmap.mjs deploy` (no `--dir` when the map is in
`architecture/`, the same rule as the other scripts).

## bcacs

- `architecture/archmap.config.json` gets
  `"deploy": { "target": "folder", "path": "archmap-site" }`, and
  `archmap-site/` goes into `.gitignore`.
- `.github/workflows/archmap.yml` comes from
  `templates/archmap-workflow.yml` with `--dir architecture`.
- `archmap:check` and `archmap:drift` are added to lefthook, so
  `pnpm check:hook-parity` passes.
- No hosting job yet.
- `.archmap/` is re-synced with `node packages/archmap/bin/archmap.mjs
install`.

## Testing

- **Targets:** each target is tested with fake `aws`, `az` and `npx`
  scripts on a temporary `PATH`. They record their arguments and
  environment, and the tests assert the exact argument lists. Tests also
  cover a missing CLI, a failing command (exit code and output tail), and
  `--dry-run` running nothing.
- **Config validation:** an unknown target, a missing field, the wrong type
  and a secret-like key each fail `check` with the field named.
- **`deploy` / `release` end to end** with `folder`:
  - The site is built.
  - The draft warning appears.
  - A site built with `includeDraft: false` has no draft saves in
    `data.json`.
  - `release` publishes and then deploys.
- **Templates:** every file parses as YAML, holds no literal secret, pins
  Node 24, calls `archmap.mjs deploy`, and leaves no `__PLACEHOLDER__` that
  setup doesn't know how to fill.
- **bcacs:** `pnpm ci:local` runs the new PR workflow through `act`.

## Not in this round

- Publishing from CI with a bot commit.
- GitLab and Bitbucket templates.
- Public-hosting presets.
- Creating cloud resources.
- Hosting bcacs.
- Pruning stale files from `azure-blob`. The site's filenames are fixed,
  so `--overwrite` replaces them.
