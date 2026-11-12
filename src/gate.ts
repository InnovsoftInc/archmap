// The map gate: a branch that changes the architecture must change the map.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import {
  changedFiles,
  commitsSince,
  fileAt,
  filesAt,
  resolveBase,
  uncommittedFiles,
} from "./git.ts";
import { evidenceOf } from "./map/evidence.ts";
import { loadMap } from "./map/load.ts";
import { leadsOf, unconfirmedLeads } from "./map/leads.ts";
import type { Finding, LoadedMap } from "./map/types.ts";
import { scan, scannerReads } from "./scan/index.ts";
import { cliCommand } from "./version.ts";

export type GateHit = { file: string; why: string };

const STRUCTURAL = [
  "**/*.csproj",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/go.mod",
  "**/Dockerfile*",
  "**/*compose*.yml",
  "**/*compose*.yaml",
  "**/*.tf",
  "**/*.bicep",
  "**/schema.prisma",
  "**/migrations/**",
  "**/*.sql",
  ".github/workflows/**",
  "azure-pipelines*.yml",
  ".azure-pipelines/**",
];

const PACKAGE_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "workspaces",
] as const;

const matches = (file: string, globs: string[]): string | undefined =>
  globs.find((g) => matchesGlob(file, g));

/** What in a package.json is architectural: the package names it depends on, and its workspaces. Versions are not. */
const dependencyShape = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(
      PACKAGE_KEYS.map((k) => {
        const v: unknown = Reflect.get(json, k);
        if (k === "workspaces") return v ?? null;
        return v && typeof v === "object" ? Object.keys(v).sort() : [];
      }),
    );
  } catch {
    return null;
  }
};

const dependenciesChanged = (
  root: string,
  base: string,
  file: string,
): boolean => {
  const abs = join(root, file);
  const now = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const before = dependencyShape(fileAt(root, base, file));
  const after = dependencyShape(now);
  return before === null || after === null || before !== after;
};

const mapPrefix = (root: string, dir: string): string => {
  const rel = relative(resolve(root), resolve(root, dir)).split("\\").join("/");
  return rel ? `${rel}/` : "";
};

const isPackageJson = (file: string): boolean =>
  file === "package.json" || file.endsWith("/package.json");

/** For each changed file, its first unconfirmed lead that didn't exist at `base`. */
const newLeadsByFile = (
  root: string,
  base: string,
  changed: string[],
  map: LoadedMap,
): Map<string, string> => {
  const out = new Map<string, string>();
  const now = unconfirmedLeads(
    scan(root),
    map.docs,
    map.config.ignore ?? [],
  ).filter((l) => changed.includes(l.file) && !isPackageJson(l.file));
  if (!now.length) return out;
  // Scan the repo as it was at base, in a temp dir at the same paths: every
  // file a reader opens, so a route still gets the prefixes of the files
  // that mount it. Only the changed files' leads are compared.
  const old = mkdtempSync(join(tmpdir(), "archmap-base-"));
  try {
    for (const [file, text] of filesAt(root, base, scannerReads)) {
      mkdirSync(dirname(join(old, file)), { recursive: true });
      writeFileSync(join(old, file), text);
    }
    const before = new Set(leadsOf(scan(old)).map((l) => l.key));
    for (const lead of now)
      if (!before.has(lead.key) && !out.has(lead.file))
        out.set(lead.file, lead.text);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
  return out;
};

/** The changed files that count as architectural, with why each does. */
export const architecturalFiles = (
  root: string,
  dir: string,
  name: string,
): GateHit[] => {
  const base = resolveBase(root, name);
  const map = loadMap(dir);
  const prefix = mapPrefix(root, dir);
  const skip = map.config.agent?.skip ?? [];
  const watch = map.config.watch ?? [];
  const changed = changedFiles(root, base).filter(
    (f) => !(prefix && f.startsWith(prefix)) && !matches(f, skip),
  );
  if (!changed.length) return [];

  const evidenceOwner = new Map<string, string>();
  for (const doc of map.docs)
    for (const c of evidenceOf(doc)) {
      const file = c.evidence.split("#")[0];
      if (!evidenceOwner.has(file)) evidenceOwner.set(file, doc.file);
    }
  const newLeads = newLeadsByFile(root, base, changed, map);

  const hits: GateHit[] = [];
  for (const file of changed) {
    const owner = evidenceOwner.get(file);
    const lead = newLeads.get(file);
    const glob = matches(file, watch);
    let why: string | null = null;
    if (owner) why = `evidence of ${owner}`;
    else if (matches(file, STRUCTURAL)) why = "structural file";
    else if (isPackageJson(file)) {
      if (dependenciesChanged(root, base, file)) why = "dependencies changed";
    } else if (lead) why = `new lead: ${lead}`;
    if (!why && glob) why = `matches watch ${glob}`;
    if (why) hits.push({ file, why });
  }
  return hits;
};

const NO_CHANGE_TRAILER = /^Archmap: none - \S/m;

/**
 * Whether the architectural changes are covered: a map change (other than .no-change) or an
 * "Archmap: none" trailer in the last commit that touches an architectural file, or later.
 * Uncommitted changes count as the newest.
 */
const covered = (
  root: string,
  prefix: string,
  base: string,
  hits: GateHit[],
): boolean => {
  const architectural = new Set(hits.map((h) => h.file));
  const isMap = (f: string) =>
    f.startsWith(prefix) && f !== `${prefix}.no-change`;
  const uncommitted = uncommittedFiles(root);
  if (uncommitted.some(isMap)) return true;
  if (uncommitted.some((f) => architectural.has(f))) return false;
  const commits = commitsSince(root, base);
  const last = commits.findLastIndex((c) =>
    c.files.some((f) => architectural.has(f)),
  );
  return commits
    .slice(Math.max(last, 0))
    .some((c) => c.files.some(isMap) || NO_CHANGE_TRAILER.test(c.message));
};

export const gateProblems = (
  root: string,
  dir: string,
  base: string,
): Finding[] => {
  const hits = architecturalFiles(root, dir, base);
  if (!hits.length) return [];
  if (covered(root, mapPrefix(root, dir), resolveBase(root, base), hits))
    return [];
  const map = loadMap(dir);
  const shown = hits.slice(0, 5).map((h) => `  ${h.file}: ${h.why}`);
  if (hits.length > 5) shown.push(`  …and ${hits.length - 5} more`);
  return [
    {
      file: "",
      message: [
        "This branch changes the architecture but not the map:",
        ...shown,
        `Update the map (run ${cliCommand(map.config, dir, root)} brief --base ${base} with your agent) or add "Archmap: none - <reason>" to a commit.`,
      ].join("\n"),
    },
  ];
};
