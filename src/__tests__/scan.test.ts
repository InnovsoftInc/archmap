import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../scan/index.ts";
import { walk } from "../scan/walk.ts";
import { appsReader } from "../scan/workspace.ts";
import { routesReader } from "../scan/routes.ts";
import { schemaReader } from "../scan/schema.ts";
import { infraReader } from "../scan/infra.ts";
import { outsideReader } from "../scan/outside.ts";
import { ciReader } from "../scan/ci.ts";
import { proposeWatch, stage } from "../scan/propose.ts";

const fixture = (name: string) =>
  join(import.meta.dirname, "fixtures", "scan", name);
const express = fixture("express-prisma");
const fastify = fixture("fastify-drizzle-tf");
const compose = fixture("compose-env");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const write = (file: string, text: string) => {
  mkdirSync(join(tmp, file, ".."), { recursive: true });
  writeFileSync(join(tmp, file), text);
};

describe("walk", () => {
  it("lists repo-relative posix paths in a stable order", () => {
    expect(walk(compose)).toEqual([
      ".env.sample",
      "app.env.example",
      "docker-compose.yml",
    ]);
  });

  it("skips node_modules and dist", () => {
    // The fixture really has the folders; walk must leave them out.
    expect(existsSync(join(express, "node_modules/x/routes/a.js"))).toBe(true);
    expect(existsSync(join(express, "dist/routes/b.js"))).toBe(true);
    const files = walk(express);
    expect(files.some((f) => /(^|\/)(node_modules|dist)\//.test(f))).toBe(
      false,
    );
    const cited = Object.values(scan(express))
      .filter(Array.isArray)
      .flat()
      .map((fact: { file: string }) => fact.file);
    expect(cited.some((f) => /(^|\/)(node_modules|dist)\//.test(f))).toBe(
      false,
    );
  });

  it("skips .git, build, coverage, .turbo, .terraform, .next and .venv too", () => {
    writeFileSync(join(tmp, "keep.ts"), "");
    for (const dir of [
      ".git",
      "build",
      "coverage",
      ".turbo",
      ".terraform",
      ".next",
      ".venv",
    ]) {
      mkdirSync(join(tmp, dir));
      writeFileSync(join(tmp, dir, "x.ts"), "");
    }
    expect(walk(tmp)).toEqual(["keep.ts"]);
  });
});

// chmod can't lock root out of a folder.
describe.skipIf(process.getuid?.() === 0)("an unreadable folder", () => {
  const locked = () => join(tmp, "locked");
  afterEach(() => chmodSync(locked(), 0o755));

  it("is listed under unreadable and the walk carries on", () => {
    mkdirSync(join(tmp, "src", "routes"), { recursive: true });
    writeFileSync(join(tmp, "src", "routes", "a.ts"), 'app.get("/a", h);\n');
    mkdirSync(locked());
    writeFileSync(join(locked(), "x.ts"), "");
    chmodSync(locked(), 0o000);
    const unreadable: { file: string; reason: string }[] = [];
    expect(walk(tmp, unreadable)).toEqual(["src/routes/a.ts"]);
    expect(unreadable).toEqual([
      { file: "locked", reason: expect.stringContaining("EACCES") },
    ]);
    const s = scan(tmp);
    expect(s.routes).toEqual([
      { file: "src/routes/a.ts", method: "GET", path: "/a" },
    ]);
    expect(s.unreadable.map((u) => u.file)).toEqual(["locked"]);
  });
});

describe("apps", () => {
  it("reads the root package", () => {
    expect(appsReader(express, walk(express)).apps).toEqual([
      {
        file: "package.json",
        name: "express-prisma-app",
        path: ".",
        deps: ["@prisma/client", "express", "stripe"],
      },
    ]);
  });

  it("reads workspace packages from pnpm-workspace.yaml, not a dependency-free root", () => {
    expect(appsReader(fastify, walk(fastify)).apps).toEqual([
      {
        file: "apps/api/package.json",
        name: "@acme/api",
        path: "apps/api",
        deps: ["@azure/storage-blob", "@sentry/node", "drizzle-orm", "fastify"],
      },
      {
        file: "apps/web/package.json",
        name: "@acme/web",
        path: "apps/web",
        deps: ["react"],
      },
    ]);
  });

  it("reads workspaces from package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ workspaces: ["pkgs/*"] }),
    );
    mkdirSync(join(tmp, "pkgs/a"), { recursive: true });
    writeFileSync(
      join(tmp, "pkgs/a/package.json"),
      JSON.stringify({ dependencies: { zod: "1" } }),
    );
    expect(appsReader(tmp, walk(tmp)).apps).toEqual([
      // A package with no name is called after its folder.
      { file: "pkgs/a/package.json", name: "a", path: "pkgs/a", deps: ["zod"] },
    ]);
  });
});

describe("routes", () => {
  it("finds Express routes and lists route files with none", () => {
    expect(routesReader(express, walk(express))).toEqual({
      routes: [
        { file: "src/routes/users.ts", method: "GET", path: "/users" },
        { file: "src/routes/users.ts", method: "POST", path: "/users" },
        { file: "src/routes/users.ts", method: "DELETE", path: "/users/:id" },
        { file: "src/server.ts", method: "GET", path: "/health" },
      ],
      routeFiles: [{ file: "src/routes/helpers.ts" }],
      unreadable: [],
    });
  });

  it("skips tests, fixtures, e2e, comments and paths without a leading /", () => {
    const put = (file: string, text: string) => {
      mkdirSync(join(tmp, file, ".."), { recursive: true });
      writeFileSync(join(tmp, file), text);
    };
    const route = 'app.get("/real", h);\n';
    put("src/__tests__/a.ts", route);
    put("src/users.test.ts", route);
    put("src/users.spec.js", route);
    put("src/fixtures/app.ts", route);
    put("e2e/app.ts", route);
    put(
      "src/server.ts",
      [
        '// app.get("/commented", h);',
        "/**",
        ' * router.post("/in-a-doc-comment", h);',
        " */",
        'const port = app.get("port");',
        'app.get("/real", h);',
        "app.post(",
        '  "/multi-line",',
        "  h,",
        ");",
      ].join("\n"),
    );
    expect(routesReader(tmp, walk(tmp)).routes).toEqual([
      { file: "src/server.ts", method: "POST", path: "/multi-line" },
      { file: "src/server.ts", method: "GET", path: "/real" },
    ]);
  });

  it("finds Next.js app-router routes by folder and exported method", () => {
    const api = "apps/server/src/app/api";
    write(
      `${api}/trips/route.ts`,
      [
        "export async function GET(req: Request) {}",
        "export const POST = handler;",
        "export function OPTIONS() {}",
      ].join("\n"),
    );
    write(`${api}/costs/[id]/route.ts`, "export async function PATCH() {}\n");
    write("app/(marketing)/api/ping/route.js", "export function GET() {}\n");
    // Not a route: a helper next to one, and a page.
    write(`${api}/trips/helpers.ts`, "export function GET() {}\n");
    write("app/page.tsx", "export default function Page() {}\n");
    expect(routesReader(tmp, walk(tmp))).toEqual({
      routes: [
        {
          file: "app/(marketing)/api/ping/route.js",
          method: "GET",
          path: "/api/ping",
        },
        {
          file: `${api}/costs/[id]/route.ts`,
          method: "PATCH",
          path: "/api/costs/[id]",
        },
        { file: `${api}/trips/route.ts`, method: "GET", path: "/api/trips" },
        { file: `${api}/trips/route.ts`, method: "POST", path: "/api/trips" },
      ],
      routeFiles: [],
      unreadable: [],
    });
  });

  it("leaves out a routes/ folder of UI pages", () => {
    // A client router's folder holds .tsx pages and plain helpers with no
    // server routes; none of it is an API endpoint.
    write("apps/web/src/routes/map.tsx", "export const Map = () => null;\n");
    write("apps/web/src/routes/settings-nav.ts", "export const nav = [];\n");
    write("apps/api/src/routes/helpers.ts", "export const x = 1;\n");
    expect(routesReader(tmp, walk(tmp)).routeFiles).toEqual([
      { file: "apps/api/src/routes/helpers.ts" },
    ]);
  });

  it("finds Fastify routes", () => {
    expect(routesReader(fastify, walk(fastify)).routes).toEqual([
      { file: "apps/api/src/server.ts", method: "POST", path: "/accounts" },
      { file: "apps/api/src/server.ts", method: "GET", path: "/ping" },
    ]);
  });
});

describe("schema", () => {
  it("reads Prisma models, with fields as columns", () => {
    expect(schemaReader(express, walk(express))).toEqual({
      tables: [
        {
          file: "prisma/schema.prisma",
          name: "Post",
          columns: ["id", "title", "authorId"],
        },
        {
          file: "prisma/schema.prisma",
          name: "User",
          columns: ["id", "email", "posts"],
        },
      ],
      schemaFiles: [{ file: "prisma/schema.prisma", kind: "prisma" }],
      unreadable: [],
    });
  });

  it("reads Drizzle tables (not index callbacks), CREATE TABLE and lists a binary bacpac as a dump", () => {
    expect(schemaReader(fastify, walk(fastify))).toEqual({
      tables: [
        {
          file: "apps/api/src/db/schema.ts",
          name: "accounts",
          columns: ["id", "email", "createdAt"],
        },
        {
          file: "apps/api/src/db/schema.ts",
          name: "sessions",
          columns: ["token"],
        },
        {
          file: "apps/api/src/db/schema.ts",
          name: "users",
          columns: ["id", "email"],
        },
        {
          file: "migrations/0001_init.sql",
          name: "audit",
          columns: ["id", "action"],
        },
        // Tables end where their brackets do, not at the next line start.
        {
          file: "migrations/0002_tags.sql",
          name: "posts",
          columns: ["id", "title"],
        },
        {
          file: "migrations/0002_tags.sql",
          name: "tags",
          columns: ["id", "name"],
        },
      ],
      schemaFiles: [
        { file: "apps/api/src/db/schema.ts", kind: "drizzle" },
        { file: "backup/legacy.bacpac", kind: "dump" },
        { file: "migrations/0001_init.sql", kind: "sql" },
        { file: "migrations/0002_tags.sql", kind: "sql" },
      ],
      unreadable: [],
    });
  });
});

describe("schema, one entry per table", () => {
  it("prefers the ORM schema over migrations that create the same table", () => {
    write(
      "db/src/schema.ts",
      'export const trips = pgTable("trips", { id: uuid(), status: text() });\n',
    );
    write("db/migrations/0000_init.sql", "CREATE TABLE trips (id uuid);\n");
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([
      { file: "db/src/schema.ts", name: "trips", columns: ["id", "status"] },
    ]);
  });

  it("keeps the latest migration's version of a recreated table", () => {
    write("migrations/0001_a.sql", "CREATE TABLE tags (id int);\n");
    write("migrations/0002_b.sql", "CREATE TABLE tags (id int, name text);\n");
    expect(schemaReader(tmp, walk(tmp)).tables).toEqual([
      { file: "migrations/0002_b.sql", name: "tags", columns: ["id", "name"] },
    ]);
  });

  it("lists only SQL files that create or alter tables", () => {
    write("migrations/0001_a.sql", "CREATE TABLE tags (id int);\n");
    write("migrations/0002_b.sql", "ALTER TABLE tags ADD COLUMN name text;\n");
    write("scripts/audit.sql", "SELECT count(*) FROM tags;\n");
    write("scripts/role.sql", "GRANT SELECT ON tags TO app;\n");
    expect(schemaReader(tmp, walk(tmp)).schemaFiles).toEqual([
      { file: "migrations/0001_a.sql", kind: "sql" },
      { file: "migrations/0002_b.sql", kind: "sql" },
    ]);
  });
});

describe("infra", () => {
  it("reads Terraform resources", () => {
    expect(infraReader(fastify, walk(fastify)).infra).toEqual([
      {
        file: "infra/main.tf",
        kind: "terraform",
        type: "azurerm_linux_web_app",
        name: "api",
      },
      {
        file: "infra/main.tf",
        kind: "terraform",
        type: "azurerm_resource_group",
        name: "main",
      },
    ]);
  });

  it("reads compose services", () => {
    expect(infraReader(compose, walk(compose)).infra).toEqual([
      {
        file: "docker-compose.yml",
        kind: "compose",
        type: "service",
        name: "db",
      },
      {
        file: "docker-compose.yml",
        kind: "compose",
        type: "service",
        name: "web",
      },
    ]);
  });

  it("reads a Dockerfile as an image named for its folder", () => {
    expect(infraReader(express, walk(express)).infra).toEqual([
      { file: "Dockerfile", kind: "docker", type: "image", name: "." },
    ]);
  });
});

describe("outside", () => {
  it("reads env names and SDKs from dependencies", () => {
    expect(outsideReader(express, walk(express)).outside).toEqual([
      { file: ".env.example", name: "DATABASE_URL", via: "env" },
      { file: ".env.example", name: "STRIPE_SECRET_KEY", via: "env" },
      { file: "package.json", name: "Stripe", via: "sdk" },
    ]);
  });

  it("reads .env.sample and *.env.example, ignoring comments and export", () => {
    expect(outsideReader(compose, walk(compose)).outside).toEqual([
      { file: ".env.sample", name: "API_URL", via: "env" },
      { file: ".env.sample", name: "REDIS_URL", via: "env" },
      { file: "app.env.example", name: "APP_MODE", via: "env" },
    ]);
  });

  it("names each SDK once per package", () => {
    expect(outsideReader(fastify, walk(fastify)).outside).toEqual([
      { file: "apps/api/package.json", name: "Azure", via: "sdk" },
      { file: "apps/api/package.json", name: "Sentry", via: "sdk" },
    ]);
  });
});

describe("ci", () => {
  it("reads workflows and what they deploy with", () => {
    expect(ciReader(fastify, walk(fastify)).ci).toEqual([
      { file: ".github/workflows/ci.yml", workflow: "ci.yml", deploys: [] },
      {
        file: ".github/workflows/deploy.yml",
        workflow: "deploy.yml",
        deploys: ["azure/login@v2", "flyctl"],
      },
    ]);
  });

  it("reads image pushes and copying to a server over SSH", () => {
    write(
      ".github/workflows/images.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "      - run: mkdir -p ~/.ssh && ssh-keyscan -H host >> ~/.ssh/known_hosts",
        "      - run: docker push ghcr.io/acme/web",
        "      - run: |",
        "          scp -i key image.tar.gz me@host:/srv",
        "          ssh -i key me@host 'bash -s' < deploy.sh",
      ].join("\n"),
    );
    expect(ciReader(tmp, walk(tmp)).ci).toEqual([
      {
        file: ".github/workflows/images.yml",
        workflow: "images.yml",
        deploys: ["docker push", "docker/build-push-action@v6", "scp", "ssh"],
      },
    ]);
  });
});

describe("scan", () => {
  it("empty repo scans to empty lists", () => {
    expect(scan(fixture("empty"))).toEqual({
      root: fixture("empty"),
      apps: [],
      routes: [],
      routeFiles: [],
      tables: [],
      schemaFiles: [],
      infra: [],
      outside: [],
      ci: [],
      unreadable: [],
      codeFiles: 0,
    });
  });

  it("lists a file it can't parse under unreadable", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), "name: [oops\n");
    writeFileSync(join(tmp, "Dockerfile"), "FROM node\n");
    const result = scan(tmp);
    expect(result.unreadable).toEqual([
      { file: "docker-compose.yml", reason: "no services: section found" },
    ]);
    // It carries on with the other files.
    expect(result.infra).toEqual([
      { file: "Dockerfile", kind: "docker", type: "image", name: "." },
    ]);
  });

  it("gives the same result every time", () => {
    expect(scan(fastify)).toEqual(scan(fastify));
  });
});

describe("stage", () => {
  it("is planning for an empty repo", () => {
    expect(stage(scan(fixture("empty")))).toBe("planning");
  });

  it("is scaffolded for a few routes and nothing else", () => {
    mkdirSync(join(tmp, "src", "routes"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "routes", "users.ts"),
      'router.get("/users", h);\nrouter.post("/users", h);\n',
    );
    const s = scan(tmp);
    expect(s.routes).toHaveLength(2);
    expect(stage(s)).toBe("scaffolded");
  });

  it("is not planning for code with no package.json, routes or infrastructure", () => {
    const s = scan(fixture("go-only"));
    expect(s.apps).toEqual([]);
    expect(s.codeFiles).toBe(1);
    expect(stage(s)).toBe("scaffolded");
  });

  it("is not planning for a src/ folder alone", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "notes.txt"), "");
    expect(stage(scan(tmp))).toBe("scaffolded");
  });

  it("is existing once there is a schema", () => {
    expect(stage(scan(express))).toBe("existing");
  });
});

describe("proposeWatch", () => {
  it("proposes route folders and schema files", () => {
    const watch = proposeWatch(scan(express));
    expect(watch).toContainEqual({
      paths: ["src/routes/**", "src/server.ts"],
      means: "API endpoints",
      layer: "parts",
    });
    expect(watch).toContainEqual({
      paths: ["prisma/schema.prisma"],
      means: "Database tables and columns",
      layer: "data",
    });
  });

  it("proposes terraform, compose, libraries and env files", () => {
    const names = proposeWatch(scan(fastify)).map((e) => e.means);
    expect(names).toContain("Hosting and cloud services");
    expect(names).toContain("Libraries and tools");
    const c = proposeWatch(scan(compose));
    expect(c).toContainEqual({
      paths: ["docker-compose.yml"],
      means: "Services and containers",
      layer: "overview",
    });
    expect(c.find((e) => e.means === "Outside services")?.paths).toContain(
      "app.env.example",
    );
  });

  it("watches Next.js route files and migration folders, not loose SQL", () => {
    write(
      "apps/server/src/app/api/trips/route.ts",
      "export function GET() {}\n",
    );
    write("db/migrations/0001_a.sql", "CREATE TABLE tags (id int);\n");
    write("scripts/audit.sql", "SELECT 1;\n");
    const watch = proposeWatch(scan(tmp));
    expect(watch).toContainEqual({
      paths: ["apps/server/src/app/**/route.ts"],
      means: "API endpoints",
      layer: "parts",
    });
    expect(watch).toContainEqual({
      paths: ["db/migrations/**"],
      means: "Database tables and columns",
      layer: "data",
    });
  });

  it("leaves out the root app's package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", dependencies: { express: "1" } }),
    );
    const s = scan(tmp);
    expect(s.apps.some((a) => a.path === ".")).toBe(true);
    expect(
      proposeWatch(s).find((e) => e.means === "Libraries and tools"),
    ).toBeUndefined();
  });

  it("leaves out kinds with nothing found", () => {
    expect(proposeWatch(scan(fixture("empty")))).toEqual([]);
  });
});
