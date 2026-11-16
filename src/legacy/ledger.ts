// The old save ledger (saves/*.json, replayed into a model). Only `migrate`
// reads it, to turn a ledger into markdown map files once.

import {
  emptyModel,
  type Column,
  type Entity,
  type Model,

} from "../model.ts";
import { isObj } from "../util.ts";

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
