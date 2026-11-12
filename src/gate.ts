// The map gate: a branch that changes the architecture must change the map.

import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";
import { changedFiles, commitMessages, fileAt } from "./git.ts";
import { evidenceOf } from "./map/evidence.ts";
import { loadMap } from "./map/load.ts";
import { unconfirmedLeads } from "./map/leads.ts";
import type { Finding } from "./map/types.ts";
import { scan } from "./scan/index.ts";
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

const dependencyShape = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(
      PACKAGE_KEYS.map((k) => Reflect.get(json, k) ?? null),
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

/** The changed files that count as architectural, with why each does. */
export const architecturalFiles = (
  root: string,
  dir: string,
  base: string,
): GateHit[] => {
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
  const leadByFile = new Map<string, string>();
  for (const lead of unconfirmedLeads(
    scan(root),
    map.docs,
    map.config.ignore ?? [],
  ))
    if (!leadByFile.has(lead.file)) leadByFile.set(lead.file, lead.text);

  const hits: GateHit[] = [];
  for (const file of changed) {
    const owner = evidenceOwner.get(file);
    const lead = leadByFile.get(file);
    const glob = matches(file, watch);
    let why: string | null = null;
    if (owner) why = `evidence of ${owner}`;
    else if (matches(file, STRUCTURAL)) why = "structural file";
    else if (
      (file === "package.json" || file.endsWith("/package.json")) &&
      dependenciesChanged(root, base, file)
    )
      why = "dependencies changed";
    else if (lead) why = `new lead: ${lead}`;
    else if (glob) why = `matches watch ${glob}`;
    if (why) hits.push({ file, why });
  }
  return hits;
};

const NO_CHANGE_TRAILER = /^Archmap: none - \S/m;

export const gateProblems = (
  root: string,
  dir: string,
  base: string,
): Finding[] => {
  const hits = architecturalFiles(root, dir, base);
  if (!hits.length) return [];
  const prefix = mapPrefix(root, dir);
  const mapChanged = changedFiles(root, base).some(
    (f) => f.startsWith(prefix) && f !== `${prefix}.no-change`,
  );
  if (mapChanged || NO_CHANGE_TRAILER.test(commitMessages(root, base)))
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
