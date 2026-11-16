// The latest version of each library, from the npm registry. Only `dev` and
// `build` ask; `check` and the gate never use the network. Only package names
// are sent, and only for dependencies that come from the registry (not
// `workspace:`, `file:`, `link:`, `portal:`, `npm:` aliases, git or URL specs). Answers,
// including "not found", are cached for a day in the user's cache folder, a
// slow or failed lookup is skipped, and `--offline` asks nothing.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

/** `v` is the latest version, or null when the registry has no such package. */
type Cache = Record<string, { v: string | null; at: number }>;

const DAY = 24 * 60 * 60 * 1000;

/** `$XDG_CACHE_HOME/archmap/registry.json`, else `~/.cache/archmap/registry.json`. */
export const defaultCacheFile = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "archmap", "registry.json");
};

/** A range the registry can answer for; local, linked and git dependencies aren't sent. */
export const fromRegistry = (range: string): boolean => {
  const r = range.trim();
  if (
    /^(workspace|file|link|portal|npm|git|git\+[a-z]+|https?|github|gitlab|bitbucket|gist):/i.test(
      r,
    )
  )
    return false;
  // A path, or a GitHub shorthand like `user/repo` or `user/repo#tag`.
  if (/^(?:\.\.?\/|\/|~\/)/.test(r) || /^[^@\s]+\/[^\s]+$/.test(r))
    return false;
  return true;
};

const readCache = (file: string): Cache => {
  try {
    // Never read through a link someone else put there.
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) return {};
      const c = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      return typeof c === "object" && c !== null && !Array.isArray(c)
        ? (c as Cache)
        : {};
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
};

/** Writes the cache to a private folder: a new file renamed over the old one, so a link is replaced, not followed. */
const writeCache = (file: string, cache: Cache): void => {
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (lstatSync(folder).isSymbolicLink()) return;
  const tmp = join(folder, `.registry-${randomBytes(6).toString("hex")}.tmp`);
  try {
    // `wx` fails rather than follow a link or reuse a file at that name.
    writeFileSync(tmp, JSON.stringify(cache), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
};

const cached = (
  hit: Cache[string] | undefined,
  now: number,
): hit is Cache[string] =>
  !!hit &&
  typeof hit.at === "number" &&
  (typeof hit.v === "string" || hit.v === null) &&
  now - hit.at < DAY;

export const latestVersions = async (
  packages: string[],
  opts: {
    offline?: boolean;
    fetch?: typeof fetch;
    cacheFile?: string;
    now?: number;
    registry?: string;
  } = {},
): Promise<Record<string, string>> => {
  const file = opts.cacheFile ?? defaultCacheFile();
  const now = opts.now ?? Date.now();
  const cache = new Map(Object.entries(readCache(file)));
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const p of new Set(packages)) {
    const hit = cache.get(p);
    if (cached(hit, now)) {
      if (hit.v !== null) out.set(p, hit.v);
    } else missing.push(p);
  }
  if (opts.offline || missing.length === 0) return Object.fromEntries(out);
  const get = opts.fetch ?? fetch;
  const registry = opts.registry ?? "https://registry.npmjs.org";
  await Promise.all(
    missing.map(async (p) => {
      try {
        // A scoped name keeps its @ but its / is escaped.
        const res = await get(`${registry}/${p.replace("/", "%2f")}/latest`, {
          signal: AbortSignal.timeout(4000),
        });
        // Not found is an answer too: don't ask again until it expires.
        if (res.status === 404) {
          cache.set(p, { v: null, at: now });
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version !== "string") return;
        out.set(p, body.version);
        cache.set(p, { v: body.version, at: now });
      } catch {
        // Offline, slow or unknown: show the version without a badge.
      }
    }),
  );
  try {
    writeCache(file, Object.fromEntries(cache));
  } catch {
    // A cache that can't be written only costs a lookup next time.
  }
  return Object.fromEntries(out);
};
