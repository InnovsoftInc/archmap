import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { runAgent } from "../agent.ts";

let root: string;
const dir = () => join(root, "architecture");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const exists = (rel: string) => existsSync(join(root, rel));
const commit = (message = "change") => {
  git("add", ".");
  git("commit", "-q", "-m", message);
};

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** A shell command that runs `script` with this node. */
const node = (script: string) =>
  `${quote(process.execPath)} -e ${quote(script)}`;
const config = (agent: Record<string, unknown> | undefined) =>
  write(
    "architecture/archmap.config.json",
    JSON.stringify({ name: "Test", ...(agent ? { agent } : {}) }),
  );

const SERVICE =
  "---\nname: X\nstatus: live\nkind: api\n---\nDoes x.\n\n## How it works\n\nx\n\n## For developers\n\nx\n";

/** The stub agent: writes a map file and a file outside the map. */
const STUB = node(`
const fs = require("node:fs");
fs.mkdirSync("architecture/services", { recursive: true });
fs.writeFileSync("architecture/services/x.md", ${JSON.stringify(SERVICE)});
fs.mkdirSync("apps", { recursive: true });
fs.writeFileSync("apps/other.ts", "export const changed = 1;\\n");
`);

// Building the base repo takes several git calls, so it is built once and
// copied for each test.
let template: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-agent-template-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  config({ command: STUB });
  write("architecture/README.md", "# Test\n");
  write("apps/other.ts", "export const other = 1;\n");
  write("apps/mine.ts", "export const mine = 1;\n");
  write("README.md", "hi\n");
  commit("base");
  template = root;
});
afterAll(() => rmSync(template, { recursive: true, force: true }));
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-agent-")));
  cpSync(template, root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("archmap agent", () => {
  it("fails with a hint when no agent command is set", () => {
    config(undefined);
    expect(runAgent(root, dir(), {})).toEqual({
      ok: false,
      lines: [
        'Set agent.command in archmap.config.json (for example "claude -p").',
      ],
    });
  });

  it("skips when only skipped files changed", () => {
    config({ command: STUB, skip: ["docs/**", "architecture/**"] });
    write("docs/guide.md", "changed\n");
    expect(runAgent(root, dir(), { base: "HEAD" })).toEqual({
      ok: true,
      lines: ["Only skipped files changed; nothing to map."],
    });
    expect(exists("architecture/services/x.md")).toBe(false);
  });

  it("says nothing changed, rather than only skipped files, on a clean tree", () => {
    expect(runAgent(root, dir(), { base: "HEAD" })).toEqual({
      ok: true,
      lines: ["No files changed since HEAD; nothing to map."],
    });
    expect(exists("architecture/services/x.md")).toBe(false);
  });

  it("fills {cli} in with the map's cli command when it runs", () => {
    const seen = node(
      `require("node:fs").writeFileSync("architecture/cli-seen.txt", process.argv[1])`,
    );
    config({ command: `${seen} "{cli} check"` });
    runAgent(root, dir(), {});
    expect(read("architecture/cli-seen.txt")).toMatch(
      /^npx -y github:\S+#v\S+ check$/,
    );
    // Setting cli later takes effect without rewriting the command.
    write(
      "architecture/archmap.config.json",
      JSON.stringify({
        name: "Test",
        cli: "node tools/archmap.mjs",
        agent: { command: `${seen} "{cli} check"` },
      }),
    );
    runAgent(root, dir(), {});
    expect(read("architecture/cli-seen.txt")).toBe(
      "node tools/archmap.mjs check",
    );
  });

  it("passes the brief on stdin", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("architecture/brief-seen.txt", require("node:fs").readFileSync(0, "utf8"))`,
      ),
    });
    runAgent(root, dir(), {});
    expect(read("architecture/brief-seen.txt")).toContain("# archmap brief");
  });

  it("substitutes {brief} as one quoted argument", () => {
    config({
      command: `${node(
        `require("node:fs").writeFileSync("architecture/brief-seen.txt", JSON.stringify(process.argv.slice(1)))`,
      )} {brief}`,
    });
    // A broken map file with a ' in its name puts a ' into the brief's problems.
    write("architecture/services/it's.md", "---\nstatus: nope\n---\nx\n");
    runAgent(root, dir(), {});
    const args = JSON.parse(read("architecture/brief-seen.txt")) as string[];
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("# archmap brief");
    expect(args[0]).toContain("it's");
  });

  it("passes $ patterns in the brief through {brief} verbatim", () => {
    config({
      command: `${node(
        `require("node:fs").writeFileSync("architecture/brief-seen.txt", process.argv[1])`,
      )} {brief}`,
    });
    // A broken map file whose name holds every replacement pattern puts them into the brief.
    const name = "a$&b$'c$`d$$e.md";
    write(`architecture/services/${name}`, "---\nstatus: nope\n---\nx\n");
    runAgent(root, dir(), {});
    expect(read("architecture/brief-seen.txt")).toContain(name);
  });

  it("keeps map edits and reverts new edits outside the map", () => {
    const r = runAgent(root, dir(), {});
    expect(read("architecture/services/x.md")).toBe(SERVICE);
    expect(read("apps/other.ts")).toBe("export const other = 1;\n");
    expect(r.lines.join("\n")).not.toContain("apps/other.ts");
    expect(git("status", "--porcelain")).toBe("?? architecture/services/\n");
  });

  it("restores a tracked file the agent deleted", () => {
    config({ command: node(`require("node:fs").rmSync("apps/other.ts")`) });
    commit("config");
    runAgent(root, dir(), {});
    expect(read("apps/other.ts")).toBe("export const other = 1;\n");
  });

  it("leaves the developer's pre-existing edits outside the map and warns when the agent touched them", () => {
    write("apps/other.ts", "export const mine = 2;\n");
    write("apps/mine.ts", "export const untouched = 2;\n");
    const r = runAgent(root, dir(), {});
    expect(read("apps/other.ts")).toBe("export const changed = 1;\n");
    expect(read("apps/mine.ts")).toBe("export const untouched = 2;\n");
    expect(r.lines[0]).toBe(
      "The agent changed apps/other.ts, which had your uncommitted changes; review it.",
    );
    expect(r.lines.join("\n")).not.toContain("apps/mine.ts");
  });

  it("removes untracked files the agent created outside the map but not ones that existed", () => {
    config({
      command: node(`
const fs = require("node:fs");
fs.mkdirSync("tmp", { recursive: true });
fs.writeFileSync("tmp/agent.txt", "agent\\n");
fs.writeFileSync("architecture/new.md", "x\\n");
`),
    });
    commit("config");
    write("notes/mine.txt", "my notes\n");
    const r = runAgent(root, dir(), {});
    expect(exists("tmp/agent.txt")).toBe(false);
    expect(read("notes/mine.txt")).toBe("my notes\n");
    expect(exists("architecture/new.md")).toBe(true);
    expect(r.lines.join("\n")).not.toContain("notes/mine.txt");
  });

  it("returns check's result after the run", () => {
    const ok = runAgent(root, dir(), {});
    expect(ok.ok).toBe(true);
    expect(ok.lines.at(-1)).toBe("Map OK.");
    config({
      command: node(
        `require("node:fs").mkdirSync("architecture/services", { recursive: true }); require("node:fs").writeFileSync("architecture/services/bad.md", "---\\nstatus: nope\\n---\\nx\\n")`,
      ),
    });
    const bad = runAgent(root, dir(), {});
    expect(bad.ok).toBe(false);
    expect(bad.lines.some((l) => l.startsWith("error: services/bad.md"))).toBe(
      true,
    );
  });

  it("reports the agent's exit code", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("apps/other.ts", "x"); process.exit(3)`,
      ),
    });
    commit("config");
    expect(runAgent(root, dir(), {})).toEqual({
      ok: false,
      lines: ["Agent command exited 3; nothing kept outside the map."],
    });
    expect(read("apps/other.ts")).toBe("export const other = 1;\n");
  });

  it("undoes the agent's commits and keeps only its map edits", () => {
    config({
      command: node(`
const fs = require("node:fs");
const { execSync } = require("node:child_process");
fs.mkdirSync("architecture/services", { recursive: true });
fs.writeFileSync("architecture/services/x.md", ${JSON.stringify(SERVICE)});
fs.writeFileSync("apps/other.ts", "export const changed = 1;\\n");
fs.writeFileSync("apps/new.ts", "export const added = 1;\\n");
execSync("git add -A && git commit -q -m agent");
`),
    });
    commit("config");
    const before = git("rev-parse", "HEAD");
    const r = runAgent(root, dir(), {});
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(read("architecture/services/x.md")).toBe(SERVICE);
    expect(read("apps/other.ts")).toBe("export const other = 1;\n");
    expect(exists("apps/new.ts")).toBe(false);
    expect(r.lines).toContain(
      "The agent made commits; they were undone and only map edits kept.",
    );
    expect(git("status", "--porcelain")).toBe(
      "A  architecture/services/x.md\n",
    );
  });

  it("deletes a .no-change left from an earlier run before running the agent", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("architecture/ran.txt", "x")`,
      ),
    });
    commit("config");
    write("architecture/.no-change", "stale reason\n");
    const r = runAgent(root, dir(), {});
    expect(exists("architecture/.no-change")).toBe(false);
    expect(r.lines.join("\n")).not.toContain("No map change");
  });

  it("deletes .no-change after a failed run", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("architecture/.no-change", "nothing\\n"); process.exit(2)`,
      ),
    });
    commit("config");
    const r = runAgent(root, dir(), {});
    expect(r.ok).toBe(false);
    expect(exists("architecture/.no-change")).toBe(false);
  });

  it("tells the agent to use .no-change", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("architecture/brief-seen.txt", require("node:fs").readFileSync(0, "utf8"))`,
      ),
    });
    commit("config");
    write("apps/other.ts", "export const other = 2;\n");
    runAgent(root, dir(), { task: "update", base: "HEAD" });
    expect(read("architecture/brief-seen.txt")).toContain(".no-change");
  });

  it("reads, deletes and prints .no-change as the last line", () => {
    config({
      command: node(
        `require("node:fs").writeFileSync("architecture/.no-change", "Only tests changed.\\nmore\\n")`,
      ),
    });
    const r = runAgent(root, dir(), {});
    expect(exists("architecture/.no-change")).toBe(false);
    expect(r.lines.at(-1)).toBe("No map change: Only tests changed.");
    expect(r.lines.at(-2)).toBe("Map OK.");
  });
});
