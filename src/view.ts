// The viewer's data: the markdown docs become the Model the browser draws, plus
// each doc's prose sections.

import { emptyModel } from "./core.ts";
import type { Column, Model, Table } from "./core.ts";
import type { Doc, Folder, MapConfig } from "./map/types.ts";
import type { Freshness } from "./versions.ts";
import { DEFAULT_LANES, laneOf, type Lane } from "./map/lanes.ts";

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

/** A library's version, and how far behind the latest release it is. */
export type LibInfo = {
  package: string;
  declared: string;
  latest?: string;
  fresh?: Freshness;
};

export const toViewModel = (
  docs: Doc[],
  libs: Record<string, LibInfo> = {},
  lanes: Lane[] = DEFAULT_LANES,
): Model => {
  const m = emptyModel();
  lanes.forEach((l, i) =>
    Reflect.set(m.categories, l.id, {
      name: l.name,
      order: i + 1,
      purpose: l.purpose,
      external: l.outside === true,
    }),
  );
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
        lane: laneOf(d, lanes),
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
        const v = Reflect.get(libs, `${d.id}.lib-${i}`) as LibInfo | undefined;
        m.services[`${d.id}.lib-${i}`] = {
          parent: d.id,
          type: "library",
          name: text(l.name),
          purpose: text(l.why),
          package: v?.package,
          version: v?.declared,
          latest: v?.latest,
          fresh: v?.fresh,
        };
      });
    } else if (d.folder === "stores") {
      m.services[d.id] = {
        name,
        status,
        lane: laneOf(d, lanes),
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
      m.services[d.id] = {
        name,
        status,
        lane: laneOf(d, lanes),
        type: "external",
      };
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
  // A lane with nothing in it isn't drawn.
  const used = new Set(Object.values(m.services).map((s) => s.lane));
  for (const id of Object.keys(m.categories))
    if (!used.has(id)) Reflect.deleteProperty(m.categories, id);
  return m;
};

const ENTRY_PRIVATE = ["code", "evidence"];
const DOC_PRIVATE = ["code", "evidence", "dev"];

/** A copy of one entry object without the given keys. Nested values are kept as they are. */
const without = <T>(entry: T, keys: string[]): T => {
  if (!isObj(entry)) return entry;
  const out: Obj = Object.create(null) as Obj;
  for (const [k, v] of Object.entries(entry))
    if (!keys.includes(k)) Reflect.set(out, k, v);
  return out as T;
};

/** An id-keyed collection with each entry passed through `fn`; the ids themselves are never dropped. */
const eachEntry = <T>(
  bag: Record<string, T>,
  fn: (entry: T) => T,
): Record<string, T> => {
  const out = Object.create(null) as Record<string, T>;
  for (const [id, entry] of Object.entries(bag)) Reflect.set(out, id, fn(entry));
  return out;
};

const stripEntry = <T>(entry: T): T => without(entry, ENTRY_PRIVATE);

/**
 * The model without what only developers see: `code` and `evidence` on each
 * service and part, connection, table, column, enum, persona and flow. Ids are
 * never looked at, so a table called `evidence` stays.
 */
export const stripPublicModel = (m: Model): Model => ({
  ...m,
  services: eachEntry(m.services, stripEntry),
  connections: eachEntry(m.connections, stripEntry),
  tables: eachEntry(m.tables, (t) => {
    const table = stripEntry(t);
    return {
      ...table,
      columns: Array.isArray(table.columns)
        ? table.columns.map(stripEntry)
        : table.columns,
    };
  }),
  enums: eachEntry(m.enums, stripEntry),
  personas: eachEntry(m.personas, stripEntry),
  flows: eachEntry(m.flows, stripEntry),
});

/** Each doc's view without `code`, `evidence` and the For developers text. */
export const stripPublicDocs = (
  docs: Record<string, DocView>,
): Record<string, DocView> => eachEntry(docs, (d) => without(d, DOC_PRIVATE));

const BRANDING = [
  "name",
  "product",
  "logo",
  "labels",
  "theme",
  "fonts",
  "links",
] as const;

/** Only the config keys that brand the viewer; the CLI, agent and ignore settings stay out of a public build. */
export const publicConfig = (config: MapConfig): Partial<MapConfig> => {
  const keep: readonly string[] = BRANDING;
  return Object.fromEntries(
    Object.entries(config).filter(
      ([k, v]) => keep.includes(k) && v !== undefined,
    ),
  ) as Partial<MapConfig>;
};
