import { describe, expect, it } from "vitest";
import {
  buildVersions,
  checkModel,
  layerReport,
  nextLayer,
  replay,
  stepConnected,
  validateSave,
  type Save,
} from "../core.ts";

const save = (id: string, at: string, ops: Save["ops"]): Save => ({
  id,
  at,
  summary: id,
  ops,
});

const base = save("a", "2026-01-01T00:00:00Z", [
  {
    kind: "category",
    id: "backend",
    op: "add",
    value: { name: "Backend" },
    reason: "r",
  },
  {
    kind: "service",
    id: "api",
    op: "add",
    value: { name: "API", lane: "backend" },
    reason: "r",
  },
  {
    kind: "service",
    id: "db",
    op: "add",
    value: { name: "DB", lane: "backend", type: "store" },
    reason: "r",
  },
  {
    kind: "connection",
    id: "api->db",
    op: "add",
    value: { from: "api", to: "db", label: "Reads" },
    reason: "r",
  },
  {
    kind: "table",
    id: "person",
    op: "add",
    value: { area: "x", columns: [{ name: "id", type: "uuid", pk: true }] },
    reason: "r",
  },
]);

describe("replay", () => {
  it("applies saves oldest first, whatever order they come in", () => {
    const later = save("b", "2026-02-01T00:00:00Z", [
      {
        kind: "service",
        id: "api",
        op: "update",
        value: { status: "live" },
        reason: "r",
      },
    ]);
    const m = replay([later, base]);
    expect(m.services.api).toMatchObject({ name: "API", status: "live" });
    expect(m.problems).toEqual([]);
  });

  it("adds, updates and removes columns inside their table, keeping order", () => {
    const cols = save("b", "2026-02-01T00:00:00Z", [
      {
        kind: "column",
        id: "person.name",
        op: "add",
        value: { type: "text" },
        reason: "r",
      },
      {
        kind: "column",
        id: "person.email",
        op: "add",
        value: { type: "text", after: "id" },
        reason: "r",
      },
      {
        kind: "column",
        id: "person.name",
        op: "update",
        value: { desc: "Legal name" },
        reason: "r",
      },
      { kind: "column", id: "person.email", op: "remove", reason: "r" },
    ]);
    const m = replay([base, cols]);
    expect(m.tables.person.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(m.tables.person.columns[1].desc).toBe("Legal name");
  });

  it("records changes that can't apply as problems instead of throwing", () => {
    const bad = save("b", "2026-02-01T00:00:00Z", [
      {
        kind: "service",
        id: "ghost",
        op: "update",
        value: { name: "x" },
        reason: "r",
      },
      { kind: "service", id: "api", op: "add", value: {}, reason: "r" },
      { kind: "column", id: "nope.x", op: "add", value: {}, reason: "r" },
      { kind: "widget", id: "w", op: "add", value: {}, reason: "r" },
    ]);
    const m = replay([base, bad]);
    expect(m.problems).toHaveLength(4);
    expect(m.problems[0]).toContain("ghost doesn't exist to update");
  });

  it("replays only the saves a version includes", () => {
    const later = save("b", "2026-02-01T00:00:00Z", [
      {
        kind: "service",
        id: "web",
        op: "add",
        value: { name: "Web" },
        reason: "r",
      },
    ]);
    const m = replay([base, later], { a: true });
    expect(m.services.web).toBeUndefined();
  });
});

describe("buildVersions", () => {
  it("orders versions by publish date, accumulates saves, and puts unpublished saves in a draft", () => {
    const saves = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const vs = buildVersions(saves, [
      {
        id: "s2",
        name: "Sprint 2",
        published_at: "2026-03-01T00:00:00Z",
        saves: ["b"],
      },
      {
        id: "s1",
        name: "Sprint 1",
        published_at: "2026-02-01T00:00:00Z",
        saves: ["a"],
      },
    ]);
    expect(vs.map((v) => v.name)).toEqual(["Sprint 1", "Sprint 2", "Draft"]);
    expect(Object.keys(vs[1].set).sort()).toEqual(["a", "b"]);
    expect(vs[2].draftIds).toEqual(["c"]);
  });

  it("has no draft when every save is published", () => {
    const vs = buildVersions(
      [{ id: "a" }],
      [
        {
          id: "s1",
          name: "Sprint 1",
          published_at: "2026-02-01T00:00:00Z",
          saves: ["a"],
        },
      ],
    );
    expect(vs.some((v) => v.draft)).toBe(false);
  });
});

describe("validateSave", () => {
  it("accepts a well-formed save", () => {
    expect(
      validateSave(
        {
          at: "2026-01-01T00:00:00Z",
          ops: [
            { kind: "service", id: "x", op: "add", value: {}, reason: "why" },
          ],
        },
        "s",
      ),
    ).toEqual([]);
  });

  it("names each problem, including a missing reason", () => {
    const errors = validateSave(
      { at: "yesterday", ops: [{ kind: "thing", op: "move", reason: " " }] },
      "s",
    );
    expect(errors.join("\n")).toMatch(/ISO 8601/);
    expect(errors.join("\n")).toMatch(/unknown kind thing/);
    expect(errors.join("\n")).toMatch(/"id" is required/);
    expect(errors.join("\n")).toMatch(/add, update or remove/);
    expect(errors.join("\n")).toMatch(/needs a "reason"/);
  });

  it("rejects ids that would reach Object.prototype", () => {
    const errors = validateSave(
      {
        at: "2026-01-01T00:00:00Z",
        ops: [
          {
            kind: "column",
            id: "person.__proto__",
            op: "add",
            value: {},
            reason: "r",
          },
        ],
      },
      "s",
    );
    expect(errors[0]).toMatch(/can't be used as an id/);
  });

  it("rejects an empty save", () => {
    expect(
      validateSave({ at: "2026-01-01T00:00:00Z", ops: [] }, "s")[0],
    ).toMatch(/non-empty/);
  });
});

describe("checkModel", () => {
  it("is clean for a consistent model", () => {
    expect(checkModel(replay([base]))).toEqual([]);
  });

  it("finds links to things that don't exist", () => {
    const broken = save("b", "2026-02-01T00:00:00Z", [
      { kind: "service", id: "db", op: "remove", reason: "r" },
      {
        kind: "service",
        id: "part",
        op: "add",
        value: { name: "Part", lane: "nowhere", parent: "gone" },
        reason: "r",
      },
      {
        kind: "column",
        id: "person.org",
        op: "add",
        value: { fk: "org", enum: "kinds" },
        reason: "r",
      },
      {
        kind: "persona",
        id: "op",
        op: "add",
        value: {
          uses: [{ to: "web" }],
          jobs: [{ job: "Log hours", t: { logbook: "w" } }],
        },
        reason: "r",
      },
      {
        kind: "flow",
        id: "f",
        op: "add",
        value: {
          steps: [
            { from: "persona:op", to: "api" },
            { from: "api", to: "nowhere" },
          ],
        },
        reason: "r",
      },
    ]);
    const text = checkModel(replay([base, broken])).join("\n");
    expect(text).toMatch(/Connection api->db: db doesn't exist/);
    expect(text).toMatch(/parent gone doesn't exist/);
    expect(text).toMatch(/category nowhere doesn't exist/);
    expect(text).toMatch(/missing table org/);
    expect(text).toMatch(/enum kinds doesn't exist/);
    expect(text).toMatch(/uses missing service web/);
    expect(text).toMatch(/uses missing table logbook/);
    expect(text).toMatch(/Flow f step 1: no recorded connection/);
    expect(text).toMatch(/Flow f step 2: nowhere doesn't exist/);
  });
});

describe("stepConnected", () => {
  it("accepts a connection in either direction and a persona's use", () => {
    const m = replay([
      base,
      save("b", "2026-02-01T00:00:00Z", [
        {
          kind: "persona",
          id: "op",
          op: "add",
          value: { uses: [{ to: "api" }] },
          reason: "r",
        },
      ]),
    ]);
    expect(stepConnected(m, { from: "db", to: "api" })).toBe(true);
    expect(stepConnected(m, { from: "persona:op", to: "api" })).toBe(true);
    expect(stepConnected(m, { from: "api", to: "persona:op" })).toBe(true);
    expect(stepConnected(m, { from: "persona:op", to: "db" })).toBe(false);
  });
});

describe("layerReport", () => {
  it("counts each layer and names the first empty one", () => {
    const m = replay([base]);
    expect(layerReport(m)).toEqual([
      { layer: "overview", count: 2 },
      { layer: "parts", count: 0 },
      { layer: "data", count: 1 },
      { layer: "people", count: 0 },
    ]);
    expect(nextLayer(m)).toBe("parts");
  });

  it("returns null once every layer has content", () => {
    const full = save("b", "2026-01-02T00:00:00Z", [
      {
        kind: "service",
        id: "worker",
        op: "add",
        value: { name: "Worker", lane: "backend", parent: "api" },
        reason: "r",
      },
      {
        kind: "persona",
        id: "admin",
        op: "add",
        value: { name: "Admin" },
        reason: "r",
      },
    ]);
    const m = replay([base, full]);
    expect(layerReport(m).map((l) => l.count)).toEqual([2, 1, 1, 1]);
    expect(nextLayer(m)).toBeNull();
  });
});
