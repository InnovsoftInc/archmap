import path from "node:path";
import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Fact, Reader, Scan } from "./types.ts";

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IN_ROUTES = /(?:^|\/)routes\//;
// Tests and fixtures register routes too, but not the project's.
const NOT_APP_CODE =
  /(?:^|\/)(?:__tests__|fixtures|e2e)\/|\.(?:test|spec)\.[^/]+$/;
// Express, Fastify and Hono all register routes as `thing.get("/path", ...)`.
// Only a path that starts with `/` is a route: `app.get("port")` reads a
// setting. The usual names count in any file; any other name only in a file
// that uses a server framework, where `permitsRouter.get(...)` is a route but
// an HTTP client's `api.get("/users")` elsewhere is not.
const ROUTE =
  /\b(app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*(["'`])(\/.*?)\3/g;
const ANY_ROUTE =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options|all)\(\s*(["'`])(\/.*?)\3/g;
const FRAMEWORK =
  /\bfrom\s+["'](?:express|fastify)["']|\brequire\(\s*["'](?:express|fastify)["']\s*\)|(?<![\w$.])(?:Router|express|Fastify|fastify)\(/;
// `x.use("/prefix", name)` mounts the router `name` under the prefix.
const MOUNT =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.use\(\s*(["'`])(\/.*?)\2\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
// Where a module's names come from: ES imports and CommonJS requires.
const IMPORT = /\bimport\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
const REQUIRE =
  /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_DECL =
  /\bexport\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const EXPORT_DEFAULT =
  /\b(?:export\s+default|module\.exports\s*=)\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
const SOURCE_EXT = [
  ...[".ts", ".tsx", ".js", ".jsx"],
  ...[".mts", ".cts", ".mjs", ".cjs"],
];

// Comment lines (`//`, `/*` and the `*` lines of a block comment) are blanked
// rather than removed, so a call spread over several lines still matches.
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
// Next.js app router: the URL is the folder under app/, and the methods are
// the handlers route.ts exports. OPTIONS and HEAD are left out, as above.
export const isNextRoute = (file: string): boolean => {
  const parts = file.split("/");
  return (
    parts.slice(0, -1).includes("app") &&
    /^route\.(?:[cm]?[jt]s|[jt]sx)$/.test(parts.at(-1) ?? "")
  );
};
const NEXT_METHOD =
  /^export (?:async )?(?:function|const|let) (GET|POST|PUT|PATCH|DELETE)\b/gm;
// Route groups `(name)` and parallel slots `@name` don't appear in the URL.
const nextPath = (file: string): string => {
  const parts = file.split("/");
  const url = parts
    .slice(parts.indexOf("app") + 1, -1)
    .filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith("@"));
  return `/${url.join("/")}`;
};
// A routes/ folder with .tsx or .jsx files in it holds a client router's
// pages, not API endpoints.
const routesFolder = (file: string): string => {
  const parts = file.split("/");
  return parts.slice(0, parts.lastIndexOf("routes") + 1).join("/");
};
const withoutComments = (text: string): string =>
  text
    .split("\n")
    .map((line) => (COMMENT.test(line) ? "" : line))
    .join("\n");

type Route = { owner: string; method: string; path: string };
type Mount = { owner: string; prefix: string; target: string };
type Module = {
  routes: Route[];
  mounts: Mount[];
  // Local name -> where it was imported from.
  imports: Map<string, { from: string; name: string }>;
  // Exported name -> local name.
  exports: Map<string, string>;
};

const NAME = /^[A-Za-z_$][\w$]*$/;
// `a`, `a as b` (ES) or `a: b` (CommonJS destructuring), as [name, local].
const namedItems = (list: string, sep: RegExp): [string, string][] =>
  list.split(",").flatMap((item) => {
    const [name = "", local = name] = item
      .trim()
      .replace(/^type\s+/, "")
      .split(sep)
      .map((p) => p.trim());
    return NAME.test(name) && NAME.test(local) ? [[name, local]] : [];
  });

const readModule = (text: string, framework: boolean): Module => {
  const code = withoutComments(text);
  const routes = [...code.matchAll(framework ? ANY_ROUTE : ROUTE)].map(
    (m) => ({
      owner: m[1] ?? "",
      method: (m[2] ?? "").toUpperCase(),
      path: m[4] ?? "",
    }),
  );
  const mounts = [...code.matchAll(MOUNT)].map((m) => ({
    owner: m[1] ?? "",
    prefix: m[3] ?? "",
    target: m[4] ?? "",
  }));
  const imports: Module["imports"] = new Map();
  for (const m of code.matchAll(IMPORT)) {
    const clause = (m[1] ?? "").replace(/^type\s+/, "");
    const from = m[2] ?? "";
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const [name, local] of namedItems(braces?.[1] ?? "", /\s+as\s+/))
      imports.set(local, { from, name });
    const def = clause.replace(/\{[^}]*\}/, "").split(",")[0]?.trim() ?? "";
    if (NAME.test(def)) imports.set(def, { from, name: "default" });
  }
  for (const m of code.matchAll(REQUIRE)) {
    const target = m[1] ?? "";
    const from = m[2] ?? "";
    if (target.startsWith("{"))
      for (const [name, local] of namedItems(target.slice(1, -1), /\s*:\s*/))
        imports.set(local, { from, name });
    else imports.set(target, { from, name: "default" });
  }
  const exports: Module["exports"] = new Map();
  for (const m of code.matchAll(EXPORT_DECL))
    exports.set(m[1] ?? "", m[1] ?? "");
  for (const m of code.matchAll(EXPORT_LIST))
    for (const [local, name] of namedItems(m[1] ?? "", /\s+as\s+/))
      exports.set(name, local);
  for (const m of code.matchAll(EXPORT_DEFAULT))
    exports.set("default", m[1] ?? "");
  return { routes, mounts, imports, exports };
};

// The repo file a relative import names, trying the usual source extensions
// (TypeScript imports "./a.js" for a.ts) and index files.
const resolveImport = (
  from: string,
  spec: string,
  files: Set<string>,
): string | undefined => {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.join(path.posix.dirname(from), spec);
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  return [
    base,
    ...SOURCE_EXT.map((ext) => stem + ext),
    ...SOURCE_EXT.map((ext) => `${base}${ext}`),
    ...SOURCE_EXT.map((ext) => `${base}/index${ext}`),
  ].find((f) => files.has(f));
};

const joinPath = (prefix: string, rest: string): string =>
  `${prefix.replace(/\/+$/, "")}${rest === "/" ? "" : rest}` || "/";

// Full paths: each router's routes get the prefixes of every chain of mounts
// that reaches it. A router no resolvable mount reaches keeps its own paths.
const mountedRoutes = (
  modules: Map<string, Module>,
  files: Set<string>,
): Fact<{ method: string; path: string }>[] => {
  const parents = new Map<string, { parent: string; prefix: string }[]>();
  for (const [file, mod] of modules)
    for (const mount of mod.mounts) {
      const imported = mod.imports.get(mount.target);
      let child = `${file}#${mount.target}`;
      if (imported) {
        const target = resolveImport(file, imported.from, files);
        if (!target) continue;
        const local =
          modules.get(target)?.exports.get(imported.name) ?? imported.name;
        child = `${target}#${local}`;
      }
      const list = parents.get(child) ?? [];
      list.push({ parent: `${file}#${mount.owner}`, prefix: mount.prefix });
      parents.set(child, list);
    }
  const prefixes = (key: string, seen: Set<string>): string[] => {
    const up = (parents.get(key) ?? []).filter((p) => !seen.has(p.parent));
    if (!up.length) return [""];
    return up.flatMap((p) =>
      prefixes(p.parent, new Set([...seen, key])).map((x) =>
        joinPath(x, p.prefix),
      ),
    );
  };
  const out = new Map<string, Fact<{ method: string; path: string }>>();
  for (const [file, mod] of modules)
    for (const route of mod.routes)
      for (const prefix of prefixes(`${file}#${route.owner}`, new Set())) {
        const full = prefix ? joinPath(prefix, route.path) : route.path;
        out.set(`${file} ${route.method} ${full}`, {
          file,
          method: route.method,
          path: full,
        });
      }
  return [...out.values()];
};

export const routesReader: Reader = (root, files) => {
  const routes: Scan["routes"] = [];
  const routeFiles: Scan["routeFiles"] = [];
  const modules = new Map<string, Module>();
  const unreadable = readEach(
    root,
    files,
    (f) => CODE.test(baseName(f)) && !NOT_APP_CODE.test(f),
    (file, text) => {
      if (isNextRoute(file)) {
        for (const match of withoutComments(text).matchAll(NEXT_METHOD)) {
          routes.push({ file, method: match[1] ?? "", path: nextPath(file) });
        }
        return;
      }
      const mod = readModule(text, FRAMEWORK.test(text));
      modules.set(file, mod);
      if (!mod.routes.length && !mod.mounts.length && IN_ROUTES.test(file))
        routeFiles.push({ file });
    },
  );
  routes.push(...mountedRoutes(modules, new Set(files)));
  const pageFolders = new Set(
    files
      .filter((f) => IN_ROUTES.test(f) && /\.[jt]sx$/.test(f))
      .map(routesFolder),
  );
  return {
    routes: sortFacts(routes, "path", "method"),
    routeFiles: sortFacts(
      routeFiles.filter((f) => !pageFolders.has(routesFolder(f.file))),
    ),
    unreadable,
  };
};
