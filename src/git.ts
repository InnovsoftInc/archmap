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

/** Files changed since `base`: committed (base...HEAD), staged, unstaged and untracked, relative to `root`. */
export const changedFiles = (root: string, base: string): string[] => {
  const fail = (detail: string, cause?: unknown): never => {
    throw new Error(`Can't compare with ${base}: ${detail}`, { cause });
  };
  if (repoRoot(root) === null)
    return fail("not a git repository (or git isn't installed)");
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
        ...lines(
          git(root, [
            "diff",
            "--name-only",
            "--no-renames",
            "--relative",
            "HEAD",
          ]),
        ),
        ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
      ]),
    ].sort();
  } catch (err) {
    return fail(gitError(err), err);
  }
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
