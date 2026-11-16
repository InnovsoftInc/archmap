import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  commitsSince,
  dirtyState,
  fileAt,
  repoRoot,
  resolveBase,
  uncommittedFiles,
} from "../git.ts";

let root: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-git-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  write("a.txt", "a\n");
  write("b.txt", "b\n");
  write("c.txt", "c\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("git helpers", () => {
  it("changedFiles lists committed, staged, unstaged and untracked changes since base", () => {
    write("committed.txt", "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "more\n\nArchmap: none - tidy");
    write("a.txt", "changed\n");
    git("add", "a.txt");
    write("b.txt", "changed\n");
    write("sub/new.txt", "new\n");
    expect(changedFiles(root, "main~1")).toEqual([
      "a.txt",
      "b.txt",
      "committed.txt",
      "sub/new.txt",
    ]);
  });

  it("names the ref when it is unknown", () => {
    expect(() => changedFiles(root, "nope")).toThrow(
      "Can't compare with nope: no such branch or commit. Try main",
    );
    git("branch", "-m", "work");
    expect(() => changedFiles(root, "nope")).toThrow(
      "Can't compare with nope: no such branch or commit.",
    );
  });

  it("keeps git's own message outside a repository", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "archmap-no-git-")),
    );
    try {
      expect(() => changedFiles(outside, "main")).toThrow(
        /not a git repository/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("dirtyState records hashes of modified and untracked files", () => {
    write("a.txt", "changed\n");
    write("sub/new.txt", "new\n");
    rmSync(join(root, "c.txt"));
    const state = dirtyState(root);
    expect([...state.keys()].sort()).toEqual(["a.txt", "c.txt", "sub/new.txt"]);
    expect(state.get("c.txt")).toBe("deleted");
    expect(state.get("a.txt")).toMatch(/^[0-9a-f]{40}$/);
    const before = state.get("a.txt");
    write("a.txt", "changed again\n");
    expect(dirtyState(root).get("a.txt")).not.toBe(before);
  });

  it("repoRoot finds the top level, or null outside a repo", () => {
    expect(repoRoot(join(root, "sub-not-yet"))).toBeNull();
    mkdirSync(join(root, "sub"));
    expect(repoRoot(join(root, "sub"))).toBe(root);
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "archmap-no-git-")),
    );
    try {
      expect(repoRoot(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fileAt reads a file at a ref, or null when absent", () => {
    write("a.txt", "changed\n");
    expect(fileAt(root, "HEAD", "a.txt")).toBe("a\n");
    expect(fileAt(root, "HEAD", "missing.txt")).toBeNull();
  });
  it("lists non-ASCII and odd paths as they are, not C-quoted", () => {
    write("src/café.ts", "x\n");
    write('src/a "quoted" name.ts', "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "accents\n\nbody");
    git("commit", "-q", "--allow-empty", "-m", "empty");
    write("src/naïve.ts", "x\n");
    write("über.txt", "x\n");
    git("add", "über.txt");
    expect(uncommittedFiles(root).sort()).toEqual(["src/naïve.ts", "über.txt"]);
    expect(changedFiles(root, "main~2")).toEqual([
      'src/a "quoted" name.ts',
      "src/café.ts",
      "src/naïve.ts",
      "über.txt",
    ]);
    expect(commitsSince(root, "main~2")).toEqual([
      {
        message: "accents\n\nbody\n",
        files: ['src/a "quoted" name.ts', "src/café.ts"],
      },
      { message: "empty\n", files: [] },
    ]);
  });

  it("resolveBase prefers origin/<base> over a stale local branch", () => {
    expect(resolveBase(root, "main")).toBe("main");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    write("d.txt", "d\n");
    git("add", ".");
    git("commit", "-q", "-m", "local only");
    expect(resolveBase(root, "main")).toBe("origin/main");
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    expect(resolveBase(root, "dev")).toBe("origin/dev");
    // A ref that isn't a branch name is used as given.
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(resolveBase(root, "HEAD")).toBe("HEAD");
    expect(resolveBase(root, "main~1")).toBe("main~1");
    expect(resolveBase(root, "nope")).toBe("nope");
  });
});
