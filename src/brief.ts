// `archmap brief`: the task prompt any AI agent follows to create or update the map.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_WARNING, runCheck } from "./check.ts";
import { changedFiles } from "./git.ts";
import { PACKAGE_ROOT } from "./home.ts";
import { evidenceOf } from "./map/evidence.ts";
import type { Doc } from "./map/types.ts";
import { cliCommand } from "./version.ts";

export type Task = "setup" | "update" | "review" | "hosting";

const MAX_LEADS = 200;

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

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const covers = (doc: Doc, file: string): boolean =>
  strings(doc.data.code).some((code) => {
    const prefix = code.replace(/\/+$/, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }) || evidenceOf(doc).some((c) => c.evidence.split("#")[0] === file);

const groundRules = (task: Task, dir: string, forAgent: boolean): string => {
  const rules = [
    "The existing map, including people's edits, stands unless the code contradicts it.",
    "Write for every audience, in heading order: a plain summary first, then `## How it works`, then `## For developers`.",
    "When the code doesn't show a fact, ask, or leave it out. Don't guess.",
    `Edit only files in the map folder (\`${dir}\`).`,
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
    "## Your task",
    "",
    template(task),
    "",
  ];

  if (task === "update") {
    const base = opts.base ?? check.map.config.base ?? "main";
    const changed = changedFiles(root, base);
    const covering = check.map.docs.filter((d) =>
      changed.some((f) => covers(d, f)),
    );
    out.push(
      `## What changed since ${base}`,
      "",
      ...(changed.length ? changed.map((f) => `- ${f}`) : ["No files."]),
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

  const problems = [
    ...check.errors.map(
      (f) => `error: ${f.file ? `${f.file}: ` : ""}${f.message}`,
    ),
    // Leads are listed (and capped) under "Leads from scan", not here.
    ...check.warnings
      .filter((f) => !f.message.startsWith(LEAD_WARNING))
      .map((f) => `warning: ${f.file ? `${f.file}: ` : ""}${f.message}`),
  ];
  const leads = check.leads
    .slice(0, MAX_LEADS)
    .map((l) => `- ${l.file}: ${l.text}`);
  if (check.leads.length > MAX_LEADS)
    leads.push(`…and ${check.leads.length - MAX_LEADS} more`);

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
    groundRules(task, folder, opts.forAgent ?? false),
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
