import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../commands.ts";

const pkgRoot = join(import.meta.dirname, "..", "..");
const plugin = join(pkgRoot, "plugin");
const read = (path: string) => readFileSync(path, "utf8");
// The one instruction every command and the skill share for finding the map.
const FIND_MAP =
  "Find the map folder: the one that holds `archmap.config.json`. Look in `architecture/` first, then at the `--dir` in the `archmap:drift` script in `package.json`, then one or two folders down (skip `node_modules`). If it isn't `architecture/`, add `--dir <folder>` to every archmap command.";

// The frontmatter between the leading `---` lines, as key: value pairs.
const frontmatter = (text: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return new Map<string, string>();
  return new Map(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()] as const;
    }),
  );
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("the plugin", () => {
  it("plugin.json names the plugin archmap", () => {
    const manifest = JSON.parse(
      read(join(plugin, ".claude-plugin", "plugin.json")),
    ) as { name: string; description: string; version: string };
    expect(manifest.name).toBe("archmap");
    expect(manifest.description).not.toBe("");
    expect(manifest.version).toBe("0.3.0");
  });

  it("the marketplace lists the plugin from ./plugin", () => {
    const market = JSON.parse(
      read(join(pkgRoot, ".claude-plugin", "marketplace.json")),
    ) as { plugins: { name: string; source: string }[] };
    expect(market.plugins).toContainEqual(
      expect.objectContaining({ name: "archmap", source: "./plugin" }),
    );
  });

  it("every command has a description, and an argument hint if it takes arguments", () => {
    const files = readdirSync(join(plugin, "commands"));
    expect(files.sort()).toEqual([
      "publish.md",
      "review.md",
      "setup.md",
      "update.md",
      "upgrade.md",
    ]);
    for (const file of files) {
      const fm = frontmatter(read(join(plugin, "commands", file)));
      // review takes no arguments, so it has no hint
      const hint =
        file === "review.md" ? "none" : (fm.get("argument-hint") ?? "");
      expect({ file, hint }).toEqual({
        file,
        hint: expect.stringMatching(/\S/),
      });
      expect(fm.get("description")).toMatch(/\S/);
    }
  });

  it("review lists differences both ways and pre-approves only scan", () => {
    const text = read(join(plugin, "commands", "review.md"));
    expect(text).toContain("In the code but not on the map");
    expect(text).toContain("On the map but not in the code");
    const allowed = frontmatter(text).get("allowed-tools") ?? "";
    expect(allowed).toContain("archmap.mjs scan");
    expect(allowed).not.toMatch(/\b(snapshot|init|save|publish)\b/);
  });

  it("setup asks the five planning questions word for word", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    for (const q of [
      "What are you building, and for whom?",
      "Who uses it? (These become personas, in layer 4.)",
      "What will people see or use: a web app, a mobile app, an admin tool?",
      "What will run behind it: an API, a database, file storage, background jobs?",
      "Which outside services will it depend on (sign-in, email, payments, hosting)?",
    ])
      expect(text).toContain(q);
  });

  it("setup pre-approves only read-only commands", () => {
    const fm = frontmatter(read(join(plugin, "commands", "setup.md")));
    const allowed = fm.get("allowed-tools") ?? "";
    expect(allowed).toContain("min-version.mjs");
    expect(allowed).not.toMatch(/\b(snapshot|init|save|publish)\b/);
  });

  it("setup asks a separate question before publishing the Baseline", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    expect(text).toContain("Publish this as the Baseline version?");
  });

  it("the commands call the project's installed CLI", () => {
    for (const file of readdirSync(join(plugin, "commands"))) {
      const text = read(join(plugin, "commands", file));
      expect({
        file,
        calls: text.includes("node .archmap/bin/archmap.mjs"),
      }).toEqual({ file, calls: true });
      expect({ file, text }).not.toMatchObject({
        text: expect.stringMatching(/npx|pnpm exec/),
      });
    }
  });

  it("upgrade pre-approves only the upgrade and check commands", () => {
    const fm = frontmatter(read(join(plugin, "commands", "upgrade.md")));
    expect(fm.get("allowed-tools")).toBe(
      "Bash(node .archmap/bin/archmap.mjs upgrade:*), Bash(node .archmap/bin/archmap.mjs check:*)",
    );
    expect(fm.get("argument-hint")).toBe('"[version]"');
  });

  it("update pre-approves only read-only commands", () => {
    const text = read(join(plugin, "commands", "update.md"));
    const fm = frontmatter(text);
    expect(fm.get("description")).toMatch(/\S/);
    expect(fm.get("argument-hint")).toBe('"[--base <ref>]"');
    const allowed = fm.get("allowed-tools") ?? "";
    expect(allowed).toContain("archmap.mjs drift");
    expect(allowed).not.toMatch(/\b(snapshot|init|save|publish)\b/);
  });

  it("setup step 7 offers the CI check instead of a placeholder", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    expect(text).not.toContain("comes in a later version");
    expect(text).toContain(
      "Add a GitHub Actions check for the architecture map?",
    );
    expect(text).toContain(".github/workflows/archmap.yml");
  });

  it("setup's CI step copies the template from .archmap/ and drops the package-manager guidance", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    expect(text).toContain(".archmap/templates/archmap-workflow.yml");
    for (const gone of ["packageManager", "corepack", "npmScopes", "yarn"])
      expect(text).not.toContain(gone);
  });

  it("every command and the skill find the map folder the same way", () => {
    // upgrade only touches .archmap/, so it doesn't need the map folder
    const files = [
      ...readdirSync(join(plugin, "commands"))
        .filter((f) => f !== "upgrade.md")
        .map((f) => join(plugin, "commands", f)),
      join(plugin, "skills", "archmap", "SKILL.md"),
    ];
    for (const file of files)
      expect({ file, found: read(file).includes(FIND_MAP) }).toEqual({
        file,
        found: true,
      });
  });

  it("the skill defers to instructions.md for what to map", () => {
    const text = read(join(plugin, "skills", "archmap", "SKILL.md"));
    expect(text).toContain("What belongs on the map");
    expect(text).not.toContain("1. **Overview:**");
  });

  it("setup offers a watch list when there's none, and asks before writing it", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    expect(text).toContain("node .archmap/bin/archmap.mjs scan --watch");
    expect(text).toContain("isn't `planning`");
    expect(text).toContain('"Add this watch list to archmap.config.json?"');
    expect(text).toMatch(/Write it into the config's `watch` only on a yes/);
  });

  it("no plugin file calls node_modules/.bin/archmap", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(plugin)) {
      const text = read(file);
      expect({ file, old: text.includes("node_modules/.bin/archmap") }).toEqual(
        { file, old: false },
      );
      expect({ file, token: text.includes("npm.pkg.github.com") }).toEqual({
        file,
        token: false,
      });
    }
  });

  it("no plugin file tells the person to install with a package manager", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(plugin)) {
      const text = read(file);
      for (const gone of [
        "pnpm add",
        "npm install -D",
        "@tttstudios/archmap@latest",
      ])
        expect({ file, gone, found: text.includes(gone) }).toEqual({
          file,
          gone,
          found: false,
        });
    }
    for (const file of ["setup.md", "review.md"])
      expect(read(join(plugin, "commands", file))).toContain(
        "/archmap:upgrade",
      );
  });

  it("commands allow the copied CLI", () => {
    for (const file of ["setup.md", "update.md", "review.md", "upgrade.md"]) {
      const allowed =
        frontmatter(read(join(plugin, "commands", file))).get(
          "allowed-tools",
        ) ?? "";
      const entries = allowed.match(/Bash\([^)]*\)/g) ?? [];
      const archmap = entries.filter((e) => e.includes("archmap"));
      expect(archmap.length).toBeGreaterThan(0);
      for (const e of archmap) {
        if (e.includes("min-version.mjs")) continue;
        expect({ file, e }).toEqual({
          file,
          e: expect.stringMatching(/^Bash\(node \.archmap\/bin\/archmap\.mjs /),
        });
      }
    }
  });

  it("setup adds --dir to the CI drift step for a map outside architecture/", () => {
    const text = read(join(plugin, "commands", "setup.md"));
    expect(text).toContain(
      "node .archmap/bin/archmap.mjs drift --dir <folder> --base origin/${{ github.base_ref }}",
    );
  });

  it("review leaves out what the scan can't see", () => {
    const text = read(join(plugin, "commands", "review.md"));
    expect(text).toMatch(
      /Leave out what the scan can't see: personas, flows, categories, and parent or group services/,
    );
  });

  it("update suggests the trailer with its reason", () => {
    const text = read(join(plugin, "commands", "update.md"));
    expect(text).toContain("`Archmap: none - <reason>`");
    expect(text).not.toContain("`Archmap: none`");
  });

  it("init copies the plugin skill exactly", () => {
    init(join(tmp, "architecture"), { repoRoot: tmp });
    expect(read(join(tmp, ".claude/skills/archmap/SKILL.md"))).toBe(
      read(join(plugin, "skills/archmap/SKILL.md")),
    );
  });
});

describe("min-version.mjs", () => {
  // A copy of the script in a temp layout, so ../../package.json is a fixture.
  let script: string;
  beforeEach(() => {
    mkdirSync(join(tmp, "pkg", "plugin", "bin"), { recursive: true });
    script = join(tmp, "pkg", "plugin", "bin", "min-version.mjs");
    copyFileSync(join(plugin, "bin", "min-version.mjs"), script);
    writeFileSync(
      join(tmp, "pkg", "package.json"),
      JSON.stringify({
        version: "0.3.0",
        repository: { type: "git", url: "https://github.com/Acme/archmap" },
      }),
    );
    mkdirSync(join(tmp, "project"));
  });
  const project = () => join(tmp, "project");
  const run = () =>
    execFileSync(process.execPath, [script], {
      cwd: project(),
      encoding: "utf8",
    });
  const stamp = (text: string) => {
    mkdirSync(join(project(), ".archmap"));
    writeFileSync(join(project(), ".archmap", "VERSION"), text);
  };

  it("prints the install command when .archmap/VERSION is missing", () => {
    const out = run().trim();
    expect(out).toBe("missing npx -y github:Acme/archmap#v0.3.0 install");
    expect(out).toMatch(/^missing npx -y github:/);
  });

  it("without ../../package.json (the plugin cache), points to the README instead of crashing", () => {
    rmSync(join(tmp, "pkg", "package.json"));
    mkdirSync(join(tmp, "pkg", "plugin", ".claude-plugin"));
    writeFileSync(
      join(tmp, "pkg", "plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "archmap",
        repository: "https://github.com/Acme/archmap",
      }),
    );
    expect(run()).toBe(
      "missing see the install instructions under Quick start in https://github.com/Acme/archmap#quick-start\n",
    );
  });

  it("with neither package.json nor plugin.json, still says missing", () => {
    rmSync(join(tmp, "pkg", "package.json"));
    expect(run()).toBe(
      "missing see the install instructions under Quick start in the archmap README\n",
    );
  });

  it("says old below 0.3.0", () => {
    stamp("0.2.0\n");
    expect(run()).toBe("old 0.2.0\n");
  });

  it("says ok at 0.3.0, comparing numbers not strings", () => {
    stamp("0.3.0\n");
    expect(run()).toBe("ok\n");
    rmSync(join(project(), ".archmap"), { recursive: true });
    stamp("0.10.0\n");
    expect(run()).toBe("ok\n");
  });
});

describe("the CI workflow template", () => {
  const text = read(join(pkgRoot, "templates", "archmap-workflow.yml"));

  it("checks out full history and runs check then drift, never strict", () => {
    expect(text).toContain("fetch-depth: 0");
    expect(text).toContain("node .archmap/bin/archmap.mjs check");
    expect(text).toContain("--base origin/${{ github.base_ref }}");
    expect(text.indexOf("archmap.mjs check")).toBeLessThan(
      text.indexOf("archmap.mjs drift"),
    );
    expect(text).not.toContain("--strict");
  });

  it("runs on pull requests with read-only contents permission", () => {
    expect(text).toContain("pull_request");
    expect(text).toContain("contents: read");
    expect(text).toContain("node-version: 24");
  });
});
