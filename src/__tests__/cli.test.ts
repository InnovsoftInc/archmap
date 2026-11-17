import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "..", "bin", "archmap.mjs");

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const run = (args: string[], cwd = root) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-cli-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SERVICE =
  "---\nname: X\nstatus: live\nkind: api\n---\nDoes x.\n\n## How it works\n\nx\n\n## For developers\n\nx\n";

const REMOVED = ["install", "claude", "save", "publish", "drift"];

const COMMANDS = [
  "init",
  "scan",
  "check",
  "brief",
  "agent",
  "dev",
  "build",
  "migrate",
  "upgrade",
  "doctor",
];

describe("archmap CLI", () => {
  it("--help lists the commands and none of the removed ones", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    const listed = (name: string) =>
      r.stdout.split("\n").some((l) => l.startsWith(`  ${name}`));
    for (const c of COMMANDS) expect(listed(c)).toBe(true);
    for (const gone of REMOVED) expect(listed(gone)).toBe(false);
  });

  it("an unknown command exits 1", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command "frobnicate"');
  });

  it("init, then check passes with Map OK.", () => {
    expect(run(["init", "--name", "T"]).status).toBe(0);
    const r = run(["check"]);
    expect(r.stdout).toContain("Map OK.");
    expect(r.status).toBe(0);
  });

  it("scan prints one key (`scan:<kind>:<name>@<file>`) per lead, or JSON", () => {
    cpSync(
      join(import.meta.dirname, "fixtures", "scan", "express-prisma"),
      root,
      {
        recursive: true,
      },
    );
    const r = run(["scan"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe("");
    const j = run(["scan", "--json"]);
    const leads = JSON.parse(j.stdout) as { key: string; file: string }[];
    expect(r.stdout.trim().split("\n")).toEqual(leads.map((l) => l.key));
    expect(leads.every((l) => l.key.endsWith(`@${l.file}`))).toBe(true);
  });

  it("a bad --base prints the message, exits 1 and shows no stack", () => {
    run(["init", "--name", "T"]);
    write("architecture/services/x.md", SERVICE);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    for (const cmd of ["brief", "check"]) {
      const r = run([cmd, "--base", "nope"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("nope");
      expect(r.stderr).not.toMatch(/^\s+at /m);
    }
  });

  it("outside a git repo, brief --base exits 1 with a message", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "archmap-plain-")));
    try {
      writeFileSync(join(plain, "package.json"), '{"name":"p"}');
      const r = run(["brief", "--task", "update", "--base", "main"], plain);
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).not.toBe("");
      expect(r.stderr).not.toMatch(/^\s+at /m);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("warns on stderr when the config pins another version", () => {
    write(
      "architecture/archmap.config.json",
      JSON.stringify({ name: "T", archmap: "0.0.1" }),
    );
    const r = run(["check"]);
    expect(r.stderr).toContain("pins 0.0.1");
    expect(run(["scan"]).stderr).not.toContain("pins 0.0.1");
  });

  it("check --json writes the JSON to stdout even when it fails", () => {
    write("architecture/archmap.config.json", JSON.stringify({ name: "T" }));
    write("architecture/services/bad.md", "---\nstatus: nope\n---\nx\n");
    const r = run(["check", "--json"]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as { errors: unknown[] };
    expect(out.errors.length).toBeGreaterThan(0);
    expect(r.stderr).toBe("");
  });

  it("brief prints the brief to stdout", () => {
    run(["init", "--name", "T"]);
    const r = run(["brief", "--task", "setup"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("# archmap brief: setup");
  });

  it("build --public wires public into the site data", () => {
    run(["init", "--name", "T"]);
    expect(run(["build", "--out", "site", "--public"]).status).toBe(0);
    expect(existsSync(join(root, "site", "data.json"))).toBe(true);
    const plain = run(["build", "--out", "site2"]);
    expect(plain.status).toBe(0);
    expect(readFileSync(join(root, "site", "data.json"), "utf8")).not.toBe(
      readFileSync(join(root, "site2", "data.json"), "utf8"),
    );
  });

  it("agent keeps its map edits when run from a symlinked cwd", () => {
    const stub = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require("fs").mkdirSync("architecture/services",{recursive:true});require("fs").writeFileSync("architecture/services/x.md","---\\nname: X\\nstatus: live\\nkind: api\\n---\\nDoes x.\\n\\n## How it works\\n\\nx\\n\\n## For developers\\n\\nx\\n")`,
    )}`;
    write(
      "architecture/archmap.config.json",
      JSON.stringify({ name: "T", agent: { command: stub } }),
    );
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      const r = run(["agent"], link);
      expect(r.stderr).toBe("");
      expect(existsSync(join(root, "architecture", "services", "x.md"))).toBe(
        true,
      );
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("dev on a port in use says so and exits 1", async () => {
    expect(run(["init", "--name", "T"]).status).toBe(0);
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const port = (blocker.address() as { port: number }).port;
    try {
      const r = spawnSync(process.execPath, [BIN, "dev", "--port", String(port)], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe(
        `Port ${port} is in use. Try --port ${port + 1}.`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
