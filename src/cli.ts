#!/usr/bin/env node
// archmap: an architecture map kept as markdown files in the project's repo.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./agent.ts";
import { brief, type Task } from "./brief.ts";
import { formatCheck, runCheck } from "./check.ts";
import { repoRoot } from "./git.ts";
import { init } from "./init.ts";
import { loadMap } from "./map/load.ts";
import { leadsOf } from "./map/leads.ts";
import type { Result } from "./map/types.ts";
import { migrate } from "./migrate.ts";
import { scan } from "./scan/index.ts";
import { build, serve } from "./site.ts";
import { versionWarning } from "./version.ts";

// The viewer build uses Node's type stripping (stripTypeScriptTypes), which is
// still flagged experimental; keep its warning out of the CLI's output.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w.message);
});

const HELP = `archmap: an architecture map kept as markdown files in your repo.

Usage: archmap <command> [options]

  init [--name "Project"] [--ci github|azure] [--base <branch>] [--cli "<command>"] [--claude]
                                 Create architecture/, the AGENTS.md section and,
                                 with --ci, the PR workflow; --base is the branch
                                 PRs target (default: origin/HEAD, else main)
  scan [--json]                  List what the repo contains (leads for the map)
  check [--json] [--strict] [--base <ref>]
                                 Validate the map; with --base, run the map gate
                                 (use in CI)
  brief [--task setup|update|review|hosting] [--base <ref>]
                                 Print the task for an AI agent to follow
  agent [--task ...] [--base <ref>]
                                 Run the configured agent (agent.command) on the brief
  dev [--port 4321]              View the map locally; reloads on file changes
  build [--out archmap-site] [--public]
                                 Write the map as a static site
  migrate                        Turn an old saves ledger into map files

Options: --dir <folder> (default: architecture)
`;

const TASKS: Task[] = ["setup", "update", "review", "hosting"];

/** Prints the result: to stdout when it passed or is JSON (for a machine to read), else to stderr. */
const print = (r: Result, opts: { json?: boolean } = {}): void => {
  r.lines.forEach((l) =>
    r.ok || opts.json ? console.log(l) : console.error(l),
  );
  if (!r.ok) process.exitCode = 1;
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The repository root (symlinks resolved), or the working folder outside one. */
const projectRoot = (): string =>
  real(repoRoot(process.cwd()) ?? process.cwd());

const main = async (argv: string[]): Promise<void> => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      name: { type: "string" },
      ci: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      task: { type: "string" },
      base: { type: "string" },
      cli: { type: "string" },
      claude: { type: "boolean" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
      public: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd] = positionals;
  if (!cmd || values.help) return void console.log(HELP);

  const cwd = process.cwd();
  const dirArg = values.dir ?? "architecture";
  const dir = resolve(cwd, dirArg);
  const task = values.task as Task | undefined;
  if (task && !TASKS.includes(task))
    throw new Error(`--task must be one of ${TASKS.join(", ")}, not "${task}"`);

  switch (cmd) {
    case "init": {
      const ci = values.ci;
      if (ci !== undefined && ci !== "github" && ci !== "azure")
        throw new Error(`--ci must be github or azure, not "${ci}"`);
      return print(
        init(real(cwd), {
          dir: dirArg,
          name: values.name,
          ci,
          base: values.base,
          cli: values.cli,
          claude: values.claude,
        }),
      );
    }
    case "scan": {
      const leads = leadsOf(scan(projectRoot()));
      if (values.json) console.log(JSON.stringify(leads, null, 2));
      else leads.forEach((l) => console.log(l.key));
      return;
    }
  }

  const warning = versionWarning(loadMap(dir).config);
  if (warning) console.error(warning);
  const root = projectRoot();

  switch (cmd) {
    case "check":
      return print(
        formatCheck(runCheck(root, dir, { base: values.base }), {
          strict: values.strict,
          json: values.json,
        }),
        { json: values.json },
      );
    case "brief":
      return void console.log(brief(root, dir, { task, base: values.base }));
    case "agent":
      return print(runAgent(root, dir, { task, base: values.base }));
    case "migrate":
      return print(migrate(root, dir));
    case "build":
      return print({
        ok: true,
        lines: build(root, dir, resolve(cwd, values.out || "archmap-site"), {
          public: values.public,
        }),
      });
    case "dev": {
      const port = Number(values.port || 4321);
      await serve(root, dir, port);
      console.log(
        `Architecture map at http://127.0.0.1:${port}/ (reloads when files in ${dirArg} change). Ctrl+C to stop.`,
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
