// `archmap brief`: the task prompt any AI agent follows to create or update the map.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_WARNING, runCheck } from "./check.ts";
import {
  branchNames,
  changedFiles,
  currentBranch,
  defaultBase,
  prHost,
} from "./git.ts";
import { PACKAGE_ROOT } from "./home.ts";
import { evidenceOf } from "./map/evidence.ts";
import type { Doc, MapConfig } from "./map/types.ts";
import { troubleLines, troubles } from "./doctor.ts";
import { defaultName } from "./init.ts";
import { cliCommand } from "./version.ts";
import { strings } from "./util.ts";

export type Task = "setup" | "update" | "review" | "hosting";

// Each list in the brief is capped so a large change or a broken map can't
// make the prompt too long for the agent.
const MAX_LEADS = 200;
const MAX_CHANGED = 200;
const MAX_PROBLEMS = 200;

/** The first `max` lines, then "…and N more" for the rest. */
const capped = (lines: string[], max: number): string[] =>
  lines.length > max
    ? [...lines.slice(0, max), `…and ${lines.length - max} more`]
    : lines;

/** An explicit task wins; an empty map is set up; `--base` means update; otherwise review. */
export const pickTask = (
  docs: Doc[],
  opts: { task?: Task; base?: string },
): Task => {
  if (opts.task) return opts.task;
  if (!docs.length) return "setup";
  return opts.base ? "update" : "review";
};

const template = (name: string): string =>
  readFileSync(
    join(PACKAGE_ROOT, "templates", "brief", `${name}.md`),
    "utf8",
  ).trim();

const MAX_BRANCHES = 12;

/**
 * What to ask the person before the first map is written, with what the repo
 * already shows: its branches, the one checked out, and where its pull
 * requests live.
 */
const setupQuestions = (
  root: string,
  config: MapConfig,
  cli: string,
  // False before `init` has run: the config's name is then only a placeholder.
  named: boolean,
): string => {
  const base = config.base ?? defaultBase(root);
  const here = currentBranch(root);
  const names = branchNames(root);
  const host = prHost(root);
  const listed = names.slice(0, MAX_BRANCHES).map((n) => `\`${n}\``);
  const more = names.length - listed.length;
  return template("setup-ask")
    .replaceAll("__CLI__", cli)
    .replaceAll("__BASE__", base)
    .replaceAll(
      "__BASE_NOTE__",
      here && here !== base ? ` (\`${here}\` is checked out now)` : "",
    )
    .replaceAll(
      "__BRANCHES__",
      listed.length
        ? `Branches here: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`
        : "No branches found: this isn't a git repository yet, so skip the branch and pull request steps.",
    )
    .replaceAll(
      "__CI__",
      host
        ? `${host === "github" ? "GitHub Actions" : "Azure Pipelines"}, since this repository is hosted there`
        : "no check, since this repository's host isn't GitHub or Azure DevOps",
    )
    .replaceAll("__NAME__", named ? config.name : defaultName(root));
};

const covers = (doc: Doc, file: string): boolean =>
  strings(doc.data.code).some((code) => {
    const prefix = code.replace(/\/+$/, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }) || evidenceOf(doc).some((c) => c.evidence.split("#")[0] === file);

const groundRules = (
  task: Task,
  dir: string,
  forAgent: boolean,
  cli: string,
): string => {
  const rules = [
    "The existing map, including people's edits, stands unless the code contradicts it.",
    "Write for every audience, in heading order: a plain summary first, then `## How it works`, then `## For developers`.",
    "When the code doesn't show a fact, ask, or leave it out. Don't guess.",
    `Edit only files in the map folder (\`${dir}\`).`,
    `If a command fails because of the setup, not the map (the Node version, the package manager, a missing tool or script), don't stop at reporting it. Run \`${cli} doctor\`, fix what only changes your own shell, and tell the person what failed, why, and the exact command that fixes it.`,
  ];
  if (task === "update")
    rules.push(
      forAgent
        ? `If nothing on the map needs to change, write one line saying why to \`${dir}/.no-change\` and edit nothing else.`
        : "If nothing on the map needs to change, add `Archmap: none - <reason>` to your commit message and edit nothing.",
    );
  return rules.map((r) => `- ${r}`).join("\n");
};

export const brief = (
  root: string,
  dir: string,
  opts: { task?: Task; base?: string; forAgent?: boolean },
): string => {
  // With --base the results include the map gate, so the agent sees why CI fails.
  const check = runCheck(root, dir, { base: opts.base });
  const task = pickTask(check.map.docs, opts);
  const cli = cliCommand(check.map.config, dir, root);
  const folder = dir.startsWith(root)
    ? dir.slice(root.length).replace(/^[\\/]+/, "") || "."
    : dir;
  const out: string[] = [
    `# archmap brief: ${task}`,
    "",
    // A first map starts with the person's choices. Not when archmap runs the
    // agent itself: nobody is there to answer.
    ...(task === "setup" && !check.map.docs.length && !opts.forAgent
      ? [
          "## First, ask the person",
          "",
          setupQuestions(
            root,
            check.map.config,
            cli,
            existsSync(join(dir, "archmap.config.json")),
          ),
          "",
        ]
      : []),
    "## Your task",
    "",
    template(task),
    "",
  ];

  // What will fail in this shell whatever the map says, so the agent can
  // repair it or tell the person how.
  const broken = troubles(root, dir, check.map.config);
  if (broken.length)
    out.push(
      "## Fix the setup",
      "",
      "These will make commands fail here. Fix the ones that only change your own shell; in your final message tell the person each one that is left, with its fix.",
      "",
      ...troubleLines(broken),
      "",
    );

  if (task === "update") {
    const base = opts.base ?? check.map.config.base ?? defaultBase(root);
    const changed = changedFiles(root, base);
    const covering = check.map.docs.filter((d) =>
      changed.some((f) => covers(d, f)),
    );
    out.push(
      `## What changed since ${base}`,
      "",
      ...(changed.length
        ? capped(
            changed.map((f) => `- ${f}`),
            MAX_CHANGED,
          )
        : ["No files."]),
      "",
      ...(covering.length
        ? [
            "Map files that cover them:",
            "",
            ...covering.map((d) => `- ${d.file}`),
            "",
          ]
        : []),
    );
  }

  const problems = capped(
    [
      ...check.errors.map(
        (f) => `error: ${f.file ? `${f.file}: ` : ""}${f.message}`,
      ),
      // Leads are listed (and capped) under "Leads from scan", not here.
      ...check.warnings
        .filter((f) => !f.message.startsWith(LEAD_WARNING))
        .map((f) => `warning: ${f.file ? `${f.file}: ` : ""}${f.message}`),
    ],
    MAX_PROBLEMS,
  );
  const leads = capped(
    check.leads.map((l) => `- ${l.file}: ${l.text}`),
    MAX_LEADS,
  );

  out.push(
    "## What belongs on the map",
    "",
    template("rules"),
    "",
    "## How to write map files",
    "",
    template("format"),
    "",
    "## Ground rules",
    "",
    groundRules(task, folder, opts.forAgent ?? false, cli),
    "",
    "## Current check results",
    "",
    ...(problems.length ? problems : ["None."]),
    "",
    "## Leads from scan",
    "",
    ...(leads.length ? leads : ["None."]),
    "",
    "## When you're done",
    "",
    `Run \`${cli} check\` and fix every error until it passes.`,
    "",
  );
  return out.join("\n");
};
