import { describe, expect, it } from "vitest";
import { isPlanned, schemaProblems } from "../map/schema.ts";
import type { Doc, Folder } from "../map/types.ts";

const BODY = "Intro.\n\n## How it works\nx\n\n## For developers\ny\n";
const doc = (
  folder: Folder,
  id: string,
  data: Record<string, unknown>,
  body = folder === "external" || folder === "personas" ? "Text." : BODY,
): Doc => ({ id, folder, file: `${folder}/${id}.md`, data, body });
const live = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  status: "live",
  ...extra,
});
const service = (id: string, extra: Record<string, unknown> = {}) =>
  doc("services", id, live(id, { kind: "api", ...extra }));
const store = (id: string, extra: Record<string, unknown> = {}) =>
  doc("stores", id, live(id, { kind: "database", ...extra }));
const messages = (docs: Doc[]) => schemaProblems(docs).map((f) => f.message);

describe("schemaProblems", () => {
  it("accepts a fully valid service, store, external, persona and flow", () => {
    const docs = [
      service("api", {
        code: ["apps/api"],
        connects: [{ to: "db", why: "reads", how: "sql", evidence: "a.ts" }],
        endpoints: [{ route: "GET /x", evidence: "a.ts#x" }],
        jobs: [{ name: "nightly", schedule: "0 1 * * *", evidence: "j.ts" }],
        libraries: [{ name: "zod", why: "validation" }],
      }),
      store("db", {
        tables: [
          {
            name: "users",
            group: "core",
            purpose: "people",
            evidence: "schema.ts",
            columns: [
              { name: "id", type: "uuid", pk: true },
              { name: "role", enum: "role", unique: false, desc: "r" },
              { name: "org", fk: "orgs.id" },
            ],
          },
          {
            name: "orgs",
            evidence: "schema.ts",
            columns: [{ name: "id", type: "uuid", pk: true }],
          },
        ],
        enums: [{ name: "role", values: ["a", "b"], evidence: "e.ts" }],
      }),
      doc("external", "mail", live("Mail", { kind: "email" })),
      doc(
        "personas",
        "admin",
        live("Admin", {
          roles: [{ name: "Owner", evidence: "r.ts" }],
          needs: ["n"],
        }),
      ),
      doc(
        "flows",
        "signup",
        live("Signup", {
          persona: "admin",
          steps: [{ by: "admin", at: "api", does: "signs up" }],
        }),
      ),
    ];
    expect(schemaProblems(docs)).toEqual([]);
  });

  it("accepts a planned service with an endpoint and no evidence", () => {
    const d = doc("services", "api", {
      name: "API",
      status: "planned",
      kind: "api",
      endpoints: [{ route: "GET /x" }],
    });
    expect(schemaProblems([d])).toEqual([]);
    expect(isPlanned(d)).toBe(true);
    expect(isPlanned(service("api"))).toBe(false);
  });

  it("requires a non-empty name", () => {
    const d = doc("services", "api", { status: "live", kind: "api" });
    expect(schemaProblems([d])).toContainEqual({
      file: "services/api.md",
      message: "name must be a non-empty string",
    });
  });

  it("requires a known status", () => {
    const d = doc("services", "api", {
      name: "A",
      status: "dead",
      kind: "api",
    });
    expect(messages([d])).toContain(
      'status "dead" must be one of live, planned, retiring',
    );
  });

  it("requires code to be a list of strings", () => {
    expect(messages([service("api", { code: "apps/api" })])).toContain(
      "code must be a list of strings",
    );
    expect(messages([service("api", { code: [1] })])).toContain(
      "code[0] must be a string",
    );
  });

  it("requires a well-formed id", () => {
    expect(messages([service("Bad_Id")])).toContain(
      'id "Bad_Id" must be lowercase letters, digits and dashes',
    );
  });

  it("rejects a duplicate id across folders", () => {
    expect(schemaProblems([service("db"), store("db")])).toContainEqual({
      file: "stores/db.md",
      message: 'id "db" is also used by services/db.md',
    });
  });

  it("checks service kind", () => {
    expect(messages([service("api", { kind: "thing" })])).toContain(
      'kind "thing" must be one of app, api, worker, job',
    );
  });

  it("checks connects entries", () => {
    expect(
      messages([service("api", { connects: [{ why: "x", evidence: "a" }] })]),
    ).toContain("connects[0].to must be a non-empty string");
    expect(messages([service("api", { connects: "db" })])).toContain(
      "connects must be a list",
    );
  });

  it("names the field of a bad endpoint route", () => {
    const d = service("api", {
      endpoints: [
        { route: "GET /ok", evidence: "a.ts" },
        { route: "get /x", evidence: "a.ts" },
      ],
    });
    expect(schemaProblems([d])).toContainEqual({
      file: "services/api.md",
      message: 'endpoints[1].route "get /x" must be METHOD /path',
    });
    expect(messages([d])).toHaveLength(1);
  });

  it("checks jobs and libraries entries", () => {
    const d = service("api", {
      jobs: [{ schedule: "daily", evidence: "j.ts" }],
      libraries: [{ why: "x" }],
    });
    expect(messages([d])).toEqual(
      expect.arrayContaining([
        "jobs[0].name must be a non-empty string",
        "libraries[0].name must be a non-empty string",
      ]),
    );
  });

  it("checks an endpoint's documentation: does, auth, params, body and returns", () => {
    const ok = service("api", {
      endpoints: [
        {
          route: "POST /a/:id",
          does: "Renames a thing.",
          auth: "signed-in staff",
          params: [{ name: "id", in: "path", type: "uuid", required: true }],
          body: [{ name: "name", type: "string", desc: "the new name" }],
          returns: "the thing",
          evidence: "a.ts",
        },
      ],
      jobs: [{ name: "nightly", does: "Cleans up.", evidence: "j.ts" }],
    });
    expect(messages([ok])).toEqual([]);
    const bad = service("api", {
      endpoints: [
        {
          route: "GET /a",
          params: [{ in: "cookie", required: "yes" }],
          body: [{ type: "string", example: "x" }],
          evidence: "a.ts",
        },
      ],
    });
    expect(messages([bad])).toEqual(
      expect.arrayContaining([
        "endpoints[0].params[0].name must be a non-empty string",
        'endpoints[0].params[0].in "cookie" must be one of path, query, header',
        "endpoints[0].params[0].required must be a boolean",
        'endpoints[0].body[0] has unknown key "example"',
        "endpoints[0].body[0].name must be a non-empty string",
      ]),
    );
  });

  it("checks env entries: a name, an optional why, and public as a boolean", () => {
    const ok = service("api", {
      env: [{ name: "API_KEY", why: "calls the partner API", public: false }],
    });
    expect(messages([ok])).toEqual([]);
    const bad = service("api", {
      env: [{ why: "x", public: "yes", value: "hunter2" }],
    });
    expect(messages([bad])).toEqual(
      expect.arrayContaining([
        'env[0] has unknown key "value"',
        "env[0].name must be a non-empty string",
        "env[0].public must be a boolean",
      ]),
    );
  });

  it("checks store kind, tables, columns and enums", () => {
    const d = store("db", {
      kind: "sql",
      tables: [
        {
          purpose: "p",
          evidence: "s.ts",
          columns: [{ type: "int" }, { name: "a", pk: "yes" }],
        },
      ],
      enums: [{ name: "e", values: "a" }],
    });
    expect(messages([d])).toEqual(
      expect.arrayContaining([
        'kind "sql" must be one of database, queue, bucket, cache',
        "tables[0].name must be a non-empty string",
        "tables[0].columns[0].name must be a non-empty string",
        "tables[0].columns[1].pk must be a boolean",
        "enums[0].values must be a list of strings",
      ]),
    );
  });

  it("requires a column enum to name an enum in the same store", () => {
    const tables = [
      { name: "t", evidence: "s.ts", columns: [{ name: "c", enum: "role" }] },
    ];
    const other = store("cache", {
      enums: [{ name: "role", values: ["a"], evidence: "e" }],
    });
    expect(messages([store("db", { tables }), other])).toContain(
      'tables[0].columns[0].enum "role" is not an enum in this store',
    );
  });

  it("requires a column fk to name a table in the same store, as table or table.column", () => {
    const tables = [
      { name: "users", evidence: "s.ts", columns: [{ name: "id" }] },
      {
        name: "orders",
        evidence: "s.ts",
        columns: [
          { name: "user_id", fk: "users.id" },
          { name: "owner", fk: "users" },
          { name: "shop_id", fk: "shops.id" },
        ],
      },
    ];
    const fkProblems = messages([store("db", { tables })]).filter((m) =>
      m.includes(".fk "),
    );
    expect(fkProblems).toEqual([
      'tables[1].columns[2].fk "shops.id" is not a table in this store',
    ]);
  });

  it("checks external kind", () => {
    const d = doc("external", "x", live("X", { kind: "mystery" }));
    expect(messages([d])).toContain(
      'kind "mystery" must be one of auth, email, payments, ai, hosting, secrets, monitoring, ci, dns, other',
    );
  });

  it("checks persona roles and needs", () => {
    const d = doc("personas", "p", live("P", { roles: [{}], needs: "money" }));
    expect(messages([d])).toEqual(
      expect.arrayContaining([
        "roles[0].name must be a non-empty string",
        "needs must be a list of strings",
      ]),
    );
  });

  it("resolves a flow's persona, steps' by and at", () => {
    const flow = doc(
      "flows",
      "f",
      live("F", {
        persona: "ghost",
        steps: [
          { by: "nobody", at: "api", does: "x" },
          { by: "api", at: "admin", does: "y" },
          { by: "admin", at: "api" },
        ],
      }),
    );
    const docs = [
      flow,
      service("api"),
      doc("personas", "admin", live("Admin")),
    ];
    expect(messages(docs)).toEqual(
      expect.arrayContaining([
        'persona "ghost" does not match a persona',
        'steps[0].by "nobody" does not match a persona or service',
        'steps[1].at "admin" does not match a service, store or external',
        "steps[2].does must be a non-empty string",
      ]),
    );
    expect(messages(docs)).toHaveLength(4);
  });

  it("resolves connects[].to", () => {
    const d = service("api", {
      connects: [{ to: "ghost", evidence: "a.ts" }],
    });
    expect(messages([d])).toContain(
      'connects[0].to "ghost" does not match a service, store or external',
    );
    const personaTarget = service("api", {
      connects: [{ to: "admin", evidence: "a" }],
    });
    expect(
      messages([personaTarget, doc("personas", "admin", live("A"))]),
    ).toContain(
      'connects[0].to "admin" does not match a service, store or external',
    );
  });

  it("lets external docs carry connects, resolved and evidenced like services", () => {
    const github = doc(
      "external",
      "github",
      live("GitHub", {
        kind: "hosting",
        connects: [
          { to: "acr", why: "pushes", evidence: "ci.yml" },
          { to: "ghost", evidence: "ci.yml" },
          { to: "api" },
        ],
      }),
    );
    const acr = doc("external", "acr", live("ACR", { kind: "hosting" }));
    expect(messages([github, acr, service("api")])).toEqual([
      "connects[2] needs evidence",
      'connects[1].to "ghost" does not match a service, store or external',
    ]);
  });

  it("validates a connects status and exempts planned entries from evidence", () => {
    const d = service("api", {
      connects: [
        { to: "db", status: "planned" },
        { to: "db", status: "live" },
        { to: "db", status: "soon", evidence: "a.ts" },
      ],
    });
    expect(messages([d, store("db")])).toEqual([
      'connects[2].status "soon" must be one of live, planned, retiring',
      "connects[1] needs evidence",
    ]);
  });

  it("requires evidence unless the doc is planned", () => {
    const d = service("api", {
      connects: [{ to: "api" }],
      endpoints: [{ route: "GET /x" }],
      jobs: [{ name: "j" }],
    });
    const p = doc("personas", "p", live("P", { roles: [{ name: "r" }] }));
    const s = store("db", {
      tables: [{ name: "t", columns: [{ name: "c" }] }],
    });
    expect(messages([d, p, s])).toEqual(
      expect.arrayContaining([
        "connects[0] needs evidence",
        "endpoints[0] needs evidence",
        "jobs[0] needs evidence",
        "roles[0] needs evidence",
        "tables[0] needs evidence",
      ]),
    );
    expect(messages([d, p, s]).filter((m) => m.includes("columns"))).toEqual(
      [],
    );
  });

  it("requires intro text and both headings on services, stores and flows", () => {
    const noIntro = doc(
      "services",
      "a",
      live("A", { kind: "api" }),
      "## How it works\nx\n## For developers\ny\n",
    );
    const noDevs = doc(
      "stores",
      "b",
      live("B", { kind: "cache" }),
      "Intro\n## How it works\nx\n",
    );
    const noHow = doc(
      "flows",
      "c",
      live("C", { persona: "p" }),
      "Intro\n## For developers\ny\n",
    );
    const personas = doc("personas", "p", live("P"));
    expect(schemaProblems([noIntro, noDevs, noHow, personas])).toEqual(
      expect.arrayContaining([
        {
          file: "services/a.md",
          message: "needs text before the first ## heading",
        },
        { file: "stores/b.md", message: "needs a ## For developers heading" },
        { file: "flows/c.md", message: "needs a ## How it works heading" },
      ]),
    );
  });

  it("requires text in external and personas bodies", () => {
    const e = doc("external", "x", live("X", { kind: "other" }), "  \n");
    const p = doc("personas", "p", live("P"), "");
    expect(schemaProblems([e, p])).toEqual(
      expect.arrayContaining([
        { file: "external/x.md", message: "needs a description in the body" },
        { file: "personas/p.md", message: "needs a description in the body" },
      ]),
    );
  });

  it("flags an unknown top-level key", () => {
    const d = service("api", { conects: [] });
    expect(schemaProblems([d])).toContainEqual({
      file: "services/api.md",
      message: 'unknown key "conects"',
    });
  });

  it("flags unknown keys inside list items, nested ones too", () => {
    const d = service("api", {
      connects: [{ to: "db", evidnce: "a.ts", evidence: "a.ts" }],
      endpoints: [{ route: "GET /x", evidence: "a.ts", note: "x" }],
    });
    const s = store("db", {
      tables: [
        {
          name: "t",
          evidence: "s.ts",
          columns: [{ name: "c", nullable: true }],
        },
      ],
    });
    expect(messages([d, s])).toEqual([
      'connects[0] has unknown key "evidnce"',
      'endpoints[0] has unknown key "note"',
      'tables[0].columns[0] has unknown key "nullable"',
    ]);
  });

  it("allows status only on connects entries, and exempts only planned connects from evidence", () => {
    const d = service("api", {
      endpoints: [{ route: "GET /x", status: "planned" }],
      jobs: [{ name: "j", status: "planned" }],
    });
    const p = doc(
      "personas",
      "p",
      live("P", { roles: [{ name: "r", status: "planned" }] }),
    );
    const s = store("db", { tables: [{ name: "t", status: "planned" }] });
    expect(messages([d, p, s])).toEqual([
      'endpoints[0] has unknown key "status"',
      'jobs[0] has unknown key "status"',
      "endpoints[0] needs evidence",
      "jobs[0] needs evidence",
      'roles[0] has unknown key "status"',
      "roles[0] needs evidence",
      'tables[0] has unknown key "status"',
      "tables[0] needs evidence",
    ]);
  });
});
