import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_REPO } from "../home.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the package", () => {
  it("package.json is ready for npx github:", () => {
    const raw = read("package.json");
    const pkg = JSON.parse(raw) as Record<string, unknown> & {
      bin: Record<string, string>;
      files: string[];
      version: string;
      description: string;
      repository: { url: string };
    };
    expect(pkg.name).toBe("@tttstudios/archmap");
    expect(pkg).not.toHaveProperty("private");
    expect(pkg).not.toHaveProperty("publishConfig");
    expect(pkg.bin.archmap).toBe("./bin/archmap.mjs");
    expect(pkg.version).toBe("0.4.6");
    expect(pkg.repository.url).toBe(`https://github.com/${HOME_REPO}`);
    for (const shipped of ["bin", "src", "viewer", "templates"])
      expect(pkg.files).toContain(shipped);
    expect(pkg.files.join(" ")).not.toMatch(/plugin/);
    expect(pkg.description).not.toMatch(/plugin|marketplace|claude/i);
    expect(raw).not.toContain("workspace:");
  });

  it("ships no Claude plugin or marketplace", () => {
    expect(existsSync(join(root, "plugin"))).toBe(false);
    expect(existsSync(join(root, ".claude-plugin"))).toBe(false);
  });

  it("the CI templates run through npx, with no vendored copy", () => {
    for (const [dir, check] of [
      ["github", "check --base"],
      ["azure-pipelines", "check --base"],
    ] as const) {
      const text = read(join("templates", "ci", dir, "archmap-pr.yml"));
      expect(text).toContain("__CLI__");
      expect(text).toContain(check);
      expect(text).not.toContain(".archmap/bin");
    }
  });
});
