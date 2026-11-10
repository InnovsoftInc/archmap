---
description: Compare what the code contains with what the architecture map records, list the differences both ways, and record only what the person picks.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs), Bash(node .archmap/bin/archmap.mjs scan:*)
---

# Review the architecture map against the code

Compare what the code contains with what the map records, and list the differences in both directions. This command changes nothing until the person picks what to record. The `archmap` skill describes how to record a change (snapshot, save, ops with reasons, check); follow it for every save you write here.

Run every command from the project root with the project's copy of the CLI: `node .archmap/bin/archmap.mjs <command>`. Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command.

## 0. Check the CLI

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/min-version.mjs`. It prints one of:

- `ok`: carry on.
- `missing <command>`: the archmap CLI isn't copied into this project (there's no `.archmap/VERSION`). Show the person what follows `missing` (the install command to run from the project root, or where to find it), then `/archmap:review` again. Stop here.
- `old <version>`: the project's copy is older than this plugin needs (0.3.0). Point the person to `/archmap:upgrade` and stop here.

If there's no `archmap.config.json` (found as described above), tell the person to run `/archmap:setup` and stop.

## 1. Read both sides

Run `node .archmap/bin/archmap.mjs snapshot` to refresh `current.json` in the map's folder, then read it. It holds `services` (each with `name`, `type`, `tech`, `status`, `parent`), `tables` (each with `columns`), `connections`, `personas` and `flows`.

Run `node .archmap/bin/archmap.mjs scan`. It prints the code's inventory as JSON: `apps`, `routes`, `routeFiles`, `tables`, `schemaFiles`, `infra`, `outside`, `ci` and `unreadable`.

## 2. Compare

- **Routes and endpoints:** each scanned route (`method` and `path`) against the services with `type: "endpoint"`, matching on the name (usually `GET /path`). Treat a path parameter written `:id`, `{id}` or `[id]` as the same. Routes in `routeFiles` or `unreadable` files couldn't be listed; don't call them missing.
- **Tables and columns:** each scanned table against `tables` by name, then its columns against the recorded columns.
- **Infrastructure and outside services:** each `infra` entry and each `outside` entry against services by name, type and tech.
- **App dependencies:** each app's `deps` against the library parts recorded under that app's service. Only notable libraries belong on the map (frameworks, ORMs, SDKs for outside services); skip utility packages.

Entries with `status: planned` or `retired` on the map aren't expected in the code. Don't list a planned item as "on the map but not in the code"; if the code now has it, list it under "In the code but not on the map" as a candidate to mark `live`.

## 3. Print two lists

Print both lists, even when one is empty (write "Nothing" then). Group items by kind (endpoints, tables, columns, services, libraries). Each item gets one line with its file (from the scan) or its map id, so the person can check it.

### In the code but not on the map

Things the scan found that the map doesn't record. Each item: what it is, and the file it was found in.

### On the map but not in the code

Things the map records as `live` that the scan didn't find. Each item: what it is, and its map id. Leave out what the scan can't see: personas, flows, categories, and parent or group services (a service that holds others, or any service with no counterpart among the scan's kinds: routes, tables, apps, infrastructure and outside services). Those are never "not in the code". Say plainly that the scan can miss things it can't read (note any `unreadable` files), so the person decides whether each is really gone.

If both lists are empty, say the map and the code agree and stop.

## 4. Change nothing until the person picks

Ask which items to record, by number. Don't write any save, edit any file or run any command that changes the map before they answer. For each picked item, write a save through the skill: add what's missing from the map, and for items on the map but not in the code, mark them `retired` or remove them, whichever the person says. Each op's `reason` names the file or map id it comes from. Items they don't pick stay as they are.

Write the saves the normal way (the person is prompted to approve each one).

## 5. Check

Run `node .archmap/bin/archmap.mjs check` and fix every problem it reports with new saves or by correcting the saves you wrote in this run. Then say what was recorded and what was left alone.
