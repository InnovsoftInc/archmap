import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scan } from "../scan/index.ts";
import { walk } from "../scan/walk.ts";
import { appsReader } from "../scan/workspace.ts";
import { routesReader } from "../scan/routes.ts";
import { readsSchema, schemaReader } from "../scan/schema.ts";
import { infraReader } from "../scan/infra.ts";
import { splitFrontmatter } from "../map/load.ts";
import { schemaProblems } from "../map/schema.ts";
import type { Doc } from "../map/types.ts";

vi.mock("node:fs", { spy: true });

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

const write = (file: string, text: string, root = tmp) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};
const routes = () => routesReader(tmp, walk(tmp)).routes;

describe("routes: mounts", () => {
  it("mounts a router passed after middleware", () => {
    write(
      "src/app.ts",
      [
        'import express from "express";',
        'import { auth } from "./auth";',
        'import usersRouter from "./users";',
        "const app = express();",
        'app.use("/api", auth, usersRouter);',
      ].join("\n"),
    );
    write("src/auth.ts", "export const auth = (req, res, next) => next();\n");
    write(
      "src/users.ts",
      'import { Router } from "express";\nconst r = Router();\nr.get("/users", h);\nexport default r;\n',
    );
    expect(routes()).toEqual([
      { file: "src/users.ts", method: "GET", path: "/api/users" },
    ]);
  });

  it("mounts a Fastify plugin registered with a prefix", () => {
    write(
      "src/server.ts",
      [
        'import Fastify from "fastify";',
        'import { userRoutes } from "./users";',
        "const app = Fastify();",
        'app.register(userRoutes, { prefix: "/api" });',
        'app.get("/health", h);',
      ].join("\n"),
    );
    write(
      "src/users.ts",
      'import type { FastifyInstance } from "fastify";\nexport async function userRoutes(fastify: FastifyInstance) {\n  fastify.get("/users", h);\n}\n',
    );
    expect(routes()).toEqual([
      { file: "src/server.ts", method: "GET", path: "/health" },
      { file: "src/users.ts", method: "GET", path: "/api/users" },
    ]);
  });

  it("mounts a Hono sub-app with app.route", () => {
    write(
      "src/index.ts",
      'import { Hono } from "hono";\nimport users from "./users";\nconst app = new Hono();\napp.route("/api", users);\n',
    );
    write(
      "src/users.ts",
      'import { Hono } from "hono";\nconst users = new Hono();\nusers.get("/users", (c) => c.json([]));\nexport default users;\n',
    );
    expect(routes()).toEqual([
      { file: "src/users.ts", method: "GET", path: "/api/users" },
    ]);
  });
});

describe("routes: imports and re-exports", () => {
  it("reads an import after a side-effect import with no semicolon", () => {
    write(
      "src/app.ts",
      [
        'import express from "express"',
        'import "./instrument"',
        'import usersRouter from "./routes/users"',
        "const app = express()",
        'app.use("/api", usersRouter)',
      ].join("\n"),
    );
    write("src/instrument.ts", "export {};\n");
    write(
      "src/routes/users.ts",
      'import { Router } from "express"\nconst r = Router()\nr.get("/users", h)\nexport default r\n',
    );
    expect(routes()).toEqual([
      { file: "src/routes/users.ts", method: "GET", path: "/api/users" },
    ]);
  });

  it("follows barrel re-exports, named, default-as and star, without looping", () => {
    write(
      "src/app.ts",
      [
        'import express from "express";',
        'import { usersRouter, postsRouter, tagsRouter } from "./routes";',
        "const app = express();",
        'app.use("/users", usersRouter);',
        'app.use("/posts", postsRouter);',
        'app.use("/tags", tagsRouter);',
      ].join("\n"),
    );
    write(
      "src/routes/index.ts",
      [
        'export { default as usersRouter } from "./users";',
        'export { postsRouter } from "./posts";',
        'export * from "./more";',
      ].join("\n"),
    );
    // A cycle: more re-exports the barrel that re-exports it.
    write(
      "src/routes/more.ts",
      'export * from "./index";\nexport * from "./tags";\n',
    );
    const router = (name: string, path: string, exp: string) =>
      `import { Router } from "express";\nconst ${name} = Router();\n${name}.get("${path}", h);\n${exp}\n`;
    write("src/routes/users.ts", router("u", "/me", "export default u;"));
    write(
      "src/routes/posts.ts",
      router("postsRouter", "/", "export { postsRouter };"),
    );
    write(
      "src/routes/tags.ts",
      router("tagsRouter", "/:id", "export { tagsRouter };"),
    );
    expect(routes()).toEqual([
      { file: "src/routes/posts.ts", method: "GET", path: "/posts" },
      { file: "src/routes/tags.ts", method: "GET", path: "/tags/:id" },
      { file: "src/routes/users.ts", method: "GET", path: "/users/me" },
    ]);
  });
});

describe("routes: comments and non-routes", () => {
  it("skips every line of a block comment but keeps a route path /*", () => {
    write(
      "src/server.ts",
      [
        'import express from "express";',
        "const app = express();",
        "/*",
        'app.get("/legacy", h);',
        '   app.post("/legacy2", h); */',
        'app.get("/*", h); /* app.get("/inline", h) */',
        'app.get("/after", h); // app.get("/trailing", h)',
        'const url = "http://example.com"; app.put("/url", h);',
      ].join("\n"),
    );
    expect(routes()).toEqual([
      { file: "src/server.ts", method: "GET", path: "/*" },
      { file: "src/server.ts", method: "GET", path: "/after" },
      { file: "src/server.ts", method: "PUT", path: "/url" },
    ]);
  });

  it("needs a handler after the path, so a cache lookup is not a route", () => {
    write(
      "src/server.ts",
      'import express from "express";\nconst app = express();\nconst v = cache.get("/not-a-route");\napp.get("/x");\nrouter.all("/any", h);\n',
    );
    expect(routes()).toEqual([
      { file: "src/server.ts", method: "ALL", path: "/any" },
    ]);
  });
});

const service = (endpoints: unknown[], connects: unknown[] = []): Doc => ({
  id: "api",
  folder: "services",
  file: "services/api.md",
  data: { name: "API", status: "live", kind: "api", endpoints, connects },
  body: "Intro.\n\n## How it works\nx\n\n## For developers\ny\n",
});

describe("map schema", () => {
  it("accepts an ALL route, as the scanner reports router.all", () => {
    expect(
      schemaProblems([service([{ route: "ALL /any", evidence: "a.ts" }])]),
    ).toEqual([]);
  });

  it("builds the set of ids for a reference list once, not per reference", () => {
    const docs = [
      service(
        [],
        Array.from({ length: 50 }, () => ({ to: "api", evidence: "a.ts" })),
      ),
    ];
    const filter = vi.spyOn(docs, "filter");
    expect(schemaProblems(docs)).toEqual([]);
    expect(filter.mock.calls.length).toBeLessThan(5);
  });
});

describe("frontmatter", () => {
  it("reads frontmatter after a byte-order mark and with trailing spaces on ---", () => {
    expect(splitFrontmatter("﻿--- \nname: A\n---  \nBody\n")).toEqual({
      data: { name: "A" },
      body: "Body\n",
    });
  });
});

describe("apps", () => {
  it("normalizes ./ and trailing / in workspace patterns, list and object form", () => {
    write(
      "package.json",
      JSON.stringify({ workspaces: { packages: ["./apps/*", "libs/*/"] } }),
    );
    write("apps/web/package.json", JSON.stringify({ name: "web" }));
    write("libs/ui/package.json", JSON.stringify({ name: "ui" }));
    write("other/package.json", JSON.stringify({ name: "other" }));
    expect((appsReader(tmp, walk(tmp)).apps ?? []).map((a) => a.path)).toEqual([
      "apps/web",
      "libs/ui",
    ]);
  });

  it("normalizes pnpm-workspace.yaml patterns, read as YAML", () => {
    write("package.json", "{}");
    write("pnpm-workspace.yaml", "packages: # the apps\n  - './apps/*/'\n");
    write("apps/web/package.json", JSON.stringify({ name: "web" }));
    expect((appsReader(tmp, walk(tmp)).apps ?? []).map((a) => a.path)).toEqual([
      "apps/web",
    ]);
  });

  it("with no workspaces, counts every package with dependencies", () => {
    write("package.json", JSON.stringify({ name: "root" }));
    write(
      "api/package.json",
      JSON.stringify({ name: "api", dependencies: { express: "5" } }),
    );
    write("tools/package.json", JSON.stringify({ name: "tools" }));
    write(
      "test/fixtures/app/package.json",
      JSON.stringify({ dependencies: { express: "5" } }),
    );
    expect(appsReader(tmp, walk(tmp)).apps).toEqual([
      { file: "api/package.json", name: "api", path: "api", deps: ["express"] },
    ]);
  });
});

describe("infra: compose", () => {
  it("reads compose.yaml and parses it as YAML", () => {
    write(
      "compose.yaml",
      [
        "services: # the stack",
        "  web: { image: nginx }",
        '  "worker-1":',
        "    image: app",
        "  # db:",
        "volumes: {}",
      ].join("\n"),
    );
    write(
      "deploy/docker-compose.prod.yaml",
      "services:\n  api:\n    image: x\n",
    );
    write("compose.yml.bak", "services:\n  nope: {}\n");
    expect(infraReader(tmp, walk(tmp)).infra).toEqual([
      { file: "compose.yaml", kind: "compose", type: "service", name: "web" },
      {
        file: "compose.yaml",
        kind: "compose",
        type: "service",
        name: "worker-1",
      },
      {
        file: "deploy/docker-compose.prod.yaml",
        kind: "compose",
        type: "service",
        name: "api",
      },
    ]);
  });

  it("still reports a compose file with no services", () => {
    write("compose.yml", "volumes: {}\n");
    expect(infraReader(tmp, walk(tmp)).unreadable).toEqual([
      { file: "compose.yml", reason: "no services: section found" },
    ]);
  });
});

describe("schema: SQL identifiers and Prisma @@map", () => {
  it("reads bracketed, double-quoted and backticked names, schema-qualified", () => {
    write(
      "db/schema.sql",
      [
        "CREATE TABLE [dbo].[Users] ([Id] INT, [Email] NVARCHAR(255), [Full Name] TEXT);",
        'CREATE TABLE "public"."orders" ("id" INT, "total" NUMERIC(10, 2), "primary" BOOL, PRIMARY KEY ("id"));',
        "CREATE TABLE IF NOT EXISTS `shop`.`items` (`id` INT, note TEXT DEFAULT 'a,b');",
        "/* CREATE TABLE ghosts (id INT); */",
      ].join("\n"),
    );
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([
      {
        file: "db/schema.sql",
        name: "Users",
        columns: ["Id", "Email", "Full Name"],
      },
      { file: "db/schema.sql", name: "items", columns: ["id", "note"] },
      {
        file: "db/schema.sql",
        name: "orders",
        columns: ["id", "total", "primary"],
      },
    ]);
  });

  it("names a Prisma model by its @@map table name", () => {
    write(
      "prisma/schema.prisma",
      'model User {\n  id Int @id\n  @@map("users")\n}\n',
    );
    write(
      "prisma/migrations/1_init/migration.sql",
      "CREATE TABLE users (id INT);\n",
    );
    // The model and the migration are the same table: the schema wins.
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([
      { file: "prisma/schema.prisma", name: "users", columns: ["id"] },
    ]);
  });
});

describe("schema: which files", () => {
  it("leaves out tests and fixtures", () => {
    expect(readsSchema("src/db/schema.ts")).toBe(true);
    expect(readsSchema("src/__tests__/schema.ts")).toBe(false);
    expect(readsSchema("test/fixtures/schema.sql")).toBe(false);
    expect(readsSchema("src/db.test.ts")).toBe(false);
    write(
      "src/__tests__/db.ts",
      'export const t = pgTable("ghost", { id: uuid() });\n',
    );
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([]);
  });

  it("keeps one table per project, not one per name across the repo", () => {
    write("apps/a/package.json", "{}");
    write("apps/b/package.json", "{}");
    write("apps/a/migrations/1.sql", "CREATE TABLE users (id INT);\n");
    write("apps/a/migrations/2.sql", "CREATE TABLE users (id INT, a INT);\n");
    write("apps/b/migrations/1.sql", "CREATE TABLE users (id INT, b INT);\n");
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([
      { file: "apps/a/migrations/2.sql", name: "users", columns: ["id", "a"] },
      { file: "apps/b/migrations/1.sql", name: "users", columns: ["id", "b"] },
    ]);
  });
});

describe("walk", () => {
  it("skips more build, vendor and cache folders, but not a package named build", () => {
    write("keep.ts", "");
    for (const dir of [
      "target",
      "out",
      ".svelte-kit",
      ".vercel",
      ".nuxt",
      "vendor",
      "venv",
      "__pycache__",
      "dist",
    ])
      write(`${dir}/x.ts`, "");
    write("packages/build/package.json", "{}");
    expect(walk(tmp)).toEqual(["keep.ts", "packages/build/package.json"]);
  });

  it("respects .gitignore in a git repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "archmap-walk-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      write(".gitignore", "generated/\n*.log\n", repo);
      write("src/a.ts", "", repo);
      write("src/b.ts", "", repo);
      write("generated/client.ts", "", repo);
      write("debug.log", "", repo);
      write("node_modules/x/index.js", "", repo);
      execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
      expect(walk(repo)).toEqual([".gitignore", "src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("doesn't read a file over 1 MB, and reads each file once per scan", () => {
    write("src/routes/big.ts", `app.get("/big", h);\n${" ".repeat(1_100_000)}`);
    write("package.json", JSON.stringify({ dependencies: { stripe: "1" } }));
    // Both the routes and the schema reader open a source file.
    write("src/db.ts", 'export const t = pgTable("t", { id: uuid() });\n');
    const s = scan(tmp);
    expect(s.routes).toEqual([]);
    expect(s.unreadable).toEqual([
      {
        file: "src/routes/big.ts",
        reason: expect.stringContaining("larger than 1 MB"),
      },
    ]);
    const reads = vi
      .mocked(fs.readFileSync)
      .mock.calls.map(([p]) => String(p))
      .filter((p) => p.startsWith(tmp));
    expect(reads.toSorted()).toEqual([
      join(tmp, "package.json"),
      join(tmp, "src/db.ts"),
    ]);
  });
});
