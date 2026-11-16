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
    "%s template parses as YAML, pins node 24, has no literal secret, and only __CLI__/__DIR__/__VERSION__ placeholders",
    (name) => {
      const text = load(name);
      expect(() => parse(text)).not.toThrow();
      expect(text).toMatch(/\b24\b/);
      expect(text).not.toMatch(/sk-ant|ghp_|github_pat_/);
      const tokens = new Set(text.match(/__[A-Z]+__/g) ?? []);
      expect(
        [...tokens].every((t) =>
          ["__CLI__", "__DIR__", "__VERSION__"].includes(t),
        ),
      ).toBe(true);
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
    expect(push?.env).toMatchObject({
      PUSH_TOKEN: "${{ secrets.ARCHMAP_PUSH_TOKEN }}",
    });
    expect(String(push?.if)).toContain(
      "steps.commit.outputs.committed == 'true'",
    );
    expect(String(push?.run)).toContain('-n "$PUSH_TOKEN"');
    expect(String(push?.run)).toContain("::warning::");
    expect(String(push?.run)).toContain("pushed=true");
    const run = String(jobs.map.steps.find((s) => s.id === "commit")?.run);
    expect(run).toContain("No map change: ");
    expect(run).toContain("Archmap: none - ");
    expect(run).toContain("--allow-empty");
    expect(run).toContain("archmap: update map");
    expect(run).toContain("committed=$committed");
    const az = load("azure-pipelines");
    expect(az).toContain("Archmap: none - ");
    expect(az).toContain("ne(variables['System.PullRequest.IsFork'], 'True')");
  });

  it("keeps the push credential away from the agent", () => {
    const { jobs } = github();
    const checkout = jobs.map.steps.find((s) =>
      String(s.uses).startsWith("actions/checkout"),
    );
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    expect(JSON.stringify(checkout?.with)).not.toContain("ARCHMAP_PUSH_TOKEN");
    const push = String(jobs.map.steps.find((s) => s.id === "push")?.run);
    // The token is a header for the push alone, never in a URL or on the
    // command line, and the push goes to an explicit URL with hooks off.
    expect(push).toContain(
      'push "https://github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/${HEAD_REF}"',
    );
    expect(push).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"');
    expect(push).toContain("core.hooksPath=/dev/null");
    expect(push).toContain("credential.helper=");
    expect(push).not.toMatch(/:\$\{?PUSH_TOKEN\}?@/);
    const agent = jobs.map.steps.find((s) => String(s.run).includes(" agent "));
    expect(JSON.stringify(agent?.env)).not.toContain("PUSH_TOKEN");
    // Only the push step sees the token.
    const others = jobs.map.steps.filter((s) => s.id !== "push");
    expect(JSON.stringify(others)).not.toContain("PUSH_TOKEN");
    // The commit runs git with hooks off, after dropping config the agent
    // could have used to redirect the push or run a program, and only on the
    // commit the job checked out.
    const commit = String(jobs.map.steps.find((s) => s.id === "commit")?.run);
    expect(commit).toContain("git -c core.hooksPath=/dev/null");
    expect(commit).toContain("--unset-all");
    expect(commit).toMatch(/\^\(url\|include/);
    expect(commit).toContain('"$START"');
    expect(commit).toContain("g reset -q");
    expect(commit).not.toMatch(/^\s*git (add|commit|status)/m);

    const doc = parse(load("azure-pipelines")) as {
      stages: { jobs: { steps: Step[] }[] }[];
    };
    const steps = doc.stages[0]?.jobs[0]?.steps ?? [];
    expect(steps[0]).toMatchObject({
      checkout: "self",
      persistCredentials: false,
    });
    const azPush = steps.find((s) => s.name === "push");
    expect(String(azPush?.bash)).toContain(
      'GIT_CONFIG_VALUE_0="AUTHORIZATION: bearer $SYSTEM_ACCESSTOKEN"',
    );
    expect(String(azPush?.bash)).toContain('push "$REPO_URL"');
    expect(String(azPush?.bash)).toContain("core.hooksPath=/dev/null");
    expect(azPush?.env).toMatchObject({
      SYSTEM_ACCESSTOKEN: "$(System.AccessToken)",
      REPO_URL: "$(Build.Repository.Uri)",
    });
    const azCommit = steps.find((s) => s.displayName === "Commit the map");
    expect(String(azCommit?.bash)).toContain("git -c core.hooksPath=/dev/null");
    expect(String(azCommit?.bash)).toContain("--unset-all");
    expect(JSON.stringify(azCommit)).not.toContain("AccessToken");
    const azAgent = steps.find((s) => String(s.bash).includes(" agent "));
    expect(JSON.stringify(azAgent?.env)).not.toContain("AccessToken");
    // branch names reach bash through env, never macro-expanded into the script
    for (const s of steps)
      expect(String(s.bash ?? "")).not.toContain("$(System.PullRequest");
  });

  it("GitHub check job checks out the head sha, and the agent step fails when the agent does", () => {
    const { jobs } = github();
    const checkout = jobs.check.steps.find((s) =>
      String(s.uses).startsWith("actions/checkout"),
    );
    expect(checkout?.with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
    });
    const agent = jobs.map.steps.find((s) => String(s.run).includes(" agent "));
    expect(agent?.shell === "bash" || /pipefail/.test(String(agent?.run))).toBe(
      true,
    );
  });

  it("Azure scripts derive full branch names, stop on failure and only run after success", () => {
    const text = load("azure-pipelines");
    expect(text).not.toMatch(/SourceBranchName|TargetBranchName/);
    expect(text).toContain("System.PullRequest.SourceBranch)");
    expect(text).toContain("System.PullRequest.TargetBranch)");
    expect(text).toContain("#refs/heads/}");
    const doc = parse(text) as {
      stages: { jobs: { steps: Step[] }[] }[];
    };
    const steps = doc.stages.flatMap((st) => st.jobs.flatMap((j) => j.steps));
    const scripts = steps
      .map((step) => step.bash)
      .filter((b): b is string => typeof b === "string" && b.includes("\n"));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((b) => b.includes("set -euo pipefail"))).toBe(true);
    const mapSteps = (doc.stages[0]?.jobs[0]?.steps ?? []).filter(
      (s) => s.condition,
    );
    expect(mapSteps.length).toBeGreaterThan(0);
    for (const s of mapSteps)
      expect(String(s.condition)).toContain("succeeded()");
  });

  it.each(["github", "azure-pipelines"])(
    "%s reads the pinned archmap version from the config when it runs",
    (name) => {
      const text = load(name);
      expect(text).toContain('"$PWD/__DIR__/archmap.config.json" __VERSION__');
      expect(text).toMatch(/ARCHMAP_VERSION/);
      // validated, so the value can't inject env lines or shell words
      expect(text).toContain("^\\d+\\.\\d+\\.\\d+");
      // twice: the check job and the map job each read it
      expect(text.match(/Read the pinned archmap version/g)).toHaveLength(2);
    },
  );
});
