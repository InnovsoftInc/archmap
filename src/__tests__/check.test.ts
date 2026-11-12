import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCheck, runCheck } from "../check.ts";
import { HOME_REPO, VERSION } from "../home.ts";
import { unconfirmedLeads } from "../map/leads.ts";
import { scan } from "../scan/index.ts";
import { cliCommand, versionWarning } from "../version.ts";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  dir = join(root, "architecture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const config = (extra: Record<string, unknown> = {}) =>
  write(
    "architecture/archmap.config.json",
    JSON.stringify({ name: "Test", ...extra }),
  );
const api = (extra = "") =>
  write(
    "architecture/services/api.md",
    `---\nname: API\nstatus: live\nkind: api\n${extra}---\nServes requests.\n\n## How it works\n\nx\n\n## For developers\n\nx\n`,
  );
const repo = () =>
  write(
    "apps/api/src/routes.ts",
    'import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.send("ok"));\n',
  );
const messages = (r: { errors: { message: string }[] }) =>
  r.errors.map((e) => e.message);
const warnings = () => runCheck(root, dir).warnings.map((w) => w.message);

describe("runCheck", () => {
  it("reports schema, evidence and secret errors and exits not ok", () => {
    config();
    write(
      "architecture/services/api.md",
      '---\nname: API\nstatus: live\nkind: nope\nendpoints:\n  - route: GET /x\n    evidence: missing.ts\n---\npassword: "hunter2hunter2"\n',
    );
    const r = runCheck(root, dir);
    const all = messages(r).join("\n");
    expect(all).toContain("kind");
    expect(all).toContain("missing.ts does not exist");
    expect(all).toContain("looks like a assigned secret");
    const out = formatCheck(r, {});
    expect(out.ok).toBe(false);
    expect(out.lines.at(-1)).toMatch(/^\d+ problems\.$/);
  });

  it("reports a YAML error once, with its line, and no missing-id errors for that file", () => {
    config();
    write(
      "architecture/services/ci-cd.md",
      "---\nname: CI\nstatus: live\nkind: job\njobs:\n  - name: Lint\n    evidence: .github/workflows/lint.yml#name: Lint\n---\nx\n",
    );
    write(
      "architecture/flows/ship.md",
      "---\nname: Ship\nstatus: live\npersona: dev\nsteps:\n  - by: ci-cd\n    at: ci-cd\n    does: builds\n---\nx\n",
    );
    write(
      "architecture/personas/dev.md",
      "---\nname: Dev\nstatus: live\nneeds: [ship]\n---\nx\n",
    );
    const r = runCheck(root, dir);
    expect(r.map.failedIds).toEqual(["ci-cd"]);
    expect(
      r.errors.filter(
        (e) => e.file === "services/ci-cd.md" || e.message.includes("ci-cd"),
      ),
    ).toEqual([
      {
        file: "services/ci-cd.md",
        message:
          "invalid YAML at line 7: Nested mappings are not allowed in compact mappings",
      },
    ]);
  });

  it("reports secrets in the README and a config with no name", () => {
    write("architecture/archmap.config.json", "[]");
    write("architecture/README.md", "key AKIAABCDEFGHIJKLMNOP\n");
    const r = runCheck(root, dir);
    expect(r.errors).toContainEqual({
      file: "README.md",
      message: "looks like a aws key",
    });
    expect(
      r.errors.filter((e) => e.file === "archmap.config.json"),
    ).toHaveLength(1);
  });

  it("reports secrets in archmap.config.json", () => {
    config({ links: [{ label: "DB", url: "postgres://admin:hunter22@db/x" }] });
    expect(runCheck(root, dir).errors).toContainEqual({
      file: "archmap.config.json",
      message: "looks like a url with credentials",
    });
  });

  it("fails on an old save ledger that hasn't been migrated", () => {
    config();
    write("architecture/saves/0001.json", "{}\n");
    const r = runCheck(root, dir, {});
    expect(r.errors).toContainEqual({
      file: "",
      message: `This map uses the old save ledger. Run "${cliCommand(r.map.config, dir, root)} migrate" first.`,
    });
    expect(formatCheck(r, {}).ok).toBe(false);
    api();
    expect(
      messages(runCheck(root, dir)).some((m) => m.includes("save ledger")),
    ).toBe(false);
  });

  it("reports an unconfirmed route lead as a warning, ok unless --strict", () => {
    config();
    api();
    repo();
    const r = runCheck(root, dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContainEqual({
      file: "apps/api/src/routes.ts",
      message: "unconfirmed lead: route GET /health",
    });
    expect(formatCheck(r, {}).ok).toBe(true);
    expect(formatCheck(r, { strict: true }).ok).toBe(false);
  });

  it("confirms a lead by evidence file", () => {
    config();
    repo();
    api(
      "endpoints:\n  - route: GET /elsewhere\n    evidence: apps/api/src/routes.ts#health\n",
    );
    expect(warnings().filter((w) => w.includes("GET /health"))).toEqual([]);
  });

  it("drops leads listed in ignore", () => {
    config({ ignore: ["scan:route:GET /health@apps/api/src/routes.ts"] });
    api();
    repo();
    expect(warnings().filter((w) => w.includes("GET /health"))).toEqual([]);
  });

  it("keys leads by file, so ignoring one compose service leaves the other", () => {
    config({ ignore: ["scan:infra:service:api@docker-compose-dev.yml"] });
    api();
    const compose = "services:\n  api:\n    build: .\n";
    write("docker-compose.yml", compose);
    write("docker-compose-dev.yml", compose);
    expect(scan(root).infra.length).toBe(2);
    expect(
      runCheck(root, dir)
        .leads.map((l) => l.key)
        .filter((k) => k.startsWith("scan:infra:")),
    ).toEqual(["scan:infra:service:api@docker-compose.yml"]);
  });

  it("matches ignore entries as globs against lead keys", () => {
    api();
    write("infra/main.tf", 'resource "azurerm_key_vault" "main" {}\n');
    write("infra/db/pg.tf", 'resource "azurerm_postgresql" "db" {}\n');
    write("deploy/main.tf", 'resource "azurerm_key_vault" "other" {}\n');
    const infra = () =>
      runCheck(root, dir)
        .leads.map((l) => l.key)
        .filter((k) => k.startsWith("scan:infra:"));
    config({ ignore: ["scan:infra:*@infra/**"] });
    expect(infra()).toEqual([
      "scan:infra:azurerm_key_vault:other@deploy/main.tf",
    ]);
    // An entry without "@<file>" matches the lead in every file.
    config({ ignore: ["scan:infra:azurerm_key_vault:*"] });
    expect(infra()).toEqual([
      "scan:infra:azurerm_postgresql:db@infra/db/pg.tf",
    ]);
  });

  it("confirms infra, Docker and CI leads by a code entry of the file or a folder above it", () => {
    write("apps/api/Dockerfile", "FROM node:24\n");
    write("infra/pg.tf", 'resource "azurerm_postgresql" "db" {}\n');
    write(
      ".github/workflows/deploy.yml",
      "name: Deploy\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    );
    write("apps/api/src/server.ts", 'app.get("/health", h);\n');
    config();
    const leads = () =>
      runCheck(root, dir).leads.map((l) => `${l.file}: ${l.text}`);
    api();
    expect(leads()).toEqual([
      "apps/api/src/server.ts: route GET /health",
      "apps/api/Dockerfile: docker image apps/api",
      "infra/pg.tf: terraform azurerm_postgresql db",
      ".github/workflows/deploy.yml: CI workflow deploy.yml",
    ]);
    api("code:\n  - apps/api\n  - infra/pg.tf\n  - .github/workflows/\n");
    // Routes keep their own rule: a code entry doesn't confirm them.
    expect(leads()).toEqual(["apps/api/src/server.ts: route GET /health"]);
    // A sibling path with the same prefix is not a parent folder.
    api("code:\n  - apps/ap\n  - infra/pg\n");
    expect(leads()).toHaveLength(4);
  });

  it("prints json with errors and warnings", () => {
    config();
    api();
    repo();
    const out = formatCheck(runCheck(root, dir), { json: true });
    const parsed = JSON.parse(out.lines.join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["errors", "warnings"]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("lists which layers have content", () => {
    config();
    repo();
    write("schema.sql", "x");
    api(
      "endpoints:\n  - route: GET /health\n    evidence: apps/api/src/routes.ts\n",
    );
    write(
      "architecture/stores/db.md",
      "---\nname: DB\nstatus: live\nkind: database\ntables:\n  - name: users\n    evidence: schema.sql\n---\nHolds data.\n\n## How it works\n\nx\n\n## For developers\n\nx\n",
    );
    write(
      "architecture/personas/dev.md",
      "---\nname: Dev\nstatus: live\n---\nA developer.\n",
    );
    const lines = formatCheck(runCheck(root, dir), {}).lines;
    expect(
      lines.filter((l) => /^(overview|parts|data|people)/.test(l)),
    ).toEqual([
      "overview: 1 services, 1 stores, 0 external",
      "parts: 1 endpoints, 0 jobs",
      "data: 1 tables",
      "people and flows: 1 personas, 0 flows",
    ]);
    expect(lines.at(-1)).toBe("Map OK.");
  });
});

describe("unconfirmedLeads", () => {
  const doc = (
    folder: "services" | "stores" | "external",
    id: string,
    data: Record<string, unknown>,
  ) => ({ id, folder, file: `${folder}/${id}.md`, data, body: "" });

  it("matches routes ignoring method case and a trailing slash", () => {
    repo();
    const s = scan(root);
    const has = (route: string) =>
      unconfirmedLeads(
        s,
        [doc("services", "api", { endpoints: [{ route }] })],
        [],
      ).some(
        (l) => l.key === "scan:route:GET /health@apps/api/src/routes.ts",
      );
    expect(has("GET /health")).toBe(false);
    expect(has("GET /health/")).toBe(false);
    expect(has("GET /other")).toBe(true);
  });

  it("confirms by app code path, table name and external name", () => {
    const s = scan(root);
    s.apps.push({
      name: "api",
      path: "apps/api",
      deps: [],
      file: "apps/api/package.json",
    });
    s.tables.push({ name: "users", columns: [], file: "schema.prisma" });
    s.outside.push({ name: "SendGrid", via: "sdk", file: "mail.ts" });
    expect(unconfirmedLeads(s, [], []).map((l) => l.key)).toEqual([
      "scan:app:apps/api@apps/api/package.json",
      "scan:table:users@schema.prisma",
      "scan:outside:SendGrid@mail.ts",
    ]);
    expect(
      unconfirmedLeads(
        s,
        [
          doc("services", "api", { code: ["apps/api/src"] }),
          doc("stores", "db", { tables: [{ name: "users" }] }),
          doc("external", "sendgrid", { name: "Mail" }),
        ],
        [],
      ),
    ).toEqual([]);
    expect(
      unconfirmedLeads(s, [doc("external", "x", { name: "sendgrid" })], []).map(
        (l) => l.key,
      ),
    ).toEqual([
      "scan:app:apps/api@apps/api/package.json",
      "scan:table:users@schema.prisma",
    ]);
  });
});

describe("unconfirmedLeads: apps", () => {
  const svc = (code: string[]) => ({
    id: "x",
    folder: "services" as const,
    file: "services/x.md",
    data: { code },
    body: "",
  });
  const appLeads = (path: string, code: string[]) => {
    const s = scan(root);
    s.apps.push({ name: "a", path, deps: [], file: `${path}/package.json` });
    return unconfirmedLeads(s, [svc(code)], [])
      .map((l) => l.key.split("@")[0])
      .filter((k) => k.startsWith("scan:app:"));
  };

  it("confirms an app only by a code entry equal to its path or inside it", () => {
    expect(appLeads("apps/api", ["apps/api"])).toEqual([]);
    expect(appLeads("apps/api", ["apps/api/src"])).toEqual([]);
    expect(appLeads("apps/api", ["apps/api-gateway"])).toEqual([
      "scan:app:apps/api",
    ]);
    expect(appLeads("apps/api", ["old/apps/api"])).toEqual([
      "scan:app:apps/api",
    ]);
    expect(appLeads("apps/api", ["apps"])).toEqual(["scan:app:apps/api"]);
  });

  it("confirms the root app only by a code entry of .", () => {
    expect(appLeads(".", ["src/index.ts"])).toEqual(["scan:app:."]);
    expect(appLeads(".", ["apps/web"])).toEqual(["scan:app:."]);
    expect(appLeads(".", ["."])).toEqual([]);
  });
});

describe("version", () => {
  it("warns when the pinned version differs", () => {
    expect(versionWarning({ name: "T", archmap: "0.0.1" })).toBe(
      `archmap.config.json pins 0.0.1; this is ${VERSION}`,
    );
    expect(versionWarning({ name: "T", archmap: VERSION })).toBeNull();
    expect(versionWarning({ name: "T" })).toBeNull();
  });

  it("uses the pinned version, else the running one", () => {
    const at = (v: string) => `npx -y github:${HOME_REPO}#v${v}`;
    const d = join(root, "architecture");
    expect(cliCommand({ name: "T", archmap: "0.3.9" }, d, root)).toBe(
      at("0.3.9"),
    );
    expect(cliCommand({ name: "T" }, d, root)).toBe(at(VERSION));
  });

  it("appends --dir to the cli from the config off the default folder", () => {
    expect(
      cliCommand({ name: "T", cli: "archmap" }, join(root, "docs/map"), root),
    ).toBe("archmap --dir docs/map");
  });

  it("builds the cli command, with --dir only off the default folder", () => {
    const base = `npx -y github:${HOME_REPO}#v${VERSION}`;
    expect(cliCommand({ name: "T" }, join(root, "architecture"), root)).toBe(
      base,
    );
    expect(cliCommand({ name: "T" }, join(root, "docs/map"), root)).toBe(
      `${base} --dir docs/map`,
    );
    expect(
      cliCommand(
        { name: "T", cli: "archmap" },
        join(root, "architecture"),
        root,
      ),
    ).toBe("archmap");
  });
});
