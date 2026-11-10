// `archmap upgrade`: finds newer releases of archmap and names the command to reinstall.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./commands.ts";
import { HOME_REPO } from "./home.ts";

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const parts = (v: string): number[] => v.split(".").map(Number);

// Compares versions part by part as numbers (0.10.0 is above 0.3.0).
const compare = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const remoteTags = (): string[] =>
  execFileSync(
    "git",
    ["ls-remote", "--tags", `https://github.com/${HOME_REPO}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
  )
    .split("\n")
    .map((line) => line.split("refs/tags/")[1]?.trim() ?? "")
    .filter((name) => TAG.test(name));

const installCommand = (version: string): string =>
  `npx -y github:${HOME_REPO}#v${version} install`;

export const upgradeInfo = (
  projectRoot: string,
  opts: { tags?: () => string[]; want?: string } = {},
): Result => {
  let tags: string[];
  try {
    tags = (opts.tags ?? remoteTags)().filter((t) => TAG.test(t));
  } catch {
    return {
      ok: false,
      lines: [`Couldn't read the releases of ${HOME_REPO} with git.`],
    };
  }
  const versions = tags
    .map((t) => t.slice(1))
    .sort(compare)
    .reverse();
  const target = opts.want?.replace(/^v/, "") ?? versions[0];
  if (opts.want && !versions.includes(target))
    return { ok: false, lines: [`No tag v${target} in ${HOME_REPO}.`] };
  if (!target)
    return { ok: false, lines: [`No releases found in ${HOME_REPO}.`] };

  const file = join(projectRoot, ".archmap", "VERSION");
  if (!existsSync(file))
    return {
      ok: false,
      lines: [
        "archmap isn't installed here (no .archmap/VERSION).",
        `Latest: ${versions[0] ?? target}`,
        `Run: ${installCommand(target)}`,
      ],
    };
  const installed = readFileSync(file, "utf8").trim();
  const lines = [`Installed: ${installed}`, `Latest: ${versions[0]}`];
  if (!opts.want && compare(installed, target) >= 0)
    return { ok: true, lines: [...lines, "archmap is up to date."] };
  return { ok: true, lines: [...lines, `Run: ${installCommand(target)}`] };
};
