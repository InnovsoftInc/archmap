// The viewer: `archmap build` writes it as a static site, `archmap dev` serves it
// locally and reloads when the architecture files change.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Marked } from "marked";
import { runCheck } from "./check.ts";
import { loadMap } from "./map/load.ts";
import { ensureDir } from "./project.ts";
import {
  docSections,
  publicConfig,
  stripPublicDocs,
  stripPublicModel,
  toViewModel,
} from "./view.ts";
import type { DocView } from "./view.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = join(HERE, "..", "viewer");
const STATIC = ["index.html", "app.js", "styles.css"];

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// A link or image keeps only these schemes; a URL with no scheme (a relative
// path or #anchor) is fine. Control characters and whitespace are dropped
// first, as browsers do, so "java\tscript:" is caught too.
const SAFE_SCHEME = /^(?:https?|mailto):/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
// marked leaves character references in a URL as written, and the browser
// decodes them in the attribute, so "&#106;avascript:" must be read as
// "javascript:". No named reference stands for a plain letter; these are the
// ones for the separators.
const NAMED = new Map([
  ["colon", ":"],
  ["tab", "\t"],
  ["newline", "\n"],
]);
const REFERENCE = /&(#x[\da-f]+|#\d+|colon|tab|newline);?/gi;
const decoded = (href: string): string =>
  href.replace(REFERENCE, (_, ref: string) => {
    const lower = ref.toLowerCase();
    if (!lower.startsWith("#")) return NAMED.get(lower) ?? "";
    const code = lower.startsWith("#x")
      ? parseInt(lower.slice(2), 16)
      : parseInt(lower.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
const safeUrl = (href: string): boolean => {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const url = decoded(href).replace(/[\u0000-\u0020\u007f]/g, "");
  return SAFE_SCHEME.test(url) || !SCHEME.test(url);
};

// The map is written by agents and anyone with commit access, and the viewer
// puts this HTML straight into the page, so raw HTML in the markdown is shown
// as text, never as markup, and a link or image with any other scheme
// (javascript:, data:) is shown as its text.
const markdown = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ href, tokens }) {
      return safeUrl(href) ? false : this.parser.parseInline(tokens);
    },
    image: ({ href, text }) => (safeUrl(href) ? false : escapeHtml(text)),
  },
});

const html = (md: string | undefined): string | undefined =>
  md === undefined ? undefined : markdown.parse(md, { async: false });

/** Everything the viewer needs, in one JSON document. */
export const siteData = (
  root: string,
  dir: string,
  opts: { dev?: boolean; public?: boolean } = {},
): string => {
  const { errors, warnings, map } = runCheck(root, dir);
  const docs: Record<string, DocView> = {};
  for (const d of map.docs) {
    const s = docSections(d);
    const code = Array.isArray(d.data.code)
      ? d.data.code.filter((c): c is string => typeof c === "string")
      : undefined;
    docs[d.id] = {
      folder: d.folder,
      name: typeof d.data.name === "string" ? d.data.name : d.id,
      status: typeof d.data.status === "string" ? d.data.status : "",
      summary: html(s.summary) ?? "",
      how: html(s.how),
      dev: html(s.dev),
      code,
    };
  }
  const model = toViewModel(map.docs);
  const body = {
    config: {
      ...(opts.public ? publicConfig(map.config) : map.config),
      logo: map.config.logo ? "logo" + extname(map.config.logo) : undefined,
    },
    readme: html(map.readme) ?? "",
    model: opts.public ? stripPublicModel(model) : model,
    docs: opts.public ? stripPublicDocs(docs) : docs,
    ...(opts.public ? {} : { check: { errors, warnings } }),
    dev: opts.dev ?? false,
    public: opts.public ?? false,
  };
  const json = JSON.stringify(body);
  return JSON.stringify({
    ...body,
    rev: createHash("sha1").update(json).digest("hex").slice(0, 12),
  });
};

export const build = (
  root: string,
  dir: string,
  out: string,
  opts: { public?: boolean } = {},
): string[] => {
  ensureDir(out);
  STATIC.forEach((f) => copyFileSync(join(VIEWER, f), join(out, f)));
  writeFileSync(join(out, "data.json"), siteData(root, dir, opts));
  const logo = loadMap(dir).config.logo;
  if (logo) {
    const src = join(dir, logo);
    if (existsSync(src)) copyFileSync(src, join(out, "logo" + extname(logo)));
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

export const serve = (
  root: string,
  dir: string,
  port: number,
): Promise<Server> => {
  const server = createServer((req, res) => {
    const name = basename((req.url || "/").split("?")[0]) || "index.html";
    try {
      let body: string | Buffer;
      if (name === "data.json") body = siteData(root, dir, { dev: true });
      else if (STATIC.includes(name)) body = readFileSync(join(VIEWER, name));
      else if (name.startsWith("logo.")) {
        const logo = loadMap(dir).config.logo;
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
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is in use. Try --port ${port + 1}.`)
          : err,
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
};
