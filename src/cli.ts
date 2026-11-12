#!/usr/bin/env node
// archmap: an architecture map kept as files in the project's repo.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  check,
  init,
  newSave,
  publish,
  resolveDir,
  scanCommand,
  snapshot,
  type Result,
} from "./commands.ts";
import { connectClaude } from "./claude.ts";
import { driftCommand } from "./drift.ts";
import { install } from "./install.ts";
import { upgradeInfo } from "./upgrade.ts";
import { build, serve } from "./site.ts";

// The viewer build uses Node's type stripping (stripTypeScriptTypes), which is
// still flagged experimental; keep its warning out of the CLI's output.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w.message);
});

const HELP = `archmap: an architecture map kept as files in your repo.

Usage: archmap <command> [options]

  install                        Copy archmap into .archmap/ and set up Claude Code (run through npx)
  upgrade [version]              Find a newer release and name the command to reinstall
  claude                         Connect Claude Code to .archmap/ for you (local scope, not committed)
  init [--name "Project"] [--no-skill]
                                 Create architecture/ and the Claude skill
                                 (--no-skill if the plugin provides it)
  dev [--port 4321]              View the map locally; reloads on file changes
  build [--out archmap-site]     Write the map as a static site
  check                          Validate every save and version (use in CI)
  save --summary "..."           Start a new save file for Claude or you to fill
  publish "Sprint 2" [--summary]  Turn the draft into a version
  snapshot                       Write architecture/current.json (latest state)
  scan [--watch]                 List what the repo contains (routes, tables,
                                 services) as JSON; --watch proposes a watch list
                                 (run it from the project root: the paths are
                                 relative to it, as drift reads them)
  drift [--base <ref>] [--json] [--strict]
                                 List watched files changed on this branch with
                                 no new save; exits 0 unless --strict

Options: --dir <folder> (default: architecture)
`;

const print = (r: Result): void => {
  r.lines.forEach((l) => (r.ok ? console.log(l) : console.error(l)));
  if (!r.ok) process.exitCode = 1;
};

const main = async (argv: string[]): Promise<void> => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      dir: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      summary: { type: "string" },
      author: { type: "string" },
      skill: { type: "boolean", default: true },
      watch: { type: "boolean" },
      base: { type: "string" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const dir = resolveDir(values.dir);
  if (!cmd || values.help) return void console.log(HELP);
  switch (cmd) {
    case "init":
      return print(
        init(values.dir || "architecture", {
          name: values.name,
          skill: values.skill,
        }),
      );
    case "install":
      return print(install(process.cwd()));
    case "upgrade":
      return print(upgradeInfo(process.cwd(), { want: arg }));
    case "claude":
      return print(connectClaude(process.cwd()));
    case "check":
      return print(check(dir));
    case "scan":
      return print(scanCommand(process.cwd(), { watch: values.watch }));
    case "drift":
      return print(
        driftCommand(dir, {
          base: values.base,
          json: values.json,
          strict: values.strict,
        }),
      );
    case "snapshot":
      return print(snapshot(dir));
    case "save":
      if (!values.summary)
        return print({
          ok: false,
          lines: [
            'Give the save a summary: archmap save --summary "Add hour type"',
          ],
        });
      return print(
        newSave(dir, { summary: values.summary, author: values.author }),
      );
    case "publish":
      if (!arg)
        return print({
          ok: false,
          lines: ['Name the version: archmap publish "Sprint 2"'],
        });
      return print(publish(dir, arg, { summary: values.summary }));
    case "build":
      return print({
        ok: true,
        lines: build(
          process.cwd(),
          dir,
          resolve(values.out || "archmap-site"),
          {},
        ),
      });
    case "dev": {
      const port = Number(values.port || 4321);
      await serve(process.cwd(), dir, port);
      console.log(
        `Architecture map at http://127.0.0.1:${port}/ (reloads when files in ${dir} change). Ctrl+C to stop.`,
      );
      return;
    }
    default:
      print({ ok: false, lines: [`Unknown command "${cmd}".`, HELP] });
  }
};

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
