// The viewer: `archmap build` writes it as a static site, `archmap dev` serves it
// locally and reloads when the architecture files change.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ensureDir, loadProject } from "./project.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = join(HERE, "..", "viewer");
const STATIC = ["index.html", "app.js", "styles.css"];

/** core.ts with its types removed, so the browser runs the same replay as the CLI. */
export const coreJs = (): string =>
  stripTypeScriptTypes(readFileSync(join(HERE, "core.ts"), "utf8"));

/** Everything the viewer needs, in one JSON document. */
export const siteData = (dir: string, dev = false): string => {
  const p = loadProject(dir);
  const body = {
    config: {
      ...p.config,
      logo: p.config.logo ? "logo" + extname(p.config.logo) : undefined,
    },
    saves: p.saves,
    versions: p.versions,
    instructions: p.instructions,
    fileErrors: p.fileErrors,
    dev,
  };
  const json = JSON.stringify(body);
  return JSON.stringify({
    ...body,
    rev: createHash("sha1").update(json).digest("hex").slice(0, 12),
  });
};

export const build = (dir: string, out: string): string[] => {
  ensureDir(out);
  STATIC.forEach((f) => copyFileSync(join(VIEWER, f), join(out, f)));
  writeFileSync(join(out, "core.js"), coreJs());
  writeFileSync(join(out, "data.json"), siteData(dir));
  const p = loadProject(dir);
  if (p.config.logo) {
    const src = join(dir, p.config.logo);
    if (existsSync(src))
      copyFileSync(src, join(out, "logo" + extname(p.config.logo)));
  }
  return [
    `Built the map into ${out}. Host the folder anywhere that serves static files.`,
  ];
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export const serve = (dir: string, port: number): Promise<Server> => {
  const server = createServer((req, res) => {
    const name = basename((req.url || "/").split("?")[0]) || "index.html";
    try {
      let body: string | Buffer;
      if (name === "data.json") body = siteData(dir, true);
      else if (name === "core.js") body = coreJs();
      else if (STATIC.includes(name)) body = readFileSync(join(VIEWER, name));
      else if (name.startsWith("logo.")) {
        const logo = loadProject(dir).config.logo;
        if (!logo) throw new Error("no logo");
        body = readFileSync(join(dir, logo));
      } else {
        res.writeHead(404).end("Not found");
        return;
      }
      res
        .writeHead(200, {
          "content-type": TYPES[extname(name)] || "application/octet-stream",
          "cache-control": "no-store",
        })
        .end(body);
    } catch (err) {
      res
        .writeHead(500, { "content-type": "text/plain" })
        .end((err as Error).message);
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
};
