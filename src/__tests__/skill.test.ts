import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../home.ts";
import { installSkill, skillsDir } from "../skill.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archmap-skill-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const source = readFileSync(
  join(PACKAGE_ROOT, "skills", "archmap", "SKILL.md"),
  "utf8",
);

describe("the archmap skill", () => {
  it("installs into the person's skills folder, and says so once", () => {
    const file = join(dir, "archmap", "SKILL.md");
    expect(installSkill(dir).lines[0]).toBe(
      `Installed the archmap skill at ${file}.`,
    );
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(installSkill(dir).lines).toEqual([
      `The archmap skill is already at ${file}.`,
    ]);
    expect(skillsDir({ CLAUDE_CONFIG_DIR: "/x/claude" })).toBe(
      join("/x/claude", "skills"),
    );
  });

  it("has frontmatter Claude Code can read, and names only commands that exist", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
    expect(front).toMatch(/^name: archmap$/m);
    expect(front).toMatch(/^description: Use when /m);
    expect(front.length).toBeLessThan(1024);
    const help = readFileSync(join(PACKAGE_ROOT, "src", "cli.ts"), "utf8");
    for (const [, cmd] of source.matchAll(/`ARCHMAP ([a-z]+)/g))
      expect(
        help.includes(`case "${cmd}"`) || help.includes(`cmd === "${cmd}"`),
      ).toBe(true);
    // It ships with the package, or `archmap skill` has nothing to install.
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("skills");
  });
});
