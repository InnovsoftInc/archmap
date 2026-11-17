// `archmap doctor`: what in this project or shell will make archmap's commands
// fail, each with the command that fixes it. The brief carries the same list,
// so an agent that hits one can say how to repair it instead of only that it broke.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript } from "./init.ts";
import { loadMap } from "./map/load.ts";
import type { MapConfig, Result } from "./map/types.ts";
import { cliCommand } from "./version.ts";

export type Trouble = { problem: string; fix: string };

type Version = [number, number, number];

// One part of a version: a number, or undefined for `x`, `*` or a part left out.
const part = (s: string | undefined): number | undefined | null =>
  s === undefined || s === "x" || s === "*"
    ? undefined
    : /^\d+$/.test(s)
      ? Number(s)
      : null;

const parse = (text: string): Version | undefined => {
  // A prerelease or build suffix (`-rc.1`, `+sha`) doesn't change the answer here.
  const nums = text
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    ?.split(".")
    .map(part);
  if (!nums || nums.length > 3 || typeof nums[0] !== "number") return undefined;
  if (nums.some((n) => n === null)) return undefined;
  return [nums[0], nums[1] ?? 0, nums[2] ?? 0];
};

const compare = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether `v` meets one comparator (`^24.14.0`, `>=20`, `24.x`); undefined when it isn't understood. */
const meets = (v: Version, comparator: string): boolean | undefined => {
  if (comparator === "" || comparator === "*" || comparator === "x")
    return true;
  const op = /^(\^|~|>=|<=|>|<|=)/.exec(comparator)?.[1] ?? "";
  const nums = comparator.slice(op.length).replace(/^v/, "").split(".").map(part);
  const major = nums[0];
  if (nums.length > 3 || typeof major !== "number") return undefined;
  if (nums.some((n) => n === null)) return undefined;
  const minor = nums[1] ?? undefined;
  const patch = nums[2] ?? undefined;
  const low: Version = [major, minor ?? 0, patch ?? 0];
  // The first version past a partial one: `24` ends before 25, `24.1` before 24.2.
  const next: Version =
    minor === undefined
      ? [major + 1, 0, 0]
      : patch === undefined
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1];
  const below = (top: Version) => compare(v, low) >= 0 && compare(v, top) < 0;
  switch (op) {
    case "^":
      return below(
        major > 0
          ? [major + 1, 0, 0]
          : (minor ?? 0) > 0
            ? [0, (minor ?? 0) + 1, 0]
            : next,
      );
    case "~":
      return below(minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0]);
    case ">=":
      return compare(v, low) >= 0;
    case ">":
      return compare(v, next) >= 0;
    case "<=":
      return compare(v, next) < 0;
    case "<":
      return compare(v, low) < 0;
    default:
      return below(next);
  }
};

/**
 * Whether `version` is inside a package.json `engines` range: comparators
 * joined by spaces (all must hold) and `||` (any may). Undefined when the range
 * uses syntax this doesn't read (a hyphen range, a tag), so nothing is claimed.
 */
export const satisfies = (
  version: string,
  range: string,
): boolean | undefined => {
  const v = parse(version);
  if (!v) return undefined;
  let any = false;
  for (const part of range.split("||")) {
    const comparators = part
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1")
      .split(/\s+/);
    let all = true;
    for (const c of comparators) {
      const ok = meets(v, c);
      if (ok === undefined) return undefined;
      all &&= ok;
    }
    any ||= all;
  }
  return any;
};

/** The command that switches this shell to Node `major`, for the version manager in use. */
const switchNode = (
  root: string,
  major: string,
  env: NodeJS.ProcessEnv,
): string => {
  const has = (file: string) => existsSync(join(root, file));
  if (env.MISE_SHELL || has("mise.toml") || has(".mise.toml"))
    return `\`mise use node@${major}\``;
  if (env.VOLTA_HOME) return `\`volta pin node@${major}\``;
  if (env.FNM_DIR) return `\`fnm install ${major} && fnm use ${major}\``;
  if (env.NVM_DIR) return `\`nvm install ${major} && nvm use ${major}\``;
  return `your Node version manager (\`mise use node@${major}\`, \`nvm use ${major}\` or \`fnm use ${major}\`)`;
};

const readPackage = (root: string): Record<string, unknown> | undefined => {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    return pkg && typeof pkg === "object" && !Array.isArray(pkg)
      ? (pkg as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const field = (o: unknown, key: string): unknown =>
  o && typeof o === "object" ? Reflect.get(o, key) : undefined;

/** What will make archmap's commands fail here, each with its fix. */
export const troubles = (
  root: string,
  dir: string,
  config: MapConfig,
  opts: { node?: string; env?: NodeJS.ProcessEnv } = {},
): Trouble[] => {
  const node = opts.node ?? process.versions.node;
  const env = opts.env ?? process.env;
  const cli = cliCommand(config, dir, root);
  const out: Trouble[] = [];
  if (satisfies(node, ">=24") === false)
    out.push({
      problem: `This shell runs Node ${node}; archmap needs Node 24 or later.`,
      fix: `Switch with ${switchNode(root, "24", env)}.`,
    });
  const pkg = readPackage(root);
  if (!pkg) return out;
  const run = runScript(root, pkg);
  const range = field(field(pkg, "engines"), "node");
  if (typeof range === "string" && satisfies(node, range) === false) {
    const major = /\d+/.exec(range)?.[0] ?? "24";
    out.push({
      problem: `This shell runs Node ${node}, but package.json requires Node ${range}. The package manager may refuse to run any script, so \`${run} archmap\` and hooks that run scripts (lint on save, pre-commit) fail. The map files themselves are not affected.`,
      fix: `Switch this shell to a Node that matches with ${switchNode(root, major, env)}, then run the command again. Until then, start the map without the package manager: \`${cli} dev\`.`,
    });
  }
  const script: unknown = field(field(pkg, "scripts"), "archmap");
  if (script === undefined)
    out.push({
      problem: `package.json has no \`archmap\` script, so \`${run} archmap\` doesn't start the map.`,
      fix: `Run \`${cli} init\`: it adds the script and changes nothing else that is already set up.`,
    });
  else if (
    typeof script === "string" &&
    script.includes("archmap") &&
    script !== `${cli} dev`
  )
    out.push({
      problem: `The \`archmap\` script in package.json runs \`${script}\`, not the archmap this map is set to use (\`${cli} dev\`).`,
      fix: `Run \`${cli} init\` to update it.`,
    });
  return out;
};

/** Each trouble as the lines a person or an agent reads. */
export const troubleLines = (list: Trouble[]): string[] =>
  list.flatMap((t) => [`- ${t.problem}`, `  Fix: ${t.fix}`]);

export const doctor = (root: string, dir: string): Result => {
  if (!existsSync(join(dir, "archmap.config.json")))
    return {
      ok: false,
      lines: [
        "- There is no map here yet (no archmap.config.json).",
        "  Fix: run `init` in the project's root folder.",
      ],
    };
  const list = troubles(root, dir, loadMap(dir).config);
  return list.length
    ? { ok: false, lines: troubleLines(list) }
    : { ok: true, lines: ["Nothing to fix: archmap can run here."] };
};
