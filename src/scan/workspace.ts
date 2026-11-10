import { readFileSync } from "node:fs";
import path from "node:path";
import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

// Workspace patterns from pnpm-workspace.yaml (the "- pattern" lines under
// packages:) or package.json workspaces. Negated ones (`!dir`) are applied as exclusions.
const patterns = (root: string, manifest: Manifest): string[] => {
  const found: string[] = [];
  const { workspaces } = manifest;
  if (Array.isArray(workspaces)) found.push(...workspaces);
  else if (workspaces?.packages) found.push(...workspaces.packages);
  try {
    const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const line of yaml.split("\n")) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const item = /^\s+-\s*["']?([^"'#\s]+)/.exec(line);
        if (item?.[1]) found.push(item[1]);
      }
    }
  } catch {
    // No pnpm-workspace.yaml: package.json workspaces (or none) is all there is.
  }
  return found;
};

export const appsReader: Reader = (root, files) => {
  const apps: Scan["apps"] = [];
  const dirOf = (file: string) => path.posix.dirname(file);
  const manifests = new Map<string, Manifest>();
  const unreadable = readEach(
    root,
    files,
    (f) => baseName(f) === "package.json",
    (file, text) => {
      manifests.set(file, JSON.parse(text) as Manifest);
    },
  );
  const rootManifest = manifests.get("package.json");
  const workspace = patterns(root, rootManifest ?? {});

  for (const [file, manifest] of manifests) {
    const dir = dirOf(file);
    const deps = Object.keys(manifest.dependencies ?? {}).toSorted();
    const matches = (p: string) =>
      path.posix.matchesGlob(file, `${p}/package.json`);
    const inWorkspace =
      workspace.some((p) => !p.startsWith("!") && matches(p)) &&
      !workspace.some((p) => p.startsWith("!") && matches(p.slice(1)));
    // The root counts when it has dependencies of its own; other packages
    // only when a workspace pattern names them.
    if (dir === "." ? deps.length === 0 : !inWorkspace) continue;
    apps.push({
      file,
      name: manifest.name ?? path.posix.basename(dir === "." ? root : dir),
      path: dir,
      deps,
    });
  }
  return { apps: sortFacts(apps, "path"), unreadable };
};
