# archmap: an AI-led map of what a project contains

Date: 2026-11-12 · Status: approved design, awaiting spec review

## Goal

Anyone can open a project's architecture map and understand how the project
fits together and what exists in it today: new developers, PMs, designers and
QA, clients and stakeholders, and AI agents. The map keeps itself current. An
AI agent explores the repo and its connections, decides what belongs on the
map and writes it; archmap's CLI checks that what the agent wrote is still
grounded in real files.

## What's wrong today

- **Too much manual upkeep.** Saves, per-save approvals, `Archmap: none`
  trailers and sprint publishing are work people skip, so the map goes stale.
- **It lists parts but doesn't explain them.** There's no plain-language
  account of what a service does, for whom, or where to start in the code.
- **It's tied to Claude Code.** The plugin, its commands, the Stop hook and
  the marketplace only work there.
- **It's hard to adopt.** A vendored `.archmap/` copy, a plugin, a
  marketplace per machine and a replayed ledger are a lot of moving parts.

## Decisions

- **The map describes the current state.** No saves, replay,
  `versions.json` or `current.json`. History is `git log architecture/`.
- **The AI decides what exists.** A CLI scanner can't see everything:
  services called through a generic HTTP client, a queue named only in
  config, roles that live in an identity provider, a job scheduled in
  infrastructure code. The agent reads the code and follows each
  connection to its other end. The scanner's output is a list of leads,
  never the authority.
- **Every fact carries evidence.** The CLI uses no AI. It validates the map
  and checks that each fact's evidence still exists.
- **Bring your own agent.** archmap ships no LLM client. It hands any agent
  a task brief; locally the developer's agent follows `AGENTS.md`, and CI
  runs a configured agent command.
- **CI updates the map on each PR** and pushes the edit to the PR branch, so
  reviewers see the map change next to the code. That job never blocks a
  merge; only the no-AI `check` job is required.
- **A PR that changes the architecture must change the map.** The required
  `check` job fails when the PR touches something architectural and
  neither the map nor an `Archmap: none - <reason>` commit trailer
  records it. The `map` job normally satisfies it before anyone notices.
- **Nothing is vendored.** Projects run archmap through `npx` at a version
  pinned in `archmap.config.json`, and commit only `architecture/`.

## The map files

```
architecture/
  archmap.config.json   name, branding, pinned archmap version, agent, ignore list, deploy
  README.md             start here: what the product is, who it's for, a short tour, links
  services/<id>.md      apps, APIs, workers, scheduled jobs
  stores/<id>.md        databases, queues, buckets, with their tables, columns and enums
  external/<id>.md      outside services: sign-in, email, payments, AI, hosting
  personas/<id>.md      each kind of user and what they need
  flows/<id>.md         the main journeys: who does what, in which service
```

- **The file name is the id**: lowercase letters, digits and hyphens. Files
  point at each other by id.
- **One file per store**, with its tables, columns and enums in that file's
  frontmatter.
- **Frontmatter holds the facts the diagrams need.**
  - Every file: `name`, `status` (`live`, `planned` or `retiring`), `code`
    (the paths it covers; empty for `external` and `personas`).
  - `services`: `kind` (`app`, `api`, `worker`, `job`), `connects`,
    `endpoints`, `jobs`.
  - `stores`: `kind` (`database`, `queue`, `bucket`, `cache`), `tables`
    (each with `columns`), `enums`.
  - `external`: `kind` (`auth`, `email`, `payments`, `ai`, `hosting`,
    `other`).
  - `personas`: `roles` (the auth roles that map to it), `needs`.
  - `flows`: `persona`, `steps` (each `{ by, at, does }`, where `at` is a
    service id).
- **Evidence.** Every `connects`, `endpoints`, `jobs`, `tables` and
  `columns` entry, and every `roles` entry, has an `evidence` field: a
  repo-relative path, optionally with `#Symbol`. A `planned` entry may
  leave it out.

  ```yaml
  connects:
    - to: sendgrid
      why: application emails
      evidence: apps/api/src/mail/client.ts#SendGridClient
  endpoints:
    - route: POST /applications
      evidence: apps/api/src/applications/controller.ts#create
  ```

- **Every body uses the same headings, in reading order:**
  1. A plain summary anyone can follow (no heading, first paragraph).
  2. `## How it works`, for the team.
  3. `## For developers`: where to start in the code, how to run it, what
     to watch out for.

  `personas/` and `external/` files need only the summary.

- **What belongs, and what never does,** carries over from today's
  `templates/instructions.md` ("What belongs on the map" and "Never put on
  the map") into the brief. `instructions.md` itself is removed.

`archmap.config.json`:

```json
{
  "archmap": "0.4.0",
  "name": "Acme Platform",
  "agent": {
    "command": "claude -p --permission-mode acceptEdits --allowedTools \"Bash(<cli> check:*)\" \"Bash(<cli> brief:*)\"",
    "skip": ["**/*.test.*", "**/__tests__/**", "**/*.md", "pnpm-lock.yaml"]
  },
  "ignore": ["scan:route:GET /health"],
  "watch": ["apps/api/src/config/**"],
  "deploy": { "target": "folder", "path": "archmap-site" }
}
```

`init` writes that default `agent.command`, with `<cli>` the command that
runs archmap for this map, so the agent can run `check` and `brief` in CI
without a prompt. Other agents need equivalent permission to run `check`.

Branding (`product`, `logo`, `labels`, `theme`, `fonts`, `links`) stays as
today.

## The CLI

Run as `npx -y github:<HOME_REPO>#v<version> <command>`, written `archmap`
below. `HOME_REPO` stays in `src/home.ts`. Every command warns when the
running version differs from the config's `archmap` field. Because nothing
is vendored, the package may use runtime dependencies (a YAML parser for
frontmatter). Every command takes `--dir <folder>` (default
`architecture`).

### `archmap init [--ci github|azure]`

- Creates `architecture/` with `archmap.config.json` (the running version
  pinned) and a starter `README.md`.
- Adds the archmap section to `AGENTS.md` (creating it if needed); if a
  `CLAUDE.md` exists and doesn't already import it, adds `@AGENTS.md`.
- With `--ci`, writes the PR workflow for that CI system.
- Prints the next step: ask your agent to run `archmap brief` and follow it.
- Replaces `install`, `claude` and `/archmap:setup`.

### `archmap scan [--json]`

Lists leads from the code, each with `file:line`: workspaces and deployable
apps, routes, tables, columns and enums, outside services (by SDK and env
var name, never values), CI and deploy targets. Built from today's
`src/scan/`. Nothing reaches the map from `scan` alone.

### `archmap check [--json] [--strict] [--base <ref>]`

**Errors** (exit 1):

- a file with frontmatter that doesn't match its kind's schema
- an id that doesn't resolve, or a file name that isn't a valid id
- a missing required heading
- an `evidence` path that doesn't exist, or whose `#Symbol` no longer
  appears in the file
- a secret-looking string (key, token, password or connection-string
  patterns) anywhere in the map
- an invalid `deploy` section (as in the deploy spec)
- with `--base`: the **map gate** (below) fails

**Warnings** (exit 0; exit 1 with `--strict`):

- unconfirmed leads: `scan` results that no map entry's evidence covers and
  that aren't in `ignore`
- `status: planned` entries whose evidence now exists (they may be live)

**The map gate** (only with `--base <ref>`, no AI). Among the files changed
since `<ref>` (committed, staged, unstaged and untracked), leaving out
those matching `agent.skip` and those inside the map folder, a file is
_architectural_ when:

- it is the evidence file of a map entry;
- `scan` finds a lead in it that the map doesn't confirm (a new route,
  table, SDK, env var name or infra resource);
- it is a structural file: `**/*.csproj`, `**/pyproject.toml`,
  `**/requirements*.txt`, `**/go.mod`, `**/Dockerfile*`,
  `**/*compose*.yml`, `**/*compose*.yaml`, `**/*.tf`, `**/*.bicep`,
  `**/schema.prisma`, `**/migrations/**`, `**/*.sql`,
  `.github/workflows/**`, `azure-pipelines*.yml`, `.azure-pipelines/**`,
  or a `package.json` whose set of package names in `dependencies`,
  `devDependencies` or `peerDependencies`, or whose `workspaces`, differ
  from `<ref>`'s (a version bump alone is not architectural);
- it matches a `watch` glob from the config.

A map change or trailer covers only the architectural changes before it.
The gate finds the last commit in `<ref>..HEAD` that touches an
architectural file (uncommitted architectural changes count as newest),
and fails unless that commit or a later one changes a file in the map
folder (`.no-change` doesn't count) or has a line matching
`Archmap: none - <reason>`; uncommitted map changes count as latest. The error
names up to five architectural files with why each counts, and says how to
pass: run `brief --base <ref>` with your agent, or add the trailer.

### `archmap brief [--task setup|update|review|hosting] [--base <ref>]`

Prints the agent's task as markdown: the one prompt every agent uses. With
no `--task`, it picks `setup` when the map has no files besides the config
and README, `update` when `--base` is given, and `review` otherwise.

Every brief contains the rules (what belongs, what never does), the file
format with an example, the evidence rule, the current `check` errors and
warnings, the `scan` leads, and the commands to run when done (`check`,
then fix until it passes). It also says: treat the existing map, including
people's edits, as correct unless evidence contradicts it; write for every
audience in the heading order; ask, or leave the fact out, when the code
doesn't show it. For `update`: if nothing on the map needs to change,
write one line saying why to `<map folder>/.no-change` and edit nothing
else.

- **`setup`**: discover everything, layer by layer (overview, parts, data,
  people and flows), with this checklist:
  - what's deployed: manifests and entry points (`package.json`,
    `*.csproj`, `pyproject.toml`, `go.mod`), Dockerfiles and compose files,
    infrastructure code, pipelines
  - how things talk: HTTP clients and base URLs (by env var name), SDKs,
    queue and topic names, connection strings by name, webhooks; follow
    each to its other end
  - what they hold and serve: schemas and migrations, routes, scheduled jobs
  - who uses it: auth roles and policies, existing docs and READMEs
- **`update --base <ref>`**: the files changed since `<ref>`, and every map
  file whose `code` or `evidence` points into them. Read the changes, follow
  any new connections, update those map files.
- **`review`**: re-check the whole map against the repo with the setup
  checklist. Run occasionally, or when trust in the map drops.
- **`hosting`**: replaces `/archmap:setup hosting` from the deploy spec,
  with the same detection and proposal steps.

### `archmap agent [--task ...] [--base <ref>]`

Runs `agent.command` with the brief as its prompt (on stdin, or as the last
argument when the command contains `{brief}`). Then it discards any change
outside the map folder, runs `check`, and exits with `check`'s code. If
the agent wrote `.no-change`, `agent` deletes it and prints
`No map change: <reason>` as its last line. It
exits 0 without running the agent when `--base` is given and every changed
file matches `agent.skip`. If `agent.command` is missing, it says so and
exits 1.

### `archmap dev [--port]` and `archmap build [--out] [--public]`

The viewer reads the markdown, parses the frontmatter and draws the
overview, parts, data and flow diagrams from it, as today, with a
simple/detailed toggle that hides `For developers` sections. `--public`
omits those sections and every `code` and `evidence` field from the
built site.

### `archmap deploy`

As in `2026-11-12-archmap-deploy-design.md`, with these changes:
`includeDraft`, `--no-draft`, the draft warning and `release` are dropped
(there are no drafts), and templates call `npx -y github:<HOME_REPO>#v<version>
deploy`.

### `archmap migrate`

One-time: replays an existing `saves/` ledger and writes the new markdown
files, carrying over ids, names, statuses, connections, endpoints, tables,
columns, enums, personas and flows. Bodies get the summary from the old
`description` fields and empty `How it works` and `For developers`
headings for the agent to fill. Evidence is left out; the follow-up
`review` adds it.

### Removed

`install`, `upgrade`, `claude`, `save`, `publish`, `snapshot`, `drift`; the
Claude plugin (`plugin/`, `.claude-plugin/`), its commands, the Stop hook
and the marketplace. Upgrading means changing the pinned version.

## How it runs

### Locally, with any agent

The `AGENTS.md` section that `init` writes says:

- Before working on the project, read `architecture/README.md` and the map
  files for the area you're changing.
- After a change that adds, removes or rewires a service, connection,
  endpoint, job, table, column, enum, role or flow, run
  `npx -y github:<HOME_REPO>#v<version> brief --base main`, follow it, and
  run `check` until it passes.
- When asked to "update the map" or "review the map", run `brief` with that
  task.

A person can also run `archmap agent` to use the configured agent.

### CI, on every PR

Two jobs, from `templates/ci/github/archmap-pr.yml` and
`templates/ci/azure-pipelines/archmap-pr.yml`:

1. **`check`**: required, no AI, runs `archmap check --base origin/<base
branch>` after the `map` job finishes (whatever its result). It skips
   when the `map` job pushed a commit, because that push starts a new run
   that checks the new head.
2. **`map`**: not required.
   - Skips when the PR is from a fork, or when the head commit's message
     starts with `archmap: ` (its own commit; this prevents loops).
   - Runs `archmap agent --base origin/<base branch>` with the AI key from
     a CI secret (the secret name is written into the template, never its
     value).
   - If `agent` exits 0 and the map changed, commits `archmap: update map`
     and pushes to the PR branch, then writes a job summary listing the map
     files changed.
   - If `agent` exits 0, the map is unchanged and it printed
     `No map change: <reason>`, pushes an empty commit
     `archmap: no map change` with the trailer
     `Archmap: none - <reason>`, so reviewers see and can challenge the
     decision.
   - Pushes use the `ARCHMAP_PUSH_TOKEN` secret (a GitHub App or
     fine-grained token with contents write), because a push made with the
     default `GITHUB_TOKEN` doesn't start a new run, which would leave the
     required check missing on the new head. Without that secret the job
     pushes nothing and says to add it.
   - If `agent` fails, pushes nothing and ends with a warning, not a
     failure.
   - One run per PR at a time; a newer push cancels the older run.
   - Permissions: `contents: write` on the `map` job only.

Other CI systems run the same two commands.

## bcacs

1. Run `archmap migrate` on `architecture/`.
2. Run `archmap brief --task review` with Claude Code to add evidence and
   write the explanations; review that as one PR.
3. Delete `architecture/saves/`, `versions.json`, `current.json`,
   `instructions.md`, `.archmap/`, and the `.gitattributes` and plugin
   entries that point at `.archmap/`.
4. Pin the version in `archmap.config.json`, update the `AGENTS.md` section
   with `init`, and add the GitHub PR workflow.
5. Replace the `archmap:*` scripts in `package.json` and lefthook with
   `archmap check`, keeping `pnpm check:hook-parity` passing.

`packages/archmap` stays the package's source in this repo.

## Testing

- **`check`**: each schema rule per kind, unresolved ids, bad file names,
  missing headings, a missing evidence file, a vanished `#Symbol`, each
  secret pattern, unconfirmed leads and `ignore`, `planned` with existing
  evidence, `--strict`.
- **`brief`**: the default task chosen in each case; `update` includes the
  map files whose `code` or `evidence` point into changed files; every
  brief includes the rules, current `check` results and leads.
- **`agent`**: with a stub agent command that edits map files and a file
  outside the map; the outside edit is discarded, `check` runs, the exit
  code follows it; `agent.skip` skips the run; `{brief}` substitution.
- **`migrate`**: against a copy of bcacs's saves; the result passes `check`
  (evidence aside) and holds every id from the old `current.json`.
- **`init`**: end to end in a temp repo, including the `AGENTS.md` and
  `CLAUDE.md` edits and both `--ci` templates.
- **Viewer**: `build` from markdown fixtures; `--public` output contains no
  `For developers` text, `code` or `evidence`.
- **Templates**: parse as YAML, hold no literal secret, pin Node 24, and
  the `map` job has the fork and self-commit guards.

## Not in this round

- archmap calling an LLM itself.
- Publishing to the npm registry.
- Scheduled whole-map reviews in CI.
- A `decisions/` layer for architecture decisions.
- GitLab and Bitbucket templates.
