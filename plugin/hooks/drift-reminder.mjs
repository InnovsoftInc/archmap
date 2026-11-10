// Stop hook: when Claude finishes a turn and watched files changed with no
// save recording them, block the stop once and ask for /archmap:update.
// It never loops (stop_hook_active), never repeats itself for the same files
// (a per-session list of what it already mentioned), and stays silent on any
// error, so it can never get in the way of ending a turn.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// One group of changed files, as a stable key: the means plus its sorted files.
export const groupKey = (group) =>
  `${group.means}|${[...group.files].sort().join(",")}`;

// Decides whether to block the stop. `seen` holds the group keys already
// mentioned this session; the returned `seen` includes any new ones.
export const decide = (input, drift, seen) => {
  if (input.stop_hook_active || !drift || drift.status !== "uncovered") {
    return { output: null, seen };
  }
  const fresh = drift.groups.filter((g) => !seen.includes(groupKey(g)));
  if (fresh.length === 0) return { output: null, seen };
  const what = fresh.map((g) => `${g.means} (${g.files.length} files)`);
  return {
    output: {
      decision: "block",
      reason: `These changes may need the architecture map updated: ${what.join(", ")}. Run /archmap:update to record them, or say why no map change is needed and suggest the commit trailer 'Archmap: none - <reason>'.`,
    },
    seen: [...seen, ...fresh.map(groupKey)],
  };
};

const CONFIG = "archmap.config.json";
const hasMap = (cwd, dir) => existsSync(join(cwd, dir, CONFIG));

// The `--dir` in the project's archmap:drift script, if it has one.
const scriptDir = (cwd) => {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const script = pkg?.scripts?.["archmap:drift"];
    const m = /--dir[\s=]+(["']?)([^"'\s]+)\1/.exec(String(script ?? ""));
    return m ? m[2] : null;
  } catch {
    return null;
  }
};

// Folders one and two levels down that hold a map, in a stable order.
// node_modules and hidden folders hold no project map.
const searchDir = (cwd) => {
  const children = (dir) => {
    try {
      return readdirSync(join(cwd, dir), { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            e.name !== "node_modules" &&
            !e.name.startsWith("."),
        )
        .map((e) => (dir ? `${dir}/${e.name}` : e.name))
        .sort();
    } catch {
      return [];
    }
  };
  const first = children("");
  return (
    first.find((d) => hasMap(cwd, d)) ??
    first.flatMap(children).find((d) => hasMap(cwd, d)) ??
    null
  );
};

// The map folder, relative to cwd: architecture/ when it holds the config,
// then the --dir of the archmap:drift script, then a search one or two levels
// down. null when there's no map.
export const findMapDir = (cwd) => {
  if (hasMap(cwd, "architecture")) return "architecture";
  const fromScript = scriptDir(cwd);
  if (fromScript && hasMap(cwd, fromScript)) return fromScript;
  return searchDir(cwd);
};

const readSeen = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const main = () => {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const cwd = input.cwd || process.cwd();
    const cli = join(cwd, ".archmap", "bin", "archmap.mjs");
    if (!existsSync(cli)) return;
    const dir = findMapDir(cwd);
    if (!dir) return;
    const file = join(tmpdir(), `archmap-hook-${input.session_id}.json`);
    const seen = readSeen(file);
    let drift = null;
    if (!input.stop_hook_active) {
      const out = execFileSync(
        process.execPath,
        [cli, "drift", "--json", "--dir", dir],
        {
          cwd,
          encoding: "utf8",
          timeout: 9000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      drift = JSON.parse(out);
    }
    const result = decide(input, drift, seen);
    writeFileSync(file, JSON.stringify(result.seen));
    if (result.output) console.log(JSON.stringify(result.output));
  } catch (error) {
    console.error(`archmap hook skipped: ${error?.message ?? error}`);
  }
};

// Node resolves symlinks in the module URL but not in argv[1], so compare
// real paths; otherwise a symlinked plugin folder would never run main().
const runDirectly = () => {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (runDirectly()) main();
