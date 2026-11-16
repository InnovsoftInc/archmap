import path from "node:path";
import { parse } from "yaml";
import {
  NOT_APP_CODE,
  baseName,
  readEach,
  readText,
  sortFacts,
} from "./walk.ts";
import type { FileCache, Reader, Scan } from "./types.ts";

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

// A pattern as written ("./apps/*", "apps/*/") as a glob relative to the
// root ("apps/*"). A leading `!` is kept.
const normalize = (pattern: string): string => {
  const negated = pattern.startsWith("!");
  const glob = (negated ? pattern.slice(1) : pattern)
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return negated ? `!${glob}` : glob;
};

// Workspace patterns from pnpm-workspace.yaml (its `packages` list) or
// package.json `workspaces` (a list, or `{ packages: [...] }`). Negated ones
// (`!dir`) are applied as exclusions.
const patterns = (
  root: string,
  manifest: Manifest,
  files: string[],
  cache?: FileCache,
): string[] => {
  const found: unknown[] = [];
  const { workspaces } = manifest;
  if (Array.isArray(workspaces)) found.push(...workspaces);
  else if (Array.isArray(workspaces?.packages))
    found.push(...workspaces.packages);
  if (files.includes("pnpm-workspace.yaml")) {
    const doc: unknown = parse(readText(root, "pnpm-workspace.yaml", cache));
    const packages: unknown =
      typeof doc === "object" && doc !== null
        ? Reflect.get(doc, "packages")
        : undefined;
    if (Array.isArray(packages)) found.push(...packages);
  }
  return found
    .filter((p): p is string => typeof p === "string")
    .map(normalize)
    .filter((p) => p && p !== "!");
};

export const readsApps = (f: string): boolean =>
  baseName(f) === "package.json" || f === "pnpm-workspace.yaml";

export const appsReader: Reader = (root, files, cache) => {
  const apps: Scan["apps"] = [];
  const dirOf = (file: string) => path.posix.dirname(file);
  const manifests = new Map<string, Manifest>();
  const unreadable = readEach(
    root,
    files,
    (f) => baseName(f) === "package.json",
    (file, text) => {
      const manifest: unknown = JSON.parse(text);
      if (typeof manifest !== "object" || manifest === null)
        throw new Error("not a JSON object");
      manifests.set(file, manifest as Manifest);
    },
    cache,
  );
  const rootManifest = manifests.get("package.json");
  let workspace: string[] = [];
  try {
    workspace = patterns(root, rootManifest ?? {}, files, cache);
  } catch (error) {
    unreadable.push({
      file: "pnpm-workspace.yaml",
      reason:
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "")
          : String(error),
    });
  }

  for (const [file, manifest] of manifests) {
    const dir = dirOf(file);
    const deps = Object.keys(manifest.dependencies ?? {}).toSorted();
    const matches = (p: string) =>
      path.posix.matchesGlob(file, `${p}/package.json`);
    const inWorkspace =
      workspace.some((p) => !p.startsWith("!") && matches(p)) &&
      !workspace.some((p) => p.startsWith("!") && matches(p.slice(1)));
    // The root counts when it has dependencies of its own; other packages
    // when a workspace pattern names them or, in a repo with no workspaces,
    // when they have dependencies and aren't test fixtures.
    const counts =
      dir === "."
        ? deps.length > 0
        : workspace.length
          ? inWorkspace
          : deps.length > 0 && !NOT_APP_CODE.test(file);
    if (!counts) continue;
    apps.push({
      file,
      name: manifest.name ?? path.posix.basename(dir === "." ? root : dir),
      path: dir,
      deps,
    });
  }
  return { apps: sortFacts(apps, "path"), unreadable };
};
