# archmap AI-led redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace archmap's save ledger and Claude plugin with markdown map files that any AI agent writes and the CLI verifies against the code, then move bcacs onto it.

**Architecture:** The map is `architecture/**/*.md` with YAML frontmatter. A loader parses it into `Doc`s; `check` validates schema, references, headings, evidence and secrets, and reports scanner leads; `brief` renders the agent's task; `agent` runs a configured agent command with that brief. The existing viewer keeps drawing: a new adapter turns `Doc`s into the viewer's existing `Model` shape, so the diagrams code stays. The old replay (`core.ts`, `project.ts`) survives only for `migrate`.

**Tech Stack:** Node 24 TypeScript run without a build step (type stripping), vitest, `yaml` (frontmatter), `marked` (markdown to HTML for the viewer).

**Spec:** `docs/superpowers/specs/2026-11-12-archmap-ai-led-redesign-design.md`

## Global Constraints

- Node 24 or newer; no build step; package `@tttstudios/archmap`, version bumped to `0.4.0`.
- Runtime dependencies allowed: `yaml` and `marked` only.
- Map folder default `architecture`; every command takes `--dir <folder>`. Commands run from the project root; evidence and `code` paths are relative to it.
- Ids: file name without `.md`, `/^[a-z0-9][a-z0-9-]*$/`, unique across all five folders.
- `status` is one of `live`, `planned`, `retiring`.
- Body headings, exactly: `## How it works`, `## For developers`.
- CLI invocation written into AGENTS.md, briefs and CI: config `cli` if set, else `npx -y github:${HOME_REPO}#v${config.archmap}` (`HOME_REPO` from `src/home.ts`), plus ` --dir <folder>` when the folder isn't `architecture`.
- `check` never uses AI or the network. archmap ships no LLM client.
- The CI `map` job never fails the PR and never runs for forks or on a head commit whose message starts with `archmap: `.
- The map gate (`check --base`) is deterministic: evidence files, unconfirmed leads in changed files, the structural globs listed in the spec, and config `watch` globs; it is satisfied by any changed file in the map folder other than `.no-change`, or by a commit line `Archmap: none - <reason>` in `<ref>..HEAD`.
- Run one test file while working: `pnpm --filter @tttstudios/archmap exec vitest run src/__tests__/<file>` (prefix `mise exec --` if `pnpm` isn't on `PATH`).

**Spec amendments made by this plan** (small, needed to carry bcacs's existing map; listed so the reviewer can veto them):

- `services` frontmatter gains optional `libraries: [{ name, why?, evidence? }]` (the spec's rules keep architecture-shaping libraries, but its schema had no field).
- `tables` entries gain optional `group` (bcacs groups 37 tables into 6 areas; the viewer lays the schema out by group).
- A column with no `evidence` uses its table's.
- Config gains optional `cli` (bcacs runs the package from `packages/archmap`, not from a release tag).
- `scan` reports `file` per lead, not `file:line` (no reader tracks lines today).

## Review Focus

- **Agent run with the developer's own uncommitted work outside the map.** `agent` must not discard edits that existed before it ran; it reverts only paths the agent changed that were clean before, and warns about pre-dirty paths the agent touched. (Task 6.)
- **Frontmatter that isn't valid YAML or has no closing `---`.** One bad file is reported as an error naming the file; the rest still load and check. (Task 1.)
- **Evidence pointing outside the repo or at a folder** (`../secrets.txt`, `apps/api`). Paths that escape the root or aren't files are errors, never read. (Task 3.)
- **Running `check` or `brief` outside a git repo or with an unknown `--base`.** `brief` without git still works for `setup`/`review`; `--base` errors name the ref and suggest one that exists. (Task 5.)
- **A map entry and a scanner lead that differ only in case or a trailing slash** (`GET /Applications/` vs `GET /applications`). Lead matching normalises method case, path case-sensitively but trailing slash removed. (Task 4.)

---

## File Structure

```
packages/archmap/
  src/
    map/types.ts       Doc, Folder, MapConfig, per-kind frontmatter types
    map/load.ts        loadMap(dir): parse every .md and the config
    map/schema.ts      schemaProblems(docs): kinds, fields, ids, references, headings
    map/evidence.ts    evidenceProblems(root, docs): evidence and code paths exist
    map/secrets.ts     findSecrets(text)
    map/leads.ts       unconfirmedLeads(scan, docs, ignore)
    check.ts           runCheck(root, dir) -> CheckResult; formatCheck
    version.ts         cliCommand(config, dir), versionWarning(config)
    git.ts             repoRoot, changedFiles, dirtyState (moved from drift.ts)
    gate.ts            gateProblems(root, dir, base): the map gate for check --base
    brief.ts           brief(root, dir, opts) -> string
    agent.ts           runAgent(root, dir, opts)
    init.ts            init(root, opts)  (replaces commands.ts init + install.ts)
    migrate.ts         migrate(root, dir): saves -> markdown
    view.ts            toViewModel(docs), docSections(doc), stripPublic
    site.ts            build/serve from the map (modified)
    cli.ts             rewritten command table
    core.ts, project.ts  kept, used only by migrate.ts
    scan/              kept; propose.ts removed
  templates/
    config.json, README.md, agents-section.md
    brief/{rules,format,setup,update,review,hosting}.md
    ci/github/archmap-pr.yml, ci/azure-pipelines/archmap-pr.yml
  viewer/app.js        reads model + docs, no replay or versions
Removed: src/{commands,claude,install,upgrade,drift,watch}.ts, src/scan/propose.ts,
  plugin/, .claude-plugin/, templates/{instructions.md,starter-save.json,archmap-workflow.yml},
  and the tests for them.
```

---

### Task 1: Map types, config and loader

**Files:**

- Modify: `packages/archmap/package.json` (add `yaml`, `marked` to `dependencies`; version `0.4.0`)
- Create: `packages/archmap/src/map/types.ts`, `packages/archmap/src/map/load.ts`
- Test: `packages/archmap/src/__tests__/load.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const FOLDERS = ["services", "stores", "external", "personas", "flows"] as const;
  export type Folder = (typeof FOLDERS)[number];
  export type Evidence = string; // "path" or "path#Symbol"
  export type Doc = {
    id: string; folder: Folder;
    file: string;                       // relative to the map dir, e.g. "services/api.md"
    data: Record<string, unknown>;      // parsed frontmatter
    body: string;                       // markdown after the frontmatter
  };
  export type MapConfig = {
    archmap?: string; name: string; cli?: string;
    agent?: { command?: string; skip?: string[] };
    ignore?: string[]; deploy?: Record<string, unknown>;
    // branding fields as today's Config: product, logo, theme, fonts, labels, links
  };
  export type LoadedMap = { dir: string; config: MapConfig; readme: string; docs: Doc[]; fileErrors: Finding[] };
  export type Finding = { file: string; message: string };
  export type Result = { ok: boolean; lines: string[] }; // moved here from commands.ts, which Task 11 deletes
  export const loadMap = (dir: string): LoadedMap;
  export const splitFrontmatter = (text: string): { data: Record<string, unknown>; body: string } | { error: string };
  ```

- [ ] **Step 1: Add the dependencies**

Run: `pnpm --filter @tttstudios/archmap add yaml marked` and set `"version": "0.4.0"`.

- [ ] **Step 2: Write the failing tests** in `load.test.ts` (temp-dir pattern from `commands.test.ts`: `mkdtempSync(join(import.meta.dirname, ".tmp-"))`)

```ts
it("loads every doc with its folder, id and frontmatter", () => {
  write(
    "services/api.md",
    "---\nname: API\nstatus: live\nkind: api\n---\nHandles requests.\n",
  );
  const m = loadMap(dir);
  expect(m.docs).toEqual([
    {
      id: "api",
      folder: "services",
      file: "services/api.md",
      data: { name: "API", status: "live", kind: "api" },
      body: "Handles requests.\n",
    },
  ]);
});
it("reports a file without frontmatter or with invalid YAML and keeps loading the rest", () => {
  write("services/a.md", "no frontmatter");
  write("services/b.md", "---\nname: [unclosed\n---\n");
  write(
    "stores/db.md",
    "---\nname: DB\nstatus: live\nkind: database\n---\nx\n",
  );
  const m = loadMap(dir);
  expect(m.docs.map((d) => d.id)).toEqual(["db"]);
  expect(m.fileErrors.map((e) => e.file)).toEqual([
    "services/a.md",
    "services/b.md",
  ]);
});
it("accepts CRLF line endings", () => {
  /* "---\r\nname: A\r\n---\r\nx" parses */
});
it("ignores non-.md files and files outside the five folders", () => {
  /* notes.txt, other/x.md skipped */
});
it("reads README.md and archmap.config.json; a missing config is a fileError", () => {});
it("sorts docs by folder order then id", () => {});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm --filter @tttstudios/archmap exec vitest run src/__tests__/load.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement `types.ts` and `load.ts`**

`splitFrontmatter`: normalise `\r\n` to `\n`; the text must start with `---\n` and contain a later line that is exactly `---`; parse the part between with `yaml`'s `parse`; a non-object result is an error. Folder listing: only direct `*.md` children of each folder.

- [ ] **Step 5: Run the tests** → PASS.

- [ ] **Step 6: Commit** `archmap map: load markdown map files`

---

### Task 2: Schema, ids, references and headings

**Files:**

- Create: `packages/archmap/src/map/schema.ts`
- Test: `packages/archmap/src/__tests__/schema.test.ts`

**Interfaces:**

- Consumes: `Doc`, `Finding` (Task 1).
- Produces: `export const schemaProblems = (docs: Doc[]): Finding[]` and `export const isPlanned = (doc: Doc) => boolean`.

Rules (each a separate test, each finding names the file and the field path like `endpoints[1].route`):

| Applies to        | Rule                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all               | `name` non-empty string; `status` in live/planned/retiring; `code` absent or string[]; id matches `/^[a-z0-9][a-z0-9-]*$/`; id unique across folders                                                                                                                                                  |
| services          | `kind` in app/api/worker/job; `connects[]` `{to, why?, how?, evidence?}`; `endpoints[]` `{route, evidence?}` with route `/^(GET\|POST\|PUT\|PATCH\|DELETE\|HEAD\|OPTIONS) \/\S*$/`; `jobs[]` `{name, schedule?, evidence?}`; `libraries[]` `{name, why?, evidence?}`                                  |
| stores            | `kind` in database/queue/bucket/cache; `connects[]` as services; `tables[]` `{name, group?, purpose?, evidence?, columns[]}`; `columns[]` `{name, type?, pk?, unique?, fk?, enum?, desc?, evidence?}`; `enums[]` `{name, values: string[], evidence?}`; column `enum` names an enum in the same store |
| external          | `kind` in auth/email/payments/ai/hosting/other                                                                                                                                                                                                                                                        |
| personas          | `roles[]` `{name, evidence?}`; `needs` string[]                                                                                                                                                                                                                                                       |
| flows             | `persona` resolves to a persona; `steps[]` `{by, at, does}`; `by` resolves to a persona or service; `at` resolves to a service, store or external                                                                                                                                                     |
| references        | `connects[].to` resolves to a service, store or external                                                                                                                                                                                                                                              |
| evidence presence | unless the doc is `planned`: every `connects`, `endpoints`, `jobs`, `tables` and `roles` entry has `evidence`; a column without `evidence` is fine when its table has it                                                                                                                              |
| headings          | services, stores, flows: non-empty text before the first `##`, and both `## How it works` and `## For developers` present; external, personas: non-empty text                                                                                                                                         |
| unknown keys      | an unknown top-level key is a finding (catches typos like `conects`)                                                                                                                                                                                                                                  |

- [ ] **Step 1: Write the failing tests**, one `it` per row above plus: a fully valid service, store, external, persona and flow produce `[]`; a `planned` service with an endpoint and no evidence produces `[]`.

```ts
it("names the field of a bad endpoint route", () => {
  const d = doc("services", "api", { ...live("api"), endpoints: [{ route: "get /x", evidence: "a.ts" }] });
  expect(schemaProblems([d])).toContainEqual({ file: "services/api.md",
    message: 'endpoints[0].route "get /x" must be METHOD /path' });
});
it("rejects a duplicate id across folders", () => {
  expect(schemaProblems([doc("services", "db", ...), doc("stores", "db", ...)]))
    .toContainEqual({ file: "stores/db.md", message: 'id "db" is also used by services/db.md' });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `schemaProblems`** as a table of field specs per folder checked by one small validator (no schema library).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap map: validate frontmatter, references and headings`

---

### Task 3: Evidence, code paths and secrets

**Files:**

- Create: `packages/archmap/src/map/evidence.ts`, `packages/archmap/src/map/secrets.ts`
- Test: `packages/archmap/src/__tests__/evidence.test.ts`, `packages/archmap/src/__tests__/secrets.test.ts`

**Interfaces:**

- Produces:
  - `export const evidenceOf = (doc: Doc): { field: string; evidence: string }[]` — every `evidence` in the doc with its field path; columns without their own are not listed.
  - `export const evidenceProblems = (root: string, docs: Doc[]): Finding[]`
  - `export const plannedWithEvidence = (root: string, docs: Doc[]): Finding[]` (warnings)
  - `export const findSecrets = (text: string): string[]` — names of matched patterns.

- [ ] **Step 1: Write the failing tests**

```ts
it("flags a missing evidence file", ...)        // 'connects[0].evidence apps/api/mail.ts does not exist'
it("flags a symbol no longer in the file", ...) // 'endpoints[0].evidence: "create" not found in apps/api/c.ts'
it("passes when the symbol appears", ...)
it("rejects evidence that leaves the repo or is a folder", ...) // "../x.ts", "/etc/passwd", "apps/api"
it("checks code paths exist (files or folders) unless the doc is planned", ...)
it("skips evidence checks for planned docs but warns when their evidence exists", ...)
it.each([
  ["aws key", "AKIAIOSFODNN7EXAMPLE"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["stripe key", "sk_live_abcdefghijklmnop1234"],
  ["github token", "ghp_" + "a".repeat(36)],
  ["slack token", "xoxb-1234567890-abc"],
  ["assigned secret", 'password: "hunter2hunter2"'],
  ["url with credentials", "postgres://user:pass@host/db"],
  ["azure account key", "AccountKey=" + "A".repeat(40)],
  ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f"],
])("finds %s", (name, text) => expect(findSecrets(text)).toContain(name));
it("doesn't flag env var names or prose", () =>
  expect(findSecrets("Reads DATABASE_URL and SENDGRID_API_KEY. The token expires.")).toEqual([]));
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Resolve each path with `resolve(root, path)` and reject when `relative(root, abs)` starts with `..` or is absolute. Symbol match is a plain substring of the file text. Secret patterns are the nine named in the test, as regexes in one `PATTERNS: [name, RegExp][]` table.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap map: check evidence, code paths and secrets`

---

### Task 4: Leads, `check` and the version warning

**Files:**

- Create: `packages/archmap/src/map/leads.ts`, `packages/archmap/src/check.ts`, `packages/archmap/src/version.ts`
- Test: `packages/archmap/src/__tests__/check.test.ts`

**Interfaces:**

- Consumes: `loadMap` (T1), `schemaProblems` (T2), `evidenceProblems`, `plannedWithEvidence`, `findSecrets` (T3), `scan` from `src/scan/index.ts`.
- Produces:
  ```ts
  export type Lead = { key: string; file: string; text: string }; // key e.g. "scan:route:GET /health"
  export const leadsOf = (s: Scan): Lead[];
  export const unconfirmedLeads = (s: Scan, docs: Doc[], ignore: string[]): Lead[];
  export type CheckResult = { errors: Finding[]; warnings: Finding[]; leads: Lead[]; map: LoadedMap };
  export const runCheck = (root: string, dir: string) => CheckResult;
  export const formatCheck = (r: CheckResult, opts: { strict?: boolean; json?: boolean }) => Result; // Result = { ok: boolean; lines: string[] }
  export const cliCommand = (config: MapConfig, dir: string, root: string) => string;
  export const versionWarning = (config: MapConfig) => string | null;
  ```

Lead keys: `scan:app:<path>`, `scan:route:<METHOD> <path>`, `scan:table:<name>`, `scan:outside:<name>`, `scan:infra:<type>:<name>`, `scan:ci:<workflow>`. A lead is confirmed when any map evidence path (before `#`) equals the lead's `file`, or: app — some doc's `code` contains its path; route — some endpoint's route equals it after upper-casing the method and removing one trailing `/` from the path (except `/` itself); table — some store table has that name; outside — some external doc's id or name equals it case-insensitively. Leads whose key is in `ignore` are dropped.

`runCheck` errors: `fileErrors`, schema, evidence and secrets (secrets scanned over every doc's raw text and README, finding message `looks like a <name>`), and a config with no `name`. Warnings: unconfirmed leads (`message: "unconfirmed lead: <text>"`, `file` = the lead's file), `plannedWithEvidence`. `versionWarning` returns `archmap.config.json pins <x>; this is <VERSION>` when they differ, `null` otherwise. `formatCheck`: ok is false on any error, or on any warning with `strict`; `json` prints `{ errors, warnings }`; text lists errors, then warnings, then the layers that have content (overview: services/stores/external; parts: any endpoints/jobs; data: any tables; people and flows: personas/flows), then `Map OK.` or `<n> problems.`

- [ ] **Step 1: Write the failing tests** (fixture repo in a temp dir with `apps/api/src/routes.ts` declaring an Express `GET /health` route the existing `routesReader` detects — copy the shape from `src/__tests__/fixtures/scan`)

```ts
it("reports schema, evidence and secret errors and exits not ok", ...)
it("reports an unconfirmed route lead as a warning, ok unless --strict", ...)
it("confirms a lead by evidence file, by matching route, by table name, by external name", ...)
it("matches routes ignoring method case and a trailing slash", ...)
it("drops leads listed in ignore", ...)
it("prints json with errors and warnings", ...)
it("warns when the pinned version differs", ...)
it("lists which layers have content", ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap check: validate the map and report unconfirmed leads`

---

### Task 5: Git helpers, the map gate and `brief`

**Files:**

- Create: `packages/archmap/src/git.ts`, `packages/archmap/src/gate.ts`, `packages/archmap/src/brief.ts`, `packages/archmap/templates/brief/{rules,format,setup,update,review,hosting}.md`
- Modify: `packages/archmap/src/check.ts` (`runCheck` takes `opts.base`), `packages/archmap/src/map/types.ts` (`MapConfig.watch?: string[]`)
- Test: `packages/archmap/src/__tests__/brief.test.ts`, `packages/archmap/src/__tests__/git.test.ts`, `packages/archmap/src/__tests__/gate.test.ts`

**Interfaces:**

- Consumes: `runCheck`, `leadsOf`, `unconfirmedLeads`, `cliCommand` (T4), `evidenceOf` (T3).
- Produces:
  ```ts
  // git.ts — moved from drift.ts and generalised
  export const repoRoot = (cwd: string) => string | null;
  export const changedFiles = (root: string, base: string) => string[]; // base...HEAD + working tree + untracked, repo-relative; throws Error("Can't compare with <base>: ...") on a bad ref
  export type DirtyState = Map<string, string>;  // path -> sha1 of contents, or "deleted"
  export const dirtyState = (root: string) => DirtyState; // from `git status --porcelain=v1 -z --untracked-files=all`
  // brief.ts
  export type Task = "setup" | "update" | "review" | "hosting";
  export const pickTask = (docs: Doc[], opts: { task?: Task; base?: string }) => Task;
  export const brief = (root: string, dir: string, opts: { task?: Task; base?: string }) => string;
  // git.ts, also
  export const commitMessages = (root: string, base: string) => string; // `git log <base>..HEAD --format=%B`
  export const fileAt = (root: string, ref: string, path: string) => string | null; // `git show <ref>:<path>`, null if absent
  // gate.ts
  export type GateHit = { file: string; why: string }; // why: "evidence of services/api.md" | "new lead: <text>" | "structural file" | "dependencies changed" | "matches watch <glob>"
  export const architecturalFiles = (root: string, dir: string, base: string) => GateHit[];
  export const gateProblems = (root: string, dir: string, base: string) => Finding[];
  // check.ts, changed
  export const runCheck = (root: string, dir: string, opts?: { base?: string }) => CheckResult; // with base, gateProblems are errors
  ```

Templates: `rules.md` is the "What belongs on the map" and "Never put on the map" sections of today's `templates/instructions.md`, with "Record a change ... needs no save" reworded to "update the map files" (no saves). `format.md` is the folder tree, the frontmatter fields per folder (Task 2's table), the evidence rule with the spec's `connects`/`endpoints` example, the three body headings and who each is for, and one complete `services/api.md` example. `setup.md`, `update.md`, `review.md` carry the spec's text for each task; `setup.md` and `review.md` include the discovery checklist verbatim from the spec. `hosting.md` carries steps 1–5 of "Setup: a hosting step" from `2026-11-12-archmap-deploy-design.md`.

`gateProblems`: changed files from `changedFiles`, minus `agent.skip` matches and files inside the map folder; each remaining file becomes a `GateHit` by the spec's four rules (structural globs exactly as listed in the spec's "map gate"; for `package.json` compare `dependencies`, `devDependencies`, `peerDependencies`, `workspaces` of `fileAt(root, base, path)` vs the working copy, a missing base file counts as changed). Returns `[]` when there are no hits, or any changed file is in the map folder other than `.no-change`, or `commitMessages` has a line matching `/^Archmap: none - \S/m`. Otherwise one `Finding` with `file: ""` and message `This branch changes the architecture but not the map:` followed by up to five `  <file>: <why>` lines (`  …and <n> more`), then `Update the map (run <cliCommand> brief --base <base> with your agent) or add "Archmap: none - <reason>" to a commit.`

`brief` output, in order: `# archmap brief: <task>`; `## Your task` (the task template); for `update`, `## What changed since <base>` listing changed files, then `Map files that cover them:` each doc whose `code` entry is a prefix of, or whose evidence path equals, a changed file; `## What belongs on the map` (rules); `## How to write map files` (format); `## Ground rules` (the spec's four: existing map and people's edits stand unless evidence contradicts; write for every audience in heading order; ask or leave out what the code doesn't show; edit only files in the map folder; for `update`, if nothing needs to change, write one line saying why to `<dir>/.no-change` and edit nothing else); `## Current check results` (errors and warnings, or `None.`); `## Leads from scan` (unconfirmed leads, at most 200, then `…and <n> more`); `## When you're done` (`Run \`<cliCommand> check\` and fix every error until it passes.`). `pickTask`: explicit task wins; no docs → setup; base → update; else review.

- [ ] **Step 1: Write the failing tests**

```ts
it("picks setup for an empty map, update with --base, review otherwise, and an explicit task always", ...)
it("includes the rules, the format, ground rules, check results and the done command in every task", ...)
it("for update lists changed files and the map files that cover them by code prefix and evidence", ...)
it("caps leads at 200", ...)
it("uses config.cli and adds --dir when the folder isn't architecture", ...)
it("works outside a git repo for setup and review", ...)
it("names the ref when --base is unknown", ...) // brief throws Error matching /Can't compare with nope/
// gate.test.ts, in a temp git repo with a map and a base commit
it("passes when nothing architectural changed", ...)          // only a test file and README changed
it("fails on a changed evidence file with no map change", ...)  // message names the file and "evidence of services/api.md"
it("fails on a new unconfirmed route in a changed file", ...)
it("fails on each structural glob", ...)                        // it.each over Dockerfile, infra/main.tf, prisma/schema.prisma, db/migrations/001.sql, .github/workflows/ci.yml
it("fails on package.json dependency changes but not on a version or script change", ...)
it("fails on a watch glob match", ...)
it("passes when a map file changed, but not when only .no-change did", ...)
it("passes with an Archmap: none trailer in a commit since base", ...)
it("ignores files matching agent.skip", ...)
it("lists at most five files", ...)
it("check --base reports the gate as an error; check without --base doesn't run it", ...)
// git.test.ts, in a temp repo
it("changedFiles lists committed, staged, unstaged and untracked changes since base", ...)
it("dirtyState records hashes of modified and untracked files", ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `git.ts` (lift `git()` and the diff logic from `drift.ts`), `gate.ts`, the `runCheck` change and `brief.ts`; templates load from `join(PACKAGE_ROOT, "templates", "brief")`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap brief and gate: the agent's task, and failing a branch that changes the architecture but not the map`

---

### Task 6: `agent`

**Files:**

- Create: `packages/archmap/src/agent.ts`
- Test: `packages/archmap/src/__tests__/agent.test.ts`

**Interfaces:**

- Consumes: `brief`, `pickTask` (T5), `changedFiles`, `dirtyState` (T5), `runCheck`, `formatCheck` (T4).
- Produces: `export const runAgent = (root: string, dir: string, opts: { task?: Task; base?: string }) => Result`

Behaviour, in order:

1. No `agent.command` in the config → `{ ok: false, lines: ["Set agent.command in archmap.config.json (for example \"claude -p\")."] }`.
2. With `base`: if every changed file matches some `agent.skip` glob (`path.matchesGlob`) → `{ ok: true, lines: ["Only skipped files changed; nothing to map."] }` without running.
3. Record `before = dirtyState(root)`. Run the command with `spawnSync(command, { shell: true, cwd: root, input: briefText, stdio: ["pipe", "inherit", "inherit"] })`; when the command contains `{brief}`, replace it with the brief single-quoted for POSIX shells (`'` → `'\''`) and pass no stdin.
4. Non-zero exit → `{ ok: false, lines: ["Agent command exited <code>; nothing kept outside the map."] }` after step 5.
5. `after = dirtyState(root)`. For each path outside the map folder whose `after` entry differs from `before`: if it wasn't in `before`, restore it (`git checkout -- <path>` when tracked, delete when untracked); if it was in `before`, leave it and add the line `The agent changed <path>, which had your uncommitted changes; review it.`
6. If `<dir>/.no-change` exists, read its first line as the reason and delete the file.
7. Return `formatCheck(runCheck(root, dir), {})` with step 5's lines prepended and, when there was a reason, `No map change: <reason>` as the last line.

Tests use a temp git repo and a stub agent: `node -e "<script>"` that writes `architecture/services/x.md` and `apps/other.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it("fails with a hint when no agent command is set", ...)
it("skips when only skipped files changed", ...)
it("passes the brief on stdin", ...)                   // stub writes stdin to architecture/brief-seen.txt; contains "# archmap brief"
it("substitutes {brief} as one quoted argument", ...)  // brief containing ' survives
it("keeps map edits and reverts new edits outside the map", ...)
it("leaves the developer's pre-existing edits outside the map and warns when the agent touched them", ...)
it("removes untracked files the agent created outside the map but not ones that existed", ...)
it("returns check's result after the run", ...)
it("reports the agent's exit code", ...)
it("reads, deletes and prints .no-change as the last line", ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `runAgent`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap agent: run any agent with the brief and keep only map edits`

---

### Task 7: `init` and its templates

**Files:**

- Create: `packages/archmap/src/init.ts`, `packages/archmap/templates/{config.json,README.md,agents-section.md}`, `packages/archmap/templates/ci/github/archmap-pr.yml`, `packages/archmap/templates/ci/azure-pipelines/archmap-pr.yml`
- Test: `packages/archmap/src/__tests__/init.test.ts`, `packages/archmap/src/__tests__/templates.test.ts`

**Interfaces:**

- Consumes: `cliCommand` (T4), `VERSION`, `HOME_REPO` (`src/home.ts`), `appendLineOnce` (move from `install.ts` into `init.ts`).
- Produces: `export const init = (root: string, opts: { dir?: string; name?: string; ci?: "github" | "azure" }) => Result`

`templates/config.json`:

```json
{
  "archmap": "__VERSION__",
  "name": "__NAME__",
  "agent": {
    "command": "claude -p --permission-mode acceptEdits",
    "skip": [
      "**/*.test.*",
      "**/__tests__/**",
      "**/*.md",
      "**/*.lock",
      "**/pnpm-lock.yaml",
      "**/package-lock.json"
    ]
  },
  "ignore": []
}
```

`init` steps: write the config (name from `--name`, else `package.json` `name`, else the folder name) unless one exists (then keep it and say so); write `README.md` from the template unless one exists; replace or append the AGENTS.md block between `<!-- archmap:start -->` and `<!-- archmap:end -->` (create `AGENTS.md` with `# Agent notes` if missing), its text from `agents-section.md` with `__CLI__` filled; if `CLAUDE.md` exists, `appendLineOnce(CLAUDE.md, "@AGENTS.md")`; with `ci`, write `.github/workflows/archmap.yml` or `.azure-pipelines/archmap.yml` from the template with `__CLI__` filled and `__DIR__` set to the map folder. Last line: `Next: ask your agent to run \`<cli> brief\` and follow it.`

`agents-section.md` is the spec's three bullets under "Locally, with any agent", with `__CLI__` in the commands.

GitHub template (`archmap-pr.yml`): `on: pull_request`; `permissions: contents: read` at the top. Job `check`: `needs: map`, `if: always() && needs.map.outputs.pushed != 'true'`; checkout with `ref: ${{ github.head_ref }}` and `fetch-depth: 0`, `actions/setup-node@v4` with `node-version: 24`, `run: __CLI__ check --base origin/${{ github.base_ref }}`. Job `map` declares `outputs: pushed: ${{ steps.push.outputs.pushed }}`. Job `map`: `if: github.event.pull_request.head.repo.full_name == github.repository`; `continue-on-error: true`; `permissions: contents: write`; `concurrency: { group: archmap-map-${{ github.event.pull_request.number }}, cancel-in-progress: true }`; checkout with `ref: ${{ github.head_ref }}`, `fetch-depth: 0` and `token: ${{ secrets.ARCHMAP_PUSH_TOKEN || github.token }}`; a step that sets `skip=true` when `git log -1 --format=%s` starts with `archmap: `; later steps `if: steps.guard.outputs.skip != 'true'`; setup Node 24; `run: npm install -g @anthropic-ai/claude-code` with a comment naming it as the step to swap for another agent; `run: __CLI__ agent --base origin/${{ github.base_ref }}` with `env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`; the agent step writes its output to a file with `tee`; a push step (`id: push`) that sets user `github-actions[bot]` / `41898341+github-actions[bot]@users.noreply.github.com`, then: when `git status --porcelain -- __DIR__` is non-empty, commits `__DIR__` with `archmap: update map` and appends `git diff --name-only HEAD~1 -- __DIR__` to `$GITHUB_STEP_SUMMARY`; otherwise, when the output's last line starts with `No map change: `, makes `git commit --allow-empty -m "archmap: no map change" -m "Archmap: none - <reason>"`; if it committed and `secrets.ARCHMAP_PUSH_TOKEN` is set, pushes and sets `pushed=true`; if it committed without that secret, prints a `::warning::` saying to add `ARCHMAP_PUSH_TOKEN` (a push with the default token starts no new run) and pushes nothing. Azure template: same two jobs as stages with `pr:` trigger, the key from `$(ANTHROPIC_API_KEY)`, the fork guard `ne(variables['System.PullRequest.IsFork'], 'True')`, `continueOnError: true`, the same push logic using the build identity (`persistCredentials: true` on checkout; no extra secret), and a `check` stage that `dependsOn` the map stage with `condition: always()` running `__CLI__ check --base origin/$(System.PullRequest.TargetBranch)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates the config pinned to this version, README and AGENTS block", ...)
it("is idempotent: a second run keeps the config and replaces, not duplicates, the AGENTS block", ...)
it("adds @AGENTS.md to an existing CLAUDE.md once, and doesn't create CLAUDE.md", ...)
it("writes the GitHub and Azure workflows with the CLI and dir filled", ...)
it("uses --dir in the CLI command for a non-default folder", ...)
// templates.test.ts
it.each(["github", "azure-pipelines"])("%s template parses as YAML, pins node 24, has no literal secret, and only __CLI__/__DIR__ placeholders", ...)
it("GitHub map job has the fork guard, self-commit guard, continue-on-error and concurrency", ...)
it("GitHub check job runs check --base after map, and skips when map pushed", ...)
it("pushes only with ARCHMAP_PUSH_TOKEN and writes the Archmap: none trailer for a no-change decision", ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `init.ts` and the templates.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap init: config, README, AGENTS.md and PR workflows`

---

### Task 8: View model and site data

**Files:**

- Create: `packages/archmap/src/view.ts`
- Modify: `packages/archmap/src/site.ts`
- Test: `packages/archmap/src/__tests__/site.test.ts` (replaces the site parts of `commands.test.ts`)

**Interfaces:**

- Consumes: `loadMap` (T1), `runCheck` (T4), `Model` and its types from `core.ts`.
- Produces:
  ```ts
  export const toViewModel = (docs: Doc[]) => Model;
  export type DocView = { folder: Folder; name: string; status: string; summary: string; how?: string; dev?: string; code?: string[] };
  export const docSections = (doc: Doc) => { summary: string; how?: string; dev?: string }; // markdown, split on the two headings
  export const stripPublic = <T>(value: T) => T; // deep copy without keys "code", "evidence", "dev"
  export const siteData = (root: string, dir: string, opts: { dev?: boolean; public?: boolean }) => string;
  export const build = (root: string, dir: string, out: string, opts: { public?: boolean }) => string[];
  export const serve = (root: string, dir: string, port: number) => Promise<Server>;
  ```

`toViewModel` mapping (fixed categories so the existing lanes keep working):

- `categories`: `apps` (Apps, order 1), `services` (Services, 2), `data` (Data, 3), `outside` (Outside, 4).
- services → `services[id]` `{ name, status, lane: kind === "app" ? "apps" : "services", type: kind === "job" ? "job" : "app", purpose: summary text }`; each endpoint → part `${id}.ep-${i}` `{ parent: id, type: "endpoint", name: route }`; each job → `${id}.job-${i}` type `job`; each library → `${id}.lib-${i}` type `library`.
- stores → `services[id]` `{ lane: "data", type: "store", opens: kind === "database" ? "schema" : undefined }`; tables → `tables[name]` `{ area: group ?? id, purpose, columns }`; each distinct `group` → `areas[group]` `{ name: group, order }`; enums → `enums[name]` `{ values }`.
- external → `services[id]` `{ lane: "outside", type: "external" }`.
- connects → `connections[\`${from}-${to}\`]` `{ from, to, label: why, protocol: how }`.
- personas → `personas[id]` `{ name, blurb: summary, jobs: needs.map((job) => ({ job })) }`.
- flows → `flows[id]` `{ name, steps: steps.map((s) => ({ from: personaIds.has(s.by) ? \`persona:${s.by}\` : s.by, to: s.at, label: s.does })) }`.
- `status` passes through; `problems` is `[]`.

`siteData` body: `{ config, readme (markdown), model, docs: Record<id, DocView>, check: { errors, warnings }, dev, public, rev }`; with `public`, `stripPublic` the model and docs and omit `check`. `build` copies the viewer files and writes `data.json`; it no longer writes `core.js`. `docSections` returns markdown; `siteData` renders it, and `readme`, with `marked.parse`, so `DocView.summary/how/dev` and `readme` are HTML and the viewer only inserts them.

- [ ] **Step 1: Write the failing tests**

```ts
it("maps a service with endpoints, jobs and libraries to a top-level service and parts", ...)
it("maps stores to data-lane services, tables with areas from group, and enums", ...)
it("maps a flow step by a persona to persona:<id>", ...)
it("splits a body into summary, how and dev HTML", ...)
it("--public build has no For developers text, code or evidence anywhere in data.json", ...)
it("dev serve returns fresh data.json after a file changes", ...) // keep the existing serve test's shape
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `view.ts` and update `site.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap site: build the viewer from markdown map files`

---

### Task 9: Viewer reads the map

**Files:**

- Modify: `packages/archmap/viewer/app.js`, `packages/archmap/viewer/index.html`, `packages/archmap/viewer/styles.css`
- Modify: `/Users/minte.temple/Documents/bcacs/.claude/launch.json` only if its `archmap` entry's command no longer works

**Interfaces:**

- Consumes: `data.json` from Task 8.

Changes:

- Remove `import * as core from "./core.js"`, the replay (around `app.js:131-136`), `SAVES`, `SPRINTS`, the version/sprint picker, history and draft UI, and `PROTOCOL`/instructions panel. Load `data.model` as the model directly (around `app.js:3607-3628`). Keep `layerReport` behaviour by inlining the four layer tests from Task 4 (the empty states at `app.js:931` use it).
- Detail drawer: for the selected id, show `docs[id].summary`, then `how` under "How it works", then `dev` under "For developers", each as HTML; show `code` paths as plain text.
- A header toggle "Simple / Detailed" (default Detailed, Simple when `data.public`, hidden when `data.public`) that hides "For developers" sections; remember the choice in `localStorage` in a try/catch.
- A "Start here" view showing `data.readme`, opened first.
- The problems panel lists `data.check.errors` then `warnings` (`file: message`).

- [ ] **Step 1: Make the changes.**
- [ ] **Step 2: Verify in the browser.** Build a fixture map (one of each folder) in a temp folder, run `node packages/archmap/bin/archmap.mjs dev --dir <fixture>`, open it with the browser preview, and confirm: Start here shows the README; the overview draws all four lanes with connections; clicking a service shows summary, How it works and For developers; Simple hides For developers; the schema view shows tables by group; a flow draws; the console has no errors. Screenshot the overview and a drawer.
- [ ] **Step 3: Commit** `archmap viewer: read the map's model and docs, no saves or versions`

---

### Task 10: `migrate`

**Files:**

- Create: `packages/archmap/src/migrate.ts`
- Test: `packages/archmap/src/__tests__/migrate.test.ts`

**Interfaces:**

- Consumes: `loadProject` (`project.ts`), `replay` (`core.ts`), `schemaProblems` (T2), `VERSION`.
- Produces: `export const migrate = (root: string, dir: string) => Result`

Rules:

- Refuse when `saves/` is missing, or when any of the five folders already has a `.md`.
- Ids: `_` → `-`; services with a `group`-type parent re-parent to the group's parent; groups themselves are dropped.
- Top-level old services: lane `frontend` + type `app` → `services` kind `app`; other type `app` → kind `api`; type `job` → kind `job`; type `store` (any lane, top-level or part) or `container` → `stores`, kind `database` when name or `tech` matches `/postgres|sql|database|db\b/i`, `queue` for `/queue|bus/i`, else `bucket`; types `external` and `platform` → `external`, kind `hosting` for `platform`, else `other`.
- Parts: `endpoint` → parent's `endpoints` (`route` = part name if it matches the route pattern, else `GET /` + slug, with the original name added to How it works); `job` → parent's `jobs`; `library` and `tool` → parent's `libraries`; `module` → a bullet `- **<name>**: <purpose>` in the parent's How it works.
- Status: `planned` → planned; lane `legacy` or status containing `retir` → retiring; else live.
- `code`: from `docs[].url` paths after `/tree/<branch>/` or `/blob/<branch>/`.
- Body: summary from `purpose`, `blurb` or `description`; How it works from `notes`, then `facts` as `- **k**: v`, then module bullets; For developers empty with the line `_To be written._`.
- Connections → the top-level ancestor of `from`'s `connects` `{ to: top-level ancestor of to, why: label, how: protocol }`, dropping self-connections and duplicates.
- Tables and enums → the first `database` store not in lane `legacy` (else the first `database`), table `group` = old `area`'s name.
- Personas: `needs` from `jobs[].job`; roles empty. Flows: steps `{ by: from without "persona:", at: to ?? from, does: label }`; `persona` = the first step's persona.
- All docs get no evidence; a `review` brief adds it. Set config `archmap` to `VERSION`. Write `README.md` (name, then each old category's name and purpose) unless one exists. Report the counts written per folder and `Next: run brief --task review`.

- [ ] **Step 1: Write the failing tests** with a small saves fixture covering each rule, plus:

```ts
it("migrates a copy of bcacs's saves into docs that pass schema checks except evidence presence", () => {
  cpSync(join(repoRoot, "architecture"), dir, { recursive: true });
  expect(migrate(root, dir).ok).toBe(true);
  const problems = schemaProblems(loadMap(dir).docs).filter((p) => !p.message.includes("evidence"));
  expect(problems).toEqual([]);
});
it("keeps every old table, enum, persona and flow", ...) // counts equal current.json's
it("refuses when map files already exist", ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `migrate`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `archmap migrate: turn a save ledger into map files`

---

### Task 11: New CLI, removals and the package README

**Files:**

- Rewrite: `packages/archmap/src/cli.ts`
- Modify: `packages/archmap/src/scan/index.ts` (drop `propose` export if any), `packages/archmap/package.json` (`files`: drop `plugin`, `.claude-plugin`; description), `packages/archmap/README.md`
- Delete: `src/{commands,claude,install,upgrade,drift,watch}.ts`, `src/scan/propose.ts`, `plugin/`, `.claude-plugin/`, `templates/{instructions.md,starter-save.json,archmap-workflow.yml}`, tests `src/__tests__/{commands,claude,install,upgrade,drift,hook,plugin,watch}.test.ts`
- Modify: `src/__tests__/package.test.ts`, `src/__tests__/installed.test.ts` (new command names)
- Test: `packages/archmap/src/__tests__/cli.test.ts`

**Interfaces:**

- Consumes: everything above.

Commands: `init [--name] [--ci github|azure]`, `scan [--json]`, `check [--json] [--strict] [--base]`, `brief [--task] [--base]`, `agent [--task] [--base]`, `dev [--port]`, `build [--out archmap-site] [--public]`, `migrate`; all take `--dir`. Every command except `init` and `scan` prints `versionWarning` to stderr when non-null. `scan` without `--json` prints one line per lead: `<key>  <file>`. Errors thrown (like a bad `--base`) print their message and exit 1. Help text lists exactly these commands.

- [ ] **Step 1: Write the failing tests** — spawn `bin/archmap.mjs` for: `--help` lists the eight commands; an unknown command exits 1; `check` on a valid fixture exits 0 and prints `Map OK.`; `brief --base nope` exits 1 naming `nope`; the version warning appears on stderr.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Rewrite `cli.ts`, delete the listed files, update `package.test.ts` and `installed.test.ts`.**
- [ ] **Step 4: Run the whole package**: `pnpm --filter @tttstudios/archmap test`, `pnpm --filter @tttstudios/archmap typecheck`, `pnpm --filter @tttstudios/archmap lint` → all pass.
- [ ] **Step 5: Rewrite `README.md`**: what archmap is (the spec's Goal), quick start (`npx -y github:<HOME_REPO>#v0.4.0 init`, then ask your agent to run `brief`), the map folder, the commands table, CI, moving from saves (`migrate`), white-labelling (kept).
- [ ] **Step 6: Commit** `archmap 0.4.0: AI-led map, any agent, no plugin`

---

### Task 12: Move bcacs onto the new map

**Files (repo root `/Users/minte.temple/Documents/bcacs`):**

- Modify: `architecture/**`, `package.json` (scripts), `lefthook.yml`, `AGENTS.md`, `.gitattributes`, `.claude/launch.json` (if it calls `.archmap/`)
- Create: `.github/workflows/archmap.yml`
- Delete: `.archmap/`, `architecture/{saves,versions.json,current.json,instructions.md}`

- [ ] **Step 1: Migrate.** Run `node packages/archmap/bin/archmap.mjs migrate --dir architecture`. Expected: counts per folder and the review hint. Add `"cli": "node packages/archmap/bin/archmap.mjs"` to `architecture/archmap.config.json`.
- [ ] **Step 2: Review pass.** Run `node packages/archmap/bin/archmap.mjs brief --task review --dir architecture` and follow it: add evidence to every live entry, write How it works and For developers, correct what the code contradicts. Repeat `check` until it prints `Map OK.` (warnings allowed; list each remaining unconfirmed lead in the PR description, or add it to `ignore` with a reason in the commit).
- [ ] **Step 3: Remove the old pieces.** Delete `.archmap/`, `architecture/saves/`, `versions.json`, `current.json`, `instructions.md`; remove the `.archmap/**` line from `.gitattributes`.
- [ ] **Step 4: Init.** Run `node packages/archmap/bin/archmap.mjs init --dir architecture --ci github`; delete the old archmap bullet from `AGENTS.md` (the new block replaces it).
- [ ] **Step 5: Scripts and hooks.** In `package.json` replace the five `archmap*` scripts with `"archmap": "node packages/archmap/bin/archmap.mjs --dir architecture"`, `"archmap:dev": "node packages/archmap/bin/archmap.mjs dev --dir architecture"`, `"archmap:check": "node packages/archmap/bin/archmap.mjs check --dir architecture"`. Point any lefthook archmap commands at `archmap:check` and drop `archmap:drift`. Run `pnpm check:hook-parity` → passes.
- [ ] **Step 6: Verify.** `pnpm archmap:check` → `Map OK.`; `pnpm archmap:dev` in the browser preview shows the bcacs map with all four layers; `pnpm ci:local` passes (the `map` job is skipped locally without a key and must not fail the run).
- [ ] **Step 7: Commit** in two commits: `bcacs: migrate the architecture map to markdown` (steps 1–2) and `bcacs: drop the save ledger and .archmap/, use the new archmap CLI` (steps 3–5).

---

## Not in this plan

- `archmap deploy` (its own plan from `2026-11-12-archmap-deploy-design.md`, amended as the redesign spec says).
- Syncing `packages/archmap` to `HOME_REPO` and tagging `v0.4.0`.
- Adding `ANTHROPIC_API_KEY` to the bcacs repo's secrets (a person does it; until then the `map` job skips with a warning).
