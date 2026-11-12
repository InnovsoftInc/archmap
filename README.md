# archmap

An architecture map kept as markdown files in your repo. Anyone can open it and understand how the project fits together and what exists in it today: new developers, PMs, designers and QA, clients and stakeholders, and AI agents.

An AI agent explores the repo and its connections, decides what belongs on the map and writes it. archmap's CLI uses no AI: it validates the map and checks that each fact's evidence still points at real files. Any agent works (Claude Code, Codex, Cursor, Copilot and others); the package ships no LLM client and no plugin.

Nothing in the package is specific to one project. Each project brands its own map with `archmap.config.json`.

archmap lives in this repo. Projects don't install it: they run it with `npx -y github:InnovsoftInc/archmap#v<version>` at the version their `archmap.config.json` pins.

## Quick start

Run this once from the project root (Node 24 or newer), with the latest release tag in place of `v0.4.0`:

```bash
npx -y github:InnovsoftInc/archmap#v0.4.0 init
```

`init` creates `architecture/` with `archmap.config.json` (pinned to this version) and a starter `README.md`, and adds an archmap section to `AGENTS.md` (plus `@AGENTS.md` in an existing `CLAUDE.md`). Add `--ci github` or `--ci azure` to write the PR workflow too.

Then ask your agent to run `brief` and follow it:

```bash
npx -y github:InnovsoftInc/archmap#v0.4.0 brief
```

On an empty map the brief is the setup task: discover everything in the code, write the map files, then run `check` until it passes. Nothing is installed or vendored. Projects run archmap through `npx` at the version pinned in `archmap.config.json`, and commit only `architecture/`. To upgrade, change the pinned version.

## The map folder

```
architecture/
  archmap.config.json   name, branding, pinned archmap version, agent, ignore list
  README.md             start here: what the product is, who it's for, a short tour
  services/<id>.md      apps, APIs, workers, scheduled jobs
  stores/<id>.md        databases, queues, buckets, with tables, columns and enums
  external/<id>.md      outside services: sign-in, email, payments, AI, hosting
  personas/<id>.md      each kind of user and what they need
  flows/<id>.md         the main journeys: who does what, in which service
```

The file name is the id. Frontmatter holds the facts the diagrams need (kind, status, connections, endpoints, tables) and each carries `evidence`: a file path, optionally with `#Symbol`. The body explains in plain language: a summary, then `## How it works`, then `## For developers`. The map describes the current state; history is `git log architecture/`.

## Commands

Run them as `npx -y github:InnovsoftInc/archmap#v0.4.0 <command>`, written `archmap` below.

| Command                                                                | What it does                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `archmap init [--name] [--ci github\|azure]`                           | Creates `architecture/`, the `AGENTS.md` section and, with `--ci`, the workflow |
| `archmap scan [--json]`                                                | Lists leads from the code: `<key>  <file>` per line, or JSON                    |
| `archmap check [--json] [--strict] [--base <ref>]`                     | Validates the map and its evidence; with `--base`, the map gate (run it in CI)  |
| `archmap brief [--task setup\|update\|review\|hosting] [--base <ref>]` | Prints the task for an agent to follow                                          |
| `archmap agent [--task ...] [--base <ref>]`                            | Runs `agent.command` from the config on the brief                               |
| `archmap dev [--port 4321]`                                            | Serves the map locally and picks up file changes                                |
| `archmap build [--out archmap-site] [--public]`                        | Writes the map as a static site for any static host                             |
| `archmap migrate`                                                      | Turns an old `saves/` ledger into map files                                     |

All of them take `--dir <folder>` (default `architecture`). Every command except `init` and `scan` warns on stderr when `archmap.config.json` pins a different version than the one running. Errors print their message and exit 1.

## CI

`init --ci github` (or `azure`) writes two jobs for pull requests:

1. `check` (required, no AI) runs `archmap check --base origin/<base branch>`. It fails when the PR changes the architecture but neither the map nor an `Archmap: none - <reason>` commit trailer records it.
2. `map` (not required) runs `archmap agent --base origin/<base branch>` with the AI key from a CI secret and pushes the map edit to the PR branch, so reviewers see it next to the code. It never blocks a merge.

### Secrets (GitHub)

Add two repository secrets for the `map` job:

- `ANTHROPIC_API_KEY`, or whatever key your `agent.command` needs (change the env name in the workflow if you use another agent).
- `ARCHMAP_PUSH_TOKEN`: a GitHub App or fine-grained token with contents write. A push made with the default `GITHUB_TOKEN` starts no new run, so the required `check` job would be missing on the new head. Without this secret the job commits but does not push, and ends with a warning telling you to add it.

### Azure Pipelines

Add `ANTHROPIC_API_KEY` (or your agent's key) as a secret pipeline variable. The build service identity needs Contribute permission on the repo so the `map` job can push. Azure Repos does not start PR pipelines from the YAML alone: add the pipeline as a build validation in the target branch's branch policy, and make it required so `check` gates the merge.

Other CI systems run the same two commands.

### The agent command

`init` sets `agent.command` to Claude Code, allowed to edit files and to run `archmap check` and `archmap brief` without asking, since nobody is there to approve a command in CI:

```
claude -p --permission-mode acceptEdits --allowedTools "Bash(<cli> check:*)" "Bash(<cli> brief:*)"
```

`<cli>` is the command that runs archmap for this map. Another agent needs the same: permission to edit files in the map folder and to run `check` without a prompt. The command gets the brief on stdin, or in place of `{brief}` when the command contains it. If the agent decides the map needs no change, it writes the reason to `<map folder>/.no-change` (which `init` adds to the map folder's `.gitignore`); `archmap agent` reads and deletes it, and the `map` job commits the reason as an `Archmap: none` trailer. When you run `brief` yourself instead, add `Archmap: none - <reason>` to your commit message.

The `check` job counts a `package.json` only when the packages it depends on, or its workspaces, change; a version bump alone is not architectural. A map change or `Archmap: none` trailer covers only the architectural changes made before it: a later commit that changes the architecture needs its own.

## Moving from saves

Projects on archmap 0.3 or earlier keep a `saves/` ledger. Run `archmap migrate` once: it replays the ledger and writes the markdown files, carrying over ids, names, statuses, connections, endpoints, tables, columns, enums, personas and flows. Then run `archmap brief --task review` with your agent to add evidence and write the explanations, and delete `saves/`, `versions.json`, `current.json` and `instructions.md`.

## White-labelling

`architecture/archmap.config.json`:

```json
{
  "name": "Acme Platform",
  "product": "Architecture map",
  "logo": "logo.svg",
  "labels": { "boundary": "Acme Platform", "outside": "Outside Acme" },
  "theme": {
    "light": { "--accent": "#0a7d4f" },
    "dark": { "--accent": "#4fd1a0" }
  },
  "fonts": {
    "stylesheet": "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap",
    "sans": "Inter, sans-serif"
  },
  "links": [{ "label": "Repo", "url": "https://github.com/acme/platform" }]
}
```

Any CSS custom property the viewer uses can be overridden under `theme.light` and `theme.dark`. The full list is at the top of `viewer/styles.css`.

## How it works

- The map is parsed from the markdown files (frontmatter with a YAML parser, bodies with `marked`). `check` validates it against each kind's schema and looks every evidence path up in the repo.
- `build` and `dev` write the viewer (`viewer/`), plain HTML, CSS and JavaScript with no framework and no build step, reading a generated `data.json`.
- The CLI runs on Node 24 straight from the TypeScript source, with no build step. `bin/archmap.mjs` strips the types itself because Node won't do it for files under `node_modules`, where `npx` runs the package from.

## Developing archmap

Clone this repo and use Node 24 or newer with pnpm 10 (the version is pinned in `package.json`):

```bash
pnpm install
pnpm test        # vitest, with coverage written to coverage.json
pnpm lint        # oxlint, then eslint
pnpm typecheck   # tsc --noEmit
```

Run one test file with `pnpm exec vitest run src/__tests__/<file>`. CI (`.github/workflows/ci.yml`) runs typecheck, lint and test on every push and pull request. To release, bump `version` in `package.json`, tag the commit `v<version>` and push the tag; projects then pin that tag.
