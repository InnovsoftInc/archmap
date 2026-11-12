// Library versions, read from the manifests the map points at, so nobody has
// to type them into the map. A library is matched to a package by its
// `package` field, else by its name (`Express` → `express`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "./map/types.ts";

export type LibVersion = { package: string; declared: string };
export type Freshness = "ok" | "patch" | "minor" | "major";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every dependency named in the package.json files under a doc's `code` paths. */
const dependenciesOf = (root: string, doc: Doc): Map<string, string> => {
  const code = Array.isArray(doc.data.code) ? doc.data.code : [];
  const out = new Map<string, string>();
  for (const c of code) {
    if (typeof c !== "string") continue;
    const file = c.endsWith("package.json") ? c : join(c, "package.json");
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as Obj;
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ]) {
        const deps: unknown = Reflect.get(pkg, section);
        if (!isObj(deps)) continue;
        for (const [name, range] of Object.entries(deps))
          if (typeof range === "string" && !out.has(name)) out.set(name, range);
      }
    } catch {
      // An unreadable manifest just gives no versions.
    }
  }
  return out;
};

const squash = (s: string): string => s.toLowerCase().replace(/[\s._-]/g, "");

/** Version info per library part id (`<service>.lib-<i>`, as the view model names them). */
export const libraryVersions = (
  root: string,
  docs: Doc[],
): Record<string, LibVersion> => {
  const out: [string, LibVersion][] = [];
  for (const d of docs) {
    if (d.folder !== "services" || !Array.isArray(d.data.libraries)) continue;
    const deps = dependenciesOf(root, d);
    const names = [...deps.keys()];
    d.data.libraries.forEach((l: unknown, i: number) => {
      if (!isObj(l)) return;
      const wanted =
        typeof l.package === "string"
          ? l.package
          : typeof l.name === "string"
            ? l.name
            : "";
      const name =
        names.find((n) => n === wanted) ??
        names.find((n) => squash(n) === squash(wanted));
      const declared = name === undefined ? undefined : deps.get(name);
      if (name !== undefined && declared !== undefined)
        out.push([`${d.id}.lib-${i}`, { package: name, declared }]);
    });
  }
  return Object.fromEntries(out);
};

const parts = (v: string): number[] | undefined => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v) ?? /(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
};

/**
 * How far the lowest version a range allows (`^4.18.2` → 4.18.2) is behind the
 * latest release. Undefined when either can't be read (`workspace:*`, a git
 * URL).
 */
export const freshness = (
  declared: string,
  latest: string,
): Freshness | undefined => {
  const a = parts(declared),
    b = parts(latest);
  if (!a || !b) return undefined;
  if (a[0] !== b[0]) return a[0] < b[0] ? "major" : "ok";
  if (a[1] !== b[1]) return a[1] < b[1] ? "minor" : "ok";
  return a[2] < b[2] ? "patch" : "ok";
};
