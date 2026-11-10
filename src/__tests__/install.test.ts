import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_REPO, VERSION } from "../home.ts";
import type { Run } from "../claude.ts";
import { install } from "../install.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  mkdirSync(join(root, ".git"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, [".archmap/bin/archmap.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });

// Every install test passes a fake `run`, so none touches the real Claude config.
const fakeRun = () => {
  const calls: [string, string[]][] = [];
  const seen: boolean[] = [];
  const run: Run = (cmd, args) => {
    calls.push([cmd, args]);
    seen.push(existsSync(join(root, ".archmap", "bin", "archmap.mjs")));
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls, seen };
};

describe("install", () => {
  it("copies the package into .archmap", () => {
    const r = install(root, { run: fakeRun().run });
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe(`Copied archmap ${VERSION} into .archmap/.`);
    for (const file of [
      "bin/archmap.mjs",
      "plugin/.claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "viewer/index.html",
      "src/cli.ts",
    ])
      expect({ file, there: existsSync(join(root, ".archmap", file)) }).toEqual(
        {
          file,
          there: true,
        },
      );
    expect(existsSync(join(root, ".archmap", "src", "__tests__"))).toBe(false);
  });

  it("writes VERSION and a minimal package.json", () => {
    install(root, { run: fakeRun().run });
    expect(readFileSync(join(root, ".archmap", "VERSION"), "utf8")).toBe(
      `${VERSION}\n`,
    );
    expect(
      JSON.parse(readFileSync(join(root, ".archmap", "package.json"), "utf8")),
    ).toEqual({
      name: "@tttstudios/archmap",
      version: VERSION,
      type: "module",
      repository: { type: "git", url: `https://github.com/${HOME_REPO}` },
    });
  });

  it("the copied CLI runs", () => {
    install(root, { run: fakeRun().run });
    expect(run("init", "--name", "T").status).toBe(0);
    expect(run("check").status).toBe(0);
  });

  it("replaces an older copy", () => {
    mkdirSync(join(root, ".archmap"));
    writeFileSync(join(root, ".archmap", "stale.txt"), "old");
    install(root, { run: fakeRun().run });
    expect(existsSync(join(root, ".archmap", "stale.txt"))).toBe(false);
  });

  it("stops without .git", () => {
    rmSync(join(root, ".git"), { recursive: true });
    const r = install(root, { run: fakeRun().run });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe(
      "Run this from the project root (the folder with .git).",
    );
    expect(existsSync(join(root, ".archmap"))).toBe(false);
  });

  it("accepts a worktree's .git file", () => {
    rmSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: x");
    expect(install(root, { run: fakeRun().run }).ok).toBe(true);
  });

  it("refuses to install over itself", () => {
    install(root, { run: fakeRun().run });
    const r = install(root, {
      packageRoot: join(root, ".archmap"),
      run: fakeRun().run,
    });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe(
      "Run install through npx from the home repo; see `archmap upgrade`.",
    );
    expect(existsSync(join(root, ".archmap", "bin", "archmap.mjs"))).toBe(true);
  });

  it("adds the gitattributes line once", () => {
    const { run } = fakeRun();
    install(root, { run });
    install(root, { run });
    const text = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(text.split(".archmap/** linguist-vendored -diff").length - 1).toBe(
      1,
    );
  });

  it("appends after a file with no trailing newline", () => {
    writeFileSync(join(root, ".gitattributes"), "*.png binary");
    install(root, { run: fakeRun().run });
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(
      "*.png binary\n.archmap/** linguist-vendored -diff\n",
    );
  });

  it("adds the AGENTS.md pointer once", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nBe kind.\n");
    const { run } = fakeRun();
    install(root, { run });
    install(root, { run });
    const text = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Agents\n\nBe kind.\n")).toBe(true);
    for (const needle of [
      "architecture/instructions.md",
      "node .archmap/bin/archmap.mjs check",
      "node .archmap/bin/archmap.mjs claude",
    ])
      expect(text.split(needle).length - 1).toBe(1);
  });

  it("starts a new AGENTS.md with a heading", () => {
    install(root, { run: fakeRun().run });
    const text = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Agent notes\n\n- Architecture map: ")).toBe(true);
    expect(text.split("# Agent notes").length - 1).toBe(1);
  });

  it("an existing AGENTS.md gets only the bullet", () => {
    writeFileSync(join(root, "AGENTS.md"), "Be kind.\n");
    install(root, { run: fakeRun().run });
    const text = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(text).not.toContain("# Agent notes");
    expect(text.startsWith("Be kind.\n- Architecture map: ")).toBe(true);
  });

  it("doesn't duplicate lines in a CRLF file", () => {
    writeFileSync(
      join(root, ".gitattributes"),
      "*.png binary\r\n.archmap/** linguist-vendored -diff\r\n",
    );
    install(root, { run: fakeRun().run });
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(
      "*.png binary\r\n.archmap/** linguist-vendored -diff\r\n",
    );
  });

  it("never writes .claude/settings.json", () => {
    install(root, { run: fakeRun().run });
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
  });

  it("connects Claude Code last", () => {
    const { run, seen } = fakeRun();
    install(root, { run });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("ends with the next step", () => {
    const r = install(root, { run: fakeRun().run });
    expect(r.lines.at(-1)).toBe(
      "Next: open Claude Code here and run /archmap:setup. Teammates run node .archmap/bin/archmap.mjs claude once after cloning.",
    );
  });
});
