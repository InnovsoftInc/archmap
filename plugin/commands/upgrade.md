---
description: Upgrade the project's copy of archmap in .archmap/ to a newer release.
argument-hint: "[version]"
allowed-tools: Bash(node .archmap/bin/archmap.mjs upgrade:*)
---

# Upgrade archmap

Upgrade the project's copy of archmap (in `.archmap/`) to a newer release. Run every command from the project root with the project's copy of the CLI: `node .archmap/bin/archmap.mjs <command>`. This command doesn't touch the map, so it doesn't need to find the map folder.

1. Run `node .archmap/bin/archmap.mjs upgrade $ARGUMENTS` and show what it prints.
2. If it prints a `Run:` line, ask "Upgrade to <version>?" (the version in that line) and run that command only on a yes.
3. Then run `node .archmap/bin/archmap.mjs check`, and tell the person the new plugin loads after `/reload-plugins` or in a new session.
