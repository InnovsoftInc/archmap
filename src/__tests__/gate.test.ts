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
import { runCheck } from "../check.ts";
import { architecturalFiles, gateProblems } from "../gate.ts";

let root: string;
const dir = () => join(root, "architecture");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const config = (extra: Record<string, unknown> = {}) =>
  write(
    "architecture/archmap.config.json",
    JSON.stringify({ name: "Test", ...extra }),
  );
const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "x",
    version: "1.0.0",
    scripts: { test: "vitest" },
    dependencies: { express: "^4.0.0" },
    ...extra,
  });
const commit = (message = "change") => {
  git("add", ".");
  git("commit", "-q", "-m", message);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-gate-")));
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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const problem = (base = "HEAD"): string =>
  gateProblems(root, dir(), base)[0]?.message ?? "";

describe("map gate", () => {
  it("passes when nothing architectural changed", () => {
    write("apps/api/src/routes.test.ts", "// test\n");
    write("README.md", "changed\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
  });

  it("fails on a changed evidence file with no map change", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    const msg = problem();
    expect(msg).toContain(
      "This branch changes the architecture but not the map:",
    );
    expect(msg).toContain(
      "  apps/api/src/routes.ts: evidence of services/api.md",
    );
    expect(msg).toContain("brief --base HEAD");
    expect(msg).toContain('add "Archmap: none - <reason>" to a commit.');
    expect(gateProblems(root, dir(), "HEAD")[0]?.file).toBe("");
  });

  it("fails on a new unconfirmed route in a changed file", () => {
    write(
      "apps/api/src/other.ts",
      'import express from "express";\nconst app = express();\napp.post("/orders", (_req, res) => res.send("ok"));\n',
    );
    expect(problem()).toContain(
      "apps/api/src/other.ts: new lead: route POST /orders",
    );
  });

  it("counts a lead that moved to another changed file as new", () => {
    const route = 'import express from "express";\nconst app = express();\napp.post("/orders", h);\n';
    write("apps/api/src/a.ts", route);
    commit("orders");
    write("apps/api/src/a.ts", "export {};\n");
    write("apps/api/src/b.ts", route);
    expect(problem()).toContain("apps/api/src/b.ts: new lead: route POST /orders");
  });

  it.each([
    "Dockerfile",
    "infra/main.tf",
    "prisma/schema.prisma",
    "db/migrations/001.sql",
    ".github/workflows/ci.yml",
  ])("fails on the structural file %s", (file) => {
    write(file, "x\n");
    expect(problem()).toContain(`${file}: structural file`);
  });

  it("fails on package.json dependency changes but not on a version or script change", () => {
    write("package.json", pkg({ version: "2.0.0", scripts: { test: "jest" } }));
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    write(
      "package.json",
      pkg({ dependencies: { express: "^4.0.0", pg: "^8" } }),
    );
    expect(problem()).toContain("package.json: dependencies changed");
  });

  it("counts package.json only when dependency names or workspaces change", () => {
    write(
      "package.json",
      pkg({
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^3" },
      }),
    );
    commit("dev deps");
    write(
      "package.json",
      pkg({
        dependencies: { express: "^5.0.0" },
        devDependencies: { vitest: "^4" },
      }),
    );
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    write(
      "package.json",
      pkg({
        dependencies: { express: "^4.18.0", pg: "^8" },
        devDependencies: { vitest: "^3" },
      }),
    );
    expect(problem()).toContain("package.json: dependencies changed");
    write(
      "package.json",
      pkg({ dependencies: {}, devDependencies: { vitest: "^3" } }),
    );
    expect(problem()).toContain("package.json: dependencies changed");
    write(
      "package.json",
      pkg({
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^3" },
        workspaces: ["apps/*"],
      }),
    );
    expect(problem()).toContain("package.json: dependencies changed");
  });

  it("passes a version-only bump in a workspace package.json with an unconfirmed app", () => {
    write("tools/lint/package.json", pkg({ name: "lint" }));
    commit("tool");
    write("tools/lint/package.json", pkg({ name: "lint", version: "9.9.9" }));
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
  });

  it("passes when a route file with an already-unconfirmed route changes without a new route", () => {
    write(
      "apps/api/src/other.ts",
      'import express from "express";\nconst app = express();\napp.post("/orders", (_req, res) => res.send("ok"));\n',
    );
    commit("orders");
    write(
      "apps/api/src/other.ts",
      'import express from "express";\nconst app = express();\n// fix\napp.post("/orders", (_req, res) => res.send("fine"));\n',
    );
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    write(
      "apps/api/src/other.ts",
      'import express from "express";\nconst app = express();\napp.post("/orders", (_req, res) => res.send("ok"));\napp.get("/orders", (_req, res) => res.send("ok"));\n',
    );
    expect(problem()).toContain("other.ts: new lead: route GET /orders");
  });

  it("fails when .env.example gains an env var, but not when only a comment changes", () => {
    write(".env.example", "# keys\nSTRIPE_API_KEY=\n");
    commit("env");
    write(".env.example", "# the keys\nSTRIPE_API_KEY=\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    write(".env.example", "# keys\nSTRIPE_API_KEY=\nSENDGRID_API_KEY=\n");
    expect(problem()).toContain(".env.example: new lead:");
  });

  it("counts a package.json missing at the base as changed", () => {
    write("apps/web/package.json", pkg());
    expect(problem()).toContain("apps/web/package.json: dependencies changed");
  });

  it("fails on a watch glob match", () => {
    config({ watch: ["apps/api/src/config/**"] });
    commit("config");
    write("apps/api/src/config/db.ts", "x\n");
    expect(problem()).toContain(
      "apps/api/src/config/db.ts: matches watch apps/api/src/config/**",
    );
  });

  it("passes when a map file changed, but not when only .no-change did", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    write("architecture/.no-change", "internal only\n");
    expect(problem()).toContain("evidence of services/api.md");
    write("architecture/services/api.md", "---\nname: API\n---\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
  });

  it("passes with an Archmap: none trailer in a commit since base", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - only a comment");
    expect(gateProblems(root, dir(), "HEAD~1")).toEqual([]);
  });

  it("does not let a trailer cover architectural changes made after it", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - only a comment");
    write("infra/main.tf", "x\n");
    commit("infra");
    expect(problem("HEAD~2")).toContain("infra/main.tf: structural file");
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map");
    expect(gateProblems(root, dir(), "HEAD~3")).toEqual([]);
  });

  it("does not let a map edit cover architectural changes made after it", () => {
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map");
    write("infra/main.tf", "x\n");
    commit("infra");
    expect(problem("HEAD~2")).toContain("infra/main.tf: structural file");
  });

  it("treats uncommitted architectural changes as the newest", () => {
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map\n\nArchmap: none - covered");
    write("infra/main.tf", "x\n");
    expect(problem("HEAD~1")).toContain("infra/main.tf: structural file");
    write("architecture/services/web.md", "---\nname: Web\n---\n");
    expect(gateProblems(root, dir(), "HEAD~1")).toEqual([]);
  });

  it("does not accept a trailer with no reason", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - ");
    expect(problem("HEAD~1")).toContain("evidence of services/api.md");
  });

  it("ignores files matching agent.skip", () => {
    config({ agent: { skip: ["apps/api/**"] } });
    commit("config");
    write("apps/api/src/routes.ts", "// changed\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    expect(architecturalFiles(root, dir(), "HEAD")).toEqual([]);
  });

  it("lists at most five files", () => {
    for (let i = 0; i < 7; i++) write(`infra/m${i}.tf`, "x\n");
    const msg = problem();
    expect(msg.match(/structural file/g)).toHaveLength(5);
    expect(msg).toContain("  …and 2 more");
  });

  it("check --base reports the gate as an error; check without --base doesn't run it", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    const withBase = runCheck(root, dir(), { base: "HEAD" });
    expect(withBase.errors.map((e) => e.message).join("\n")).toContain(
      "This branch changes the architecture but not the map:",
    );
    const without = runCheck(root, dir());
    expect(without.errors.map((e) => e.message).join("\n")).not.toContain(
      "changes the architecture",
    );
  });
});
