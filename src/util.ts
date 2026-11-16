// Small helpers shared across modules: repo-relative paths, file globs and
// type guards for parsed YAML and JSON.

import { relative, resolve } from "node:path";

/** A plain object (not an array or null). */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `v` when it is an array, else []. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `v` when it is a string, else undefined. */
export const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** `v` when it is a string with something other than whitespace in it. */
export const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

/** The strings in `v` when it is an array, else []. */
export const strings = (v: unknown): string[] =>
  list(v).filter((s): s is string => typeof s === "string");

/**
 * A path as written in the map, as a repo-relative path: `./infra/` and
 * `infra\` are `infra`, `./` is `.`, and "" stays "".
 */
export const normalizePath = (p: string): string => {
  if (p.trim() === "") return "";
  const s = p
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return s === "" ? "." : s;
};

/** The file part of an `evidence` entry (`path#Symbol`), normalized. */
export const evidencePath = (evidence: string): string =>
  normalizePath(evidence.split("#")[0] ?? "");

/** `path` is `folder` or inside it; the root folder covers nothing this way. */
export const isUnder = (path: string, folder: string): boolean =>
  folder !== "." &&
  folder !== "" &&
  (path === folder || path.startsWith(`${folder}/`));

/** The map folder relative to root, with a trailing slash ("" when it is the root). */
export const mapPrefix = (root: string, dir: string): string => {
  const rel = relative(resolve(root), resolve(root, dir)).split("\\").join("/");
  return rel ? `${rel}/` : "";
};

// `**` is any run of folders, `*` and `?` stay inside one folder. Unlike
// path.matchesGlob, these also match dotfiles and dot folders (`**/*.tf`
// covers `infra/.terraform/x.tf`, `.archmap-local/**` covers `.env.sample`),
// and `[` is literal, so `app/users/[id]/route.ts` names only that file.
const globRegex = (pattern: string): RegExp => {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      const slash = pattern.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped
  return new RegExp(`^${out}$`, "s");
};

// `{a,b}` alternatives, expanded into one pattern each (nested braces too);
// a `{` without a matching `}` or a comma is literal.
const MAX_EXPANSIONS = 256;
const expandBraces = (pattern: string): string[] => {
  for (
    let open = pattern.indexOf("{");
    open >= 0;
    open = pattern.indexOf("{", open + 1)
  ) {
    let depth = 0;
    const commas: number[] = [];
    for (let i = open; i < pattern.length; i++) {
      const c = pattern.charAt(i);
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        if (!commas.length) break;
        const parts: string[] = [];
        let from = open + 1;
        for (const at of [...commas, i]) {
          parts.push(pattern.slice(from, at));
          from = at + 1;
        }
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        return parts
          .flatMap((p) => expandBraces(`${head}${p}${tail}`))
          .slice(0, MAX_EXPANSIONS);
      } else if (c === "," && depth === 1) commas.push(i);
    }
  }
  return [pattern];
};

/** A matcher for a repo-relative file glob (see globRegex), with `{a,b}` alternatives. */
export const fileMatcher = (pattern: string): ((file: string) => boolean) => {
  const res = expandBraces(pattern).map(globRegex);
  return (file) => file === pattern || res.some((re) => re.test(file));
};

/** A matcher returning the first of `globs` that matches a file, or undefined. */
export const globsMatcher = (
  globs: string[],
): ((file: string) => string | undefined) => {
  const matchers = globs.map((g) => [g, fileMatcher(g)] as const);
  return (file) => matchers.find(([, m]) => m(file))?.[0];
};
