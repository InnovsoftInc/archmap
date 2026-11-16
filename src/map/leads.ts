// Leads: things the scanner saw in the code that the map doesn't yet cover.

import type { Scan } from "../scan/index.ts";
import {
  evidencePath,
  fileMatcher,
  isObj,
  isUnder,
  list,
  normalizePath,
  str,
} from "../util.ts";
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
  ...s.outside.map((o) =>
    o.via === "env"
      ? {
          kind: "env",
          name: o.name,
          file: o.file,
          text: `environment variable ${o.name}`,
        }
      : {
          kind: "outside",
          name: o.name,
          file: o.file,
          text: `outside service ${o.name}`,
        },
  ),
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

// In the name part `*` is any run of characters, `/` included, since route
// names hold paths.
const nameMatcher = (pattern: string): ((name: string) => boolean) => {
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  );
  return (name) => name === pattern || re.test(name);
};

// An ignore entry is `<name>@<file>`, split at its last `@`: the name part
// matched with `*` as a wildcard, the file part as a glob
// (`scan:route:*@apps/api/**`). An entry, or one whose part after the last
// `@` doesn't match, also counts as a name alone, matching the lead in every
// file, so a name holding `@` (`GET /users/@me`) works without a file.
type Ignore = (name: string, file: string) => boolean;
const ignoreMatcher = (pattern: string): Ignore => {
  const whole = nameMatcher(pattern);
  const at = pattern.lastIndexOf("@");
  if (at < 0) return (name) => whole(name);
  const name = nameMatcher(pattern.slice(0, at));
  const file = fileMatcher(pattern.slice(at + 1));
  return (n, f) => whole(n) || (name(n) && file(f));
};

const normalizeRoute = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path}`;
const normalizeRouteText = (route: string): string => {
  const space = route.indexOf(" ");
  return space < 0
    ? route
    : normalizeRoute(route.slice(0, space), route.slice(space + 1));
};

// Every identifier-like word in `v`: strings, and the strings inside lists
// and objects, at any depth.
const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const wordsIn = (v: unknown, out: Set<string>): void => {
  if (typeof v === "string") for (const [w] of v.matchAll(WORD)) out.add(w);
  else if (Array.isArray(v)) for (const x of v) wordsIn(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) wordsIn(x, out);
};

// An SDK lead's name is the scanner's service name ("Azure", "AWS",
// "SendGrid"). An external doc covers it when its id or name is that name, or
// starts with it and a separator, so `azure-blob`, `aws.s3`, `azure/storage`
// and "Azure Blob Storage" all cover "Azure" (but `azurite` does not).
const coversService = (doc: string, lead: string): boolean =>
  doc === lead ||
  (doc.startsWith(lead) && /^[-/. ]/.test(doc.slice(lead.length)));

/**
 * The leads no map doc confirms and no ignore entry drops. How each kind is confirmed:
 * - route: an `endpoints[].route` naming it (method case and a trailing slash ignored);
 * - table: a `tables[].name` in a store;
 * - outside (an SDK in package.json): an external doc whose id or name covers it (coversService);
 * - env (a variable in a `.env.example`): its name as a word anywhere in an
 *   external doc's frontmatter (an `env` list, say) or in any doc's body;
 * - app: a code entry that is its path or inside it;
 * - infra, ci: a code entry that is the file or a folder above it;
 * - app, infra, ci also: an `evidence` entry citing the lead's file.
 * Routes, tables, outside services and variables are confirmed by name only:
 * evidence citing their file says nothing about a new route added to it.
 */
export const unconfirmedLeads = (
  s: Scan,
  docs: Doc[],
  ignore: string[],
): Lead[] => {
  const evidenceFiles = new Set(
    docs.flatMap((d) => evidenceOf(d).map((c) => evidencePath(c.evidence))),
  );
  // An app is covered by a code entry that is its path or a path inside it;
  // the root app (".") only by a code entry of ".".
  const codes = docs.flatMap((d) =>
    list(d.data.code).flatMap((c) => {
      const s = str(c);
      return s === undefined ? [] : [normalizePath(s)];
    }),
  );
  const routes = new Set(
    docs.flatMap((d) =>
      list(d.data.endpoints).flatMap((e) => {
        const route = isObj(e) ? str(e.route) : undefined;
        return route ? [normalizeRouteText(route)] : [];
      }),
    ),
  );
  const tables = new Set(
    docs
      .filter((d) => d.folder === "stores")
      .flatMap((d) =>
        list(d.data.tables).flatMap((t) => (isObj(t) ? [str(t.name)] : [])),
      ),
  );
  const externalDocs = docs.filter((d) => d.folder === "external");
  const external = externalDocs
    .flatMap((d) => [d.id, str(d.data.name)])
    .flatMap((n) => (n ? [n.toLowerCase()] : []));
  const mentioned = new Set<string>();
  for (const d of externalDocs) wordsIn(d.data, mentioned);
  for (const d of docs) wordsIn(d.body, mentioned);
  const coversFile = (file: string): boolean =>
    codes.some((c) => isUnder(file, c));
  const confirmed = (lead: Raw): boolean => {
    const { kind, name } = lead;
    if (kind === "route") return routes.has(normalizeRouteText(name));
    if (kind === "table") return tables.has(name);
    if (kind === "outside")
      return external.some((e) => coversService(e, name.toLowerCase()));
    if (kind === "env") return mentioned.has(name);
    if (evidenceFiles.has(lead.file)) return true;
    if (kind === "app")
      return codes.some((c) => c === name || isUnder(c, name));
    if (kind === "infra" || kind === "ci") return coversFile(lead.file);
    return false;
  };
  const ignores = ignore.map(ignoreMatcher);
  return rawLeads(s).flatMap((r) => {
    const name = unkeyed(r);
    if (ignores.some((m) => m(name, r.file)) || confirmed(r)) return [];
    return [toLead(r)];
  });
};
