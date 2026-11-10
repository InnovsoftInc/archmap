import { describe, expect, it } from "vitest";
import { matchWatch, type WatchEntry } from "../watch.ts";

const watch: WatchEntry[] = [
  {
    paths: ["apps/api/src/routes/**"],
    means: "API endpoints",
    layer: "parts",
  },
  {
    paths: ["infra/**/*.tf"],
    means: "Hosting and Azure services",
    layer: "overview",
  },
  {
    paths: ["apps/*/package.json"],
    means: "Libraries and tools",
    layer: "parts",
  },
  {
    paths: ["**/migrations/**", "**/schema.prisma"],
    means: "Database tables and columns",
    layer: "data",
  },
];

describe("matchWatch", () => {
  it("groups changed files by watch entry", () => {
    const groups = matchWatch(
      ["apps/api/src/routes/users.ts", "infra/main.tf", "README.md"],
      watch,
    );
    expect(groups.map((g) => g.entry.means)).toEqual([
      "API endpoints",
      "Hosting and Azure services",
    ]);
    expect(groups[0]?.files).toEqual(["apps/api/src/routes/users.ts"]);
    expect(groups[1]?.files).toEqual(["infra/main.tf"]);
  });

  it("matches ** across folders and single-level *", () => {
    const libs = (file: string) =>
      matchWatch([file], watch).some(
        (g) => g.entry.means === "Libraries and tools",
      );
    expect(libs("apps/web/package.json")).toBe(true);
    expect(libs("apps/web/sub/package.json")).toBe(false);
    const data = matchWatch(["a/b/migrations/001.sql"], watch);
    expect(data.map((g) => g.entry.layer)).toEqual(["data"]);
  });

  it("lets a file match more than one entry", () => {
    const both: WatchEntry[] = [
      { paths: ["a/**"], means: "A", layer: "parts" },
      { paths: ["**/x.ts"], means: "X", layer: "data" },
    ];
    expect(matchWatch(["a/x.ts"], both).map((g) => g.entry.means)).toEqual([
      "A",
      "X",
    ]);
  });

  it("returns nothing for an empty watch list", () => {
    expect(matchWatch(["a.ts"], [])).toEqual([]);
  });
});
