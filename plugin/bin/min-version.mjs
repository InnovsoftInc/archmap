// Checks the archmap copy in the project (.archmap/VERSION), from the project
// root. Prints `ok`, `old <version>`, or
// `missing npx -y github:<owner/repo>#v<version> install` (or, from the plugin
// cache, `missing see the install instructions ...`).
// The plugin's commands call that copy, so they need at least this version.
// The repo and version come from the package this plugin ships in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM = "0.3.0";

// major.minor.patch as numbers, so 0.10.0 is newer than 0.9.0. Anything after
// the patch number (a prerelease tag) is ignored.
const parts = (version) =>
  String(version)
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);

const atLeast = (version, minimum) => {
  const b = parts(minimum);
  const diff = parts(version)
    .map((n, i) => n - (b.at(i) ?? 0))
    .find((d) => d !== 0);
  return (diff ?? 0) >= 0;
};

const installed = () => {
  try {
    return (
      readFileSync(join(".archmap", "VERSION"), "utf8").trim() || undefined
    );
  } catch {
    return undefined;
  }
};

// The install command for this plugin's own package, from its package.json.
// When the plugin runs from Claude Code's plugin cache there is no package
// above it, so point to the README's install instructions instead.
const installCommand = () => {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const repo = String(pkg.repository?.url ?? "")
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^https?:\/\/github\.com\//, "");
    return `npx -y github:${repo}#v${pkg.version} install`;
  } catch {
    return `see the install instructions under Quick start in ${readme()}`;
  }
};

const readme = () => {
  try {
    const file = fileURLToPath(
      new URL("../.claude-plugin/plugin.json", import.meta.url),
    );
    const repo = JSON.parse(readFileSync(file, "utf8")).repository;
    if (typeof repo === "string" && repo !== "") return `${repo}#quick-start`;
  } catch {
    // fall through
  }
  return "the archmap README";
};

const version = installed();
if (!version) console.log(`missing ${installCommand()}`);
else if (atLeast(version, MINIMUM)) console.log("ok");
else console.log(`old ${version}`);
