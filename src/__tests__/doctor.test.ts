import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief } from "../brief.ts";
import { doctor, satisfies, troubles } from "../doctor.ts";
import { init } from "../init.ts";

let root: string;
const ceiling = process.env.GIT_CEILING_DIRECTORIES;
beforeEach(() => {
  process.env.GIT_CEILING_DIRECTORIES = import.meta.dirname;
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => {
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  rmSync(root, { recursive: true, force: true });
});

const CLI = "node tools/archmap.mjs";
const config = { name: "Shop", cli: CLI };
const pkg = (json: object) =>
  writeFileSync(join(root, "package.json"), JSON.stringify(json));
const found = (node: string, env: NodeJS.ProcessEnv = {}) =>
  troubles(root, "architecture", config, { node, env });

describe("satisfies", () => {
  it("reads the ranges a package.json engines field uses", () => {
    expect(satisfies("26.13.0", "^24.14.0")).toBe(false);
    expect(satisfies("24.14.0", "^24.14.0")).toBe(true);
    expect(satisfies("24.13.9", "^24.14.0")).toBe(false);
    expect(satisfies("24.2.0", "~24.1.0")).toBe(false);
    expect(satisfies("24.1.7", "~24.1")).toBe(true);
    expect(satisfies("26.0.0", ">=24")).toBe(true);
    expect(satisfies("22.9.0", ">= 20 <23")).toBe(true);
    expect(satisfies("23.0.0", ">=20 <23")).toBe(false);
    expect(satisfies("24.3.1", "24.x")).toBe(true);
    expect(satisfies("25.0.0", "24")).toBe(false);
    expect(satisfies("22.1.0", "^20 || ^22")).toBe(true);
    expect(satisfies("21.0.0", "^20.0.0 || >=22")).toBe(false);
    expect(satisfies("26.0.0", "*")).toBe(true);
    expect(satisfies("24.0.0", ">20.1")).toBe(true);
    expect(satisfies("20.1.5", ">20.1")).toBe(false);
    expect(satisfies("20.1.5", "<=20.1")).toBe(true);
  });

  it("claims nothing about a range it doesn't read", () => {
    expect(satisfies("24.0.0", "20 - 24")).toBeUndefined();
    expect(satisfies("24.0.0", "lts/*")).toBeUndefined();
  });
});

describe("troubles", () => {
  it("names a Node version the project's engines reject, with the switch command and a way to start the map meanwhile", () => {
    pkg({
      engines: { node: "^24.14.0" },
      packageManager: "pnpm@10.0.0",
      scripts: { archmap: `${CLI} dev` },
    });
    const [t, ...rest] = found("26.13.0", { MISE_SHELL: "zsh" });
    expect(rest).toEqual([]);
    expect(t.problem).toContain(
      "This shell runs Node 26.13.0, but package.json requires Node ^24.14.0.",
    );
    expect(t.problem).toContain("`pnpm archmap`");
    expect(t.fix).toContain("`mise use node@24`");
    expect(t.fix).toContain(`\`${CLI} dev\``);
    // Each version manager gets its own command; none gets the list.
    expect(found("26.13.0", { NVM_DIR: "/x" })[0].fix).toContain(
      "`nvm install 24 && nvm use 24`",
    );
    expect(found("26.13.0")[0].fix).toContain("your Node version manager");
    expect(found("24.14.2")).toEqual([]);
  });

  it("names a missing or out-of-date start script, and a Node too old for archmap", () => {
    pkg({ scripts: { test: "vitest" } });
    expect(found("24.0.0")).toEqual([
      {
        problem:
          "package.json has no `archmap` script, so `npm run archmap` doesn't start the map.",
        fix: `Run \`${CLI} init\`: it adds the script and changes nothing else that is already set up.`,
      },
    ]);
    pkg({ scripts: { archmap: "npx archmap@old dev" } });
    expect(found("24.0.0")[0].fix).toBe(`Run \`${CLI} init\` to update it.`);
    // Someone's own script of that name is left alone.
    pkg({ scripts: { archmap: "node docs/draw.js" } });
    expect(found("24.0.0")).toEqual([]);
    expect(found("22.3.0")[0].problem).toBe(
      "This shell runs Node 22.3.0; archmap needs Node 24 or later.",
    );
  });

  it("finds nothing in a project without a package.json", () => {
    expect(found("26.0.0")).toEqual([]);
  });
});

describe("doctor and the brief", () => {
  it("passes after init, and says to run init where there is no map", () => {
    expect(doctor(root, join(root, "architecture"))).toEqual({
      ok: false,
      lines: [
        "- There is no map here yet (no archmap.config.json).",
        "  Fix: run `init` in the project's root folder.",
      ],
    });
    pkg({ name: "shop" });
    init(root, {});
    expect(doctor(root, join(root, "architecture"))).toEqual({
      ok: true,
      lines: ["Nothing to fix: archmap can run here."],
    });
  });

  it("puts what is broken at the top of the brief, and always says to repair or explain a setup failure", () => {
    pkg({ name: "shop" });
    init(root, {});
    const dir = join(root, "architecture");
    const clean = brief(root, dir, {});
    expect(clean).not.toContain("## Fix the setup");
    expect(clean).toContain("doctor`, fix what only changes your own shell");
    pkg({ name: "shop", engines: { node: "<1" }, scripts: {} });
    const out = brief(root, dir, {});
    const section = out.split("## Fix the setup")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("but package.json requires Node <1.");
    expect(section).toContain("  Fix: Switch this shell to a Node that matches");
    expect(section).toContain("package.json has no `archmap` script");
    expect(doctor(root, dir).ok).toBe(false);
  });
});
