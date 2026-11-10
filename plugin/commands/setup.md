---
description: Set up the architecture map, or fill its next layer, from the code or a short interview.
argument-hint: "[overview|parts|data|people]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs), Bash(node .archmap/bin/archmap.mjs scan:*), Bash(node .archmap/bin/archmap.mjs check:*)
---

# Set up the architecture map

Build up this project's architecture map one layer at a time. The `archmap` skill describes how to record a change (snapshot, save, ops with reasons, check); follow it for every save you write here.

Requested layer: `$ARGUMENTS` (empty means "the next missing layer").

Run every command from the project root. Call the project's copy of the CLI: `node .archmap/bin/archmap.mjs <command>`. Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command.

## 0. Check the CLI

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs`. It prints one of:

- `ok`: carry on.
- `missing <command>`: the archmap CLI isn't copied into this project (there's no `.archmap/VERSION`). Show the person what follows `missing` (the install command to run from the project root, or where to find it), then `/archmap:setup` again. Stop here.
- `old <version>`: the project's copy is older than this plugin needs (0.3.0). Point the person to `/archmap:upgrade` and stop here.

## 1. Create the map if there isn't one

If there's no `archmap.config.json` (found as described above), run:

```
node .archmap/bin/archmap.mjs init --no-skill --name "<repo name>"
```

Use the `name` in the root `package.json`, or the folder name if there isn't one, written the way people say it. `--no-skill` because this plugin provides the skill. Init also adds the `archmap`, `archmap:dev`, `archmap:check` and `archmap:drift` scripts to the root `package.json` and writes a proposed watch list into `archmap.config.json`; mention both.

If `archmap.config.json` already exists, skip `init`.

## Pick the layer

The map is built up in four layers:

1. **Overview** (`overview`): categories, the main services in each, the connections between them, outside services.
2. **Parts** (`parts`): what's inside a service: endpoints, libraries and tools, jobs, storage containers.
3. **Data** (`data`): areas, tables, columns, enums.
4. **People and flows** (`people`): personas, their jobs, and flows through the services.

If a layer was requested, do that one. If the argument isn't one of `overview`, `parts`, `data` or `people`, say so, list the four, and stop.

Otherwise run `node .archmap/bin/archmap.mjs check`. Its last line reads `Layers: overview N · parts N · data N · people N. Next: /archmap:setup <layer>`. Do the layer it names. If there's no "Next:", every layer has content: say so, suggest `/archmap:review` to compare the map with the code, and stop.

Do only this one layer in this run.

## 2. Work out the starting point

Run `node .archmap/bin/archmap.mjs scan`. It prints the repo's inventory as JSON, with a `stage`:

- `planning`: no app code (no workspace packages, no `src/`, no code files, no infrastructure). The first map comes from a short interview plus any links or files the person gives (a PRD, Miro board, persona docs). Everything is recorded with `status: planned`.
- `scaffolded`: app code exists but is thin (fewer than five routes and no schema or infrastructure files). Draft from the scan plus a few questions. Record what exists as `live` and what's only described as `planned`.
- `existing`: app code with routes, schema or infrastructure. Draft from the scan. Record what exists as `live`.

Tell the person which starting point this is and why, citing what the scan found (or didn't). If they say otherwise ("treat this as planning"), use the path they choose.

### Offer a watch list

The watch list in `archmap.config.json` tells `archmap drift` which changed files mean the map may need updating. A project that started at the planning stage has `"watch": []`, and nothing else offers one later.

If `watch` in `archmap.config.json` is empty and the stage isn't `planning`, run `node .archmap/bin/archmap.mjs scan --watch` and show the person what it prints, in plain words (for example "changes under `src/routes/` mean API endpoints"). Ask: "Add this watch list to archmap.config.json?" Write it into the config's `watch` only on a yes; otherwise leave the config as it is and carry on.

## 3. Draft the layer

Read `current.json` first (run `node .archmap/bin/archmap.mjs snapshot`) so you build on what's already recorded.

**With code** (`scaffolded` or `existing`): draft the layer as a few small saves rather than one large one: one save per category for the overview layer, one per service for the parts and data layers. Base every op on the scan and the files it lists, and name those files in each op's `reason` so a reviewer can check the save against the code. For a `scaffolded` project, ask a few short questions about what's planned but not built yet.

**Without code** (`planning`): ask at most five questions, one at a time, waiting for each answer before asking the next. Skip a question the person has already answered.

1. What are you building, and for whom?
2. Who uses it? (These become personas, in layer 4.)
3. What will people see or use: a web app, a mobile app, an admin tool?
4. What will run behind it: an API, a database, file storage, background jobs?
5. Which outside services will it depend on (sign-in, email, payments, hosting)?

Then read any links or files the person gives, and draft saves with `status: planned`. Record only what belongs to this layer; keep the rest (personas, for example) for the layer it belongs to.

## 4. Check

Run `node .archmap/bin/archmap.mjs check` and fix every problem it reports, with new saves or by correcting the saves you wrote in this run.

## 5. Ask for a review

Tell the person what you drafted, save by save, and ask them to open the map with `pnpm archmap:dev` (or `node .archmap/bin/archmap.mjs dev` if the script isn't there), review the Draft, and say what to change. Apply each correction as a new save, then run `node .archmap/bin/archmap.mjs check` again.

## 6. Publish the Baseline, only on a yes

If the project already has a published version, don't publish here; the draft goes out with the next version (`/archmap:publish`). Skip to step 7.

Otherwise, once the person is happy with the draft, ask them separately, as its own question: "Publish this as the Baseline version?" Approving the draft ("looks good") is not a yes to publishing. Show the exact command you'll run:

```
node .archmap/bin/archmap.mjs publish "Baseline" --summary "<one plain line on what the map covers>"
```

Run it only on a yes to that question, and report what it printed. If they decline, say the draft stays in Draft until they publish it with `/archmap:publish`.

## 7. CI

Ask: "Add a GitHub Actions check for the architecture map?" Write the file only on a yes. If they decline, move on.

On a yes, copy `.archmap/templates/archmap-workflow.yml` to `.github/workflows/archmap.yml` (create the folder if needed). The template calls the project's copy of the CLI, so it needs no package-manager changes. If the map isn't in `architecture/`, add `--dir <folder>` to both commands in it, for example `node .archmap/bin/archmap.mjs drift --dir <folder> --base origin/${{ github.base_ref }}`.

The workflow runs `archmap:check` (which fails the pull request when a save is invalid) and `archmap drift` against the PR's base branch (which only warns).

If `lefthook.yml` exists, or `package.json` has a script named like `check:hook-parity`, say that both `archmap:check` and `archmap:drift` must also be added to the project's git hooks. Don't edit the hook config yourself.

Finish by naming the next layer to fill, from the "Next:" in `archmap check`'s output (for example "Next: `/archmap:setup parts`").

Teammates run `node .archmap/bin/archmap.mjs claude` once after cloning to get these commands.
