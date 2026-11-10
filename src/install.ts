// `archmap install`: copies archmap into the project as .archmap/.

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { connectClaude, type Run } from "./claude.ts";
import type { Result } from "./commands.ts";
import { HOME_REPO, PACKAGE_ROOT, VERSION } from "./home.ts";
import { writeJson } from "./project.ts";

export const COPIED = [
  ".claude-plugin",
  "plugin",
  "bin",
  "src",
  "viewer",
  "templates",
] as const;

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// Adds `line` to the file (creating it) unless a line already matches.
// Returns true when it wrote.
export const appendLineOnce = (file: string, line: string): boolean => {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").includes(line)) return false;
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${lead}${line}\n`);
  return true;
};

const GITATTRIBUTES_LINE = ".archmap/** linguist-vendored -diff";
const AGENTS_LINE =
  "- Architecture map: read architecture/instructions.md before changing services, endpoints, tables or flows, and run `node .archmap/bin/archmap.mjs check` after recording a change. Claude Code users run `node .archmap/bin/archmap.mjs claude` once to get the archmap commands.";

export const install = (
  projectRoot: string,
  opts: { packageRoot?: string; run?: Run } = {},
): Result => {
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  if (!existsSync(join(projectRoot, ".git")))
    return {
      ok: false,
      lines: ["Run this from the project root (the folder with .git)."],
    };
  const target = join(projectRoot, ".archmap");
  if (real(packageRoot) === real(target))
    return {
      ok: false,
      lines: [
        "Run install through npx from the home repo; see `archmap upgrade`.",
      ],
    };

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const skip = (source: string): boolean => {
    const rel = relative(packageRoot, source).split(sep).join("/");
    return (
      rel !== "src/__tests__" &&
      !rel.startsWith("src/__tests__/") &&
      !basename(source).startsWith(".tmp-")
    );
  };
  // Copy each entry's children one by one: cpSync refuses to copy a folder
  // that contains the target, and a project can sit inside src/ (the tests do).
  for (const entry of COPIED) {
    mkdirSync(join(target, entry), { recursive: true });
    for (const child of readdirSync(join(packageRoot, entry)))
      cpSync(join(packageRoot, entry, child), join(target, entry, child), {
        recursive: true,
        filter: skip,
      });
  }
  writeFileSync(join(target, "VERSION"), `${VERSION}\n`);
  writeJson(join(target, "package.json"), {
    name: "@tttstudios/archmap",
    version: VERSION,
    type: "module",
    repository: { type: "git", url: `https://github.com/${HOME_REPO}` },
  });
  appendLineOnce(join(projectRoot, ".gitattributes"), GITATTRIBUTES_LINE);
  appendLineOnce(join(projectRoot, "AGENTS.md"), AGENTS_LINE);
  const claude = connectClaude(projectRoot, { run: opts.run });
  return {
    ok: claude.ok,
    lines: [
      `Copied archmap ${VERSION} into .archmap/.`,
      ...claude.lines,
      "Next: open Claude Code here and run /archmap:setup. Teammates run node .archmap/bin/archmap.mjs claude once after cloning.",
    ],
  };
};
