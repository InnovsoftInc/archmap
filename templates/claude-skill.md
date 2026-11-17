---
name: archmap
description: Build, update or review this project's architecture map in __DIR__/ (services, stores, outside services, personas, flows). Use after a change that adds, removes or rewires a service, connection, endpoint, job, table, column, enum, role or flow; when asked to set up, update or review the architecture map; or when the archmap check or gate fails.
---

# Architecture map

The map lives in `__DIR__/` as markdown files that you write and `archmap` checks. `archmap brief` prints the full task, with the rules, the file format and what the code scan found; follow it rather than this summary.

1. Pick the task:
   - After changing code on this branch: `__CLI__ brief --base __BASE__`
   - When asked to set up the map, or `__DIR__/` has no map files yet: `__CLI__ brief --task setup`
   - When asked to review the map: `__CLI__ brief --task review`
2. Follow the brief. Every fact you write needs `evidence` you checked in the code.
3. Run `__CLI__ check` and fix every error until it passes. Warnings list leads to confirm: add them to the map with evidence, or to `ignore` in `__DIR__/archmap.config.json` if they don't belong.
4. Run `__CLI__ check --base __BASE__`. If it still fails because nothing on the map needs to change, say so and suggest adding `Archmap: none - <reason>` to the commit message.

To show the map, run `__START__` in the background and give the person the address it prints (http://127.0.0.1:4321/ by default); it reloads as you edit map files. If that script is missing from `package.json`, run `__CLI__ init` to add it.

Edit only files in `__DIR__/`. Tell the person what you changed on the map.
