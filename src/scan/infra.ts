import path from "node:path";
import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

const isCompose = (f: string) =>
  baseName(f).startsWith("docker-compose") && /\.ya?ml$/.test(f);
const isDockerfile = (f: string) =>
  baseName(f) === "Dockerfile" || baseName(f).startsWith("Dockerfile.");

export const readsInfra = (f: string): boolean =>
  f.endsWith(".tf") || isCompose(f) || isDockerfile(f);

// The keys one level under a top-level `services:` line.
const composeServices = (text: string): string[] => {
  const names: string[] = [];
  let inServices = false;
  let indent: string | undefined;
  for (const line of text.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
    } else if (inServices && /^\S/.test(line) && !line.startsWith("#")) {
      break;
    } else if (inServices) {
      const key = /^(\s+)([\w.-]+):\s*$/.exec(line);
      if (key?.[1] && key[2]) {
        indent ??= key[1];
        if (key[1] === indent) names.push(key[2]);
      }
    }
  }
  if (!inServices) throw new Error("no services: section found");
  return names;
};

export const infraReader: Reader = (root, files) => {
  const infra: Scan["infra"] = [];
  const unreadable = readEach(
    root,
    files,
    readsInfra,
    (file, text) => {
      if (file.endsWith(".tf")) {
        for (const m of text.matchAll(
          /^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm,
        )) {
          infra.push({
            file,
            kind: "terraform",
            type: m[1] ?? "",
            name: m[2] ?? "",
          });
        }
      } else if (isCompose(file)) {
        for (const name of composeServices(text)) {
          infra.push({ file, kind: "compose", type: "service", name });
        }
      } else {
        infra.push({
          file,
          kind: "docker",
          type: "image",
          name: path.posix.dirname(file),
        });
      }
    },
  );
  return { infra: sortFacts(infra, "name", "type"), unreadable };
};
