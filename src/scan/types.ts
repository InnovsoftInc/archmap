// What `archmap scan` reports. Every fact names the file it came from, so
// Claude can cite it and the person can check it.

export type Fact<T> = T & { file: string };

export type Scan = {
  root: string;
  apps: Fact<{ name: string; path: string; deps: string[] }>[];
  routes: Fact<{ method: string; path: string }>[];
  // Files under a routes/ folder where no route could be read.
  routeFiles: Fact<object>[];
  tables: Fact<{ name: string; columns: string[] }>[];
  schemaFiles: Fact<{ kind: "prisma" | "drizzle" | "sql" | "dump" }>[];
  infra: Fact<{
    kind: "terraform" | "compose" | "docker";
    type: string;
    name: string;
  }>[];
  outside: Fact<{ name: string; via: "env" | "sdk" }>[];
  ci: Fact<{ workflow: string; deploys: string[] }>[];
  unreadable: Fact<{ reason: string }>[];
  // How many files are code (a common code extension, or anything under a
  // top-level src/): a repo with none is still at the planning stage.
  codeFiles: number;
};

// File text by repo-relative path (or why it couldn't be read), shared by the
// readers so each file is read at most once per scan.
export type FileCache = Map<string, string | Error>;

export type Reader = (
  root: string,
  files: string[],
  cache?: FileCache,
) => Partial<Scan>;
