---
name: archmap
description: Record a change on the project's architecture map (services, connections, database tables and columns, enums, personas, flows). Use after adding or changing an endpoint, table, column, service, integration or flow, when asked to "update the architecture map", or to publish a sprint version.
---

# Update the architecture map

The map lives in the folder that holds `archmap.config.json`, `architecture/` by default, and is the source of truth for this project's architecture. Follow that folder's `instructions.md` exactly.

Run the project's copy of the CLI, from the project root: `node .archmap/bin/archmap.mjs <command>`. Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command.

## What to record

What belongs on the map, and in which of its four layers, is in the "What belongs on the map" section of the map folder's `instructions.md`. Read it before recording.

`node .archmap/bin/archmap.mjs check` prints which layers have content. To fill an empty layer, suggest `/archmap:setup <layer>`.

## Record a change

1. Run `node .archmap/bin/archmap.mjs snapshot` and read `current.json` in the map's folder to see what exists.
2. Run `node .archmap/bin/archmap.mjs save --summary "<one plain line>" --author "<person> via Claude"` and fill in the new save's `ops`, each with a `reason` that names the files it came from.
3. Run `node .archmap/bin/archmap.mjs check` and fix every problem it reports.
4. Tell the person what you recorded; it shows in the map's Draft until a version is published.

## When the map doesn't need to change

If a change touches files the map watches but changes nothing the map describes (a refactor, a test, a rename inside a file), don't add a save. Instead, add this trailer to the commit message, with a reason a teammate understands:

```
Archmap: none - <reason>
```

## Rules

- Only run `archmap publish` when a person asks for it (usually at the end of a sprint, or with `/archmap:publish`).
- Never edit or delete existing saves, `current.json` or `versions.json` by hand. Fix a mistake with a new save that says so.
