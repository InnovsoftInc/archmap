import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, serve, siteData } from "../site.ts";
import { docSections, toViewModel } from "../view.ts";
import type { Doc, Folder } from "../map/types.ts";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  dir = join(root, "architecture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const doc = (
  folder: Folder,
  id: string,
  data: Record<string, unknown>,
  body = "Summary.\n",
): Doc => ({ id, folder, file: `${folder}/${id}.md`, data, body });

const seed = () => {
  write("archmap.config.json", '{"name":"Acme"}');
  write("README.md", "# Acme\n\nHello **world**.\n");
  write(
    "services/api.md",
    `---
name: API
status: live
kind: api
code: [apps/api]
---
Handles requests.

## How it works

It routes things.

## For developers

SECRET-DEV-TEXT in apps/api.
`,
  );
};

describe("toViewModel", () => {
  it("maps a service with endpoints, jobs and libraries to a top-level service and parts", () => {
    const m = toViewModel([
      doc(
        "services",
        "api",
        {
          name: "API",
          status: "live",
          kind: "api",
          endpoints: [
            { route: "GET /a" },
            {
              route: "POST /a/:id",
              does: "Renames a thing.",
              auth: "signed-in staff",
              params: [{ name: "id", in: "path", required: true }],
              body: [{ name: "name", type: "string", desc: "the new name" }],
              returns: "the thing",
            },
          ],
          jobs: [{ name: "nightly" }],
          libraries: [{ name: "zod" }],
          env: [
            { name: "VITE_API_URL", why: "where the API is", public: true },
            { name: "API_KEY", evidence: "src/config.ts" },
          ],
          connects: [{ to: "db", why: "reads", how: "SQL" }],
        },
        "Handles requests.\n",
      ),
      doc("services", "web", { name: "Web", status: "live", kind: "app" }),
      doc("services", "cron", { name: "Cron", status: "live", kind: "job" }),
    ]);
    // Only lanes with something in them are drawn.
    expect(Object.keys(m.categories)).toEqual(["frontend", "backend"]);
    expect(m.categories.backend).toMatchObject({ external: false });
    expect(m.services.api).toMatchObject({
      name: "API",
      status: "live",
      lane: "backend",
      type: "app",
      purpose: "Handles requests.",
    });
    expect(m.services.web).toMatchObject({ lane: "frontend", type: "app" });
    expect(m.services.cron).toMatchObject({ lane: "backend", type: "job" });
    expect(m.services["api.ep-0"]).toEqual({
      parent: "api",
      type: "endpoint",
      name: "GET /a",
    });
    expect(m.services["api.ep-1"]).toEqual({
      parent: "api",
      type: "endpoint",
      name: "POST /a/:id",
      purpose: "Renames a thing.",
      auth: "signed-in staff",
      params: [{ name: "id", in: "path", required: true }],
      body: [{ name: "name", type: "string", desc: "the new name" }],
      returns: "the thing",
    });
    expect(m.services["api.job-0"]).toMatchObject({
      parent: "api",
      type: "job",
    });
    expect(m.services["api.lib-0"]).toMatchObject({
      parent: "api",
      type: "library",
    });
    expect(m.services["api.env-0"]).toEqual({
      parent: "api",
      type: "env",
      name: "VITE_API_URL",
      purpose: "where the API is",
      public: true,
    });
    expect(m.services["api.env-1"]).toEqual({
      parent: "api",
      type: "env",
      name: "API_KEY",
      evidence: "src/config.ts",
    });
    expect(m.connections["api-db"]).toMatchObject({
      from: "api",
      to: "db",
      label: "reads",
      protocol: "SQL",
    });
    expect(m.problems).toEqual([]);
  });

  it("emits connections from external docs and passes each entry's status, default live", () => {
    const m = toViewModel([
      doc("external", "github", {
        name: "GitHub",
        status: "live",
        kind: "hosting",
        connects: [{ to: "acr", why: "pushes", status: "planned" }],
      }),
      doc("external", "acr", {
        name: "ACR",
        status: "live",
        kind: "hosting",
        connects: [{ to: "github" }],
      }),
    ]);
    expect(m.connections["github-acr"]).toMatchObject({
      from: "github",
      to: "acr",
      label: "pushes",
      status: "planned",
    });
    expect(m.connections["acr-github"]?.status).toBe("live");
  });

  it("maps stores to data-lane services, tables with areas from group, and enums", () => {
    const m = toViewModel([
      doc("stores", "db", {
        name: "DB",
        status: "live",
        kind: "database",
        tables: [
          {
            name: "users",
            group: "People",
            purpose: "Accounts",
            columns: [{ name: "id", type: "uuid", pk: true }],
          },
          { name: "jobs", columns: [] },
        ],
        enums: [{ name: "role", values: ["a", "b"] }],
      }),
      doc("stores", "q", { name: "Q", status: "live", kind: "queue" }),
      doc("external", "stripe", { name: "Stripe", status: "live" }),
    ]);
    expect(m.services.db).toMatchObject({
      lane: "backend",
      type: "store",
      opens: "schema",
    });
    expect(m.services.q?.opens).toBeUndefined();
    expect(m.services.stripe).toMatchObject({
      lane: "third_party",
      type: "external",
    });
    expect(m.tables.users).toMatchObject({
      area: "People",
      purpose: "Accounts",
    });
    expect(m.tables.users?.columns[0]).toMatchObject({
      name: "id",
      type: "uuid",
      pk: true,
    });
    expect(m.tables.jobs?.area).toBe("db");
    expect(m.areas.People).toEqual({ name: "People", order: 1 });
    expect(m.areas.db).toEqual({ name: "DB", order: 2 });
    expect(m.enums.role).toEqual({ values: ["a", "b"] });
  });

  it("maps a flow step by a persona to persona:<id>", () => {
    const m = toViewModel([
      doc(
        "personas",
        "admin",
        { name: "Admin", status: "live", needs: ["Manage users"] },
        "Runs it.\n",
      ),
      doc("flows", "signup", {
        name: "Signup",
        status: "live",
        steps: [
          { by: "admin", at: "api", does: "asks" },
          { by: "api", at: "db", does: "saves" },
        ],
      }),
    ]);
    expect(m.personas.admin).toMatchObject({
      name: "Admin",
      blurb: "Runs it.",
      jobs: [{ job: "Manage users" }],
      // From the flow steps the persona takes; the map has no per-need tables.
      uses: [{ to: "api", label: "asks" }],
    });
    expect(m.personas.admin?.jobs?.[0]).not.toHaveProperty("t");
    expect(m.flows.signup?.steps).toEqual([
      { from: "persona:admin", to: "api", label: "asks" },
      { from: "api", to: "db", label: "saves" },
    ]);
  });
});

describe("site data", () => {
  it("splits a body into summary, how and dev HTML", () => {
    seed();
    const s = docSections(
      doc(
        "services",
        "x",
        {},
        "Intro.\n\n## How it works\nHow.\n\n## For developers\nDev.\n",
      ),
    );
    expect(s).toEqual({ summary: "Intro.", how: "How.", dev: "Dev." });
    const data = JSON.parse(siteData(root, dir, {})) as {
      readme: string;
      docs: Record<string, { summary: string; how: string; dev: string }>;
      check: unknown;
    };
    expect(data.readme).toContain("<strong>world</strong>");
    expect(data.docs.api?.summary).toContain("<p>Handles requests.</p>");
    expect(data.docs.api?.how).toContain("<p>It routes things.</p>");
    expect(data.docs.api?.dev).toContain("SECRET-DEV-TEXT");
    expect(data.check).toBeDefined();
  });

  it("--public build has no For developers text, code or evidence anywhere in data.json", async () => {
    seed();
    const out = join(root, "site");
    await build(root, dir, out, { public: true, offline: true });
    expect(readdirSync(out).sort()).toEqual([
      "app.js",
      "data.json",
      "index.html",
      "styles.css",
    ]);
    const raw = readFileSync(join(out, "data.json"), "utf8");
    expect(raw).not.toContain("SECRET-DEV-TEXT");
    expect(raw).not.toContain('"code"');
    expect(raw).not.toContain('"evidence"');
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(JSON.stringify(data.docs)).not.toContain('"dev"');
    expect(data.check).toBeUndefined();
    expect(data.public).toBe(true);
  });

  it("--public keeps tables, enums and services whose ids are code, evidence or dev", () => {
    write(
      "archmap.config.json",
      JSON.stringify({
        name: "Acme",
        product: "Map",
        cli: "npx archmap",
        agent: { command: "secret-agent" },
        ignore: ["private/**"],
        watch: ["src/**"],
        deploy: { target: "x" },
        labels: { boundary: "Acme" },
        links: [{ label: "Repo", url: "https://example.com" }],
      }),
    );
    write("README.md", "# Acme\n");
    write(
      "stores/evidence.md",
      `---
name: Evidence store
status: live
kind: database
code: [db]
tables:
  - name: evidence
    evidence: [db/schema.sql]
    columns:
      - { name: code, type: text }
  - name: code
    columns: []
  - name: dev
    columns: []
enums:
  - { name: code, values: [a, b] }
---
Holds it.
`,
    );
    write(
      "services/code.md",
      "---\nname: Code\nstatus: live\nkind: api\ncode: [apps/code]\n---\nCode service.\n",
    );
    const data = JSON.parse(siteData(root, dir, { public: true })) as {
      config: Record<string, unknown>;
      model: {
        tables: Record<string, { columns: { name: string }[] }>;
        enums: Record<string, unknown>;
        services: Record<string, unknown>;
      };
      docs: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(data.model.tables).sort()).toEqual([
      "code",
      "dev",
      "evidence",
    ]);
    expect(data.model.tables.evidence?.columns[0]?.name).toBe("code");
    expect(data.model.tables.evidence).not.toHaveProperty("evidence");
    expect(data.model.enums.code).toEqual({ values: ["a", "b"] });
    expect(data.model.services.code).toBeDefined();
    expect(data.docs.code?.name).toBe("Code");
    expect(data.docs.code).not.toHaveProperty("code");
    expect(data.docs.evidence?.name).toBe("Evidence store");
    expect(Object.keys(data.config).sort()).toEqual([
      "labels",
      "links",
      "name",
      "product",
    ]);
  });

  it("escapes raw HTML in markdown so it never reaches data.json as a tag", () => {
    write("archmap.config.json", '{"name":"Acme"}');
    write("README.md", "# Acme\n\n<script>alert(1)</script>\n");
    write(
      "services/api.md",
      `---
name: API
status: live
kind: api
---
Hi <img src=x onerror=alert(1)> there.

<img src=x onerror=alert(1)>

## How it works

<div onclick="x()">block</div>

## For developers

Inline <b onmouseover=alert(1)>bold</b>.
`,
    );
    for (const opts of [{}, { public: true }, { dev: true }]) {
      const raw = siteData(root, dir, opts);
      const data = JSON.parse(raw) as {
        readme: string;
        docs: Record<string, Record<string, string>>;
      };
      const all = JSON.stringify([data.readme, data.docs]);
      expect(all).not.toMatch(/<img/i);
      expect(all).not.toMatch(/<script/i);
      expect(all).not.toMatch(/<div/i);
      expect(all).not.toMatch(/<b /i);
      expect(data.docs.api?.summary).toContain(
        "&lt;img src=x onerror=alert(1)&gt;",
      );
    }
  });

  it("renders only http, https, mailto, relative and #anchor links and images", () => {
    write("archmap.config.json", '{"name":"Acme"}');
    write(
      "README.md",
      [
        "# Acme",
        "",
        "[x](javascript:alert(1)) ![y](data:text/html,<b>hi</b>)",
        "[z](JavaScript:alert(2)) [w](&#106;avascript:alert(3)) <javascript:alert(4)>",
        "[ok](https://example.com) [mail](mailto:a@b.c) [rel](docs/a.md) [top](#top)",
        "![logo](img/logo.png)",
      ].join("\n"),
    );
    for (const opts of [{}, { public: true }]) {
      const data = JSON.parse(siteData(root, dir, opts)) as { readme: string };
      const readme = data.readme;
      // Unsafe links keep their text; no attribute carries them.
      expect(readme).not.toMatch(
        /(?:href|src)="(?!https:|mailto:|docs\/|#|img\/)/,
      );
      expect(readme).toContain("<p>x y\nz w javascript:alert(4)\n");
      expect(readme).toContain('<a href="https://example.com">ok</a>');
      expect(readme).toContain('<a href="mailto:a@b.c">mail</a>');
      expect(readme).toContain('<a href="docs/a.md">rel</a>');
      expect(readme).toContain('<a href="#top">top</a>');
      expect(readme).toContain('<img src="img/logo.png" alt="logo">');
      expect((readme.match(/<a /g) ?? []).length).toBe(4);
      expect((readme.match(/<img /g) ?? []).length).toBe(1);
    }
  });

  it("a normal build keeps dev text and code", async () => {
    seed();
    const out = join(root, "site");
    await build(root, dir, out, { offline: true });
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      docs: Record<string, { code: string[]; dev: string }>;
      config: { name: string };
    };
    expect(data.config.name).toBe("Acme");
    expect(data.docs.api?.code).toEqual(["apps/api"]);
    expect(data.docs.api?.dev).toContain("SECRET-DEV-TEXT");
  });

  it("dev serve returns fresh data.json after a file changes", async () => {
    seed();
    const server = await serve(root, dir, 0);
    const port = (server.address() as { port: number }).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve) =>
        request({ host: "127.0.0.1", port, path }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        }).end(),
      );
    const first = JSON.parse((await get("/data.json")).body) as {
      dev: boolean;
      rev: string;
    };
    expect(first.dev).toBe(true);
    write(
      "services/web.md",
      "---\nname: Web\nstatus: live\nkind: app\n---\nThe site.\n",
    );
    const second = JSON.parse((await get("/data.json")).body) as {
      rev: string;
    };
    expect(second.rev).not.toBe(first.rev);
    expect((await get("/index.html")).status).toBe(200);
    expect((await get("/secret.txt")).status).toBe(404);
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a logo outside the map folder or that isn't an image, and copies a good one", async () => {
    seed();
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    write("logo.svg", "<svg/>");
    const out = join(root, "site");
    for (const logo of ["../.env", "../logo.svg", "/etc/passwd", "README.md"]) {
      write("archmap.config.json", JSON.stringify({ name: "Acme", logo }));
      await expect(
        build(root, dir, out, { public: true, offline: true }),
      ).rejects.toThrow(/"logo"/);
      const data = JSON.parse(siteData(root, dir, {})) as {
        config: { logo?: string };
      };
      expect(data.config.logo).toBeUndefined();
    }
    expect(existsSync(out)).toBe(false);
    // A link inside the map folder that points outside it is refused too.
    symlinkSync(join(root, ".env"), join(dir, "sneaky.png"));
    write("archmap.config.json", '{"name":"Acme","logo":"sneaky.png"}');
    await expect(build(root, dir, out, { offline: true })).rejects.toThrow(
      /links outside the map folder/,
    );
    write("archmap.config.json", '{"name":"Acme","logo":"logo.svg"}');
    await build(root, dir, out, { offline: true });
    expect(readFileSync(join(out, "logo.svg"), "utf8")).toBe("<svg/>");
    expect(readdirSync(out).join(",")).not.toContain("env");
  });

  it("dev serve never returns a file outside the map folder as the logo", async () => {
    seed();
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    write("archmap.config.json", '{"name":"Acme","logo":"../.env"}');
    const server = await serve(root, dir, 0, { offline: true });
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<string>((resolve) =>
      request({ host: "127.0.0.1", port, path: "/logo.env" }, (res) => {
        let b = "";
        res.on("data", (c: Buffer) => (b += c.toString()));
        res.on("end", () => resolve(b));
      }).end(),
    );
    expect(body).not.toContain("SECRET");
    await new Promise((resolve) => server.close(resolve));
  });

  it("drops config links and font stylesheets the viewer can't safely load", () => {
    write(
      "archmap.config.json",
      JSON.stringify({
        name: "Acme",
        links: [
          { label: "Repo", url: "https://example.com" },
          { label: "Mail", url: "mailto:a@b.c" },
          { label: "Docs", url: "docs/index.html" },
          { label: "Bad", url: "javascript:alert(1)" },
          { label: "Bad2", url: "java\tscript:alert(1)" },
          { label: "Bad3", url: "&#106;avascript:alert(1)" },
          { label: "Data", url: "data:text/html,<b>x</b>" },
        ],
        fonts: { stylesheet: "javascript:alert(1)", sans: "Inter" },
      }),
    );
    write("README.md", "# Acme\n");
    for (const opts of [{}, { public: true }, { dev: true }]) {
      const data = JSON.parse(siteData(root, dir, opts)) as {
        config: {
          links: { url: string }[];
          fonts: { stylesheet?: string; sans?: string };
        };
      };
      expect(data.config.links.map((l) => l.url)).toEqual([
        "https://example.com",
        "mailto:a@b.c",
        "docs/index.html",
      ]);
      expect(data.config.fonts).toEqual({ sans: "Inter" });
    }
    for (const [sheet, kept] of [
      ["https://fonts.googleapis.com/css2?family=Inter", true],
      ["fonts.css", true],
      ["http://fonts.example/x.css", false],
      ["//evil.example/x.css", false],
      ["data:text/css,body{}", false],
    ] as const) {
      write(
        "archmap.config.json",
        JSON.stringify({ name: "Acme", fonts: { stylesheet: sheet } }),
      );
      const data = JSON.parse(siteData(root, dir, {})) as {
        config: { fonts: { stylesheet?: string } };
      };
      expect(data.config.fonts.stylesheet).toBe(kept ? sheet : undefined);
    }
  });

  it("dev serve rebuilds data.json when the map changes, and rescans code only every rescanMs", async () => {
    seed();
    const get = async (port: number) =>
      (
        JSON.parse(
          await new Promise<string>((resolve) =>
            request({ host: "127.0.0.1", port, path: "/data.json" }, (res) => {
              let b = "";
              res.on("data", (c: Buffer) => (b += c.toString()));
              res.on("end", () => resolve(b));
            }).end(),
          ),
        ) as { rev: string }
      ).rev;
    const route = (n: number) => {
      mkdirSync(join(root, "apps", "api"), { recursive: true });
      writeFileSync(
        join(root, "apps", "api", `r${n}.ts`),
        `import express from "express";\nconst app = express();\napp.get("/n${n}", (_q, r) => r.send("ok"));\n`,
      );
    };
    const slow = await serve(root, dir, 0, { offline: true, rescanMs: 60_000 });
    const port = (slow.address() as { port: number }).port;
    const first = await get(port);
    expect(await get(port)).toBe(first);
    // A code change alone waits for the rescan...
    route(1);
    expect(await get(port)).toBe(first);
    // ...a map change rebuilds at once.
    write(
      "services/web.md",
      "---\nname: Web\nstatus: live\nkind: app\n---\nThe site.\n",
    );
    const second = await get(port);
    expect(second).not.toBe(first);
    await new Promise((resolve) => slow.close(resolve));

    const fast = await serve(root, dir, 0, { offline: true, rescanMs: 0 });
    const fastPort = (fast.address() as { port: number }).port;
    const before = await get(fastPort);
    route(2);
    expect(await get(fastPort)).not.toBe(before);
    await new Promise((resolve) => fast.close(resolve));
  });

  it("asks the registry only for dependencies that come from it", async () => {
    seed();
    write(
      "services/api.md",
      '---\nname: API\nstatus: live\nkind: api\ncode: [apps/api]\nlibraries:\n  - { name: Express }\n  - { name: Shared, package: "@acme/shared" }\n  - { name: Fork, package: forked }\n---\nHandles requests.\n',
    );
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", "package.json"),
      JSON.stringify({
        dependencies: {
          express: "^5.1.0",
          "@acme/shared": "workspace:*",
          forked: "github:acme/forked#v1",
        },
      }),
    );
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ version: "5.1.0" }));
    }) as typeof fetch;
    await build(root, dir, join(root, "site"), {
      fetch: get,
      cacheFile: join(root, "cache.json"),
    });
    expect(asked).toEqual(["https://registry.npmjs.org/express/latest"]);
  });

  it("serve rejects with a readable message when the port is in use", async () => {
    seed();
    const first = await serve(root, dir, 0);
    const port = (first.address() as { port: number }).port;
    try {
      await expect(serve(root, dir, port)).rejects.toThrow(
        `Port ${port} is in use. Try --port ${port + 1}.`,
      );
    } finally {
      await new Promise((resolve) => first.close(resolve));
    }
  });
});

describe("viewer: Start here", () => {
  const app = readFileSync(
    join(import.meta.dirname, "..", "..", "viewer", "app.js"),
    "utf8",
  );
  const fn = (header: string): string => {
    const start = app.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    return app.slice(start, app.indexOf("\n}", start));
  };

  // Start here is drawn above the drawer (z-index 8 vs 6), so every drawer,
  // flow, problems and enum panel, which all open through showPanel, closes it.
  it("closes whenever a drawer opens", () => {
    expect(fn("function showPanel(")).toContain("showStart(false)");
    for (const opener of [
      "function openFlow(",
      "function openFlows(",
      "function openEnums(",
      "function openProblems(",
      "function openTable(",
      "function openService(",
      "function openPersona(",
    ])
      expect(fn(opener)).toContain("showPanel(");
  });

  it("closes on search navigation", () => {
    const search = app.slice(app.indexOf('$("q").addEventListener("keydown"'));
    expect(search.slice(0, search.indexOf("\n});"))).toContain(
      "showStart(false)",
    );
  });
});
