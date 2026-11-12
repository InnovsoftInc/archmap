import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_REPO } from "../home.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the package", () => {
  it("the instructions template has nothing project-specific", () => {
    const text = read("templates/instructions.md");
    expect(text).not.toMatch(/logbook|WorkSafeBC|BCACS/i);
    expect(text).toMatch(/orders\.status/);
  });

  it("the instructions template says what belongs on the map", () => {
    const text = read("templates/instructions.md");
    const at = text.indexOf("## What belongs on the map");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf("## Where things live"));
    expect(text).toContain("1. **Overview**");
    expect(text).toContain("4. **People and flows**");
    expect(text).toContain("Never put on the map:");
  });

  it("package.json is ready for npx github:", () => {
    const raw = read("package.json");
    const pkg = JSON.parse(raw) as Record<string, unknown> & {
      bin: Record<string, string>;
      files: string[];
      version: string;
      repository: { url: string };
    };
    const repo = `https://github.com/${HOME_REPO}`;
    expect(pkg.name).toBe("@tttstudios/archmap");
    expect(pkg).not.toHaveProperty("private");
    expect(pkg).not.toHaveProperty("publishConfig");
    expect(pkg.bin.archmap).toBe("./bin/archmap.mjs");
    expect(pkg.version).toBe("0.4.0");
    expect(pkg.repository.url).toBe(repo);
    expect(pkg.files).toContain("bin");
    expect(pkg.files).toContain("plugin");
    expect(raw).not.toContain("workspace:");

    const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json")) as {
      version: string;
      repository: string;
    };
    expect(plugin.version).toBe("0.4.0");
    expect(plugin.repository).toBe(repo);
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { version: string; repository: string }[];
    };
    expect(market.plugins[0]?.version).toBe("0.4.0");
    expect(market.plugins[0]?.repository).toBe(repo);
  });

  it("the CI template needs no install or token", () => {
    const text = read("templates/archmap-workflow.yml");
    expect(text).toContain("node .archmap/bin/archmap.mjs check");
    expect(text).toContain(
      "node .archmap/bin/archmap.mjs drift --base origin/${{ github.base_ref }}",
    );
    for (const gone of [
      "__INSTALL__",
      "__RUN__",
      "NODE_AUTH_TOKEN",
      "packages: read",
      "pnpm/action-setup",
    ])
      expect(text).not.toContain(gone);
  });
});
