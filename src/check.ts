// `archmap check`: validate the map against itself and the repo, and report scanner leads.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapAt,
  newEndpointProblems,
  staleEntries,
  undocumented,
} from "./drift.ts";
import { gateProblems } from "./gate.ts";
import { forkPoint, resolveBase } from "./git.ts";
import { loadMap } from "./map/load.ts";
import { schemaProblems } from "./map/schema.ts";
import { laneProblems } from "./map/lanes.ts";
import { evidenceProblems, plannedWithEvidence } from "./map/evidence.ts";
import { findSecrets } from "./map/secrets.ts";
import { unconfirmedLeads } from "./map/leads.ts";
import type { Lead } from "./map/leads.ts";
import { scan } from "./scan/index.ts";
import type { Doc, Finding, LoadedMap, Result } from "./map/types.ts";
import { cliCommand } from "./version.ts";

export type CheckResult = {
  errors: Finding[];
  warnings: Finding[];
  leads: Lead[];
  map: LoadedMap;
};

/** How check words a scanner lead it can't find on the map. */
export const LEAD_WARNING = "unconfirmed lead: ";

const configText = (dir: string): string => {
  const file = join(dir, "archmap.config.json");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const secretProblems = (map: LoadedMap): Finding[] => {
  const texts: [string, string][] = [
    ["archmap.config.json", configText(map.dir)],
    ["README.md", map.readme],
    ...map.docs.map((d): [string, string] => [
      d.file,
      readFileSync(join(map.dir, d.file), "utf8"),
    ]),
  ];
  return texts.flatMap(([file, text]) =>
    findSecrets(text).map((name) => ({
      file,
      message: `looks like a ${name}`,
    })),
  );
};

/**
 * Warnings: a persona no flow step is taken by. The viewer still draws them,
 * but with no arrow, since only a flow says what a persona uses.
 */
const personasWithoutFlows = (docs: Doc[]): Finding[] => {
  const acting = new Set(
    docs
      .filter((d) => d.folder === "flows")
      .flatMap((d) =>
        (Array.isArray(d.data.steps) ? d.data.steps : []).flatMap(
          (s: unknown) =>
            s && typeof s === "object" && "by" in s && typeof s.by === "string"
              ? [s.by]
              : [],
        ),
      ),
  );
  return docs
    .filter((d) => d.folder === "personas" && !acting.has(d.id))
    .map((d) => ({
      file: d.file,
      message: `no flow has a step by \`${d.id}\`, so the map doesn't show what they use. Add a flow with \`persona: ${d.id}\` and steps \`by: ${d.id}\`.`,
    }));
};

const mapBefore = (root: string, dir: string, base: string): Doc[] => {
  try {
    return mapAt(root, dir, forkPoint(root, resolveBase(root, base)));
  } catch {
    return [];
  }
};

export const runCheck = (
  root: string,
  dir: string,
  opts: { base?: string } = {},
): CheckResult => {
  const map = loadMap(dir);
  // The map as this branch found it, to tell new entries from old ones.
  const before = opts.base ? mapBefore(root, dir, opts.base) : [];
  const errors: Finding[] = [
    ...map.fileErrors,
    ...schemaProblems(map.docs, map.failedIds),
    ...evidenceProblems(root, map.docs),
    ...secretProblems(map),
    ...laneProblems(map.config, map.docs),
    ...(opts.base ? gateProblems(root, dir, opts.base) : []),
    ...newEndpointProblems(map.docs, before),
  ];
  if (!map.docs.length && existsSync(join(dir, "saves")))
    errors.push({
      file: "",
      message: `This map uses the old save ledger. Run "${cliCommand(map.config, dir, root)} migrate" first.`,
    });
  if (
    !map.config.name &&
    !map.fileErrors.some((f) => f.file === "archmap.config.json")
  )
    errors.push({ file: "archmap.config.json", message: `"name" is required` });
  const leads = unconfirmedLeads(scan(root), map.docs, map.config.ignore ?? []);
  const warnings: Finding[] = [
    ...leads.map((l) => ({
      file: l.file,
      message: `${LEAD_WARNING}${l.text}`,
    })),
    ...plannedWithEvidence(root, map.docs),
    ...(opts.base ? staleEntries(root, dir, opts.base, map.docs, before) : []),
    ...undocumented(map.docs),
    ...personasWithoutFlows(map.docs),
  ];
  return { errors, warnings, leads, map };
};

const where = (f: Finding): string => (f.file ? `${f.file}: ` : "");

const count = (docs: Doc[], folder: string): number =>
  docs.filter((d) => d.folder === folder).length;
const itemsIn = (docs: Doc[], key: string): number =>
  docs.reduce((n, d) => {
    const v: unknown = Reflect.get(d.data, key);
    return n + (Array.isArray(v) ? v.length : 0);
  }, 0);

const layers = (docs: Doc[]): string[] => {
  const out: string[] = [];
  const services = count(docs, "services");
  const stores = count(docs, "stores");
  const external = count(docs, "external");
  if (services + stores + external)
    out.push(
      `overview: ${services} services, ${stores} stores, ${external} external`,
    );
  const endpoints = itemsIn(docs, "endpoints");
  const jobs = itemsIn(docs, "jobs");
  const libraries = itemsIn(docs, "libraries");
  const env = itemsIn(docs, "env");
  if (endpoints + jobs + libraries + env)
    out.push(
      `parts: ${endpoints} endpoints, ${jobs} jobs, ${libraries} libraries, ${env} environment variables`,
    );
  const tables = itemsIn(docs, "tables");
  if (tables) out.push(`data: ${tables} tables`);
  const personas = count(docs, "personas");
  const flows = count(docs, "flows");
  if (personas + flows)
    out.push(`people and flows: ${personas} personas, ${flows} flows`);
  return out;
};

export const formatCheck = (
  r: CheckResult,
  opts: { strict?: boolean; json?: boolean },
): Result => {
  const ok = r.errors.length === 0 && (!opts.strict || r.warnings.length === 0);
  if (opts.json)
    return {
      ok,
      lines: [
        JSON.stringify({ errors: r.errors, warnings: r.warnings }, null, 2),
      ],
    };
  const total = r.errors.length + r.warnings.length;
  return {
    ok,
    lines: [
      ...r.errors.map((f) => `error: ${where(f)}${f.message}`),
      ...r.warnings.map((f) => `warning: ${where(f)}${f.message}`),
      ...layers(r.map.docs),
      ok ? "Map OK." : `${total} problems.`,
    ],
  };
};
