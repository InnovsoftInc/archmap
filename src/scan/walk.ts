import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Fact, FileCache, Scan } from "./types.ts";

// Folders that hold other people's code, build output or caches, never this
// project's.
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".turbo",
  ".terraform",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
]);
// Build-output names that are also used for a workspace package's own
// folder: such a folder is kept when it has a package.json.
const KEPT_WITH_MANIFEST = new Set(["dist", "build"]);

// Tests and fixtures register routes and build tables too, but not the
// project's.
export const NOT_APP_CODE =
  /(?:^|\/)(?:__tests__|fixtures|e2e)\/|\.(?:test|spec)\.[^/]+$/;

// Bigger files are generated or data, not code worth reading.
export const MAX_READ_BYTES = 1024 * 1024;

const bySegments = (a: string, b: string): number => {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x.at(i) ?? "";
    const q = y.at(i) ?? "";
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
};

// Whether a folder at `dir` (repo-relative) is left out of the scan.
const skipsFolder = (dir: string, hasManifest: (dir: string) => boolean) => {
  const name = path.posix.basename(dir);
  if (!SKIPPED.has(name)) return false;
  return !(KEPT_WITH_MANIFEST.has(name) && hasManifest(dir));
};

// The files git would show for the repo: tracked plus untracked files that
// aren't ignored. Undefined when root isn't in a git work tree (or git is
// missing), so the caller walks the folders instead.
const gitFiles = (root: string): string[] | undefined => {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 512 },
  );
  if (result.status !== 0 || typeof result.stdout !== "string")
    return undefined;
  const listed = [...new Set(result.stdout.split("\0").filter(Boolean))];
  // An ignored root (a temp folder inside a repo) lists nothing: walk it.
  if (!listed.length) return undefined;
  const manifests = new Set(
    listed
      .filter((f) => path.posix.basename(f) === "package.json")
      .map((f) => path.posix.dirname(f)),
  );
  const out: string[] = [];
  for (const file of listed) {
    const parts = file.split("/");
    const skipped = parts
      .slice(0, -1)
      .some((_, i) =>
        skipsFolder(parts.slice(0, i + 1).join("/"), (d) => manifests.has(d)),
      );
    if (skipped) continue;
    // Deleted but still tracked files, symlinks and submodules are left out,
    // as the folder walk leaves them out.
    try {
      if (!lstatSync(path.join(root, file)).isFile()) continue;
    } catch {
      continue;
    }
    out.push(file);
  }
  return out.toSorted(bySegments);
};

// Every file under root as a repo-relative posix path, in a stable order.
// In a git work tree that is what `git ls-files` lists, so .gitignore is
// respected; elsewhere the folders are walked. Symlinks are not followed, so
// a link can't lead the scan outside the repo. A folder that can't be read is
// added to `unreadable` (when given) and skipped, so one locked folder never
// stops the scan.
export const walk = (
  root: string,
  unreadable: Scan["unreadable"] = [],
): string[] => gitFiles(root) ?? walkFolders(root, unreadable);

export const walkFolders = (
  root: string,
  unreadable: Scan["unreadable"] = [],
): string[] => {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
      unreadable.push({
        file: dir || ".",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const entry of entries.toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const hasManifest = () => {
          try {
            return readdirSync(path.join(root, rel)).includes("package.json");
          } catch {
            return false;
          }
        };
        if (!skipsFolder(rel, hasManifest)) visit(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  visit("");
  return out;
};

export const baseName = (file: string): string => path.posix.basename(file);

// A file's text, read once per scan when a cache is given. Too-big files
// throw, so they are reported rather than read.
export const readText = (
  root: string,
  file: string,
  cache?: FileCache,
): string => {
  const cached = cache?.get(file);
  if (cached instanceof Error) throw cached;
  if (cached !== undefined) return cached;
  let value: string | Error;
  try {
    const full = path.join(root, file);
    const size = statSync(full).size;
    value =
      size > MAX_READ_BYTES
        ? new Error(`larger than 1 MB (${size} bytes), not read`)
        : readFileSync(full, "utf8");
  } catch (error) {
    value = error instanceof Error ? error : new Error(String(error));
  }
  cache?.set(file, value);
  if (value instanceof Error) throw value;
  return value;
};

// Reads each matching file and hands its text to `read`. A file that can't be
// read or parsed is reported and skipped, so one bad file never stops the scan.
export const readEach = (
  root: string,
  files: string[],
  match: (file: string) => boolean,
  read: (file: string, text: string) => void,
  cache?: FileCache,
): Scan["unreadable"] => {
  const unreadable: Scan["unreadable"] = [];
  for (const file of files.filter(match)) {
    try {
      read(file, readText(root, file, cache));
    } catch (error) {
      unreadable.push({
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return unreadable;
};

// Orders facts by file, then by the given fields, so output is the same on
// every run.
export const sortFacts = <T extends Fact<object>>(
  facts: T[],
  ...keys: string[]
): T[] =>
  facts.toSorted((a, b) => {
    for (const key of ["file", ...keys]) {
      const x = String(Reflect.get(a, key));
      const y = String(Reflect.get(b, key));
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
