// Keeping what the map says about each entry true as the code moves: endpoints
// that are listed but not documented, new endpoints that arrive without their
// documentation, and entries whose cited code changed while they stayed the same.

import { changedFiles, changedText, filesAt, forkPoint, resolveBase } from "./git.ts";
import { splitFrontmatter } from "./map/load.ts";
import type { Doc, Finding } from "./map/types.ts";
import { FOLDERS } from "./map/types.ts";
import { evidencePath, isObj, list, mapPrefix, text } from "./util.ts";

type Obj = Record<string, unknown>;

const routeOf = (e: Obj): string => text(e.route) ?? "";

/** The names a route's path takes: `:id`, `{id}` and `[id]` all name `id`. */
export const pathParams = (route: string): string[] => [
  ...new Set(
    [...route.matchAll(/(?::|\{|\[)([A-Za-z_]\w*)/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    ),
  ),
];

/** What an endpoint's entry is missing to be usable as documentation. */
const missing = (e: Obj): string[] => {
  const out: string[] = [];
  if (!text(e.does)) out.push("`does`");
  const documented = new Set(
    list(e.params).flatMap((p) => (isObj(p) && text(p.name) ? [p.name] : [])),
  );
  for (const name of pathParams(routeOf(e)))
    if (!documented.has(name)) out.push(`a \`params\` entry for \`${name}\``);
  return out;
};

const endpointsOf = (doc: Doc): Obj[] => list(doc.data.endpoints).filter(isObj);

/** One warning per doc: how many of its endpoints say too little to be used. */
export const undocumented = (docs: Doc[]): Finding[] =>
  docs.flatMap((doc) => {
    const thin = endpointsOf(doc).filter((e) => missing(e).length);
    if (!thin.length) return [];
    const total = endpointsOf(doc).length;
    const named = thin.slice(0, 3).map(routeOf).join(", ");
    return [
      {
        file: doc.file,
        message: `${thin.length} of ${total} endpoints aren't documented (no \`does\`, or a path parameter missing from \`params\`): ${named}${thin.length > 3 ? ", …" : ""}`,
      },
    ];
  });

/** The map's docs as they were at `ref`. Files that don't parse are left out. */
export const mapAt = (root: string, dir: string, ref: string): Doc[] => {
  const prefix = mapPrefix(root, dir);
  const docs: Doc[] = [];
  let files: Map<string, Buffer>;
  try {
    files = filesAt(
      root,
      ref,
      (p) => p.startsWith(prefix) && p.endsWith(".md"),
    );
  } catch {
    return docs;
  }
  for (const [path, body] of files) {
    const [folder, name, ...rest] = path.slice(prefix.length).split("/");
    const known = FOLDERS.find((f) => f === folder);
    if (!known || !name || rest.length) continue;
    const parsed = splitFrontmatter(body.toString("utf8"));
    if ("error" in parsed) continue;
    docs.push({
      id: name.slice(0, -3),
      folder: known,
      file: `${known}/${name}`,
      ...parsed,
    });
  }
  return docs;
};

/**
 * Errors: an endpoint this branch adds to the map must come documented, with
 * `does` and a `params` entry for each name in its path. Endpoints already on
 * the map at `base` only get the warning above, and so does a map that didn't
 * exist at `base`: a first map isn't held to it.
 */
export const newEndpointProblems = (docs: Doc[], before: Doc[]): Finding[] => {
  if (!before.length) return [];
  const had = new Set(before.flatMap((d) => endpointsOf(d).map(routeOf)));
  return docs.flatMap((doc) =>
    endpointsOf(doc).flatMap((e, i) => {
      const route = routeOf(e);
      const gaps = missing(e);
      if (!route || had.has(route) || !gaps.length) return [];
      return [
        {
          file: doc.file,
          message: `endpoints[${i}] ${route} is new and needs ${gaps.join(" and ")}`,
        },
      ];
    }),
  );
};

// The lists whose entries cite code, and the field that names each entry.
const CITING: [string, string][] = [
  ["connects", "to"],
  ["endpoints", "route"],
  ["jobs", "name"],
  ["libraries", "name"],
  ["env", "name"],
  ["tables", "name"],
  ["roles", "name"],
];

const wholeWord = (haystack: string, word: string): boolean => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped above
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(haystack);
};

/**
 * Warnings: entries that may be out of date. An entry is one when the code it
 * cites changed on this branch (the file, and for `file#Symbol` evidence, a
 * function that mentions the symbol) while the entry itself is word for word
 * what it was at `base`. Changing the entry, or the code back, clears it.
 */
export const staleEntries = (
  root: string,
  dir: string,
  base: string,
  docs: Doc[],
  before: Doc[],
): Finding[] => {
  const ref = forkPoint(root, resolveBase(root, base));
  const prefix = mapPrefix(root, dir);
  let changed: Set<string>;
  try {
    changed = new Set(
      changedFiles(root, base).filter((f) => !(prefix && f.startsWith(prefix))),
    );
  } catch {
    return [];
  }
  if (!changed.size || !before.length) return [];
  const old = new Map(before.map((d) => [d.file, d]));
  const touched = new Map<string, string>();
  const touchedText = (file: string): string => {
    let t = touched.get(file);
    if (t === undefined) {
      t = changedText(root, ref, file);
      touched.set(file, t);
    }
    return t;
  };
  const out: Finding[] = [];
  for (const doc of docs) {
    const was = old.get(doc.file);
    if (!was) continue;
    for (const [key, nameField] of CITING) {
      const then = new Map(
        list(Reflect.get(was.data, key))
          .filter(isObj)
          .map((e) => [text(Reflect.get(e, nameField)) ?? "", JSON.stringify(e)]),
      );
      list(Reflect.get(doc.data, key)).forEach((e, i) => {
        if (!isObj(e)) return;
        const name = text(Reflect.get(e, nameField)) ?? "";
        const evidence = text(e.evidence);
        if (!name || !evidence || then.get(name) !== JSON.stringify(e)) return;
        const file = evidencePath(evidence);
        if (!changed.has(file)) return;
        const symbol = evidence.split("#")[1];
        if (symbol && !wholeWord(touchedText(file), symbol)) return;
        out.push({
          file: doc.file,
          message: `${key}[${i}] ${name} may be out of date: ${file} changed on this branch${symbol ? ` around ${symbol}` : ""} and this entry didn't. Re-read the code and correct the entry.`,
        });
      });
    }
  }
  return out;
};
