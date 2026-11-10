import { appsReader } from "./workspace.ts";
import { routesReader } from "./routes.ts";
import { schemaReader } from "./schema.ts";
import { infraReader } from "./infra.ts";
import { outsideReader } from "./outside.ts";
import { ciReader } from "./ci.ts";
import { sortFacts, walk } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

export type { Fact, Scan } from "./types.ts";
export { walk } from "./walk.ts";

const READERS: Reader[] = [
  appsReader,
  routesReader,
  schemaReader,
  infraReader,
  outsideReader,
  ciReader,
];

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
    ci: [],
    unreadable,
    codeFiles: files.filter((f) => f.startsWith("src/") || CODE.test(f)).length,
  };
  for (const reader of READERS) {
    const part = reader(root, files);
    result.apps.push(...(part.apps ?? []));
    result.routes.push(...(part.routes ?? []));
    result.routeFiles.push(...(part.routeFiles ?? []));
    result.tables.push(...(part.tables ?? []));
    result.schemaFiles.push(...(part.schemaFiles ?? []));
    result.infra.push(...(part.infra ?? []));
    result.outside.push(...(part.outside ?? []));
    result.ci.push(...(part.ci ?? []));
    result.unreadable.push(...(part.unreadable ?? []));
  }
  result.unreadable = sortFacts(result.unreadable, "reason");
  return result;
};
