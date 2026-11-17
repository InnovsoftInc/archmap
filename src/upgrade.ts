// Keeping a project on the latest archmap: finding the newest release, saying
// so, and `archmap upgrade`, which moves the map's pin and refreshes what init
// wrote. A map with `"upgrade": "auto"` upgrades itself when a person or their
// agent runs `dev` or `brief`; CI never does, so a pull request's check is
// decided by the version the repo pins.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { HOME_REPO, VERSION } from "./home.ts";
import type { MapConfig, Result } from "./map/types.ts";
import { defaultCacheFile } from "./registry.ts";

const DAY = 24 * 60 * 60 * 1000;
const RELEASE = /^\d+\.\d+\.\d+$/;

const parts = (v: string): number[] => v.split(".").map(Number);

/** Whether release `a` is later than release `b`. */
export const newer = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x.at(i) ?? 0) - (y.at(i) ?? 0);
    if (d) return d > 0;
  }
  return false;
};

/** The highest `vX.Y.Z` tag in `git ls-remote --tags` output, or null. */
export const highestTag = (lsRemote: string): string | null => {
  let best: string | null = null;
  for (const line of lsRemote.split("\n")) {
    const v = /refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim())?.[1];
    if (v && (best === null || newer(v, best))) best = v;
  }
  return best;
};

// Asks the home repo for its tags, the way npx fetches archmap from it. Never
// prompts for a password, and gives up after a few seconds.
const askRemote = (): string =>
  execFileSync(
    "git",
    ["ls-remote", "--tags", "--refs", `https://github.com/${HOME_REPO}.git`, "v*"],
    {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );

type Lookup = {
  env?: NodeJS.ProcessEnv;
  now?: number;
  cacheFile?: string;
  ask?: () => string;
  /** Skip the cached answer: `upgrade` wants what is there now. */
  fresh?: boolean;
};

/**
 * The newest archmap release, or null when it can't be told: offline, in CI
 * (which runs the pinned version and nothing else), or with
 * ARCHMAP_NO_UPDATE_CHECK set. The answer is kept for a day.
 */
export const latestRelease = (opts: Lookup = {}): string | null => {
  const env = opts.env ?? process.env;
  if (env.CI || env.ARCHMAP_NO_UPDATE_CHECK) return null;
  const now = opts.now ?? Date.now();
  const file =
    opts.cacheFile ?? join(dirname(defaultCacheFile(env)), "release.json");
  if (!opts.fresh)
    try {
      const hit = JSON.parse(readFileSync(file, "utf8")) as {
        v?: unknown;
        at?: unknown;
      };
      if (
        typeof hit.at === "number" &&
        now - hit.at < DAY &&
        now >= hit.at &&
        (hit.v === null || (typeof hit.v === "string" && RELEASE.test(hit.v)))
      )
        return hit.v;
    } catch {
      // No usable cache: ask.
    }
  let v: string | null;
  try {
    v = highestTag((opts.ask ?? askRemote)());
  } catch {
    v = null;
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ v, at: now }), { mode: 0o600 });
  } catch {
    // A cache that can't be written only costs a lookup next time.
  }
  return v;
};

/** The version this map runs: its pin, else this copy's. */
const pinned = (config: MapConfig): string =>
  config.archmap && RELEASE.test(config.archmap) ? config.archmap : VERSION;

/**
 * The release this map could move to, or null: it is on the latest, the latest
 * isn't known, or it runs archmap through its own `cli`, which archmap doesn't
 * upgrade.
 */
export const available = (
  config: MapConfig,
  latest: string | null,
): string | null =>
  !config.cli && latest && newer(latest, pinned(config)) ? latest : null;

/** npx running archmap at `version`. */
export const npxArgs = (version: string): string[] => [
  "-y",
  `github:${HOME_REPO}#v${version}`,
];

export const upgradeCommand = (version: string, dir: string, root: string) => {
  const rel = relative(root, dir) || ".";
  return `npx ${npxArgs(version).join(" ")}${rel === "architecture" ? "" : ` --dir ${rel}`} upgrade`;
};

export const notice = (
  config: MapConfig,
  next: string,
  dir: string,
  root: string,
): string =>
  `archmap ${next} is available (this map uses ${pinned(config)}). To move to it: ${upgradeCommand(next, dir, root)}`;

/**
 * Moves the map to `latest`: sets the pin in archmap.config.json, then runs
 * that version's `init`, which refreshes the start script, the README and
 * AGENTS.md sections and, where the project has it, the Claude skill. If init
 * fails the pin is put back.
 */
export const upgrade = (
  root: string,
  dir: string,
  latest: string | null,
  run: (args: string[]) => string = (args) =>
    execFileSync("npx", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
): Result => {
  const file = join(dir, "archmap.config.json");
  if (!existsSync(file))
    return {
      ok: false,
      lines: ["There is no map here yet. Run `init` first."],
    };
  const before = readFileSync(file, "utf8");
  let config: MapConfig;
  try {
    config = JSON.parse(before) as MapConfig;
  } catch {
    return {
      ok: false,
      lines: ["archmap.config.json isn't valid JSON; fix it first."],
    };
  }
  if (config.cli)
    return {
      ok: false,
      lines: [
        `This map runs archmap through its own command (\`cli\`: ${config.cli}). Upgrade that command; archmap can't do it for you.`,
      ],
    };
  if (!latest)
    return {
      ok: false,
      lines: [
        "Couldn't find archmap's releases. Check the network and that git can reach GitHub, then try again.",
      ],
    };
  const from = pinned(config);
  if (!newer(latest, from))
    return { ok: true, lines: [`Already on the latest archmap (${from}).`] };
  writeFileSync(
    file,
    `${JSON.stringify({ ...config, archmap: latest }, null, 2)}\n`,
  );
  const rel = relative(root, dir) || ".";
  const skill = existsSync(
    join(root, ".claude", "skills", "archmap", "SKILL.md"),
  );
  let out: string;
  try {
    out = run([
      ...npxArgs(latest),
      "init",
      "--dir",
      rel,
      ...(skill ? ["--claude"] : []),
    ]);
  } catch (err) {
    writeFileSync(file, before);
    return {
      ok: false,
      lines: [
        `Couldn't run archmap ${latest}, so the map stays on ${from}: ${(err as Error).message.split("\n")[0] ?? ""}`,
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `Upgraded archmap ${from} to ${latest}.`,
      ...out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^(Added|Updated|Wrote|Set|Replaced)\b/.test(l))
        .map((l) => `  ${l}`),
      "Commit these changes so everyone, and CI, moves to it too.",
    ],
  };
};
