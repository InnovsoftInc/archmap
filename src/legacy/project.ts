// Reading an old ledger-format map folder, for `migrate`:
//
//   architecture/
//     archmap.config.json   name, logo, theme, labels (the white-label settings)
//     instructions.md       how to record a change
//     versions.json         { "versions": [{ id, name, published_at, summary, saves }] }
//     saves/<id>.json       one save each: { at, author, summary, ops }

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSave, type Save, type Version } from "./ledger.ts";

export type Config = {
  name: string;
  product?: string;
  logo?: string;
  theme?: { light?: Record<string, string>; dark?: Record<string, string> };
  fonts?: { stylesheet?: string; sans?: string; mono?: string };
  labels?: {
    boundary?: string;
    boundarySub?: string;
    outside?: string;
    outsideSub?: string;
  };
  links?: { label: string; url: string }[];
  watch?: { paths: string[]; means: string; layer: string }[];
};

export type Project = {
  dir: string;
  config: Config;
  saves: Save[];
  versions: Version[];
  instructions: string;
  /** Files that couldn't be read or don't have the right shape. */
  fileErrors: string[];
};

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

export const writeJson = (path: string, data: unknown): void => {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

export const loadProject = (dir: string): Project => {
  if (!existsSync(join(dir, "archmap.config.json"))) {
    throw new Error(
      `No architecture map in ${dir}. Run \`archmap init\` first, or pass --dir.`,
    );
  }
  const fileErrors: string[] = [];
  let config: Config = { name: "Architecture" };
  try {
    config = readJson(join(dir, "archmap.config.json")) as Config;
    if (typeof config.name !== "string" || !config.name)
      fileErrors.push(`archmap.config.json: "name" is required`);
  } catch (err) {
    fileErrors.push(`archmap.config.json: ${(err as Error).message}`);
  }
  const saves: Save[] = [];
  const savesDir = join(dir, "saves");
  if (existsSync(savesDir)) {
    readdirSync(savesDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .forEach((file) => {
        const id = file.slice(0, -5);
        try {
          const raw = readJson(join(savesDir, file));
          const errors = validateSave(raw, id);
          if (errors.length) fileErrors.push(...errors);
          else saves.push({ ...(raw as Omit<Save, "id">), id });
        } catch (err) {
          fileErrors.push(`${id}: ${(err as Error).message}`);
        }
      });
  }
  let versions: Version[] = [];
  const vpath = join(dir, "versions.json");
  if (existsSync(vpath)) {
    try {
      const raw = readJson(vpath) as { versions?: Version[] };
      versions = Array.isArray(raw.versions) ? raw.versions : [];
      const ids = new Set(saves.map((s) => s.id));
      versions.forEach((v) =>
        v.saves.forEach((sid) => {
          if (!ids.has(sid))
            fileErrors.push(
              `versions.json: ${v.name} lists save ${sid}, which doesn't exist`,
            );
        }),
      );
    } catch (err) {
      fileErrors.push(`versions.json: ${(err as Error).message}`);
    }
  }
  const ipath = join(dir, "instructions.md");
  const instructions = existsSync(ipath) ? readFileSync(ipath, "utf8") : "";
  return { dir, config, saves, versions, instructions, fileErrors };
};
