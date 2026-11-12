// The overview's lanes, C4-style: what the project builds and runs, grouped by
// responsibility (frontend, backend, platform), and the outside systems it
// talks to (third-party and partners, legacy it replaces). Each map file is
// placed from what it already says (its folder, kind and status); a project can
// rename or add lanes in archmap.config.json, and a file can name its `lane`.

import type { Doc, Finding, MapConfig } from "./types.ts";

export type Lane = {
  id: string;
  name: string;
  purpose?: string;
  /** Drawn outside the project's boundary. */
  outside?: boolean;
};

export const DEFAULT_LANES: Lane[] = [
  {
    id: "frontend",
    name: "Frontend",
    purpose: "What people use: the apps and portals.",
  },
  {
    id: "backend",
    name: "Backend",
    purpose: "The server side: APIs, workers, jobs and the data they keep.",
  },
  {
    id: "platform",
    name: "Platform and delivery",
    purpose: "How it's hosted, secured, monitored and deployed.",
  },
  {
    id: "third_party",
    name: "Third-party and partners",
    purpose: "Outside services and organisations the project talks to.",
    outside: true,
  },
  {
    id: "legacy",
    name: "Legacy",
    purpose: "Systems the project replaces.",
    outside: true,
  },
];

const LANE_ID = /^[a-z0-9][a-z0-9_-]*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

/** The config's lanes when it lists valid ones, else the defaults. */
export const lanesOf = (config: MapConfig): Lane[] => {
  if (!Array.isArray(config.lanes)) return DEFAULT_LANES;
  const lanes = config.lanes.flatMap((l): Lane[] => {
    if (!isObj(l)) return [];
    const id = str(l.id);
    const name = str(l.name);
    if (!id || !name || !LANE_ID.test(id)) return [];
    return [{ id, name, purpose: str(l.purpose), outside: l.outside === true }];
  });
  return lanes.some((l) => !l.outside) ? lanes : DEFAULT_LANES;
};

/** The lane a file goes in by default, from its folder, kind and status. */
const derived = (doc: Doc): { id: string; outside: boolean } => {
  const kind = doc.data.kind;
  if (doc.folder === "external") {
    if (doc.data.status === "retiring") return { id: "legacy", outside: true };
    if (kind === "hosting") return { id: "platform", outside: false };
    return { id: "third_party", outside: true };
  }
  if (doc.folder === "services" && kind === "app")
    return { id: "frontend", outside: false };
  return { id: "backend", outside: false };
};

/**
 * Where a service, store or external file is drawn: its own `lane` when the
 * project has that lane, else the default for what it is, else the first lane
 * on the same side of the boundary.
 */
export const laneOf = (doc: Doc, lanes: Lane[]): string => {
  const own = str(doc.data.lane);
  if (own && lanes.some((l) => l.id === own)) return own;
  const d = derived(doc);
  if (lanes.some((l) => l.id === d.id)) return d.id;
  const side =
    lanes.find((l) => (l.outside ?? false) === d.outside) ?? lanes[0];
  return side ? side.id : d.id;
};

/** A config `lanes` list that's malformed, and files naming a lane that doesn't exist. */
export const laneProblems = (config: MapConfig, docs: Doc[]): Finding[] => {
  const out: Finding[] = [];
  const file = "archmap.config.json";
  if (config.lanes !== undefined) {
    if (!Array.isArray(config.lanes))
      out.push({ file, message: "lanes must be a list" });
    else {
      const seen = new Set<string>();
      config.lanes.forEach((l: unknown, i: number) => {
        const at = `lanes[${i}]`;
        if (!isObj(l)) return void out.push({ file, message: `${at} must be a mapping` });
        const id = str(l.id);
        if (!id || !LANE_ID.test(id))
          out.push({ file, message: `${at}.id must be lowercase letters, digits, - or _` });
        else if (seen.has(id))
          out.push({ file, message: `${at}.id "${id}" is used twice` });
        else seen.add(id);
        if (!str(l.name)) out.push({ file, message: `${at}.name must be a non-empty string` });
      });
      if (!config.lanes.some((l: unknown) => isObj(l) && l.outside !== true))
        out.push({ file, message: "lanes needs at least one lane inside the boundary" });
    }
  }
  const ids = new Set(lanesOf(config).map((l) => l.id));
  for (const d of docs) {
    const own = d.data.lane;
    if (own === undefined) continue;
    if (typeof own !== "string" || !ids.has(own))
      out.push({
        file: d.file,
        message: `lane "${String(own)}" isn't one of the map's lanes (${[...ids].join(", ")})`,
      });
  }
  return out;
};
