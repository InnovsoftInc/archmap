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
// The workflows run archmap at the version the config pins when they run.
const CI_CLI = `npx -y github:${HOME_REPO}#v\${ARCHMAP_VERSION}`;

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
      `Next: ask your agent to run \`${CLI} brief\` and follow it; on a new map it asks you which branch to describe and how to keep it current. To see the map, run \`npm run archmap\`.`,
    );
  });

  it("names the map after --name, else the folder", () => {
    init(root, { name: "Given" });
    expect(JSON.parse(read("architecture", "archmap.config.json")).name).toBe(
      "Given",
    );
  });

  it("adds an archmap script that starts the viewer, and tells agents how to run it", () => {
    writeFileSync(
      join(root, "package.json"),
      '{\n\t"name": "shop",\n\t"scripts": { "test": "vitest" }\n}\n',
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const r = init(root, { claude: true });
    const text = read("package.json");
    expect(JSON.parse(text).scripts).toEqual({
      test: "vitest",
      archmap: `${CLI} dev`,
    });
    // The file keeps its tabs and its final newline.
    expect(text).toContain('\n\t"name": "shop"');
    expect(text.endsWith("}\n")).toBe(true);
    expect(r.lines).toContain(
      "Added the archmap script in package.json (`pnpm archmap` opens the map).",
    );
    expect(read("AGENTS.md")).toContain("run `pnpm archmap` in the background");
    expect(read(".claude", "skills", "archmap", "SKILL.md")).toContain(
      "run `pnpm archmap` in the background",
    );
    // A second run changes nothing; a new cli updates the script.
    expect(init(root, {}).lines).toContain(
      "Kept the archmap script in package.json.",
    );
    expect(read("package.json")).toBe(text);
    init(root, { cli: "node tools/archmap.mjs" });
    expect(JSON.parse(read("package.json")).scripts.archmap).toBe(
      "node tools/archmap.mjs dev",
    );
  });

  it("writes how to view and use the map into the project's README, once", () => {
    writeFileSync(join(root, "package.json"), '{"name":"shop"}');
    writeFileSync(join(root, "README.md"), "# Shop\n\nSells things.\n");
    expect(init(root, {}).lines).toContain(
      "Updated the archmap section of README.md.",
    );
    const text = read("README.md");
    expect(text.startsWith("# Shop\n\nSells things.\n\n<!-- archmap:start -->")).toBe(true);
    expect(text).toContain("[`architecture/`](architecture/README.md)");
    expect(text).toContain("run `npm run archmap` and open http://127.0.0.1:4321/");
    expect(text).toContain(`run \`${CLI} check\``);
    expect(text).not.toMatch(/__[A-Z]+__/);
    expect(init(root, {}).lines).toContain(
      "Kept the archmap section of README.md.",
    );
    expect(read("README.md")).toBe(text);
    // Without a README the project gets one; a map at the root keeps its own.
    rmSync(join(root, "README.md"));
    expect(init(root, {}).lines).toContain(
      "Wrote README.md with how to view the map.",
    );
  });

  it("keeps a script of that name that isn't archmap's, and works without a package.json", () => {
    const own = '{"scripts":{"archmap":"node docs/draw.js"}}';
    writeFileSync(join(root, "package.json"), own);
    expect(init(root, {}).lines).toContain(
      "Kept your own archmap script in package.json.",
    );
    expect(read("package.json")).toBe(own);
    expect(read("AGENTS.md")).toContain(`run \`${CLI} dev\` in the background`);
    rmSync(join(root, "package.json"));
    const r = init(root, {});
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(r.lines.at(-1)).toContain(`To see the map, run \`${CLI} dev\`.`);
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
    expect(gh).toContain(`${CI_CLI} check --base origin/`);
    expect(gh).toContain("status --porcelain -- architecture");
    expect(gh).toContain(`"$PWD/architecture/archmap.config.json" ${VERSION}`);
    expect(gh).not.toMatch(/__(CLI|DIR|VERSION)__/);
    init(root, { ci: "azure" });
    const az = read(".azure-pipelines", "archmap.yml");
    expect(az).toContain(`${CI_CLI} agent --base`);
    expect(az).not.toMatch(/__(CLI|DIR|VERSION)__/);
  });

  it("keeps a workflow that differs from the template unless --force, and never bakes the pinned version in", () => {
    init(root, { ci: "github" });
    const file = join(root, ".github", "workflows", "archmap.yml");
    const original = readFileSync(file, "utf8");
    expect(original).not.toContain(`#v${VERSION}`);
    expect(init(root, { ci: "github" }).lines).toContain(
      "Kept .github/workflows/archmap.yml.",
    );
    // A new pin needs no new workflow: the same file is written.
    const cfg = join(root, "architecture", "archmap.config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfg, "utf8")),
        archmap: "9.9.9",
      }),
    );
    expect(init(root, { ci: "github" }).lines).toContain(
      "Kept .github/workflows/archmap.yml.",
    );
    writeFileSync(file, original + "# mine\n");
    const kept = init(root, { ci: "github" });
    expect(kept.lines.join("\n")).toContain(
      "Kept .github/workflows/archmap.yml: it differs from the workflow init writes. Run init --ci github --force to replace it.",
    );
    expect(readFileSync(file, "utf8")).toContain("# mine");
    const forced = init(root, { ci: "github", force: true });
    expect(forced.lines).toContain("Replaced .github/workflows/archmap.yml.");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("uses --dir in the CLI command for a non-default folder", () => {
    const r = init(root, { dir: "docs/map", ci: "github" });
    expect(existsSync(join(root, "docs", "map", "archmap.config.json"))).toBe(
      true,
    );
    expect(read("AGENTS.md")).toContain(`${CLI} --dir docs/map brief --base`);
    expect(read(".github", "workflows", "archmap.yml")).toContain(
      "status --porcelain -- docs/map",
    );
    expect(read(".github", "workflows", "archmap.yml")).toContain(
      `${CI_CLI} --dir docs/map check`,
    );
    expect(r.lines.at(-1)).toContain(`${CLI} --dir docs/map brief`);
  });

  it("--cli sets cli before AGENTS.md is written, on a new or an existing config", () => {
    const r = init(root, { cli: "node tools/archmap.mjs" });
    const config = JSON.parse(read("architecture", "archmap.config.json")) as {
      cli?: string;
      base?: string;
    };
    expect(Object.keys(config).slice(0, 3)).toEqual(["archmap", "name", "cli"]);
    expect(config.cli).toBe("node tools/archmap.mjs");
    expect(config.base).toBe("main");
    expect(read("AGENTS.md")).toContain("node tools/archmap.mjs brief --base");
    expect(r.lines.at(-1)).toContain("node tools/archmap.mjs brief");

    const again = init(root, { cli: "node other.mjs" });
    expect(again.lines).toContain(
      "Set cli to node other.mjs in architecture/archmap.config.json.",
    );
    expect(read("AGENTS.md")).toContain("node other.mjs brief --base");
    expect(read("AGENTS.md")).not.toContain("tools/archmap.mjs");
  });

  it("--claude writes the /archmap skill from the config, and keeps it in step", () => {
    const skill = [".claude", "skills", "archmap", "SKILL.md"];
    init(root, {});
    expect(existsSync(join(root, ...skill))).toBe(false);

    const r = init(root, { claude: true, base: "dev", dir: "docs/map" });
    const text = read(...skill);
    expect(r.lines).toContain(
      "Wrote .claude/skills/archmap/SKILL.md (/archmap in Claude Code).",
    );
    expect(text).toMatch(/^---\nname: archmap\ndescription: .+\n---\n/);
    expect(text).toContain(`${CLI} --dir docs/map brief --base dev`);
    expect(text).toContain("`docs/map/`");
    expect(text).not.toMatch(/__[A-Z]+__/);

    expect(init(root, { claude: true, dir: "docs/map" }).lines).toContain(
      "Kept .claude/skills/archmap/SKILL.md.",
    );
    init(root, { claude: true, dir: "docs/map", cli: "node a.mjs" });
    expect(read(...skill)).toContain(
      "node a.mjs --dir docs/map brief --base dev",
    );
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
    const claude = read("CLAUDE.md").replace(/^@AGENTS\.md$/m, "  @AGENTS.md");
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
