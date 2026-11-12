import { describe, expect, it } from "vitest";
import { runCheck } from "../check.ts";
import { architecturalFiles, gateProblems } from "../gate.ts";
import {
  root,
  dir,
  write,
  config,
  commit,
  problem,
  useGateRepo,
} from "./gate-repo.ts";

useGateRepo();

describe("map gate: what covers a change", () => {
  it("passes when a map file changed, but not when only .no-change did", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    write("architecture/.no-change", "internal only\n");
    expect(problem()).toContain("evidence of services/api.md");
    write("architecture/services/api.md", "---\nname: API\n---\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
  });

  it("passes with an Archmap: none trailer in a commit since base", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - only a comment");
    expect(gateProblems(root, dir(), "HEAD~1")).toEqual([]);
  });

  it("does not let a trailer cover architectural changes made after it", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - only a comment");
    write("infra/main.tf", "x\n");
    commit("infra");
    expect(problem("HEAD~2")).toContain("infra/main.tf: structural file");
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map");
    expect(gateProblems(root, dir(), "HEAD~3")).toEqual([]);
  });

  it("does not let a map edit cover architectural changes made after it", () => {
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map");
    write("infra/main.tf", "x\n");
    commit("infra");
    expect(problem("HEAD~2")).toContain("infra/main.tf: structural file");
  });

  it("treats uncommitted architectural changes as the newest", () => {
    write("architecture/services/api.md", "---\nname: API\n---\n");
    commit("map\n\nArchmap: none - covered");
    write("infra/main.tf", "x\n");
    expect(problem("HEAD~1")).toContain("infra/main.tf: structural file");
    write("architecture/services/web.md", "---\nname: Web\n---\n");
    expect(gateProblems(root, dir(), "HEAD~1")).toEqual([]);
  });

  it("does not accept a trailer with no reason", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    commit("tweak\n\nArchmap: none - ");
    expect(problem("HEAD~1")).toContain("evidence of services/api.md");
  });

  it("ignores files matching agent.skip", () => {
    config({ agent: { skip: ["apps/api/**"] } });
    commit("config");
    write("apps/api/src/routes.ts", "// changed\n");
    expect(gateProblems(root, dir(), "HEAD")).toEqual([]);
    expect(architecturalFiles(root, dir(), "HEAD")).toEqual([]);
  });

  it("lists at most five files", () => {
    for (let i = 0; i < 7; i++) write(`infra/m${i}.tf`, "x\n");
    const msg = problem();
    expect(msg.match(/structural file/g)).toHaveLength(5);
    expect(msg).toContain("  …and 2 more");
  });

  it("check --base reports the gate as an error; check without --base doesn't run it", () => {
    write("apps/api/src/routes.ts", "// changed\n");
    const withBase = runCheck(root, dir(), { base: "HEAD" });
    expect(withBase.errors.map((e) => e.message).join("\n")).toContain(
      "This branch changes the architecture but not the map:",
    );
    const without = runCheck(root, dir());
    expect(without.errors.map((e) => e.message).join("\n")).not.toContain(
      "changes the architecture",
    );
  });
});
