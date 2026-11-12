// The viewer's data: the markdown docs become the Model the browser draws, plus
// each doc's prose sections.

import { emptyModel } from "./core.ts";
import type { Column, Model, Table } from "./core.ts";
import type { Doc, Folder } from "./map/types.ts";

export type DocView = {
  folder: Folder;
  name: string;
  status: string;
  summary: string;
  how?: string;
  dev?: string;
  code?: string[];
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const HOW = "## How it works";
const DEV = "## For developers";

/** The body split on its two headings, as markdown. Text before the first ## is the summary. */
export const docSections = (
  doc: Doc,
): { summary: string; how?: string; dev?: string } => {
  const summary: string[] = [];
  let how: string[] | undefined;
  let dev: string[] | undefined;
  let into: string[] | undefined = summary;
  for (const line of doc.body.split("\n")) {
    const heading = line.trimEnd();
    if (heading === HOW) into = how = [];
    else if (heading === DEV) into = dev = [];
    else if (/^##(\s|$)/.test(line)) into = undefined;
    else into?.push(line);
  }
  const join = (lines: string[]) => lines.join("\n").trim();
  return {
    summary: join(summary),
    ...(how ? { how: join(how) } : {}),
    ...(dev ? { dev: join(dev) } : {}),
  };
};

const summaryOf = (doc: Doc): string => docSections(doc).summary;

const column = (c: Obj): Column => ({
  name: text(c.name) ?? "",
  type: text(c.type),
  pk: c.pk === true ? true : undefined,
  unique: c.unique === true ? true : undefined,
  fk: text(c.fk),
  enum: text(c.enum),
  desc: text(c.desc),
});

export const toViewModel = (docs: Doc[]): Model => {
  const m = emptyModel();
  m.categories.apps = { name: "Apps", order: 1 };
  m.categories.services = { name: "Services", order: 2 };
  m.categories.data = { name: "Data", order: 3 };
  m.categories.outside = { name: "Outside", order: 4 };
  const personaIds = new Set(
    docs.filter((d) => d.folder === "personas").map((d) => d.id),
  );
  let areaOrder = 0;
  for (const d of docs) {
    const name = text(d.data.name) ?? d.id;
    const status = text(d.data.status);
    const kind = text(d.data.kind);
    if (d.folder === "services") {
      m.services[d.id] = {
        name,
        status,
        lane: kind === "app" ? "apps" : "services",
        type: kind === "job" ? "job" : "app",
        purpose: summaryOf(d),
      };
      list(d.data.endpoints).forEach((e, i) => {
        m.services[`${d.id}.ep-${i}`] = {
          parent: d.id,
          type: "endpoint",
          name: text(e.route),
        };
      });
      list(d.data.jobs).forEach((j, i) => {
        m.services[`${d.id}.job-${i}`] = {
          parent: d.id,
          type: "job",
          name: text(j.name),
        };
      });
      list(d.data.libraries).forEach((l, i) => {
        m.services[`${d.id}.lib-${i}`] = {
          parent: d.id,
          type: "library",
          name: text(l.name),
        };
      });
    } else if (d.folder === "stores") {
      m.services[d.id] = {
        name,
        status,
        lane: "data",
        type: "store",
        opens: kind === "database" ? "schema" : undefined,
      };
      for (const t of list(d.data.tables)) {
        const group = text(t.group);
        const tableName = text(t.name) ?? "";
        const table: Table = {
          area: group ?? d.id,
          purpose: text(t.purpose),
          columns: list(t.columns).map(column),
        };
        Reflect.set(m.tables, tableName, table);
        const areaId = group ?? d.id;
        if (!Reflect.has(m.areas, areaId)) {
          areaOrder += 1;
          Reflect.set(m.areas, areaId, {
            name: group ?? name,
            order: areaOrder,
          });
        }
      }
      for (const e of list(d.data.enums))
        m.enums[text(e.name) ?? ""] = { values: strings(e.values) };
    } else if (d.folder === "external") {
      m.services[d.id] = { name, status, lane: "outside", type: "external" };
    }
    for (const c of list(d.data.connects)) {
      const to = text(c.to) ?? "";
      m.connections[`${d.id}-${to}`] = {
        from: d.id,
        to,
        label: text(c.why),
        protocol: text(c.how),
        status: text(c.status) ?? "live",
      };
    }
    if (d.folder === "personas")
      m.personas[d.id] = {
        name,
        blurb: summaryOf(d),
        jobs: strings(d.data.needs).map((job) => ({ job })),
      };
    if (d.folder === "flows")
      m.flows[d.id] = {
        name,
        steps: list(d.data.steps).map((s) => {
          const by = text(s.by) ?? "";
          return {
            from: personaIds.has(by) ? `persona:${by}` : by,
            to: text(s.at),
            label: text(s.does),
          };
        }),
      };
  }
  return m;
};

const PRIVATE = new Set(["code", "evidence", "dev"]);

/** A deep copy without the keys that only developers see. */
export const stripPublic = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stripPublic) as T;
  if (isObj(value)) {
    const out: Obj = Object.create(null) as Obj;
    for (const [k, v] of Object.entries(value))
      if (!PRIVATE.has(k)) Reflect.set(out, k, stripPublic(v));
    return out as T;
  }
  return value;
};
