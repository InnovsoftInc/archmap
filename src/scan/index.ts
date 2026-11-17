import { appsReader, readsApps } from "./workspace.ts";
import { readsRoutes, routesReader } from "./routes.ts";
import { readsSchema, schemaReader } from "./schema.ts";
import { infraReader, readsInfra } from "./infra.ts";
import { outsideReader, readsOutside } from "./outside.ts";
import { envReader, readsEnv } from "./env.ts";
import { ciReader, readsCi } from "./ci.ts";
import { sortFacts, walk } from "./walk.ts";
import type { FileCache, Reader, Scan } from "./types.ts";

export type { Fact, Scan } from "./types.ts";
export { walk } from "./walk.ts";

const READERS: Reader[] = [
  appsReader,
  routesReader,
  schemaReader,
  infraReader,
  outsideReader,
  envReader,
  ciReader,
];

/** Whether any reader opens `file`: the files a scan's leads depend on. */
export const scannerReads = (file: string): boolean =>
  [
    readsApps,
    readsRoutes,
    readsSchema,
    readsInfra,
    readsOutside,
    readsEnv,
    readsCi,
  ].some((reads) => reads(file));

// Files in common programming languages: a repo with any of them has code,
// even with no package.json, routes or infrastructure.
const CODE = /\.(?:tsx?|jsx?|py|go|rb|java|cs|php|rs)$/;

// A deterministic inventory of the repo. It only reads files; it never runs
// project code. Each reader sees the same file list.
export const scan = (root: string): Scan => {
  const unreadable: Scan["unreadable"] = [];
  const files = walk(root, unreadable);
  const result: Scan = {
    root,
    apps: [],
    routes: [],
    routeFiles: [],
    tables: [],
    schemaFiles: [],
    infra: [],
    outside: [],
    env: [],
    ci: [],
    unreadable,
    codeFiles: files.filter((f) => f.startsWith("src/") || CODE.test(f)).length,
  };
  // Several readers open the same files (package.json, source files): each
  // is read from disk once.
  const cache: FileCache = new Map();
  for (const reader of READERS) {
    const part = reader(root, files, cache);
    result.apps.push(...(part.apps ?? []));
    result.routes.push(...(part.routes ?? []));
    result.routeFiles.push(...(part.routeFiles ?? []));
    result.tables.push(...(part.tables ?? []));
    result.schemaFiles.push(...(part.schemaFiles ?? []));
    result.infra.push(...(part.infra ?? []));
    result.outside.push(...(part.outside ?? []));
    result.env.push(...(part.env ?? []));
    result.ci.push(...(part.ci ?? []));
    result.unreadable.push(...(part.unreadable ?? []));
  }
  // A file several readers open is reported once.
  const reported = new Map(
    result.unreadable.map((u) => [`${u.file}\0${u.reason}`, u]),
  );
  result.unreadable = sortFacts([...reported.values()], "reason");
  return result;
};
