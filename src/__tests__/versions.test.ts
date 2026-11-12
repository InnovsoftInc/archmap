import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Doc } from "../map/types.ts";
import { latestVersions } from "../registry.ts";
import { freshness, libraryVersions } from "../versions.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archmap-versions-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const api = (libraries: unknown[], code = ["apps/api"]): Doc => ({
  id: "api",
  folder: "services",
  file: "services/api.md",
  data: { name: "API", status: "live", kind: "api", code, libraries },
  body: "",
});

describe("libraryVersions", () => {
  it("reads versions from the package.json under the service's code, by package or by name", () => {
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", "package.json"),
      JSON.stringify({
        dependencies: { express: "^5.1.0", pino: "^9.6.0" },
        devDependencies: { "@types/node": "^24.0.0" },
      }),
    );
    const v = libraryVersions(root, [
      api([
        { name: "Express" },
        { name: "Logging", package: "pino" },
        { name: "Node types", package: "@types/node" },
        { name: "Zod" },
      ]),
    ]);
    expect(v).toEqual({
      "api.lib-0": { package: "express", declared: "^5.1.0" },
      "api.lib-1": { package: "pino", declared: "^9.6.0" },
      "api.lib-2": { package: "@types/node", declared: "^24.0.0" },
    });
  });

  it("gives nothing when the service has no readable manifest", () => {
    expect(libraryVersions(root, [api([{ name: "Express" }])])).toEqual({});
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    writeFileSync(join(root, "apps", "api", "package.json"), "{ not json");
    expect(libraryVersions(root, [api([{ name: "Express" }])])).toEqual({});
  });
});

describe("freshness", () => {
  it.each([
    ["^5.1.0", "5.1.0", "ok"],
    ["^5.1.0", "5.1.3", "patch"],
    ["~5.0.2", "5.2.0", "minor"],
    ["^4.18.2", "5.1.0", "major"],
    ["6.0.0", "5.1.0", "ok"],
    ["workspace:*", "5.1.0", undefined],
  ])("%s against %s is %s", (declared, latest, want) => {
    expect(freshness(declared, latest)).toBe(want);
  });
});

describe("latestVersions", () => {
  const cacheFile = () => join(root, "cache.json");
  const registry = (versions: Record<string, string>) => {
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      const name = decodeURIComponent(
        url.replace("https://registry.npmjs.org/", "").replace("/latest", ""),
      );
      const v: unknown = Reflect.get(versions, name);
      return v
        ? new Response(JSON.stringify({ version: v }))
        : new Response("", { status: 404 });
    }) as typeof fetch;
    return { get, asked };
  };

  it("asks the registry once per package, escaping scopes, and caches the answers for a day", async () => {
    const r = registry({ express: "5.1.0", "@types/node": "24.1.0" });
    const now = 1_000_000;
    expect(
      await latestVersions(["express", "@types/node", "nope", "express"], {
        fetch: r.get,
        cacheFile: cacheFile(),
        now,
      }),
    ).toEqual({ express: "5.1.0", "@types/node": "24.1.0" });
    expect(r.asked.sort()).toEqual([
      "https://registry.npmjs.org/@types%2fnode/latest",
      "https://registry.npmjs.org/express/latest",
      "https://registry.npmjs.org/nope/latest",
    ]);
    const again = registry({});
    expect(
      await latestVersions(["express"], {
        fetch: again.get,
        cacheFile: cacheFile(),
        now: now + 1000,
      }),
    ).toEqual({ express: "5.1.0" });
    expect(again.asked).toEqual([]);
  });

  it("asks nothing offline and survives a failing registry", async () => {
    const r = registry({ express: "5.1.0" });
    expect(
      await latestVersions(["express"], {
        offline: true,
        fetch: r.get,
        cacheFile: cacheFile(),
      }),
    ).toEqual({});
    expect(r.asked).toEqual([]);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(
      await latestVersions(["express"], {
        fetch: failing,
        cacheFile: cacheFile(),
      }),
    ).toEqual({});
  });
});
