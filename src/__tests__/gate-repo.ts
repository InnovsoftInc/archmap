// The repo and helpers the gate tests share. The gate tests are split over
// several files so they run in parallel; each calls useGateRepo().

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { gateProblems } from "../gate.ts";

export let root: string;
export const dir = () => join(root, "architecture");

export const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
export const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
export const config = (extra: Record<string, unknown> = {}) =>
  write(
    "architecture/archmap.config.json",
    JSON.stringify({ name: "Test", ...extra }),
  );
export const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "x",
    version: "1.0.0",
    scripts: { test: "vitest" },
    dependencies: { express: "^4.0.0" },
    ...extra,
  });
export const commit = (message = "change") => {
  git("add", ".");
  git("commit", "-q", "-m", message);
};

// Building the base repo takes several git calls, so it is built once per
// test file and copied for each test.
export const useGateRepo = (): void => {
  let template = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-gate-template-")));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    config();
    write(
      "architecture/services/api.md",
      "---\nname: API\nstatus: live\nkind: api\nendpoints:\n  - route: GET /health\n    evidence: apps/api/src/routes.ts\n---\nServes requests.\n\n## How it works\n\nx\n\n## For developers\n\nx\n",
    );
    write("architecture/README.md", "# Test\n");
    write(
      "apps/api/src/routes.ts",
      'import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.send("ok"));\n',
    );
    write("package.json", pkg());
    write("README.md", "hi\n");
    commit("base");
    template = root;
  });
  afterAll(() => rmSync(template, { recursive: true, force: true }));
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-gate-")));
    cpSync(template, root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
};

export const problem = (base = "HEAD"): string =>
  gateProblems(root, dir(), base)[0]?.message ?? "";
