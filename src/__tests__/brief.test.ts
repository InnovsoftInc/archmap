import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, pickTask } from "../brief.ts";
import type { Doc } from "../map/types.ts";

let root: string;
const dir = () => join(root, "architecture");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const config = (extra: Record<string, unknown> = {}) =>
  write(
    "architecture/archmap.config.json",
    JSON.stringify({ name: "Test", ...extra }),
  );
const api = (extra = "") =>
  write(
    "architecture/services/api.md",
    `---\nname: API\nstatus: live\nkind: api\n${extra}---\nServes requests.\n\n## How it works\n\nx\n\n## For developers\n\nx\n`,
  );
const initRepo = () => {
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "base");
};
const doc = (): Doc => ({
  id: "api",
  folder: "services",
  file: "services/api.md",
  data: {},
  body: "",
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archmap-brief-")));
  config();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pickTask", () => {
  it("picks setup for an empty map, update with --base, review otherwise, and an explicit task always", () => {
    expect(pickTask([], {})).toBe("setup");
    expect(pickTask([], { base: "main" })).toBe("setup");
    expect(pickTask([doc()], { base: "main" })).toBe("update");
    expect(pickTask([doc()], {})).toBe("review");
    expect(pickTask([], { task: "hosting" })).toBe("hosting");
    expect(pickTask([doc()], { task: "setup", base: "main" })).toBe("setup");
  });
});

describe("brief", () => {
  it("includes the rules, the format, ground rules, check results and the done command in every task", () => {
    api();
    for (const task of ["setup", "review", "hosting"] as const) {
      const out = brief(root, dir(), { task });
      expect(out).toContain(`# archmap brief: ${task}`);
      expect(out).toContain("## Your task");
      expect(out).toContain("## What belongs on the map");
      expect(out).toContain("Never put on the map");
      expect(out).toContain("## How to write map files");
      expect(out).toContain("## For developers");
      expect(out).toContain("## Ground rules");
      expect(out).toContain("## Current check results");
      expect(out).toContain("## Leads from scan");
      expect(out).toContain("## When you're done");
      expect(out).toContain("check` and fix every error until it passes.");
    }
    expect(brief(root, dir(), { task: "setup" })).toContain("What's deployed");
    expect(brief(root, dir(), { task: "review" })).toContain("What's deployed");
    expect(brief(root, dir(), { task: "hosting" })).toContain(
      "Detect the CI system",
    );
  });

  it("lists check errors and warnings, or None.", () => {
    api("endpoints:\n  - route: GET /x\n    evidence: missing.ts\n");
    const out = brief(root, dir(), { task: "review" });
    expect(out).toContain("missing.ts does not exist");
    api();
    expect(brief(root, dir(), { task: "review" })).toContain("None.");
  });

  it("for update lists changed files and the map files that cover them by code prefix and evidence", () => {
    write("apps/api/src/a.ts", "a\n");
    write("apps/web/src/b.ts", "b\n");
    write("libs/c.ts", "c\n");
    write("other/d.ts", "d\n");
    api(
      "code:\n  - apps/api\nendpoints:\n  - route: GET /x\n    evidence: libs/c.ts\n",
    );
    initRepo();
    write("apps/api/src/a.ts", "a2\n");
    write("libs/c.ts", "c2\n");
    write("other/d.ts", "d2\n");
    const out = brief(root, dir(), { task: "update", base: "HEAD" });
    expect(out).toContain("## What changed since HEAD");
    expect(out).toContain("- apps/api/src/a.ts");
    expect(out).toContain("- other/d.ts");
    expect(out).toContain("Map files that cover them:");
    expect(out).toContain("- services/api.md");
    expect(out.match(/- services\/api\.md/g)).toHaveLength(1);
  });

  it("compares an update with the config's base when --base isn't given", () => {
    config({ base: "dev" });
    api();
    initRepo();
    git("branch", "dev");
    write("apps/a.ts", "a\n");
    const out = brief(root, dir(), { task: "update" });
    expect(out).toContain("## What changed since dev");
    expect(out).toContain("- apps/a.ts");
  });

  it("compares with the origin/HEAD branch when neither --base nor the config's base is set", () => {
    api();
    initRepo();
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
    git("branch", "dev");
    write("apps/a.ts", "a\n");
    expect(brief(root, dir(), { task: "update" })).toContain(
      "## What changed since dev",
    );
  });

  it("includes the gate's finding in the check results with --base", () => {
    write("apps/api/src/a.ts", "a\n");
    api("endpoints:\n  - route: GET /a\n    evidence: apps/api/src/a.ts\n");
    initRepo();
    write("apps/api/src/a.ts", "a2\n");
    const results = (base?: string) =>
      brief(root, dir(), { task: "update", base })
        .split("## Current check results")[1]
        ?.split("## Leads")[0];
    expect(results("HEAD")).toContain(
      "This branch changes the architecture but not the map",
    );
    expect(results("HEAD")).toContain(
      "apps/api/src/a.ts: evidence of services/api.md",
    );
  });

  it("tells a person to add the trailer, and only the agent run to write .no-change", () => {
    api();
    initRepo();
    write("other/d.ts", "d2\n");
    const forPerson = brief(root, dir(), { task: "update", base: "HEAD" });
    expect(forPerson).not.toContain(".no-change");
    expect(forPerson).toContain(
      "If nothing on the map needs to change, add `Archmap: none - <reason>` to your commit message",
    );
    const forAgent = brief(root, dir(), {
      task: "update",
      base: "HEAD",
      forAgent: true,
    });
    expect(forAgent).toContain("architecture/.no-change");
    expect(forAgent).not.toContain("Archmap: none");
  });

  it("lists leads only under Leads from scan, not in the check results", () => {
    write(
      "apps/api/src/routes.ts",
      'import express from "express";\nconst app = express();\napp.get("/r1", (_req, res) => res.send("ok"));\n',
    );
    const out = brief(root, dir(), { task: "setup" });
    const results = out
      .split("## Current check results")[1]
      .split("## Leads")[0];
    expect(results).not.toContain("unconfirmed lead");
    expect(results).not.toContain("GET /r1");
    expect(out.split("## Leads from scan")[1]).toContain("GET /r1");
  });

  it("omits the map files line when none cover the change", () => {
    api("code:\n  - apps/api\n");
    write("other/d.ts", "d\n");
    initRepo();
    write("other/d.ts", "d2\n");
    const out = brief(root, dir(), { task: "update", base: "HEAD" });
    expect(out).not.toContain("- services/api.md");
  });

  it("caps leads at 200", () => {
    const routes = Array.from(
      { length: 205 },
      (_, i) => `app.get("/r${i}", (_req, res) => res.send("ok"));`,
    ).join("\n");
    write(
      "apps/api/src/routes.ts",
      `import express from "express";\nconst app = express();\n${routes}\n`,
    );
    const out = brief(root, dir(), { task: "setup" });
    const section = out.split("## Leads from scan")[1].split("## When")[0];
    expect(section.match(/^- /gm)?.length).toBe(200);
    expect(section).toMatch(/…and \d+ more/);
  });

  it("uses config.cli and adds --dir when the folder isn't architecture", () => {
    config({ cli: "archmap" });
    expect(brief(root, dir(), { task: "review" })).toContain(
      "Run `archmap check`",
    );
    mkdirSync(join(root, "docs/map"), { recursive: true });
    write("docs/map/archmap.config.json", JSON.stringify({ name: "T" }));
    expect(brief(root, join(root, "docs/map"), { task: "review" })).toContain(
      "npx -y github:",
    );
    expect(brief(root, join(root, "docs/map"), { task: "review" })).toContain(
      "--dir docs/map check",
    );
  });

  it("works outside a git repo for setup and review", () => {
    expect(() => brief(root, dir(), { task: "setup" })).not.toThrow();
    expect(() => brief(root, dir(), { task: "review" })).not.toThrow();
  });

  it("names the ref when --base is unknown", () => {
    api();
    initRepo();
    expect(() => brief(root, dir(), { base: "nope" })).toThrow(
      /Can't compare with nope/,
    );
  });
});
