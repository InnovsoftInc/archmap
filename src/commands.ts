// The CLI's commands, as functions that return what they did, so the tests can
// call them directly. cli.ts parses arguments and prints.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersions, layerReport, nextLayer, replay } from "./core.ts";
import {
  ensureDir,
  loadProject,
  projectProblems,
  saveId,
  slugify,
  writeJson,
  type Config,
} from "./project.ts";
import { scan } from "./scan/index.ts";
import { proposeWatch, stage } from "./scan/propose.ts";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(PACKAGE, "templates");
// The plugin's skill is the only copy; init gives projects without the plugin
// the same text.
const SKILL = join(PACKAGE, "plugin", "skills", "archmap", "SKILL.md");

export type Result = { ok: boolean; lines: string[] };

// Reads the repo's package.json before init writes anything, so a bad one can't
// leave init half-done. `write` adds the archmap scripts, keeping any the
// project already has.
type ScriptsPlan = { warning?: string; write?: () => boolean };
const planScripts = (root: string, dir: string): ScriptsPlan => {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  const skipped = (why: string): ScriptsPlan => ({
    warning: `Skipped the archmap scripts: package.json ${why}. Add them yourself if you want them.`,
  });
  let pkg: { scripts?: unknown };
  try {
    pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: unknown };
  } catch {
    return skipped("isn't valid JSON");
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg))
    return skipped("isn't a JSON object");
  const existing = pkg.scripts ?? {};
  if (
    typeof existing !== "object" ||
    existing === null ||
    Array.isArray(existing)
  )
    return skipped(`has a "scripts" entry that isn't an object`);
  const CLI = "node .archmap/bin/archmap.mjs";
  const rel = relative(resolve(root), resolve(dir));
  const flag = rel === "architecture" ? "" : ` --dir ${rel}`;
  const wanted: [string, string][] = [
    ["archmap", CLI],
    ["archmap:dev", `${CLI} dev${flag}`],
    ["archmap:check", `${CLI} check${flag}`],
    ["archmap:drift", `${CLI} drift${flag}`],
    ["archmap:claude", `${CLI} claude`],
  ];
  const scripts = new Map(Object.entries(existing as Record<string, string>));
  const before = scripts.size;
  for (const [name, cmd] of wanted)
    if (!scripts.has(name)) scripts.set(name, cmd);
  return {
    write: () => {
      if (scripts.size === before) return false;
      writeJson(file, { ...pkg, scripts: Object.fromEntries(scripts) });
      return true;
    },
  };
};

export const init = (
  dir: string,
  opts: {
    name?: string;
    repoRoot?: string;
    now?: Date;
    skill?: boolean;
  } = {},
): Result => {
  if (existsSync(join(dir, "archmap.config.json")))
    return { ok: false, lines: [`${dir} already has an architecture map.`] };
  const root = opts.repoRoot || ".";
  const scriptsPlan = planScripts(root, dir);
  ensureDir(join(dir, "saves"));
  const config: Config = {
    name: opts.name || "My platform",
    product: "Architecture map",
    labels: {
      boundary: opts.name || "Our platform",
      boundarySub: "what we build and run",
      outside: "Outside",
      outsideSub: "services and systems we use",
    },
    theme: {
      light: { "--accent": "#2d6cdf" },
      dark: { "--accent": "#6ea6ff" },
    },
    watch: proposeWatch(scan(root)),
  };
  writeJson(join(dir, "archmap.config.json"), config);
  writeJson(join(dir, "versions.json"), { versions: [] });
  copyFileSync(
    join(TEMPLATES, "instructions.md"),
    join(dir, "instructions.md"),
  );
  const starter = JSON.parse(
    readFileSync(join(TEMPLATES, "starter-save.json"), "utf8"),
  ) as Record<string, unknown>;
  const now = opts.now || new Date();
  starter.at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = saveId("starter categories", now);
  writeJson(join(dir, "saves", id + ".json"), starter);
  const lines = [`Created ${dir}/ with a starter save (${id}).`];
  const skill = join(root, ".claude", "skills", "archmap", "SKILL.md");
  if (opts.skill !== false && !existsSync(skill)) {
    ensureDir(dirname(skill));
    copyFileSync(SKILL, skill);
    lines.push(`Added the Claude skill at ${skill}.`);
  }
  if (scriptsPlan.write?.())
    lines.push("Added archmap scripts to package.json.");
  if (scriptsPlan.warning) lines.push(scriptsPlan.warning);
  lines.push(
    "Next: `archmap dev` to see it, then ask Claude to record your architecture.",
  );
  return { ok: true, lines };
};

export const check = (dir: string): Result => {
  const p = loadProject(dir);
  const problems = projectProblems(p);
  const vs = buildVersions(p.saves, p.versions);
  const summary = `${p.saves.length} saves · ${p.versions.length} published version${p.versions.length === 1 ? "" : "s"}${vs.some((v) => v.draft) ? " · draft pending" : ""}`;
  const model = replay(p.saves);
  const next = nextLayer(model);
  const layers = `Layers: ${layerReport(model)
    .map((l) => `${l.layer} ${l.count}`)
    .join(" · ")}${next ? `. Next: /archmap:setup ${next}` : "."}`;
  if (!problems.length) return { ok: true, lines: [`OK: ${summary}.`, layers] };
  return {
    ok: false,
    lines: [
      `${problems.length} problem${problems.length === 1 ? "" : "s"} (${summary}):`,
      ...problems.map((x) => "  - " + x),
      layers,
    ],
  };
};

export const newSave = (
  dir: string,
  opts: { summary: string; author?: string; now?: Date },
): Result => {
  loadProject(dir);
  const now = opts.now || new Date();
  const id = saveId(opts.summary, now);
  const path = join(dir, "saves", id + ".json");
  if (existsSync(path))
    return { ok: false, lines: [`${path} already exists.`] };
  ensureDir(join(dir, "saves"));
  writeJson(path, {
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    author: opts.author || "",
    summary: opts.summary,
    ops: [],
  });
  return {
    ok: true,
    lines: [`Created ${path}. Add its ops, then run \`archmap check\`.`],
  };
};

export const publish = (
  dir: string,
  name: string,
  opts: { summary?: string; now?: Date } = {},
): Result => {
  const p = loadProject(dir);
  const draft = buildVersions(p.saves, p.versions).find((v) => v.draft);
  if (!draft || !draft.draftIds?.length)
    return {
      ok: false,
      lines: ["Nothing to publish: every save is already in a version."],
    };
  const problems = projectProblems(p);
  if (problems.length)
    return {
      ok: false,
      lines: [
        "Fix these before publishing:",
        ...problems.map((x) => "  - " + x),
      ],
    };
  let id = slugify(name);
  const taken = new Set(p.versions.map((v) => v.id));
  for (let n = 2; taken.has(id); n++) id = slugify(name) + "-" + n;
  const now = opts.now || new Date();
  p.versions.push({
    id,
    name,
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    summary: opts.summary || "",
    saves: draft.draftIds,
  });
  writeJson(join(dir, "versions.json"), { versions: p.versions });
  snapshot(dir);
  return {
    ok: true,
    lines: [
      `Published ${name} with ${draft.draftIds.length} save${draft.draftIds.length === 1 ? "" : "s"}. Commit versions.json and current.json in a PR.`,
    ],
  };
};

/** Writes current.json: the latest state (published plus draft), so Claude and people can read it without replaying. */
export const snapshot = (dir: string): Result => {
  const p = loadProject(dir);
  const m = replay(p.saves);
  const vs = buildVersions(p.saves, p.versions);
  const latest = vs.filter((v) => !v.draft).slice(-1)[0];
  const draft = vs.find((v) => v.draft);
  const out = {
    note: "Generated by `archmap snapshot`. Don't edit: change the map by adding a save.",
    latest_published: latest ? latest.name : null,
    unpublished_saves: draft?.draftIds?.length || 0,
    ...m,
  };
  writeJson(join(dir, "current.json"), out);
  return { ok: true, lines: [`Wrote ${join(dir, "current.json")}.`] };
};

export const scanCommand = (
  root: string,
  opts: { watch?: boolean } = {},
): Result => {
  const s = scan(root);
  const out = opts.watch ? proposeWatch(s) : { ...s, stage: stage(s) };
  return { ok: true, lines: [JSON.stringify(out, null, 2)] };
};

export const resolveDir = (dir?: string): string =>
  resolve(dir || "architecture");
