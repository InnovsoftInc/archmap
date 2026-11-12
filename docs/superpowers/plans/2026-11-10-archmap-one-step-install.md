# archmap one-step install: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `npx -y github:InnovsoftInc/archmap#v0.3.0 install`, copies archmap (CLI, viewer and Claude plugin) into a project as `.archmap/` and wires it up. After that, the project, its CI, other agents and Claude Code need no npm package and no token.

**Architecture:** A new `install` CLI command copies the package's own files into `<project>/.archmap/` and edits `.gitattributes` and `AGENTS.md`, then connects Claude Code for that person with `archmap claude` (local scope, never committed). Everything that called `node_modules/.bin/archmap` (the plugin's commands and skill, the drift hook, `init`'s scripts and the CI template) calls `node .archmap/bin/archmap.mjs` instead. A new `upgrade` CLI command and `/archmap:upgrade` command re-run the install at a newer tag.

**Tech stack:** Node 24 TypeScript run without a build step (through `bin/archmap.mjs`), `node:fs` / `node:child_process` only (no runtime dependencies), vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-archmap-one-step-install-design.md`

All paths below are relative to `packages/archmap/` unless they start with `bcacs/`.

## Global constraints

- Node >= 24. No runtime dependencies, so `package.json` keeps no `dependencies`.
- The home repo is the constant `HOME_REPO = "InnovsoftInc/archmap"` in `src/home.ts`. No other source file, command or template spells it out.
- The new version is `0.3.0`, in `package.json`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. `plugin/bin/min-version.mjs` requires `0.3.0`.
- The CLI path used everywhere is exactly `node .archmap/bin/archmap.mjs`, run from the project root.
- Claude Code is connected per person, never through committed settings: `claude plugin marketplace add <absolute .archmap path> --scope local`, then `claude plugin install archmap@archmap --scope local`. No task writes `.claude/settings.json`.
- The `.gitattributes` line is exactly `.archmap/** linguist-vendored -diff`.
- Run a single test file with `pnpm --filter @tttstudios/archmap exec vitest run src/__tests__/<file>`. Don't run the full suite after every change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **Re-install over an older copy:** files the new version dropped must not linger. `.archmap/` is removed, then copied. (Task 1)
2. **Install run from inside the copy:** running `node .archmap/bin/archmap.mjs install` would delete the code that's running. It must stop with "Run install through npx from the home repo; see `archmap upgrade`." (Task 1)
3. **Run from a subfolder:** without `.git` (a folder or a worktree's file) in the working folder, install stops with "Run this from the project root (the folder with .git)." and writes nothing. (Task 1)
4. **A marketplace named `archmap` already exists with another source** (the old `.tgz` install leaves one in user scope): leave it, print `claude plugin marketplace remove archmap` with the reason, skip the plugin install, and still report the copy as done. (Task 2)
5. **`.gitattributes` or `AGENTS.md` with no trailing newline:** the new line is appended on a line of its own. (Task 2)

---

### Task 0: Test the two unknowns (by hand, gates the rest)

**Files:** `bcacs/docs/superpowers/specs/2026-11-10-archmap-one-step-install-design.md` (record the results)

- [ ] **Step 1:** In a scratch folder in the scratchpad, `git init`, then copy `.claude-plugin/`, `plugin/`, `bin/`, `src/` (without `__tests__`), `viewer/` and `templates/` into `.archmap/`. Add a `package.json` there holding `{"name":"@tttstudios/archmap","version":"0.2.0","type":"module"}`. Write `.claude/settings.json` with the settings entry from Global constraints. Commit.
- [ ] **Step 2:** `git clone` that folder to a second scratch folder (this is the teammate), and run `claude -p "/archmap:setup"` there. Do it once from the root and once from a subfolder. Record whether the plugin's commands exist and whether the marketplace path resolved. `claude plugin marketplace list --json` shows the resolved path.
- [ ] **Step 3:** If the commands are missing, run `claude plugin install archmap@archmap --scope project` in the clone and check again.
- [ ] **Step 4:** Write the results into the spec's "To test first" section. Then apply its fallbacks: if the relative path fails, Task 2 runs `claude plugin marketplace add ./.archmap --scope project` in place of the `extraKnownMarketplaces` entry. If teammates need an install step, Task 2's final output and Task 6's README gain the `claude plugin install` line. Commit the spec. Stop and show the person before Task 1.

### Task 1: `install` copies archmap into `.archmap/`

**Files:**

- Create: `src/home.ts`, `src/install.ts`, `src/__tests__/install.test.ts`
- Modify: `src/cli.ts` (HELP plus `case "install"`)

**Interfaces:**

- Produces, in `src/home.ts`: `export const HOME_REPO = "InnovsoftInc/archmap"`, `export const PACKAGE_ROOT: string` (the package folder, worked out as in `commands.ts`), and `export const VERSION: string`, read from `PACKAGE_ROOT/package.json`.
- Produces, in `src/install.ts`: `export const install = (projectRoot: string, opts?: { packageRoot?: string }): Result`. `Result` is the type from `commands.ts`. Task 2 adds the wiring steps inside it.
- Produces: `export const COPIED = [".claude-plugin", "plugin", "bin", "src", "viewer", "templates"] as const`.

- [ ] **Step 1: Write the failing tests** in `install.test.ts`. Each one uses a temp project folder made with `mkdtempSync` and holding an empty `.git/` folder:
  - `copies the package into .archmap`: `.archmap/bin/archmap.mjs`, `.archmap/plugin/.claude-plugin/plugin.json`, `.archmap/.claude-plugin/marketplace.json`, `.archmap/viewer/index.html` and `.archmap/src/cli.ts` exist. `.archmap/src/__tests__` doesn't.
  - `writes VERSION and a minimal package.json`: `.archmap/VERSION` is `` `${VERSION}\n` ``, and `.archmap/package.json` parses to exactly `{ name: "@tttstudios/archmap", version: VERSION, type: "module", repository: { type: "git", url: \`https://github.com/${HOME_REPO}\` } }`.
  - `the copied CLI runs`: `spawnSync(process.execPath, [".archmap/bin/archmap.mjs", "init", "--name", "T"], { cwd })` gives status 0, then `check` gives status 0.
  - `replaces an older copy`: write `.archmap/stale.txt`, run install, and it no longer exists.
  - `stops without .git`: no `.git`, so `ok` is false, `lines[0]` is `"Run this from the project root (the folder with .git)."`, and there's no `.archmap/`.
  - `accepts a worktree's .git file`: `.git` written as a file holding `gitdir: x`, so `ok` is true.
  - `refuses to install over itself`: `install(root, { packageRoot: join(root, ".archmap") })` after a first install gives `ok` false, the message from Review focus 2, and `.archmap/bin/archmap.mjs` still exists.
- [ ] **Step 2: Run them and check they fail.** Run `pnpm --filter @tttstudios/archmap exec vitest run src/__tests__/install.test.ts`. Expected: FAIL, because `../install.ts` can't be resolved.
- [ ] **Step 3: Implement `src/home.ts` and `install` in `src/install.ts`.** Check first that the project has `.git` and that the package isn't the target, then `rmSync(target, { recursive: true, force: true })`. Copy each entry in `COPIED` with `cpSync(..., { recursive: true, filter })`, where the filter drops `src/__tests__` and anything named `.tmp-*`. Then write `VERSION` and `package.json`. Return `ok: true` with a first line of `` `Copied archmap ${VERSION} into .archmap/.` ``.
- [ ] **Step 4: Wire it into the CLI.** Add `case "install": return print(install(process.cwd()));` to `cli.ts`, and add this HELP line: `install                        Copy archmap into .archmap/ and set up Claude Code (run through npx)`.
- [ ] **Step 5: Run the tests and check they pass.** Same command as Step 2. Expected: PASS.
- [ ] **Step 6: Commit.** Run `git add packages/archmap/src && git commit -m "archmap install: copy the CLI and plugin into .archmap/"`.

### Task 2: `install` wires the project up, and `archmap claude`

**Files:**

- Create: `src/claude.ts`, `src/__tests__/claude.test.ts`
- Modify: `src/install.ts`, `src/__tests__/install.test.ts`, `src/cli.ts` (HELP plus `case "claude"`)

**Interfaces:**

- Consumes: `install` from Task 1.
- Produces: `export type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string; missing?: boolean }` (`missing` is true when the command isn't on `PATH`), and `export const connectClaude = (projectRoot: string, opts?: { run?: Run }): Result` in `src/claude.ts`. The default `run` uses `spawnSync` and sets `missing` on `ENOENT`. `install` calls `connectClaude` last and appends its lines.

- [ ] **Step 0: Check the flag.** Run `claude plugin marketplace add --help` and `claude plugin install --help` and confirm both accept `--scope local`. If they don't, stop and report: the controller rules on it. Don't fall back to project scope.
- [ ] **Step 1: Write the failing tests.** In `claude.test.ts`, use a fake `run` that records its calls:
  - `connects with local scope`: the calls are exactly `["claude", ["plugin","marketplace","add", join(root,".archmap"), "--scope","local"]]`, then `["claude", ["plugin","install","archmap@archmap","--scope","local"]]`. `ok` is true.
  - `claude not on PATH prints the commands`: `run` returns `missing: true`, so `ok` is true and the lines contain both commands, written out in full.
  - `an archmap marketplace from elsewhere is left alone`: `marketplace add` fails with stderr containing `already`, so there's no install call, the lines contain `claude plugin marketplace remove archmap`, and `ok` is true.
  - `other failures are reported`: the install exits 1 with stderr `boom`, so `ok` is false and the lines contain `boom`.

  In `install.test.ts`, pass a fake `run` through `install(root, { run })`:
  - `adds the gitattributes line once`: install twice, and `.gitattributes` holds `.archmap/** linguist-vendored -diff` exactly once.
  - `appends after a file with no trailing newline`: `.gitattributes` starting as `*.png binary` ends as `` `*.png binary\n.archmap/** linguist-vendored -diff\n` ``.
  - `adds the AGENTS.md pointer once`: `AGENTS.md` contains `architecture/instructions.md`, `node .archmap/bin/archmap.mjs check` and `node .archmap/bin/archmap.mjs claude` once each, after two installs, and its earlier text is kept.
  - `never writes .claude/settings.json`: it doesn't exist after install.
  - `connects Claude Code last`: the fake `run` is called after `.archmap/bin/archmap.mjs` exists.
  - `ends with the next step`: the last line is `Next: open Claude Code here and run /archmap:setup. Teammates run node .archmap/bin/archmap.mjs claude once after cloning.`

- [ ] **Step 2: Run them and check they fail.** Run both files. Expected: the new tests FAIL and Task 1's still pass.
- [ ] **Step 3: Implement.** Write `connectClaude` in `src/claude.ts`. Add `appendLineOnce(file: string, line: string): boolean` to `install.ts`, and have `install` accept `opts.run` and pass it on. The AGENTS.md line is: `- Architecture map: read architecture/instructions.md before changing services, endpoints, tables or flows, and run \`node .archmap/bin/archmap.mjs check\` after recording a change. Claude Code users run \`node .archmap/bin/archmap.mjs claude\` once to get the archmap commands.`Add`case "claude": return print(connectClaude(process.cwd()));`and a HELP line:`claude Connect Claude Code to .archmap/ for you (local scope, not committed)`.
- [ ] **Step 4: Run them and check they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `archmap install: mark the copy vendored, point agents at the map, connect Claude Code per person`.

### Task 3: `init`'s scripts call the copied CLI

**Files:** Modify `src/commands.ts` (`planScripts`) and `src/__tests__/commands.test.ts`.

- [ ] **Step 1: Update the failing test** (the existing scripts test in `commands.test.ts`). Expect `archmap` to be `node .archmap/bin/archmap.mjs`, and `archmap:dev`, `archmap:check`, `archmap:drift` and `archmap:claude` to be that path followed by ` dev`, ` check`, ` drift` and ` claude` (`archmap:claude` takes no `--dir`). A map outside `architecture/` gets ` --dir <rel>` appended, as it does today.
- [ ] **Step 2: Run it and check it fails.** Run `pnpm --filter @tttstudios/archmap exec vitest run src/__tests__/commands.test.ts`. Expected: FAIL on the script values.
- [ ] **Step 3: Implement.** In `planScripts`, add `const CLI = "node .archmap/bin/archmap.mjs"` and build `wanted` from it.
- [ ] **Step 4: Run it and check it passes.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `archmap init: scripts call the copy in .archmap/`.

### Task 4: The plugin calls the copied CLI

**Files:**

- Modify: `plugin/commands/{setup,update,review,publish}.md`, `plugin/skills/archmap/SKILL.md`, `plugin/hooks/drift-reminder.mjs` and `plugin/bin/min-version.mjs`
- Test: `src/__tests__/plugin.test.ts` and `src/__tests__/hook.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - In `plugin.test.ts`, `no plugin file calls node_modules/.bin/archmap`: no file under `plugin/` contains `node_modules/.bin/archmap` or `npm.pkg.github.com`.
  - In `plugin.test.ts`, `commands allow the copied CLI`: every `Bash(` entry in the `allowed-tools` of `setup.md`, `update.md` and `review.md` that names archmap starts with `Bash(node .archmap/bin/archmap.mjs `.
  - In `plugin.test.ts`, `min-version reads .archmap/VERSION`: in a temp folder, no `.archmap/VERSION` prints a line starting `missing npx -y github:` (a fixture `package.json` beside `plugin/` supplies the repo), `0.2.0\n` prints `old 0.2.0`, and `0.3.0\n` prints `ok`.
  - In `hook.test.ts`, change the fixture that fakes `node_modules/.bin/archmap` to write `.archmap/bin/archmap.mjs` (a script that prints the drift JSON). Keep the existing assertions. Add `stays silent without .archmap/`.
- [ ] **Step 2: Run them and check they fail.** Run both files. Expected: FAIL.
- [ ] **Step 3: Update the plugin files:**
  - Everywhere: replace `node_modules/.bin/archmap` with `node .archmap/bin/archmap.mjs`.
  - Each command that says "If `node_modules/.bin/archmap` doesn't exist" now says: if `.archmap/bin/archmap.mjs` doesn't exist, run `node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs` and show the person the install command it prints, then stop.
  - In `setup.md`, step 0's `missing` text (the `.npmrc`, token and package-manager instructions) becomes: show the person the command that follows `missing` and stop. `min-version.mjs` prints `missing npx -y github:<owner/repo>#v<version> install`, building the repo and version from the `repository.url` and `version` in the plugin's own `../../package.json`. That file is plain JSON, so the `.mjs` imports no TypeScript. The `old` text points to `/archmap:upgrade`.
  - In `setup.md`, step 7 becomes: copy `.archmap/templates/archmap-workflow.yml` to `.github/workflows/archmap.yml`, add `--dir <folder>` to both commands when the map isn't in `architecture/`, plus the existing git-hooks note. Delete the lockfile table, the yarn guidance and the pnpm `packageManager` guidance.
  - In `drift-reminder.mjs`: `const cli = join(cwd, ".archmap", "bin", "archmap.mjs")`, run as `execFileSync(process.execPath, [cli, "drift", "--json", "--dir", dir], …)`.
  - In `min-version.mjs`: read `.archmap/VERSION`, with `MINIMUM = "0.3.0"`.
  - At the end of `setup.md`, after naming the next layer, add: teammates run `node .archmap/bin/archmap.mjs claude` once after cloning to get these commands.
- [ ] **Step 4: Run them and check they pass.** Expected: PASS. Then run `pnpm --filter @tttstudios/archmap typecheck`.
- [ ] **Step 5: Commit.** Message: `archmap plugin: call the copy in .archmap/, drop the token setup`.

### Task 5: CI template, package metadata, version 0.3.0

**Files:**

- Modify: `templates/archmap-workflow.yml`, `package.json`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
- Test: `src/__tests__/package.test.ts` and `src/__tests__/installed.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - In `package.test.ts`, `package.json is ready for npx github:`: no `publishConfig`, `bin.archmap` is `./bin/archmap.mjs`, `version` is `0.3.0`, and `repository.url` is `` `https://github.com/${HOME_REPO}` ``. `plugin.json` and `marketplace.json` both have version `0.3.0` and the same repository.
  - In `package.test.ts`, `the CI template needs no install or token`: the template contains `node .archmap/bin/archmap.mjs check` and `node .archmap/bin/archmap.mjs drift --base origin/${{ github.base_ref }}`. It doesn't contain `__INSTALL__`, `__RUN__`, `NODE_AUTH_TOKEN`, `packages: read` or `pnpm/action-setup`.
  - Rewrite `installed.test.ts` as the end-to-end test. Run `npm pack` into the temp folder and `npm install` the tarball into a scratch `install-from` folder. Then run `node <install-from>/node_modules/@tttstudios/archmap/bin/archmap.mjs install` with `cwd` set to a scratch git project. Then run `node .archmap/bin/archmap.mjs init --name T` and `check` there. All give status 0.
- [ ] **Step 2: Run them and check they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Write the template as in the spec's CI section, with `permissions: contents: read` only. Bump the three versions, remove `publishConfig` and set `repository`.
- [ ] **Step 4: Run them and check they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `archmap 0.3.0: CI without a registry, installable from git`.

### Task 6: `upgrade` command and `/archmap:upgrade`, README

**Files:**

- Create: `src/upgrade.ts`, `src/__tests__/upgrade.test.ts` and `plugin/commands/upgrade.md`
- Modify: `src/cli.ts` and `README.md`

**Interfaces:**

- Produces: `export const upgradeInfo = (projectRoot: string, opts?: { tags?: () => string[]; want?: string }): Result`. By default `tags` runs `git ls-remote --tags https://github.com/${HOME_REPO}` and keeps the `vX.Y.Z` names.

- [ ] **Step 1: Write the failing tests:**
  - `names the latest tag`: with `tags: () => ["v0.2.0","v0.3.0","v0.10.0"]` and `.archmap/VERSION` set to `0.3.0`, the lines are `Installed: 0.3.0`, `Latest: 0.10.0` and `` `Run: npx -y github:${HOME_REPO}#v0.10.0 install` ``. 0.10.0 sorts above 0.3.0.
  - `already latest`: when VERSION equals the newest tag, `ok` is true and the last line is `archmap is up to date.`
  - `a wanted version that doesn't exist`: `want: "9.9.9"` gives `ok` false and `No tag v9.9.9 in <HOME_REPO>.`
  - `git can't reach the repo`: when `tags` throws, `ok` is false, and the line says the repo couldn't be read and names `HOME_REPO`.
- [ ] **Step 2: Run them and check they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `upgradeInfo` and wire it in.** Add `case "upgrade": return print(upgradeInfo(process.cwd(), { want: arg }));` to `cli.ts` and a HELP line.
- [ ] **Step 4: Write `plugin/commands/upgrade.md`.** Its frontmatter has `description: Upgrade the project's copy of archmap in .archmap/ to a newer release.`, `argument-hint: "[version]"` and `allowed-tools: Bash(node .archmap/bin/archmap.mjs upgrade:*)`. The body:
  1. Run `node .archmap/bin/archmap.mjs upgrade $ARGUMENTS` and show what it prints.
  2. If it prints a `Run:` line, ask "Upgrade to <version>?" and run that command only on a yes.
  3. Then run `node .archmap/bin/archmap.mjs check`, and say the new plugin loads after `/reload-plugins` or in a new session.
     Add the command to the `plugin.test.ts` allowed-tools test.
- [ ] **Step 5: Rewrite the README's Quick start.** It becomes the install command (with `<home>` explained as `HOME_REPO`), then `/archmap:setup`, then `pnpm archmap:dev` or `node .archmap/bin/archmap.mjs dev`. Add `install` and `upgrade` to the Commands table, and add `claude` to the Commands table. Add a short "Teammates" paragraph: run `pnpm archmap:claude` (or `node .archmap/bin/archmap.mjs claude`) once after cloning. It connects Claude Code locally and commits nothing.
- [ ] **Step 6: Run the tests and check they pass.** Run `upgrade.test.ts` and `plugin.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit.** Message: `archmap upgrade: find newer releases and reinstall`.

### Task 7: What belongs on the map, for every agent

**Files:**

- Modify: `templates/instructions.md` and `plugin/skills/archmap/SKILL.md`
- Test: `src/__tests__/package.test.ts` and `src/__tests__/plugin.test.ts`

The section's exact text is in the spec, under "What belongs on the map". Copy it verbatim.

- [ ] **Step 1: Write the failing tests:**
  - In `package.test.ts`, `the instructions template says what belongs on the map`: `templates/instructions.md` contains `## What belongs on the map`, before `## Where things live`. It also contains `1. **Overview**`, `4. **People and flows**` and `Never put on the map:`. The existing "nothing project-specific" test still passes.
  - In `plugin.test.ts`, `the skill defers to instructions.md for what to map`: `SKILL.md` contains `What belongs on the map` and doesn't contain `1. **Overview:**`.
- [ ] **Step 2: Run them and check they fail.** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Insert the section after the template's opening paragraph. In `SKILL.md`, replace the "The four layers" list with one paragraph: what to record is in the "What belongs on the map" section of the map folder's `instructions.md`, so read it before recording. Keep the existing pointer to `/archmap:setup <layer>`.
- [ ] **Step 4: Run them and check they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `archmap: say what belongs on the map, for every agent`.

### Task 8: Create the home repo and test the real one step

Creating the repo is outward-facing, so ask the person before Step 1.

- [ ] **Step 1:** Create the repo with `gh repo create InnovsoftInc/archmap --private`. Push only the package, with its history: `git subtree split --prefix packages/archmap -b archmap-home`, then `git push git@github.com:InnovsoftInc/archmap.git archmap-home:main`. Then `git tag v0.3.0 archmap-home` and `git push … v0.3.0`.
- [ ] **Step 2:** In a scratch git project, run `npx -y github:InnovsoftInc/archmap#v0.3.0 install`. Expected: `Copied archmap 0.3.0 into .archmap/.` and the `Next:` line.
- [ ] **Step 3:** In that project, run `node .archmap/bin/archmap.mjs init --name Scratch` and `check`. Then `claude -p "/archmap:setup overview"`. Expected: the setup command runs with no install or token prompts.
- [ ] **Step 4:** Run the workflow template there with `act pull_request`, or note in the results if `act` can't reach the scratch repo.

### Task 9: Move bcacs to the copy

**Files:** `bcacs/package.json`, `bcacs/.archmap/` (new), `bcacs/.gitattributes`, `bcacs/AGENTS.md`, `bcacs/pnpm-lock.yaml`. Delete `packages/archmap/INSTALL-from-file.md` and `packages/archmap/tttstudios-archmap-0.2.0.tgz` (both untracked, so ask before deleting).

- [ ] **Step 1:** From the bcacs root, run `node packages/archmap/bin/archmap.mjs install`. Expected: `.archmap/` and the wiring are written.
- [ ] **Step 2:** In the root `package.json`, set the `archmap`, `archmap:dev` and `archmap:check` scripts to `node .archmap/bin/archmap.mjs … --dir architecture`, add `archmap:drift` and `archmap:claude` the same way, and remove the `@tttstudios/archmap` dev dependency. Then run `pnpm install`.
- [ ] **Step 3:** Run `pnpm archmap:check`. Expected: exit 0. Run `pnpm archmap:dev -- --port 4322` and open the viewer to see the map load.
- [ ] **Step 4:** Commit. Message: `bcacs: use the archmap copy in .archmap/`. The pre-commit hook runs the affected tests.
