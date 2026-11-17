import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_REPO } from "../home.ts";
import {
  available,
  highestTag,
  latestRelease,
  newer,
  notice,
  upgrade,
} from "../upgrade.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archmap-upgrade-"));
  mkdirSync(join(root, "architecture"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dir = () => join(root, "architecture");
const configFile = () => join(dir(), "archmap.config.json");
const setConfig = (config: object) =>
  writeFileSync(configFile(), JSON.stringify(config, null, 2));
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8"));

const TAGS = [
  "aaa\trefs/tags/v0.4.1",
  "bbb\trefs/tags/v0.10.0",
  "ccc\trefs/tags/v0.9.3",
  "ddd\trefs/tags/nightly",
  "eee\trefs/tags/v1.0.0-rc.1",
].join("\n");

describe("releases", () => {
  it("orders releases by number, not by text", () => {
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("0.4.3", "0.4.3")).toBe(false);
    expect(newer("0.4.2", "0.4.3")).toBe(false);
    expect(highestTag(TAGS)).toBe("0.10.0");
    expect(highestTag("")).toBeNull();
  });

  it("asks once a day, and never in CI or when told not to", () => {
    const cacheFile = join(root, "cache", "release.json");
    let asked = 0;
    const ask = () => {
      asked += 1;
      return TAGS;
    };
    const at = (now: number, env: NodeJS.ProcessEnv = {}, fresh = false) =>
      latestRelease({ env, now, cacheFile, ask, fresh });
    expect(at(1000)).toBe("0.10.0");
    expect(at(2000)).toBe("0.10.0");
    expect(asked).toBe(1);
    expect(at(1000 + 25 * 60 * 60 * 1000)).toBe("0.10.0");
    expect(asked).toBe(2);
    // `upgrade` skips the cache.
    at(3000, {}, true);
    expect(asked).toBe(3);
    expect(at(1000, { CI: "true" })).toBeNull();
    expect(at(1000, { ARCHMAP_NO_UPDATE_CHECK: "1" })).toBeNull();
    expect(asked).toBe(3);
  });

  it("is null, not an error, when the releases can't be reached", () => {
    expect(
      latestRelease({
        env: {},
        cacheFile: join(root, "c", "release.json"),
        ask: () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  });

  it("offers a release only to a map behind it that archmap itself runs", () => {
    expect(available({ name: "x", archmap: "0.4.1" }, "0.4.3")).toBe("0.4.3");
    expect(available({ name: "x", archmap: "0.4.3" }, "0.4.3")).toBeNull();
    expect(available({ name: "x", archmap: "0.4.1" }, null)).toBeNull();
    expect(
      available({ name: "x", archmap: "0.4.1", cli: "node a.mjs" }, "0.4.3"),
    ).toBeNull();
    expect(notice({ name: "x", archmap: "0.4.1" }, "0.4.3", dir(), root)).toBe(
      `archmap 0.4.3 is available (this map uses 0.4.1). To move to it: npx -y github:${HOME_REPO}#v0.4.3 upgrade`,
    );
  });
});

describe("upgrade", () => {
  it("sets the pin, runs the new version's init and says what to commit", () => {
    setConfig({ archmap: "0.4.1", name: "Shop", base: "main" });
    mkdirSync(join(root, ".claude", "skills", "archmap"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "archmap", "SKILL.md"), "x");
    const ran: string[][] = [];
    const r = upgrade(root, dir(), "0.4.3", (args) => {
      ran.push(args);
      return "Kept the existing architecture/archmap.config.json.\nUpdated the archmap script in package.json (`npm run archmap` opens the map).\nNext: ask your agent\n";
    });
    expect(readConfig()).toEqual({ archmap: "0.4.3", name: "Shop", base: "main" });
    expect(ran).toEqual([
      [
        "-y",
        `github:${HOME_REPO}#v0.4.3`,
        "init",
        "--dir",
        "architecture",
        "--claude",
      ],
    ]);
    expect(r).toEqual({
      ok: true,
      lines: [
        "Upgraded archmap 0.4.1 to 0.4.3.",
        "  Updated the archmap script in package.json (`npm run archmap` opens the map).",
        "Commit these changes so everyone, and CI, moves to it too.",
      ],
    });
  });

  it("changes nothing when already on the latest, when it can't tell, or when the map has its own cli", () => {
    const never = () => {
      throw new Error("must not run");
    };
    setConfig({ archmap: "0.4.3", name: "Shop" });
    expect(upgrade(root, dir(), "0.4.3", never)).toEqual({
      ok: true,
      lines: ["Already on the latest archmap (0.4.3)."],
    });
    expect(upgrade(root, dir(), null, never).ok).toBe(false);
    setConfig({ archmap: "0.4.1", name: "Shop", cli: "node tools/a.mjs" });
    expect(upgrade(root, dir(), "0.4.3", never).lines[0]).toContain(
      "runs archmap through its own command",
    );
    expect(readConfig().archmap).toBe("0.4.1");
  });

  it("puts the pin back when the new version can't be run", () => {
    setConfig({ archmap: "0.4.1", name: "Shop" });
    const before = readFileSync(configFile(), "utf8");
    const r = upgrade(root, dir(), "0.4.3", () => {
      throw new Error("npx failed\nmore");
    });
    expect(r).toEqual({
      ok: false,
      lines: ["Couldn't run archmap 0.4.3, so the map stays on 0.4.1: npx failed"],
    });
    expect(readFileSync(configFile(), "utf8")).toBe(before);
  });
});
