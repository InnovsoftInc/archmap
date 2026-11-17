## Architecture map

- Before working on the project, read `__DIR__/README.md` and the map files for the area you're changing.
- After a change that adds, removes or rewires a service, connection, endpoint, job, table, column, enum, role or flow, run `__CLI__ brief --base __BASE__`, follow it, and run `check` until it passes.
- When asked to "update the map" or "review the map", run `brief` with that task.
- When asked to show, open or start the map, run `__START__` in the background and give the person the address it prints (http://127.0.0.1:4321/ by default); it reloads as map files change, so leave it running while you edit the map. If that script is missing from `package.json`, run `__CLI__ init` to add it.
