// Which archmap runs the map's commands, and whether the map pins another one.

import { relative, resolve } from "node:path";
import { HOME_REPO, VERSION } from "./home.ts";
import type { MapConfig } from "./map/types.ts";

/** The command that runs archmap for this map: `cli` from the config, or npx at the version the config pins (this one when unpinned). */
export const cliCommand = (
  config: MapConfig,
  dir: string,
  root: string,
): string => {
  const base =
    config.cli ?? `npx -y github:${HOME_REPO}#v${config.archmap ?? VERSION}`;
  const rel = relative(resolve(root), resolve(root, dir));
  return rel === "architecture" ? base : `${base} --dir ${rel || "."}`;
};

export const versionWarning = (config: MapConfig): string | null =>
  config.archmap && config.archmap !== VERSION
    ? `archmap.config.json pins ${config.archmap}; this is ${VERSION}`
    : null;
