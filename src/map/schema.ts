// Checking a map's frontmatter, ids, references and headings. A table of field specs per
// folder, run by one small validator (no schema library).

import type { Doc, Finding, Folder } from "./types.ts";

type Spec =
  | { t: "string"; required?: boolean }
  | { t: "bool" }
  | { t: "enum"; values: string[]; required?: boolean }
  | { t: "strings" }
  | { t: "route" }
  | { t: "list"; item: Shape };
type Shape = Record<string, Spec>;

const STATUSES = ["live", "planned", "retiring"];
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

const req: Spec = { t: "string", required: true };
const opt: Spec = { t: "string" };
const connects: Spec = {
  t: "list",
  item: {
    to: req,
    why: opt,
    how: opt,
    status: { t: "enum", values: STATUSES },
    evidence: opt,
  },
};
const kind = (...values: string[]): Spec => ({
  t: "enum",
  values,
  required: true,
});

const COMMON: Shape = {
  name: req,
  status: { t: "enum", values: STATUSES, required: true },
  code: { t: "strings" },
};

const SHAPES: Record<Folder, Shape> = {
  services: {
    ...COMMON,
    kind: kind("app", "api", "worker", "job"),
    connects,
    endpoints: { t: "list", item: { route: { t: "route" }, evidence: opt } },
    jobs: { t: "list", item: { name: req, schedule: opt, evidence: opt } },
    libraries: { t: "list", item: { name: req, why: opt, evidence: opt } },
  },
  stores: {
    ...COMMON,
    kind: kind("database", "queue", "bucket", "cache"),
    connects,
    tables: {
      t: "list",
      item: {
        name: req,
        group: opt,
        purpose: opt,
        evidence: opt,
        columns: {
          t: "list",
          item: {
            name: req,
            type: opt,
            pk: { t: "bool" },
            unique: { t: "bool" },
            fk: opt,
            enum: opt,
            desc: opt,
            evidence: opt,
          },
        },
      },
    },
    enums: {
      t: "list",
      item: { name: req, values: { t: "strings" }, evidence: opt },
    },
  },
  external: {
    ...COMMON,
    kind: kind("auth", "email", "payments", "ai", "hosting", "other"),
    connects,
  },
  personas: {
    ...COMMON,
    roles: { t: "list", item: { name: req, evidence: opt } },
    needs: { t: "strings" },
  },
  flows: {
    ...COMMON,
    persona: req,
    steps: { t: "list", item: { by: req, at: req, does: req } },
  },
};

/**
 * Lists whose entries must cite evidence unless the doc is planned. A `connects`
 * entry may also be planned on its own (only `connects` entries have a status).
 */
const NEEDS_EVIDENCE = ["connects", "endpoints", "jobs", "tables", "roles"];

export const isPlanned = (doc: Doc): boolean => doc.data.status === "planned";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";
const get = (o: object, key: string): unknown => Reflect.get(o, key);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = (values: string[]) => values.join(", ");

/** Check `value` against `spec`; `path` is the field path used in messages. */
const check = (
  value: unknown,
  spec: Spec,
  path: string,
  out: string[],
): void => {
  if (value === undefined) {
    if ("required" in spec && spec.required)
      out.push(
        spec.t === "enum"
          ? `${path} is required (one of ${oneOf(spec.values)})`
          : `${path} must be a non-empty string`,
      );
    return;
  }
  switch (spec.t) {
    case "string":
      if (!isText(value)) out.push(`${path} must be a non-empty string`);
      return;
    case "bool":
      if (typeof value !== "boolean") out.push(`${path} must be a boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value))
        out.push(
          `${path} ${JSON.stringify(value)} must be one of ${oneOf(spec.values)}`,
        );
      return;
    case "route":
      if (typeof value !== "string" || !ROUTE.test(value))
        out.push(`${path} ${JSON.stringify(value)} must be METHOD /path`);
      return;
    case "strings":
      if (!Array.isArray(value)) out.push(`${path} must be a list of strings`);
      else
        value.forEach((v, i) => {
          if (typeof v !== "string") out.push(`${path}[${i}] must be a string`);
        });
      return;
    case "list":
      if (!Array.isArray(value)) {
        out.push(`${path} must be a list`);
        return;
      }
      value.forEach((entry, i) => {
        if (!isObject(entry)) {
          out.push(`${path}[${i}] must be a mapping`);
          return;
        }
        for (const key of Object.keys(entry))
          if (!(key in spec.item))
            out.push(`${path}[${i}] has unknown key ${JSON.stringify(key)}`);
        for (const [key, sub] of Object.entries(spec.item))
          check(get(entry, key), sub, `${path}[${i}].${key}`, out);
      });
  }
};

const hasHeading = (body: string, title: string): boolean =>
  body.split("\n").some((line) => line.trimEnd() === `## ${title}`);

const headingProblems = (doc: Doc): string[] => {
  if (doc.folder === "external" || doc.folder === "personas")
    return doc.body.trim() === "" ? ["needs a description in the body"] : [];
  const out: string[] = [];
  const intro = doc.body.split(/^## /m)[0] ?? "";
  if (intro.trim() === "") out.push("needs text before the first ## heading");
  for (const title of ["How it works", "For developers"])
    if (!hasHeading(doc.body, title)) out.push(`needs a ## ${title} heading`);
  return out;
};

type Ref = { folders: Folder[]; describe: string };
const PERSONA: Ref = { folders: ["personas"], describe: "a persona" };
const ACTOR: Ref = {
  folders: ["personas", "services"],
  describe: "a persona or service",
};
const PLACE: Ref = {
  folders: ["services", "stores", "external"],
  describe: "a service, store or external",
};

export const schemaProblems = (docs: Doc[]): Finding[] => {
  const findings: Finding[] = [];
  const byFolder = (folders: Folder[]) =>
    new Set(docs.filter((d) => folders.includes(d.folder)).map((d) => d.id));
  const firstWithId = new Map<string, Doc>();

  for (const doc of docs) {
    const out: string[] = [];
    const shape = SHAPES[doc.folder];

    if (!ID.test(doc.id))
      out.push(
        `id ${JSON.stringify(doc.id)} must be lowercase letters, digits and dashes`,
      );
    const first = firstWithId.get(doc.id);
    if (first)
      out.push(`id ${JSON.stringify(doc.id)} is also used by ${first.file}`);
    else firstWithId.set(doc.id, doc);

    for (const key of Object.keys(doc.data))
      if (!(key in shape)) out.push(`unknown key ${JSON.stringify(key)}`);
    for (const [key, spec] of Object.entries(shape))
      check(get(doc.data, key), spec, key, out);

    if (!isPlanned(doc))
      for (const key of NEEDS_EVIDENCE)
        list(get(doc.data, key)).forEach((entry, i) => {
          if (
            isObject(entry) &&
            !(key === "connects" && entry.status === "planned") &&
            !isText(entry.evidence)
          )
            out.push(`${key}[${i}] needs evidence`);
        });

    // References: only checked where the value is a usable string.
    const resolve = (value: unknown, ref: Ref, path: string) => {
      if (!isText(value)) return;
      if (!byFolder(ref.folders).has(value))
        out.push(
          `${path} ${JSON.stringify(value)} does not match ${ref.describe}`,
        );
    };
    list(doc.data.connects).forEach((c, i) => {
      if (isObject(c)) resolve(c.to, PLACE, `connects[${i}].to`);
    });
    if (doc.folder === "flows") {
      resolve(doc.data.persona, PERSONA, "persona");
      list(doc.data.steps).forEach((s, i) => {
        if (!isObject(s)) return;
        resolve(s.by, ACTOR, `steps[${i}].by`);
        resolve(s.at, PLACE, `steps[${i}].at`);
      });
    }

    if (doc.folder === "stores") {
      const enums = new Set(
        list(doc.data.enums).flatMap((e) =>
          isObject(e) && isText(e.name) ? [e.name] : [],
        ),
      );
      list(doc.data.tables).forEach((t, ti) => {
        if (!isObject(t)) return;
        list(t.columns).forEach((c, ci) => {
          if (isObject(c) && isText(c.enum) && !enums.has(c.enum))
            out.push(
              `tables[${ti}].columns[${ci}].enum ${JSON.stringify(c.enum)} is not an enum in this store`,
            );
        });
      });
    }

    out.push(...headingProblems(doc));
    for (const message of out) findings.push({ file: doc.file, message });
  }
  return findings;
};
