# archmap: one-step install

Date: 2026-11-10 · Status: approved design, awaiting spec review

## Goal

Getting archmap into a project takes one command, and nothing else needs
setting up: no npm package, no registry, no personal access token, and no
CI secret. That holds for TTT projects and for client repos, including
their developers and their CI, who have no access to TTT's repositories.

## What's wrong today

- The CLI is published to GitHub Packages, which needs a token even to
  install. `/archmap:setup` asks every developer to create a classic
  personal access token and put it in `~/.npmrc`.
- The plugin's marketplace points into `node_modules`, so it breaks
  whenever `node_modules` is reinstalled.
- The CI template must install the package, so it carries a registry,
  `NODE_AUTH_TOKEN`, and per-package-manager substitutions
  (`__INSTALL__`, `__RUN__`, the pnpm step, yarn caveats).
- `tttstudios/archmap`, which `plugin.json` names as its repository,
  doesn't exist, and the package was never published.

## Decision

Copy archmap into each project as `.archmap/` and commit it there (the
CLI, the viewer and the Claude plugin together). The project then carries
everything it needs. CI, other agents and Claude Code all run the copy in
the repo, and the only access needed is to the project itself.

This is possible because the CLI has no runtime dependencies: Node 24 runs
its TypeScript directly, through `bin/archmap.mjs`. The copy is about 500 KB.

Rejected: installing from the private home repo, with a
read token in every project's CI. Every client developer would need
access to the repo and every client CI would need a token, which is
the friction we have now in another place.

## Where the code lives

- **Home:** a private repo made from `packages/archmap`, with the package
  at the repo root. Releases are git tags (`v0.3.0`). While we test, the
  home is `InnovsoftInc/archmap`. Once TTT approves the approach, it
  moves to `tttstudios/archmap`. The home is one constant, `HOME_REPO` in
  `src/home.ts`, which the install command, `/archmap:upgrade` and the
  README all read, so the move changes that one line and the README.
  Examples below use `<home>` for it.
- **In each project:** `.archmap/`, committed. Its layout matches the
  home repo's, so the copy is itself a marketplace:

  ```
  .archmap/
    .claude-plugin/marketplace.json   marketplace "archmap", plugin source ./plugin
    plugin/                           commands, skills, hooks, plugin bin
    bin/archmap.mjs                   the CLI entry point
    src/  viewer/  templates/
    package.json                      name, version, "type": "module" only
    VERSION                           e.g. 0.3.0
  ```

  Tests, coverage and lint config are left out of the copy.

## The one step

The first person to set up a project (anyone with access to the home
repo, through their normal git login) runs:

```bash
npx -y github:<home>#v0.3.0 install
```

`archmap install` (a new command) does the following, in this order:

1. Copies itself into `.archmap/` (the files listed above), replacing
   any copy already there, and writes `VERSION`.
2. Adds `.archmap/** linguist-vendored -diff` to `.gitattributes`, so the
   copy stays out of language stats and PR diffs.
3. Connects Claude Code for this person (`archmap claude`, below).
4. Adds one line to `AGENTS.md` (creating it if needed), pointing other
   agents at `architecture/instructions.md` and at
   `node .archmap/bin/archmap.mjs`.
5. Prints what it did, and the next step: open Claude Code and run
   `/archmap:setup`.

Running it again is safe: every step leaves an existing entry as it
is, and step 1 replaces the copy. Without a git repo, it stops before
writing anything and says why.

`/archmap:setup` then works as it does today (init, scan, layers, publish
the Baseline, CI), with the changes below.

## How everything finds the CLI

Every command file, the skill, the drift hook and `init`'s scripts call
`node .archmap/bin/archmap.mjs <command>` from the project root, in place
of `node_modules/.bin/archmap`. Command frontmatter allows it as
`Bash(node .archmap/bin/archmap.mjs <command>:*)`, a fixed path, because
the docs don't say whether `${CLAUDE_PLUGIN_ROOT}` is substituted in
`allowed-tools`.

- **`init`'s scripts:** `archmap:dev`, `archmap:check` and `archmap:drift`
  in `package.json` become `node .archmap/bin/archmap.mjs …`, so they work
  without the package installed. A project without `package.json` (not
  JavaScript) skips them, as it does today, and runs the CLI directly.
- **`min-version.mjs`:** reads `.archmap/VERSION` in place of
  `node_modules/@tttstudios/archmap/package.json`. `missing` now means
  "run the install command" (it prints the command). `old <version>` now
  means "run `/archmap:upgrade`".
- **The drift hook:** stays silent when `.archmap/` is missing, as it does
  today when the CLI isn't installed.

## CI

The workflow template drops the registry, the token, the
package-manager steps and every substitution:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: node .archmap/bin/archmap.mjs check
- run: node .archmap/bin/archmap.mjs drift --base origin/${{ github.base_ref }}
```

`permissions` drops `packages: read`. Setup's step 7 shrinks to writing
the file (with `--dir` when the map isn't in `architecture/`) and
the existing note about git hooks. The yarn and lockfile guidance goes.

## Upgrades

`/archmap:upgrade [version]` (a new command) runs
`npx -y github:<home>#v<version> install`, defaulting to the
latest tag, which the command finds with `git ls-remote --tags`. It shows
the old and new `VERSION` and asks before running. The plugin is used in
place, not cached, so the new copy loads at the next session or after
`/reload-plugins`. A client without access to the home repo gets
upgrades when TTT opens a PR against their repo.

## Teammates: one command per person

Task 0 showed that a marketplace committed in `.claude/settings.json`
isn't registered by headless Claude Code. Registering it with
`--scope project` writes an absolute path into the committed settings,
which breaks on everyone else's machine. So the plugin is connected per
person, and nothing about it is committed:

```bash
node .archmap/bin/archmap.mjs claude      # or: pnpm archmap:claude
```

`archmap claude` (a new command) runs, from the project root:

1. `claude plugin marketplace add <absolute path to .archmap> --scope local`
2. `claude plugin install archmap@archmap --scope local`

`--scope local` writes to `.claude/settings.local.json`, which git
ignores, so the absolute path stays on that person's machine. The
`install` command runs it for the first person. Everyone else runs it
once after cloning: the README, the `AGENTS.md` line and `/archmap:setup`'s
closing message say so.

- **`claude` isn't on `PATH`:** print both commands for the person to run,
  and don't treat it as an error.
- **A marketplace named `archmap` already exists** (for example from the old
  `.tgz` install, in user scope) with a different source: leave it, print
  `claude plugin marketplace remove archmap` and the reason, and skip the
  install step. Never remove it automatically.
- **Already connected to this path:** report it and change nothing.

The CLI, CI and other agents don't depend on the plugin.

## To test first, in a fresh clone

The docs leave two things open. The first task of the plan tests both, in
a scratch repo with a hand-made `.archmap/`, before anything else is built:

1. **Relative path.** Does `"path": "./.archmap"` resolve against the
   project root, opened from the root and from a subfolder? If not, the
   install command stops writing the marketplace to
   `.claude/settings.json` and instead runs
   `claude plugin marketplace add ./.archmap --scope project` (falling
   back to printing that command if `claude` isn't on `PATH`).
2. **Teammate install.** In a fresh clone with the settings committed,
   do `/archmap:*` commands appear without
   `claude plugin install archmap@archmap --scope project`? If not, the
   install command prints that line under "Teammates run once:", and the
   setup command adds it to the project's README section on archmap.

The results go into this spec before implementation continues.

### Results (2026-11-10)

Setup: scratch repo with a hand-made `.archmap/` (plugin, bin, src, viewer,
templates, `package.json`) and `.claude/settings.json` with the entry above,
committed, then `git clone`d as the teammate. Claude Code 2.1.318. The
marketplace and plugin were renamed `archmapt0` for the test, because this
machine already has a user-scope `archmap` marketplace (from
`turo/node_modules/@tttstudios/archmap`) that would hide the result.

**What could be observed headlessly (no interactive trust dialog)**

- `claude -p` in the clone root, debug log:
  `Skipping orphaned enabledPlugins entry archmapt0@archmapt0: marketplace not registered`.
  `claude plugin marketplace list --json` showed no `archmapt0`, and
  `/archmapt0:*` commands were absent (only the pre-existing user-scope
  `/archmap:*` appeared). Same from a subfolder.
- `claude plugin install archmapt0@archmapt0 --scope project` in the clone,
  with the settings entry present, failed from root and subfolder:
  `Plugin "archmapt0" not found in marketplace "archmapt0"`. Using an
  absolute path in the entry gave the identical error, so the failure is not
  about the relative path: headless commands never register
  `extraKnownMarketplaces` entries.
- Fallback command, run in an isolated config dir:
  `claude plugin marketplace add ./.archmap --scope project` (from root, and
  `./../.archmap` from a subfolder) printed `Successfully added marketplace:
archmapt0 (declared in project settings)`, then
  `claude plugin install archmapt0@archmapt0 --scope project` printed
  `Successfully installed plugin ... (scope: project)`.
  **It wrote an absolute path** into `.claude/settings.json`
  (`"path": "/private/tmp/.../clone4/.archmap"`), so committing that file
  would break for every teammate.

**Answers**

1. Does `"path": "./.archmap"` resolve from root and from a subfolder?
   **Not determined.** Registration from `extraKnownMarketplaces` happens in
   the interactive trust flow, which `claude -p` and `claude plugin` skip, so
   there was nothing to resolve. It needs one interactive check (open Claude
   Code in a fresh clone, accept the trust prompt, run
   `claude plugin marketplace list`, repeat from a subfolder).
2. Do `/archmap:*` commands appear in a fresh clone without
   `claude plugin install`? **Not in headless mode** (above); not determined
   for an interactive session.

**Fallbacks**

- Fallback 2 applies: Task 2's final output and Task 6's README gain the
  `claude plugin install archmap@archmap --scope project` line, because the
  commands were not present in the fresh clone and the line is harmless if
  they are.
- Fallback 1 is **not** applied: the relative path was not shown to fail, and
  the replacement command writes an absolute path into committed settings.
  If the interactive check shows the relative path fails, the fallback must
  be rethought, for example by printing the `marketplace add` command for
  each person to run rather than committing its result.

## What belongs on the map

Today the four layers, and what should trigger an update, are only in the
Claude skill. `instructions.md` only explains how to write a save. So Codex,
Cursor or a CI agent reading `instructions.md` can't tell what to record,
and nothing anywhere says how much detail to record or what to leave out.
`templates/instructions.md` gains this section, placed after its opening
paragraph, so every agent reads the same rules. `SKILL.md` drops its own
layer list and points to the section instead. Like the rest of the
template, the section stays free of project-specific detail.

```markdown
## What belongs on the map

Record what someone joining the project needs in order to understand how it
fits together. Leave out how each piece is written inside. The map has four
layers; put each change in the layer it belongs to.

1. **Overview**: every app or service the project deploys, every database,
   queue or file store, every outside service it calls (sign-in, email,
   payments, AI, hosting), and the connections between them. Update it when
   one of these is added, removed, replaced or moved.
2. **Parts**: inside each app, every endpoint it serves (method and path), every
   background or scheduled job, and every storage container (bucket, queue,
   topic). Libraries and tools only when they shape the architecture: the
   framework, auth, database access, payments, messaging, observability. Not
   general utilities.
3. **Data**: every table and column in the databases the project owns, and every
   enum they use. Not indexes (except unique constraints), migrations or views.
4. **People and flows**: one persona per kind of user the product serves (the
   roles in its auth, or the people a brief names), what each needs to get done,
   and the main journeys through the services: signing up, the product's core
   jobs, paying. Not every screen or click.

Record a change when code adds, removes, renames or rewires one of these, or
when a decision is made about one that isn't built yet (`status: planned`), or
is being phased out (`status: retiring`). A refactor, a test, or a change
inside a file that leaves all of the above as it was needs no save.

Never put on the map: secrets, keys, tokens, passwords or environment values;
personal data; internal hostnames or URLs that include credentials; UI
components, helper functions, test fixtures or one-off scripts; anything that's
only an idea nobody has decided on.
```

## Not changing

The map format, saves, versions, `scan`, `drift`, `publish`, the viewer, and
the layers in `/archmap:setup`.

## Migration

- **bcacs:** run the install command, remove the `@tttstudios/archmap`
  dev dependency, rewrite its archmap workflow from the new template,
  and delete `INSTALL-from-file.md` and the `.tgz`.
- **The home repo:** create `InnovsoftInc/archmap` (private) from
  `packages/archmap`, with history, and tag the first release. After TTT
  approves: transfer it to `tttstudios`, or push it there, then update
  `HOME_REPO`, `repository` in `package.json` and `plugin.json`, and the
  README.
- **The package:** drop `publishConfig` and stop publishing to GitHub
  Packages. `repository` in `package.json` and `plugin.json` names the
  home repo. `package.json`'s `bin` stays, so `npx github:…` works.
- **README:** the install section becomes the one command, plus
  `/archmap:setup`.

## Testing

- **Unit tests for `install`:** writes the expected files and leaves out
  tests and config; writes `VERSION`; merges settings while keeping
  existing keys, `enabledPlugins` entries and marketplaces; is safe to
  run twice; writes nothing when settings JSON is invalid or there's no
  git repo; adds the `.gitattributes` and `AGENTS.md` lines once.
- **Unit tests for `init`:** scripts use `node .archmap/bin/archmap.mjs`.
- **Unit tests for `min-version.mjs`:** `ok`, `missing` and `old` from
  `VERSION`.
- **End to end:** pack the repo, run `npx <tarball> install` in a scratch
  git repo, run `node .archmap/bin/archmap.mjs check` there, and run the
  workflow template with `act`.
- **By hand:** the two tests in "To test first", and `/archmap:setup` in
  a fresh clone of a scratch project.
