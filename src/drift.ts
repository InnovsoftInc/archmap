// archmap drift: which watched files changed on this branch with no new save?
// Advisory by default: it only fails when asked to (--strict).

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Result } from "./commands.ts";
import { loadProject } from "./project.ts";
import { matchWatch } from "./watch.ts";

export type DriftGroup = { means: string; layer: string; files: string[] };
export type Drift = {
  status: "no-baseline" | "no-watch" | "ok" | "uncovered" | "error";
  base?: string;
  groups: DriftGroup[];
  message: string;
};

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

const gitError = (err: unknown): string => {
  const e = err as Error & { stderr?: string };
  return `${e.message}${e.stderr ? `\n${e.stderr}` : ""}`.trim();
};

const defaultBranch = (root: string): string => {
  try {
    const ref = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
  } catch {
    return "main";
  }
};

export const drift = (dir: string, opts: { base?: string } = {}): Drift => {
  const none = (status: Drift["status"], message: string): Drift => ({
    status,
    groups: [],
    message,
  });
  let project;
  try {
    project = loadProject(dir);
  } catch (err) {
    return none("error", (err as Error).message);
  }
  if (!project.versions.length)
    return none("no-baseline", "No baseline yet: run /archmap:setup");
  const watch = project.config.watch;
  if (!watch?.length)
    return none(
      "no-watch",
      "No watch list: run `archmap scan --watch` and add it to archmap.config.json",
    );

  try {
    const root = realpathSync(
      git(dir, ["rev-parse", "--show-toplevel"]).trim(),
    );
    let base = opts.base;
    if (!base) {
      try {
        base = git(root, [
          "merge-base",
          "HEAD",
          `origin/${defaultBranch(root)}`,
        ]).trim();
      } catch {
        return none(
          "error",
          "Can't find the base to compare with (shallow clone or no remote). Pass --base.",
        );
      }
    }
    const changed = [
      ...new Set([
        ...lines(
          git(root, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]),
        ),
        ...lines(git(root, ["diff", "--name-only", "--no-renames", "HEAD"])),
        ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
      ]),
    ].sort();

    const mapDir = realpathSync(resolve(dir));
    const rel = relative(root, mapDir).split("\\").join("/");
    const savesPrefix = rel ? `${rel}/saves/` : "saves/";
    const hasSave = changed.some(
      (f) => f.startsWith(savesPrefix) && f.endsWith(".json"),
    );
    const trailer = /^Archmap:\s*none\b/im.test(
      git(root, ["log", `${base}..HEAD`, "--format=%B"]),
    );
    const short = git(root, ["rev-parse", "--short", base]).trim();
    if (hasSave || trailer)
      return {
        status: "ok",
        base: short,
        groups: [],
        message: hasSave
          ? "The map has a new save."
          : "A commit says the map needs no change.",
      };

    // Watch paths are relative to the project root, the folder `init` and
    // `scan --watch` ran in: the map folder's parent when it holds a
    // package.json (a package in a monorepo), otherwise the git top level.
    // git lists changes from the top level, so convert them and leave out
    // files outside the project.
    const parent = dirname(mapDir);
    const project = existsSync(join(parent, "package.json"))
      ? relative(root, parent).split("\\").join("/")
      : "";
    const inProject = project
      ? changed
          .filter((f) => f.startsWith(`${project}/`))
          .map((f) => f.slice(project.length + 1))
      : changed;
    const groups = matchWatch(inProject, watch).map(({ entry, files }) => ({
      means: entry.means,
      layer: entry.layer,
      files,
    }));
    if (!groups.length)
      return {
        status: "ok",
        base: short,
        groups,
        message: "No watched files changed.",
      };
    return {
      status: "uncovered",
      base: short,
      groups,
      message: `The architecture map may need updating (compared with ${short}).`,
    };
  } catch (err) {
    return none("error", `Can't compare with git: ${gitError(err)}`);
  }
};

const groupLine = (g: DriftGroup): string =>
  `${g.means} (${g.layer}): ${g.files.length} file${g.files.length === 1 ? "" : "s"}`;

export const driftCommand = (
  dir: string,
  opts: { base?: string; json?: boolean; strict?: boolean },
): Result => {
  const d = drift(dir, { base: opts.base });
  const ok = !(
    opts.strict &&
    (d.status === "uncovered" || d.status === "error")
  );
  const out: string[] = [];
  if (opts.json) out.push(JSON.stringify(d, null, 2));
  else if (d.status === "uncovered")
    out.push(
      `The architecture map may need updating (compared with ${d.base}):`,
      ...d.groups.flatMap((g) => [
        `  - ${groupLine(g)}`,
        ...g.files.map((f) => `      ${f}`),
      ]),
      'Record them with /archmap:update, or add the trailer "Archmap: none - <reason>" to a commit.',
    );
  else out.push(d.message);

  // A workflow command is one line, so its message escapes %, CR and LF.
  const escape = (text: string): string =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  if (process.env.GITHUB_ACTIONS === "true" && d.status === "error")
    out.push(`::warning title=Architecture map::${escape(d.message)}`);
  if (process.env.GITHUB_ACTIONS === "true" && d.status === "uncovered") {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      // A summary that can't be written must never fail the build.
      try {
        appendFileSync(
          summary,
          `### Architecture map\n\n${d.message}\n\n${d.groups.map((g) => `- ${groupLine(g)}`).join("\n")}\n`,
        );
      } catch {
        out.push("Couldn't write the job summary; the warnings are below.");
      }
    }
    for (const g of d.groups)
      out.push(
        `::warning title=Architecture map::${g.means}: ${g.files.length} files changed with no save`,
      );
  }
  return { ok, lines: out };
};
