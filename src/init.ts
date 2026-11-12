// `init`: set a project up for a markdown map: config, README, the AGENTS.md block and, on request, the PR workflow.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PACKAGE_ROOT, VERSION } from "./home.ts";
import type { MapConfig, Result } from "./map/types.ts";
import { cliCommand } from "./version.ts";

const START = "<!-- archmap:start -->";
const END = "<!-- archmap:end -->";

const template = (...path: string[]): string =>
  readFileSync(join(PACKAGE_ROOT, "templates", ...path), "utf8");

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// Appends `line` to `file` unless a line equal to it is already there (ignoring
// trailing whitespace, so a CRLF file isn't given a second copy). A new file
// starts with `header`, when given. Returns true when it wrote.
const appendLineOnce = (
  file: string,
  line: string,
  header?: string,
): boolean => {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((l) => l.trimEnd() === line)) return false;
  if (!exists && header !== undefined) {
    writeFileSync(file, `${header}\n\n${line}\n`);
    return true;
  }
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${text}${lead}${line}\n`);
  return true;
};

// Adds the `@AGENTS.md` import to CLAUDE.md unless it is there, however a
// formatter indented it. A blank line before it keeps a list from absorbing it.
const IMPORTS_AGENTS = new Set(["@AGENTS.md", "@./AGENTS.md"]);
const addAgentsImport = (file: string): boolean => {
  const text = readFileSync(file, "utf8");
  if (text.split("\n").some((l) => IMPORTS_AGENTS.has(l.trim()))) return false;
  const lead =
    text === "" || text.endsWith("\n\n")
      ? ""
      : text.endsWith("\n")
        ? "\n"
        : "\n\n";
  writeFileSync(file, `${text}${lead}@AGENTS.md\n`);
  return true;
};

// The branch pull requests target: the one origin/HEAD names, else main.
const defaultBase = (root: string): string => {
  try {
    const ref = execFileSync(
      "git",
      ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return ref.replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
};

const packageName = (root: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.name === "string" && pkg.name ? pkg.name : undefined;
  } catch {
    return undefined;
  }
};

// Formatting a formatter may apply (blank lines, indentation, spacing) doesn't
// count as a difference.
const normalized = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");

/**
 * Replaces the archmap block in `text`, or appends it when there is none. A block
 * that differs only by formatting is left as it is.
 */
const withBlock = (text: string, block: string): string => {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start !== -1 && end !== -1) {
    const current = text.slice(start, end + END.length);
    if (normalized(current) === normalized(block)) return text;
    return text.slice(0, start) + block + text.slice(end + END.length);
  }
  const lead =
    text === "" || text.endsWith("\n\n")
      ? ""
      : text.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${text}${lead}${block}\n`;
};

export const init = (
  root: string,
  opts: {
    dir?: string;
    name?: string;
    ci?: "github" | "azure";
    base?: string;
  },
): Result => {
  const dir = opts.dir ?? "architecture";
  const mapDir = resolve(root, dir);
  const rel = relative(resolve(root), mapDir) || ".";
  const lines: string[] = [];

  const configPath = join(mapDir, "archmap.config.json");
  let config: MapConfig;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as MapConfig;
    } catch {
      return {
        ok: false,
        lines: [
          `${rel}/archmap.config.json isn't valid JSON; fix it and run init again.`,
        ],
      };
    }
    if (opts.base && config.base !== opts.base) {
      config = { ...config, base: opts.base };
      write(configPath, `${JSON.stringify(config, null, 2)}\n`);
      lines.push(`Set base to ${opts.base} in ${rel}/archmap.config.json.`);
    } else lines.push(`Kept the existing ${rel}/archmap.config.json.`);
  } else {
    const name =
      opts.name ??
      packageName(root) ??
      basename(resolve(root)) ??
      "Architecture";
    const json = (v: string) => JSON.stringify(v).slice(1, -1);
    // The default agent may run check and brief without asking, so it works
    // in CI; `archmap agent` fills `{cli}` in when it runs.
    const text = template("config.json")
      .replace("__VERSION__", VERSION)
      .replace("__NAME__", () => json(name))
      .replace("__BASE__", () => json(opts.base ?? defaultBase(root)));
    write(configPath, text);
    config = JSON.parse(text) as MapConfig;
    lines.push(`Wrote ${rel}/archmap.config.json (archmap ${VERSION}).`);
  }
  const cli = cliCommand(config, dir, root);

  const readme = join(mapDir, "README.md");
  if (existsSync(readme)) lines.push(`Kept the existing ${rel}/README.md.`);
  else {
    write(readme, template("README.md"));
    lines.push(`Wrote ${rel}/README.md.`);
  }

  // `archmap agent` reads and deletes .no-change; it is never committed.
  if (appendLineOnce(join(mapDir, ".gitignore"), ".no-change"))
    lines.push(`Added .no-change to ${rel}/.gitignore.`);

  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) writeFileSync(agents, "# Agent notes\n");
  const section = template("agents-section.md")
    .replaceAll("__CLI__", cli)
    .replaceAll("__DIR__", rel)
    .replaceAll("__BASE__", config.base ?? defaultBase(root))
    .trimEnd();
  const agentsText = readFileSync(agents, "utf8");
  const updated = withBlock(agentsText, `${START}\n${section}\n${END}`);
  if (updated === agentsText)
    lines.push("Kept the archmap section of AGENTS.md.");
  else {
    writeFileSync(agents, updated);
    lines.push("Updated the archmap section of AGENTS.md.");
  }

  const claude = join(root, "CLAUDE.md");
  if (existsSync(claude) && addAgentsImport(claude))
    lines.push("Added @AGENTS.md to CLAUDE.md.");

  if (opts.ci) {
    const [from, to] =
      opts.ci === "github"
        ? ["github", join(".github", "workflows", "archmap.yml")]
        : ["azure-pipelines", join(".azure-pipelines", "archmap.yml")];
    write(
      join(root, to),
      template("ci", from, "archmap-pr.yml")
        .replaceAll("__CLI__", cli)
        .replaceAll("__DIR__", rel),
    );
    lines.push(`Wrote ${to}.`);
  }

  lines.push(`Next: ask your agent to run \`${cli} brief\` and follow it.`);
  return { ok: true, lines };
};
