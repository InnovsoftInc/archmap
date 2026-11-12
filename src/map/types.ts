// The shapes of a markdown map: one file per thing, YAML frontmatter plus a markdown body.

export const FOLDERS = [
  "services",
  "stores",
  "external",
  "personas",
  "flows",
] as const;
export type Folder = (typeof FOLDERS)[number];

/** "path" or "path#Symbol" */
export type Evidence = string;

export type Doc = {
  id: string;
  folder: Folder;
  /** Relative to the map dir, e.g. "services/api.md". */
  file: string;
  /** Parsed frontmatter. */
  data: Record<string, unknown>;
  /** Markdown after the frontmatter. */
  body: string;
};

export type MapConfig = {
  archmap?: string;
  name: string;
  cli?: string;
  agent?: { command?: string; skip?: string[] };
  ignore?: string[];
  watch?: string[];
  deploy?: Record<string, unknown>;
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
};

export type Finding = { file: string; message: string };

export type LoadedMap = {
  dir: string;
  config: MapConfig;
  readme: string;
  docs: Doc[];
  fileErrors: Finding[];
  /** Ids of docs that failed to load; references to them aren't reported as missing. */
  failedIds: string[];
};

export type Result = { ok: boolean; lines: string[] };
