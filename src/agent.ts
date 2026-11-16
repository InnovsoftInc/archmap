// `archmap agent`: run the project's AI agent with the brief, keep only its map edits, and check the map.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brief } from "./brief.ts";
import type { Task } from "./brief.ts";
import { formatCheck, runCheck } from "./check.ts";
import { changedFiles, dirtyState } from "./git.ts";
import type { DirtyState } from "./git.ts";
import { loadMap } from "./map/load.ts";
import type { Result } from "./map/types.ts";
import { globsMatcher, isObj, mapPrefix } from "./util.ts";
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

const gitOut = (root: string, args: string[]): string | null => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/** The branch HEAD is on (`refs/heads/<name>`), or null when it is detached. */
const headRef = (root: string): string | null =>
  gitOut(root, ["symbolic-ref", "-q", "HEAD"]) || null;

const branchName = (ref: string | null): string =>
  ref ? ref.replace(/^refs\/heads\//, "") : "a detached HEAD";

/**
 * Put HEAD back where it was before the agent ran: on the same branch (or detached at the
 * same commit), with that branch at the same commit. Only HEAD and that branch move; the
 * index and working tree keep whatever the agent left, so its edits, committed or not,
 * on any branch, are there for keepOnlyMapEdits. Commits the agent made on another
 * branch stay on it.
 */
const restoreHead = (
  root: string,
  ref: string | null,
  head: string,
): string[] => {
  const lines: string[] = [];
  const nowRef = headRef(root);
  const nowHead = headCommit(root);
  const newCommits =
    nowHead !== null &&
    gitOut(root, ["rev-list", "--count", `${head}..${nowHead}`]) !== "0";
  if (nowRef !== ref) {
    try {
      if (ref) {
        if (gitOut(root, ["rev-parse", "--verify", "-q", ref]) === null) {
          git(root, ["update-ref", ref, head]);
          lines.push(
            `The agent deleted the branch ${branchName(ref)}; it was put back at ${head.slice(0, 12)}.`,
          );
        }
        git(root, ["symbolic-ref", "HEAD", ref]);
      } else git(root, ["update-ref", "--no-deref", "HEAD", head]);
    } catch (err) {
      throw new Error(
        `The agent switched from ${branchName(ref)} to ${branchName(nowRef)}, and switching back failed: ${(err as Error).message}. ` +
          `Run "git switch ${ref ? branchName(ref) : `--detach ${head}`}" yourself and review the working tree.`,
        { cause: err },
      );
    }
    lines.push(
      `The agent switched from ${branchName(ref)} to ${branchName(nowRef)}; switched back${nowRef && newCommits ? `, and its commits stay on ${branchName(nowRef)}` : ""}.`,
    );
  }
  if (headCommit(root) !== head) {
    git(root, ["reset", "-q", "--soft", head]);
    lines.push(
      "The agent made commits; they were undone and only map edits kept.",
    );
  }
  return lines;
};

// Config keys that choose what runs later (in CI, by `archmap agent`): an
// agent must not change them, or a prompt injected into the code it reads
// could pick the next command to run.
const PROTECTED: [string, ...string[]][] = [
  ["archmap"],
  ["cli"],
  ["agent", "command"],
];

const parseJson = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
};

const readOrNull = (file: string): string | null =>
  existsSync(file) ? readFileSync(file, "utf8") : null;

const getPath = (o: Record<string, unknown>, keys: string[]): unknown => {
  let v: unknown = o;
  for (const k of keys) v = isObj(v) ? Reflect.get(v, k) : undefined;
  return v;
};

const setPath = (
  o: Record<string, unknown>,
  keys: [string, ...string[]],
  value: unknown,
): void => {
  const last = keys.at(-1) ?? keys[0];
  let at = o;
  for (const k of keys.slice(0, -1)) {
    let next: unknown = Reflect.get(at, k);
    if (!isObj(next)) {
      if (value === undefined) return;
      next = {};
      Reflect.set(at, k, next);
    }
    at = next as Record<string, unknown>;
  }
  if (value === undefined) Reflect.deleteProperty(at, last);
  else Reflect.set(at, last, value);
};

/** Put back the protected keys of archmap.config.json the agent changed, keeping its other edits. */
const restoreConfig = (file: string, before: string | null): string[] => {
  const after = readOrNull(file);
  if (after === before) return [];
  const old = parseJson(before);
  const now = parseJson(after);
  const changed = PROTECTED.filter(
    (keys) =>
      JSON.stringify(getPath(old ?? {}, keys)) !==
      JSON.stringify(getPath(now ?? {}, keys)),
  );
  if (before !== null && (old === null || now === null)) {
    // Unreadable before or after: the keys can't be compared, so the whole file goes back.
    writeFileSync(file, before);
    return [
      "WARNING: the agent made archmap.config.json unreadable or replaced an unreadable one; it was put back as it was.",
    ];
  }
  if (!changed.length || now === null) return [];
  for (const keys of changed) setPath(now, keys, getPath(old ?? {}, keys));
  writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
  return [
    `WARNING: the agent changed ${changed.map((k) => k.join(".")).join(", ")} in archmap.config.json; put back as it was. Change these yourself if you meant to.`,
  ];
};

/** What git runs on its own: .git/config (aliases, core.fsmonitor, core.hooksPath) and the hooks. */
type GitSnapshot = {
  config: string;
  configText: Buffer | null;
  hooks: string;
  hookFiles: Map<string, Buffer>;
};

const snapshotGit = (root: string): GitSnapshot | null => {
  const common = gitOut(root, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  const gitDir = resolve(root, common);
  const config = join(gitDir, "config");
  const hooks = join(gitDir, "hooks");
  const hookFiles = new Map<string, Buffer>();
  if (existsSync(hooks))
    for (const name of readdirSync(hooks)) {
      const abs = join(hooks, name);
      if (statSync(abs).isFile()) hookFiles.set(name, readFileSync(abs));
    }
  return {
    config,
    configText: existsSync(config) ? readFileSync(config) : null,
    hooks,
    hookFiles,
  };
};

const sameBytes = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null || b === null
    ? a === b
    : createHash("sha1").update(a).digest("hex") ===
      createHash("sha1").update(b).digest("hex");

/**
 * Undo the agent's changes to .git/config and .git/hooks, which git status can't see and
 * which would run commands on the next git call. Runs before any other git command.
 */
const restoreGit = (before: GitSnapshot | null, root: string): string[] => {
  if (!before) return [];
  const now = snapshotGit(root);
  if (!now) return [];
  const changed: string[] = [];
  if (!sameBytes(before.configText, now.configText)) {
    if (before.configText) writeFileSync(before.config, before.configText);
    else rmSync(before.config, { force: true });
    changed.push(".git/config");
  }
  for (const [name, text] of now.hookFiles) {
    const old = before.hookFiles.get(name);
    if (old && sameBytes(old, text)) continue;
    if (old) writeFileSync(join(before.hooks, name), old);
    else rmSync(join(before.hooks, name), { force: true });
    changed.push(`.git/hooks/${name}`);
  }
  for (const [name, text] of before.hookFiles)
    if (!now.hookFiles.has(name)) {
      writeFileSync(join(before.hooks, name), text, { mode: 0o755 });
      changed.push(`.git/hooks/${name}`);
    }
  return changed.length
    ? [
        `WARNING: the agent changed ${changed.join(", ")}, which git runs commands from; put back as they were. Check the agent's output and what it read: this can be a prompt injection.`,
      ]
    : [];
};

// Linux limits one argument to 128 KiB; the brief goes in one sh -c argument.
const MAX_BRIEF_ARG = 100 * 1024;

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
    const skipped = globsMatcher(agent?.skip ?? []);
    const changed = changedFiles(root, opts.base);
    if (!changed.length)
      return {
        ok: true,
        lines: [`No files changed since ${opts.base}; nothing to map.`],
      };
    if (changed.every((f) => skipped(f) !== undefined))
      return {
        ok: true,
        lines: ["Only skipped files changed; nothing to map."],
      };
  }

  // A .no-change left from an earlier run must not answer for this one.
  rmSync(join(dir, ".no-change"), { force: true });
  const text = brief(root, dir, { ...opts, forAgent: true });
  const inline = command.includes("{brief}");
  const size = Buffer.byteLength(text);
  if (inline && size > MAX_BRIEF_ARG)
    return {
      ok: false,
      lines: [
        `The brief is ${Math.ceil(size / 1024)} KB, too long to pass as one argument in place of {brief}. ` +
          "Use {brief_file} in agent.command instead: it is replaced with the path of a file holding the brief.",
      ],
    };
  const configFile = join(dir, "archmap.config.json");
  const configBefore = readOrNull(configFile);
  const gitBefore = snapshotGit(root);
  const head = headCommit(root);
  const ref = headRef(root);
  const before = dirtyState(root);
  const briefDir = command.includes("{brief_file}")
    ? mkdtempSync(join(tmpdir(), "archmap-brief-"))
    : null;
  let run: ReturnType<typeof spawnSync>;
  try {
    const briefFile = briefDir ? join(briefDir, "brief.md") : "";
    if (briefDir) writeFileSync(briefFile, text, { mode: 0o600 });
    const substituted = inline || briefDir !== null;
    // One pass, so a `{brief_file}` inside the brief's text stays as it is.
    run = spawnSync(
      command.replace(/\{brief(_file)?\}/g, (_, file?: string) =>
        shellQuote(file ? briefFile : text),
      ),
      {
        shell: true,
        cwd: root,
        input: substituted ? undefined : text,
        stdio: [substituted ? "ignore" : "pipe", "inherit", "inherit"],
      },
    );
  } finally {
    if (briefDir) rmSync(briefDir, { recursive: true, force: true });
  }
  // First, before git runs again: what git would run on its own.
  const lines = restoreGit(gitBefore, root);
  // Commits the agent made are undone, keeping their changes in the working tree, so
  // the same rule (only map edits stay) covers committed and uncommitted edits.
  let headLines: string[] = [];
  try {
    if (head !== null) headLines = restoreHead(root, ref, head);
  } catch (err) {
    return {
      ok: false,
      lines: [
        ...lines,
        ...restoreConfig(configFile, configBefore),
        (err as Error).message,
      ],
    };
  }
  lines.push(
    ...keepOnlyMapEdits(root, mapPrefix(root, dir), before, dirtyState(root)),
    ...headLines,
    ...restoreConfig(configFile, configBefore),
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
