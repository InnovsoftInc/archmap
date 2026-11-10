---
description: Publish the architecture map's draft as a named version, after showing what it contains.
argument-hint: '"<version name>"'
---

# Publish the architecture map's draft

Turn the map's draft (every save not yet in a published version) into a named version, usually at the end of a sprint. Only publish after the person says yes.

Version name given: `$ARGUMENTS` (may be empty).

Run every command from the project root with the project's copy of the CLI: `node .archmap/bin/archmap.mjs <command>`. Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command. If `.archmap/bin/archmap.mjs` doesn't exist, run `node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs`, show the person the install command it prints, and stop.

## 1. Show the draft

1. Run `node .archmap/bin/archmap.mjs check`. If it reports problems, show them and stop: a draft with problems can't be published. Offer to fix them.
2. Read `versions.json` and list `saves/` in the map's folder. The draft is every save whose id (the file name without `.json`) isn't in any version's `saves` list. If there are none, say there's nothing to publish and stop.
3. Summarise the draft for the person: each save's `summary` and `author`, oldest first, and what it changes in plain words (for example "adds 3 endpoints to the API, adds the `orders.status` column"). End with the totals.

## 2. Ask for a name and a summary

Ask for the version's name (suggest the one given above, if any, or the next sprint name after the last version in `versions.json`) and a one-line summary of what changed in it. Suggest a summary drafted from the saves.

## 3. Publish only on a yes

Show exactly what you'll run and wait for a clear yes:

```
node .archmap/bin/archmap.mjs publish "<name>" --summary "<one-line summary>"
```

Run it only after that yes. Report what it printed. If the person wants changes first, make them as new saves (following the `archmap` skill), then start again from step 1.
