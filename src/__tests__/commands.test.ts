import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  check,
  init,
  newSave,
  publish,
  scanCommand,
  snapshot,
} from "../commands.ts";
import { build, serve } from "../site.ts";

let root: string;
let dir: string;
const now = new Date("2026-11-20T18:04:00Z");

beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  dir = join(root, "architecture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const json = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const writeSave = (id: string, ops: unknown[], at = "2026-11-21T00:00:00Z") =>
  writeFileSync(
    join(dir, "saves", id + ".json"),
    JSON.stringify({ at, summary: id, ops }),
  );

describe("scanCommand", () => {
  it("prints the scan with its stage, or only the watch list", () => {
    const text = scanCommand(root).lines.join("\n");
    expect(JSON.parse(text)).toMatchObject({ stage: "planning", apps: [] });
    expect(JSON.parse(scanCommand(root, { watch: true }).lines[0])).toEqual([]);
  });
});

describe("init", () => {
  it("creates the folder, a valid starter save and the Claude skill", () => {
    const r = init(dir, { name: "Acme", repoRoot: root, now });
    expect(r.ok).toBe(true);
    expect(json(join(dir, "archmap.config.json")).name).toBe("Acme");
    expect(readdirSync(join(dir, "saves"))).toEqual([
      "20261120-180400-starter-categories.json",
    ]);
    expect(existsSync(join(root, ".claude/skills/archmap/SKILL.md"))).toBe(
      true,
    );
    expect(check(dir).ok).toBe(true);
  });

  it("init can leave the skill to the plugin", () => {
    init(dir, { repoRoot: root, now, skill: false });
    expect(existsSync(join(root, ".claude/skills/archmap/SKILL.md"))).toBe(
      false,
    );
  });

  it("writes the proposed watch list into the config", () => {
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    writeFileSync(join(root, "src", "routes", "a.ts"), 'r.get("/a", h);\n');
    init(dir, { repoRoot: root, now });
    expect(json(join(dir, "archmap.config.json")).watch).toEqual([
      { paths: ["src/routes/**"], means: "API endpoints", layer: "parts" },
    ]);
  });

  it("adds the archmap scripts and keeps existing ones", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "archmap:check": "custom" } }),
    );
    init(dir, { repoRoot: root, now });
    expect(json(join(root, "package.json")).scripts).toEqual({
      archmap: "node .archmap/bin/archmap.mjs",
      "archmap:dev": "node .archmap/bin/archmap.mjs dev",
      "archmap:check": "custom",
      "archmap:drift": "node .archmap/bin/archmap.mjs drift",
      "archmap:claude": "node .archmap/bin/archmap.mjs claude",
    });
  });

  it("passes --dir when the folder isn't architecture", () => {
    writeFileSync(join(root, "package.json"), "{}");
    init(join(root, "docs", "map"), { repoRoot: root, now });
    expect(json(join(root, "package.json")).scripts).toMatchObject({
      archmap: "node .archmap/bin/archmap.mjs",
      "archmap:dev": "node .archmap/bin/archmap.mjs dev --dir docs/map",
      "archmap:check": "node .archmap/bin/archmap.mjs check --dir docs/map",
      "archmap:drift": "node .archmap/bin/archmap.mjs drift --dir docs/map",
      "archmap:claude": "node .archmap/bin/archmap.mjs claude",
    });
  });

  it("warns and still finishes when package.json is malformed", () => {
    writeFileSync(join(root, "package.json"), "{ nope");
    const r = init(dir, { repoRoot: root, now });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("Skipped the archmap scripts");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{ nope");
    expect(check(dir).ok).toBe(true);
  });

  it("warns when scripts isn't an object", () => {
    writeFileSync(join(root, "package.json"), '{"scripts":"x"}');
    const r = init(dir, { repoRoot: root, now });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("Skipped the archmap scripts");
    expect(existsSync(join(dir, "archmap.config.json"))).toBe(true);
  });

  it("init works without a package.json", () => {
    expect(init(dir, { repoRoot: root, now }).ok).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(false);
  });

  it("refuses to overwrite an existing map", () => {
    init(dir, { repoRoot: root, now });
    expect(init(dir, { repoRoot: root, now }).ok).toBe(false);
  });
});

describe("check", () => {
  beforeEach(() => init(dir, { repoRoot: root, now }));

  it("lists the layers and the next one to set up", () => {
    expect(check(dir).lines).toEqual([
      expect.stringMatching(/^OK: /),
      "Layers: overview 0 · parts 0 · data 0 · people 0. Next: /archmap:setup overview",
    ]);
  });

  it("reports broken files and broken links, and fails", () => {
    writeSave("bad-shape", [
      { kind: "service", id: "x", op: "add", value: {} },
    ]);
    writeSave("dangling", [
      {
        kind: "connection",
        id: "a->b",
        op: "add",
        value: { from: "a", to: "b" },
        reason: "r",
      },
    ]);
    const r = check(dir);
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toMatch(/bad-shape op 1: every change needs a "reason"/);
    expect(text).toMatch(/Connection a->b: a doesn't exist/);
    expect(r.lines.at(-1)).toMatch(/^Layers: overview 0 /);
  });
});

describe("save, publish and snapshot", () => {
  beforeEach(() => init(dir, { repoRoot: root, now }));

  it("starts a named save file for filling in", () => {
    const r = newSave(dir, {
      summary: "Add the API",
      author: "Minte via Claude",
      now: new Date("2026-11-21T09:00:00Z"),
    });
    expect(r.ok).toBe(true);
    const file = join(dir, "saves", "20261121-090000-add-the-api.json");
    expect(json(file)).toMatchObject({
      summary: "Add the API",
      author: "Minte via Claude",
      ops: [],
    });
  });

  it("publishes the draft as a version and writes the current state", () => {
    writeSave("api", [
      {
        kind: "service",
        id: "api",
        op: "add",
        value: { name: "API", lane: "backend" },
        reason: "r",
      },
    ]);
    const r = publish(dir, "Sprint 1", { summary: "First cut", now });
    expect(r.ok).toBe(true);
    const versions = json(join(dir, "versions.json")).versions as {
      id: string;
      saves: string[];
    }[];
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe("sprint-1");
    expect(versions[0].saves).toHaveLength(2);
    const current = json(join(dir, "current.json"));
    expect(current.latest_published).toBe("Sprint 1");
    expect((current.services as Record<string, unknown>).api).toBeDefined();
    expect(publish(dir, "Sprint 2").ok).toBe(false);
  });

  it("won't publish a draft with problems", () => {
    writeSave("dangling", [
      {
        kind: "connection",
        id: "a->b",
        op: "add",
        value: { from: "a", to: "b" },
        reason: "r",
      },
    ]);
    const r = publish(dir, "Sprint 1");
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/Fix these before publishing/);
    expect(existsSync(join(dir, "current.json"))).toBe(false);
  });

  it("writes a snapshot with the unpublished count", () => {
    snapshot(dir);
    expect(json(join(dir, "current.json"))).toMatchObject({
      latest_published: null,
      unpublished_saves: 1,
    });
  });
});

describe("site", () => {
  beforeEach(() => init(dir, { repoRoot: root, now }));

  it("builds a static site whose core.js is plain JavaScript", () => {
    const out = join(root, "site");
    build(dir, out);
    expect(readdirSync(out).sort()).toEqual([
      "app.js",
      "core.js",
      "data.json",
      "index.html",
      "styles.css",
    ]);
    const core = readFileSync(join(out, "core.js"), "utf8");
    expect(core).toContain("export const replay");
    expect(core).not.toMatch(/: Model\b/);
    const data = json(join(out, "data.json"));
    expect(data.config).toMatchObject({ name: "My platform" });
    expect((data.saves as unknown[]).length).toBe(1);
  });

  it("serves fresh data in dev mode", async () => {
    const server = await serve(dir, 0);
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
    writeSave("api", [
      {
        kind: "service",
        id: "api",
        op: "add",
        value: { name: "API" },
        reason: "r",
      },
    ]);
    const second = JSON.parse((await get("/data.json")).body) as {
      rev: string;
    };
    expect(second.rev).not.toBe(first.rev);
    expect((await get("/index.html")).status).toBe(200);
    expect((await get("/secret.txt")).status).toBe(404);
    await new Promise((resolve) => server.close(resolve));
  });
});
