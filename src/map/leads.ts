// Leads: things the scanner saw in the code that the map doesn't yet cover.

import type { Scan } from "../scan/index.ts";
import { evidenceOf } from "./evidence.ts";
import type { Doc } from "./types.ts";

export type Lead = { key: string; file: string; text: string };

export const leadsOf = (s: Scan): Lead[] => [
  ...s.apps.map((a) => ({
    key: `scan:app:${a.path}`,
    file: a.file,
    text: `app ${a.name} at ${a.path}`,
  })),
  ...s.routes.map((r) => ({
    key: `scan:route:${r.method} ${r.path}`,
    file: r.file,
    text: `route ${r.method} ${r.path}`,
  })),
  ...s.tables.map((t) => ({
    key: `scan:table:${t.name}`,
    file: t.file,
    text: `table ${t.name}`,
  })),
  ...s.outside.map((o) => ({
    key: `scan:outside:${o.name}`,
    file: o.file,
    text: `outside service ${o.name}`,
  })),
  ...s.infra.map((i) => ({
    key: `scan:infra:${i.type}:${i.name}`,
    file: i.file,
    text: `${i.kind} ${i.type} ${i.name}`,
  })),
  ...s.ci.map((c) => ({
    key: `scan:ci:${c.workflow}`,
    file: c.file,
    text: `CI workflow ${c.workflow}`,
  })),
];

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const normalizeRoute = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path}`;
const normalizeRouteText = (route: string): string => {
  const space = route.indexOf(" ");
  return space < 0
    ? route
    : normalizeRoute(route.slice(0, space), route.slice(space + 1));
};

export const unconfirmedLeads = (
  s: Scan,
  docs: Doc[],
  ignore: string[],
): Lead[] => {
  const evidenceFiles = new Set(
    docs.flatMap((d) => evidenceOf(d).map((c) => c.evidence.split("#")[0])),
  );
  // An app is covered by a code entry that is its path or a path inside it;
  // the root app (".") only by a code entry of ".".
  const codes = docs.flatMap((d) => list(d.data.code).map(str));
  const routes = new Set(
    docs.flatMap((d) =>
      list(d.data.endpoints).flatMap((e) => {
        const route =
          typeof e === "object" && e !== null
            ? str(Reflect.get(e, "route"))
            : undefined;
        return route ? [normalizeRouteText(route)] : [];
      }),
    ),
  );
  const tables = new Set(
    docs
      .filter((d) => d.folder === "stores")
      .flatMap((d) =>
        list(d.data.tables).flatMap((t) =>
          typeof t === "object" && t !== null
            ? [str(Reflect.get(t, "name"))]
            : [],
        ),
      ),
  );
  const external = new Set(
    docs
      .filter((d) => d.folder === "external")
      .flatMap((d) => [d.id, str(d.data.name)])
      .flatMap((n) => (n ? [n.toLowerCase()] : [])),
  );
  const apps = new Map(s.apps.map((a) => [`scan:app:${a.path}`, a.path]));
  const routeOf = new Map(
    s.routes.map((r) => [
      `scan:route:${r.method} ${r.path}`,
      normalizeRoute(r.method, r.path),
    ]),
  );
  const confirmed = (lead: Lead): boolean => {
    if (evidenceFiles.has(lead.file)) return true;
    const [, kind, ...rest] = lead.key.split(":");
    const name = rest.join(":");
    if (kind === "app") {
      const path = apps.get(lead.key) ?? name;
      return codes.some(
        (c) =>
          c !== undefined &&
          (c === path || (path !== "." && c.startsWith(`${path}/`))),
      );
    }
    if (kind === "route") return routes.has(routeOf.get(lead.key) ?? "");
    if (kind === "table") return tables.has(name);
    if (kind === "outside") return external.has(name.toLowerCase());
    return false;
  };
  const skip = new Set(ignore);
  return leadsOf(s).filter((l) => !skip.has(l.key) && !confirmed(l));
};
