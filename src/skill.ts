// `archmap skill`: puts the /archmap skill in the person's own Claude Code
// skills folder, so it is there in every repository, with or without a map.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./home.ts";
import type { Result } from "./map/types.ts";

/** `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`. */
export const skillsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills");

export const installSkill = (dir: string = skillsDir()): Result => {
  const text = readFileSync(
    join(PACKAGE_ROOT, "skills", "archmap", "SKILL.md"),
    "utf8",
  );
  const file = join(dir, "archmap", "SKILL.md");
  if (existsSync(file) && readFileSync(file, "utf8") === text)
    return { ok: true, lines: [`The archmap skill is already at ${file}.`] };
  const had = existsSync(file);
  mkdirSync(join(dir, "archmap"), { recursive: true });
  writeFileSync(file, text);
  return {
    ok: true,
    lines: [
      `${had ? "Updated" : "Installed"} the archmap skill at ${file}.`,
      "In Claude Code, start a new session and type /archmap, or just ask for the architecture map.",
    ],
  };
};
