import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Fact, Scan } from "./types.ts";

// Folders that hold other people's code or build output, never this project's.
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".terraform",
  ".next",
  ".venv",
]);

// Every file under root as a repo-relative posix path, in a stable order.
// Symlinks are not followed, so a link can't lead the scan outside the repo.
// A folder that can't be read is added to `unreadable` (when given) and
// skipped, so one locked folder never stops the scan.
export const walk = (
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
        if (!SKIPPED.has(entry.name)) visit(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  visit("");
  return out;
};

export const baseName = (file: string): string => path.posix.basename(file);

// Reads each matching file and hands its text to `read`. A file that can't be
// read or parsed is reported and skipped, so one bad file never stops the scan.
export const readEach = (
  root: string,
  files: string[],
  match: (file: string) => boolean,
  read: (file: string, text: string) => void,
): Scan["unreadable"] => {
  const unreadable: Scan["unreadable"] = [];
  for (const file of files.filter(match)) {
    try {
      read(file, readFileSync(path.join(root, file), "utf8"));
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
