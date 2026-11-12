// `migrate`: turn an old save ledger (saves/*.json replayed into a model) into markdown map
// files, once. The docs it writes carry no evidence; a `review` brief adds it.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { replay, type Column, type Model, type Service } from "./core.ts";
import { VERSION } from "./home.ts";
import { FOLDERS } from "./map/types.ts";
import type { Folder, Result } from "./map/types.ts";
import { loadProject, writeJson } from "./project.ts";

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/;
const DATABASE = /postgres|sql|database|db\b/i;
const QUEUE = /queue|bus/i;
const CODE_PATH = /\/(?:tree|blob)\/[^/]+\/(.+?)\/?$/;

type Entry = Record<string, unknown>;

/** A doc being built: frontmatter lists fill in as parts and connections are folded in. */
type Draft = {
  folder: Folder;
  id: string;
  name: string;
  status: string;
  kind?: string;
  code: string[];
  summary: string;
  notes?: string;
  bullets: string[];
  /** Frontmatter after name, status, kind and code, in insertion order. */
  lists: Map<string, unknown>;
  lane?: string;
};

const toId = (id: string): string => id.toLowerCase().replace(/_/g, "-");

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

const statusOf = (status: unknown, lane?: unknown): string => {
  const s = typeof status === "string" ? status : "";
  if (s === "planned") return "planned";
  if (lane === "legacy" || /retir/i.test(s)) return "retiring";
  return "live";
};

/** Fields set only when the value is present, so the YAML has no empty keys. */
const compact = (entry: Entry): Entry =>
  Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));

const codePaths = (docs: unknown): string[] => {
  const out: string[] = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    const url: unknown = Reflect.get(Object(d), "url");
    const path = typeof url === "string" ? CODE_PATH.exec(url)?.[1] : undefined;
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
};

const factLines = (facts: unknown): string[] =>
  (Array.isArray(facts) ? facts : []).flatMap((f) => {
    const k = text(Reflect.get(Object(f), "k"));
    const v = text(Reflect.get(Object(f), "v"));
    return k && v ? [`- **${k}**: ${v}`] : [];
  });

const bullet = (name: string, purpose?: string) =>
  purpose ? `- **${name}**: ${purpose}` : `- **${name}**`;

const push = (draft: Draft, key: string, entry: Entry) => {
  const list = draft.lists.get(key);
  draft.lists.set(key, [...(Array.isArray(list) ? list : []), entry]);
};

const FULL_BODY: Folder[] = ["services", "stores", "flows"];

const render = (d: Draft): string => {
  const data: Entry = {
    ...compact({
      name: d.name,
      status: d.status,
      kind: d.kind,
      code: d.code.length ? d.code : undefined,
    }),
    ...Object.fromEntries(d.lists),
  };
  const how = [d.notes, d.bullets.join("\n")].filter(Boolean).join("\n\n");
  const full = FULL_BODY.includes(d.folder);
  const parts = [d.summary];
  if (full || how)
    parts.push(how ? `## How it works\n\n${how}` : "## How it works");
  if (full) parts.push("## For developers\n\n_To be written._");
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n${parts.join("\n\n")}\n`;
};

const storeKind = (s: Service): string => {
  const words = `${s.name ?? ""} ${typeof s.tech === "string" ? s.tech : ""}`;
  if (DATABASE.test(words)) return "database";
  if (QUEUE.test(words)) return "queue";
  return "bucket";
};

const placeOf = (s: Service): { folder: Folder; kind: string } => {
  if (s.type === "store" || s.type === "container")
    return { folder: "stores", kind: storeKind(s) };
  if (s.type === "external") return { folder: "external", kind: "other" };
  if (s.type === "platform") return { folder: "external", kind: "hosting" };
  if (s.type === "job") return { folder: "services", kind: "job" };
  if (s.type === "app" && s.lane === "frontend")
    return { folder: "services", kind: "app" };
  return { folder: "services", kind: "api" };
};

const isStore = (s: Service) => s.type === "store" || s.type === "container";

/** Builds the drafts from a replayed model. */
const draftsFrom = (m: Model): Draft[] => {
  const services = new Map(Object.entries(m.services));

  // The parent, skipping groups: a group's children belong to the group's parent.
  const parentOf = (id: string): string | undefined => {
    let p = services.get(id)?.parent;
    while (p && services.get(p)?.type === "group") p = services.get(p)?.parent;
    return p && services.has(p) ? p : undefined;
  };
  const isDoc = (id: string): boolean => {
    const s = services.get(id);
    return !!s && s.type !== "group" && (isStore(s) || !parentOf(id));
  };
  /** The nearest service at or above `id` that becomes a doc. */
  const docOf = (id: string): string | undefined => {
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && !isDoc(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf(cur);
    }
    return cur && isDoc(cur) ? cur : undefined;
  };

  const drafts = new Map<string, Draft>();
  for (const [id, s] of services) {
    if (!isDoc(id)) continue;
    const { folder, kind } = placeOf(s);
    drafts.set(id, {
      folder,
      id: toId(id),
      name: text(s.name) ?? id,
      status: statusOf(s.status, s.lane),
      kind,
      code: codePaths(s.docs),
      summary:
        text(s.purpose) ??
        text(s.blurb) ??
        text(s.description) ??
        text(s.name) ??
        id,
      notes: text(s.notes),
      bullets: [
        ...(text(s.tech) ? [`- **Tech**: ${String(s.tech)}`] : []),
        ...factLines(s.facts),
      ],
      lists: new Map(),
      lane: typeof s.lane === "string" ? s.lane : undefined,
    });
  }

  // Parts fold into their doc: endpoints, jobs, libraries, or a bullet.
  for (const [id, s] of services) {
    if (isDoc(id) || s.type === "group") continue;
    const parent = parentOf(id);
    const owner = parent ? drafts.get(docOf(parent) ?? "") : undefined;
    if (!owner) continue;
    const name = text(s.name) ?? id;
    const purpose = text(s.purpose);
    const isService = owner.folder === "services";
    if (s.type === "endpoint" && isService) {
      const route = ROUTE.test(name) ? name : `GET /${slug(name)}`;
      push(owner, "endpoints", { route });
      if (route !== name)
        owner.bullets.push(bullet(`${name} (${route})`, purpose));
    } else if (s.type === "job" && isService) push(owner, "jobs", { name });
    else if ((s.type === "library" || s.type === "tool") && isService)
      push(owner, "libraries", compact({ name, why: purpose }));
    else owner.bullets.push(bullet(name, purpose));
  }

  // Connections: from the doc that holds `from` to the doc that holds `to`. Externals
  // can't hold connections, so an external's connection is recorded on the other end.
  const seen = new Set<string>();
  for (const c of Object.values(m.connections)) {
    const from = docOf(c.from);
    const to = docOf(c.to);
    if (!from || !to || from === to) continue;
    let owner = drafts.get(from);
    let target = to;
    if (owner?.folder === "external") {
      owner = drafts.get(to);
      target = from;
    }
    if (!owner || owner.folder === "external") continue;
    const key = `${owner.id}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(
      owner,
      "connects",
      compact({ to: toId(target), why: text(c.label), how: text(c.protocol) }),
    );
  }

  // Tables and enums go to the first database that isn't legacy.
  const databases = [...drafts.values()].filter((d) => d.kind === "database");
  let db = databases.find((d) => d.lane !== "legacy") ?? databases[0];
  const tables = Object.entries(m.tables);
  const enums = Object.entries(m.enums);
  if (!db && (tables.length || enums.length)) {
    db = {
      folder: "stores",
      id: "database",
      name: "Database",
      status: "live",
      kind: "database",
      code: [],
      summary: "The database.",
      bullets: [],
      lists: new Map(),
    };
    drafts.set("database", db);
  }
  if (db) {
    const areas = new Map(Object.entries(m.areas));
    for (const [name, values] of enums)
      push(db, "enums", {
        name,
        values: (Array.isArray(values.values) ? values.values : []).filter(
          (v): v is string => typeof v === "string",
        ),
      });
    for (const [name, t] of tables) {
      const area = t.area ? areas.get(t.area) : undefined;
      push(
        db,
        "tables",
        compact({
          name,
          group: t.area ? (text(area?.name) ?? t.area) : undefined,
          purpose: text(t.purpose),
          columns: t.columns.map((col: Column) =>
            compact({
              name: col.name,
              type: col.type && col.array ? `${col.type}[]` : col.type,
              pk: col.pk,
              unique: col.unique,
              fk: col.fk,
              enum: col.enum,
              desc: col.desc,
            }),
          ),
        }),
      );
    }
  }

  const out = [...drafts.values()];

  for (const [id, p] of Object.entries(m.personas))
    out.push({
      folder: "personas",
      id: toId(id),
      name: text(p.name) ?? id,
      status: statusOf(p.status),
      code: [],
      summary: text(p.blurb) ?? text(p.description) ?? text(p.name) ?? id,
      bullets: [],
      lists: new Map<string, unknown>([
        ["roles", []],
        ["needs", (p.jobs ?? []).flatMap((j) => (text(j.job) ? [j.job] : []))],
      ]),
    });

  // A flow step names a persona ("persona:x") or a service; services resolve to their doc.
  const actor = (ref: string): string =>
    ref.startsWith("persona:") ? toId(ref.slice(8)) : toId(docOf(ref) ?? ref);
  for (const [id, f] of Object.entries(m.flows)) {
    const steps = f.steps ?? [];
    const first = steps.find((st) => st.from.startsWith("persona:"));
    const lists = new Map<string, unknown>();
    if (first) lists.set("persona", toId(first.from.slice(8)));
    lists.set(
      "steps",
      steps.map((st) => {
        const at = st.to && !st.to.startsWith("persona:") ? st.to : st.from;
        return { by: actor(st.from), at: actor(at), does: st.label ?? "" };
      }),
    );
    out.push({
      folder: "flows",
      id: toId(id),
      name: text(f.name) ?? id,
      status: statusOf(f.status),
      code: [],
      summary: text(f.description) ?? text(f.purpose) ?? text(f.name) ?? id,
      bullets: [],
      lists,
    });
  }
  return out;
};

const hasMarkdown = (dir: string): boolean =>
  existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".md"));

export const migrate = (root: string, dir: string): Result => {
  const mapDir = resolve(root, dir);
  const rel = relative(resolve(root), mapDir) || ".";
  if (!existsSync(join(mapDir, "saves")))
    return {
      ok: false,
      lines: [`${rel}/saves/ is missing, so there is no ledger to migrate.`],
    };
  const taken = FOLDERS.filter((f) => hasMarkdown(join(mapDir, f)));
  if (taken.length)
    return {
      ok: false,
      lines: [
        `${rel} already has map files in ${taken.map((f) => `${f}/`).join(", ")}; migrate only runs once, on a ledger.`,
      ],
    };

  let project;
  try {
    project = loadProject(mapDir);
  } catch (err) {
    return { ok: false, lines: [(err as Error).message] };
  }
  const lines = project.fileErrors.map((e) => `Skipped: ${e}`);
  const m = replay(project.saves);
  const drafts = draftsFrom(m);

  const counts = new Map<Folder, number>(FOLDERS.map((f) => [f, 0]));
  for (const d of drafts) {
    mkdirSync(join(mapDir, d.folder), { recursive: true });
    writeFileSync(join(mapDir, d.folder, `${d.id}.md`), render(d));
    counts.set(d.folder, (counts.get(d.folder) ?? 0) + 1);
  }
  lines.push(
    `Wrote ${FOLDERS.map((f) => `${counts.get(f) ?? 0} ${f}`).join(", ")} to ${rel}.`,
  );

  const configPath = join(mapDir, "archmap.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Entry;
  config.archmap = VERSION;
  writeJson(configPath, config);
  lines.push(`Pinned ${rel}/archmap.config.json to archmap ${VERSION}.`);

  const readme = join(mapDir, "README.md");
  if (existsSync(readme)) lines.push(`Kept the existing ${rel}/README.md.`);
  else {
    const categories = Object.values(m.categories)
      .slice()
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .map((c) => bullet(text(c.name) ?? "Category", text(c.purpose)));
    const name = text(config.name) ?? "Architecture";
    writeFileSync(
      readme,
      [`# ${name}`, ...(categories.length ? [categories.join("\n")] : [])].join(
        "\n\n",
      ) + "\n",
    );
    lines.push(`Wrote ${rel}/README.md.`);
  }

  lines.push("Next: run brief --task review");
  return { ok: true, lines };
};
