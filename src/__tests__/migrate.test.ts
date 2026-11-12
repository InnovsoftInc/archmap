import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, type Op } from "../core.ts";
import { VERSION } from "../home.ts";
import { loadMap } from "../map/load.ts";
import { schemaProblems } from "../map/schema.ts";
import type { Doc, Folder } from "../map/types.ts";
import { migrate } from "../migrate.ts";
import { loadProject } from "../project.ts";

const BCACS = join(import.meta.dirname, "fixtures", "bcacs-saves");

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  dir = join(root, "architecture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const add = (kind: string, id: string, value: Record<string, unknown>): Op => ({
  kind,
  id,
  op: "add",
  value,
  reason: "fixture",
});

const OPS: Op[] = [
  add("category", "frontend", {
    name: "Frontend",
    purpose: "What people use.",
  }),
  add("category", "backend", { name: "Backend", purpose: "The server side." }),
  add("area", "identity", { name: "Identity and access" }),
  add("enum", "user_role", { values: ["admin", "member"] }),
  add("table", "user_account", {
    area: "identity",
    purpose: "One row per login.",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "role", type: "user_role", enum: "user_role" },
      { name: "tags", type: "text", array: true, desc: "Labels." },
    ],
  }),
  // Top-level services, one per kind rule.
  add("service", "web_app", {
    name: "Web app",
    lane: "frontend",
    type: "app",
    status: "in build",
    purpose: "The browser app.",
    notes: "Served by the app container.",
    facts: [{ k: "Code", v: "apps/web" }],
    docs: [
      { label: "Code", url: "https://github.com/o/r/tree/main/apps/web" },
      { label: "Repo", url: "https://github.com/o/r" },
    ],
  }),
  add("service", "api", {
    name: "API",
    lane: "backend",
    type: "app",
    status: "live",
    purpose: "The server.",
    docs: [{ url: "https://github.com/o/r/blob/dev/apps/api/src/index.ts" }],
  }),
  add("service", "jobs", {
    name: "Jobs",
    lane: "backend",
    type: "job",
    status: "planned",
    purpose: "Scheduled work.",
  }),
  add("service", "storage", {
    name: "Storage",
    lane: "backend",
    type: "group",
    purpose: "A group.",
  }),
  add("service", "postgres", {
    name: "Database",
    lane: "backend",
    type: "store",
    parent: "storage",
    tech: "PostgreSQL",
    purpose: "Registry data.",
  }),
  add("service", "events", {
    name: "Event bus",
    lane: "backend",
    type: "store",
    purpose: "Events.",
  }),
  add("service", "blob", {
    name: "Files",
    lane: "backend",
    type: "store",
    parent: "storage",
    purpose: "Uploads.",
  }),
  add("service", "blob_uploads", {
    name: "Uploads container",
    lane: "backend",
    type: "container",
    parent: "blob",
    purpose: "Private uploads.",
  }),
  add("service", "old_db", {
    name: "Old reporting db",
    lane: "legacy",
    type: "store",
    tech: "Azure SQL",
    purpose: "Old copy.",
  }),
  add("service", "vault", {
    name: "Key Vault",
    lane: "platform",
    type: "platform",
    purpose: "Secrets.",
  }),
  add("service", "mailer", {
    name: "Mailer",
    lane: "third_party",
    type: "external",
    status: "retiring soon",
    purpose: "Sends email.",
  }),
  add("service", "old_portal", {
    name: "Old portal",
    lane: "legacy",
    type: "external",
    status: "live",
    purpose: "Today's portal.",
  }),
  // Parts.
  add("service", "api_endpoints", {
    name: "Endpoints",
    lane: "backend",
    type: "group",
    parent: "api",
  }),
  add("service", "ep_health", {
    name: "GET /api/v1/healthcheck",
    type: "endpoint",
    parent: "api_endpoints",
    purpose: "Health.",
  }),
  add("service", "ep_users", {
    name: "List users",
    type: "endpoint",
    parent: "api",
    purpose: "Lists users.",
  }),
  add("service", "mod_auth", {
    name: "Auth",
    type: "module",
    parent: "api_endpoints",
    purpose: "Endpoints to be designed",
  }),
  add("service", "lib_zod", {
    name: "Zod",
    type: "library",
    parent: "api",
    purpose: "Validation",
  }),
  add("service", "tool_vitest", {
    name: "Vitest",
    type: "tool",
    parent: "web_app",
    purpose: "Tests",
  }),
  add("service", "job_outbox", {
    name: "Email outbox sender",
    type: "job",
    parent: "jobs",
  }),
  // Connections.
  add("connection", "web->api", {
    from: "web_app",
    to: "api",
    label: "All app data",
    protocol: "HTTPS",
  }),
  add("connection", "ep->db", {
    from: "ep_users",
    to: "postgres",
    label: "Reads users",
    protocol: "SQL",
  }),
  add("connection", "api->db", {
    from: "api",
    to: "postgres",
    label: "Registry data",
    protocol: "SQL over TLS",
  }),
  add("connection", "api->api", { from: "ep_users", to: "api", label: "self" }),
  add("connection", "api->mail", { from: "api", to: "mailer", label: "Mail" }),
  // People.
  add("persona", "staff_admin", {
    name: "Staff admin",
    blurb: "Runs the registry.",
    jobs: [{ job: "Approve applications" }, { job: "Fix records" }],
  }),
  add("flow", "sign_in", {
    name: "Sign in",
    description: "A person signs in.",
    steps: [
      { from: "persona:staff_admin", to: "web_app", label: "Opens the app" },
      { from: "web_app", to: "api", label: "Posts credentials" },
      { from: "api", label: "Checks the password" },
    ],
  }),
];

const writeLedger = (ops = OPS) => {
  mkdirSync(join(dir, "saves"), { recursive: true });
  writeFileSync(
    join(dir, "archmap.config.json"),
    JSON.stringify({ name: "Shop", product: "Map" }),
  );
  writeFileSync(
    join(dir, "saves", "20260101-000000-all.json"),
    JSON.stringify({ at: "2026-01-01T00:00:00Z", summary: "all", ops }),
  );
};

const docs = (): Doc[] => loadMap(dir).docs;
const find = (folder: Folder, id: string): Doc => {
  const d = docs().find((x) => x.folder === folder && x.id === id);
  if (!d) throw new Error(`no ${folder}/${id}`);
  return d;
};
const ids = (folder: Folder) =>
  docs()
    .filter((d) => d.folder === folder)
    .map((d) => d.id);

describe("migrate", () => {
  it("refuses when saves/ is missing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "archmap.config.json"), '{"name":"x"}');
    const r = migrate(root, dir);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/saves/);
  });

  it("refuses when map files already exist", () => {
    writeLedger();
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "x.md"), "---\nname: x\n---\n");
    const r = migrate(root, dir);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/flows/);
    expect(existsSync(join(dir, "services"))).toBe(false);
  });

  it("sorts top-level services into folders and kinds, dropping groups", () => {
    writeLedger();
    expect(migrate(root, dir).ok).toBe(true);
    expect(ids("services").sort()).toEqual(["api", "jobs", "web-app"]);
    expect(find("services", "web-app").data.kind).toBe("app");
    expect(find("services", "api").data.kind).toBe("api");
    expect(find("services", "jobs").data.kind).toBe("job");
    expect(ids("stores").sort()).toEqual([
      "blob",
      "blob-uploads",
      "events",
      "old-db",
      "postgres",
    ]);
    expect(find("stores", "postgres").data.kind).toBe("database");
    expect(find("stores", "old-db").data.kind).toBe("database");
    expect(find("stores", "events").data.kind).toBe("queue");
    expect(find("stores", "blob").data.kind).toBe("bucket");
    expect(find("stores", "blob-uploads").data.kind).toBe("bucket");
    expect(ids("external").sort()).toEqual(["mailer", "old-portal", "vault"]);
    expect(find("external", "vault").data.kind).toBe("hosting");
    expect(find("external", "mailer").data.kind).toBe("other");
    expect(ids("services")).not.toContain("storage");
  });

  it("maps status: planned, retiring for legacy or retir*, else live", () => {
    writeLedger();
    migrate(root, dir);
    expect(find("services", "jobs").data.status).toBe("planned");
    expect(find("services", "web-app").data.status).toBe("live");
    expect(find("external", "mailer").data.status).toBe("retiring");
    expect(find("external", "old-portal").data.status).toBe("retiring");
    expect(find("stores", "old-db").data.status).toBe("retiring");
  });

  it("takes code paths from docs urls", () => {
    writeLedger();
    migrate(root, dir);
    expect(find("services", "web-app").data.code).toEqual(["apps/web"]);
    expect(find("services", "api").data.code).toEqual([
      "apps/api/src/index.ts",
    ]);
    expect(find("services", "jobs").data.code).toBeUndefined();
  });

  it("folds parts into their top-level service", () => {
    writeLedger();
    migrate(root, dir);
    const api = find("services", "api");
    expect(api.data.endpoints).toEqual([
      { route: "GET /api/v1/healthcheck" },
      { route: "GET /list-users" },
    ]);
    expect(api.data.libraries).toEqual([{ name: "Zod", why: "Validation" }]);
    expect(api.body).toContain("List users");
    expect(api.body).toContain("- **Auth**: Endpoints to be designed");
    expect(find("services", "web-app").data.libraries).toEqual([
      { name: "Vitest", why: "Tests" },
    ]);
    expect(find("services", "jobs").data.jobs).toEqual([
      { name: "Email outbox sender" },
    ]);
  });

  it("writes the body from purpose, notes, facts and modules", () => {
    writeLedger();
    migrate(root, dir);
    const web = find("services", "web-app").body;
    expect(web).toMatch(/^\s*The browser app\.\n/);
    const how = web.split("## How it works")[1].split("## For developers")[0];
    expect(how).toContain("Served by the app container.");
    expect(how).toContain("- **Code**: apps/web");
    expect(how.indexOf("Served by")).toBeLessThan(how.indexOf("**Code**"));
    expect(web.split("## For developers")[1].trim()).toBe("_To be written._");
    expect(find("external", "mailer").body).toContain("Sends email.");
    expect(find("personas", "staff-admin").body).toContain(
      "Runs the registry.",
    );
    expect(find("flows", "sign-in").body).toContain("A person signs in.");
  });

  it("lifts connections to top-level ancestors, dropping self and duplicate ones", () => {
    writeLedger();
    migrate(root, dir);
    expect(find("services", "api").data.connects).toEqual([
      { to: "postgres", why: "Reads users", how: "SQL" },
      { to: "mailer", why: "Mail" },
    ]);
    expect(find("services", "web-app").data.connects).toEqual([
      { to: "api", why: "All app data", how: "HTTPS" },
    ]);
  });

  it("puts tables and enums on the first non-legacy database", () => {
    writeLedger();
    migrate(root, dir);
    const pg = find("stores", "postgres");
    expect(pg.data.enums).toEqual([
      { name: "user_role", values: ["admin", "member"] },
    ]);
    expect(pg.data.tables).toEqual([
      {
        name: "user_account",
        group: "Identity and access",
        purpose: "One row per login.",
        columns: [
          { name: "id", type: "uuid", pk: true },
          { name: "role", type: "user_role", enum: "user_role" },
          { name: "tags", type: "text[]", desc: "Labels." },
        ],
      },
    ]);
    expect(find("stores", "old-db").data.tables).toBeUndefined();
  });

  it("migrates personas and flows", () => {
    writeLedger();
    migrate(root, dir);
    const p = find("personas", "staff-admin");
    expect(p.data).toMatchObject({
      name: "Staff admin",
      status: "live",
      roles: [],
      needs: ["Approve applications", "Fix records"],
    });
    const f = find("flows", "sign-in");
    expect(f.data.persona).toBe("staff-admin");
    expect(f.data.steps).toEqual([
      { by: "staff-admin", at: "web-app", does: "Opens the app" },
      { by: "web-app", at: "api", does: "Posts credentials" },
      { by: "api", at: "api", does: "Checks the password" },
    ]);
  });

  it("pins the config, writes a README and reports counts", () => {
    writeLedger();
    const r = migrate(root, dir);
    const config = JSON.parse(
      readFileSync(join(dir, "archmap.config.json"), "utf8"),
    );
    expect(config).toEqual({ name: "Shop", product: "Map", archmap: VERSION });
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Shop");
    expect(readme).toContain("Frontend");
    expect(readme).toContain("What people use.");
    const text = r.lines.join("\n");
    expect(text).toMatch(/3 services/);
    expect(text).toMatch(/5 stores/);
    expect(text).toMatch(/3 external/);
    expect(text).toMatch(/1 personas/);
    expect(text).toMatch(/1 flows/);
    expect(r.lines.at(-1)).toBe("Next: run brief --task review");
  });

  it("keeps an existing README", () => {
    writeLedger();
    writeFileSync(join(dir, "README.md"), "mine");
    migrate(root, dir);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("mine");
  });

  it("writes docs that pass schema checks except evidence", () => {
    writeLedger();
    migrate(root, dir);
    const problems = schemaProblems(docs()).filter(
      (p) => !p.message.includes("evidence"),
    );
    expect(problems).toEqual([]);
  });

  it("migrates a copy of bcacs's saves into docs that pass schema checks except evidence presence", () => {
    cpSync(BCACS, dir, { recursive: true });
    expect(migrate(root, dir).ok).toBe(true);
    const problems = schemaProblems(loadMap(dir).docs).filter(
      (p) => !p.message.includes("evidence"),
    );
    expect(problems).toEqual([]);
  });

  it("keeps every old table, enum, persona and flow", () => {
    cpSync(BCACS, dir, { recursive: true });
    const m = replay(loadProject(dir).saves);
    migrate(root, dir);
    const all = docs();
    const stores = all.filter((d) => d.folder === "stores");
    const count = (key: "tables" | "enums") =>
      stores.reduce((n, d) => {
        const list: unknown = Reflect.get(d.data, key);
        return n + (Array.isArray(list) ? list.length : 0);
      }, 0);
    expect(count("tables")).toBe(Object.keys(m.tables).length);
    expect(count("enums")).toBe(Object.keys(m.enums).length);
    expect(all.filter((d) => d.folder === "personas")).toHaveLength(
      Object.keys(m.personas).length,
    );
    expect(all.filter((d) => d.folder === "flows")).toHaveLength(
      Object.keys(m.flows).length,
    );
  });
});
