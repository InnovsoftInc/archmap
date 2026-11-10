// From a repo inventory: which starting point the project is at, and a first
// watch list for drift detection.

import { posix } from "node:path";
import type { WatchEntry } from "../watch.ts";
import { isNextRoute } from "./routes.ts";
import type { Scan } from "./types.ts";

export type Stage = "planning" | "scaffolded" | "existing";

export const stage = (s: Scan): Stage => {
  if (
    !s.apps.length &&
    !s.routes.length &&
    !s.routeFiles.length &&
    !s.schemaFiles.length &&
    !s.infra.length &&
    !s.codeFiles
  )
    return "planning";
  if (s.routes.length < 5 && !s.schemaFiles.length && !s.infra.length)
    return "scaffolded";
  return "existing";
};

const folderOf = (file: string): string => posix.dirname(file);
const inFolder = (folder: string, rest: string): string =>
  folder === "." ? rest : `${folder}/${rest}`;
// A file inside a routes/ folder is watched through that folder, so new route
// files count. A route declared anywhere else (a server.ts) is watched by that
// file alone: its whole folder would be far too broad. A Next.js route is
// watched through every route file under its app/ folder.
const routeGlobs = (files: string[]): string[] =>
  files.map((file) => {
    const parts = file.split("/");
    if (isNextRoute(file))
      return [
        ...parts.slice(0, parts.indexOf("app") + 1),
        "**",
        parts.at(-1),
      ].join("/");
    const at = parts.lastIndexOf("routes");
    return at < 0 || at === parts.length - 1
      ? file
      : parts.slice(0, at + 1).join("/") + "/**";
  });
const unique = (paths: string[]): string[] => [...new Set(paths)].sort();

export const proposeWatch = (s: Scan): WatchEntry[] => {
  const entries: WatchEntry[] = [
    {
      paths: unique(
        routeGlobs([...s.routes, ...s.routeFiles].map((f) => f.file)),
      ),
      means: "API endpoints",
      layer: "parts",
    },
    {
      paths: unique(
        s.schemaFiles.flatMap((f) =>
          f.kind === "dump"
            ? []
            : [f.kind === "sql" ? inFolder(folderOf(f.file), "**") : f.file],
        ),
      ),
      means: "Database tables and columns",
      layer: "data",
    },
    {
      paths: unique(
        s.infra
          .filter((f) => f.kind === "terraform")
          .map((f) => inFolder(folderOf(f.file), "**/*.tf")),
      ),
      means: "Hosting and cloud services",
      layer: "overview",
    },
    {
      paths: unique(
        s.infra.filter((f) => f.kind === "compose").map((f) => f.file),
      ),
      means: "Services and containers",
      layer: "overview",
    },
    {
      paths: unique(
        s.apps
          .filter((a) => a.path !== ".")
          .map((a) => posix.join(a.path, "package.json")),
      ),
      means: "Libraries and tools",
      layer: "parts",
    },
    {
      paths: unique(
        s.outside.filter((f) => f.via === "env").map((f) => f.file),
      ),
      means: "Outside services",
      layer: "overview",
    },
  ];
  return entries.filter((e) => e.paths.length > 0);
};
