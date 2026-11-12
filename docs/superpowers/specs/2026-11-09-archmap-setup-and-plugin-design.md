# archmap: setup and the Claude plugin

**Date:** 2026-11-09
**Status:** draft for review
**Builds on:** `packages/archmap` (commit 80714ae on `feat/archmap`)

## Goal

A project with no architecture map gets a useful, reviewed map within its first session. After that, the map stays current as the code changes, without anyone remembering to update it.

Success looks like this:

- A new project goes from nothing to a published "Baseline" version in one sitting, by running one command and reviewing a draft.
- On a project with a baseline, a pull request that changes something the map describes also changes the map, or says why it doesn't need to.
- Nothing in archmap is specific to BCACS. BCACS uses it like any other project.

## What the user told us

- Make archmap its own project, white-labelled, presented without claude.ai artifacts.
- Set up a Claude skill and plugin so teams use it effectively as the code changes.
- Think first about how a new project starts, with little data or setup.

## Assumptions (correct these in review)

- People review every save. Claude drafts saves; nothing writes the map from code without a person seeing it in a PR.
- In CI, drift only warns. It can be made to block later, once a project's watch list is reliable.
- archmap is an internal TTT Studios tool. It's published privately (see Distribution).

## What a new project gets today, and the gaps

`archmap init` writes `archmap.config.json`, an empty `versions.json`, `instructions.md`, a starter save with four empty categories, and the Claude skill. The viewer shows four empty boxes.

1. **It can't be installed.** archmap exists only inside the bcacs monorepo.
2. **The generic template mentions BCACS.** `templates/instructions.md` uses a `logbook_entry` and WorkSafeBC example.
3. **`init` stops at files.** It adds no package scripts, watch list or CI step.
4. **No next step.** Empty categories don't say what to record or how.
5. **Drift would be noise on day one.** With nothing recorded, every file looks unrecorded.

## Design

### 1. Distribution

- archmap moves to its own repository, `tttstudios/archmap`. It holds the npm package (CLI, core, viewer, templates) and the Claude plugin, with a `.claude-plugin/marketplace.json` so the repo is also the plugin marketplace.
- The package is published as `@tttstudios/archmap` to GitHub Packages. A project adds an `.npmrc` line for the `@tttstudios` scope. The CLI command stays `archmap`.
- bcacs drops `packages/archmap`, depends on `@tttstudios/archmap`, and installs the plugin like any other project. Its `architecture/` folder doesn't change.
- Releases are tagged; the plugin's commands call the CLI the project has installed, so the plugin and package versions don't have to match exactly. The plugin checks for a minimum CLI version and says how to upgrade when it's older.

### 2. Starting points

`/archmap:setup` works out where the project is and takes the matching path:

| Starting point    | Detected by                                              | Source of the first map                                                          | Status of what's recorded                              |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Idea or planning  | No app code (no workspace packages, no `src/`, no infra) | A short interview plus links or files the person gives (PRD, Miro, persona docs) | `planned`                                              |
| Scaffolded        | App code exists but is thin (few routes, no schema)      | `archmap scan` plus a few questions                                              | `live` for what exists, `planned` for what's described |
| Existing codebase | App code with routes, schema or infra                    | `archmap scan`                                                                   | `live`                                                 |

"Thin" means `scan` finds fewer than five routes and no schema or infrastructure files. The person can override the detected path ("treat this as planning").

### 3. Layers

A map is built up in four layers. Setup does layer 1 by default; each later layer is its own run.

1. **Overview:** categories, the main services in each, the connections between them, outside services.
2. **Parts:** what's inside a service: endpoints, libraries and tools, jobs, storage containers.
3. **Data:** areas, tables, columns, enums.
4. **People and flows:** personas, their jobs, and flows through the services.

`/archmap:setup` with no argument does the first missing layer it can, and ends by naming the next one. `/archmap:setup parts` (or `data`, `people`) does that layer.

The viewer shows an empty state where a layer is missing, for example "No tables recorded yet. Run `/archmap:setup data` in Claude Code." `archmap check` prints which layers have content.

### 4. `archmap scan` (new CLI command)

A deterministic inventory of the repo, printed as JSON, so Claude drafts from facts and a reviewer can rerun it. It reads files only and never runs project code.

| Fact                                                      | Read from                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workspace apps and packages, with their main dependencies | `package.json`, `pnpm-workspace.yaml`, `apps/*`, `packages/*`                                                                   |
| HTTP routes (method and path, with the file)              | Express, Fastify and Hono route files, matched by common patterns; unknown frameworks are listed as route files without parsing |
| Database schema                                           | Prisma `schema.prisma`, Drizzle schema files, SQL migration folders, `.bacpac`/`.sql` dumps listed by name only                 |
| Infrastructure                                            | Terraform resource types and names, `docker-compose` services, Dockerfiles                                                      |
| Outside services                                          | Env variable names in `.env.example`-style files and config; known SDK dependencies (Azure, AWS, Stripe, SendGrid, and so on)   |
| CI and hosting                                            | `.github/workflows/*` names and deploy targets                                                                                  |

Each fact carries the file it came from. Claude cites those files in each op's `reason`, so a reviewer can check a save against the code.

`scan` also proposes the watch list (section 6) from what it found.

### 5. `/archmap:setup` (plugin command)

1. If there's no `architecture/` folder, run `archmap init --name <repo name>`. Init now also:
   - adds `archmap`, `archmap:dev`, `archmap:check` and `archmap:drift` scripts to the root `package.json`;
   - writes the proposed watch list into `archmap.config.json`.
2. Run `archmap scan` and decide the starting point (section 2). Say which, and why.
3. **With code:** draft the layer as a few small saves, one per category (for layer 1) or one per service (for layers 2 and 3). Every op's reason names the files it came from.
   **Without code:** ask at most five questions, one at a time:
   1. What are you building, and for whom?
   2. Who uses it? (These become personas, in layer 4.)
   3. What will people see or use: a web app, a mobile app, an admin tool?
   4. What will run behind it: an API, a database, file storage, background jobs?
   5. Which outside services will it depend on (sign-in, email, payments, hosting)?

   Then read any links or files the person gives, and draft saves with `status: planned`.

4. Run `archmap check` and fix what it reports.
5. Tell the person to open `pnpm archmap:dev`, review the Draft, and say what to change. Apply corrections as new saves.
6. When the person approves, and only then, run `archmap publish "Baseline"`.
7. Offer to add the CI step (section 7). Write the workflow only on a yes.

### 6. Watch list and `archmap drift` (new CLI command)

`archmap.config.json` gets a `watch` list that maps file patterns to what they mean on the map:

```json
"watch": [
  { "paths": ["apps/api/src/routes/**"], "means": "API endpoints", "layer": "parts" },
  { "paths": ["infra/**/*.tf"], "means": "Hosting and Azure services", "layer": "overview" },
  { "paths": ["apps/*/package.json"], "means": "Libraries and tools", "layer": "parts" },
  { "paths": ["**/migrations/**", "**/schema.prisma"], "means": "Database tables and columns", "layer": "data" }
]
```

Patterns use Node's `path.matchesGlob`, so archmap still has no dependencies.

`archmap drift [--base <ref>]`:

1. If no version is published yet, print "No baseline yet: run /archmap:setup" and exit 0.
2. Collect the changed files: `git diff --name-only <base>...HEAD`, plus staged, unstaged and untracked files. The default base is the merge-base with the remote's default branch.
3. Match them against the watch list.
4. The change is **covered** when a new save under `architecture/saves/` is in the same diff, or when a commit on the branch has the trailer `Archmap: none - <reason>`.
5. Print each uncovered group: what it means, the layer, and the files. Exit 0, or exit 1 with `--strict`.
6. `--json` prints the same as JSON for the hook and CI.

### 7. CI

- `archmap check` fails a pull request when a save is invalid or leaves broken references.
- `archmap drift --base origin/<default>` runs in the same job. It writes uncovered groups to the job summary and as a warning annotation, and doesn't fail the job.
- Setup offers a `.github/workflows/archmap.yml` that runs `pnpm archmap:check` and `pnpm archmap:drift`. Repos with a hook-parity rule (bcacs has one) need the same scripts in their git hooks; setup says so instead of editing hook config itself.

### 8. The Claude plugin

```
plugin/
  .claude-plugin/plugin.json
  skills/archmap/SKILL.md          when and how to record a change (today's skill, updated)
  commands/setup.md                /archmap:setup [overview|parts|data|people]
  commands/update.md               /archmap:update  record what this branch changed
  commands/review.md               /archmap:review  compare the map to the code and list differences
  commands/publish.md              /archmap:publish "<name>"  publish the draft
  hooks/hooks.json                 the Stop hook below
  hooks/drift-reminder.mjs
```

- **The skill** stays the single description of how to record a change. The commands call it rather than repeating it.
- **`/archmap:update`** runs `archmap drift`, reads the changed files in each uncovered group, and drafts saves for them. When a group needs no map change (a refactor, a test), it says so and suggests the `Archmap: none` trailer for the commit.
- **`/archmap:review`** runs `archmap scan`, compares it with `current.json`, and lists what's in the code but not the map, and the reverse. It changes nothing until the person picks what to record.
- **`/archmap:publish`** shows what the draft contains, asks for a name and a one-line summary, then runs `archmap publish`.
- **The Stop hook** runs `archmap drift --json` when Claude finishes a turn:
  - It stays silent when there's no baseline, when nothing watched changed, when everything is covered, or when `stop_hook_active` is set (so it never loops).
  - Otherwise it returns `decision: "block"` with a reason naming the uncovered groups and asking Claude to run `/archmap:update`, or to say why no map change is needed.
  - It reminds once per set of files per session: it remembers which groups it already raised, in a file under the session's temp folder.
  - It finds the CLI in the project's `node_modules/.bin/archmap`. If the CLI isn't installed, it does nothing.

### 9. Fixes to the existing package

- Replace the BCACS example in `templates/instructions.md` with a neutral one (an `orders.status` column).
- `archmap check` prints the layers that have content and the next one to fill.
- The viewer shows empty states per layer (section 3).

## Error handling

- `scan` skips files it can't parse and lists them under `unreadable` with the reason. It never fails the whole scan for one file.
- `drift` outside a git repo, or with an unknown base, prints the problem and exits 0 (exit 1 with `--strict`), so a misconfigured hook never blocks Claude.
- The Stop hook has a 10-second limit. On a timeout or any error it lets Claude stop and logs one line.
- `/archmap:setup` on a project that already has a map skips `init` and goes straight to the next missing layer.

## Testing

- **Unit (vitest):** watch-pattern matching; drift coverage rules (new save, trailer, no baseline); each scan reader against small fixture repos in `src/__tests__/fixtures/` (Express routes, Prisma, Terraform, docker-compose, env files); the layer report from `check`.
- **Hook:** run `drift-reminder.mjs` with recorded Stop-hook inputs, and check it's silent, blocks, and stops after one reminder as described.
- **End to end, by hand, before release:**
  1. an empty folder (planning path, interview, Baseline);
  2. a scaffolded app (scan, thin layer 1);
  3. bcacs itself (existing map, `/archmap:review` and drift on a branch that adds a route).
- The package keeps `vitest run --coverage` as its `test` script.

## Build order

1. Extract `tttstudios/archmap`, fix the template, publish `@tttstudios/archmap` to GitHub Packages, and switch bcacs to it.
2. `archmap scan` and the init additions (package scripts, watch list).
3. The plugin: skill, `/archmap:setup`, `/archmap:publish`.
4. `archmap drift`, `/archmap:update`, the Stop hook and the CI workflow.
5. `/archmap:review`, the layer report in `check`, and viewer empty states.

Each step ships on its own, and bcacs adopts each as it lands.

## Out of scope

- Writing the map from code without a person reviewing it.
- Parsing every web framework or ORM. `scan` covers the common ones and lists the rest as files.
- Making drift block pull requests. A project can opt in with `--strict` later.
- Hosting the viewer (Azure Static Web Apps or similar). `archmap build` already produces a static site.
