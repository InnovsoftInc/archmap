import path from "node:path";
import { parse, YAMLError } from "yaml";
import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

// Compose files: compose.yaml / compose.yml (the current names) and
// docker-compose*.yml / .yaml, including overrides like
// docker-compose.prod.yml.
const isCompose = (f: string) => {
  const name = baseName(f);
  return (
    /\.ya?ml$/.test(name) &&
    (/^compose\.ya?ml$/.test(name) || name.startsWith("docker-compose"))
  );
};
const isDockerfile = (f: string) =>
  baseName(f) === "Dockerfile" || baseName(f).startsWith("Dockerfile.");

export const readsInfra = (f: string): boolean =>
  f.endsWith(".tf") || isCompose(f) || isDockerfile(f);

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The keys of the top-level `services` mapping.
const composeServices = (text: string): string[] => {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    // The parser's message ends "at line N, column M:" and a code frame.
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.split(/ at line \d+|\n/)[0]?.trim() ?? message;
    const line = error instanceof YAMLError ? error.linePos?.[0].line : 0;
    throw new Error(
      line
        ? `invalid YAML at line ${line}: ${reason}`
        : `invalid YAML: ${reason}`,
      { cause: error },
    );
  }
  const services = isMapping(doc) ? doc.services : undefined;
  if (services === undefined) throw new Error("no services: section found");
  if (services === null) return [];
  if (!isMapping(services)) throw new Error("services: is not a mapping");
  return Object.keys(services);
};

export const infraReader: Reader = (root, files, cache) => {
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
    cache,
  );
  return { infra: sortFacts(infra, "name", "type"), unreadable };
};
