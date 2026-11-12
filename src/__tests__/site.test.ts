import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
          endpoints: [{ route: "GET /a" }],
          jobs: [{ name: "nightly" }],
          libraries: [{ name: "zod" }],
          connects: [{ to: "db", why: "reads", how: "SQL" }],
        },
        "Handles requests.\n",
      ),
      doc("services", "web", { name: "Web", status: "live", kind: "app" }),
      doc("services", "cron", { name: "Cron", status: "live", kind: "job" }),
    ]);
    expect(Object.keys(m.categories)).toEqual([
      "apps",
      "services",
      "data",
      "outside",
    ]);
    expect(m.services.api).toMatchObject({
      name: "API",
      status: "live",
      lane: "services",
      type: "app",
      purpose: "Handles requests.",
    });
    expect(m.services.web).toMatchObject({ lane: "apps", type: "app" });
    expect(m.services.cron).toMatchObject({ lane: "services", type: "job" });
    expect(m.services["api.ep-0"]).toEqual({
      parent: "api",
      type: "endpoint",
      name: "GET /a",
    });
    expect(m.services["api.job-0"]).toMatchObject({
      parent: "api",
      type: "job",
    });
    expect(m.services["api.lib-0"]).toMatchObject({
      parent: "api",
      type: "library",
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
      lane: "data",
      type: "store",
      opens: "schema",
    });
    expect(m.services.q?.opens).toBeUndefined();
    expect(m.services.stripe).toMatchObject({
      lane: "outside",
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
    });
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

  it("--public build has no For developers text, code or evidence anywhere in data.json", () => {
    seed();
    const out = join(root, "site");
    build(root, dir, out, { public: true });
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

  it("a normal build keeps dev text and code", () => {
    seed();
    const out = join(root, "site");
    build(root, dir, out, {});
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
});
