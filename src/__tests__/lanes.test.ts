import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANES,
  laneOf,
  laneProblems,
  lanesOf,
} from "../map/lanes.ts";
import type { Doc, Folder, MapConfig } from "../map/types.ts";
import { toViewModel } from "../view.ts";

const doc = (folder: Folder, id: string, data: Record<string, unknown>): Doc => ({
  id,
  folder,
  file: `${folder}/${id}.md`,
  data: { name: id, status: "live", ...data },
  body: "",
});
const config = (extra: Partial<MapConfig> = {}): MapConfig => ({
  name: "Test",
  ...extra,
});

describe("lanes", () => {
  it("places each file from its folder, kind and status", () => {
    const at = (d: Doc) => laneOf(d, DEFAULT_LANES);
    expect(at(doc("services", "web", { kind: "app" }))).toBe("frontend");
    expect(at(doc("services", "api", { kind: "api" }))).toBe("backend");
    expect(at(doc("services", "jobs", { kind: "job" }))).toBe("backend");
    expect(at(doc("stores", "db", { kind: "database" }))).toBe("backend");
    expect(at(doc("external", "azure", { kind: "hosting" }))).toBe("platform");
    expect(at(doc("external", "mail", { kind: "email" }))).toBe("third_party");
    expect(
      at(doc("external", "old", { kind: "other", status: "retiring" })),
    ).toBe("legacy");
  });

  it("uses a file's own lane, and falls back to the same side of the boundary when the project has no such lane", () => {
    const lanes = lanesOf(
      config({
        lanes: [
          { id: "apps", name: "Apps" },
          { id: "partners", name: "Partners", outside: true },
        ],
      }),
    );
    expect(lanes.map((l) => l.id)).toEqual(["apps", "partners"]);
    expect(laneOf(doc("services", "api", { kind: "api" }), lanes)).toBe("apps");
    expect(laneOf(doc("external", "mail", { kind: "email" }), lanes)).toBe(
      "partners",
    );
    expect(
      laneOf(doc("services", "api", { kind: "api", lane: "partners" }), lanes),
    ).toBe("partners");
  });

  it("falls back to the default lanes when the config's are unusable", () => {
    expect(lanesOf(config({ lanes: "x" }))).toBe(DEFAULT_LANES);
    expect(
      lanesOf(config({ lanes: [{ id: "out", name: "Out", outside: true }] })),
    ).toBe(DEFAULT_LANES);
  });

  it("reports malformed config lanes and files naming a lane that doesn't exist", () => {
    expect(
      laneProblems(
        config({
          lanes: [
            { id: "Bad Id", name: "X" },
            { id: "a", name: "" },
            { id: "a", name: "Again" },
          ],
        }),
        [doc("services", "api", { kind: "api", lane: "nowhere" })],
      ).map((p) => p.message),
    ).toEqual([
      "lanes[0].id must be lowercase letters, digits, - or _",
      "lanes[1].name must be a non-empty string",
      'lanes[2].id "a" is used twice',
      'lane "nowhere" isn\'t one of the map\'s lanes (a)',
    ]);
    expect(
      laneProblems(config(), [doc("services", "api", { lane: "backend" })]),
    ).toEqual([]);
  });

  it("gives the viewer one category per lane, with its purpose and side", () => {
    const m = toViewModel(
      [doc("external", "azure", { kind: "hosting" })],
      {},
      DEFAULT_LANES,
    );
    expect(m.categories.platform).toEqual({
      name: "Platform and delivery",
      order: 3,
      purpose: "How it's hosted, secured, monitored and deployed.",
      external: false,
    });
    expect(m.services.azure).toMatchObject({ lane: "platform" });
  });
});
