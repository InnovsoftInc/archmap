# archmap setup and Claude plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn archmap into a standalone, privately published package plus a Claude Code plugin. A new project then goes from nothing to a reviewed "Baseline" map in one session, and the map stays current as the code changes.

**Architecture:** The npm package (`@tttstudios/archmap`) gets two deterministic commands, `scan` (an inventory of the repo) and `drift` (watched files changed without a save), plus a layer report in `check`. The plugin is prompts and one hook: commands tell Claude how to use those CLI commands, and a Stop hook runs `drift` at the end of each turn. The package and the plugin live in one repo, `tttstudios/archmap`, which is also the plugin marketplace.

**Tech Stack:** Node 24 running TypeScript directly (type stripping, no build step), no runtime dependencies, vitest with coverage, GitHub Packages, Claude Code plugins (commands, skills, hooks).

**Spec:** `docs/superpowers/specs/2026-11-09-archmap-setup-and-plugin-design.md`

## Global Constraints

- Node `>=24`. The CLI runs from `src/cli.ts`, with no build step.
- No runtime dependencies. Globs use `path.posix.matchesGlob`; git is called with `node:child_process` `execFileSync`.
- The package name is `@tttstudios/archmap`, published to GitHub Packages (`https://npm.pkg.github.com`). The command stays `archmap`.
- The package's `test` script stays `vitest run --coverage`.
- `scan` reads files only and never runs project code. It skips `node_modules`, `.git`, `dist`, `build`, `coverage` and `.turbo`.
- `drift` exits 0 unless `--strict` is passed, including on errors (no git, unknown base).
- In CI, drift warns and never fails the job. `check` fails it.
- The Stop hook has a 10-second limit and is silent on any error.
- The planning interview asks at most five questions, one at a time (spec §5).
- `archmap publish` runs only after the person approves. No command publishes on its own.
- Layer names, in order: `overview`, `parts`, `data`, `people`.
- The no-change trailer is exactly `Archmap: none - <reason>`, matched case-insensitively on `Archmap: none`.
- Creating the GitHub repo, pushing, tagging and publishing are outward actions. Ask the person before each one.

## Review Focus

1. **CI checkouts are shallow** (`actions/checkout` defaults to depth 1), so the merge-base can't be found. Expected: drift reports "can't find the base" and exits 0, and the workflow template uses `fetch-depth: 0`. The test is in Task 9.
2. **The map isn't at the repo root** (`--dir docs/architecture`, or a monorepo package). Expected: a new save under that folder still counts as covering the change. The test is in Task 9.
3. **A watched file is deleted or renamed.** Expected: it counts as a change to that group. The test is in Task 9.
4. **The repo has `node_modules` or `dist` folders containing route-like files.** Expected: scan ignores them. The test is in Task 5.
5. **An older map has no `watch` list, or a project has no `package.json`.** Expected: drift says "No watch list: run `archmap scan --watch`" and exits 0, and init skips the package scripts without failing. The tests are in Tasks 6 and 9.

---

## Phase A: standalone and published (spec build step 1)

### Task 1: Make the package standalone

**Files:**

- Modify: `packages/archmap/package.json`, `eslint.config.ts`, `vitest.config.ts`, `.oxlintrc.json`, `tsconfig.json`
- Modify: `packages/archmap/templates/instructions.md` (the neutral example)
- Modify: `packages/archmap/src/commands.ts` (the `init` `skill` option)
- Test: `packages/archmap/src/__tests__/package.test.ts` (new)

**Interfaces:**

- Produces: `init(dir, opts: { name?; repoRoot?; now?; skill?: boolean })`. `skill` defaults to `true`. With `false`, init doesn't write `.claude/skills/archmap/SKILL.md`, because the plugin provides the skill.

- [ ] **Step 1: Write failing tests** in `package.test.ts`:
  - `"the instructions template has nothing project-specific"`: reads `templates/instructions.md` and expects no match for `/logbook|WorkSafeBC|BCACS/i`, and a match for `orders.status`.
  - `"package.json is ready to publish"`: expects `name === "@tttstudios/archmap"`, no `private`, `publishConfig.registry === "https://npm.pkg.github.com"`, `bin.archmap === "./src/cli.ts"`, no `workspace:` version anywhere in it, and a `files` list that includes `plugin`.
  - In `commands.test.ts`, `"init can leave the skill to the plugin"`: `init(dir, { repoRoot: root, now, skill: false })`, then the skill file doesn't exist.
- [ ] **Step 2: Run them and check they fail.** Run: `pnpm --filter archmap exec vitest run src/__tests__/package.test.ts src/__tests__/commands.test.ts`. Expected: 3 failures.
- [ ] **Step 3: Implement.**
  - Replace the example in `instructions.md` with an `orders.status` column add: enum `order_status`, `after: "total"`, desc "Where the order is in fulfilment.", and a reason in the same plain style.
  - Inline the ESLint, vitest and oxlint settings now pulled from `@repo/*`: copy what the base configs set, so the package has no workspace dependencies. Make `lint` run `oxlint && eslint . --max-warnings 0`.
  - Rename the package, add `publishConfig`, `repository` (`https://github.com/tttstudios/archmap`) and `license: "UNLICENSED"`, and remove `private`.
  - Add the `skill` option to `init`, and a `--no-skill` CLI flag for it (`parseArgs` with `allowNegative: true` and `skill: { type: "boolean", default: true }`).
- [ ] **Step 4: Run the package's whole suite.** Run: `pnpm --filter @tttstudios/archmap exec vitest run`, then `pnpm --filter @tttstudios/archmap typecheck`, then `pnpm --filter @tttstudios/archmap lint`. Expected: all pass. Update the root `package.json` devDependency to `"@tttstudios/archmap": "workspace:*"` and run `pnpm install`.
- [ ] **Step 5: Check what would be published.** Run: `cd packages/archmap && npm pack --dry-run`. Expected: `src/`, `viewer/`, `templates/` and `README.md` are listed, and there's no `src/__tests__` and no `.tmp-*`.
- [ ] **Step 6: Commit.** Message: `archmap: make the package standalone and neutral`

### Task 2: Create `tttstudios/archmap` and publish 0.1.0 (outward: ask first)

**Files (in the new repo):**

- Create: everything under `packages/archmap/` moved to the repo root, including its git history (`git subtree split --prefix packages/archmap`)
- Create: `.github/workflows/ci.yml`, which runs `npm ci`, `npm run typecheck`, `npm run lint` and `npm test` on pull requests
- Create: `.github/workflows/release.yml`, which runs on a `v*` tag with `actions/setup-node` and `registry-url: https://npm.pkg.github.com`, `permissions: packages: write, contents: read`, then `npm publish` with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
- Create: `package-lock.json` (from `npm install`, since this repo is no longer in a pnpm workspace)

- [ ] **Step 1: Ask the person** to create the repo, or for permission to create it with `gh repo create tttstudios/archmap --private`. Wait for a yes.
- [ ] **Step 2: Split and push.** Run `git subtree split --prefix packages/archmap -b archmap-split` in bcacs, then push that branch to the new repo's `main`.
- [ ] **Step 3: Add the two workflows and the lockfile in a PR.** Expected: `ci.yml` is green on the PR.
- [ ] **Step 4: Ask the person to approve the `v0.1.0` tag**, then tag and push it. Expected: `release.yml` passes and `@tttstudios/archmap@0.1.0` appears under the repo's Packages.
- [ ] **Step 5: In the package settings,** grant `tttstudios/bcacs` read access (Manage Actions access), so bcacs CI can install it with its own `GITHUB_TOKEN`.

### Task 3: Switch bcacs to the published package

**Files (bcacs):**

- Create: `.npmrc`, with `@tttstudios:registry=https://npm.pkg.github.com`
- Modify: root `package.json` (`"@tttstudios/archmap": "0.1.0"`, replacing `workspace:*`)
- Delete: `packages/archmap/`
- Modify: every workflow that runs `pnpm install`. Add `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: packages: read`.
- Modify: `Readme.md` setup section. A `read:packages` token is needed in `~/.npmrc` for local installs.

- [ ] **Step 1: Make the changes and run `pnpm install`.** Expected: it installs `@tttstudios/archmap@0.1.0` from GitHub Packages.
- [ ] **Step 2: Verify.** Run: `pnpm archmap:check`. Expected: `OK: 28 saves · 1 published version · draft pending.` Then run `pnpm check:hook-parity` and `pnpm check:tool-versions`; expected: both pass.
- [ ] **Step 3: Commit.** Message: `Use @tttstudios/archmap from GitHub Packages`. Pushing needs `pnpm ci:local`, per this repo's rules.

---

From Task 4 on, every path is in the `tttstudios/archmap` repo, and tests run with `npx vitest run <file>`.

## Phase B: scan, watch list and layers (spec build steps 2 and 5)

### Task 4: Watch list and matching

**Files:**

- Create: `src/watch.ts`
- Modify: `src/project.ts` (`Config` gets `watch?: WatchEntry[]`)
- Test: `src/__tests__/watch.test.ts`

**Interfaces:**

- Produces: `type Layer = "overview" | "parts" | "data" | "people"`, `const LAYERS: Layer[]` (in that order), `type WatchEntry = { paths: string[]; means: string; layer: Layer }`, and `matchWatch(files: string[], watch: WatchEntry[]): { entry: WatchEntry; files: string[] }[]`. The result keeps the order of `watch`, leaves out entries with no files, and a file can match more than one entry.

- [ ] **Step 1: Write failing tests:**
  - `"groups changed files by watch entry"`: with the spec §6 example watch list, `["apps/api/src/routes/users.ts", "infra/main.tf", "README.md"]` gives 2 groups, "API endpoints" with one file and "Hosting and Azure services" with one file.
  - `"matches ** across folders and single-level *"`: `apps/web/package.json` matches `apps/*/package.json`; `apps/web/sub/package.json` doesn't.
  - `"returns nothing for an empty watch list"`.
- [ ] **Step 2: Run them and check they fail.** Run: `npx vitest run src/__tests__/watch.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `matchWatch`** with `path.posix.matchesGlob`.
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** Message: `watch list matching`

### Task 5: `scan` readers

**Files:**

- Create: `src/scan/types.ts`, `src/scan/walk.ts`, `src/scan/workspace.ts`, `src/scan/routes.ts`, `src/scan/schema.ts`, `src/scan/infra.ts`, `src/scan/outside.ts`, `src/scan/ci.ts`, `src/scan/index.ts`
- Create: fixtures in `src/__tests__/fixtures/scan/` named `empty/`, `express-prisma/`, `fastify-drizzle-tf/`, `compose-env/`
- Test: `src/__tests__/scan.test.ts`

**Interfaces:**

- Produces (`types.ts`):
  ```ts
  type Fact<T> = T & { file: string };
  type Scan = {
    root: string;
    apps: Fact<{ name: string; path: string; deps: string[] }>[];
    routes: Fact<{ method: string; path: string }>[];
    routeFiles: Fact<{}>[];
    tables: Fact<{ name: string; columns: string[] }>[];
    schemaFiles: Fact<{ kind: "prisma" | "drizzle" | "sql" | "dump" }>[];
    infra: Fact<{
      kind: "terraform" | "compose" | "docker";
      type: string;
      name: string;
    }>[];
    outside: Fact<{ name: string; via: "env" | "sdk" }>[];
    ci: Fact<{ workflow: string; deploys: string[] }>[];
    unreadable: Fact<{ reason: string }>[];
  };
  ```
- Produces: `walk(root: string): string[]` (repo-relative posix paths, skipping the folders in Global Constraints), and `scan(root: string): Scan`. Each reader has the signature `(root: string, files: string[]) => Partial<Scan>`, and `scan` merges their results.
- What each reader recognises:
  - **routes:** `app|router|server|fastify.(get|post|put|patch|delete)("path"` for Express, Fastify and Hono. Files under a `routes/` folder with no matches go to `routeFiles`.
  - **schema:** Prisma `model X {` blocks (fields become columns); Drizzle `pgTable("x", {` / `mysqlTable` / `sqliteTable` keys; `CREATE TABLE x (` in `*.sql`; `*.bacpac` listed as `dump` only.
  - **infra:** Terraform `resource "type" "name"`, `docker-compose*.yml` top-level `services:` keys, and each `Dockerfile` (`type: "image"`, with the folder as `name`).
  - **outside:** env names from `.env.example`, `.env.sample` and `*.env.example`. SDKs come from deps matching the table `{ "@azure/": "Azure", "aws-sdk": "AWS", "@aws-sdk/": "AWS", "stripe": "Stripe", "@sendgrid/": "SendGrid", "twilio": "Twilio", "@sentry/": "Sentry", "openai": "OpenAI", "@anthropic-ai/": "Anthropic" }`.
  - **ci:** each `.github/workflows/*.yml` file name, with `deploys` taken from lines matching `azure/|aws-actions/|vercel|netlify|fly`.
- A reader that throws on one file adds that file to `unreadable` with the error message, and carries on.

- [ ] **Step 1: Write failing tests,** one per reader against its fixture, with exact expected facts. Also:
  - `"skips node_modules and dist"`: `express-prisma/node_modules/x/routes/a.js` and `dist/routes/b.js` exist in the fixture, and no fact cites them.
  - `"lists a file it can't parse under unreadable"`: a malformed `docker-compose.yml`.
  - `"empty repo scans to empty lists"`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement the readers and `scan`.** Use line-oriented regex parsing (no YAML or HCL parser, so there are no dependencies). For compose, read the indented keys under `services:`.
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** Message: `archmap scan: repo inventory readers`

### Task 6: Starting point, proposed watch list, the `scan` command and init additions

**Files:**

- Create: `src/scan/propose.ts`
- Modify: `src/commands.ts`, `src/cli.ts` (the `scan` command and help text)
- Test: `src/__tests__/scan.test.ts`, `src/__tests__/commands.test.ts`

**Interfaces:**

- Consumes: `scan` and `Scan` (Task 5); `WatchEntry` (Task 4).
- Produces:
  - `stage(s: Scan): "planning" | "scaffolded" | "existing"`:
    - **planning** when `apps`, `routes`, `routeFiles`, `schemaFiles` and `infra` are all empty;
    - **scaffolded** when there are fewer than 5 routes and `schemaFiles` and `infra` are both empty;
    - **existing** otherwise.
  - `proposeWatch(s: Scan): WatchEntry[]`. It builds one entry per kind found, using the folder of each fact's file:
    - route folders → "API endpoints" (`parts`);
    - schema files → "Database tables and columns" (`data`);
    - Terraform folders → "Hosting and cloud services" (`overview`);
    - compose files → "Services and containers" (`overview`);
    - `apps/*/package.json` → "Libraries and tools" (`parts`);
    - env example files → "Outside services" (`overview`).
  - `scanCommand(root: string, opts: { watch?: boolean }): Result`. It prints the scan plus `stage` as JSON. With `watch`, it prints only the proposed watch list.
  - `init` additionally scans `repoRoot` and writes `watch: proposeWatch(...)` into the config. If `repoRoot/package.json` exists, it adds the scripts `archmap`, `archmap:dev` (`archmap dev`), `archmap:check` (`archmap check`) and `archmap:drift` (`archmap drift`), keeping any that already exist. The scripts pass `--dir <dir>` when it isn't `architecture`.

- [ ] **Step 1: Write failing tests:**
  - `stage` gives `planning` for `empty`, `scaffolded` for a fixture with 2 routes and nothing else, and `existing` for `express-prisma`.
  - `proposeWatch(express-prisma)` contains `{ paths: ["src/routes/**"], means: "API endpoints", layer: "parts" }` and `{ paths: ["prisma/schema.prisma"], means: "Database tables and columns", layer: "data" }`.
  - `init` in a root that has a `package.json` adds the 4 scripts and keeps an existing `"archmap:check": "custom"`.
  - `"init works without a package.json"` (Review Focus 5): it succeeds and no `package.json` is created.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement,** and add `scan [--watch]` to the CLI help.
- [ ] **Step 4: Run them and check they pass,** then run the whole suite: `npx vitest run`.
- [ ] **Step 5: Commit.** Message: `archmap scan command, starting point and watch list in init`

### Task 7: Layer report in core and `check`

**Files:**

- Modify: `src/core.ts` (shared with the viewer: no imports)
- Modify: `src/commands.ts` (`check` output)
- Test: `src/__tests__/core.test.ts`, `src/__tests__/commands.test.ts`

**Interfaces:**

- Produces: `layerReport(m: Model): { layer: "overview" | "parts" | "data" | "people"; count: number }[]` in `LAYERS` order. The counts are:
  - **overview:** services with no `parent`;
  - **parts:** services with a `parent`;
  - **data:** tables;
  - **people:** personas plus flows.

  `nextLayer(m: Model): string | null` gives the first layer with count 0, or `null`. Repeat the layer union inline in core.ts, which must stay import-free.

- `check` adds a line after OK (or after the problem list): `Layers: overview 12 · parts 30 · data 0 · people 0. Next: /archmap:setup data`. "Next:" is left out when `nextLayer` is null.

- [ ] **Step 1: Write failing tests:**
  - `layerReport(replay([base]))` (the core test fixture) gives overview 2, parts 0, data 1, people 0;
  - `nextLayer` of that model is `"parts"`;
  - `check` on a fresh `init` prints `Layers: overview 0 · parts 0 · data 0 · people 0. Next: /archmap:setup overview`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** Message: `layer report in core and check`

## Phase C: the plugin (spec build step 3)

### Task 8: Plugin skeleton, skill, `/archmap:setup` and `/archmap:publish`

**Files:**

- Create: `plugin/.claude-plugin/plugin.json` (`{ "name": "archmap", "description": ..., "version": "0.2.0" }`)
- Create: `.claude-plugin/marketplace.json` at the repo root, listing the plugin with `source: "./plugin"`
- Create: `plugin/skills/archmap/SKILL.md`, moved from `templates/SKILL.md`. `{{dir}}` becomes "the folder in `archmap.config.json`'s location, `architecture/` by default". It adds the layer list and the `Archmap: none - <reason>` trailer.
- Create: `plugin/commands/setup.md`, `plugin/commands/publish.md`
- Create: `plugin/bin/min-version.mjs`. It reads `node_modules/@tttstudios/archmap/package.json` and prints `ok`, `missing` or `old <version>` against the minimum version `0.2.0`.
- Delete: `templates/SKILL.md`. The plugin skill is the only copy: `init` (without `--no-skill`) now copies `plugin/skills/archmap/SKILL.md` into the project.
- Test: `src/__tests__/plugin.test.ts`

**Interfaces:**

- Consumes: the CLI commands `init --no-skill`, `scan`, `check` and `publish` (Tasks 1, 6 and 7); `nextLayer` through the `check` output.
- Command frontmatter: `description:` and `argument-hint:` (`[overview|parts|data|people]` for setup, `"<version name>"` for publish).
- `setup.md` is a prompt that follows spec §5 steps 1 to 7 exactly, with the five interview questions word for word. It starts with `min-version.mjs`: on `missing`, it tells the person how to add `.npmrc` and the dependency, then stops. On `old`, it gives the upgrade command and stops. When `archmap.config.json` already exists, it skips `init`. When a layer argument is given, it does that layer; otherwise it uses the "Next:" from `archmap check`, and when that's empty it says every layer has content and suggests `/archmap:review`.
- `publish.md` shows the draft (`archmap check`, then a summary of the draft saves from `versions.json` and `saves/`), asks for a name and a one-line summary, waits for a yes, then runs `archmap publish`.

- [ ] **Step 1: Write failing tests** in `plugin.test.ts`:
  - `plugin.json` parses and its name is `archmap`;
  - every file in `plugin/commands/` has frontmatter with a non-empty `description`;
  - `setup.md` contains all five spec §5 questions verbatim;
  - `init` copies `plugin/skills/archmap/SKILL.md` exactly.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run them and check they pass.** Then run `claude plugin validate ./plugin`; expected: no errors. Add `plugin` to the package `files`, since init reads the skill from there.
- [ ] **Step 5: Try it by hand.** Run `claude --plugin-dir ./plugin` in an empty scratch folder, then `/archmap:setup`. Expected: it detects planning, asks question 1 alone, and doesn't publish without a yes.
- [ ] **Step 6: Commit.** Message: `plugin: skill, setup and publish commands`

## Phase D: drift (spec build step 4)

### Task 9: `archmap drift`

**Files:**

- Create: `src/drift.ts`
- Modify: `src/cli.ts` (`drift [--base <ref>] [--json] [--strict]`)
- Test: `src/__tests__/drift.test.ts`, which builds real temp git repos with `git init`, commits and a bare clone as `origin`

**Interfaces:**

- Consumes: `matchWatch` and `WatchEntry` (Task 4); `loadProject` (existing).
- Produces:
  ```ts
  type DriftGroup = { means: string; layer: string; files: string[] };
  type Drift = {
    status: "no-baseline" | "no-watch" | "ok" | "uncovered" | "error";
    base?: string;
    groups: DriftGroup[];
    message: string;
  };
  drift(dir: string, opts?: { base?: string }): Drift
  driftCommand(dir: string, opts: { base?: string; json?: boolean; strict?: boolean }): Result
  ```
- Algorithm (spec §6):
  1. **Repo root:** `git rev-parse --show-toplevel`, from `dir`.
  2. **No baseline:** when `versions.json` has no versions, status `no-baseline`, message "No baseline yet: run /archmap:setup".
  3. **No watch list:** when it's missing or empty, status `no-watch`, message "No watch list: run `archmap scan --watch` and add it to archmap.config.json".
  4. **Base:** `opts.base`, or `git merge-base HEAD origin/<default>`, where `<default>` comes from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`. If that fails, status `error`, message "Can't find the base to compare with (shallow clone or no remote). Pass --base."
  5. **Changed files:** `git diff --name-only --no-renames <base>...HEAD`, plus `git diff --name-only --no-renames HEAD`, plus `git ls-files --others --exclude-standard`, de-duplicated and relative to the repo root.
  6. **Coverage:** covered when any changed file starts with `<dir relative to root>/saves/` and ends `.json`, or when `git log <base>..HEAD --format=%B` matches `/^Archmap:\s*none\b/im`. When covered, status `ok`.
  7. **Otherwise:** `matchWatch` on the changed files. Groups mean `uncovered`; no groups mean `ok`.
- `driftCommand`:
  - prints a readable list, or JSON with `--json`;
  - when `process.env.GITHUB_ACTIONS === "true"`, also appends a markdown list to `process.env.GITHUB_STEP_SUMMARY` and prints one `::warning title=Architecture map::<means>: <n> files changed with no save` per group;
  - returns `ok: true`, unless `--strict` and the status is `uncovered` or `error`.

- [ ] **Step 1: Write failing tests:**
  - `"no baseline is silent"`: status `no-baseline`.
  - `"uncovered route change is reported"`: a branch edits `src/routes/a.ts`, giving status `uncovered` with one group "API endpoints".
  - `"a new save covers it"`: plus an added `architecture/saves/x.json`, giving `ok`.
  - `"the trailer covers it"`: a commit message `Fix typo\n\nArchmap: none - test only`, giving `ok`.
  - `"uncommitted and untracked files count"`.
  - `"a deleted watched file counts"` (Review Focus 3).
  - `"a map in a nested folder is covered by its own saves"` (Review Focus 2): `dir = <root>/docs/architecture`.
  - `"a shallow clone with no base is an error but exits 0"` (Review Focus 1): `git clone --depth 1`, giving status `error`, with `driftCommand(...).ok === true`, and `ok === false` with `strict`.
  - `"no watch list"` (Review Focus 5): status `no-watch`.
  - `"writes a step summary and warnings in GitHub Actions"`: set both env vars to a temp file, check the file content and the captured stdout.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.** Use `execFileSync("git", args, { cwd, encoding: "utf8" })` wrapped in `try`; any git failure becomes status `error` with git's stderr appended.
- [ ] **Step 4: Run them and check they pass,** then run the whole suite.
- [ ] **Step 5: Commit.** Message: `archmap drift`

### Task 10: The Stop hook

**Files:**

- Create: `plugin/hooks/hooks.json`, which adds a `Stop` hook running `node "${CLAUDE_PLUGIN_ROOT}/hooks/drift-reminder.mjs"` with `"timeout": 10`
- Create: `plugin/hooks/drift-reminder.mjs`
- Test: `src/__tests__/hook.test.ts`

**Interfaces:**

- Consumes: `archmap drift --json` output (`Drift`, Task 9), run as `<cwd>/node_modules/.bin/archmap drift --json` with a 9-second `execFileSync` timeout.
- Produces, exported for tests:

  ```js
  decide(input: { session_id: string; stop_hook_active?: boolean },
         drift: Drift | null,
         seen: string[]): { output: object | null; seen: string[] }
  ```

  - The output is `null` (silent) when `stop_hook_active`, when `drift` is null, when the status isn't `uncovered`, or when every group key (`means + "|" + files.sorted.join(",")`) is already in `seen`.
  - Otherwise the output is `{ decision: "block", reason }` and the new keys are added to `seen`. The reason is: `"These changes may need the architecture map updated: <means> (<n> files)[, ...]. Run /archmap:update to record them, or say why no map change is needed and suggest the commit trailer 'Archmap: none - <reason>'."`

- `main()`:
  1. reads stdin JSON;
  2. returns silently if `node_modules/.bin/archmap` is missing;
  3. loads `seen` from `join(os.tmpdir(), "archmap-hook-" + session_id + ".json")`;
  4. calls `decide`, writes `seen` back, and prints the output if there is one.

  Any thrown error exits 0 with nothing on stdout and one line on stderr.

- [ ] **Step 1: Write failing tests** for `decide`:
  - silent on `stop_hook_active`;
  - silent on `ok`, `no-baseline` and `error`;
  - blocks on `uncovered` with the exact reason for one group;
  - silent the second time with the returned `seen`;
  - blocks again when a new file joins the group.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass.** Then check by hand with `claude --plugin-dir ./plugin` in a scratch repo that has a Baseline and a watch list: edit a watched file and end the turn. Expected: Claude is asked once to run `/archmap:update`.
- [ ] **Step 5: Commit.** Message: `plugin: Stop hook reminds Claude about drift`

### Task 11: `/archmap:update` and the CI workflow template

**Files:**

- Create: `plugin/commands/update.md`
- Create: `templates/archmap-workflow.yml`
- Modify: `plugin/commands/setup.md` (step 7 offers this template)
- Test: `src/__tests__/plugin.test.ts`

**Interfaces:**

- Consumes: `archmap drift --json` (Task 9); the skill (Task 8).
- `update.md`:
  1. runs `archmap drift --json`;
  2. for each group, reads the changed files and drafts saves following the skill. Each op's reason cites the files;
  3. names groups that need no map change and suggests the trailer;
  4. ends with `archmap check`.
- `archmap-workflow.yml`:
  - runs on `pull_request`, with `actions/checkout` and `fetch-depth: 0`, then setup-node 24;
  - installs with `npm ci` / `pnpm install`, chosen by `setup.md` from the lockfile it finds;
  - runs `<pm> run archmap:check`, then `<pm> run archmap:drift`;
  - sets `permissions: contents: read, packages: read` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

  `setup.md` writes it to `.github/workflows/archmap.yml` only on a yes. If the repo has a hook-parity check or lefthook, it says that both scripts need to go in the git hooks too.

- [ ] **Step 1: Write failing tests:**
  - `update.md` has a description;
  - the workflow template contains `fetch-depth: 0`, `archmap:check` and `archmap:drift`, and doesn't contain `--strict`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** Message: `plugin: update command and CI workflow template`

## Phase E: review and empty states (spec build step 5)

### Task 12: `/archmap:review`

**Files:**

- Create: `plugin/commands/review.md`
- Test: `src/__tests__/plugin.test.ts` (the frontmatter check covers it)

**Interfaces:**

- Consumes: `archmap scan` (Task 6) and `architecture/current.json` (`archmap snapshot`).
- The prompt:
  1. runs `archmap snapshot` and `archmap scan`;
  2. compares routes with endpoint parts, tables with tables, infra and `outside` with services, and app deps with library parts;
  3. prints two lists, "In the code but not on the map" and "On the map but not in the code", each item with its file or map id;
  4. changes nothing until the person picks items, then records them as saves through the skill.

- [ ] **Step 1: Write the command.**
- [ ] **Step 2: Run** `npx vitest run src/__tests__/plugin.test.ts`. Expected: PASS.
- [ ] **Step 3: Try it by hand** on bcacs with `claude --plugin-dir`. Expected: both lists appear, and no file changes.
- [ ] **Step 4: Commit.** Message: `plugin: review command`

### Task 13: Empty states in the viewer

**Files:**

- Modify: `viewer/app.js`, in `renderArch()` (around line 1045), `renderSchema()` (around 952), `openFlows()` (1933) and the personas list
- Modify: `viewer/styles.css` (an `.empty-state` block using the existing tokens)

**Interfaces:**

- Consumes: `core.layerReport(model)` (Task 7), through `import * as core from "./core.js"`.
- Copy, exact:
  - **Overview with 0 services:** "Nothing on the map yet. In Claude Code, run `/archmap:setup` to draft it from your code or a short interview."
  - **A store with `opens: "schema"` and 0 tables:** "No tables recorded yet. Run `/archmap:setup data` in Claude Code."
  - **0 flows:** "No flows recorded yet. Run `/archmap:setup people` in Claude Code."
  - **0 personas:** "No personas recorded yet. Run `/archmap:setup people` in Claude Code."

- [ ] **Step 1: Add the empty states.**
- [ ] **Step 2: Check in the browser.** Run `archmap init` in a scratch folder, then `archmap dev --port 4399`, and open the page. Expected: the overview message shows, with no console errors. Then run `archmap dev` on bcacs's map. Expected: no empty-state message shows, since every layer has content.
- [ ] **Step 3: Commit.** Message: `viewer: empty states per layer`

## Phase F: release and adoption

### Task 14: Release 0.2.0 and adopt in bcacs (outward: ask first)

**Files (bcacs):**

- Modify: `package.json` (`@tttstudios/archmap` `0.2.0`, plus the `archmap:drift` script)
- Modify: `architecture/archmap.config.json` (a `watch` list from `archmap scan --watch`, reviewed by the person)
- Create: `.github/workflows/archmap.yml` (from the template)
- Modify: `lefthook.yml` (a pre-push job running `mise x -- pnpm archmap:check` and `mise x -- pnpm archmap:drift`, for hook parity)
- Delete: `.claude/skills/archmap/` (the plugin provides it)
- Create: `.claude/settings.json` entries for `extraKnownMarketplaces` (`tttstudios/archmap`) and `enabledPlugins` (`archmap@archmap`)

- [ ] **Step 1: Ask the person to approve the `v0.2.0` tag.** Tag it and confirm the release workflow publishes.
- [ ] **Step 2: Make the bcacs changes.** Run `pnpm install`, `pnpm archmap:check`, `pnpm archmap:drift` and `pnpm check:hook-parity`. Expected: OK, then "no changes to watched files" or a correct list, then pass.
- [ ] **Step 3: Run the end-to-end checks from spec §Testing:**
  1. an empty folder: planning path, interview, Baseline only after a yes;
  2. a scaffolded app: a thin layer 1;
  3. bcacs: `/archmap:review` runs, and on a branch that adds a route the Stop hook reminds once and `/archmap:update` drafts a save.

  Record the results in the PR description.

- [ ] **Step 4: Commit.** Message: `Adopt archmap 0.2.0 plugin, watch list and CI drift warning`. Pushing needs `pnpm ci:local`.
