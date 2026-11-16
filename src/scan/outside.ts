import { baseName, readEach, sortFacts } from "./walk.ts";
import type { Reader, Scan } from "./types.ts";

// A dependency whose name starts with the key means the project talks to this
// outside service.
const SDKS: [string, string][] = [
  ["@azure/", "Azure"],
  ["aws-sdk", "AWS"],
  ["@aws-sdk/", "AWS"],
  ["stripe", "Stripe"],
  ["@sendgrid/", "SendGrid"],
  ["twilio", "Twilio"],
  ["@sentry/", "Sentry"],
  ["openai", "OpenAI"],
  ["@anthropic-ai/", "Anthropic"],
];

const isEnvExample = (f: string) => {
  const name = baseName(f);
  return name.endsWith(".env.example") || name === ".env.sample";
};

export const readsOutside = (f: string): boolean =>
  isEnvExample(f) || baseName(f) === "package.json";

export const outsideReader: Reader = (root, files, cache) => {
  const outside: Scan["outside"] = [];
  const unreadable = readEach(
    root,
    files,
    readsOutside,
    (file, text) => {
      if (isEnvExample(file)) {
        for (const m of text.matchAll(/^\s*(?:export )?([A-Za-z_]\w*)\s*=/gm)) {
          outside.push({ file, name: m[1] ?? "", via: "env" });
        }
        return;
      }
      const manifest = JSON.parse(text) as {
        dependencies?: Record<string, string>;
      };
      const names = new Set<string>();
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        const sdk = SDKS.find(([prefix]) => dep.startsWith(prefix));
        if (sdk) names.add(sdk[1]);
      }
      for (const name of names) outside.push({ file, name, via: "sdk" });
    },
    cache,
  );
  // A broken package.json is reported once, by the apps reader.
  return {
    outside: sortFacts(outside, "name", "via"),
    unreadable: unreadable.filter((u) => !u.file.endsWith("package.json")),
  };
};
