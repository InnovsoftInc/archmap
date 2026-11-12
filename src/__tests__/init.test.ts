import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_REPO, VERSION } from "../home.ts";
import { init } from "../init.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const CLI = `npx -y github:${HOME_REPO}#v${VERSION}`;

describe("init", () => {
  it("creates the config pinned to this version, README and AGENTS block", () => {
    writeFileSync(join(root, "package.json"), '{"name":"shop"}');
    const r = init(root, {});
    expect(r.ok).toBe(true);
    const config = JSON.parse(read("architecture", "archmap.config.json"));
    expect(config.archmap).toBe(VERSION);
    expect(config.name).toBe("shop");
    expect(config.agent.command).toBe(
      "claude -p --permission-mode acceptEdits",
    );
    expect(existsSync(join(root, "architecture", "README.md"))).toBe(true);
    const agents = read("AGENTS.md");
    expect(agents.startsWith("# Agent notes")).toBe(true);
    expect(agents).toContain("<!-- archmap:start -->");
    expect(agents).toContain(`${CLI} brief --base main`);
    expect(agents).not.toContain("__CLI__");
    expect(r.lines.at(-1)).toBe(
      `Next: ask your agent to run \`${CLI} brief\` and follow it.`,
    );
  });

  it("names the map after --name, else the folder", () => {
    init(root, { name: "Given" });
    expect(JSON.parse(read("architecture", "archmap.config.json")).name).toBe(
      "Given",
    );
  });

  it("is idempotent: a second run keeps the config and replaces, not duplicates, the AGENTS block", () => {
    init(root, { name: "A" });
    const cfg = join(root, "architecture", "archmap.config.json");
    writeFileSync(cfg, '{"name":"Mine"}');
    writeFileSync(join(root, "architecture", "README.md"), "mine");
    const r = init(root, { name: "B" });
    expect(read("architecture", "archmap.config.json")).toBe('{"name":"Mine"}');
    expect(read("architecture", "README.md")).toBe("mine");
    expect(r.lines.join("\n")).toMatch(/kept/i);
    expect(read("AGENTS.md").split("<!-- archmap:start -->")).toHaveLength(2);
    expect(read("AGENTS.md").split("<!-- archmap:end -->")).toHaveLength(2);
  });

  it("adds @AGENTS.md to an existing CLAUDE.md once, and doesn't create CLAUDE.md", () => {
    init(root, {});
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    writeFileSync(join(root, "CLAUDE.md"), "# Notes\n");
    init(root, {});
    init(root, {});
    expect(read("CLAUDE.md").match(/@AGENTS\.md/g)).toHaveLength(1);
  });

  it("writes the GitHub and Azure workflows with the CLI and dir filled", () => {
    init(root, { ci: "github" });
    const gh = read(".github", "workflows", "archmap.yml");
    expect(gh).toContain(`${CLI} check --base origin/`);
    expect(gh).toContain("git status --porcelain -- architecture");
    expect(gh).not.toMatch(/__(CLI|DIR)__/);
    init(root, { ci: "azure" });
    const az = read(".azure-pipelines", "archmap.yml");
    expect(az).toContain(`${CLI} agent --base`);
    expect(az).not.toMatch(/__(CLI|DIR)__/);
  });

  it("uses --dir in the CLI command for a non-default folder", () => {
    const r = init(root, { dir: "docs/map", ci: "github" });
    expect(existsSync(join(root, "docs", "map", "archmap.config.json"))).toBe(
      true,
    );
    expect(read("AGENTS.md")).toContain(`${CLI} --dir docs/map brief --base`);
    expect(read(".github", "workflows", "archmap.yml")).toContain(
      "git status --porcelain -- docs/map",
    );
    expect(r.lines.at(-1)).toContain(`${CLI} --dir docs/map brief`);
  });

  it("uses a configured cli when the existing config sets one", () => {
    mkdirSync(join(root, "architecture"));
    writeFileSync(
      join(root, "architecture", "archmap.config.json"),
      '{"name":"x","cli":"node tools/archmap.mjs"}',
    );
    init(root, {});
    expect(read("AGENTS.md")).toContain("node tools/archmap.mjs brief");
  });
});
