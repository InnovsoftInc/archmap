// The viewer: `archmap build` writes it as a static site, `archmap dev` serves it
// locally and reloads when the architecture files change.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Marked } from "marked";
import { runCheck } from "./check.ts";
import { loadMap } from "./map/load.ts";
import {
  docSections,
  publicConfig,
  stripPublicDocs,
  stripPublicModel,
  toViewModel,
} from "./view.ts";
import type { DocView, LibInfo } from "./view.ts";
import { fromRegistry, latestVersions } from "./registry.ts";
import { freshness, libraryVersions } from "./versions.ts";
import { lanesOf } from "./map/lanes.ts";
import type { MapConfig } from "./map/types.ts";

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

// A font stylesheet is loaded into the page, so it must come over https (or
// from the site itself); a protocol-relative "//host" URL counts as another
// host.
const safeStylesheet = (href: string): boolean => {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const url = decoded(href).replace(/[\u0000-\u0020\u007f]/g, "");
  if (/^https:/i.test(url)) return true;
  return !SCHEME.test(url) && !/^[\\/]{2}/.test(url);
};

/**
 * The config with only links the viewer can safely put in an href (the same
 * schemes as markdown links) and a font stylesheet only from https or the
 * site itself; anything else is dropped.
 */
const safeConfig = <C extends Partial<MapConfig>>(config: C): C => {
  const out: C = { ...config };
  if (config.links !== undefined)
    out.links = (Array.isArray(config.links) ? config.links : []).filter(
      (l) =>
        typeof l === "object" &&
        l !== null &&
        typeof l.url === "string" &&
        typeof l.label === "string" &&
        safeUrl(l.url),
    );
  const fonts = config.fonts;
  if (fonts !== undefined) {
    const sheet: unknown =
      typeof fonts === "object" && fonts !== null
        ? fonts.stylesheet
        : undefined;
    out.fonts = {
      ...(typeof fonts === "object" && fonts !== null ? fonts : {}),
      stylesheet:
        typeof sheet === "string" && safeStylesheet(sheet) ? sheet : undefined,
    };
  }
  return out;
};

const LOGO_TYPES = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".avif",
];

/**
 * The logo's path, checked: an image inside the map folder (after links are
 * resolved), or undefined when the config has none or the file is missing.
 * Anything else throws, so `"logo": "../.env"` can't publish another file.
 */
export const logoPath = (dir: string, logo: unknown): string | undefined => {
  if (logo === undefined || logo === "") return undefined;
  const bad = (why: string) =>
    new Error(
      `archmap.config.json: "logo" ${why}; use an image file (${LOGO_TYPES.join(" ")}) inside the map folder.`,
    );
  if (typeof logo !== "string") throw bad("must be a path");
  if (!LOGO_TYPES.includes(extname(logo).toLowerCase()))
    throw bad(`"${logo}" isn't an image`);
  const inside = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const path = resolve(dir, logo);
  if (isAbsolute(logo) || !inside(resolve(dir), path))
    throw bad(`"${logo}" is outside the map folder`);
  if (!existsSync(path)) return undefined;
  if (!inside(realpathSync(dir), realpathSync(path)))
    throw bad(`"${logo}" links outside the map folder`);
  if (!lstatSync(realpathSync(path)).isFile())
    throw bad(`"${logo}" isn't a file`);
  return path;
};

/** The logo's name in the site (`logo.png`), or undefined when it can't be used. */
const logoName = (dir: string, logo: unknown): string | undefined => {
  try {
    return logoPath(dir, logo) === undefined
      ? undefined
      : "logo" + extname(String(logo)).toLowerCase();
  } catch {
    return undefined;
  }
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
  opts: {
    dev?: boolean;
    public?: boolean;
    /** Latest release per package, from latestVersions. */
    latest?: Record<string, string>;
  } = {},
): string => {
  const { errors, warnings, map } = runCheck(root, dir);
  const libs: Record<string, LibInfo> = Object.fromEntries(
    Object.entries(libraryVersions(root, map.docs)).map(([id, v]) => {
      const latest: unknown = opts.latest
        ? Reflect.get(opts.latest, v.package)
        : undefined;
      return [
        id,
        typeof latest === "string"
          ? { ...v, latest, fresh: freshness(v.declared, latest) }
          : v,
      ];
    }),
  );
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
  const model = toViewModel(map.docs, libs, lanesOf(map.config));
  const body = {
    config: {
      ...safeConfig(opts.public ? publicConfig(map.config) : map.config),
      logo: logoName(dir, map.config.logo),
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

/** The registry packages the map's libraries use, for a latest-version lookup. */
const libraryPackages = (root: string, dir: string): string[] =>
  Object.values(libraryVersions(root, loadMap(dir).docs))
    .filter((v) => fromRegistry(v.declared))
    .map((v) => v.package);

export const build = async (
  root: string,
  dir: string,
  out: string,
  opts: {
    public?: boolean;
    offline?: boolean;
    fetch?: typeof fetch;
    cacheFile?: string;
  } = {},
): Promise<string[]> => {
  // Checked first, so a bad logo stops the build before anything is written.
  const logo = loadMap(dir).config.logo;
  const logoSrc = logoPath(dir, logo);
  const latest = await latestVersions(libraryPackages(root, dir), opts);
  mkdirSync(out, { recursive: true });
  STATIC.forEach((f) => copyFileSync(join(VIEWER, f), join(out, f)));
  writeFileSync(
    join(out, "data.json"),
    siteData(root, dir, { public: opts.public, latest }),
  );
  if (logoSrc)
    copyFileSync(logoSrc, join(out, "logo" + extname(logoSrc).toLowerCase()));
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
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

/**
 * A fingerprint of every file and folder under the map folder (the config is
 * one of them): count, total size and the newest change. Links aren't
 * followed. A folder's own time changes when a file is added or removed.
 */
const mapStamp = (dir: string): string => {
  let count = 0,
    size = 0,
    newest = 0;
  const walk = (folder: string) => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const n of names) {
      const path = join(folder, n);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      count += 1;
      size += st.size;
      newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
      if (st.isDirectory()) walk(path);
    }
  };
  try {
    newest = lstatSync(dir).mtimeMs;
  } catch {
    // A missing map folder still gives a stamp.
  }
  walk(dir);
  return `${count}:${size}:${newest}`;
};

/** How often dev rescans the code when the map hasn't changed. */
const RESCAN_MS = 10_000;

export const serve = (
  root: string,
  dir: string,
  port: number,
  opts: {
    offline?: boolean;
    fetch?: typeof fetch;
    /** Rebuild data.json at least this often (ms) for code changes; default 10s. */
    rescanMs?: number;
  } = {},
): Promise<Server> => {
  // The viewer asks for data.json every two seconds; it is rebuilt only when
  // a file under the map folder changed, or for the code scan at most every
  // rescanMs.
  const rescanMs = opts.rescanMs ?? RESCAN_MS;
  let last: { body: string; stamp: string; at: number } | undefined;
  const data = async (): Promise<string> => {
    const stamp = mapStamp(dir);
    const now = Date.now();
    if (last && last.stamp === stamp && now - last.at < rescanMs)
      return last.body;
    const latest = await latestVersions(libraryPackages(root, dir), opts);
    last = { body: siteData(root, dir, { dev: true, latest }), stamp, at: now };
    return last.body;
  };
  const server = createServer(async (req, res) => {
    const name = basename((req.url || "/").split("?")[0]) || "index.html";
    try {
      let body: string | Buffer;
      if (name === "data.json") body = await data();
      else if (STATIC.includes(name)) body = readFileSync(join(VIEWER, name));
      else if (name.startsWith("logo.")) {
        const logo = logoPath(dir, loadMap(dir).config.logo);
        if (!logo) {
          res.writeHead(404).end("Not found");
          return;
        }
        body = readFileSync(logo);
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
