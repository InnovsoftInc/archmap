import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMap, splitFrontmatter } from "../map/load.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const config = () => write("archmap.config.json", '{"name":"Test"}');

describe("loadMap", () => {
  it("loads every doc with its folder, id and frontmatter", () => {
    config();
    write(
      "services/api.md",
      "---\nname: API\nstatus: live\nkind: api\n---\nHandles requests.\n",
    );
    const m = loadMap(dir);
    expect(m.docs).toEqual([
      {
        id: "api",
        folder: "services",
        file: "services/api.md",
        data: { name: "API", status: "live", kind: "api" },
        body: "Handles requests.\n",
      },
    ]);
    expect(m.fileErrors).toEqual([]);
  });

  it("reports a file without frontmatter or with invalid YAML and keeps loading the rest", () => {
    config();
    write("services/a.md", "no frontmatter");
    write("services/b.md", "---\nname: [unclosed\n---\n");
    write(
      "stores/db.md",
      "---\nname: DB\nstatus: live\nkind: database\n---\nx\n",
    );
    const m = loadMap(dir);
    expect(m.docs.map((d) => d.id)).toEqual(["db"]);
    expect(m.fileErrors.map((e) => e.file)).toEqual([
      "services/a.md",
      "services/b.md",
    ]);
  });

  it("accepts CRLF line endings", () => {
    config();
    write("services/a.md", "---\r\nname: A\r\n---\r\nx");
    const m = loadMap(dir);
    expect(m.docs[0]?.data).toEqual({ name: "A" });
    expect(m.docs[0]?.body).toBe("x");
  });

  it("ignores non-.md files and files outside the five folders", () => {
    config();
    write("services/notes.txt", "x");
    write("other/x.md", "---\nname: X\n---\n");
    write("services/nested/y.md", "---\nname: Y\n---\n");
    const m = loadMap(dir);
    expect(m.docs).toEqual([]);
    expect(m.fileErrors).toEqual([]);
  });

  it("reads README.md and archmap.config.json; a missing config is a fileError", () => {
    write("README.md", "# Hello\n");
    const missing = loadMap(dir);
    expect(missing.readme).toBe("# Hello\n");
    expect(missing.fileErrors.map((e) => e.file)).toEqual([
      "archmap.config.json",
    ]);
    write("archmap.config.json", '{"name":"Shop","cli":"archmap"}');
    const m = loadMap(dir);
    expect(m.config).toEqual({ name: "Shop", cli: "archmap" });
    expect(m.fileErrors).toEqual([]);
  });

  it("sorts docs by folder order then id", () => {
    config();
    for (const p of ["flows/z", "services/b", "services/a", "stores/s"])
      write(p + ".md", "---\nname: n\n---\n");
    expect(loadMap(dir).docs.map((d) => d.file)).toEqual([
      "services/a.md",
      "services/b.md",
      "stores/s.md",
      "flows/z.md",
    ]);
  });
});

describe("splitFrontmatter", () => {
  it("returns an error when the closing line is missing or the YAML is not an object", () => {
    expect(splitFrontmatter("---\nname: A\n")).toHaveProperty("error");
    expect(splitFrontmatter("---\n- a\n- b\n---\n")).toHaveProperty("error");
  });
});

describe("loadMap config that is not an object", () => {
  it.each(["null", "[]", '"x"'])(
    "reports %s as a file error and uses the default config",
    (text) => {
      write("archmap.config.json", text);
      const m = loadMap(dir);
      expect(m.fileErrors).toEqual([
        { file: "archmap.config.json", message: "must be a JSON object" },
      ]);
      expect(m.config).toEqual({ name: "Architecture" });
    },
  );
});
