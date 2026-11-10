import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkgRoot = join(import.meta.dirname, "..", "..");

let tmp: string;
let cli: string;
let project: string;
// The project's own copy of the CLI, relative to the project.
const mine = join(".archmap", "bin", "archmap.mjs");

const must = (r: { status: number | null; stderr: string }, what: string) => {
  if (r.status !== 0)
    throw new Error(`${what} failed (${r.status}): ${r.stderr}`);
};

const sh = (cmd: string, args: string[], cwd: string, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// The whole one-step install, end to end: pack the package, install the
// tarball somewhere else (as `npx github:` would), run its `install` in a
// fresh project, then use the copy in .archmap/. Node refuses to strip types
// under node_modules, so this also proves the CLI runs once installed. The
// setup spawns run in beforeAll (120 s); each test spawns at most one CLI, so
// it stays well inside the 5 s test timeout on a busy machine.
describe("install end to end", () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
    const packed = sh(
      "npm",
      ["pack", "--pack-destination", tmp, "--silent"],
      pkgRoot,
    );
    must(packed, "npm pack");
    const tarball = join(tmp, packed.stdout.trim().split("\n").pop() ?? "");
    const from = join(tmp, "install-from");
    mkdirSync(from);
    must(sh("npm", ["init", "-y"], from), "npm init");
    const installed = sh(
      "npm",
      ["install", "--no-audit", "--no-fund", tarball],
      from,
    );
    must(installed, "npm install");
    cli = join(
      from,
      "node_modules",
      "@tttstudios",
      "archmap",
      "bin",
      "archmap.mjs",
    );

    // The project: install from the packed copy, then init and build with
    // the project's own copy. These only set up state, so they run here and
    // the tests below only assert. No `claude` on PATH: install must not
    // touch real Claude config, and a missing claude is not an error.
    project = join(tmp, "project");
    mkdirSync(project);
    must(sh("git", ["init", "-q"], project), "git init");
    const env = { ...process.env, PATH: dirname(process.execPath) };
    const node = (args: string[], what: string) =>
      must(sh(process.execPath, args, project, env), what);
    node([cli, "install"], "install");
    node([mine, "init", "--name", "T"], "init");
    node([mine, "build", "--out", "site"], "build");
  }, 120_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("install copies archmap into .archmap/", () => {
    expect(existsSync(join(project, ".archmap", "bin", "archmap.mjs"))).toBe(
      true,
    );
    expect(readdirSync(join(project, ".archmap"))).toContain("VERSION");
  });

  it("check runs from .archmap/ on the map init created", () => {
    const r = sh(process.execPath, [mine, "check"], project);
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(r.stdout).toMatch(/^OK: 1 saves/);
  });

  it("build from .archmap/ wrote the site", () => {
    for (const f of ["index.html", "app.js", "styles.css"])
      expect(existsSync(join(project, "site", f))).toBe(true);
    expect(readFileSync(join(project, "site", "data.json"), "utf8")).toContain(
      '"name":"T"',
    );
  });
});
