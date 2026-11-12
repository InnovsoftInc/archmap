// `archmap check`: validate the map against itself and the repo, and report scanner leads.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMap } from "./map/load.ts";
import { schemaProblems } from "./map/schema.ts";
import { evidenceProblems, plannedWithEvidence } from "./map/evidence.ts";
import { findSecrets } from "./map/secrets.ts";
import { unconfirmedLeads } from "./map/leads.ts";
import type { Lead } from "./map/leads.ts";
import { scan } from "./scan/index.ts";
import type { Doc, Finding, LoadedMap, Result } from "./map/types.ts";

export type CheckResult = {
  errors: Finding[];
  warnings: Finding[];
  leads: Lead[];
  map: LoadedMap;
};

const secretProblems = (map: LoadedMap): Finding[] => {
  const texts: [string, string][] = [
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

export const runCheck = (root: string, dir: string): CheckResult => {
  const map = loadMap(dir);
  const errors: Finding[] = [
    ...map.fileErrors,
    ...schemaProblems(map.docs),
    ...evidenceProblems(root, map.docs),
    ...secretProblems(map),
  ];
  if (
    !map.config.name &&
    !map.fileErrors.some((f) => f.file === "archmap.config.json")
  )
    errors.push({ file: "archmap.config.json", message: `"name" is required` });
  const leads = unconfirmedLeads(scan(root), map.docs, map.config.ignore ?? []);
  const warnings: Finding[] = [
    ...leads.map((l) => ({
      file: l.file,
      message: `unconfirmed lead: ${l.text}`,
    })),
    ...plannedWithEvidence(root, map.docs),
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
  if (endpoints + jobs) out.push(`parts: ${endpoints} endpoints, ${jobs} jobs`);
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
