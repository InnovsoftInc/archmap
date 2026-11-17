---
name: archmap
description: Use when asked to set up, update, review, show, open, check, fix or upgrade a project's architecture map or "archmap"; when a repo has an architecture/archmap.config.json; when an archmap check or map gate fails on a pull request; or when an archmap command or the project's `archmap` script fails to run.
---

# archmap

archmap keeps a project's architecture as markdown files in `architecture/`,
checked against the code. You write the files; the `archmap` command tells you
what to write and checks it.

**Core rule: never work from memory or guess a subcommand. Run `brief` and
follow what it prints.** The brief carries the current rules, the file format,
what the code scan found and what to ask the person. It changes between
releases; this skill only gets you to it.

## The command

archmap is not on npm. It runs from GitHub at a release tag. Work out the
command once, then use it everywhere below as `ARCHMAP`:

| The repo has | `ARCHMAP` is |
|---|---|
| `architecture/archmap.config.json` with `"cli"` | that `cli` value |
| the config with `"archmap": "X.Y.Z"` | `npx -y github:InnovsoftInc/archmap#vX.Y.Z` |
| no config yet | the latest release: `git ls-remote --tags --refs https://github.com/InnovsoftInc/archmap.git 'v*'`, take the highest `vX.Y.Z`, then `npx -y github:InnovsoftInc/archmap#vX.Y.Z` |

If the map is in another folder, add `--dir <folder>` to every command. Needs
Node 24 or later.

If a command answers `Unknown command`, the project's pinned release is older
than that command (`doctor` came in 0.4.1, `upgrade` in 0.4.4). Run that one
command from the latest release instead, found as in the last row above.

## What to run

| The person wants | Run | Then |
|---|---|---|
| a map set up (no map files yet) | `ARCHMAP brief --task setup` | Follow it. It starts with questions for the person (which branch, pull request checks, name): ask them **before** reading code or running `init`. The brief tells you when to run `init`. |
| the map updated after code changed | `ARCHMAP brief --base <base>` | `<base>` is `"base"` in the config, written as it is there (`main`, not `origin/main`; archmap finds the remote branch). Follow it, then `ARCHMAP check --base <base>` until it passes. |
| the map reviewed, or docs filled in | `ARCHMAP brief --task review` | Follow it, then `ARCHMAP check`. |
| to see the map | the `archmap` script in the root `package.json` (`npm run archmap`, `pnpm archmap`), else `ARCHMAP dev` | Run it **in the background**, give the person the address it prints (http://127.0.0.1:4321/ by default), leave it running. With no map yet, say so and offer to set one up. |
| a failing check or map gate fixed | `ARCHMAP check --base <base>` | Read every error. Then run the update brief above; don't patch files to silence a message. |
| a command that won't run fixed (engine error, missing script) | `ARCHMAP doctor` | It names each problem and the command that fixes it. Run fixes that only change your shell; tell the person the rest. |
| to know if archmap is up to date | the `git ls-remote` line above | Compare its highest `vX.Y.Z` with the config's `"archmap"`. Report both. Change nothing. |
| archmap upgraded | `ARCHMAP upgrade` | It finds the latest release, moves the pin and refreshes the project's archmap files. Say what changed and that it needs committing. |
| the map published as a site | `ARCHMAP brief --task hosting` | Follow it. |

## Ground rules

- Edit only files in the map folder, unless a brief step says otherwise
  (setup's `init`, `upgrade`).
- Every fact you write needs `evidence`: a file you opened, optionally
  `file#Symbol`. If the code doesn't show it, leave it out or ask.
- Names only for environment variables. Never a value, key or token.
- Ask before you commit, push or open a pull request.
- When nothing on the map needs to change for a code change, say so and
  suggest `Archmap: none - <reason>` in the commit message.

## Common mistakes

| Mistake | Instead |
|---|---|
| Running `init` and calling the map set up | `init` only creates the folder and config. The map is written by following `brief --task setup`. |
| Editing map files by copying the shape of nearby entries | Run the brief: the format has fields you won't infer (`does`, `params`, `body`, `env`, `tech`, `host`). |
| Guessing `show`, `view`, `sync`, `add` | The commands are `init`, `scan`, `check`, `brief`, `agent`, `dev`, `build`, `migrate`, `upgrade`, `doctor`. |
| `check` without `--base` on a branch | Without `--base` the pull request rules (new endpoints documented, stale entries, the map gate) don't run. |
| Starting the viewer in the foreground | It never exits. Background it and report the address. |
| Debugging a Node or package-manager error by hand | `ARCHMAP doctor` first. |
| Running a newer archmap than the project pins | Use the pinned version, or `upgrade` first. |
