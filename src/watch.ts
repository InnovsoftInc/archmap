// The watch list: which changed files mean which part of the architecture map.
// Each entry says "if a file matching these paths changes, look at this layer".

import path from "node:path";

export type Layer = "overview" | "parts" | "data" | "people";

export const LAYERS: Layer[] = ["overview", "parts", "data", "people"];

export type WatchEntry = { paths: string[]; means: string; layer: Layer };

// Groups changed files by watch entry. Keeps the order of `watch`, leaves out
// entries with no files, and a file can match more than one entry.
export const matchWatch = (
  files: string[],
  watch: WatchEntry[],
): { entry: WatchEntry; files: string[] }[] =>
  watch
    .map((entry) => ({
      entry,
      files: files.filter((file) =>
        entry.paths.some((glob) => path.posix.matchesGlob(file, glob)),
      ),
    }))
    .filter((group) => group.files.length > 0);
