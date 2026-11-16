import path from "node:path";
import { NOT_APP_CODE, baseName, readEach, sortFacts } from "./walk.ts";
import type { Fact, Reader, Scan } from "./types.ts";

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IN_ROUTES = /(?:^|\/)routes\//;
// Express, Fastify and Hono all register routes as `thing.get("/path", ...)`.
// Only a path that starts with `/` is a route: `app.get("port")` reads a
// setting. The usual names count in any file; any other name only in a file
// that uses a server framework, where `permitsRouter.get(...)` is a route but
// an HTTP client's `api.get("/users")` elsewhere is not. A route has a
// handler after its path, so `cache.get("/key")` is not one.
const ROUTE =
  /\b(app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*(["'`])(\/.*?)\3\s*,/g;
const ANY_ROUTE =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options|all)\(\s*(["'`])(\/.*?)\3\s*,/g;
// A value import of the framework (not `import type`), a require, or a call
// that creates an app or router.
const FRAMEWORK_IMPORT =
  /\bimport\s+(?!type\s)(?:(?!\bimport\b)[^;])*?\bfrom\s+["'](?:express|fastify|hono)["']/;
const FRAMEWORK =
  /\brequire\(\s*["'](?:express|fastify|hono)["']\s*\)|(?<![\w$.])(?:Router|express|Fastify|fastify|Hono)\(/;
const usesFramework = (text: string): boolean =>
  FRAMEWORK_IMPORT.test(text) || FRAMEWORK.test(text);
// `x.use("/prefix", auth, name)` (Express) or `x.route("/prefix", name)`
// (Hono) mounts the routers among the arguments after the prefix under it.
// Every plain name is a candidate; only the ones that hold routes matter.
const MOUNT =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.(?:use|route)\(\s*(["'`])(\/.*?)\2\s*,/g;
// `x.register(plugin, { prefix: "/api" })` (Fastify) mounts every route the
// plugin's module registers under the prefix.
const REGISTER =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.register\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^}]*?\bprefix\s*:\s*(["'`])(\/.*?)\3/g;
// Where a module's names come from: ES imports and CommonJS requires. The
// clause can't run past another `import`, so a side-effect import with no
// semicolon doesn't swallow the next one.
const IMPORT =
  /\bimport\s+((?:(?!\bimport\b)[^;])*?)\s+from\s+["']([^"']+)["']/g;
// Re-exports: `export { a, default as b } from "./x"` and `export * from`.
const REEXPORT_LIST = /\bexport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const REEXPORT_ALL = /\bexport\s*\*\s*from\s*["']([^"']+)["']/g;
const REQUIRE =
  /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_DECL =
  /\bexport\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
const EXPORT_DEFAULT =
  /\b(?:export\s+default|module\.exports\s*=)\s*(?!(?:function|class|async|new)\b)([A-Za-z_$][\w$]*)(?![\w$.(])/g;
const SOURCE_EXT = [
  ...[".ts", ".tsx", ".js", ".jsx"],
  ...[".mts", ".cts", ".mjs", ".cjs"],
];

export const readsRoutes = (f: string): boolean =>
  CODE.test(baseName(f)) && !NOT_APP_CODE.test(f);

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
// Comments (`//` and `/* ... */`) are blanked rather than removed, keeping
// line breaks, so a call spread over several lines still matches. Strings are
// skipped whole, so a route "/*" or a URL's `//` is not a comment. A '- or
// "-string ends at the line's end at the latest, so a quote in a regex literal
// costs at most the rest of its line.
const withoutComments = (text: string): string => {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === "/" && (next === "/" || next === "*")) {
      const close = next === "/" ? "\n" : "*/";
      const found = text.indexOf(close, i + 2);
      const end = found === -1 ? text.length : next === "/" ? found : found + 2;
      out.push(text.slice(last, i), text.slice(i, end).replace(/[^\n]/g, " "));
      last = end;
      i = end;
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < text.length) {
        const c = text.charAt(j);
        if (c === "\\") j += 2;
        else if (c === char) {
          j++;
          break;
        } else if (c === "\n" && char !== "`") break;
        else j++;
      }
      i = j;
    } else {
      i++;
    }
  }
  out.push(text.slice(last));
  return out.join("");
};

// The plain names among a call's arguments, from just after an argument's
// comma up to the bracket that closes the call.
const nameArguments = (code: string, from: number): string[] => {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = from; i < code.length; i++) {
    const char = code.charAt(i);
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      if (depth === 0) {
        names.push(current.trim());
        break;
      }
      depth--;
    }
    if (depth === 0 && char === ",") {
      names.push(current.trim());
      current = "";
    } else current += char;
  }
  return names.filter((n) => NAME.test(n));
};

type Route = { owner: string; method: string; path: string };
// `whole`: the target is a plugin whose module's routes all go under prefix.
type Mount = { owner: string; prefix: string; target: string; whole?: boolean };
type Module = {
  routes: Route[];
  mounts: Mount[];
  // Local name -> where it was imported from.
  imports: Map<string, { from: string; name: string }>;
  // Exported name -> local name.
  exports: Map<string, string>;
  // Exported name -> the module and name it is re-exported from.
  reexports: Map<string, { from: string; name: string }>;
  // `export * from` modules.
  reexportAll: string[];
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
  const routes = [...code.matchAll(framework ? ANY_ROUTE : ROUTE)].map((m) => ({
    owner: m[1] ?? "",
    method: (m[2] ?? "").toUpperCase(),
    path: m[4] ?? "",
  }));
  const mounts: Mount[] = [...code.matchAll(MOUNT)].flatMap((m) =>
    nameArguments(code, m.index + m[0].length).map((target) => ({
      owner: m[1] ?? "",
      prefix: m[3] ?? "",
      target,
    })),
  );
  for (const m of code.matchAll(REGISTER))
    mounts.push({
      owner: m[1] ?? "",
      prefix: m[4] ?? "",
      target: m[2] ?? "",
      whole: true,
    });
  const imports: Module["imports"] = new Map();
  for (const m of code.matchAll(IMPORT)) {
    const clause = (m[1] ?? "").replace(/^type\s+/, "");
    const from = m[2] ?? "";
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const [name, local] of namedItems(braces?.[1] ?? "", /\s+as\s+/))
      imports.set(local, { from, name });
    const def =
      clause
        .replace(/\{[^}]*\}/, "")
        .split(",")[0]
        ?.trim() ?? "";
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
  const reexports: Module["reexports"] = new Map();
  for (const m of code.matchAll(REEXPORT_LIST))
    for (const [name, exported] of namedItems(m[1] ?? "", /\s+as\s+/))
      reexports.set(exported, { from: m[2] ?? "", name });
  const reexportAll = [...code.matchAll(REEXPORT_ALL)].map((m) => m[1] ?? "");
  return { routes, mounts, imports, exports, reexports, reexportAll };
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

// Where the name `name` exported by `file` is defined, as `file#local`,
// following re-exports (`export { x } from`, `export * from`) and exported
// imports; undefined when the module doesn't export it. `seen` stops a cycle
// of barrels.
const findExport = (
  modules: Map<string, Module>,
  files: Set<string>,
  file: string,
  name: string,
  seen: Set<string>,
): string | undefined => {
  const key = `${file}#${name}`;
  const mod = modules.get(file);
  if (!mod || seen.has(key)) return undefined;
  seen.add(key);
  const local = mod.exports.get(name);
  if (local !== undefined)
    return localDefinition(modules, files, file, local, seen);
  const re = mod.reexports.get(name);
  if (re) {
    const target = resolveImport(file, re.from, files);
    return target && importedDefinition(modules, files, target, re.name, seen);
  }
  if (name === "default") return undefined;
  for (const from of mod.reexportAll) {
    const target = resolveImport(file, from, files);
    const found = target && findExport(modules, files, target, name, seen);
    if (found) return found;
  }
  return undefined;
};

// What importing `name` from `file` gives: its definition, or failing that
// `file#name` (a router the scanner couldn't trace further).
const importedDefinition = (
  modules: Map<string, Module>,
  files: Set<string>,
  file: string,
  name: string,
  seen: Set<string>,
): string => findExport(modules, files, file, name, seen) ?? `${file}#${name}`;

// Where the local name `local` in `file` is defined: itself, or what it was
// imported as. Undefined when the import names no file in the repo.
const localDefinition = (
  modules: Map<string, Module>,
  files: Set<string>,
  file: string,
  local: string,
  seen: Set<string> = new Set(),
): string | undefined => {
  const imported = modules.get(file)?.imports.get(local);
  if (!imported) return `${file}#${local}`;
  const target = resolveImport(file, imported.from, files);
  return (
    target && importedDefinition(modules, files, target, imported.name, seen)
  );
};

// Full paths: each router's routes get the prefixes of every chain of mounts
// that reaches it. A router no resolvable mount reaches keeps its own paths.
// A Fastify plugin mounts its whole module: `file#*` stands for every router
// in the file that isn't mounted on its own.
const mountedRoutes = (
  modules: Map<string, Module>,
  files: Set<string>,
): Fact<{ method: string; path: string }>[] => {
  const parents = new Map<string, { parent: string; prefix: string }[]>();
  for (const [file, mod] of modules)
    for (const mount of mod.mounts) {
      const found = localDefinition(modules, files, file, mount.target);
      if (!found) continue;
      // A plugin defined in the same file can't be told apart from the app.
      if (mount.whole && found.startsWith(`${file}#`)) continue;
      const child = mount.whole
        ? `${found.slice(0, found.lastIndexOf("#"))}#*`
        : found;
      const list = parents.get(child) ?? [];
      list.push({ parent: `${file}#${mount.owner}`, prefix: mount.prefix });
      parents.set(child, list);
    }
  const above = (key: string) => {
    const own = parents.get(key);
    if (own?.length) return own;
    return parents.get(`${key.slice(0, key.lastIndexOf("#"))}#*`) ?? [];
  };
  const prefixes = (key: string, seen: Set<string>): string[] => {
    const up = above(key).filter((p) => !seen.has(p.parent));
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

export const routesReader: Reader = (root, files, cache) => {
  const routes: Scan["routes"] = [];
  const routeFiles: Scan["routeFiles"] = [];
  const modules = new Map<string, Module>();
  const unreadable = readEach(
    root,
    files,
    readsRoutes,
    (file, text) => {
      if (isNextRoute(file)) {
        for (const match of withoutComments(text).matchAll(NEXT_METHOD)) {
          routes.push({ file, method: match[1] ?? "", path: nextPath(file) });
        }
        return;
      }
      const mod = readModule(text, usesFramework(text));
      modules.set(file, mod);
      if (!mod.routes.length && !mod.mounts.length && IN_ROUTES.test(file))
        routeFiles.push({ file });
    },
    cache,
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
