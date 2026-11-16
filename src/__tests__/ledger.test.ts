import { describe, expect, it } from "vitest";
import { replay, validateSave, type Save } from "../legacy/ledger.ts";

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
