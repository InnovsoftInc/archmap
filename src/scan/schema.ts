import { readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

const DRIZZLE =
  /\b(?:pgTable|mysqlTable|sqliteTable)\(\s*["'](\w+)["']\s*,\s*\{/;
export const readsSchema = (f: string): boolean =>
  /\.(?:prisma|sql|ts|js|mjs)$/.test(f);
const SQL_TABLE = /^\s*create table (?:if not exists )?([^\s(]+)\s*\(/gim;
// A .sql file that neither creates nor alters a table (a query, a grant) is
// not part of the schema.
const SQL_CHANGES_TABLES = /\b(?:create|alter) table\b/i;
const SQL_NOT_COLUMN =
  /^(?:primary|foreign|constraint|unique|key|check|index)\b/i;

const unquote = (name: string) => name.replace(/^["'`[]|["'`\]]$/g, "");

// The comma-separated parts directly inside a bracket that opened just before
// `from`, up to the bracket that closes it. Anything nested deeper, and
// anything after the close, is left out. That keeps a one-line table, a table
// ending `);` and a Drizzle `}, (t) => ({` callback from leaking into columns.
const topLevelParts = (text: string, from: number): string[] => {
  const parts: string[] = [];
  let depth = 1;
  let current = "";
  for (let i = from; i < text.length; i++) {
    const char = text.charAt(i);
    if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth--;
    if (depth === 0) break;
    if (depth === 1 && char === ",") {
      parts.push(current);
      current = "";
    } else if (depth === 1 || (depth === 2 && "{([".includes(char))) {
      current += char;
    }
  }
  parts.push(current);
  return parts;
};

export const schemaReader: Reader = (root, files) => {
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
          if (model?.[1]) {
            table = { file, name: model[1], columns: [] };
            tables.push(table);
          } else if (table && /^\s*\}/.test(line)) {
            table = undefined;
          } else if (table) {
            const field = /^\s*(\w+)\s+\S/.exec(line);
            if (field?.[1]) table.columns.push(field[1]);
          }
        }
        schemaFiles.push({ file, kind: "prisma" });
      } else if (file.endsWith(".sql")) {
        const sql = text.replace(/--.*$/gm, "");
        for (const create of sql.matchAll(SQL_TABLE)) {
          const columns: string[] = [];
          const body = topLevelParts(sql, create.index + create[0].length);
          for (const part of body) {
            const word = /^\s*(\S+)/.exec(part)?.[1];
            if (word && !SQL_NOT_COLUMN.test(word)) columns.push(unquote(word));
          }
          tables.push({ file, name: unquote(create[1] ?? ""), columns });
        }
        if (SQL_CHANGES_TABLES.test(sql))
          schemaFiles.push({ file, kind: "sql" });
      } else {
        // Drizzle: the keys of the object passed as the second argument.
        for (const start of text.matchAll(new RegExp(DRIZZLE, "g"))) {
          const columns: string[] = [];
          for (const part of topLevelParts(
            text,
            start.index + start[0].length,
          )) {
            const key = /^\s*(\w+)\s*:/.exec(part)?.[1];
            if (key) columns.push(key);
          }
          tables.push({ file, name: start[1] ?? "", columns });
        }
        if (tables.length > before) schemaFiles.push({ file, kind: "drizzle" });
      }
    },
  );
  // A dump can be huge and holds nothing we read, so it is listed without
  // being opened.
  for (const file of files.filter((f) => f.endsWith(".bacpac"))) {
    schemaFiles.push({ file, kind: "dump" });
  }
  // One entry per table. A Prisma or Drizzle schema is the table as it is
  // now, so it wins over the migrations that built it; failing that, the
  // latest migration that creates it (files arrive in sorted order).
  const fromOrm = new Set(
    tables.filter((t) => !t.file.endsWith(".sql")).map((t) => t.name),
  );
  const latestSql = new Map(
    tables.filter((t) => t.file.endsWith(".sql")).map((t) => [t.name, t]),
  );
  const kept = tables.filter((t) =>
    t.file.endsWith(".sql")
      ? !fromOrm.has(t.name) && latestSql.get(t.name) === t
      : true,
  );
  return {
    tables: sortFacts(kept, "name"),
    schemaFiles: sortFacts(schemaFiles, "kind"),
    unreadable,
  };
};
