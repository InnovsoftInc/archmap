// Reading a markdown map folder: archmap.config.json, README.md and one .md file per thing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLError } from "yaml";
import { FOLDERS } from "./types.ts";
import type { Doc, Finding, LoadedMap, MapConfig } from "./types.ts";

// The parser's own message ends "at line N, column M:" and a code frame; keep
// the first part and give the line in the file (the frontmatter starts on
// line 2).
const yamlError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  const reason = message.split(/ at line \d+|\n/)[0]?.trim() ?? message;
  const line =
    err instanceof YAMLError && err.linePos ? err.linePos[0].line + 1 : 0;
  return line
    ? `invalid YAML at line ${line}: ${reason}`
    : `invalid YAML: ${reason}`;
};

export const splitFrontmatter = (
  text: string,
): { data: Record<string, unknown>; body: string } | { error: string } => {
  // A byte-order mark or trailing spaces on a --- line are invisible in an
  // editor, so they don't stop the frontmatter being read.
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const isFence = (line: string | undefined) => line?.trimEnd() === "---";
  if (!isFence(lines[0])) return { error: "missing frontmatter (--- block)" };
  const end = lines.findIndex((line, i) => i > 0 && isFence(line));
  if (end === -1) return { error: "frontmatter is not closed with ---" };
  let data: unknown;
  try {
    data = parse(lines.slice(1, end).join("\n"));
  } catch (err) {
    return { error: yamlError(err) };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { error: "frontmatter must be a YAML mapping" };
  return {
    data: data as Record<string, unknown>,
    body: lines.slice(end + 1).join("\n"),
  };
};

export const loadMap = (dir: string): LoadedMap => {
  const fileErrors: Finding[] = [];
  let config: MapConfig = { name: "Architecture" };
  const configPath = join(dir, "archmap.config.json");
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        fileErrors.push({
          file: "archmap.config.json",
          message: "must be a JSON object",
        });
      else {
        config = parsed as MapConfig;
        if (typeof config.name !== "string" || !config.name)
          fileErrors.push({
            file: "archmap.config.json",
            message: `"name" is required`,
          });
      }
    } catch (err) {
      fileErrors.push({
        file: "archmap.config.json",
        message: (err as Error).message,
      });
    }
  } else {
    fileErrors.push({
      file: "archmap.config.json",
      message: "file is missing",
    });
  }

  const readmePath = join(dir, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";

  const docs: Doc[] = [];
  const failedIds: string[] = [];
  for (const folder of FOLDERS) {
    const folderDir = join(dir, folder);
    if (!existsSync(folderDir)) continue;
    const entries = readdirSync(folderDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort((a, b) => (a.slice(0, -3) < b.slice(0, -3) ? -1 : 1));
    for (const name of entries) {
      const file = `${folder}/${name}`;
      const parsed = splitFrontmatter(
        readFileSync(join(folderDir, name), "utf8"),
      );
      if ("error" in parsed) {
        fileErrors.push({ file, message: parsed.error });
        failedIds.push(name.slice(0, -3));
        continue;
      }
      docs.push({ id: name.slice(0, -3), folder, file, ...parsed });
    }
  }
  return { dir, config, readme, docs, fileErrors, failedIds };
};
