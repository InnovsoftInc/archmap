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
import { envReader } from "../scan/env.ts";
import { ciReader } from "../scan/ci.ts";

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

  it("finds routes on any router name and applies mount prefixes", () => {
    const mounts = fixture("express-mounts");
    const r = (file: string, method: string, path: string) => ({
      file: `apps/api/src/routes/${file}`,
      method,
      path,
    });
    expect(routesReader(mounts, walk(mounts))).toEqual({
      routes: [
        r("admin.ts", "DELETE", "/api/v1/admin/cache"),
        r("admin.ts", "GET", "/api/v1/admin/reports/daily"),
        r("healthcheck.ts", "GET", "/api/v1/healthcheck"),
        r("index.ts", "GET", "/api/v1/version"),
        r("orphan.ts", "OPTIONS", "/orphan"),
        r("permits.ts", "POST", "/api/v1/permits"),
        r("permits.ts", "GET", "/api/v1/permits/:id"),
      ],
      routeFiles: [],
      unreadable: [],
    });
  });

  it("only reads other router names in files that use a server framework", () => {
    write("src/routes/a.ts", 'thing.get("/a", h);\n');
    write(
      "src/routes/b.ts",
      'import Fastify from "fastify";\nconst api = Fastify();\napi.head("/b", h);\n',
    );
    expect(routesReader(tmp, walk(tmp))).toEqual({
      routes: [{ file: "src/routes/b.ts", method: "HEAD", path: "/b" }],
      routeFiles: [{ file: "src/routes/a.ts" }],
      unreadable: [],
    });
  });

  it("doesn't count a type-only framework import, and reads a default export with a comment", () => {
    write(
      "src/types.ts",
      'import { x } from "./x"\nimport type { Router } from "express"\nexport const api = (r: Router) => r;\napi.get("/typed", h);\n',
    );
    write(
      "src/app.ts",
      'import express from "express";\nimport users from "./users.js";\nconst app = express();\napp.use("/users", users);\n',
    );
    write(
      "src/users.ts",
      'import express, { type Request } from "express";\nconst usersRouter = express.Router();\nusersRouter.get("/me", h);\nexport default usersRouter; // mounted in app.ts\n',
    );
    expect(routesReader(tmp, walk(tmp)).routes).toEqual([
      { file: "src/users.ts", method: "GET", path: "/users/me" },
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

describe("env", () => {
  const env = () => envReader(tmp, walk(tmp)).env ?? [];

  it("reads the variables JavaScript and TypeScript code reads", () => {
    write(
      "apps/api/src/config.ts",
      [
        "const a = process.env.DATABASE_URL;",
        'const b = process.env["STRIPE_KEY"];',
        "const { REDIS_URL, PORT: port } = process.env;",
        'const c = Deno.env.get("DENO_TOKEN");',
        "if (process.env.NODE_ENV === 'production') {}",
      ].join("\n"),
    );
    write(
      "apps/web/src/api.ts",
      [
        "export const base = import.meta.env.VITE_API_URL;",
        "export const dev = import.meta.env.DEV;",
        "export const key = process.env.NEXT_PUBLIC_MAPS_KEY;",
      ].join("\n"),
    );
    expect(env()).toEqual([
      { file: "apps/api/src/config.ts", name: "DATABASE_URL", public: false },
      { file: "apps/api/src/config.ts", name: "DENO_TOKEN", public: false },
      { file: "apps/api/src/config.ts", name: "PORT", public: false },
      { file: "apps/api/src/config.ts", name: "REDIS_URL", public: false },
      { file: "apps/api/src/config.ts", name: "STRIPE_KEY", public: false },
      {
        file: "apps/web/src/api.ts",
        name: "NEXT_PUBLIC_MAPS_KEY",
        public: true,
      },
      { file: "apps/web/src/api.ts", name: "VITE_API_URL", public: true },
    ]);
  });

  it("reads the keys of a schema that parses the whole environment", () => {
    write(
      "src/env.ts",
      [
        "const schema = z.object({",
        "  OPENAI_API_KEY: z.string().optional(),",
        '  EMAIL_PROVIDER: z.enum(["log", "resend"]),',
        "  nested: { NOT_A_LINE_KEY: 1 },",
        "});",
        "export const env = schema.parse(process.env);",
      ].join("\n"),
    );
    // Without the whole environment in the file, upper-case keys are just keys.
    write("src/codes.ts", "export const codes = {\n  NOT_FOUND: 404,\n};\n");
    expect(env().map((e) => e.name)).toEqual([
      "EMAIL_PROVIDER",
      "OPENAI_API_KEY",
    ]);
  });

  it("reads other languages, each by its own call", () => {
    write(
      "a.py",
      'x = os.environ["PY_A"]\ny = os.environ.get("PY_B")\nz = os.getenv("PY_C")\n',
    );
    write("b.go", 'x := os.Getenv("GO_A")\ny, ok := os.LookupEnv("GO_B")\n');
    write("c.rb", "x = ENV['RB_A']\ny = ENV.fetch(\"RB_B\")\n");
    write("d.rs", 'let x = env::var("RS_A");\n');
    write("e.java", 'String x = System.getenv("JAVA_A");\n');
    write("f.cs", 'var x = Environment.GetEnvironmentVariable("CS_A");\n');
    write("g.php", "$x = getenv('PHP_A');\n$y = $_ENV['PHP_B'];\n");
    expect(env().map((e) => e.name)).toEqual([
      "PY_A",
      "PY_B",
      "PY_C",
      "GO_A",
      "GO_B",
      "RB_A",
      "RB_B",
      "RS_A",
      "JAVA_A",
      "CS_A",
      "PHP_A",
      "PHP_B",
    ]);
  });

  it("leaves out tests and names each variable once per file", () => {
    write("src/a.ts", "process.env.API_KEY; process.env.API_KEY;");
    write("src/a.test.ts", "process.env.TEST_ONLY;");
    expect(env()).toEqual([
      { file: "src/a.ts", name: "API_KEY", public: false },
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
      env: [],
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
      {
        file: "docker-compose.yml",
        reason:
          "invalid YAML at line 2: Flow sequence in block collection must be sufficiently indented and end with a ]",
      },
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
