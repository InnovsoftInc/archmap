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

const must = (r: { status: number | null; stderr: string }, what: string) => {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr}`);
};

const sh = (cmd: string, args: string[], cwd: string, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// The whole one-step install, end to end: pack the package, install the
// tarball somewhere else (as `npx github:` would), run its `install` in a
// fresh project, then use the copy in .archmap/. Node refuses to strip
// types under node_modules, so this also proves the CLI runs once installed.
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
  }, 120_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("installs into a project, then init, check and build run from .archmap/", () => {
    const project = join(tmp, "project");
    mkdirSync(project);
    expect(sh("git", ["init", "-q"], project).status).toBe(0);
    // No `claude` on PATH: install must not touch real Claude config, and
    // a missing claude is not an error.
    const env = { ...process.env, PATH: dirname(process.execPath) };
    const run = (args: string[]) => {
      const r = sh(process.execPath, args, project, env);
      expect({ args, status: r.status, stderr: r.stderr }).toMatchObject({
        args,
        status: 0,
      });
      return r.stdout;
    };
    run([cli, "install"]);
    expect(existsSync(join(project, ".archmap", "bin", "archmap.mjs"))).toBe(
      true,
    );
    const mine = join(".archmap", "bin", "archmap.mjs");
    run([mine, "init", "--name", "T"]);
    expect(run([mine, "check"])).toMatch(/^OK: 1 saves/);
    run([mine, "build", "--out", "site"]);
    for (const f of ["index.html", "app.js", "styles.css"])
      expect(existsSync(join(project, "site", f))).toBe(true);
    expect(readFileSync(join(project, "site", "data.json"), "utf8")).toContain(
      '"name":"T"',
    );
    expect(readdirSync(join(project, ".archmap"))).toContain("VERSION");
  });
});
