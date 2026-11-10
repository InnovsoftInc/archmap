import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectClaude, type Run } from "../claude.ts";

const root = "/work/project";
const add = [
  "plugin",
  "marketplace",
  "add",
  join(root, ".archmap"),
  "--scope",
  "local",
];
const inst = ["plugin", "install", "archmap@archmap", "--scope", "local"];

const list = ["plugin", "marketplace", "list", "--json"];
const listing = (entry: object) => (args: string[]) =>
  args[2] === "list" ? { stdout: JSON.stringify([entry]) } : {};

const fake = (
  respond: (args: string[]) => Partial<ReturnType<Run>> = () => ({}),
) => {
  const calls: [string, string[]][] = [];
  const run: Run = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: "", stderr: "", ...respond(args) };
  };
  return { run, calls };
};

describe("connectClaude", () => {
  it("connects with local scope", () => {
    const { run, calls } = fake();
    const r = connectClaude(root, { run });
    expect(calls).toEqual([
      ["claude", list],
      ["claude", add],
      ["claude", inst],
    ]);
    expect(r.ok).toBe(true);
  });

  it("claude not on PATH prints the commands", () => {
    const { run } = fake(() => ({ status: null, missing: true }));
    const r = connectClaude(root, { run });
    expect(r.ok).toBe(true);
    expect(r.lines).toContain(`  claude ${add.join(" ")}`);
    expect(r.lines).toContain(`  claude ${inst.join(" ")}`);
  });

  it("an archmap marketplace from elsewhere is left alone", () => {
    const { run, calls } = fake(
      listing({ name: "archmap", source: "directory", path: "/elsewhere" }),
    );
    const r = connectClaude(root, { run });
    expect(calls).toEqual([["claude", list]]);
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("claude plugin marketplace remove archmap");
    expect(text).toContain("/elsewhere");
  });

  it("another project's .archmap/ marketplace is shared, not replaced", () => {
    const { run, calls } = fake(
      listing({
        name: "archmap",
        source: "directory",
        path: "/other/project/.archmap",
      }),
    );
    const r = connectClaude(root, { run });
    expect(calls).toEqual([
      ["claude", list],
      ["claude", inst],
    ]);
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("/other/project/.archmap");
    expect(text).toContain(".archmap/bin/archmap.mjs");
    expect(text).not.toContain("marketplace remove");
  });

  it("another project's .archmap/ with the plugin already installed here is fine", () => {
    const { run } = fake((args) =>
      args[2] === "list"
        ? {
            stdout: JSON.stringify([
              {
                name: "archmap",
                source: "directory",
                path: "/other/project/.archmap/",
              },
            ]),
          }
        : args[1] === "install"
          ? { status: 1, stderr: "Plugin archmap is already installed" }
          : {},
    );
    const r = connectClaude(root, { run });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("/other/project/.archmap");
  });

  it("another project's .archmap/ reports a failed install", () => {
    const { run } = fake((args) =>
      args[2] === "list"
        ? {
            stdout: JSON.stringify([
              {
                name: "archmap",
                source: "directory",
                path: "/other/project/.archmap",
              },
            ]),
          }
        : args[1] === "install"
          ? { status: 1, stderr: "boom" }
          : {},
    );
    const r = connectClaude(root, { run });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("boom");
  });

  it("an old node_modules archmap is still left alone", () => {
    const { run, calls } = fake(
      listing({
        name: "archmap",
        source: "directory",
        path: "/other/project/node_modules/@tttstudios/archmap",
      }),
    );
    const r = connectClaude(root, { run });
    expect(calls).toEqual([["claude", list]]);
    expect(r.lines.join("\n")).toContain(
      "claude plugin marketplace remove archmap",
    );
  });

  it("the same path is reported as connected, and the plugin is still installed", () => {
    const { run, calls } = fake(
      listing({
        name: "archmap",
        source: "directory",
        path: join(root, ".archmap"),
      }),
    );
    const r = connectClaude(root, { run });
    expect(calls).toEqual([
      ["claude", list],
      ["claude", inst],
    ]);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(["Claude Code is already connected to .archmap/."]);
  });

  it("a failed list falls back to add, and an 'already' reply is neutral", () => {
    const { run, calls } = fake((args) =>
      args[2] === "list"
        ? { status: 1, stderr: "nope" }
        : args[2] === "add"
          ? { status: 1, stderr: "Marketplace 'archmap' already exists" }
          : {},
    );
    const r = connectClaude(root, { run });
    expect(calls).toEqual([
      ["claude", list],
      ["claude", add],
    ]);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain(
      "claude plugin marketplace remove archmap",
    );
  });

  it("other failures are reported", () => {
    const { run } = fake((args) =>
      args[1] === "install" ? { status: 1, stderr: "boom" } : {},
    );
    const r = connectClaude(root, { run });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("boom");
  });
});
