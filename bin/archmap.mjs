#!/usr/bin/env node
// The installed `archmap` command. The CLI is TypeScript run without a build
// step, but Node refuses to strip types from files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is where an installed
// package lives. So this plain-JavaScript entry point strips the types of this
// package's own .ts files itself, then loads the CLI.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Type stripping and module hooks are still flagged experimental; keep their
// warnings out of the CLI's output. Set before either is used.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w.message);
});

// Only this package's files: anything else is left to Node as usual.
const PACKAGE = new URL("../", import.meta.url).href;

registerHooks({
  load: (url, context, nextLoad) => {
    if (!url.startsWith(PACKAGE) || !url.endsWith(".ts"))
      return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "strip" }),
      shortCircuit: true,
    };
  },
});

await import("../src/cli.ts");
