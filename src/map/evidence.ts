// Checking that the evidence and code paths a map cites exist in the repo.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isPlanned } from "./schema.ts";
import type { Doc, Finding } from "./types.ts";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const entries = (doc: Doc, key: string): [unknown, string][] =>
  list(Reflect.get(doc.data, key)).map((e, i) => [e, `${key}[${i}]`]);

/** `planned` marks an entry with `status: planned`, whose evidence isn't checked yet. */
type Cited = { field: string; evidence: string; planned?: true };

/** Every `evidence` in the doc with its field path; columns without their own are not listed. */
export const evidenceOf = (doc: Doc): Cited[] => {
  const out: Cited[] = [];
  const add = (entry: unknown, path: string) => {
    if (isObject(entry) && typeof entry.evidence === "string")
      out.push({
        field: `${path}.evidence`,
        evidence: entry.evidence,
        ...(entry.status === "planned" ? { planned: true as const } : {}),
      });
  };
  for (const key of ["connects", "endpoints", "jobs", "libraries", "roles"])
    for (const [entry, path] of entries(doc, key)) add(entry, path);
  for (const [table, path] of entries(doc, "tables")) {
    add(table, path);
    if (isObject(table))
      list(table.columns).forEach((c, i) => add(c, `${path}.columns[${i}]`));
  }
  for (const [entry, path] of entries(doc, "enums")) add(entry, path);
  return out;
};

const escapes = (root: string, abs: string): boolean => {
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel);
};

/** The absolute path, or null when it leaves the repo, lexically or through a symlink. */
const inside = (root: string, path: string): string | null => {
  const abs = resolve(root, path);
  if (escapes(root, abs)) return null;
  if (existsSync(abs) && escapes(realpathSync(root), realpathSync(abs)))
    return null;
  return abs;
};

const isFile = (abs: string): boolean =>
  existsSync(abs) && statSync(abs).isFile();

const split = (evidence: string): [string, string | undefined] => {
  const at = evidence.indexOf("#");
  return at < 0
    ? [evidence, undefined]
    : [evidence.slice(0, at), evidence.slice(at + 1)];
};

/** Why `evidence` doesn't hold, or null when it does. */
const evidenceProblem = (root: string, c: Cited): string | null => {
  const [path, symbol] = split(c.evidence);
  const abs = inside(root, path);
  if (abs === null || (existsSync(abs) && !isFile(abs)))
    return `${c.field} ${c.evidence} must be a file inside the repo`;
  if (!isFile(abs)) return `${c.field} ${c.evidence} does not exist`;
  if (symbol && !readFileSync(abs, "utf8").includes(symbol))
    return `${c.field}: ${JSON.stringify(symbol)} not found in ${path}`;
  return null;
};

export const evidenceProblems = (root: string, docs: Doc[]): Finding[] => {
  const findings: Finding[] = [];
  for (const doc of docs) {
    if (isPlanned(doc)) continue;
    const add = (message: string) => findings.push({ file: doc.file, message });
    for (const c of evidenceOf(doc)) {
      if (c.planned) continue;
      const problem = evidenceProblem(root, c);
      if (problem) add(problem);
    }
    for (const code of list(doc.data.code)) {
      if (typeof code !== "string") continue;
      const abs = inside(root, code);
      if (abs === null) add(`code ${code} must be inside the repo`);
      else if (!existsSync(abs)) add(`code ${code} does not exist`);
    }
  }
  return findings;
};

/** Warnings: planned docs whose evidence already exists, so they may be live now. */
export const plannedWithEvidence = (root: string, docs: Doc[]): Finding[] =>
  docs.filter(isPlanned).flatMap((doc) =>
    evidenceOf(doc)
      .filter((c) => evidenceProblem(root, c) === null)
      .map((c) => ({
        file: doc.file,
        message: `${c.field} ${c.evidence} exists but the doc is still planned`,
      })),
  );
