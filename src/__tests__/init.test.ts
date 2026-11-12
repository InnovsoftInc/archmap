import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_REPO, VERSION } from "../home.ts";
import { init } from "../init.ts";

let root: string;
// The test folders sit inside archmap's own checkout; stop git there so
// init never reads archmap's origin/HEAD.
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
      'claude -p --permission-mode acceptEdits --allowedTools "Bash({cli} check:*)" "Bash({cli} brief:*)"',
    );
    expect(config.base).toBe("main");
    expect(read("architecture", ".gitignore")).toBe(".no-change\n");
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
    writeFileSync(cfg, '{"name":"Mine","base":"main"}');
    writeFileSync(join(root, "architecture", "README.md"), "mine");
    const r = init(root, { name: "B" });
    expect(read("architecture", "archmap.config.json")).toBe(
      '{"name":"Mine","base":"main"}',
    );
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

  it("writes .no-change to the .gitignore of a non-default folder", () => {
    init(root, { dir: "docs/map" });
    expect(read("docs", "map", ".gitignore")).toBe(".no-change\n");
  });

  it("adds .no-change to an existing map .gitignore once", () => {
    mkdirSync(join(root, "architecture"));
    writeFileSync(join(root, "architecture", ".gitignore"), "tmp/\n");
    init(root, {});
    init(root, {});
    expect(read("architecture", ".gitignore")).toBe("tmp/\n.no-change\n");
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

  it("sets base from --base, else origin/HEAD, else main, and uses it in AGENTS.md", () => {
    init(root, { base: "dev" });
    const cfg = () => JSON.parse(read("architecture", "archmap.config.json"));
    expect(cfg().base).toBe("dev");
    expect(read("AGENTS.md")).toContain(`${CLI} brief --base dev`);
    expect(read("AGENTS.md")).not.toContain("--base main");
    // An existing config keeps its base; --base changes it.
    init(root, {});
    expect(cfg().base).toBe("dev");
    init(root, { base: "staging" });
    expect(cfg().base).toBe("staging");
    expect(read("AGENTS.md")).toContain(`${CLI} brief --base staging`);
  });

  it("writes the detected base into an existing config that lacks one", () => {
    mkdirSync(join(root, "architecture"));
    const cfg = join(root, "architecture", "archmap.config.json");
    writeFileSync(cfg, '{"name":"x"}');
    const r = init(root, {});
    expect(JSON.parse(read("architecture", "archmap.config.json"))).toEqual({
      name: "x",
      base: "main",
    });
    expect(r.lines).toContain(
      "Set base to main in architecture/archmap.config.json.",
    );
  });

  it("defaults base to the origin/HEAD branch", () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "trunk");
    writeFileSync(join(root, "a.txt"), "a\n");
    git("add", "a.txt");
    git(
      ...["-c", "user.name=T", "-c", "user.email=t@e"],
      ...["-c", "commit.gpgsign=false", "commit", "-qm", "x"],
    );
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
    init(root, {});
    expect(JSON.parse(read("architecture", "archmap.config.json")).base).toBe(
      "dev",
    );
  });

  it("stays idempotent after Prettier formats AGENTS.md and CLAUDE.md", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# Notes\n\n- one\n- two\n");
    init(root, {});
    // What Prettier does: a blank line after the start marker, and a line
    // straight after a list item indented into it.
    const agents = read("AGENTS.md").replace(
      "<!-- archmap:start -->\n",
      "<!-- archmap:start -->\n\n",
    );
    writeFileSync(join(root, "AGENTS.md"), agents);
    const claude = read("CLAUDE.md").replace(
      /^@AGENTS\.md$/m,
      "  @AGENTS.md",
    );
    writeFileSync(join(root, "CLAUDE.md"), claude);
    init(root, {});
    expect(read("AGENTS.md")).toBe(agents);
    expect(read("CLAUDE.md")).toBe(claude);
    writeFileSync(join(root, "CLAUDE.md"), "# Notes\n\n@./AGENTS.md\n");
    init(root, {});
    expect(read("CLAUDE.md")).toBe("# Notes\n\n@./AGENTS.md\n");
  });

  it("puts @AGENTS.md after a blank line so a list doesn't swallow it", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# Notes\n\n- one\n");
    init(root, {});
    expect(read("CLAUDE.md")).toBe("# Notes\n\n- one\n\n@AGENTS.md\n");
  });
});
