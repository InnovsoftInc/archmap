import { execFileSync } from "node:child_process";
import {
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { decide, findMapDir } from "../../plugin/hooks/drift-reminder.mjs";

const pkgRoot = join(import.meta.dirname, "..", "..");

const input = { session_id: "s1" };
const group = (files: string[]) => ({
  means: "API endpoints",
  layer: "parts",
  files,
});
const uncovered = (files = ["src/routes/a.ts"]) => ({
  status: "uncovered" as const,
  groups: [group(files)],
  message: "",
});

describe("decide", () => {
  it("is silent when the stop was already blocked once", () => {
    const r = decide({ ...input, stop_hook_active: true }, uncovered(), []);
    expect(r).toEqual({ output: null, seen: [] });
  });

  it("is silent when there is no drift result", () => {
    expect(decide(input, null, []).output).toBeNull();
  });

  it.each(["ok", "no-baseline", "no-watch", "error"] as const)(
    "is silent on %s",
    (status) => {
      const drift = { status, groups: [], message: "" };
      expect(decide(input, drift, []).output).toBeNull();
    },
  );

  it("blocks on uncovered changes with the exact reason", () => {
    const r = decide(input, uncovered(), []);
    expect(r.output).toEqual({
      decision: "block",
      reason:
        "These changes may need the architecture map updated: API endpoints (1 files). Run /archmap:update to record them, or say why no map change is needed and suggest the commit trailer 'Archmap: none - <reason>'.",
    });
    expect(r.seen).toEqual(["API endpoints|src/routes/a.ts"]);
  });

  it("joins several groups in the reason", () => {
    const drift = {
      status: "uncovered" as const,
      groups: [
        group(["a.ts", "b.ts"]),
        { means: "Tables", layer: "parts", files: ["db.sql"] },
      ],
      message: "",
    };
    const reason = (decide(input, drift, []).output as { reason: string })
      .reason;
    expect(reason).toContain("API endpoints (2 files), Tables (1 files).");
  });

  it("is silent the second time for the same files", () => {
    const first = decide(input, uncovered(), []);
    const second = decide(input, uncovered(), first.seen);
    expect(second.output).toBeNull();
    expect(second.seen).toEqual(first.seen);
  });

  it("ignores file order when matching what was seen", () => {
    const first = decide(input, uncovered(["b.ts", "a.ts"]), []);
    expect(
      decide(input, uncovered(["a.ts", "b.ts"]), first.seen).output,
    ).toBeNull();
  });

  it("blocks again when a new file joins the group", () => {
    const first = decide(input, uncovered(), []);
    const again = decide(
      input,
      uncovered(["src/routes/a.ts", "src/routes/b.ts"]),
      first.seen,
    );
    expect(again.output).not.toBeNull();
    expect(again.seen).toHaveLength(2);
  });
});

describe("findMapDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const map = (dir: string) => {
    mkdirSync(join(tmp, dir), { recursive: true });
    writeFileSync(join(tmp, dir, "archmap.config.json"), "{}");
  };
  const scripts = (drift: string) =>
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { "archmap:drift": drift } }),
    );

  it("uses architecture/ when it holds the config", () => {
    map("architecture");
    map("docs/architecture");
    scripts("archmap drift --dir docs/architecture");
    expect(findMapDir(tmp)).toBe("architecture");
  });

  it("reads --dir from the archmap:drift script", () => {
    map("docs/architecture");
    map("a/map"); // found first by a search; the script wins
    scripts("archmap drift --dir docs/architecture");
    expect(findMapDir(tmp)).toBe("docs/architecture");
  });

  it("searches one or two levels down, skipping node_modules", () => {
    map("node_modules/x");
    map("docs/architecture");
    expect(findMapDir(tmp)).toBe("docs/architecture");
  });

  it("ignores a script --dir with no map in it", () => {
    map("docs/architecture");
    scripts("archmap drift --dir gone");
    expect(findMapDir(tmp)).toBe("docs/architecture");
  });

  it("is null when there's no map", () => {
    writeFileSync(join(tmp, "package.json"), "not json");
    expect(findMapDir(tmp)).toBeNull();
  });
});

// git exports GIT_INDEX_FILE, GIT_DIR and friends to hooks; a test that
// inherited them would act on the real repo instead of its temp one.
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: "pipe",
  });

// Each spawned process (git especially) is what costs time when the machine is
// busy, so the fixture is built once and with as few git calls as it can be:
// one commit on a feature branch, and origin/main and origin/HEAD set straight
// to it, as a clone would leave them (no bare origin or push needed).
describe("the hook end to end", () => {
  let tmp: string;
  let repo: string;
  let linked: string;
  beforeAll(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GIT_")) vi.stubEnv(k, undefined);
    }
    tmp = mkdtempSync(join(import.meta.dirname, ".tmp-"));
    repo = join(tmp, "repo");
    mkdirSync(join(repo, "src/routes"), { recursive: true });
    git(repo, "init", "-q", "-b", "feature");
    const dir = join(repo, "architecture");
    const now = new Date("2026-11-20T18:04:00Z");
    init(dir, { repoRoot: repo, now, skill: false });
    const configPath = join(dir, "archmap.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as object;
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        watch: [
          { paths: ["src/routes/**"], means: "API endpoints", layer: "parts" },
        ],
      }),
    );
    publish(dir, "Baseline", { now });
    writeFileSync(join(repo, "src/routes/a.ts"), "a\n");
    git(repo, "add", "-A");
    git(
      repo,
      ...["-c", "user.name=Test", "-c", "user.email=test@example.com"],
      ...["-c", "commit.gpgsign=false", "commit", "-qm", "Baseline"],
    );
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );

    // The project's copy of the CLI: a script that runs the real one in-process.
    const bin = join(repo, ".archmap", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "archmap.mjs"),
      `import ${JSON.stringify(join(pkgRoot, "src", "cli.ts"))};\n`,
    );
    writeFileSync(join(repo, "src/routes/a.ts"), "edited\n");

    // Reached through a symlinked folder, as an installed plugin may be.
    linked = join(tmp, "linked-hooks");
    symlinkSync(join(pkgRoot, "plugin", "hooks"), linked);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("blocks once, then stays quiet", () => {
    const sessionId = `test-${Date.now()}`;
    const stdin = JSON.stringify({
      session_id: sessionId,
      cwd: repo,
      stop_hook_active: false,
    });
    const run = () =>
      execFileSync(process.execPath, [join(linked, "drift-reminder.mjs")], {
        input: stdin,
        env: cleanEnv(),
        encoding: "utf8",
      });
    try {
      const first = JSON.parse(run()) as { decision: string; reason: string };
      expect(first.decision).toBe("block");
      expect(first.reason).toContain("API endpoints (1 files)");
      expect(run()).toBe("");
    } finally {
      rmSync(join(tmpdir(), `archmap-hook-${sessionId}.json`), { force: true });
    }
  });

  it("stays silent without .archmap/", () => {
    const bare = join(tmp, "no-copy");
    mkdirSync(join(bare, "architecture"), { recursive: true });
    writeFileSync(join(bare, "architecture", "archmap.config.json"), "{}");
    const out = execFileSync(
      process.execPath,
      [join(pkgRoot, "plugin", "hooks", "drift-reminder.mjs")],
      {
        input: JSON.stringify({ session_id: "none", cwd: bare }),
        env: cleanEnv(),
        encoding: "utf8",
      },
    );
    expect(out).toBe("");
  });
});
