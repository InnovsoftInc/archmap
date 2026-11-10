// The architecture model and how saves build it. Shared by the CLI and the
// viewer: `archmap build` and `archmap dev` strip the types and serve this file
// to the browser as core.js, so it must stay free of imports and Node APIs.

export type OpName = "add" | "update" | "remove";

export type Op = {
  kind: string;
  id: string;
  op: OpName;
  value?: Record<string, unknown>;
  reason?: string;
};

/** One save: a batch of related changes, each with its own reason. */
export type Save = {
  id: string;
  at: string;
  author?: string;
  summary?: string;
  ops: Op[];
};

/** A published version: the saves it adds on top of the versions before it. */
export type Version = {
  id: string;
  name: string;
  published_at: string;
  summary?: string;
  saves: string[];
};

export type Column = {
  name: string;
  type?: string;
  pk?: boolean;
  unique?: boolean;
  fk?: string;
  enum?: string;
  array?: boolean;
  desc?: string;
  [key: string]: unknown;
};

export type Table = {
  area?: string;
  purpose?: string;
  append?: boolean;
  order?: number;
  columns: Column[];
  [key: string]: unknown;
};

export type Service = {
  name?: string;
  lane?: string;
  parent?: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
};

export type Connection = {
  from: string;
  to: string;
  label?: string;
  protocol?: string;
  status?: string;
  [key: string]: unknown;
};

export type Use = { to: string; label?: string };

export type Job = {
  job: string;
  t?: Record<string, string>;
  [key: string]: unknown;
};

export type Persona = {
  name?: string;
  uses?: Use[];
  jobs?: Job[];
  [key: string]: unknown;
};

export type FlowStep = {
  from: string;
  to?: string;
  label?: string;
  status?: string;
};

export type Flow = {
  name?: string;
  steps?: FlowStep[];
  [key: string]: unknown;
};

export type Entity = Record<string, unknown>;

export type Model = {
  flows: Record<string, Flow>;
  categories: Record<string, Entity>;
  areas: Record<string, Entity>;
  tables: Record<string, Table>;
  enums: Record<string, Entity>;
  services: Record<string, Service>;
  connections: Record<string, Connection>;
  personas: Record<string, Persona>;
  problems: string[];
};

type Collection = Exclude<keyof Model, "problems">;

/** Which model collection each op kind writes. Columns live inside tables. */
export const KINDS: Record<string, Collection> = {
  flow: "flows",
  category: "categories",
  area: "areas",
  table: "tables",
  enum: "enums",
  service: "services",
  connection: "connections",
  persona: "personas",
};

// Collections have no prototype, so an id like "constructor" is just a key.
const bag = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

export const emptyModel = (): Model => ({
  flows: bag(),
  categories: bag(),
  areas: bag(),
  tables: bag(),
  enums: bag(),
  services: bag(),
  connections: bag(),
  personas: bag(),
  problems: [],
});

/** Ids that would reach Object.prototype through a plain object. Saves may not use them. */
export const RESERVED_IDS = ["__proto__", "prototype", "constructor"];

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/** Applies one op. Ops that can't apply are recorded in `m.problems`, never thrown. */
export const applyOp = (
  m: Model,
  op: Op,
  save: Pick<Save, "id" | "summary">,
): void => {
  const where = save.summary || save.id;
  if (op.kind === "column") {
    const dot = op.id.indexOf(".");
    const tableName = op.id.slice(0, dot);
    const colName = op.id.slice(dot + 1);
    const table = m.tables[tableName];
    if (dot < 1 || !table) {
      m.problems.push(
        `Column ${op.id}: table ${tableName} doesn't exist (${where})`,
      );
      return;
    }
    const cols = table.columns;
    const i = cols.findIndex((c) => c.name === colName);
    if (op.op === "add") {
      if (i !== -1)
        return void m.problems.push(`Column ${op.id} added twice (${where})`);
      const col = { ...clone(op.value || {}), name: colName } as Column;
      const after = col.after as string | undefined;
      delete col.after;
      const ai = after ? cols.findIndex((c) => c.name === after) : -1;
      if (ai === -1) cols.push(col);
      else cols.splice(ai + 1, 0, col);
    } else if (op.op === "update") {
      if (i === -1)
        return void m.problems.push(
          `Column ${op.id} doesn't exist to update (${where})`,
        );
      Object.assign(cols[i], clone(op.value || {}));
    } else if (op.op === "remove") {
      if (i === -1)
        return void m.problems.push(
          `Column ${op.id} doesn't exist to remove (${where})`,
        );
      cols.splice(i, 1);
    }
    return;
  }
  const name = KINDS[op.kind];
  if (!name) return void m.problems.push(`Unknown kind ${op.kind} (${where})`);
  const coll = m[name] as Record<string, Entity>;
  if (op.op === "add") {
    if (coll[op.id])
      return void m.problems.push(`${op.kind} ${op.id} added twice (${where})`);
    const value = clone(op.value || {});
    if (op.kind === "table" && !Array.isArray(value.columns))
      value.columns = [];
    coll[op.id] = value;
  } else if (op.op === "update") {
    if (!coll[op.id])
      return void m.problems.push(
        `${op.kind} ${op.id} doesn't exist to update (${where})`,
      );
    Object.assign(coll[op.id], clone(op.value || {}));
  } else if (op.op === "remove") {
    if (!coll[op.id])
      return void m.problems.push(
        `${op.kind} ${op.id} doesn't exist to remove (${where})`,
      );
    // Collections stay plain objects keyed by id: the viewer and current.json read them as JSON.
    Reflect.deleteProperty(coll, op.id);
  }
};

/** Oldest first by `at`, then by id, so every reader replays in the same order. */
export const sortSaves = <T extends Pick<Save, "id" | "at">>(saves: T[]): T[] =>
  saves
    .slice()
    .sort((a, b) =>
      a.at < b.at
        ? -1
        : a.at > b.at
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );

export type VersionView = {
  key: string;
  name: string;
  version?: Version;
  draft?: boolean;
  draftIds?: string[];
  /** Every save included in this version, cumulatively. */
  set: Record<string, true>;
};

/** Published versions oldest first, then the draft (saves in no version) if there is one. */
export const buildVersions = (
  saves: Pick<Save, "id">[],
  versions: Version[],
): VersionView[] => {
  const list: VersionView[] = [];
  const cum: Record<string, true> = {};
  versions
    .slice()
    .sort((a, b) =>
      a.published_at < b.published_at
        ? -1
        : a.published_at > b.published_at
          ? 1
          : 0,
    )
    .forEach((v) => {
      v.saves.forEach((id) => (cum[id] = true));
      list.push({
        key: "v:" + v.id,
        name: v.name,
        version: v,
        set: { ...cum },
      });
    });
  const draftIds = saves.filter((s) => !cum[s.id]).map((s) => s.id);
  if (draftIds.length) {
    const all: Record<string, true> = { ...cum };
    draftIds.forEach((id) => (all[id] = true));
    list.push({ key: "draft", name: "Draft", draft: true, set: all, draftIds });
  }
  return list;
};

type LayerName = "overview" | "parts" | "data" | "people";

/** Setup order; repeated from watch.ts because this file can't import. */
const LAYER_ORDER: LayerName[] = ["overview", "parts", "data", "people"];

/** How much of each map layer has content. Top-level services are the overview. */
export const layerReport = (
  m: Model,
): { layer: LayerName; count: number }[] => {
  const services = Object.values(m.services);
  const parts = services.filter((s) => s.parent).length;
  const counts: Record<LayerName, number> = {
    overview: services.length - parts,
    parts,
    data: Object.keys(m.tables).length,
    people: Object.keys(m.personas).length + Object.keys(m.flows).length,
  };
  return LAYER_ORDER.map((layer) => ({ layer, count: counts[layer] }));
};

/** The first layer with nothing in it, or null when all have content. */
export const nextLayer = (m: Model): string | null =>
  layerReport(m).find((l) => l.count === 0)?.layer ?? null;

/** Builds the model from the saves in `include` (all saves when omitted). */
export const replay = (
  saves: Save[],
  include?: Record<string, true>,
): Model => {
  const m = emptyModel();
  sortSaves(saves).forEach((s) => {
    if (!include || include[s.id]) s.ops.forEach((op) => applyOp(m, op, s));
  });
  return m;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape problems in one save file, as plain sentences. Empty when it's valid. */
export const validateSave = (raw: unknown, id: string): string[] => {
  const out: string[] = [];
  if (!isObj(raw)) return [`${id}: not a JSON object`];
  if (typeof raw.at !== "string" || isNaN(Date.parse(raw.at)))
    out.push(`${id}: "at" must be an ISO 8601 date`);
  if (raw.summary !== undefined && typeof raw.summary !== "string")
    out.push(`${id}: "summary" must be text`);
  if (!Array.isArray(raw.ops) || raw.ops.length === 0)
    out.push(`${id}: "ops" must be a non-empty list`);
  else
    raw.ops.forEach((op: unknown, i: number) => {
      const at = `${id} op ${i + 1}`;
      if (!isObj(op)) return void out.push(`${at}: not an object`);
      if (
        typeof op.kind !== "string" ||
        !(op.kind === "column" || KINDS[op.kind])
      )
        out.push(`${at}: unknown kind ${String(op.kind)}`);
      if (typeof op.id !== "string" || !op.id)
        out.push(`${at}: "id" is required`);
      else if (op.id.split(".").some((part) => RESERVED_IDS.includes(part)))
        out.push(`${at}: "${op.id}" can't be used as an id`);
      if (op.op !== "add" && op.op !== "update" && op.op !== "remove")
        out.push(`${at}: "op" must be add, update or remove`);
      if (op.op !== "remove" && !isObj(op.value))
        out.push(`${at}: "value" must be an object`);
      if (typeof op.reason !== "string" || !op.reason.trim())
        out.push(`${at}: every change needs a "reason"`);
    });
  return out;
};

/** Broken references in a built model: things that point at what doesn't exist. */
export const checkModel = (m: Model): string[] => {
  const out: string[] = [];
  const S = m.services;
  const hasCats = Object.keys(m.categories).length > 0;
  Object.entries(S).forEach(([id, s]) => {
    if (s.parent && !S[s.parent])
      out.push(`Service ${id}: parent ${s.parent} doesn't exist`);
    if (hasCats && s.lane && !m.categories[s.lane])
      out.push(`Service ${id}: category ${s.lane} doesn't exist`);
  });
  Object.entries(m.connections).forEach(([id, c]) => {
    if (!S[c.from]) out.push(`Connection ${id}: ${c.from} doesn't exist`);
    if (!S[c.to]) out.push(`Connection ${id}: ${c.to} doesn't exist`);
  });
  Object.entries(m.tables).forEach(([name, t]) => {
    t.columns.forEach((c) => {
      if (c.fk && !m.tables[c.fk])
        out.push(`Column ${name}.${c.name}: points at missing table ${c.fk}`);
      if (c.enum && !m.enums[c.enum])
        out.push(`Column ${name}.${c.name}: enum ${c.enum} doesn't exist`);
    });
  });
  Object.entries(m.personas).forEach(([id, p]) => {
    (p.uses || []).forEach((u) => {
      if (!S[u.to]) out.push(`Persona ${id}: uses missing service ${u.to}`);
    });
    (p.jobs || []).forEach((j) => {
      Object.keys(j.t || {}).forEach((t) => {
        if (!m.tables[t])
          out.push(`Persona ${id}: job "${j.job}" uses missing table ${t}`);
      });
    });
  });
  Object.entries(m.flows).forEach(([id, f]) => {
    (f.steps || []).forEach((st, i) => {
      const where = `Flow ${id} step ${i + 1}`;
      [st.from, st.to].forEach((n) => {
        if (!n) return;
        const ok = n.startsWith("persona:") ? !!m.personas[n.slice(8)] : !!S[n];
        if (!ok) out.push(`${where}: ${n} doesn't exist`);
      });
      if (st.to && st.from !== st.to && !stepConnected(m, st))
        out.push(
          `${where}: no recorded connection between ${st.from} and ${st.to}`,
        );
    });
  });
  return out;
};

/** True when a flow step follows a recorded connection (either direction) or a persona's use. */
export const stepConnected = (m: Model, st: FlowStep): boolean => {
  const a = st.from;
  const b = st.to || "";
  if (a.startsWith("persona:"))
    return (m.personas[a.slice(8)]?.uses || []).some((u) => u.to === b);
  if (b.startsWith("persona:"))
    return (m.personas[b.slice(8)]?.uses || []).some((u) => u.to === a);
  return Object.values(m.connections).some(
    (c) => (c.from === a && c.to === b) || (c.from === b && c.to === a),
  );
};
