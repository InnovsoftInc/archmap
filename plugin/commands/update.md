---
description: Record what this branch changed on the architecture map, drafting saves from the drift report.
argument-hint: "[--base <ref>]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs), Bash(node .archmap/bin/archmap.mjs drift:*), Bash(node .archmap/bin/archmap.mjs check:*)
---

# Update the architecture map

Turn what this branch changed in the code into saves on the architecture map. The `archmap` skill describes how to record a change (snapshot, save, ops with reasons, check); follow it for every save you write here.

Arguments: `$ARGUMENTS` (a `--base <ref>` here is passed to `archmap drift`).

Run every command from the project root with the project's copy of the CLI: `node .archmap/bin/archmap.mjs <command>`. Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command. If `.archmap/bin/archmap.mjs` doesn't exist, run `node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs`, show the person the install command it prints, and stop.

## 1. Find what changed

Run `node .archmap/bin/archmap.mjs drift --json $ARGUMENTS`. It prints `{ status, base, groups, message }`. Each group has `means` (what the changed files usually mean for the map), `layer` and `files`.

Go by `status`:

- `no-baseline`, `no-watch` or `error`: say the `message` and stop. For `no-baseline` or `no-watch` suggest `/archmap:setup`; for `error` suggest passing `--base <ref>` with a branch or commit that exists.
- `ok`: say nothing needs recording and stop.
- `uncovered`: carry on.

## 2. Draft a save for each group

For each group, read the changed files (and `git diff <base> -- <file>` where it helps), then run `node .archmap/bin/archmap.mjs snapshot` to see what the map already holds. Draft a save for what the files changed, following the skill. Each op's `reason` names the files it comes from, so a reviewer can check the save against the code.

Write the saves the normal way (the person is prompted to approve each one). Don't invent what the code doesn't show; ask when a file's meaning isn't clear.

## 3. Name the groups that need no change

If a group needs no map change (a refactor, a test, formatting), say so, with the files and why. Suggest adding the trailer `Archmap: none - <reason>` to the commit message for that case, with a reason a teammate understands.

## 4. Check

Run `node .archmap/bin/archmap.mjs check` and fix every problem it reports with new saves or by correcting the saves you wrote in this run. Then run `node .archmap/bin/archmap.mjs drift $ARGUMENTS` again and report what's still uncovered, if anything.
