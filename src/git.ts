// Git helpers: what changed since a base ref, and what is dirty right now.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

const gitError = (err: unknown): string => {
  const e = err as Error & { stderr?: string };
  return (e.stderr?.trim() || e.message).trim();
};

/** The top level of the repository holding `cwd`, or null outside one. */
export const repoRoot = (cwd: string): string | null => {
  try {
    return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return null;
  }
};

const resolves = (root: string, ref: string): boolean => {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * The ref to compare with: `base` itself, or `origin/<base>` when only the
 * remote branch exists (a CI checkout often has no local branch).
 */
export const resolveBase = (root: string, base: string): string =>
  !resolves(root, base) && resolves(root, `origin/${base}`)
    ? `origin/${base}`
    : base;

/** The branch pull requests target when the config names none: the one origin/HEAD names, else main. */
export const defaultBase = (root: string): string => {
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

/** Files changed since `base`: committed (base...HEAD), staged, unstaged and untracked, relative to `root`. */
export const changedFiles = (root: string, name: string): string[] => {
  const fail = (detail: string, cause?: unknown): never => {
    throw new Error(`Can't compare with ${name}: ${detail}`, { cause });
  };
  if (repoRoot(root) === null)
    return fail("not a git repository (or git isn't installed)");
  const base = resolveBase(root, name);
  if (!resolves(root, base)) {
    const guess = ["origin/HEAD", "origin/main", "main", "master"].find((r) =>
      resolves(root, r),
    );
    return fail(
      `no such branch or commit.${guess ? ` Try ${guess}` : ""}`.trim(),
    );
  }
  try {
    return [
      ...new Set([
        ...lines(
          git(root, [
            "diff",
            "--name-only",
            "--no-renames",
            "--relative",
            `${base}...HEAD`,
          ]),
        ),
        ...uncommittedFiles(root),
      ]),
    ].sort();
  } catch (err) {
    return fail(gitError(err), err);
  }
};

/** Files that differ from HEAD (staged or not) or are untracked, relative to `root`. */
export const uncommittedFiles = (root: string): string[] => [
  ...new Set([
    ...lines(
      git(root, ["diff", "--name-only", "--no-renames", "--relative", "HEAD"]),
    ),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
  ]),
];

export type Commit = { message: string; files: string[] };

/** The commits in `base..HEAD`, oldest first, with their messages and the files each touched (relative to `root`). */
export const commitsSince = (root: string, base: string): Commit[] => {
  const parts = git(root, [
    "log",
    "--reverse",
    "--no-renames",
    "--relative",
    "--name-only",
    "--format=%x00%H%x00%B%x00",
    `${base}..HEAD`,
  ]).split("\0");
  const out: Commit[] = [];
  // parts: "", then (hash, message, files) per commit.
  for (let i = 1; i + 1 < parts.length; i += 3)
    out.push({
      message: parts.at(i + 1) ?? "",
      files: lines(parts.at(i + 2) ?? ""),
    });
  return out;
};

/** The commit messages in `base..HEAD`. */
export const commitMessages = (root: string, base: string): string =>
  git(root, ["log", `${base}..HEAD`, "--format=%B"]);

/** A file's contents at `ref`, or null when it isn't there. */
export const fileAt = (
  root: string,
  ref: string,
  path: string,
): string | null => {
  try {
    return git(root, ["show", `${ref}:./${path}`]);
  } catch {
    return null;
  }
};

/**
 * The files under `root` at `ref` that `keep` accepts, with their contents, read
 * in one `git cat-file --batch` call. Paths are relative to `root`.
 */
export const filesAt = (
  root: string,
  ref: string,
  keep: (path: string) => boolean,
): Map<string, Buffer> => {
  const out = new Map<string, Buffer>();
  const paths = git(root, ["ls-tree", "-r", "-z", "--name-only", ref])
    .split("\0")
    .filter((p) => p && !p.includes("\n") && keep(p));
  if (!paths.length) return out;
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: paths.map((p) => `${ref}:./${p}\n`).join(""),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  let at = 0;
  for (const path of paths) {
    const eol = batch.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = batch.subarray(at, eol).toString("utf8").split(" ");
    at = eol + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") out.set(path, batch.subarray(at, at + size));
    at += size + 1;
  }
  return out;
};

/** path -> sha1 of its contents, or "deleted". */
export type DirtyState = Map<string, string>;

/** Every file that differs from HEAD or is untracked, with a hash of what is on disk. */
export const dirtyState = (root: string): DirtyState => {
  const out = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const state: DirtyState = new Map();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts.at(i) ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy lists the old path as the next entry.
    if (status.includes("R") || status.includes("C")) {
      const old = parts.at(++i);
      if (old) state.set(old, "deleted");
    }
    const abs = join(root, path);
    state.set(
      path,
      existsSync(abs) && statSync(abs).isFile()
        ? createHash("sha1").update(readFileSync(abs)).digest("hex")
        : "deleted",
    );
  }
  return state;
};
