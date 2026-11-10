import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_REPO } from "../home.ts";
import { upgradeInfo } from "../upgrade.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const stamp = (v: string) => {
  mkdirSync(join(tmp, ".archmap"), { recursive: true });
  writeFileSync(join(tmp, ".archmap", "VERSION"), `${v}\n`);
};
const tags = () => ["v0.2.0", "v0.3.0", "v0.10.0"];

describe("upgradeInfo", () => {
  it("names the latest tag", () => {
    stamp("0.3.0");
    const r = upgradeInfo(tmp, { tags });
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual([
      "Installed: 0.3.0",
      "Latest: 0.10.0",
      `Run: npx -y github:${HOME_REPO}#v0.10.0 install`,
    ]);
  });

  it("ignores tags that aren't vX.Y.Z", () => {
    stamp("0.3.0");
    const r = upgradeInfo(tmp, {
      tags: () => ["v0.3.0", "v1.0.0-rc1", "nightly"],
    });
    expect(r.lines[1]).toBe("Latest: 0.3.0");
  });

  it("already latest", () => {
    stamp("0.10.0");
    const r = upgradeInfo(tmp, { tags });
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toBe("archmap is up to date.");
  });

  it("a wanted version that exists is named even if older", () => {
    stamp("0.10.0");
    const r = upgradeInfo(tmp, { tags, want: "0.2.0" });
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toBe(
      `Run: npx -y github:${HOME_REPO}#v0.2.0 install`,
    );
  });

  it("a wanted version that doesn't exist", () => {
    stamp("0.3.0");
    const r = upgradeInfo(tmp, { tags, want: "9.9.9" });
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([`No tag v9.9.9 in ${HOME_REPO}.`]);
  });

  it("git can't reach the repo", () => {
    stamp("0.3.0");
    const r = upgradeInfo(tmp, {
      tags: () => {
        throw new Error("offline");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain(HOME_REPO);
    expect(r.lines.join("\n")).toMatch(/Couldn't read/);
  });

  it("says archmap isn't installed when .archmap/VERSION is missing", () => {
    const r = upgradeInfo(tmp, { tags });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/isn't installed here/);
    expect(r.lines.at(-1)).toBe(
      `Run: npx -y github:${HOME_REPO}#v0.10.0 install`,
    );
  });
});
