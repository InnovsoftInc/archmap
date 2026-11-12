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
  commitMessages,
  dirtyState,
  fileAt,
  repoRoot,
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
    expect(commitMessages(root, "main~1")).toContain("Archmap: none - tidy");
  });

  it("names the ref when it is unknown", () => {
    expect(() => changedFiles(root, "nope")).toThrow(/Can't compare with nope/);
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
});
