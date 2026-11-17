// `init`: set a project up for a markdown map: config, README, the start script, the AGENTS.md and README.md blocks and, on request, the PR workflow.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PACKAGE_ROOT, VERSION } from "./home.ts";
import type { MapConfig, Result } from "./map/types.ts";
import { defaultBase } from "./git.ts";
import { ciCommand, cliCommand } from "./version.ts";

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

const packageName = (root: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.name === "string" && pkg.name ? pkg.name : undefined;
  } catch {
    return undefined;
  }
};

// How the project's package manager runs a package.json script.
export const runScript = (
  root: string,
  pkg: Record<string, unknown>,
): string => {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const has = (file: string) => existsSync(join(root, file));
  if (pm.startsWith("pnpm@") || has("pnpm-lock.yaml")) return "pnpm";
  if (pm.startsWith("yarn@") || has("yarn.lock")) return "yarn";
  if (pm.startsWith("bun@") || has("bun.lock") || has("bun.lockb"))
    return "bun run";
  return "npm run";
};

/**
 * Adds an `archmap` script that starts the viewer to the root package.json, so
 * people and agents start the map the way they start everything else. A script
 * of that name that doesn't run archmap is someone's own and is kept. Returns
 * the command that starts the viewer, and a line saying what was done.
 */
const addStartScript = (
  root: string,
  cli: string,
): { start: string; line?: string } => {
  const dev = `${cli} dev`;
  const file = join(root, "package.json");
  if (!existsSync(file)) return { start: dev };
  const text = readFileSync(file, "utf8");
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    pkg = parsed as Record<string, unknown>;
  } catch {
    return {
      start: dev,
      line: "package.json isn't valid JSON, so no archmap script was added.",
    };
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const current: unknown = Reflect.get(scripts, "archmap");
  const start = `${runScript(root, pkg)} archmap`;
  if (current === dev)
    return { start, line: "Kept the archmap script in package.json." };
  if (typeof current === "string" && !current.includes("archmap"))
    return {
      start: dev,
      line: "Kept your own archmap script in package.json.",
    };
  pkg.scripts = { ...scripts, archmap: dev };
  // Keep the file's own indentation and final newline.
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  writeFileSync(
    file,
    `${JSON.stringify(pkg, null, indent)}${text.endsWith("\n") ? "\n" : ""}`,
  );
  return {
    start,
    line: `${current === undefined ? "Added" : "Updated"} the archmap script in package.json (\`${start}\` opens the map).`,
  };
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

// `cli` goes right after `name`, where the README's example has it.
const withCli = (config: MapConfig, cli: string): MapConfig => {
  const { archmap, name, ...rest } = config;
  // `rest` still holds the old cli, which would win the spread.
  const next: MapConfig = { archmap, name, cli, ...rest };
  next.cli = cli;
  return next;
};

export const init = (
  root: string,
  opts: {
    dir?: string;
    name?: string;
    ci?: "github" | "azure";
    base?: string;
    cli?: string;
    claude?: boolean;
    /** Replace a workflow that differs from the template. */
    force?: boolean;
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
    // --base changes the base; a config without one gets the detected one.
    const base = opts.base ?? config.base ?? defaultBase(root);
    const changed: string[] = [];
    if (config.base !== base) {
      config = { ...config, base };
      changed.push(`base to ${base}`);
    }
    if (opts.cli !== undefined && config.cli !== opts.cli) {
      config = withCli(config, opts.cli);
      changed.push(`cli to ${opts.cli}`);
    }
    if (changed.length) {
      write(configPath, `${JSON.stringify(config, null, 2)}\n`);
      lines.push(`Set ${changed.join(" and ")} in ${rel}/archmap.config.json.`);
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
    config = JSON.parse(text) as MapConfig;
    if (opts.cli !== undefined) config = withCli(config, opts.cli);
    write(
      configPath,
      opts.cli === undefined ? text : `${JSON.stringify(config, null, 2)}\n`,
    );
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

  const started = addStartScript(root, cli);
  if (started.line) lines.push(started.line);

  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) writeFileSync(agents, "# Agent notes\n");
  const section = template("agents-section.md")
    .replaceAll("__START__", started.start)
    .replaceAll("__CLI__", cli)
    .replaceAll("__DIR__", rel)
    .replaceAll("__BASE__", config.base ?? "main")
    .trimEnd();
  const agentsText = readFileSync(agents, "utf8");
  const updated = withBlock(agentsText, `${START}\n${section}\n${END}`);
  if (updated === agentsText)
    lines.push("Kept the archmap section of AGENTS.md.");
  else {
    writeFileSync(agents, updated);
    lines.push("Updated the archmap section of AGENTS.md.");
  }

  // The project's own README says how to view and use the map. Not when the
  // map folder is the project root: that README is the map's start page.
  if (rel !== ".") {
    const projectReadme = join(root, "README.md");
    const had = existsSync(projectReadme);
    const before = had ? readFileSync(projectReadme, "utf8") : "";
    const about = template("readme-section.md")
      .replaceAll("__START__", started.start)
      .replaceAll("__CLI__", cli)
      .replaceAll("__DIR__", rel.split("\\").join("/"))
      .trimEnd();
    const after = withBlock(before, `${START}\n${about}\n${END}`);
    if (after === before)
      lines.push("Kept the archmap section of README.md.");
    else {
      writeFileSync(projectReadme, after);
      lines.push(
        had
          ? "Updated the archmap section of README.md."
          : "Wrote README.md with how to view the map.",
      );
    }
  }

  const claude = join(root, "CLAUDE.md");
  if (existsSync(claude) && addAgentsImport(claude))
    lines.push("Added @AGENTS.md to CLAUDE.md.");

  if (opts.ci) {
    const [from, to] =
      opts.ci === "github"
        ? ["github", join(".github", "workflows", "archmap.yml")]
        : ["azure-pipelines", join(".azure-pipelines", "archmap.yml")];
    // The workflow reads the archmap version from the config when it runs,
    // so it needs no rewrite when the pin changes; this version is only the
    // fallback for a config that pins none.
    const text = template("ci", from, "archmap-pr.yml")
      .replaceAll("__CLI__", ciCommand(config, dir, root))
      .replaceAll("__DIR__", rel)
      .replaceAll("__VERSION__", VERSION);
    const path = join(root, to);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === text) lines.push(`Kept ${to}.`);
    else if (current !== undefined && !opts.force)
      lines.push(
        `Kept ${to}: it differs from the workflow init writes. Run init --ci ${opts.ci} --force to replace it.`,
      );
    else {
      write(path, text);
      lines.push(current === undefined ? `Wrote ${to}.` : `Replaced ${to}.`);
    }
  }

  if (opts.claude) {
    // A project skill, so Claude Code users get /archmap; it is generated
    // from the config, so running init again keeps it in step with cli and base.
    const skill = join(".claude", "skills", "archmap", "SKILL.md");
    const text = template("claude-skill.md")
      .replaceAll("__START__", started.start)
      .replaceAll("__CLI__", cli)
      .replaceAll("__DIR__", rel)
      .replaceAll("__BASE__", config.base ?? "main");
    const path = join(root, skill);
    if (existsSync(path) && readFileSync(path, "utf8") === text)
      lines.push(`Kept ${skill}.`);
    else {
      write(path, text);
      lines.push(`Wrote ${skill} (/archmap in Claude Code).`);
    }
  }

  lines.push(
    `Next: ask your agent to run \`${cli} brief\` and follow it. To see the map, run \`${started.start}\`.`,
  );
  return { ok: true, lines };
};
