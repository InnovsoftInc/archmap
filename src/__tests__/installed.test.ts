import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkgRoot = join(import.meta.dirname, "..", "..");

let tmp: string;
let cli: string;
let project: string;

const must = (r: { status: number | null; stderr: string }, what: string) => {
  if (r.status !== 0)
    throw new Error(`${what} failed (${r.status}): ${r.stderr}`);
};

const sh = (cmd: string, args: string[], cwd: string, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// The package as `npx github:` runs it, end to end: pack it, install the
// tarball somewhere else, then run its `init`, `check` and `build` in a fresh
// project. Node refuses to strip types under node_modules, so this also proves
// the CLI runs once installed. The
// setup spawns run in beforeAll (120 s); each test spawns at most one CLI, so
// it stays well inside the 5 s test timeout on a busy machine.
describe("installed package end to end", () => {
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

    // The project: a git repo where the installed copy runs init, then
    // build. These only set up state, so they run here and the tests below
    // only assert.
    project = join(tmp, "project");
    mkdirSync(project);
    must(sh("git", ["init", "-q"], project), "git init");
    const node = (args: string[], what: string) =>
      must(sh(process.execPath, args, project), what);
    node([cli, "init", "--name", "T"], "init");
    node([cli, "build", "--out", "site"], "build");
  }, 120_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("init wrote the map, not a vendored copy", () => {
    expect(
      existsSync(join(project, "architecture", "archmap.config.json")),
    ).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(project, ".archmap"))).toBe(false);
  });

  it("check runs from the installed package on the map init created", () => {
    const r = sh(process.execPath, [cli, "check"], project);
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(r.stdout).toContain("Map OK.");
  });

  it("build from the installed package wrote the site", () => {
    for (const f of ["index.html", "app.js", "styles.css"])
      expect(existsSync(join(project, "site", f))).toBe(true);
    expect(readFileSync(join(project, "site", "data.json"), "utf8")).toContain(
      '"name":"T"',
    );
  });
});
