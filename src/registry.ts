// The latest version of each library, from the npm registry. Only `dev` and
// `build` ask; `check` and the gate never use the network. Only package names
// are sent. Answers are cached for a day, a slow or failed lookup is skipped,
// and `--offline` asks nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cache = Record<string, { v: string; at: number }>;

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE = join(tmpdir(), "archmap-registry-cache.json");

const readCache = (file: string): Cache => {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof c === "object" && c !== null ? (c as Cache) : {};
  } catch {
    return {};
  }
};

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
  const file = opts.cacheFile ?? DEFAULT_CACHE;
  const now = opts.now ?? Date.now();
  const cache = new Map(Object.entries(readCache(file)));
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const p of new Set(packages)) {
    const hit = cache.get(p);
    if (hit && now - hit.at < DAY) out.set(p, hit.v);
    else missing.push(p);
  }
  if (opts.offline || missing.length === 0) return Object.fromEntries(out);
  const get = opts.fetch ?? fetch;
  const registry = opts.registry ?? "https://registry.npmjs.org";
  await Promise.all(
    missing.map(async (p) => {
      try {
        // A scoped name keeps its @ but its / is escaped.
        const res = await get(
          `${registry}/${p.replace("/", "%2f")}/latest`,
          { signal: AbortSignal.timeout(4000) },
        );
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
    writeFileSync(file, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // A cache that can't be written only costs a lookup next time.
  }
  return Object.fromEntries(out);
};
