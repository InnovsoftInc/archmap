import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PACKAGE_ROOT } from "../home.ts";

const load = (name: string) =>
  readFileSync(
    join(PACKAGE_ROOT, "templates", "ci", name, "archmap-pr.yml"),
    "utf8",
  );
type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps: Step[] };
const github = () =>
  parse(load("github")) as {
    permissions: unknown;
    jobs: { check: Job; map: Job };
  };

describe("CI templates", () => {
  it.each(["github", "azure-pipelines"])(
    "%s template parses as YAML, pins node 24, has no literal secret, and only __CLI__/__DIR__ placeholders",
    (name) => {
      const text = load(name);
      expect(() => parse(text)).not.toThrow();
      expect(text).toMatch(/\b24\b/);
      expect(text).not.toMatch(/sk-ant|ghp_|github_pat_/);
      const tokens = new Set(text.match(/__[A-Z]+__/g) ?? []);
      expect([...tokens].every((t) => t === "__CLI__" || t === "__DIR__")).toBe(
        true,
      );
    },
  );

  it("GitHub map job has the fork guard, self-commit guard, continue-on-error and concurrency", () => {
    const { permissions, jobs } = github();
    expect(permissions).toEqual({ contents: "read" });
    const map = jobs.map;
    expect(map.if).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(map["continue-on-error"]).toBe(true);
    expect(map.permissions).toEqual({ contents: "write" });
    expect(map.concurrency).toEqual({
      group: "archmap-map-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    const guard = map.steps.find((s) => s.id === "guard");
    expect(String(guard?.run)).toContain("archmap: ");
    expect(String(guard?.run)).toContain("skip=true");
  });

  it("GitHub check job runs check --base after map, and skips when map pushed", () => {
    const { jobs } = github();
    expect(jobs.check.needs).toBe("map");
    expect(jobs.check.if).toBe(
      "always() && needs.map.outputs.pushed != 'true'",
    );
    expect(jobs.map.outputs).toEqual({
      pushed: "${{ steps.push.outputs.pushed }}",
    });
    const run = jobs.check.steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("check --base origin/${{ github.base_ref }}");
  });

  it("pushes only with ARCHMAP_PUSH_TOKEN and writes the Archmap: none trailer for a no-change decision", () => {
    const { jobs } = github();
    const push = jobs.map.steps.find((s) => s.id === "push");
    const run = String(push?.run);
    expect(push?.env).toMatchObject({
      PUSH_TOKEN: "${{ secrets.ARCHMAP_PUSH_TOKEN }}",
    });
    expect(run).toContain('-n "$PUSH_TOKEN"');
    expect(run).toContain("::warning::");
    expect(run).toContain("No map change: ");
    expect(run).toContain("Archmap: none - ");
    expect(run).toContain("--allow-empty");
    expect(run).toContain("archmap: update map");
    expect(run).toContain("pushed=true");
    const az = load("azure-pipelines");
    expect(az).toContain("Archmap: none - ");
    expect(az).toContain("ne(variables['System.PullRequest.IsFork'], 'True')");
    expect(az).toContain("persistCredentials: true");
  });
});
