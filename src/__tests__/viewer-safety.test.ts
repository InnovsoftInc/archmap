// The viewer's own guards on map data: CSS ids, header and stylesheet URLs, and
// the page's Content-Security-Policy. The viewer is a browser script with no
// exports, so its helpers are read from the source and run in a fresh context.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const VIEWER = join(import.meta.dirname, "..", "..", "viewer");
const app = readFileSync(join(VIEWER, "app.js"), "utf8");
const html = readFileSync(join(VIEWER, "index.html"), "utf8");

const fn = (name: string): string => {
  const start = app.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return app.slice(start, app.indexOf("\n}", start) + 2);
};

type Helpers = {
  zvar: (s: unknown) => string;
  lvar: (s: unknown) => string;
  safeHref: (s: unknown) => string | null;
  safeStylesheet: (s: unknown) => string | null;
  dict: () => Record<string, unknown>;
};
const helpers = runInNewContext(
  ["cssId", "zvar", "lvar", "safeHref", "safeStylesheet", "dict"]
    .map(fn)
    .join("\n") + "\n({ zvar, lvar, safeHref, safeStylesheet, dict });",
) as Helpers;

describe("viewer: map data in CSS and URLs", () => {
  it("keeps only [A-Za-z0-9_-] of an area or lane id in a CSS variable", () => {
    expect(helpers.zvar('x;}" onmouseover="alert(1)')).toBe(
      "var(--z-x____onmouseover__alert_1_, var(--z-records))",
    );
    expect(helpers.lvar("third_party")).toBe(
      "var(--l-third_party, var(--l-platform))",
    );
  });

  it("allows http, https, mailto and relative header links only", () => {
    expect(helpers.safeHref("https://example.com")).toBe("https://example.com");
    expect(helpers.safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(helpers.safeHref("docs/x.html")).toBe("docs/x.html");
    for (const bad of [
      "javascript:alert(1)",
      "java\tscript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "",
      42,
    ])
      expect(helpers.safeHref(bad)).toBeNull();
  });

  it("loads a font stylesheet only from https or this site", () => {
    expect(helpers.safeStylesheet("https://fonts.example/x.css")).toBe(
      "https://fonts.example/x.css",
    );
    expect(helpers.safeStylesheet("fonts.css")).toBe("fonts.css");
    for (const bad of [
      "http://fonts.example/x.css",
      "//fonts.example/x.css",
      "javascript:x",
    ])
      expect(helpers.safeStylesheet(bad)).toBeNull();
  });

  it("looks ids up in maps without a prototype", () => {
    const d = helpers.dict();
    expect(d.constructor).toBeUndefined();
    expect(d.toString).toBeUndefined();
  });
});

describe("viewer: index.html", () => {
  it("has a Content-Security-Policy that allows only its own scripts", () => {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
      html,
    )?.[1];
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    // No inline script for that policy to block.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it("announces only the drawer's title, not the whole drawer", () => {
    expect(html).not.toMatch(/id="panel"[^>]*aria-live/);
    expect(html).toMatch(/id="live"[^>]*aria-live="polite"/);
  });
});
