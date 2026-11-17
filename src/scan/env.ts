import { NOT_APP_CODE, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

// The environment variables code reads, by name. Values are never read: a
// `.env` file is not code and is not opened.

const NAME = String.raw`([A-Za-z_]\w*)`;
const QUOTED = String.raw`\s*["'\`]${NAME}["'\`]`;
// eslint-disable-next-line security/detect-non-literal-regexp -- fixed parts
const re = (source: string): RegExp => new RegExp(source, "g");

// JavaScript and TypeScript: `process.env.X`, `process.env["X"]`, the same on
// `Bun.env` and `import.meta.env`, and `Deno.env.get("X")`.
const JS_ENV = String.raw`\b(?:(?:process|Bun)\.env|import\.meta\.env)`;
const JS = [
  re(String.raw`${JS_ENV}\.${NAME}`),
  re(String.raw`${JS_ENV}\[${QUOTED}\s*\]`),
  re(String.raw`\bDeno\.env\.get\(${QUOTED}`),
];
// `const { A, B: b } = process.env`
const JS_DESTRUCTURED = re(
  String.raw`\{([^{}]*)\}\s*=\s*${JS_ENV}\b(?!\s*[.[])`,
);
// The whole environment handed on (`schema.parse(process.env)`): the file
// declares the variables as the keys of an object, one per line.
const JS_WHOLE = re(String.raw`${JS_ENV}\b(?!\s*[.[\w])`);
// Upper-case with an underscore, so `GET:` or `OK:` in the same file is not one.
const SCHEMA_KEY = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;

const BY_EXTENSION: [RegExp, RegExp[]][] = [
  [/\.(?:[cm]?[jt]s|[jt]sx)$/, JS],
  [
    /\.py$/,
    [
      re(String.raw`\bos\.environ(?:\.get\(|\[)${QUOTED}`),
      re(String.raw`\bos\.getenv\(${QUOTED}`),
    ],
  ],
  [/\.go$/, [re(String.raw`\bos\.(?:Getenv|LookupEnv)\(${QUOTED}`)]],
  [/\.rb$/, [re(String.raw`\bENV(?:\.fetch\(|\[)${QUOTED}`)]],
  [/\.rs$/, [re(String.raw`\benv(?:::var(?:_os)?|!)\(${QUOTED}`)]],
  [/\.(?:java|kt)$/, [re(String.raw`\bSystem\.getenv\(${QUOTED}`)]],
  [/\.cs$/, [re(String.raw`\bEnvironment\.GetEnvironmentVariable\(${QUOTED}`)]],
  [
    /\.php$/,
    [re(String.raw`\bgetenv\(${QUOTED}`), re(String.raw`\$_ENV\[${QUOTED}`)],
  ],
];

const patternsFor = (file: string): RegExp[] | undefined =>
  BY_EXTENSION.find(([ext]) => ext.test(file))?.[1];

export const readsEnv = (f: string): boolean =>
  patternsFor(f) !== undefined && !NOT_APP_CODE.test(f);

// Set by the runtime or the build tool, not by whoever deploys the project.
const BUILT_IN = new Set([
  "NODE_ENV",
  "NEXT_RUNTIME",
  "VITEST",
  "JEST_WORKER_ID",
  ...["MODE", "DEV", "PROD", "SSR", "BASE_URL"],
]);

// Prefixes that tell a bundler to put the value in the code it sends to the
// browser: such a variable is public, whatever it holds.
const PUBLIC =
  /^(?:VITE|NEXT_PUBLIC|PUBLIC|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY)_/;

const namesIn = (file: string, text: string): string[] => {
  const names = new Set<string>();
  for (const pattern of patternsFor(file) ?? [])
    for (const m of text.matchAll(pattern)) names.add(m[1] ?? "");
  if (patternsFor(file) === JS) {
    for (const m of text.matchAll(JS_DESTRUCTURED))
      for (const part of (m[1] ?? "").split(",")) {
        const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
        if (name) names.add(name);
      }
    if (text.search(JS_WHOLE) >= 0)
      for (const m of text.matchAll(SCHEMA_KEY))
        if (m[1]?.includes("_")) names.add(m[1]);
  }
  return [...names].filter((n) => n && !BUILT_IN.has(n));
};

export const envReader: Reader = (root, files, cache) => {
  const env: Scan["env"] = [];
  const unreadable = readEach(
    root,
    files,
    readsEnv,
    (file, text) => {
      for (const name of namesIn(file, text))
        env.push({ file, name, public: PUBLIC.test(name) });
    },
    cache,
  );
  return { env: sortFacts(env, "name"), unreadable };
};
