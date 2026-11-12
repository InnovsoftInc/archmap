// Leads: things the scanner saw in the code that the map doesn't yet cover.

import { matchesGlob } from "node:path";
import type { Scan } from "../scan/index.ts";
import { evidenceOf } from "./evidence.ts";
import type { Doc } from "./types.ts";

export type Lead = { key: string; file: string; text: string };

type Raw = { kind: string; name: string; file: string; text: string };

// A lead's key is `scan:<kind>:<name>@<file>`: the same name in two files
// (an `api` service in two compose files) is two leads.
const rawLeads = (s: Scan): Raw[] => [
  ...s.apps.map((a) => ({
    kind: "app",
    name: a.path,
    file: a.file,
    text: `app ${a.name} at ${a.path}`,
  })),
  ...s.routes.map((r) => ({
    kind: "route",
    name: `${r.method} ${r.path}`,
    file: r.file,
    text: `route ${r.method} ${r.path}`,
  })),
  ...s.tables.map((t) => ({
    kind: "table",
    name: t.name,
    file: t.file,
    text: `table ${t.name}`,
  })),
  ...s.outside.map((o) => ({
    kind: "outside",
    name: o.name,
    file: o.file,
    text: `outside service ${o.name}`,
  })),
  ...s.infra.map((i) => ({
    kind: "infra",
    name: `${i.type}:${i.name}`,
    file: i.file,
    text: `${i.kind} ${i.type} ${i.name}`,
  })),
  ...s.ci.map((c) => ({
    kind: "ci",
    name: c.workflow,
    file: c.file,
    text: `CI workflow ${c.workflow}`,
  })),
];

const unkeyed = (r: Raw): string => `scan:${r.kind}:${r.name}`;
const toLead = (r: Raw): Lead => ({
  key: `${unkeyed(r)}@${r.file}`,
  file: r.file,
  text: r.text,
});

export const leadsOf = (s: Scan): Lead[] => rawLeads(s).map(toLead);

const fileMatches = (file: string, pattern: string): boolean => {
  if (file === pattern) return true;
  try {
    return matchesGlob(file, pattern);
  } catch {
    return false;
  }
};

// In the name part `*` is any run of characters, `/` included, since route
// names hold paths.
const nameMatches = (name: string, pattern: string): boolean =>
  name === pattern ||
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped
  new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  ).test(name);

// An ignore entry is `<name>@<file>`, split at its last `@`: the name part
// matched with `*` as a wildcard, the file part as a glob
// (`scan:route:*@apps/api/**`). An entry, or one whose part after the last
// `@` doesn't match, also counts as a name alone, matching the lead in every
// file, so a name holding `@` (`GET /users/@me`) works without a file.
const ignored = (r: Raw, ignore: string[]): boolean =>
  ignore.some((pattern) => {
    if (nameMatches(unkeyed(r), pattern)) return true;
    const at = pattern.lastIndexOf("@");
    return (
      at >= 0 &&
      nameMatches(unkeyed(r), pattern.slice(0, at)) &&
      fileMatches(r.file, pattern.slice(at + 1))
    );
  });

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
  // Infrastructure, Docker and CI leads are also confirmed by a code entry
  // that is the lead's file or a folder above it.
  const coversFile = (file: string): boolean =>
    codes.some((c) => {
      if (c === undefined) return false;
      const folder = c.replace(/\/+$/, "");
      return (
        folder !== "." &&
        folder !== "" &&
        (file === folder || file.startsWith(`${folder}/`))
      );
    });
  const confirmed = (lead: Raw): boolean => {
    if (evidenceFiles.has(lead.file)) return true;
    const { kind, name } = lead;
    if (kind === "app")
      return codes.some(
        (c) =>
          c !== undefined &&
          (c === name || (name !== "." && c.startsWith(`${name}/`))),
      );
    if (kind === "route") return routes.has(normalizeRouteText(name));
    if (kind === "table") return tables.has(name);
    if (kind === "outside") return external.has(name.toLowerCase());
    if (kind === "infra" || kind === "ci") return coversFile(lead.file);
    return false;
  };
  return rawLeads(s).flatMap((r) => {
    const lead = toLead(r);
    return ignored(r, ignore) || confirmed(r) ? [] : [lead];
  });
};

