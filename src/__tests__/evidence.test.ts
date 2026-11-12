import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evidenceOf,
  evidenceProblems,
  plannedWithEvidence,
} from "../map/evidence.ts";
import type { Doc } from "../map/types.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archmap-evidence-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const service = (data: Record<string, unknown>): Doc => ({
  id: "api",
  folder: "services",
  file: "services/api.md",
  data: { name: "API", status: "live", kind: "api", ...data },
  body: "",
});
const messages = (docs: Doc[]) =>
  evidenceProblems(root, docs).map((f) => f.message);

describe("evidenceOf", () => {
  it("lists every evidence with its field path, skipping columns without one", () => {
    const doc: Doc = {
      id: "db",
      folder: "stores",
      file: "stores/db.md",
      data: {
        connects: [{ to: "x", evidence: "a.ts" }],
        tables: [
          {
            name: "t",
            evidence: "s.ts",
            columns: [{ name: "a" }, { name: "b", evidence: "s.ts#b" }],
          },
        ],
        enums: [{ name: "e", evidence: "e.ts" }],
      },
      body: "",
    };
    expect(evidenceOf(doc)).toEqual([
      { field: "connects[0].evidence", evidence: "a.ts" },
      { field: "tables[0].evidence", evidence: "s.ts" },
      { field: "tables[0].columns[1].evidence", evidence: "s.ts#b" },
      { field: "enums[0].evidence", evidence: "e.ts" },
    ]);
  });
});

describe("evidenceProblems", () => {
  it("flags a missing evidence file", () => {
    const doc = service({
      connects: [{ to: "m", evidence: "apps/api/mail.ts" }],
    });
    expect(messages([doc])).toEqual([
      "connects[0].evidence apps/api/mail.ts does not exist",
    ]);
  });

  it("skips a planned connects entry, checking the rest", () => {
    const doc = service({
      connects: [
        { to: "m", status: "planned", evidence: "apps/api/later.ts" },
        { to: "n", evidence: "apps/api/mail.ts" },
      ],
    });
    expect(messages([doc])).toEqual([
      "connects[1].evidence apps/api/mail.ts does not exist",
    ]);
  });

  it("flags a symbol no longer in the file", () => {
    write("apps/api/c.ts", "export const list = 1;");
    const doc = service({
      endpoints: [{ route: "GET /x", evidence: "apps/api/c.ts#create" }],
    });
    expect(messages([doc])).toEqual([
      'endpoints[0].evidence: "create" not found in apps/api/c.ts',
    ]);
  });

  it("passes when the symbol appears", () => {
    write("apps/api/c.ts", "export const create = 1;");
    const doc = service({
      endpoints: [{ route: "GET /x", evidence: "apps/api/c.ts#create" }],
    });
    expect(messages([doc])).toEqual([]);
  });

  it("matches the symbol as a whole identifier", () => {
    write("apps/api/c.ts", "export const create = (createdAt) => {};");
    const cite = (symbol: string) =>
      service({
        endpoints: [{ route: "GET /x", evidence: `apps/api/c.ts#${symbol}` }],
      });
    expect(messages([cite("create")])).toEqual([]);
    write("apps/api/c.ts", "export const row = { createdAt: 1 };");
    expect(messages([cite("create")])).toEqual([
      'endpoints[0].evidence: "create" not found in apps/api/c.ts',
    ]);
    // Regex characters in a symbol are literal.
    write("apps/api/c.ts", "const x = a$b + 1;");
    expect(messages([cite("a$b")])).toEqual([]);
    expect(messages([cite("a.b")])).toEqual([
      'endpoints[0].evidence: "a.b" not found in apps/api/c.ts',
    ]);
  });

  it("rejects a symbol shorter than 3 characters", () => {
    write("apps/api/c.ts", "export const e = 1;");
    const doc = service({
      endpoints: [{ route: "GET /x", evidence: "apps/api/c.ts#e" }],
    });
    expect(messages([doc])).toEqual([
      'endpoints[0].evidence: "e" is too short to verify',
    ]);
  });

  it("rejects evidence that leaves the repo or is a folder", () => {
    write("apps/api/c.ts");
    const doc = service({
      jobs: [
        { name: "a", evidence: "../x.ts" },
        { name: "b", evidence: "/etc/passwd" },
        { name: "c", evidence: "apps/api" },
      ],
    });
    expect(messages([doc])).toEqual([
      "jobs[0].evidence ../x.ts must be a file inside the repo",
      "jobs[1].evidence /etc/passwd must be a file inside the repo",
      "jobs[2].evidence apps/api must be a file inside the repo",
    ]);
  });

  it("never reads through a symlink that points outside the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "archmap-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "root:x:0:0");
      write("apps/api/real.ts");
      symlinkSync(join(outside, "secret.txt"), join(root, "apps/api/x.ts"));
      symlinkSync(outside, join(root, "apps/linked"));
      const doc = service({
        code: ["apps/linked"],
        endpoints: [
          { route: "GET /x", evidence: "apps/api/x.ts#root" },
          { route: "GET /y", evidence: "apps/api/x.ts#nope" },
        ],
      });
      expect(messages([doc])).toEqual([
        "endpoints[0].evidence apps/api/x.ts#root must be a file inside the repo",
        "endpoints[1].evidence apps/api/x.ts#nope must be a file inside the repo",
        "code apps/linked must be inside the repo",
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("checks code paths exist (files or folders) unless the doc is planned", () => {
    write("apps/api/c.ts");
    const doc = service({ code: ["apps/api", "apps/api/c.ts", "apps/gone"] });
    expect(messages([doc])).toEqual(["code apps/gone does not exist"]);
    const planned = service({ status: "planned", code: ["apps/gone"] });
    expect(messages([planned])).toEqual([]);
  });

  it("skips evidence checks for planned docs but warns when their evidence exists", () => {
    write("apps/api/c.ts", "create");
    const planned = service({
      status: "planned",
      endpoints: [
        { route: "GET /x", evidence: "apps/api/c.ts#create" },
        { route: "GET /y", evidence: "apps/api/nope.ts" },
      ],
    });
    expect(messages([planned])).toEqual([]);
    expect(plannedWithEvidence(root, [planned])).toEqual([
      {
        file: "services/api.md",
        message:
          "endpoints[0].evidence apps/api/c.ts#create exists but the doc is still planned",
      },
    ]);
    expect(plannedWithEvidence(root, [service({})])).toEqual([]);
  });
});
