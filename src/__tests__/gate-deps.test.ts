import { describe, expect, it } from "vitest";
import { gateProblems } from "../gate.ts";
import {
  root,
  dir,
  write,
  config,
  pkg,
  commit,
  problem,
  useGateRepo,
} from "./gate-repo.ts";

useGateRepo();

describe("map gate: dependencies and leads", () => {
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

});
