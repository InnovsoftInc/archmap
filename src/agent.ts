// `archmap agent`: run the project's AI agent with the brief, keep only its map edits, and check the map.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";
import { brief } from "./brief.ts";
import type { Task } from "./brief.ts";
import { formatCheck, runCheck } from "./check.ts";
import { changedFiles, dirtyState } from "./git.ts";
import type { DirtyState } from "./git.ts";
import { loadMap } from "./map/load.ts";
import type { Result } from "./map/types.ts";
import { cliCommand } from "./version.ts";

const git = (root: string, args: string[]): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};

const inHead = (root: string, path: string): boolean => {
  try {
    git(root, ["cat-file", "-e", `HEAD:./${path}`]);
    return true;
  } catch {
    return false;
  }
};

/** The commit HEAD points at, or null when there is none yet. */
const headCommit = (root: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/** The map folder relative to root, with a trailing slash ("" when it is the root). */
const mapPrefix = (root: string, dir: string): string => {
  const rel = relative(resolve(root), resolve(root, dir)).split("\\").join("/");
  return rel ? `${rel}/` : "";
};

/** Quote for POSIX shells: one argument, whatever it contains. */
const shellQuote = (text: string): string =>
  `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Put back every path outside the map that the agent changed and that was clean before it ran.
 * Paths that already had the developer's uncommitted changes are left alone, with a warning
 * when the agent touched them.
 */
const keepOnlyMapEdits = (
  root: string,
  prefix: string,
  before: DirtyState,
  after: DirtyState,
): string[] => {
  const warnings: string[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    if (prefix === "" || path.startsWith(prefix)) continue;
    if (before.get(path) === after.get(path)) continue;
    if (before.has(path)) {
      warnings.push(
        `The agent changed ${path}, which had your uncommitted changes; review it.`,
      );
      continue;
    }
    // Clean before the run, so HEAD holds exactly what was there.
    if (inHead(root, path)) git(root, ["checkout", "HEAD", "--", path]);
    else {
      git(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
      rmSync(join(root, path), { force: true });
    }
  }
  return warnings;
};

/** The first line of `<dir>/.no-change`, deleting the file; null when there is none. */
const takeNoChange = (dir: string): string | null => {
  const file = join(dir, ".no-change");
  if (!existsSync(file)) return null;
  const reason = readFileSync(file, "utf8").split(/\r?\n/)[0]?.trim() ?? "";
  rmSync(file, { force: true });
  return reason;
};

export const runAgent = (
  root: string,
  dir: string,
  opts: { task?: Task; base?: string },
): Result => {
  const config = loadMap(dir).config;
  const agent = config.agent;
  // `{cli}` is filled in now, so a `cli` set after init takes effect.
  const command = agent?.command
    ?.trim()
    .replaceAll("{cli}", () => cliCommand(config, dir, root));
  if (!command)
    return {
      ok: false,
      lines: [
        'Set agent.command in archmap.config.json (for example "claude -p").',
      ],
    };

  if (opts.base) {
    const skip = agent?.skip ?? [];
    const changed = changedFiles(root, opts.base);
    if (!changed.length)
      return {
        ok: true,
        lines: [`No files changed since ${opts.base}; nothing to map.`],
      };
    if (changed.every((f) => skip.some((g) => matchesGlob(f, g))))
      return {
        ok: true,
        lines: ["Only skipped files changed; nothing to map."],
      };
  }

  // A .no-change left from an earlier run must not answer for this one.
  rmSync(join(dir, ".no-change"), { force: true });
  const text = brief(root, dir, { ...opts, forAgent: true });
  const head = headCommit(root);
  const before = dirtyState(root);
  const substituted = command.includes("{brief}");
  const run = spawnSync(
    substituted
      ? command.replaceAll("{brief}", () => shellQuote(text))
      : command,
    {
      shell: true,
      cwd: root,
      input: substituted ? undefined : text,
      stdio: [substituted ? "ignore" : "pipe", "inherit", "inherit"],
    },
  );
  // Commits the agent made are undone, keeping their changes in the working tree, so
  // the same rule (only map edits stay) covers committed and uncommitted edits.
  const committed = head !== null && headCommit(root) !== head;
  if (committed && head) git(root, ["reset", "-q", "--soft", head]);
  const lines = keepOnlyMapEdits(
    root,
    mapPrefix(root, dir),
    before,
    dirtyState(root),
  );
  if (committed)
    lines.push(
      "The agent made commits; they were undone and only map edits kept.",
    );

  if (run.error || run.status !== 0) {
    rmSync(join(dir, ".no-change"), { force: true });
    const code = run.status ?? run.signal ?? run.error?.message ?? "unknown";
    return {
      ok: false,
      lines: [
        ...lines,
        `Agent command exited ${code}; nothing kept outside the map.`,
      ],
    };
  }

  const reason = takeNoChange(dir);
  const result = formatCheck(runCheck(root, dir), {});
  return {
    ok: result.ok,
    lines: [
      ...lines,
      ...result.lines,
      ...(reason !== null ? [`No map change: ${reason}`] : []),
    ],
  };
};
