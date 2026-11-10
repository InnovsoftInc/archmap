import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IN_ROUTES = /(?:^|\/)routes\//;
// Tests and fixtures register routes too, but not the project's.
const NOT_APP_CODE =
  /(?:^|\/)(?:__tests__|fixtures|e2e)\/|\.(?:test|spec)\.[^/]+$/;
// Express, Fastify and Hono all register routes as `thing.get("/path", ...)`.
// Only a path that starts with `/` is a route: `app.get("port")` reads a
// setting.
const ROUTE =
  /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*(["'`])(\/.*?)\2/g;
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

export const routesReader: Reader = (root, files) => {
  const routes: Scan["routes"] = [];
  const routeFiles: Scan["routeFiles"] = [];
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
      let found = false;
      for (const match of withoutComments(text).matchAll(ROUTE)) {
        found = true;
        routes.push({
          file,
          method: (match[1] ?? "").toUpperCase(),
          path: match[3] ?? "",
        });
      }
      if (!found && IN_ROUTES.test(file)) routeFiles.push({ file });
    },
  );
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
