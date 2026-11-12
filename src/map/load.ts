// Reading a markdown map folder: archmap.config.json, README.md and one .md file per thing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { FOLDERS } from "./types.ts";
import type { Doc, Finding, LoadedMap, MapConfig } from "./types.ts";

export const splitFrontmatter = (
  text: string,
): { data: Record<string, unknown>; body: string } | { error: string } => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { error: "missing frontmatter (--- block)" };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { error: "frontmatter is not closed with ---" };
  let data: unknown;
  try {
    data = parse(lines.slice(1, end).join("\n"));
  } catch (err) {
    return { error: `invalid YAML: ${(err as Error).message}` };
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
        continue;
      }
      docs.push({ id: name.slice(0, -3), folder, file, ...parsed });
    }
  }
  return { dir, config, readme, docs, fileErrors };
};
