// Which archmap runs the map's commands, and whether the map pins another one.

import { relative, resolve } from "node:path";
import { HOME_REPO, VERSION } from "./home.ts";
import type { MapConfig } from "./map/types.ts";

/** npx running archmap at `version` from its home repo. */
const npxAt = (version: string): string =>
  `npx -y github:${HOME_REPO}#v${version}`;

const withDir = (base: string, dir: string, root: string): string => {
  const rel = relative(resolve(root), resolve(root, dir));
  return rel === "architecture" ? base : `${base} --dir ${rel || "."}`;
};

/** The command that runs archmap for this map: `cli` from the config, or npx at the version the config pins (this one when unpinned). */
export const cliCommand = (
  config: MapConfig,
  dir: string,
  root: string,
): string => withDir(config.cli ?? npxAt(config.archmap ?? VERSION), dir, root);

/**
 * The command the CI workflow runs: `cli` from the config, or npx at
 * `$ARCHMAP_VERSION`, which the workflow reads from archmap.config.json when it
 * runs, so changing the pin upgrades CI without running init again.
 */
export const ciCommand = (
  config: MapConfig,
  dir: string,
  root: string,
): string => withDir(config.cli ?? npxAt("${ARCHMAP_VERSION}"), dir, root);

export const versionWarning = (config: MapConfig): string | null =>
  config.archmap && config.archmap !== VERSION
    ? `archmap.config.json pins ${config.archmap}; this is ${VERSION}`
    : null;
