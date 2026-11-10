import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { init, publish } from "../commands.ts";
import { drift, driftCommand } from "../drift.ts";

let tmp: string;
let repo: string;
let origin: string;
const now = new Date("2026-11-20T18:04:00Z");

// git exports GIT_INDEX_FILE, GIT_DIR and friends to hooks; a test that
// inherited them would act on the real repo instead of its temp one.
const gitKeys = () =>
  Object.keys(process.env).filter((k) => k.startsWith("GIT_"));
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
// drift() runs git in this process, so it needs the clean env too.
const stubGitEnv = () => {
  for (const k of gitKeys()) vi.stubEnv(k, undefined);
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const write = (file: string, text = "x\n") => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};

// One git call. `-a` picks up edits and deletions of tracked files; pass
// `{ add: true }` when the commit also holds new files.
const commit = (message: string, opts: { add?: boolean } = {}) => {
  if (opts.add) git(repo, "add", "-A");
  git(repo, "commit", "-aqm", message);
};

const watch = [
  { paths: ["src/routes/**"], means: "API endpoints", layer: "parts" },
];

const templates = new Map<string, string>();
let templateRoot: string;

// A repo with a published map (map folder `mapDir`), pushed to a bare origin
// whose HEAD is set, on a feature branch ready for changes. The origin URL is
// relative so a copy of the folder needs no fix-up. `pkg/architecture` is a
// project in a subfolder of the repo (a monorepo package): its package.json
// and src/ are in pkg/.
const build = (root: string, mapDir: string) => {
  const r = join(root, "repo");
  const o = join(root, "origin.git");
  mkdirSync(r, { recursive: true });
  git(r, "init", "-qb", "main");
  git(r, "config", "user.name", "Test");
  git(r, "config", "user.email", "test@example.com");
  git(r, "config", "commit.gpgsign", "false");
  const project = mapDir.startsWith("pkg/") ? join(r, "pkg") : r;
  if (project !== r) {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"pkg"}\n');
  }
  const dir = join(r, mapDir);
  init(dir, { repoRoot: project, now, skill: false });
  const configPath = join(dir, "archmap.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as object;
  writeFileSync(configPath, JSON.stringify({ ...config, watch }));
  publish(dir, "Baseline", { now });
  mkdirSync(join(project, "src/routes"), { recursive: true });
  writeFileSync(join(project, "src/routes/a.ts"), "a\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "Baseline");
  git(root, "init", "-q", "--bare", "-b", "main", o);
  git(r, "remote", "add", "origin", "../origin.git");
  git(r, "push", "-qu", "origin", "main");
  git(r, "remote", "set-head", "origin", "main");
  git(r, "checkout", "-qb", "feature");
};

beforeAll(() => {
  stubGitEnv();
  templateRoot = mkdtempSync(join(import.meta.dirname, ".tmp-template-"));
  for (const mapDir of [
    "architecture",
    "docs/architecture",
    "pkg/architecture",
  ]) {
    const root = join(templateRoot, mapDir.replaceAll("/", "-"));
    build(root, mapDir);
    templates.set(mapDir, root);
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(templateRoot, { recursive: true, force: true });
});

// A private copy of the template, so no test sees another's changes.
const setup = (mapDir = "architecture", withWatch = true) => {
  tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  cpSync(templates.get(mapDir) as string, tmp, { recursive: true });
  repo = join(tmp, "repo");
  origin = join(tmp, "origin.git");
  const dir = join(repo, mapDir);
  if (!withWatch) {
    // An uncommitted edit to the config is enough: drift reads the working tree
    const configPath = join(dir, "archmap.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as object;
    writeFileSync(configPath, JSON.stringify({ ...config, watch: [] }));
  }
  return dir;
};

beforeEach(stubGitEnv);

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("drift", () => {
  it("no baseline is silent", () => {
    const dir = setup();
    writeFileSync(join(dir, "versions.json"), '{"versions":[]}');
    expect(drift(dir).status).toBe("no-baseline");
  });

  it("no watch list", () => {
    const dir = setup("architecture", false);
    const d = drift(dir);
    expect(d.status).toBe("no-watch");
    expect(d.message).toContain("archmap scan --watch");
  });

  it("uncovered route change is reported", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    const d = drift(dir);
    expect(d.status).toBe("uncovered");
    expect(d.groups).toEqual([
      { means: "API endpoints", layer: "parts", files: ["src/routes/a.ts"] },
    ]);
  });

  it("is ok when no watched file changed", () => {
    const dir = setup();
    write("README.md");
    commit("Docs", { add: true });
    expect(drift(dir).status).toBe("ok");
  });

  it("a new save covers it", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    write("architecture/saves/x.json", "{}");
    commit("Edit route and record it", { add: true });
    expect(drift(dir).status).toBe("ok");
  });

  it("the trailer covers it", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Fix typo\n\nArchmap: none - test only");
    expect(drift(dir).status).toBe("ok");
  });

  it("uncommitted and untracked files count", () => {
    const dir = setup();
    write("src/routes/a.ts", "edited, not committed\n");
    write("src/routes/new.ts", "untracked\n");
    const d = drift(dir);
    expect(d.status).toBe("uncovered");
    expect(d.groups[0].files).toEqual(["src/routes/a.ts", "src/routes/new.ts"]);
  });

  it("a deleted watched file counts", () => {
    const dir = setup();
    unlinkSync(join(repo, "src/routes/a.ts"));
    commit("Remove route");
    expect(drift(dir).groups[0].files).toEqual(["src/routes/a.ts"]);
  });

  it("a map in a nested folder is covered by its own saves", () => {
    const dir = setup("docs/architecture");
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    expect(drift(dir).status).toBe("uncovered");
    write("docs/architecture/saves/x.json", "{}");
    commit("Record it", { add: true });
    expect(drift(dir).status).toBe("ok");
  });

  it("a project in a subfolder matches paths relative to that project", () => {
    const dir = setup("pkg/architecture");
    write("pkg/src/routes/a.ts", "changed\n");
    // The same path outside the project is someone else's code.
    write("src/routes/b.ts", "not this project\n");
    commit("Edit route", { add: true });
    const d = drift(dir);
    expect(d.status).toBe("uncovered");
    expect(d.groups).toEqual([
      { means: "API endpoints", layer: "parts", files: ["src/routes/a.ts"] },
    ]);
    write("pkg/architecture/saves/x.json", "{}");
    commit("Record it", { add: true });
    expect(drift(dir).status).toBe("ok");
  });

  it("an explicit base is used", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    const d = drift(dir, { base: "HEAD" });
    expect(d.status).toBe("ok");
    expect(drift(dir, { base: "HEAD~1" }).status).toBe("uncovered");
  });

  it("a shallow clone with no base is an error but exits 0", () => {
    setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    git(repo, "push", "origin", "feature");
    const clone = join(tmp, "clone");
    git(
      tmp,
      "clone",
      "--depth",
      "1",
      "--branch",
      "feature",
      `file://${origin}`,
      clone,
    );
    const cloneDir = join(clone, "architecture");
    expect(drift(cloneDir).status).toBe("error");
    const lax = driftCommand(cloneDir, {});
    expect(lax.ok).toBe(true);
    expect(lax.lines.join("\n")).toContain("Pass --base.");
    expect(driftCommand(cloneDir, { strict: true }).ok).toBe(false);
  });
});

describe("driftCommand", () => {
  it("prints a readable list and fails only with --strict", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    const r = driftCommand(dir, {});
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toMatch(
      /^The architecture map may need updating \(compared with [0-9a-f]+\):$/,
    );
    expect(r.lines).toContain("  - API endpoints (parts): 1 file");
    expect(r.lines).toContain("      src/routes/a.ts");
    expect(r.lines.at(-1)).toContain('"Archmap: none - <reason>"');
    expect(driftCommand(dir, { strict: true }).ok).toBe(false);
  });

  it("prints JSON with --json", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    const r = driftCommand(dir, { json: true });
    expect(JSON.parse(r.lines[0])).toMatchObject({ status: "uncovered" });
  });

  it("writes a step summary and warnings in GitHub Actions", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    write("src/routes/b.ts", "new\n");
    commit("Edit routes", { add: true });
    const summary = join(tmp, "summary.md");
    writeFileSync(summary, "earlier\n");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    const r = driftCommand(dir, {});
    const text = readFileSync(summary, "utf8");
    expect(text.startsWith("earlier\n### Architecture map")).toBe(true);
    expect(text).toContain("- API endpoints (parts): 2 files");
    expect(r.lines).toContain(
      "::warning title=Architecture map::API endpoints: 2 files changed with no save",
    );
  });

  it("warns about an error in GitHub Actions and still exits 0", () => {
    const dir = setup();
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const r = driftCommand(dir, { base: "no-such-ref" });
    expect(r.ok).toBe(true);
    const warning = r.lines.find((l) => l.startsWith("::warning"));
    expect(warning).toMatch(
      /^::warning title=Architecture map::Can't compare with git: /,
    );
    // A workflow command is one line.
    expect(warning).not.toContain("\n");
  });

  it("an unwritable step summary never fails the command", () => {
    const dir = setup();
    write("src/routes/a.ts", "changed\n");
    commit("Edit route");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", tmp); // a directory, so appending fails
    const r = driftCommand(dir, {});
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("Couldn't write the job summary");
    expect(r.lines).toContain(
      "::warning title=Architecture map::API endpoints: 1 files changed with no save",
    );
  });
});
