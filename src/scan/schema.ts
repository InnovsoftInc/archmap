import path from "node:path";
import { NOT_APP_CODE, baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

const DRIZZLE =
  /\b(?:pgTable|mysqlTable|sqliteTable)\(\s*["'](\w+)["']\s*,\s*\{/g;
// Cheap test before the full match: most source files build no tables.
const DRIZZLE_CALL = /\b(?:pg|mysql|sqlite)Table\(/;
// Tests and fixtures hold schemas too, but not the project's.
export const readsSchema = (f: string): boolean =>
  /\.(?:prisma|sql|ts|js|mjs)$/.test(f) && !NOT_APP_CODE.test(f);

// One SQL identifier: "quoted", [bracketed], `backticked` or bare; a table's
// name is one or more of them joined by dots (`schema.table`).
const SQL_CREATE = /^\s*create\s+table\s+/gim;
const IF_NOT_EXISTS_AT = /if\s+not\s+exists\s+/iy;
const IDENT_AT = /"[^"]*"|\[[^\]]*\]|`[^`]*`|[^\s(."[`,;]+/y;
const DOT_AT = /\s*\.\s*/y;
const OPEN_AT = /\s*\(/y;
const LEADING_IDENT = /^\s*("[^"]*"|\[[^\]]*\]|`[^`]*`|[^\s(."[`,;]+)/;
// A .sql file that neither creates nor alters a table (a query, a grant) is
// not part of the schema.
const SQL_CHANGES_TABLES = /\b(?:create|alter) table\b/i;
const SQL_NOT_COLUMN =
  /^(?:primary|foreign|constraint|unique|key|check|index)$/i;

const isQuoted = (name: string) => /^(?:".*"|\[.*\]|`.*`)$/s.test(name);
const unquote = (name: string) => (isQuoted(name) ? name.slice(1, -1) : name);
// The name after CREATE TABLE at `from`: the parts of `schema.table`, each
// possibly quoted and unquoted here, and where the column list starts; or
// undefined when no `(` follows the name.
const tableName = (
  sql: string,
  from: number,
): { parts: string[]; body: number } | undefined => {
  const parts: string[] = [];
  IF_NOT_EXISTS_AT.lastIndex = from;
  let at = IF_NOT_EXISTS_AT.exec(sql) ? IF_NOT_EXISTS_AT.lastIndex : from;
  for (;;) {
    IDENT_AT.lastIndex = at;
    const ident = IDENT_AT.exec(sql);
    if (!ident) return undefined;
    parts.push(unquote(ident[0]));
    at = IDENT_AT.lastIndex;
    DOT_AT.lastIndex = at;
    if (!DOT_AT.exec(sql)) break;
    at = DOT_AT.lastIndex;
  }
  OPEN_AT.lastIndex = at;
  return OPEN_AT.exec(sql) ? { parts, body: OPEN_AT.lastIndex } : undefined;
};

// SQL without its comments, keeping quoted text (a `--` inside a string).
const withoutSqlComments = (sql: string): string =>
  sql.replace(
    /('(?:[^']|'')*'|"[^"]*"|\[[^\]]*\]|`[^`]*`)|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted: string | undefined) =>
      quoted ?? match.replace(/[^\n]/g, " "),
  );

type Brackets = { open: string; close: string; quotes: Map<string, string> };
// SQL nests only round brackets: [x] is a quoted name, like "x" and `x`.
const SQL_BRACKETS: Brackets = {
  open: "(",
  close: ")",
  quotes: new Map([
    ["'", "'"],
    ['"', '"'],
    ["`", "`"],
    ["[", "]"],
  ]),
};
// In code, a comment like `// don't` would open a quote that never closes,
// so quotes are not tracked: a comma in a string is nested in a call anyway.
const JS_BRACKETS: Brackets = { open: "{([", close: "})]", quotes: new Map() };

// The comma-separated parts directly inside a bracket that opened just before
// `from`, up to the bracket that closes it. Anything nested deeper, and
// anything after the close, is left out. That keeps a one-line table, a table
// ending `);` and a Drizzle `}, (t) => ({` callback from leaking into columns.
// Quoted text is copied whole, so a comma or bracket in it changes nothing.
const topLevelParts = (
  text: string,
  from: number,
  brackets: Brackets,
): string[] => {
  const parts: string[] = [];
  let depth = 1;
  let current = "";
  for (let i = from; i < text.length; i++) {
    const char = text.charAt(i);
    const closeQuote = brackets.quotes.get(char);
    if (closeQuote) {
      const end = text.indexOf(closeQuote, i + 1);
      const quoted = text.slice(i, end === -1 ? text.length : end + 1);
      if (depth === 1) current += quoted;
      i += quoted.length - 1;
      continue;
    }
    if (brackets.open.includes(char)) depth++;
    else if (brackets.close.includes(char)) depth--;
    if (depth === 0) break;
    if (depth === 1 && char === ",") {
      parts.push(current);
      current = "";
    } else if (depth === 1 || (depth === 2 && brackets.open.includes(char))) {
      current += char;
    }
  }
  parts.push(current);
  return parts;
};

// Files that describe a project of their own: tables are de-duplicated within
// the project that holds them, not across the repo.
const PROJECT_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
]);
const isProjectManifest = (name: string) =>
  PROJECT_MANIFESTS.has(name) || name.endsWith(".csproj");
const projectOf = (projects: Set<string>, file: string): string => {
  let dir = path.posix.dirname(file);
  while (dir !== "." && !projects.has(dir)) dir = path.posix.dirname(dir);
  return dir;
};

export const schemaReader: Reader = (root, files, cache) => {
  const tables: Scan["tables"] = [];
  const schemaFiles: Scan["schemaFiles"] = [];

  const unreadable = readEach(
    root,
    files,
    readsSchema,
    (file, text) => {
      const lines = text.split("\n");
      const before = tables.length;

      if (file.endsWith(".prisma")) {
        let table: Scan["tables"][number] | undefined;
        for (const line of lines) {
          const model = /^\s*model\s+(\w+)\s*\{/.exec(line);
          const mapped = /^\s*@@map\([^")]*"([^"]+)"/.exec(line);
          if (model?.[1]) {
            table = { file, name: model[1], columns: [] };
            tables.push(table);
          } else if (table && /^\s*\}/.test(line)) {
            table = undefined;
          } else if (table && mapped?.[1]) {
            // The table's name in the database, which migrations and the
            // map use, rather than the model's.
            table.name = mapped[1];
          } else if (table) {
            const field = /^\s*(\w+)\s+\S/.exec(line);
            if (field?.[1]) table.columns.push(field[1]);
          }
        }
        schemaFiles.push({ file, kind: "prisma" });
      } else if (file.endsWith(".sql")) {
        const sql = withoutSqlComments(text);
        for (const create of sql.matchAll(SQL_CREATE)) {
          const found = tableName(sql, create.index + create[0].length);
          if (!found) continue;
          const columns: string[] = [];
          const body = topLevelParts(sql, found.body, SQL_BRACKETS);
          for (const part of body) {
            const word = LEADING_IDENT.exec(part)?.[1];
            if (word && (isQuoted(word) || !SQL_NOT_COLUMN.test(word)))
              columns.push(unquote(word));
          }
          const name = found.parts.at(-1) ?? "";
          tables.push({ file, name, columns });
        }
        if (SQL_CHANGES_TABLES.test(sql))
          schemaFiles.push({ file, kind: "sql" });
      } else if (DRIZZLE_CALL.test(text)) {
        // Drizzle: the keys of the object passed as the second argument.
        for (const start of text.matchAll(DRIZZLE)) {
          const columns: string[] = [];
          for (const part of topLevelParts(
            text,
            start.index + start[0].length,
            JS_BRACKETS,
          )) {
            const key = /^\s*(\w+)\s*:/.exec(part)?.[1];
            if (key) columns.push(key);
          }
          tables.push({ file, name: start[1] ?? "", columns });
        }
        if (tables.length > before) schemaFiles.push({ file, kind: "drizzle" });
      }
    },
    cache,
  );
  // A dump can be huge and holds nothing we read, so it is listed without
  // being opened.
  for (const file of files.filter(
    (f) => f.endsWith(".bacpac") && !NOT_APP_CODE.test(f),
  )) {
    schemaFiles.push({ file, kind: "dump" });
  }
  // One entry per table in each project (the nearest folder above with a
  // package.json or another project manifest, else the repo). A Prisma or
  // Drizzle schema is the table as it is now, so it wins over the migrations
  // that built it; failing that, the latest migration that creates it (files
  // arrive in sorted order). Two projects with a table of the same name keep
  // one each.
  const projects = new Set(
    files
      .filter((f) => isProjectManifest(baseName(f)))
      .map((f) => path.posix.dirname(f)),
  );
  const scoped = (t: Scan["tables"][number]) =>
    `${projectOf(projects, t.file)}\0${t.name}`;
  const fromOrm = new Set(
    tables.filter((t) => !t.file.endsWith(".sql")).map(scoped),
  );
  const latestSql = new Map(
    tables.filter((t) => t.file.endsWith(".sql")).map((t) => [scoped(t), t]),
  );
  const kept = tables.filter((t) =>
    t.file.endsWith(".sql")
      ? !fromOrm.has(scoped(t)) && latestSql.get(scoped(t)) === t
      : true,
  );
  return {
    tables: sortFacts(kept, "name"),
    schemaFiles: sortFacts(schemaFiles, "kind"),
    unreadable,
  };
};
