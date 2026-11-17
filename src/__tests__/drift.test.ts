import { describe, expect, it } from "vitest";
import { runCheck } from "../check.ts";
import { pathParams } from "../drift.ts";
import { root, dir, write, commit, git, useGateRepo } from "./gate-repo.ts";

useGateRepo();

const BODY = "Serves requests.\n\n## How it works\n\nx\n\n## For developers\n\nx\n";
const api = (endpoints: string) =>
  write(
    "architecture/services/api.md",
    `---\nname: API\nstatus: live\nkind: api\nendpoints:\n${endpoints}---\n${BODY}`,
  );
const HEALTH = "  - route: GET /health\n    evidence: apps/api/src/routes.ts\n";
const check = () => runCheck(root, dir(), { base: "HEAD" });
const messages = (list: { message: string }[]) => list.map((f) => f.message);

describe("pathParams", () => {
  it("reads the names in a route's path, however the framework writes them", () => {
    expect(pathParams("GET /users/:id/posts/:postId")).toEqual(["id", "postId"]);
    expect(pathParams("GET /users/{id}")).toEqual(["id"]);
    expect(pathParams("GET /users/[id]")).toEqual(["id"]);
    expect(pathParams("GET /users/:id?")).toEqual(["id"]);
    expect(pathParams("GET /health")).toEqual([]);
  });
});

describe("undocumented endpoints", () => {
  it("warns once per doc about endpoints already on the map, and never fails them", () => {
    const r = runCheck(root, dir());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContainEqual({
      file: "services/api.md",
      message:
        "1 of 1 endpoints aren't documented (no `does`, or a path parameter missing from `params`): GET /health",
    });
    api(
      "  - route: GET /health\n    does: Says the API is up.\n    evidence: apps/api/src/routes.ts\n",
    );
    expect(messages(runCheck(root, dir()).warnings).join("\n")).not.toContain(
      "aren't documented",
    );
  });
});

describe("new endpoints", () => {
  it("fails one added without does, or without a params entry for a name in its path", () => {
    api(
      `${HEALTH}  - route: GET /users/:id\n    evidence: apps/api/src/routes.ts\n`,
    );
    expect(check().errors).toContainEqual({
      file: "services/api.md",
      message:
        "endpoints[1] GET /users/:id is new and needs `does` and a `params` entry for `id`",
    });
    api(
      `${HEALTH}  - route: GET /users/:id\n    does: Returns one user.\n    evidence: apps/api/src/routes.ts\n`,
    );
    expect(messages(check().errors)).toEqual([
      "endpoints[1] GET /users/:id is new and needs a `params` entry for `id`",
    ]);
    api(
      `${HEALTH}  - route: GET /users/:id\n    does: Returns one user.\n    params:\n      - name: id\n        in: path\n    evidence: apps/api/src/routes.ts\n`,
    );
    // The old, undocumented endpoint is still only a warning.
    expect(check().errors).toEqual([]);
  });

  it("doesn't hold a first map to it, or a check without a base", () => {
    api(
      `${HEALTH}  - route: GET /users/:id\n    evidence: apps/api/src/routes.ts\n`,
    );
    expect(runCheck(root, dir()).errors).toEqual([]);
    git("rm", "-q", "--cached", "-r", "architecture/services");
    commit("no map yet");
    expect(check().errors).toEqual([]);
  });
});

describe("stale entries", () => {
  it("warns when the cited file changed and the entry didn't, until the entry is corrected", () => {
    expect(messages(check().warnings).join("\n")).not.toContain("out of date");
    write(
      "apps/api/src/routes.ts",
      'import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.json({ ok: true }));\n',
    );
    expect(check().warnings).toContainEqual({
      file: "services/api.md",
      message:
        "endpoints[0] GET /health may be out of date: apps/api/src/routes.ts changed on this branch and this entry didn't. Re-read the code and correct the entry.",
    });
    api(
      "  - route: GET /health\n    does: Says the API is up.\n    returns: '{ ok: true }'\n    evidence: apps/api/src/routes.ts\n",
    );
    expect(messages(check().warnings).join("\n")).not.toContain("out of date");
  });

  it("flags only the entries whose symbol is in the code that changed", () => {
    const handlers = (removeBody: string) =>
      `export const create = (req, res) => {\n  res.status(201).json(req.body);\n};\n\n\n\n\n\n\n\n\nexport const remove = (req, res) => {\n  ${removeBody}\n};\n`;
    write("apps/api/src/users.ts", handlers("res.status(204).end();"));
    api(
      `${HEALTH}  - route: POST /users\n    does: Creates a user.\n    evidence: apps/api/src/users.ts#create\n  - route: DELETE /users\n    does: Removes users.\n    evidence: apps/api/src/users.ts#remove\n`,
    );
    commit("users");
    write("apps/api/src/users.ts", handlers("res.status(200).json({ removed: true });"));
    const stale = messages(check().warnings).filter((m) =>
      m.includes("out of date"),
    );
    expect(stale).toEqual([
      "endpoints[2] DELETE /users may be out of date: apps/api/src/users.ts changed on this branch around remove and this entry didn't. Re-read the code and correct the entry.",
    ]);
  });
});
