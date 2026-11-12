import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
export const readsCi = (f: string): boolean => WORKFLOW.test(f);
const DEPLOY =
  /\b(?:azure\/|aws-actions\/|docker\/build-push-action|vercel|netlify|fly)[\w./@-]*|\bdocker push\b/g;
// Copying to a server: the command itself, not a ~/.ssh path or ssh-keyscan.
const COPY = /(?<![\w./~-])(?:ssh|scp|rsync)(?=\s)/g;

export const ciReader: Reader = (root, files) => {
  const ci: Scan["ci"] = [];
  const unreadable = readEach(
    root,
    files,
    readsCi,
    (file, text) => {
      const deploys = new Set<string>();
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        for (const m of line.matchAll(DEPLOY)) deploys.add(m[0]);
        for (const m of line.matchAll(COPY)) deploys.add(m[0]);
      }
      ci.push({
        file,
        workflow: baseName(file),
        deploys: [...deploys].toSorted(),
      });
    },
  );
  return { ci: sortFacts(ci), unreadable };
};
