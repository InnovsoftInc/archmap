// `archmap claude`: connects Claude Code to .archmap/ for this person only
// (local scope), so nothing is committed to the project's settings.

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { Result } from "./commands.ts";

export type Run = (
  cmd: string,
  args: string[],
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  missing?: boolean;
};

const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const missing =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(missing ? { missing: true } : {}),
  };
};

export const connectClaude = (
  projectRoot: string,
  opts: { run?: Run } = {},
): Result => {
  const run = opts.run ?? defaultRun;
  const add = [
    "plugin",
    "marketplace",
    "add",
    join(projectRoot, ".archmap"),
    "--scope",
    "local",
  ];
  const installPlugin = [
    "plugin",
    "install",
    "archmap@archmap",
    "--scope",
    "local",
  ];
  const addCmd = `claude ${add.join(" ")}`;
  const installCmd = `claude ${installPlugin.join(" ")}`;

  const removeHint = "claude plugin marketplace remove archmap";
  const target = join(projectRoot, ".archmap");

  // Read what is registered first (read-only), so we can tell "already this
  // project's .archmap/" from "an archmap from somewhere else".
  const listed = run("claude", ["plugin", "marketplace", "list", "--json"]);
  if (listed.missing)
    return {
      ok: true,
      lines: [
        "Claude Code isn't on your PATH. When it is, run these two commands:",
        `  ${addCmd}`,
        `  ${installCmd}`,
      ],
    };
  let existing: Record<string, unknown> | undefined;
  let listUsable = false;
  if (listed.status === 0) {
    try {
      const parsed: unknown = JSON.parse(listed.stdout);
      if (Array.isArray(parsed)) {
        listUsable = true;
        existing = (parsed as Record<string, unknown>[]).find(
          (m) => m?.name === "archmap",
        );
      }
    } catch {
      listUsable = false;
    }
  }

  let alreadyHere = false;
  // Claude Code keeps one machine-wide marketplace list, keyed by name,
  // whatever --scope says. So a second archmap project finds the first one's
  // .archmap/ already registered as "archmap". Removing it would disconnect
  // that project, so share it instead: each project's commands, skill and
  // hook still run that project's own .archmap/bin/archmap.mjs.
  let sharedFrom: string | undefined;
  if (listUsable && existing) {
    const path = existing.path;
    if (typeof path === "string" && resolve(path) === resolve(target))
      alreadyHere = true;
    else if (
      existing.source === "directory" &&
      typeof path === "string" &&
      /[\\/]\.archmap$/.test(resolve(path))
    )
      sharedFrom = resolve(path);
    else {
      const where = [
        existing.path,
        existing.repo,
        existing.url,
        existing.source,
      ].find((v) => typeof v === "string");
      return {
        ok: true,
        lines: [
          `Claude Code already has a marketplace named archmap, from another source (${String(where)}), so it was left alone.`,
          `To use this copy instead, run \`${removeHint}\`, then \`node .archmap/bin/archmap.mjs claude\` again.`,
        ],
      };
    }
  }

  if (!alreadyHere && !sharedFrom) {
    const added = run("claude", add);
    if (added.missing)
      return {
        ok: true,
        lines: [
          "Claude Code isn't on your PATH. When it is, run these two commands:",
          `  ${addCmd}`,
          `  ${installCmd}`,
        ],
      };
    if (added.status !== 0) {
      const message = `${added.stderr}${added.stdout}`.trim();
      if (/already/i.test(message))
        return {
          ok: true,
          lines: [
            "A marketplace named archmap is already registered with Claude Code.",
            `If it isn't this project's .archmap/, remove it with \`${removeHint}\`, then run \`node .archmap/bin/archmap.mjs claude\` again.`,
          ],
        };
      return {
        ok: false,
        lines: [
          `Could not add the archmap marketplace to Claude Code: ${message}`,
        ],
      };
    }
  }

  const installed = run("claude", installPlugin);
  const installMessage = `${installed.stderr}${installed.stdout}`.trim();
  if (
    installed.status !== 0 &&
    !((alreadyHere || sharedFrom) && /already/i.test(installMessage))
  )
    return {
      ok: false,
      lines: [
        `Could not install the archmap plugin in Claude Code: ${installMessage}`,
      ],
    };
  if (sharedFrom)
    return {
      ok: true,
      lines: [
        `Connected Claude Code to archmap (local scope, not committed). Claude Code keeps one archmap marketplace per machine, and it already points at another project's copy (${sharedFrom}), so this project's /archmap commands come from there.`,
        "Each project still runs its own .archmap/bin/archmap.mjs, so this project's map and version are its own.",
      ],
    };
  if (alreadyHere)
    return {
      ok: true,
      lines: ["Claude Code is already connected to .archmap/."],
    };
  return {
    ok: true,
    lines: ["Connected Claude Code to .archmap/ (local scope, not committed)."],
  };
};
