import { describe, expect, it } from "vitest";
import { runCheck } from "../check.ts";
import { gateProblems } from "../gate.ts";
import {
  root,
  dir,
  git,
  write,
  commit,
  config,
  problem,
  useGateRepo,
} from "./gate-repo.ts";

useGateRepo();

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

  describe("with mounted routers", () => {
    const mounted = (routes: string) => {
      write(
        "apps/api/src/app.ts",
        'import express from "express";\nimport { apiRouter } from "./routes/index.js";\nconst app = express();\napp.use("/api/v1", apiRouter);\n',
      );
      write(
        "apps/api/src/routes/index.ts",
        'import { Router } from "express";\nimport { permitsRouter } from "./permits.js";\nexport const apiRouter = Router();\napiRouter.use("/permits", permitsRouter);\n',
      );
      write(
        "apps/api/src/routes/permits.ts",
        `import { Router } from "express";\nexport const permitsRouter = Router();\n${routes}`,
      );
    };

    it("passes a trivial edit to a mounted router whose routes already existed", () => {
      mounted('permitsRouter.get("/", h);\n');
      commit("permits\n\nArchmap: none - test setup");
      write(
        "apps/api/src/routes/permits.ts",
        'import { Router } from "express";\nexport const permitsRouter = Router();\npermitsRouter.get("/", h);\n// tweak\n',
      );
      expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    });

    it("flags a new route in a mounted router with its full path", () => {
      mounted('permitsRouter.get("/", h);\n');
      commit("permits\n\nArchmap: none - test setup");
      mounted('permitsRouter.get("/", h);\npermitsRouter.post("/:id", h);\n');
      expect(problem()).toContain(
        "apps/api/src/routes/permits.ts: new lead: route POST /api/v1/permits/:id",
      );
    });
  });

  it("uses origin/<base> when only the remote branch exists", () => {
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    write("apps/api/src/routes.ts", "// changed\n");
    expect(problem("dev")).toContain(
      "apps/api/src/routes.ts: evidence of services/api.md",
    );
    expect(problem("dev")).toContain("brief --base dev");
    commit("tweak\n\nArchmap: none - only a comment");
    expect(runCheck(root, dir(), { base: "dev" }).errors).toEqual([]);
  });

  it("counts a lead that moved to another changed file as new", () => {
    const route =
      'import express from "express";\nconst app = express();\napp.post("/orders", h);\n';
    write("apps/api/src/a.ts", route);
    commit("orders");
    write("apps/api/src/a.ts", "export {};\n");
    write("apps/api/src/b.ts", route);
    expect(problem()).toContain(
      "apps/api/src/b.ts: new lead: route POST /orders",
    );
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

  it.each([".devcontainer/Dockerfile", "infra/.terraform/x.tf"])(
    "fails on the structural file %s inside a dot folder",
    (file) => {
      write(file, "x\n");
      expect(problem()).toContain(`${file}: structural file`);
    },
  );

  it("matches watch and skip globs inside dot folders", () => {
    config({ watch: ["**/*.env.json"] });
    commit("config");
    write(".config/app.env.json", "{}\n");
    expect(problem()).toContain(
      ".config/app.env.json: matches watch **/*.env.json",
    );
    config({ watch: [".devcontainer/*"], agent: { skip: ["**/Dockerfile"] } });
    commit("skip");
    write(".devcontainer/Dockerfile", "FROM x\n");
    write(".devcontainer/devcontainer.json", "{}\n");
    expect(problem()).toContain(".devcontainer/devcontainer.json");
    expect(problem()).not.toContain(".devcontainer/Dockerfile");
  });

  it("names the doc whose evidence cites a changed file as ./path", () => {
    write(
      "architecture/services/api.md",
      "---\nname: API\nstatus: live\nkind: api\nendpoints:\n  - route: GET /health\n    evidence: ./apps/api/src/routes.ts\n---\nServes requests.\n\n## How it works\n\nx\n\n## For developers\n\nx\n",
    );
    commit("dot slash\n\nArchmap: none - test setup");
    write("apps/api/src/routes.ts", "// changed\n");
    expect(problem()).toContain(
      "apps/api/src/routes.ts: evidence of services/api.md",
    );
  });
});
