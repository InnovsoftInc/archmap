// archmap viewer: the map's UI. It reads data.json (written by `archmap build`, or served
// fresh by `archmap dev`), which carries the map's model, each doc's text and the check results.

// Saved box positions, one entry per map: the old single key is read once per map
// that has none of its own yet, and kept for other maps on the same origin.
var STORE_OLD = "archmap-pos-v1",
  STORE_PREFIX = "archmap-pos-v2|";
var W = 248,
  SW = 220,
  HEAD = 34,
  ROW = 22,
  FOOT = 20,
  SH = 34 + 72 + 2,
  GAP = 26,
  PAD = 24,
  PAD_T = 46,
  ZGAP = 90;

// Id-keyed lookups have no prototype, so an id like "constructor" or "toString"
// is just a key.
function dict() {
  return Object.create(null);
}
function own(o, k) {
  return o != null && Object.prototype.hasOwnProperty.call(o, k)
    ? o[k]
    : undefined;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c];
  });
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// An id from the map as part of a CSS custom property name: only [A-Za-z0-9_-]
// survive, so it can't end the var() or the style attribute it is written into.
function cssId(s) {
  return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "_");
}
function zvar(area) {
  return "var(--z-" + cssId(area) + ", var(--z-records))";
}
function lvar(lane) {
  return "var(--l-" + cssId(lane) + ", var(--l-platform))";
}
// A link from the config keeps only http, https, mailto or a relative URL.
// Control characters and whitespace are dropped before the check, as browsers do.
function safeHref(u) {
  if (typeof u !== "string") return null;
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  var s = u.replace(/[\u0000- \u007f]/g, "");
  if (!s) return null;
  if (/^(?:https?|mailto):/i.test(s)) return u.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(s) ? null : u.trim();
}
// A stylesheet from the config: https, or a path on this site.
function safeStylesheet(u) {
  var h = safeHref(u);
  if (!h) return null;
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  var s = h.replace(/[\u0000- \u007f]/g, "");
  if (/^https:/i.test(s)) return h;
  if (/^[a-z][a-z\d+.-]*:/i.test(s) || /^[\\/]{2}/.test(s)) return null;
  return h;
}

// ---------- data: the model, each doc's text (HTML) and what `archmap check` found
var MODEL = null,
  DOCS = dict(),
  CHECK = { errors: [], warnings: [] },
  README = "",
  PUBLIC = false,
  CONFIG = { name: "Architecture map" },
  LABELS = {};

function emptyModel() {
  return {
    categories: dict(),
    areas: dict(),
    tables: dict(),
    enums: dict(),
    services: dict(),
    connections: dict(),
    personas: dict(),
    flows: dict(),
    problems: [],
  };
}

// ---------- UI state
// The whole map on one page (the Diagram button): only at the top of "arch".
var diag = false;
var view = "arch",
  path = [],
  sel = null,
  per = null,
  hov = null,
  query = "";
// Saved positions, keyed "scope|card key". Read once the map's name is known.
var P = dict(),
  storeKey = null;
function readStore(key) {
  try {
    var v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      var out = dict();
      Object.keys(v).forEach(function (k) {
        var q = v[k];
        if (q && isFinite(q.x) && isFinite(q.y)) out[k] = { x: +q.x, y: +q.y };
      });
      return out;
    }
  } catch (e) {
    /* unreadable or blocked storage: start empty */
  }
  return null;
}
function savePos() {
  if (!storeKey) return;
  try {
    localStorage.setItem(storeKey, JSON.stringify(P));
  } catch (e) {
    /* ignore */
  }
}
// Whether a saved "scope|key" still names something on the map.
function posLive(k, B) {
  var bar = k.indexOf("|");
  if (bar < 0) return false;
  var sc = k.slice(0, bar),
    key = k.slice(bar + 1);
  if (sc === "schema") return own(B.tables, key) !== undefined;
  if (sc.indexOf("flow/") === 0 && own(B.flows, sc.slice(5)) === undefined)
    return false;
  if (sc.indexOf("arch/") === 0) {
    var segs = sc.slice(5) ? sc.slice(5).split("/") : [];
    if (segs.length && own(B.categories, segs[0]) === undefined) return false;
    for (var i = 1; i < segs.length; i++)
      if (own(B.services, segs[i]) === undefined) return false;
  } else if (sc.indexOf("flow/") !== 0) return false;
  var kind = key.slice(0, 4),
    id = key.slice(4);
  if (kind === "svc:") return own(B.services, id) !== undefined;
  if (kind === "act:") return own(B.personas, id) !== undefined;
  if (kind === "cat:") return own(B.categories, id) !== undefined;
  return false;
}
// Loads this map's saved positions (migrating the old shared key once) and
// drops the ones whose boxes are no longer on the map.
function loadPositions() {
  var key = STORE_PREFIX + (CONFIG.name || "") + "|" + location.pathname;
  if (key !== storeKey) {
    storeKey = key;
    P = readStore(key) || readStore(STORE_OLD) || dict();
  }
  var B = MODEL || emptyModel();
  // An empty model (a file mid-edit in dev) would drop every saved position.
  if (!Object.keys(B.services).length && !Object.keys(B.tables).length) return;
  var dropped = false;
  Object.keys(P).forEach(function (k) {
    if (!posLive(k, B)) {
      delete P[k];
      dropped = true;
    }
  });
  var had = false;
  try {
    had = localStorage.getItem(key) !== null;
  } catch (e) {
    had = true;
  }
  if (dropped || !had) savePos();
}

var $ = function (id) {
  return document.getElementById(id);
};
var vp = $("vp"),
  world = $("world"),
  zoneLayer = $("zoneLayer"),
  cardLayer = $("cardLayer"),
  svg = $("edges"),
  panel = $("panel");
var NS = "http://www.w3.org/2000/svg";

// ---------- view model: the map's model, shaped for drawing
// Built once per data load: drawing and navigation only read it.
var VM = null;
function buildVM() {
  var B = MODEL || emptyModel();
  var vm = {
    B: B,
    tables: [],
    services: [],
    conns: [],
    edges: [],
    areas: dict(),
  };
  Object.keys(B.tables).forEach(function (n) {
    var t = B.tables[n];
    var cols = (t.columns || []).map(function (c) {
      return { c: c, st: "" };
    });
    var hasId = cols.some(function (x) {
      return x.c.name === "id";
    });
    if (!hasId)
      cols.unshift({
        c: {
          name: "id",
          type: "uuid",
          pk: true,
          desc: "Primary key. Every table has one.",
        },
        st: "",
        implied: true,
      });
    vm.tables.push({
      name: n,
      t: t,
      st: "",
      cols: cols,
      h: HEAD + cols.length * ROW + FOOT + 2,
    });
  });
  Object.keys(B.areas).forEach(function (id) {
    vm.areas[id] = B.areas[id];
  });
  vm.T = dict();
  vm.tables.forEach(function (t) {
    vm.T[t.name] = t;
  });
  vm.tables.forEach(function (t) {
    t.cols.forEach(function (x, i) {
      if (x.c.fk && vm.T[x.c.fk])
        vm.edges.push({ s: t.name, si: i, t: x.c.fk, col: x.c.name, st: "" });
    });
  });
  Object.keys(B.services).forEach(function (id) {
    vm.services.push({ id: id, s: B.services[id], st: "" });
  });
  vm.S = dict();
  vm.services.forEach(function (s) {
    vm.S[s.id] = s;
  });
  // Per lane and per parent, so a card or filter never scans every service.
  vm.byLane = dict();
  vm.topByLane = dict(); // no parent
  vm.rootByLane = dict(); // no parent on the map
  vm.kids = dict();
  vm.services.forEach(function (x) {
    var lane = x.s.lane;
    (vm.byLane[lane] = vm.byLane[lane] || []).push(x);
    if (x.s.parent && vm.S[x.s.parent])
      (vm.kids[x.s.parent] = vm.kids[x.s.parent] || []).push(x);
    else (vm.rootByLane[lane] = vm.rootByLane[lane] || []).push(x);
    if (!x.s.parent) (vm.topByLane[lane] = vm.topByLane[lane] || []).push(x);
  });
  Object.keys(B.connections).forEach(function (id) {
    var c = B.connections[id];
    if (c && vm.S[c.from] && vm.S[c.to])
      vm.conns.push({ id: id, c: c, st: "" });
  });
  // The data carries one category per lane in use, from the map's lanes.
  vm.cats = Object.keys(B.categories).map(function (id) {
    return { id: id, c: B.categories[id], st: "" };
  });
  vm.cats.sort(function (a, b) {
    return (a.c.order || 0) - (b.c.order || 0);
  });
  vm.personas = Object.keys(B.personas)
    .sort(function (a, b) {
      return (B.personas[a].order || 0) - (B.personas[b].order || 0);
    })
    .map(function (id) {
      var p = B.personas[id],
        tables = dict();
      (Array.isArray(p.jobs) ? p.jobs : []).forEach(function (j) {
        var t = j && j.t && typeof j.t === "object" ? j.t : {};
        Object.keys(t).forEach(function (n) {
          var mode = t[n] === "w" ? "w" : "r";
          if (mode === "w" || !tables[n]) tables[n] = mode;
        });
      });
      return { id: id, p: p, tables: tables, st: "" };
    });
  // Which tables a persona reads and writes, and whom it uses, are only drawn
  // when the data says so; without them a persona is its jobs and blurb.
  vm.personaTables = vm.personas.some(function (x) {
    return Object.keys(x.tables).length > 0;
  });
  vm.PER = dict();
  vm.personas.forEach(function (x) {
    vm.PER[x.id] = x;
  });
  // Everyone the map names is drawn on the overview and the diagram. An arrow
  // needs a flow step the persona takes; without one they stand unconnected.
  vm.actors = vm.personas.slice();
  vm.flows = Object.keys(B.flows)
    .map(function (id) {
      return { id: id, f: B.flows[id], st: "" };
    })
    .sort(function (a, b) {
      return (a.f.order || 0) - (b.f.order || 0);
    });
  vm.FL = dict();
  vm.flows.forEach(function (x) {
    vm.FL[x.id] = x;
  });
  VM = vm;
}
function usesOf(p) {
  return Array.isArray(p.uses)
    ? p.uses.filter(function (u) {
        return u && typeof u.to === "string";
      })
    : [];
}
function colType(c, m) {
  var en = c.enum ? own(m.enums, c.enum) : undefined;
  if (en)
    return en.style === "native"
      ? c.enum + (c.array ? "[]" : "")
      : c.array
        ? "text[]"
        : "text";
  return c.type || "";
}

// ---------- layout
function areaOrder(vm) {
  return Object.keys(vm.areas).sort(function (a, b) {
    return (vm.areas[a].order || 0) - (vm.areas[b].order || 0);
  });
}
// Areas side by side, each two columns of tables.
function layoutSchema(vm) {
  var pos = dict(),
    x = 0;
  areaOrder(vm).forEach(function (aid) {
    var n = vm.areas[aid].cols || 2,
      colH = [],
      i;
    for (i = 0; i < n; i++) colH.push(0);
    vm.tables
      .filter(function (t) {
        return t.t.area === aid;
      })
      .sort(function (a, b) {
        return (a.t.order || 0) - (b.t.order || 0);
      })
      .forEach(function (t) {
        var c = colH.indexOf(Math.min.apply(null, colH));
        pos[t.name] = {
          x: x + PAD + c * (W + GAP),
          y: PAD_T + colH[c],
        };
        colH[c] += t.h + GAP;
      });
    x += PAD * 2 + n * W + (n - 1) * GAP + ZGAP;
  });
  return pos;
}
var AW = 210,
  AH = 64;
var TYPE_LABEL = {
  app: "App",
  store: "Store",
  job: "Job",
  platform: "Platform",
  external: "External",
  group: "Group",
  endpoint: "Endpoint",
  module: "Endpoint group",
  library: "Library",
  env: "Environment variable",
  tool: "Tool",
  container: "Container",
};
var ICON = {
  app: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>',
  store:
    '<svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/></svg>',
  job: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>',
  platform:
    '<svg viewBox="0 0 16 16"><path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z"/><circle cx="8" cy="8" r="2"/></svg>',
  external:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 1.6 9.4 0 11M8 2.5c-1.6 1.6-1.6 9.4 0 11"/></svg>',
  actor:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="5" r="2.6"/><path d="M3 14c.6-2.9 2.6-4.4 5-4.4s4.4 1.5 5 4.4"/></svg>',
  group:
    '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  endpoint:
    '<svg viewBox="0 0 16 16"><path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 3l-3 10"/></svg>',
  module:
    '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/></svg>',
  library:
    '<svg viewBox="0 0 16 16"><path d="M3 2.5h3v11H3zM7 2.5h3v11H7zM11 3l2.8.8-2.6 9.7-2.8-.8"/></svg>',
  env: '<svg viewBox="0 0 16 16"><circle cx="5" cy="8" r="2.8"/><path d="M7.8 8h6.7M12 8v2.5M14.5 8v2"/></svg>',
  tool: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5a3 3 0 0 0-2.9 3.8L2.8 11.1a1.4 1.4 0 0 0 2 2l4.8-4.8a3 3 0 0 0 3.8-2.9l-1.8 1-1.6-.6-.4-1.6z"/></svg>',
  container:
    '<svg viewBox="0 0 16 16"><path d="M2 5.5h12v8H2zM3.5 5.5V3h9v2.5"/></svg>',
};
// Always one of TYPE_LABEL's keys, so its label and icon are this file's own text.
function stype(s) {
  return own(TYPE_LABEL, s.type)
    ? s.type
    : s.lane === "third_party" || s.lane === "legacy"
      ? "external"
      : s.opens === "schema"
        ? "store"
        : "app";
}
function catName(id) {
  return (
    VM.cats.filter(function (c) {
      return c.id === id;
    })[0] || { c: { name: id || "" } }
  ).c.name;
}
// A library's declared version from its manifest, and how far it is behind the
// latest release when dev or build could look that up.
var FRESH = {
  ok: "up to date",
  patch: "patch behind",
  minor: "minor behind",
  major: "major behind",
};
function versionBadge(s) {
  if (!s.version) return "";
  var tip = s.latest ? ' title="Latest: ' + esc(s.latest) + '"' : "",
    fresh = own(FRESH, s.fresh);
  return (
    '<span class="mt ver">· ' +
    esc(s.version) +
    "</span>" +
    (fresh
      ? '<span class="fresh f-' +
        esc(s.fresh) +
        '"' +
        tip +
        ">" +
        esc(fresh) +
        "</span>"
      : "")
  );
}
// Inside a service its parts can be very long lists (every endpoint, library
// and environment variable), so they are tables, not boxes: one tab per kind,
// sorted by a click on a heading and filtered by the header search. A click on
// a row opens that part's details in the drawer.
function partName(x) {
  return x.s.name || "";
}
function partPurpose(x) {
  return x.s.purpose || "";
}
var WHERE = {
  h: "Where in the code",
  v: function (x) {
    return x.s.evidence || "";
  },
  mono: true,
  dev: true,
};
var FRESH_RANK = { ok: 1, patch: 2, minor: 3, major: 4 };
var LISTS = [
  {
    type: "endpoint",
    name: "Endpoints",
    cols: [
      {
        h: "Method",
        v: function (x) {
          return partName(x).split(" ")[0];
        },
        mono: true,
      },
      {
        h: "Path",
        v: function (x) {
          var n = partName(x),
            i = n.indexOf(" ");
          return i < 0 ? n : n.slice(i + 1);
        },
        mono: true,
        open: true,
      },
      { h: "What it does", v: partPurpose },
      WHERE,
    ],
  },
  {
    type: "job",
    name: "Jobs",
    cols: [
      { h: "Job", v: partName, open: true },
      { h: "What it does", v: partPurpose },
      {
        h: "Runs",
        v: function (x) {
          return x.s.schedule || "";
        },
      },
      WHERE,
    ],
  },
  {
    type: "library",
    name: "Libraries",
    cols: [
      { h: "Library", v: partName, open: true },
      {
        h: "Package",
        v: function (x) {
          return x.s.package || "";
        },
        mono: true,
      },
      {
        h: "Version",
        v: function (x) {
          return x.s.version || "";
        },
        mono: true,
      },
      {
        h: "Latest",
        v: function (x) {
          return x.s.latest || "";
        },
        mono: true,
      },
      {
        h: "Up to date",
        v: function (x) {
          return (own(FRESH, x.s.fresh) && FRESH[x.s.fresh]) || "";
        },
        n: function (x) {
          return (own(FRESH_RANK, x.s.fresh) && FRESH_RANK[x.s.fresh]) || 0;
        },
        html: function (x) {
          var label = own(FRESH, x.s.fresh) && FRESH[x.s.fresh];
          return label
            ? '<span class="fresh f-' +
                esc(x.s.fresh) +
                '">' +
                esc(label) +
                "</span>"
            : "";
        },
      },
      { h: "What it is for", v: partPurpose },
      WHERE,
    ],
  },
  {
    type: "env",
    name: "Environment variables",
    cols: [
      { h: "Name", v: partName, mono: true, open: true },
      {
        h: "Shipped to the browser",
        v: function (x) {
          return x.s.public === true ? "Yes" : "";
        },
      },
      { h: "What it is for", v: partPurpose },
      WHERE,
    ],
  },
];
var OTHER_LIST = {
  type: "",
  name: "Other parts",
  cols: [
    { h: "Name", v: partName, open: true },
    {
      h: "Kind",
      v: function (x) {
        return TYPE_LABEL[stype(x.s)];
      },
    },
    { h: "What it is for", v: partPurpose },
  ],
};
// Which service's lists are open, which tab, and the sort: `col` is an index
// into the tab's columns (-1 keeps the map's own order). `focus` is a part to
// show and mark once, after a search or a link led to it.
var list = { svc: null, tab: null, col: -1, dir: 1, focus: null };
function listGroups(id) {
  var kids = childrenOf(id);
  var groups = LISTS.map(function (l) {
    return {
      l: l,
      items: kids.filter(function (x) {
        return stype(x.s) === l.type;
      }),
    };
  });
  groups.push({
    l: OTHER_LIST,
    items: kids.filter(function (x) {
      return !LISTS.some(function (l) {
        return l.type === stype(x.s);
      });
    }),
  });
  return groups.filter(function (g) {
    return g.items.length;
  });
}
function rowMatches(l, x) {
  return (
    !query ||
    has(
      l.cols
        .map(function (c) {
          return c.v(x);
        })
        .join(" "),
    )
  );
}
function renderLists() {
  var box = $("lists"),
    id = path[path.length - 1],
    x = VM.S[id];
  if (!x) return;
  if (list.svc !== id)
    list = { svc: id, tab: null, col: -1, dir: 1, focus: list.focus };
  var groups = listGroups(id),
    focus = list.focus;
  list.focus = null;
  if (focus)
    groups.forEach(function (g) {
      if (
        g.l.name !== list.tab &&
        g.items.some(function (i) {
          return i.id === focus;
        })
      ) {
        list.tab = g.l.name;
        list.col = -1;
      }
    });
  var cur =
    groups.filter(function (g) {
      return g.l.name === list.tab;
    })[0] || groups[0];
  var b =
    '<div class="lhead"><h2 id="listsTitle">' +
    esc(x.s.name) +
    '</h2><div class="ltabs" role="group" aria-label="What to list">' +
    groups
      .map(function (g) {
        return (
          '<button type="button" class="tbtn" data-tab="' +
          esc(g.l.name) +
          '" aria-pressed="' +
          String(g === cur) +
          '">' +
          esc(g.l.name) +
          ' <span class="n"></span></button>'
        );
      })
      .join("") +
    "</div></div>";
  if (!cur) {
    box.innerHTML =
      b +
      '<div class="empty-state inline" role="status"><p>Nothing recorded inside yet. Ask your AI agent to run <code>archmap brief</code> and follow it.</p></div>';
    return;
  }
  list.tab = cur.l.name;
  // A column nothing fills (no schedule, or no code paths in a public build) is left out.
  var cols = cur.l.cols
    .map(function (c, i) {
      return { c: c, i: i };
    })
    .filter(function (k) {
      return cur.items.some(function (it) {
        return k.c.v(it) !== "";
      });
    });
  var by = cur.l.cols[list.col],
    rows = cur.items.slice();
  if (by)
    rows.sort(function (p, q) {
      return (
        list.dir *
        (by.n
          ? by.n(p) - by.n(q)
          : by.v(p).localeCompare(by.v(q), undefined, {
              numeric: true,
              sensitivity: "base",
            }))
      );
    });
  function cls(c) {
    var names = (c.mono ? ["mono"] : []).concat(c.dev ? ["dev"] : []);
    return names.length ? ' class="' + names.join(" ") + '"' : "";
  }
  box.innerHTML =
    b +
    '<div class="lwrap"><table class="ltable"><caption class="sr-only">' +
    esc(cur.l.name + " of " + x.s.name) +
    "</caption><thead><tr>" +
    cols
      .map(function (k) {
        return (
          '<th scope="col"' +
          cls(k.c) +
          ' aria-sort="' +
          (k.i !== list.col
            ? "none"
            : list.dir > 0
              ? "ascending"
              : "descending") +
          '"><button type="button" data-sort="' +
          k.i +
          '">' +
          esc(k.c.h) +
          '<i aria-hidden="true"></i></button></th>'
        );
      })
      .join("") +
    "</tr></thead><tbody>" +
    rows
      .map(function (it) {
        return (
          '<tr data-id="' +
          esc(it.id) +
          '">' +
          cols
            .map(function (k) {
              return (
                "<td" +
                cls(k.c) +
                ">" +
                (k.c.html
                  ? k.c.html(it)
                  : k.c.open
                    ? '<button type="button" class="rowbtn">' +
                      esc(k.c.v(it)) +
                      "</button>"
                    : esc(k.c.v(it))) +
                "</td>"
              );
            })
            .join("") +
          "</tr>"
        );
      })
      .join("") +
    '</tbody></table><p class="lnone" id="listsNone" role="status" hidden></p></div>';
  filterLists();
  if (focus)
    box.querySelectorAll("tbody tr").forEach(function (tr) {
      if (tr.dataset.id !== focus) return;
      tr.hidden = false;
      tr.scrollIntoView({ block: "center" });
    });
}
// The header search narrows the open table and counts the matches on each tab.
function filterLists() {
  var box = $("lists");
  if (box.hidden || !list.svc || !VM.S[list.svc]) return;
  var shown = 0;
  listGroups(list.svc).forEach(function (g) {
    var hits = g.items.filter(function (it) {
      return rowMatches(g.l, it);
    }).length;
    box.querySelectorAll("[data-tab]").forEach(function (t) {
      if (t.dataset.tab === g.l.name)
        t.querySelector(".n").textContent = query
          ? hits + " of " + g.items.length
          : g.items.length;
    });
    if (g.l.name !== list.tab) return;
    shown = hits;
    box.querySelectorAll("tbody tr").forEach(function (tr) {
      var it = VM.S[tr.dataset.id],
        on = !!sel && sel.view === "arch" && sel.key === "svc:" + tr.dataset.id;
      tr.hidden = !it || !rowMatches(g.l, it);
      // The row whose details are open in the drawer.
      tr.classList.toggle("on", on);
      if (on) tr.setAttribute("aria-current", "true");
      else tr.removeAttribute("aria-current");
    });
  });
  var none = $("listsNone");
  if (!none) return;
  none.hidden = shown > 0;
  none.textContent = "Nothing here matches “" + query + "”.";
}
$("lists").onclick = function (ev) {
  var tab = ev.target.closest("[data-tab]"),
    sort = ev.target.closest("[data-sort]"),
    again;
  if (tab) {
    if (list.tab === tab.dataset.tab) return;
    list.tab = tab.dataset.tab;
    list.col = -1;
    list.dir = 1;
    again = '[data-tab][aria-pressed="true"]';
  } else if (sort) {
    var i = Number(sort.dataset.sort);
    // Ascending, then descending, then back to the map's own order.
    if (list.col !== i) {
      list.col = i;
      list.dir = 1;
    } else if (list.dir > 0) list.dir = -1;
    else list.col = -1;
    again = '[data-sort="' + i + '"]';
  } else {
    var row = ev.target.closest("tr[data-id]");
    // Not when the click ends a text selection: the cells can be copied.
    if (row && VM.S[row.dataset.id] && !String(getSelection()))
      select("svc:" + row.dataset.id);
    return;
  }
  renderLists();
  var el = $("lists").querySelector(again);
  if (el) el.focus();
};
function svcCard(x, opts) {
  var s = x.s,
    k = "svc:" + x.id,
    t = stype(s),
    el = document.createElement("div"),
    stub = opts && opts.stub,
    compact = opts && opts.compact;
  var drillable =
    !stub && !compact && (s.opens === "schema" || childrenOf(x.id).length > 0);
  // Still to confirm: the map lists the options being chosen between.
  var options = Array.isArray(s.options) ? s.options : [],
    extra =
      (s.tech ? '<div class="tech">' + esc(s.tech) + "</div>" : "") +
      (options.length
        ? '<div class="tech">e.g. ' + esc(options.join(", ")) + "</div>"
        : "");
  el.className =
    "card svc t-" +
    t +
    (stub ? " stub" : "") +
    (compact ? " compact" : "") +
    (options.length && !stub ? " is-open" : "") +
    (compact && s.status === "planned" ? " is-planned" : "") +
    (compact && s.status === "retiring" ? " is-retiring" : "") +
    (x.st ? " " + x.st : "");
  el.dataset.key = k;
  if (stub) el.title = s.name + " · click to go to it";
  el.style.setProperty("--z", lvar(catOf(x.id)));
  cardRole(el, (drillable ? "Open " : "") + s.name);
  var meta =
    '<div class="meta">' +
    (stub
      ? '<span class="mt">' + esc(catName(catOf(x.id))) + "</span>"
      : '<span class="mt">' +
        esc(TYPE_LABEL[t]) +
        "</span>" +
        (s.status && s.status !== "live"
          ? '<span class="mt">· ' + esc(s.status) + "</span>"
          : "") +
        versionBadge(s)) +
    (options.length && !stub ? '<span class="mt open">to confirm</span>' : "") +
    keyBadges(x.st) +
    (drillable ? '<span class="drill">Open ›</span>' : "") +
    "</div>";
  el.innerHTML =
    '<div class="head"><span class="ico">' +
    ICON[t] +
    '</span><span class="tn">' +
    esc(s.name) +
    "</span></div>" +
    meta +
    (stub ? "" : extra) +
    (stub || compact
      ? ""
      : '<div class="sbody"><span class="pur">' +
        esc(s.purpose || "") +
        "</span></div>");
  return el;
}
function actorCard(a) {
  var el = document.createElement("div"),
    k = "act:" + a.id;
  el.className = "card actor" + (a.st ? " " + a.st : "");
  el.dataset.key = k;
  cardRole(el, "Persona " + a.p.name);
  el.innerHTML =
    '<div class="head"><span class="ico">' +
    ICON.actor +
    '</span><span class="tn">' +
    esc(a.p.name) +
    '</span></div><div class="meta"><span class="mt">' +
    esc([a.p.who, a.p.kind].filter(Boolean).join(" · ")) +
    "</span>" +
    keyBadges(a.st) +
    "</div>";
  return el;
}
function addZone(keys, title, sub, color, opts) {
  var el = document.createElement("div");
  el.className = "zone" + (opts && opts.cls ? " " + opts.cls : "");
  el.style.setProperty("--z", color);
  el.innerHTML = "<b>" + esc(title) + "<span>" + esc(sub) + "</span></b>";
  zoneLayer.appendChild(el);
  zoneEls.push({
    el: el,
    keys: keys,
    hFor: function (k) {
      return SIZE[k].h;
    },
    w: null,
    pad: (opts && opts.pad) || 0,
    tight: !!(opts && opts.tight),
    top: (opts && opts.top) || 0,
  });
}
// Architecture is browsed by level: path [] = categories, [cat] = items in a category, [cat, item, ...] = parts of an item.
var CW = 280,
  SIZE = dict(),
  MH = dict(),
  showOutside = false,
  showTypes = false;
function hOf(k, d) {
  return MH[k] || d;
}
function catOf(id) {
  var s = VM.S[id];
  var guard = 0;
  while (s && s.s.parent && VM.S[s.s.parent] && guard++ < 10)
    s = VM.S[s.s.parent];
  return s ? s.s.lane : null;
}
function childrenOf(id) {
  return VM.kids[id] || [];
}
// Every box is a button; its name is kept so apply() can add its state to it.
function cardRole(el, label) {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.dataset.label = label;
  el.setAttribute("aria-label", label);
}
function pathFor(id) {
  var chain = [],
    s = VM.S[id],
    guard = 0;
  while (s && s.s.parent && VM.S[s.s.parent] && guard++ < 10) {
    chain.unshift(s.s.parent);
    s = VM.S[s.s.parent];
  }
  return [catOf(id)].concat(chain);
}
function levelSets() {
  var main;
  if (path.length === 1) main = (VM.rootByLane[path[0]] || []).slice();
  else main = childrenOf(path[path.length - 1]);
  var inMain = dict();
  main.forEach(function (x) {
    inMain[x.id] = true;
  });
  // A connection to something nested is drawn to whichever ancestor is visible at this level.
  function chain(id) {
    var out = [id],
      x = VM.S[id],
      g = 0;
    while (x && x.s.parent && VM.S[x.s.parent] && g++ < 10) {
      out.push(x.s.parent);
      x = VM.S[x.s.parent];
    }
    return out;
  }
  function visible(id) {
    var ch = chain(id);
    for (var i = 0; i < ch.length; i++)
      if (inMain[ch[i]]) return { id: ch[i], main: true };
    return { id: ch[ch.length - 1], main: false };
  }
  var stubs = dict(),
    agg = dict();
  VM.conns.forEach(function (c) {
    var a = visible(c.c.from),
      b = visible(c.c.to);
    if (a.id === b.id || (!a.main && !b.main)) return;
    if (!a.main) stubs[a.id] = true;
    if (!b.main) stubs[b.id] = true;
    var key = a.id + ">" + b.id,
      x = agg[key];
    if (!x)
      x = agg[key] = {
        id: key,
        c: {
          from: a.id,
          to: b.id,
          label: c.c.label || "",
          status: c.c.status,
          async: c.c.async === true,
        },
        st: c.st,
        n: 1,
      };
    else {
      x.n++;
      x.c.label = x.n + " connections";
      if (c.c.status !== "planned") x.c.status = c.c.status;
      if (c.c.async !== true) x.c.async = false;
      if (x.st !== c.st) x.st = "changed";
    }
  });
  var conns = Object.keys(agg).map(function (k) {
    return agg[k];
  });
  var actors = [],
    uses = [];
  VM.actors.forEach(function (a) {
    usesOf(a.p).forEach(function (u) {
      if (inMain[u.to]) {
        if (actors.indexOf(a) === -1) actors.push(a);
        uses.push({ a: a, u: u });
      }
    });
  });
  var allStubs = Object.keys(stubs).length;
  if (!showOutside) {
    stubs = dict();
    conns = conns.filter(function (c) {
      return inMain[c.c.from] && inMain[c.c.to];
    });
  }
  return {
    main: main,
    stubs: Object.keys(stubs).map(function (id) {
      return VM.S[id];
    }),
    conns: conns,
    actors: actors,
    uses: uses,
    allStubs: allStubs,
  };
}
function catCardH(n, purpose) {
  return (
    HEAD + 2 + (purpose ? 44 : 0) + 12 + Math.min(n, 7) * 20 + (n > 7 ? 20 : 0)
  );
}
function layoutArch(vm) {
  var pos = dict();
  SIZE = dict();
  if (diag && !path.length) return layoutDiagram(vm, pos);
  if (!path.length) {
    // Overview: actors on top, the platform boundary in the middle, outside systems below.
    var GX = CW + 110,
      inside = vm.cats.filter(function (c) {
        return !c.c.external;
      }),
      outside = vm.cats.filter(function (c) {
        return c.c.external;
      });
    var y0 = AH + 150,
      maxH = 0;
    inside.forEach(function (c, i) {
      var n = (vm.topByLane[c.id] || []).length,
        h = catCardH(n, c.c.purpose);
      h = hOf("cat:" + c.id, h);
      pos["cat:" + c.id] = { x: i * GX, y: y0 };
      SIZE["cat:" + c.id] = { w: CW, h: h };
      maxH = Math.max(maxH, h);
    });
    var y1 = y0 + maxH + 180;
    outside.forEach(function (c, i) {
      var n = (vm.topByLane[c.id] || []).length,
        h = catCardH(n, c.c.purpose);
      h = hOf("cat:" + c.id, h);
      pos["cat:" + c.id] = { x: i * GX, y: y1 };
      SIZE["cat:" + c.id] = { w: CW, h: h };
    });
    var span = Math.max(inside.length, outside.length, 1) * GX - 110,
      n = vm.actors.length,
      sp = n ? Math.max(AW + 30, span / n) : 0;
    var ah = vm.actors.reduce(function (m, a) {
      return Math.max(m, hOf("act:" + a.id, AH));
    }, AH);
    vm.actors.forEach(function (a, i) {
      pos["act:" + a.id] = { x: i * sp + (sp - AW) / 2, y: AH - ah };
      SIZE["act:" + a.id] = { w: AW, h: hOf("act:" + a.id, AH) };
    });
    return pos;
  }
  // Inside a service nothing is drawn: its parts are tables (renderLists).
  if (path.length > 1) return pos;
  var L = levelSets(),
    cols = Math.min(L.main.length > 9 ? 4 : 3, Math.max(1, L.main.length));
  var sorted = L.main.slice().sort(function (a, b) {
    return (a.s.order || 0) - (b.s.order || 0);
  });
  // Rows are as tall as their tallest card, so wrapped names never overlap.
  var rowY = PAD_T,
    rowH = 0;
  sorted.forEach(function (x, i) {
    if (i && i % cols === 0) {
      rowY += rowH + 60;
      rowH = 0;
    }
    var h = hOf("svc:" + x.id, SH);
    rowH = Math.max(rowH, h);
    pos["svc:" + x.id] = { x: PAD + (i % cols) * (SW + 70), y: rowY };
    SIZE["svc:" + x.id] = { w: SW, h: h };
  });
  // Things in other categories sit below, compact, four to a row.
  var sy = rowY + rowH + ZGAP + PAD_T,
    SC = 4,
    STH = 58,
    srow = 0;
  L.stubs
    .sort(function (a, b) {
      return (
        (catOf(a.id) || "").localeCompare(catOf(b.id) || "") ||
        (a.s.order || 0) - (b.s.order || 0)
      );
    })
    .forEach(function (x, i) {
      if (i && i % SC === 0) {
        sy += srow + 22;
        srow = 0;
      }
      var h = hOf("svc:" + x.id, STH);
      srow = Math.max(srow, h);
      pos["svc:" + x.id] = { x: PAD + (i % SC) * (SW + 40), y: sy };
      SIZE["svc:" + x.id] = { w: SW, h: h };
    });
  L.actors.forEach(function (a, i) {
    var h = hOf("act:" + a.id, AH);
    pos["act:" + a.id] = { x: PAD + i * (AW + 30), y: -h - 110 };
    SIZE["act:" + a.id] = { w: AW, h: h };
  });
  return pos;
}
// ---------- diagram: every top-level service, store and outside system on one
// page, grouped by lane, with the people on the left and each connection drawn.
var DGAP = 170,
  DROWS = 6,
  HOST_T = 30,
  HOST_PAD = 10;
function diagramLanes(vm) {
  return vm.cats
    .map(function (c) {
      return {
        c: c,
        items: byHost(
          (vm.rootByLane[c.id] || []).slice().sort(function (a, b) {
            return (a.s.order || 0) - (b.s.order || 0);
          }),
        ),
      };
    })
    .filter(function (l) {
      return l.items.length;
    });
}
// The external a box runs on, when the map names one that exists.
function hostOf(x) {
  var h = x.s.host;
  return typeof h === "string" && VM.S[h] && h !== x.id ? h : null;
}
// Keeps the order, but pulls each host's boxes up beside its first one.
function byHost(items) {
  var out = [],
    done = dict();
  items.forEach(function (x) {
    if (done[x.id]) return;
    var h = hostOf(x);
    items.forEach(function (y) {
      if (done[y.id] || (y !== x && (!h || hostOf(y) !== h))) return;
      done[y.id] = true;
      out.push(y);
    });
  });
  return out;
}
// The box a connection is drawn to: the top-level one that holds `id`.
function diagramTop(id) {
  var x = VM.S[id],
    g = 0;
  while (x && x.s.parent && VM.S[x.s.parent] && g++ < 10) x = VM.S[x.s.parent];
  return x ? x.id : null;
}
function layoutDiagram(vm, pos) {
  var lanes = diagramLanes(vm),
    inside = lanes.filter(function (l) {
      return !l.c.c.external;
    }),
    outside = lanes.filter(function (l) {
      return l.c.c.external;
    }),
    x = 0,
    ROW = 20,
    BPAD = 30;
  // Stacks a lane's boxes in columns of `rows`; returns how wide and tall it is.
  function stack(items, x0, y0, rows) {
    var cols = Math.max(1, Math.ceil(items.length / rows)),
      tall = 0;
    for (var c = 0; c < cols; c++) {
      var y = y0,
        col = items.slice(c * rows, (c + 1) * rows);
      col.forEach(function (it, i) {
        var k = "svc:" + it.id,
          h = hOf(k, 58),
          host = hostOf(it),
          prev = i ? hostOf(col[i - 1]) : null;
        // Room for a host's frame and its name above its first box.
        if (host !== prev) y += (host ? HOST_T : 0) + (prev ? HOST_PAD : 0);
        pos[k] = { x: x0 + c * (SW + 36), y: y };
        SIZE[k] = { w: SW, h: h };
        y += h + ROW;
      });
      if (col.length && hostOf(col[col.length - 1])) y += HOST_PAD;
      tall = Math.max(tall, y - y0 - ROW);
    }
    return { w: cols * (SW + 36) - 36, h: tall };
  }
  if (vm.actors.length) {
    var ay = 0;
    vm.actors.forEach(function (a) {
      var k = "act:" + a.id,
        h = hOf(k, AH);
      pos[k] = { x: 0, y: ay };
      SIZE[k] = { w: AW, h: h };
      ay += h + ROW;
    });
    x = AW + DGAP + BPAD;
  }
  inside.forEach(function (l, i) {
    var b = stack(l.items, x, 0, DROWS);
    x += b.w + (i === inside.length - 1 ? DGAP + BPAD : DGAP);
  });
  var oy = 0;
  outside.forEach(function (l) {
    var b = stack(l.items, x, oy, DROWS + 2);
    oy += b.h + PAD + PAD_T + 40;
  });
  return pos;
}
function renderDiagram(vm) {
  var lanes = diagramLanes(vm),
    shown = dict();
  function keysOf(l) {
    return l.items.map(function (x) {
      return "svc:" + x.id;
    });
  }
  var insideKeys = [];
  lanes.forEach(function (l) {
    if (!l.c.c.external) insideKeys = insideKeys.concat(keysOf(l));
  });
  if (insideKeys.length)
    addZone(
      insideKeys,
      LABELS.boundary || CONFIG.name,
      LABELS.boundarySub || "what we build and run",
      "var(--accent)",
      { cls: "boundary", pad: 30 },
    );
  if (vm.actors.length)
    addZone(
      vm.actors.map(function (a) {
        return "act:" + a.id;
      }),
      "People",
      String(vm.actors.length),
      "var(--edge)",
    );
  lanes.forEach(function (l) {
    // When every column starts inside a host's frame, the lane's own name
    // needs room above that frame.
    var rows = l.c.c.external ? DROWS + 2 : DROWS,
      lead = l.items.every(function (x, i) {
        return i % rows !== 0 || hostOf(x);
      });
    addZone(keysOf(l), l.c.c.name, String(l.items.length), lvar(l.c.id), {
      top: lead ? HOST_T - 4 : 0,
    });
    // A frame round the boxes that run on the same host, named after it.
    var hosted = dict();
    l.items.forEach(function (x) {
      var h = hostOf(x);
      if (h) (hosted[h] = hosted[h] || []).push("svc:" + x.id);
    });
    Object.keys(hosted).forEach(function (h) {
      addZone(hosted[h], vm.S[h].s.name, vm.S[h].s.tech || "", lvar(l.c.id), {
        cls: "host",
        tight: true,
      });
    });
    l.items.forEach(function (x) {
      var k = "svc:" + x.id,
        el = svcCard(x, { compact: true });
      cardLayer.appendChild(el);
      cardEls[k] = el;
      shown[k] = true;
    });
  });
  vm.actors.forEach(function (a) {
    var el = actorCard(a);
    cardLayer.appendChild(el);
    cardEls["act:" + a.id] = el;
  });
  // One arrow per pair of boxes, however many connections run between them.
  var agg = dict();
  function add(a, b, label, planned, title, isAsync) {
    if (a === b || !cardEls[a] || !cardEls[b]) return;
    var key = a + ">" + b,
      x = agg[key];
    if (!x)
      x = agg[key] = {
        a: a,
        b: b,
        labels: [],
        titles: [],
        live: false,
        direct: false,
      };
    x.labels.push(label || "");
    x.titles.push(title);
    if (!planned) x.live = true;
    if (!isAsync) x.direct = true;
  }
  vm.actors.forEach(function (a) {
    usesOf(a.p).forEach(function (u) {
      var t = diagramTop(u.to);
      if (!t || !vm.S[t]) return;
      add(
        "act:" + a.id,
        "svc:" + t,
        u.label,
        false,
        a.p.name + " → " + vm.S[t].s.name + ": " + (u.label || ""),
      );
    });
  });
  vm.conns.forEach(function (c) {
    var a = diagramTop(c.c.from),
      b = diagramTop(c.c.to);
    if (!a || !b) return;
    add(
      "svc:" + a,
      "svc:" + b,
      c.c.label,
      c.c.status === "planned",
      vm.S[a].s.name + " → " + vm.S[b].s.name + ": " + (c.c.label || ""),
      c.c.async === true,
    );
  });
  Object.keys(agg).forEach(function (key) {
    var x = agg[key],
      g = mkEdge(true);
    g.a = x.a;
    g.b = x.b;
    g.ortho = true;
    g.label =
      x.labels.length === 1
        ? x.labels[0]
        : x.labels.length +
          (x.a.indexOf("act:") === 0 ? " uses" : " connections");
    if (!x.live) g.g.classList.add("planned");
    else if (!x.direct) g.g.classList.add("async");
    var t = document.createElementNS(NS, "title");
    t.textContent = x.titles.join("\n");
    g.g.appendChild(t);
    edgeEls.push(g);
  });
}
// Right-angled arrows. Each leaves the side of its box that faces the target,
// runs to the gutter beside the target and turns in. One that would cross a
// box on the way goes round, above or below everything.
function routeDiagram() {
  var rects = Object.keys(cardEls).map(function (k) {
      var q = posOf(k, DEF),
        z = SIZE[k] || { w: SW, h: 58 };
      return { k: k, x: q.x, y: q.y, w: z.w, h: z.h };
    }),
    R = dict(),
    top = Infinity,
    bottom = -Infinity;
  rects.forEach(function (r) {
    R[r.k] = r;
    top = Math.min(top, r.y);
    bottom = Math.max(bottom, r.y + r.h);
  });
  top -= PAD_T + 30 + 18;
  bottom += PAD + 30 + 18;
  var list = edgeEls
    .filter(function (g) {
      return g.ortho && R[g.a] && R[g.b];
    })
    .map(function (g) {
      var A = R[g.a],
        B = R[g.b],
        same = A.x < B.x + B.w && B.x < A.x + A.w,
        dir = same || B.x > A.x ? 1 : -1;
      return {
        g: g,
        A: A,
        B: B,
        same: same,
        // The side each end is on: 1 is the right side, -1 the left.
        out: dir,
        into: same ? 1 : -dir,
      };
    });
  // Ends on the same side of a box are spread along it, in the order of what
  // they lead to, so arrows fan out without crossing.
  function spread(end, side, other) {
    var groups = dict();
    list.forEach(function (e) {
      var key = e[end].k + "|" + e[side];
      (groups[key] = groups[key] || []).push(e);
    });
    Object.keys(groups).forEach(function (key) {
      var es = groups[key].sort(function (p, q) {
        return p[other].y - q[other].y || p[other].x - q[other].x;
      });
      es.forEach(function (e, i) {
        var box = e[end];
        e[end === "A" ? "y1" : "y2"] =
          box.y + (box.h * (i + 1)) / (es.length + 1);
        if (end === "B") e.crowd = es.length;
      });
    });
  }
  spread("A", "out", "B");
  spread("B", "into", "A");
  // Each vertical run takes its own slot in its gutter.
  var slots = dict();
  function slot(x, side) {
    var key = Math.round(x) + "|" + side,
      n = slots[key] || 0;
    slots[key] = n + 1;
    return 14 + (n % 13) * 7;
  }
  function blocked(x1, y1, x2, y2, e) {
    var lx = Math.min(x1, x2),
      hx = Math.max(x1, x2),
      ly = Math.min(y1, y2),
      hy = Math.max(y1, y2);
    return rects.some(function (r) {
      return (
        r !== e.A &&
        r !== e.B &&
        lx < r.x + r.w + 4 &&
        hx > r.x - 4 &&
        ly < r.y + r.h + 4 &&
        hy > r.y - 4
      );
    });
  }
  var over = 0,
    under = 0;
  list.forEach(function (e) {
    var x1 = e.out === 1 ? e.A.x + e.A.w : e.A.x,
      x2 = e.into === 1 ? e.B.x + e.B.w : e.B.x,
      pts;
    if (e.same) {
      var loop = Math.max(x1, x2) + slot(Math.max(x1, x2), 1);
      pts = [
        [x1, e.y1],
        [loop, e.y1],
        [loop, e.y2],
        [x2, e.y2],
      ];
    } else {
      var mx = x2 + e.into * slot(x2, e.into);
      if (
        blocked(x1, e.y1, mx, e.y1, e) ||
        blocked(mx, e.y1, mx, e.y2, e) ||
        blocked(mx, e.y2, x2, e.y2, e)
      ) {
        var ex = x1 + e.out * slot(x1, e.out),
          up = (e.y1 + e.y2) / 2 - top < bottom - (e.y1 + e.y2) / 2,
          cy = up ? top - 8 * over++ : bottom + 8 * under++;
        pts = [
          [x1, e.y1],
          [ex, e.y1],
          [ex, cy],
          [mx, cy],
          [mx, e.y2],
          [x2, e.y2],
        ];
      } else
        pts = [
          [x1, e.y1],
          [mx, e.y1],
          [mx, e.y2],
          [x2, e.y2],
        ];
    }
    // Corners are rounded by as much as the shorter leg allows.
    var d = "M" + pts[0][0] + " " + pts[0][1];
    for (var i = 1; i < pts.length - 1; i++) {
      var p = pts[i - 1],
        c = pts[i],
        n = pts[i + 1],
        r = Math.min(
          8,
          (Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1])) / 2,
          (Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1])) / 2,
        ),
        bx = c[0] - Math.sign(c[0] - p[0]) * r,
        by = c[1] - Math.sign(c[1] - p[1]) * r,
        ax = c[0] + Math.sign(n[0] - c[0]) * r,
        ay = c[1] + Math.sign(n[1] - c[1]) * r;
      d += "L" + bx + " " + by + "Q" + c[0] + " " + c[1] + " " + ax + " " + ay;
    }
    d += "L" + x2 + " " + e.y2;
    e.g.p.setAttribute("d", d);
    // The arrowhead points into the box.
    var hx = x2 + e.into * 9;
    e.g.m.setAttribute(
      "d",
      "M" +
        hx +
        " " +
        (e.y2 - 4.5) +
        "L" +
        x2 +
        " " +
        e.y2 +
        "L" +
        hx +
        " " +
        (e.y2 + 4.5),
    );
    e.g.o.setAttribute("d", "");
    if (e.g.t) {
      var label = e.g.label || "";
      if (label.length > 30) label = label.slice(0, 28).trimEnd() + "…";
      e.g.t.setAttribute("text-anchor", e.into === 1 ? "start" : "end");
      e.g.t.setAttribute("x", x2 + e.into * 14);
      e.g.t.setAttribute("y", e.y2 - 4);
      e.g.t.textContent = label;
      // A label is always shown unless too many arrive together to read them;
      // those show on hover, like everywhere else on the map.
      e.g.g.classList.toggle("lbl", e.crowd <= 3);
    }
  });
}
function openDiagram() {
  diag = true;
  path = [];
  view = "arch";
  sel = null;
  per = null;
  hov = null;
  hidePanel();
  NAV = [];
  render();
  fitAll();
  syncHash(true);
}
function flowNodes(f) {
  var order = [];
  (f.steps || []).forEach(function (st) {
    [st.from, st.to].forEach(function (n) {
      if (n && order.indexOf(n) === -1) order.push(n);
    });
  });
  return order;
}
function layoutFlow(vm) {
  var pos = dict(),
    f = vm.FL[flowId] && vm.FL[flowId].f;
  SIZE = dict();
  if (!f) return pos;
  var nodes = flowNodes(f),
    acts = nodes.filter(function (n) {
      return n.indexOf("persona:") === 0 && vm.PER[n.slice(8)];
    });
  var svcs = nodes.filter(function (n) {
      return vm.S[n];
    }),
    cols = [];
  vm.cats.forEach(function (c) {
    var list = svcs.filter(function (id) {
      return catOf(id) === c.id;
    });
    if (list.length) cols.push(list);
  });
  cols.forEach(function (list, ci) {
    var y = AH + 170;
    list.forEach(function (id) {
      var h = hOf("svc:" + id, SH);
      pos["svc:" + id] = { x: ci * (SW + 150), y: y };
      SIZE["svc:" + id] = { w: SW, h: h };
      y += h + 70;
    });
  });
  acts.forEach(function (n, i) {
    var k = "act:" + n.slice(8);
    pos[k] = { x: i * (AW + 50), y: 0 };
    SIZE[k] = { w: AW, h: hOf(k, AH) };
  });
  return pos;
}
function scope() {
  return view === "schema"
    ? "schema"
    : view === "flow"
      ? "flow/" + flowId
      : diag
        ? "diagram"
        : "arch/" + path.join("/");
}
function posOf(key, def) {
  return P[scope() + "|" + key] || def[key];
}

// ---------- render
var cardEls = dict(),
  zoneEls = [],
  edgeEls = [],
  DEF = dict();
// Empty layers say so and name the command that fills them.
var EMPTY = {
  overview:
    "Nothing on the map yet. Ask your AI agent to run <code>archmap brief --task setup</code> and follow it to draft the map from your code.",
  data: "No tables recorded yet. Ask your AI agent to run <code>archmap brief</code> and follow it.",
  flows:
    "No flows recorded yet. Ask your AI agent to run <code>archmap brief</code> and follow it.",
  personas:
    "No personas recorded yet. Ask your AI agent to run <code>archmap brief</code> and follow it.",
};
function emptyState(key, cls) {
  return (
    '<div class="empty-state' +
    (cls ? " " + cls : "") +
    '" role="status"><p>' +
    EMPTY[key] +
    "</p></div>"
  );
}
// How much each layer of the map holds; an empty layer shows its empty state.
function layerCount(name) {
  var all = VM.services,
    parts = all.filter(function (x) {
      return x.s.parent;
    }).length;
  if (name === "overview") return all.length - parts;
  if (name === "parts") return parts;
  if (name === "data") return VM.tables.length;
  if (name === "people")
    return Object.keys(VM.B.personas).length + Object.keys(VM.B.flows).length;
  return 0;
}
function showCanvasEmpty(key) {
  var old = vp.querySelector(".empty-state.canvas");
  if (old) old.remove();
  if (!key) return;
  vp.insertAdjacentHTML("beforeend", emptyState(key, "canvas"));
}
function render() {
  if (
    view === "arch" &&
    path.length &&
    !VM.cats.some(function (c) {
      return c.id === path[0];
    })
  )
    path = [];
  if (view === "arch" && path.length > 1 && !VM.S[path[path.length - 1]])
    path = path.slice(0, 1);
  if (view === "flow" && !VM.FL[flowId]) {
    view = "arch";
    path = [];
  }
  if (view !== "arch" || path.length) diag = false;
  cardLayer.innerHTML = "";
  zoneLayer.innerHTML = "";
  svg.innerHTML = "";
  cardEls = dict();
  edgeEls = [];
  zoneEls = [];
  MH = dict();
  if (view === "schema") renderSchema();
  else if (view === "flow") renderFlow();
  else renderArch();
  $("lists").hidden = view !== "arch" || path.length < 2;
  if (!$("lists").hidden) renderLists();
  showCanvasEmpty(
    view === "schema" && !VM.tables.length
      ? "data"
      : view === "arch" && !path.length && layerCount("overview") === 0
        ? "overview"
        : "",
  );
  if (view !== "schema") {
    // Measure each card as rendered, then lay out again so rows and arrows fit real heights.
    Object.keys(cardEls).forEach(function (k) {
      MH[k] = cardEls[k].offsetHeight;
    });
    DEF = view === "flow" ? layoutFlow(VM) : layoutArch(VM);
  }
  place();
  apply();
  renderChrome();
  scheduleMini();
}
function keyBadges(st) {
  return st ? '<span class="badge ' + esc(st) + '">' + esc(st) + "</span>" : "";
}
function renderSchema() {
  var vm = VM;
  DEF = layoutSchema(vm);
  areaOrder(vm).forEach(function (id) {
    var el = document.createElement("div");
    el.className = "zone";
    el.style.setProperty("--z", zvar(id));
    var n = vm.tables.filter(function (t) {
      return t.t.area === id;
    }).length;
    el.innerHTML =
      "<b>" + esc(vm.areas[id].name) + "<span>" + n + " tables</span></b>";
    zoneLayer.appendChild(el);
    zoneEls.push({
      el: el,
      keys: vm.tables
        .filter(function (t) {
          return t.t.area === id;
        })
        .map(function (t) {
          return t.name;
        }),
      hFor: function (k) {
        return vm.T[k].h;
      },
      w: W,
    });
  });
  vm.tables.forEach(function (t) {
    var el = document.createElement("div");
    el.className = "card" + (t.st ? " " + t.st : "");
    el.dataset.key = t.name;
    el.dataset.kind = "table";
    el.style.setProperty("--z", zvar(t.t.area));
    cardRole(el, "Table " + t.name);
    var h =
      '<div class="head"><span class="tn">' +
      esc(t.name) +
      "</span>" +
      keyBadges(t.st) +
      "</div>";
    t.cols.forEach(function (x, i) {
      var c = x.c,
        key = "<span></span>";
      if (c.pk) key = '<span class="k pk">PK</span>';
      else if (c.fk)
        key =
          '<span class="k fk" style="--zk:' +
          esc(zvar(vm.T[c.fk] ? vm.T[c.fk].t.area : "records")) +
          '">FK</span>';
      else if (c.unique) key = '<span class="k u">U</span>';
      else if (c.enum) key = '<span class="k en">E</span>';
      var ty = colType(c, vm.B);
      var tip =
        c.name +
        " · " +
        ty +
        (c.fk ? " → " + c.fk : "") +
        (c.desc ? "\n" + c.desc : "");
      h +=
        '<div class="row' +
        (x.st ? " " + x.st : "") +
        '" data-i="' +
        i +
        '" title="' +
        esc(tip) +
        '">' +
        key +
        '<span class="cn">' +
        esc(c.name) +
        '</span><span class="ty">' +
        esc(ty) +
        "</span></div>";
    });
    h += '<div class="foot">created_at · updated_at</div>';
    el.innerHTML = h;
    cardLayer.appendChild(el);
    cardEls[t.name] = el;
  });
  vm.edges.forEach(function (e) {
    var g = mkEdge();
    if (e.st) g.g.classList.add(e.st);
    g.e = e;
    edgeEls.push(g);
  });
}
function renderArch() {
  var vm = VM;
  DEF = layoutArch(vm);
  if (diag && !path.length) {
    renderDiagram(vm);
    return;
  }
  if (!path.length) {
    var inside = vm.cats.filter(function (c) {
        return !c.c.external;
      }),
      outside = vm.cats.filter(function (c) {
        return c.c.external;
      });
    if (inside.length)
      addZone(
        inside.map(function (c) {
          return "cat:" + c.id;
        }),
        LABELS.boundary || CONFIG.name,
        LABELS.boundarySub || "what we build and run",
        "var(--accent)",
        { cls: "boundary" },
      );
    if (outside.length)
      addZone(
        outside.map(function (c) {
          return "cat:" + c.id;
        }),
        LABELS.outside || "Outside",
        LABELS.outsideSub || "services and systems we use",
        "var(--edge)",
      );
    vm.cats.forEach(function (c) {
      var items = (vm.rootByLane[c.id] || []).slice().sort(function (a, b) {
        return (a.s.order || 0) - (b.s.order || 0);
      });
      var st = c.st;
      var el = document.createElement("div"),
        k = "cat:" + c.id;
      el.className =
        "card cat" + (c.c.external ? " ext" : "") + (st ? " " + st : "");
      el.dataset.key = k;
      el.style.setProperty("--z", lvar(c.id));
      cardRole(el, "Open " + c.c.name);
      el.innerHTML =
        '<div class="head"><span class="tn">' +
        esc(c.c.name) +
        '</span></div><div class="meta"><span class="mt">' +
        esc(c.c.external ? LABELS.outside || "Outside" : "Category") +
        "</span>" +
        keyBadges(st) +
        '<span class="drill">Open ›</span></div>' +
        (c.c.purpose
          ? '<div class="cpur">' + esc(c.c.purpose) + "</div>"
          : "") +
        '<div class="clist">' +
        items
          .slice(0, 7)
          .map(function (x) {
            return (
              '<div class="ci' +
              (x.st ? " " + esc(x.st) : "") +
              '"><span class="ico">' +
              ICON[stype(x.s)] +
              "</span>" +
              esc(x.s.name) +
              (x.s.status && x.s.status !== "live"
                ? ' <span class="cst">' + esc(x.s.status) + "</span>"
                : "") +
              "</div>"
            );
          })
          .join("") +
        (items.length > 7
          ? '<div class="more">+ ' + (items.length - 7) + " more</div>"
          : "") +
        (items.length ? "" : '<div class="more">Nothing recorded yet</div>') +
        "</div>";
      cardLayer.appendChild(el);
      cardEls[k] = el;
    });
    vm.actors.forEach(function (a) {
      var el = actorCard(a);
      cardLayer.appendChild(el);
      cardEls["act:" + a.id] = el;
      var byCat = dict();
      usesOf(a.p).forEach(function (u) {
        var c = catOf(u.to);
        if (c && cardEls["cat:" + c]) (byCat[c] = byCat[c] || []).push(u);
      });
      Object.keys(byCat).forEach(function (c) {
        var g = mkEdge(true);
        g.a = "act:" + a.id;
        g.b = "cat:" + c;
        g.label =
          byCat[c].length === 1 ? byCat[c][0].label : byCat[c].length + " uses";
        edgeEls.push(g);
      });
    });
    var agg = dict();
    vm.conns.forEach(function (c) {
      var a = catOf(c.c.from),
        b = catOf(c.c.to);
      if (!a || !b || a === b) return;
      var key = a + ">" + b;
      (agg[key] = agg[key] || { a: a, b: b, list: [] }).list.push(c);
    });
    Object.keys(agg).forEach(function (key) {
      var x = agg[key];
      if (!cardEls["cat:" + x.a] || !cardEls["cat:" + x.b]) return;
      var g = mkEdge(true);
      g.a = "cat:" + x.a;
      g.b = "cat:" + x.b;
      g.label =
        x.list.length === 1
          ? x.list[0].c.label || ""
          : x.list.length + " connections";
      if (
        x.list.every(function (c) {
          return c.c.status === "planned";
        })
      )
        g.g.classList.add("planned");
      var t = document.createElementNS(NS, "title");
      t.textContent = x.list
        .map(function (c) {
          return (
            vm.S[c.c.from].s.name +
            " → " +
            vm.S[c.c.to].s.name +
            ": " +
            (c.c.label || "")
          );
        })
        .join("\n");
      g.g.appendChild(t);
      edgeEls.push(g);
    });
    return;
  }
  if (path.length > 1) return;
  var L = levelSets(),
    lastName = (
      vm.cats.filter(function (c) {
        return c.id === path[0];
      })[0] || { c: { name: path[0] } }
    ).c.name;
  var mainKeys = L.main.map(function (x) {
      return "svc:" + x.id;
    }),
    stubKeys = L.stubs.map(function (x) {
      return "svc:" + x.id;
    }),
    zoneColour = path[0];
  [[mainKeys, lastName, zoneColour]]
    .concat([[stubKeys, "Talks to, in other categories", "records"]])
    .forEach(function (z) {
      if (!z[0].length) return;
      var el = document.createElement("div");
      el.className = "zone";
      el.style.setProperty("--z", lvar(z[2]));
      el.innerHTML = "<b>" + esc(z[1]) + "<span>" + z[0].length + "</span></b>";
      zoneLayer.appendChild(el);
      zoneEls.push({
        el: el,
        keys: z[0],
        hFor: function (k) {
          return SIZE[k].h;
        },
        w: SW,
      });
    });
  if (!L.main.length) {
    var em = document.createElement("div");
    em.className = "zone";
    em.style.setProperty("--z", "var(--l-platform)");
    em.innerHTML =
      "<b>" +
      esc(lastName) +
      "<span>Nothing recorded here yet.</span></b>";
    zoneLayer.appendChild(em);
    zoneEls.push({ el: em, keys: [], fixed: { x: 0, y: 0, w: 640, h: 120 } });
  }
  L.main.concat(L.stubs).forEach(function (x) {
    var k = "svc:" + x.id,
      el = svcCard(x, { stub: stubKeys.indexOf(k) !== -1 });
    cardLayer.appendChild(el);
    cardEls[k] = el;
  });
  L.actors.forEach(function (a) {
    var el = actorCard(a);
    cardLayer.appendChild(el);
    cardEls["act:" + a.id] = el;
  });
  L.uses.forEach(function (x) {
    var g = mkEdge(true);
    g.a = "act:" + x.a.id;
    g.b = "svc:" + x.u.to;
    g.label = x.u.label || "";
    edgeEls.push(g);
  });
  L.conns.forEach(function (c) {
    var g = mkEdge(true);
    g.c = c;
    g.a = "svc:" + c.c.from;
    g.b = "svc:" + c.c.to;
    g.label = c.c.label || "";
    if (c.st) g.g.classList.add(c.st);
    if (c.c.status === "planned") g.g.classList.add("planned");
    else if (c.c.async) g.g.classList.add("async");
    edgeEls.push(g);
  });
}
function renderFlow() {
  var vm = VM,
    fx = vm.FL[flowId];
  DEF = layoutFlow(vm);
  if (!fx) return;
  var f = fx.f,
    nodes = flowNodes(f);
  vm.cats.forEach(function (c) {
    var keys = nodes
      .filter(function (n) {
        return vm.S[n] && catOf(n) === c.id;
      })
      .map(function (n) {
        return "svc:" + n;
      });
    if (keys.length) addZone(keys, c.c.name, "", lvar(c.id));
  });
  nodes.forEach(function (n) {
    if (n.indexOf("persona:") === 0) {
      var a = vm.PER[n.slice(8)];
      if (a) {
        var el = actorCard(a);
        cardLayer.appendChild(el);
        cardEls["act:" + a.id] = el;
      }
    } else if (vm.S[n]) {
      var el2 = svcCard(vm.S[n]);
      cardLayer.appendChild(el2);
      cardEls["svc:" + n] = el2;
    }
  });
  var pairCount = dict();
  (f.steps || []).forEach(function (st, i) {
    var a = keyOf(st.from),
      b = keyOf(st.to);
    if (!cardEls[a] || !cardEls[b] || a === b) return;
    var pk = [a, b].sort().join("|"),
      k = (pairCount[pk] = (pairCount[pk] || 0) + 1);
    var g = mkEdge(true);
    g.a = a;
    g.b = b;
    g.step = i;
    g.label = i + 1 + ". " + (st.label || "");
    g.curve = (k - 1) * 46 * (k % 2 ? 1 : -1);
    if (st.status === "planned") g.g.classList.add("planned");
    edgeEls.push(g);
  });
}
function keyOf(n) {
  return !n
    ? ""
    : n.indexOf("persona:") === 0
      ? "act:" + n.slice(8)
      : "svc:" + n;
}
function stepOk(st) {
  var vm = VM,
    a = st.from,
    b = st.to;
  if (!b || a === b) return true;
  // A person isn't on the map's connections: their step only needs the persona to exist.
  if (a.indexOf("persona:") === 0) return !!vm.PER[a.slice(8)];
  if (b.indexOf("persona:") === 0) return !!vm.PER[b.slice(8)];
  return vm.conns.some(function (c) {
    return (c.c.from === a && c.c.to === b) || (c.c.from === b && c.c.to === a);
  });
}
function mkEdge(labelled) {
  var g = document.createElementNS(NS, "g"),
    p = document.createElementNS(NS, "path"),
    m = document.createElementNS(NS, "path"),
    o = document.createElementNS(NS, "path");
  g.appendChild(p);
  g.appendChild(m);
  g.appendChild(o);
  var t = null;
  if (labelled) {
    t = document.createElementNS(NS, "text");
    t.setAttribute("text-anchor", "middle");
    g.appendChild(t);
  }
  svg.appendChild(g);
  return { g: g, p: p, m: m, o: o, t: t };
}
function edgeEnds(g) {
  return g.e ? [g.e.s, g.e.t] : [g.a, g.b];
}
// Positions every box, zone and edge; with `only`, just that box and the zones
// and edges it is part of (a box being dragged).
function place(only) {
  (only ? [only] : Object.keys(cardEls)).forEach(function (k) {
    if (!cardEls[k]) return;
    var q = posOf(k, DEF);
    cardEls[k].style.left = q.x + "px";
    cardEls[k].style.top = q.y + "px";
  });
  zoneEls.forEach(function (z) {
    if (only && (z.fixed || z.keys.indexOf(only) === -1)) return;
    if (z.fixed) {
      z.box = z.fixed;
    } else {
      var x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      z.keys.forEach(function (k) {
        var q = posOf(k, DEF),
          zw = z.w || (SIZE[k] || { w: SW }).w;
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x + zw);
        y1 = Math.max(y1, q.y + z.hFor(k));
      });
      var zp = z.pad || 0;
      z.box = z.tight
        ? {
            x: x0 - HOST_PAD,
            y: y0 - HOST_T + 4,
            w: x1 - x0 + HOST_PAD * 2,
            h: y1 - y0 + HOST_T - 4 + HOST_PAD,
          }
        : {
            x: x0 - PAD - zp,
            y: y0 - PAD_T - zp - (z.top || 0),
            w: x1 - x0 + PAD * 2 + zp * 2,
            h: y1 - y0 + PAD_T + PAD + zp * 2 + (z.top || 0),
          };
    }
    z.el.style.left = z.box.x + "px";
    z.el.style.top = z.box.y + "px";
    z.el.style.width = z.box.w + "px";
    z.el.style.height = z.box.h + "px";
  });
  // The diagram's arrows share gutters, so they are all routed together.
  if (
    edgeEls.some(function (g) {
      return g.ortho;
    })
  )
    routeDiagram();
  edgeEls.forEach(function (g) {
    if (g.ortho) return;
    if (only && edgeEnds(g).indexOf(only) === -1) return;
    if (g.e) {
      var S = posOf(g.e.s, DEF),
        G = posOf(g.e.t, DEF),
        w = W,
        y1 = S.y + 1 + HEAD + g.e.si * ROW + ROW / 2,
        y2 = G.y + 1 + HEAD + ROW / 2;
      var scx = S.x + w / 2,
        tcx = G.x + w / 2,
        x1,
        x2,
        ds,
        dt,
        d;
      if (Math.abs(scx - tcx) < w * 0.9) {
        x1 = S.x + w;
        x2 = G.x + w;
        ds = 1;
        dt = 1;
        var cx = Math.max(x1, x2) + 70;
        d =
          "M" +
          x1 +
          " " +
          y1 +
          "C" +
          cx +
          " " +
          y1 +
          " " +
          cx +
          " " +
          y2 +
          " " +
          x2 +
          " " +
          y2;
      } else {
        if (tcx > scx) {
          x1 = S.x + w;
          ds = 1;
          x2 = G.x;
          dt = -1;
        } else {
          x1 = S.x;
          ds = -1;
          x2 = G.x + w;
          dt = 1;
        }
        var k = Math.max(50, Math.abs(x2 - x1) / 2);
        d =
          "M" +
          x1 +
          " " +
          y1 +
          "C" +
          (x1 + ds * k) +
          " " +
          y1 +
          " " +
          (x2 + dt * k) +
          " " +
          y2 +
          " " +
          x2 +
          " " +
          y2;
      }
      g.p.setAttribute("d", d);
      var tip = x1 + ds * 10;
      g.m.setAttribute(
        "d",
        "M" +
          tip +
          " " +
          y1 +
          "L" +
          x1 +
          " " +
          (y1 - 5) +
          "M" +
          tip +
          " " +
          y1 +
          "L" +
          x1 +
          " " +
          y1 +
          "M" +
          tip +
          " " +
          y1 +
          "L" +
          x1 +
          " " +
          (y1 + 5),
      );
      var bx = x2 + dt * 7;
      g.o.setAttribute(
        "d",
        "M" + bx + " " + (y2 - 5) + "L" + bx + " " + (y2 + 5),
      );
      return;
    }
    // boxes: straight line between the facing edges, arrowhead at the target, label in the middle
    var A = posOf(g.a, DEF),
      B = posOf(g.b, DEF),
      sa = SIZE[g.a],
      sb = SIZE[g.b];
    var ac = { x: A.x + sa.w / 2, y: A.y + sa.h / 2 },
      bc = { x: B.x + sb.w / 2, y: B.y + sb.h / 2 };
    function anchor(c, s, to) {
      var dx = to.x - c.x,
        dy = to.y - c.y,
        tx = dx ? s.w / 2 / Math.abs(dx) : Infinity,
        ty = dy ? s.h / 2 / Math.abs(dy) : Infinity,
        t = Math.min(tx, ty);
      return { x: c.x + dx * t, y: c.y + dy * t };
    }
    var p1 = anchor(ac, sa, bc),
      p2 = anchor(bc, sb, ac),
      ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    var mx = (p1.x + p2.x) / 2,
      my = (p1.y + p2.y) / 2,
      lx = mx,
      ly = my - 5;
    if (g.curve) {
      var len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
        nx = -(p2.y - p1.y) / len,
        ny = (p2.x - p1.x) / len,
        cx = mx + nx * g.curve * 2,
        cy = my + ny * g.curve * 2;
      g.p.setAttribute(
        "d",
        "M" + p1.x + " " + p1.y + "Q" + cx + " " + cy + " " + p2.x + " " + p2.y,
      );
      ang = Math.atan2(p2.y - cy, p2.x - cx);
      lx = mx + nx * g.curve;
      ly = my + ny * g.curve - 5;
    } else
      g.p.setAttribute("d", "M" + p1.x + " " + p1.y + "L" + p2.x + " " + p2.y);
    g.m.setAttribute(
      "d",
      "M" +
        (p2.x - 10 * Math.cos(ang - 0.45)) +
        " " +
        (p2.y - 10 * Math.sin(ang - 0.45)) +
        "L" +
        p2.x +
        " " +
        p2.y +
        "L" +
        (p2.x - 10 * Math.cos(ang + 0.45)) +
        " " +
        (p2.y - 10 * Math.sin(ang + 0.45)),
    );
    g.o.setAttribute("d", "");
    if (g.t) {
      g.t.setAttribute("x", lx);
      g.t.setAttribute("y", ly);
      g.t.textContent = g.label || "";
    }
  });
}

// ---------- highlighting: hover, selection, persona, search
function matchKey(k) {
  if (!query) return false;
  if (view === "schema") {
    return tableMatches(VM.T[k]);
  }
  if (k.indexOf("cat:") === 0) {
    var c = VM.cats.filter(function (x) {
      return "cat:" + x.id === k;
    })[0];
    return !!c && c.c.name.toLowerCase().indexOf(query) !== -1;
  }
  return serviceMatches(VM.S[k.slice(4)]);
}
// The query is lower case; names are compared lower case too.
function has(text) {
  return (
    String(text || "")
      .toLowerCase()
      .indexOf(query) !== -1
  );
}
function tableMatches(t) {
  return (
    !!t &&
    (has(t.name) ||
      t.cols.some(function (x) {
        return has(x.c.name);
      }))
  );
}
function serviceMatches(s) {
  return !!s && has(s.s.name);
}
function related(k) {
  var set = new Set([k]);
  edgeEls.forEach(function (g) {
    var a = g.e ? g.e.s : g.a,
      b = g.e ? g.e.t : g.b;
    if (a === k) set.add(b);
    if (b === k) set.add(a);
  });
  return set;
}
function apply() {
  filterLists();
  document.querySelectorAll(".badge.w, .badge.r").forEach(function (b) {
    b.remove();
  });
  document.querySelectorAll(".row.hl").forEach(function (r) {
    r.classList.remove("hl");
  });
  var fade = view === "schema" && $("fadePerson").checked;
  // A persona dims the schema only when the data says which tables personas use.
  if (per && view === "schema" && VM.PER[per] && VM.personaTables) {
    var pt = VM.PER[per].tables;
    Object.keys(cardEls).forEach(function (k) {
      var el = cardEls[k],
        mode = pt[k];
      el.classList.remove("on", "rel", "match");
      el.classList.toggle("pon", !!mode);
      el.classList.toggle("dim", !mode);
      if (mode) {
        var b = document.createElement("span");
        b.className = "badge " + mode;
        b.textContent = mode === "w" ? "writes" : "reads";
        el.querySelector(".head").appendChild(b);
      }
    });
    edgeEls.forEach(function (g) {
      var both = !!pt[g.e.s] && !!pt[g.e.t];
      g.g.classList.toggle("hl", both);
      g.g.classList.toggle("dim", !both);
      g.g.classList.remove("faint");
    });
  } else if (view === "flow") {
    var fx = VM.FL[flowId],
      cur = fx && fx.f.steps ? fx.f.steps[flowStep] : null,
      ends = cur ? [keyOf(cur.from), keyOf(cur.to)] : [];
    Object.keys(cardEls).forEach(function (k) {
      var el = cardEls[k];
      el.classList.remove("pon", "rel", "match", "dim");
      el.classList.toggle("on", ends.indexOf(k) !== -1);
    });
    edgeEls.forEach(function (g) {
      g.g.classList.toggle("hl", g.step === flowStep);
      g.g.classList.toggle("other", g.step !== flowStep);
      g.g.classList.remove("dim", "faint");
    });
  } else {
    var f = hov || (sel && sel.view === view ? sel.key : null),
      rel = f ? related(f) : null,
      fl = !f && (filtHover || FILT),
      fm = dict();
    // Each box is checked against the filter once, not once per edge too.
    var filtered = function (k) {
      if (!(k in fm)) fm[k] = filterMatch(k, fl);
      return fm[k];
    };
    Object.keys(cardEls).forEach(function (k) {
      var el = cardEls[k],
        m = matchKey(k);
      el.classList.remove("pon");
      el.classList.toggle("on", k === f);
      el.classList.toggle("rel", !!rel && rel.has(k) && k !== f);
      el.classList.toggle("match", !f && m);
      el.classList.toggle(
        "dim",
        rel ? !rel.has(k) : fl ? !filtered(k) : !!query && !m,
      );
    });
    edgeEls.forEach(function (g) {
      var a = g.e ? g.e.s : g.a,
        b = g.e ? g.e.t : g.b,
        touch = !!f && (a === f || b === f);
      g.g.classList.toggle("hl", touch);
      g.g.classList.toggle(
        "dim",
        f ? !touch : !!fl && !(filtered(a) && filtered(b)),
      );
      g.g.classList.remove("other");
      g.g.classList.toggle("faint", !f && fade && g.e && g.e.t === "person");
      if (touch && g.e) {
        cardEls[g.e.s]
          .querySelector('.row[data-i="' + g.e.si + '"]')
          .classList.add("hl");
        cardEls[g.e.t].querySelector('.row[data-i="0"]').classList.add("hl");
      }
    });
  }
  document.querySelectorAll("#personas .pchip").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.p === per));
  });
  cardStates();
}
// The highlight is also said in words and shape, not colour alone: the selected
// box is aria-current, and each box's label names its state.
var STATE_TEXT = [
  ["on", "selected"],
  ["pon", "used by the persona"],
  ["rel", "connected to the selection"],
  ["match", "matches the search"],
  ["dim", "faded"],
];
function cardStates() {
  var selKey = sel && sel.view === view ? sel.key : null;
  Object.keys(cardEls).forEach(function (k) {
    var el = cardEls[k],
      words = [];
    STATE_TEXT.forEach(function (x) {
      if (el.classList.contains(x[0])) words.push(x[1]);
    });
    var label =
      (el.dataset.label || "") + (words.length ? ", " + words.join(", ") : "");
    if (el.getAttribute("aria-label") !== label)
      el.setAttribute("aria-label", label);
    if (k === selKey) el.setAttribute("aria-current", "true");
    else if (el.hasAttribute("aria-current"))
      el.removeAttribute("aria-current");
  });
}

// ---------- filter bar (status and type), IcePanel-style: hover highlights, click focuses
var FILT = null,
  filtHover = null;
function svcsForKey(k) {
  if (k.indexOf("svc:") === 0)
    return VM.S[k.slice(4)] ? [VM.S[k.slice(4)]] : [];
  if (k.indexOf("cat:") === 0) return VM.byLane[k.slice(4)] || [];
  return [];
}
function filterMatch(k, fl) {
  return svcsForKey(k).some(function (x) {
    return fl.k === "status"
      ? (x.s.status || "live") === fl.v
      : stype(x.s) === fl.v;
  });
}
function renderFilters() {
  var box = $("filters");
  if (view === "schema") {
    box.innerHTML =
      '<span class="lg"><span class="k pk">PK</span>primary key</span><span class="lg"><span class="k fk" style="--zk:var(--edge)">FK</span>foreign key</span><span class="lg"><span class="k u">U</span>unique</span><span class="lg"><span class="k en">E</span>enum</span><span class="lg">crow\'s foot: many → one</span>';
    return;
  }
  var seen = new Set();
  Object.keys(cardEls).forEach(function (k) {
    svcsForKey(k).forEach(function (x) {
      seen.add(x);
    });
  });
  var pool = Array.from(seen);
  function group(label, kname, values, val) {
    return (
      '<span class="fg"><span class="fl">' +
      label +
      "</span>" +
      values
        .map(function (v) {
          var n = pool.filter(function (x) {
            return val(x) === v;
          }).length;
          if (!n) return "";
          var on = FILT && FILT.k === kname && FILT.v === v;
          return (
            '<button type="button" class="fchip' +
            (on ? " on" : "") +
            '" data-k="' +
            kname +
            '" data-v="' +
            esc(v) +
            '">' +
            (kname === "type"
              ? '<span class="ico">' + ICON[v] + "</span>"
              : '<i class="dot s-' + esc(v.replace(/ /g, "-")) + '"></i>') +
            esc(kname === "type" ? TYPE_LABEL[v] : v) +
            " <span>" +
            n +
            "</span></button>"
          );
        })
        .join("") +
      "</span>"
    );
  }
  var outsideN = view === "arch" && path.length ? levelSets().allStubs : 0;
  box.innerHTML =
    group("Status", "status", ["live", "planned", "retiring"], function (x) {
      return x.s.status || "live";
    }) +
    (showTypes
      ? group(
          "Type",
          "type",
          [
            "app",
            "store",
            "job",
            "platform",
            "external",
            "group",
            "endpoint",
            "module",
            "library",
            "tool",
            "container",
          ],
          function (x) {
            return stype(x.s);
          },
        )
      : "") +
    '<button type="button" class="linkbtn" id="fMore">' +
    (showTypes ? "Fewer filters" : "More filters") +
    "</button>" +
    (outsideN
      ? '<label class="toggle" for="fOut"><input type="checkbox" id="fOut"' +
        (showOutside ? " checked" : "") +
        "> Show outside connections (" +
        outsideN +
        ")</label>"
      : "") +
    (view === "flow"
      ? '<span class="lg">← → to step through</span>'
      : '<span class="lg">Click a box to open it</span>');
  $("fMore").onclick = function () {
    showTypes = !showTypes;
    if (!showTypes && FILT && FILT.k === "type") FILT = null;
    renderFilters();
    apply();
  };
  if ($("fOut"))
    $("fOut").onchange = function () {
      showOutside = $("fOut").checked;
      render();
      fitAll();
    };
  box.querySelectorAll(".fchip").forEach(function (b) {
    var fl = { k: b.dataset.k, v: b.dataset.v };
    b.onmouseenter = function () {
      filtHover = fl;
      apply();
    };
    b.onmouseleave = function () {
      filtHover = null;
      apply();
    };
    b.onclick = function () {
      FILT = FILT && FILT.k === fl.k && FILT.v === fl.v ? null : fl;
      renderFilters();
      apply();
    };
  });
}

// ---------- minimap
var mini = null,
  miniFrame = 0,
  miniColours = null;
// Drawn at most once a frame, however many pans, zooms and drags ask for it.
function scheduleMini() {
  if (miniFrame) return;
  miniFrame = requestAnimationFrame(function () {
    miniFrame = 0;
    drawMini();
  });
}
// The theme's colours, read once; a new brand or colour scheme clears them.
function colours() {
  if (!miniColours) {
    var cs = getComputedStyle(document.documentElement);
    miniColours = {
      dot: cs.getPropertyValue("--dot").trim() || "#ccc",
      accent: cs.getPropertyValue("--accent").trim() || "#2d6cdf",
    };
  }
  return miniColours;
}
if (window.matchMedia)
  try {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", function () {
        miniColours = null;
        scheduleMini();
      });
  } catch (e) {
    /* old browsers: colours refresh on the next data load */
  }
function drawMini() {
  mini = mini || $("mini");
  if (!mini || mini.offsetParent === null) return;
  var keys = Object.keys(cardEls);
  if (!keys.length) {
    mini.getContext("2d").clearRect(0, 0, mini.width, mini.height);
    return;
  }
  var boxes = keys.map(function (k) {
    var q = posOf(k, DEF),
      sz = SIZE[k] || (VM.T[k] ? { w: W, h: VM.T[k].h } : { w: SW, h: SH });
    return { k: k, x: q.x, y: q.y, w: sz.w, h: sz.h };
  });
  var b = bounds(
      boxes.concat(
        zoneEls
          .map(function (z) {
            return z.box;
          })
          .filter(Boolean),
      ),
    ),
    cs = colours();
  var dpr = window.devicePixelRatio || 1,
    cw = mini.clientWidth,
    ch = mini.clientHeight;
  if (mini.width !== cw * dpr) {
    mini.width = cw * dpr;
    mini.height = ch * dpr;
  }
  var ctx = mini.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  var sc = Math.min((cw - 12) / b.w, (ch - 12) / b.h),
    ox = (cw - b.w * sc) / 2 - b.x * sc,
    oy = (ch - b.h * sc) / 2 - b.y * sc;
  mini._map = { sc: sc, ox: ox, oy: oy };
  ctx.fillStyle = cs.dot;
  boxes.forEach(function (r) {
    ctx.globalAlpha = cardEls[r.k].classList.contains("dim") ? 0.35 : 1;
    ctx.fillRect(
      ox + r.x * sc,
      oy + r.y * sc,
      Math.max(2, r.w * sc),
      Math.max(2, r.h * sc),
    );
  });
  ctx.globalAlpha = 1;
  var vr = vp.getBoundingClientRect();
  ctx.strokeStyle = cs.accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    ox + (-V.x / V.k) * sc,
    oy + (-V.y / V.k) * sc,
    (vr.width / V.k) * sc,
    (vr.height / V.k) * sc,
  );
}
function miniPan(ev) {
  if (!mini || !mini._map) return;
  var r = mini.getBoundingClientRect(),
    m = mini._map,
    wx = (ev.clientX - r.left - m.ox) / m.sc,
    wy = (ev.clientY - r.top - m.oy) / m.sc,
    vr = vp.getBoundingClientRect();
  V.x = vr.width / 2 - wx * V.k;
  V.y = vr.height / 2 - wy * V.k;
  setT();
}

// ---------- flows
var flowId = null,
  flowStep = 0;
function enterFlow(id) {
  if (!VM.FL[id]) return;
  flowId = id;
  flowStep = 0;
  view = "flow";
  sel = null;
  per = null;
  hov = null;
  render();
  fitAll();
  openFlow(id);
  syncHash(true);
}
function openFlows() {
  var b =
    '<p class="lead">Step-by-step paths through the architecture. Each step follows a recorded connection; pick one to walk through it.</p>';
  b += VM.flows.length
    ? '<div class="links">' +
      VM.flows
        .map(function (x) {
          return (
            '<button type="button" class="lnk" data-flow="' +
            esc(x.id) +
            '" style="--z:var(--accent)"><i></i><span><b>' +
            esc(x.f.name) +
            (x.st ? " · " + esc(x.st) : "") +
            "</b><small>" +
            esc(x.f.description || "") +
            " · " +
            (x.f.steps || []).length +
            " steps</small></span></button>"
          );
        })
        .join("") +
      "</div>"
    : emptyState("flows");
  showPanel("Flows · " + VM.flows.length, b, false, { type: "flows" });
  panel.querySelectorAll("[data-flow]").forEach(function (x) {
    x.onclick = function () {
      enterFlow(x.dataset.flow);
    };
  });
}
function openFlow(id) {
  var x = VM.FL[id];
  if (!x) return;
  var steps = x.f.steps || [],
    cur = steps[flowStep] || {};
  var b = own(DOCS, id)
    ? docBlocks(id)
    : '<p class="lead">' + esc(x.f.description || "") + "</p>";
  b +=
    '<div class="stepper"><button type="button" class="tbtn" id="fPrev"' +
    (flowStep <= 0 ? " disabled" : "") +
    ">← Back</button><span>Step " +
    (flowStep + 1) +
    " of " +
    steps.length +
    '</span><button type="button" class="tbtn primary" id="fNext"' +
    (flowStep >= steps.length - 1 ? " disabled" : "") +
    ">Next →</button></div>";
  b +=
    '<ol class="steps">' +
    steps
      .map(function (st, i) {
        var from =
          st.from.indexOf("persona:") === 0
            ? (VM.PER[st.from.slice(8)] || { p: { name: st.from } }).p.name
            : VM.S[st.from]
              ? VM.S[st.from].s.name
              : st.from;
        var to = !st.to
          ? ""
          : st.to.indexOf("persona:") === 0
            ? (VM.PER[st.to.slice(8)] || { p: { name: st.to } }).p.name
            : VM.S[st.to]
              ? VM.S[st.to].s.name
              : st.to;
        var ok = stepOk(st);
        return (
          '<li class="' +
          (i === flowStep ? "cur" : "") +
          '"><button type="button" data-step="' +
          i +
          '"><b>' +
          esc(from) +
          (to ? " → " + esc(to) : "") +
          "</b>" +
          (st.status === "planned" ? ' <span class="cst">planned</span>' : "") +
          "<br>" +
          esc(st.label || "") +
          (ok ? "" : '<span class="warn">Not on a recorded connection</span>') +
          "</button></li>"
        );
      })
      .join("") +
    "</ol>";
  showPanel(x.f.name || id, b, false, { type: "flow", id: id });
  $("fPrev").onclick = function () {
    stepTo(flowStep - 1);
  };
  $("fNext").onclick = function () {
    stepTo(flowStep + 1);
  };
  panel.querySelectorAll("[data-step]").forEach(function (el) {
    el.onclick = function () {
      stepTo(+el.dataset.step);
    };
  });
  var curEl = panel.querySelector(".steps li.cur");
  if (curEl) curEl.scrollIntoView({ block: "nearest" });
}
function stepTo(i) {
  var x = VM.FL[flowId];
  if (!x) return;
  var n = (x.f.steps || []).length;
  if (i < 0 || i >= n) return;
  flowStep = i;
  apply();
  restoring = true;
  try {
    openFlow(flowId);
  } finally {
    restoring = false;
  }
  var st = x.f.steps[i],
    a = posOf(keyOf(st.from), DEF);
  if (a) {
    var bx = posOf(keyOf(st.to), DEF) || a;
    fitTo(
      bounds([
        { x: a.x, y: a.y, w: 240, h: 120 },
        { x: bx.x, y: bx.y, w: 240, h: 120 },
      ]),
      true,
      1,
    );
  }
  scheduleMini();
}

// ---------- header, chips, legend
function problemCount() {
  return CHECK.errors.length + CHECK.warnings.length;
}
// Errors break the map; warnings are mostly leads from the code scan that no
// map entry confirms yet, so they are counted and named apart.
function checkSummary() {
  var e = CHECK.errors.length,
    w = CHECK.warnings.length,
    parts = [];
  if (e) parts.push(e + (e === 1 ? " error" : " errors"));
  if (w) parts.push(w + " to confirm");
  return parts.join(" · ");
}
function renderChrome() {
  renderCrumbs();
  $("chips").hidden = view !== "schema";
  $("fadeWrap").hidden = view !== "schema";
  $("bEnums").hidden = view !== "schema";
  $("personas").hidden = view !== "schema";
  $("bDiagram").setAttribute("aria-pressed", String(diag));
  $("dlegend").hidden = !diag;
  $("bExport").hidden = !diag;
  var B = VM.B,
    n = checkSummary(),
    tops = VM.services.filter(function (x) {
      return !x.s.parent;
    }).length;
  var sub =
    tops +
    " services · " +
    Object.keys(B.tables).length +
    " tables · " +
    Object.keys(B.flows).length +
    (Object.keys(B.flows).length === 1 ? " flow" : " flows");
  if (n)
    sub +=
      ' · <button type="button" id="subProb"' +
      (CHECK.errors.length ? ' class="has-errors"' : "") +
      ">" +
      n +
      "</button>";
  $("sub").innerHTML = sub;
  if ($("subProb")) $("subProb").onclick = openProblems;

  var chips = $("chips");
  if (view === "schema") {
    chips.innerHTML = areaOrder(VM)
      .map(function (id) {
        var n = VM.tables.filter(function (t) {
          return t.t.area === id;
        }).length;
        return (
          '<button type="button" class="chip" data-zone="' +
          esc(id) +
          '" style="--z:' +
          esc(zvar(id)) +
          '"><i></i>' +
          esc(VM.areas[id].name) +
          " <span>" +
          n +
          "</span></button>"
        );
      })
      .join("");
  } else chips.innerHTML = ""; // the area chips are a schema-only row
  chips.querySelectorAll(".chip").forEach(function (b, i) {
    b.onclick = function () {
      if (zoneEls[i] && zoneEls[i].box) fitTo(zoneEls[i].box);
    };
  });
  var pn = $("personas");
  pn.innerHTML =
    '<span class="navlbl">Personas</span>' +
    (VM.personas.length ? "" : emptyState("personas", "inline")) +
    VM.personas
      .map(function (x) {
        return (
          '<button type="button" class="pchip" data-p="' +
          esc(x.id) +
          '" aria-pressed="' +
          (per === x.id) +
          '" title="' +
          esc(x.p.blurb || "") +
          '">' +
          esc(x.p.name) +
          (VM.personaTables ? " · " + Object.keys(x.tables).length : "") +
          (x.st ? " ●" : "") +
          "</button>"
        );
      })
      .join("");
  pn.querySelectorAll(".pchip").forEach(function (b) {
    b.onclick = function () {
      selectPersona(b.dataset.p);
    };
  });
  renderFilters();
}

// ---------- side panel
// Drawer history: every panel opened is pushed, so Back returns to the previous one.
var NAV = [],
  restoring = false,
  // What the open drawer shows, the element focused before it opened (and the
  // box that opened it, in case a redraw replaced that element).
  panelSt = null,
  opener = null,
  openerKey = null,
  lastActivated = null,
  // Set while a drawer is redrawn without the person asking (a dev reload).
  quietPanel = false;
// The focused element inside the drawer, as a selector that finds its twin after a redraw.
function focusRef(el) {
  if (el.id) return "#" + el.id;
  if (el.dataset && el.dataset.step != null)
    return '[data-step="' + el.dataset.step + '"]';
  return null;
}
// `title` is plain text; `body` is HTML built with esc().
function showPanel(title, body, mono, st) {
  if (!restoring && st) {
    var top = NAV[NAV.length - 1];
    if (!top || !same(top, st)) NAV.push(st);
  }
  var wasOpen = !panel.hidden,
    refresh = wasOpen && !!st && !!panelSt && same(panelSt, st),
    active = document.activeElement,
    keep = active && panel.contains(active) ? focusRef(active) : null;
  if (!wasOpen) {
    opener =
      active && active !== document.body && !panel.contains(active)
        ? active
        : null;
    openerKey = lastActivated;
  }
  var prev = NAV.length > 1 ? NAV[NAV.length - 2] : null;
  var back = prev
    ? '<button type="button" class="x back" id="back" title="Back to ' +
      esc(navLabel(prev)) +
      '">← Back</button>'
    : "";
  panel.innerHTML =
    '<div class="ph">' +
    back +
    '<h2 id="panelTitle" tabindex="-1"' +
    (mono ? ' class="mono"' : "") +
    ">" +
    esc(title) +
    '</h2><button type="button" class="x" id="close" aria-label="Close details">Close</button></div>' +
    body;
  panel.hidden = false;
  panelSt = st || null;
  if (!refresh) panel.scrollTop = 0;
  // Start here sits above the drawer, so it closes whenever a drawer opens.
  showStart(false);
  $("close").onclick = function () {
    clearSel(true);
  };
  if ($("back")) $("back").onclick = goBack;
  panel.querySelectorAll("[data-go]").forEach(function (b) {
    b.onclick = function () {
      // Following a link in the drawer is a step Back can undo.
      pushNext = true;
      try {
        goTo(b.getAttribute("data-go"));
      } finally {
        pushNext = false;
      }
    };
  });
  panel.querySelectorAll("[data-persona]").forEach(function (b) {
    b.onclick = function () {
      if (view !== "schema") setView("schema");
      selectPersona(b.getAttribute("data-persona"));
    };
  });
  // Only the title is announced, not the whole drawer.
  if (!refresh && !quietPanel) $("live").textContent = title;
  // Focus stays on the same control when the drawer is redrawn in place (a
  // flow step); otherwise it moves to the drawer's heading.
  var again = keep && panel.querySelector(keep);
  if (again && !again.disabled) again.focus({ preventScroll: true });
  else if (keep || (!refresh && !quietPanel))
    $("panelTitle").focus({ preventScroll: true });
}
function hidePanel() {
  panel.hidden = true;
  panelSt = null;
}
function restoreFocus() {
  var el =
    opener && opener.isConnected
      ? opener
      : openerKey && cardEls[openerKey]
        ? cardEls[openerKey]
        : null;
  opener = null;
  openerKey = null;
  if (el && el.focus) el.focus({ preventScroll: true });
}
function navLabel(st) {
  return (
    {
      table: st.id,
      service: VM && VM.S[st.id] ? VM.S[st.id].s.name : st.id,
      persona: VM && VM.PER[st.id] ? VM.PER[st.id].p.name : st.id,
      enums: "Enum types",
      flows: "Flows",
      flow: VM && VM.FL[st.id] ? VM.FL[st.id].f.name : "Flow",
      problems: "Check",
    }[st.type] || "previous"
  );
}
function goBack() {
  NAV.pop();
  var st = NAV[NAV.length - 1];
  if (!st) {
    clearSel();
    return;
  }
  restoring = true;
  try {
    if (st.type === "table") {
      if (view !== "schema") setView("schema");
      if (VM.T[st.id]) {
        select(st.id);
        centerOn(st.id);
      } else NAV.pop();
    } else if (st.type === "service") {
      if (VM.S[st.id]) goTo("service:" + st.id);
      else NAV.pop();
    } else if (st.type === "persona") {
      if (view !== "schema") setView("schema");
      per = null;
      selectPersona(st.id);
    } else if (st.type === "enums") {
      if (view !== "schema") setView("schema");
      openEnums(st.id);
    } else if (st.type === "flows") openFlows();
    else if (st.type === "flow") {
      if (view !== "flow" || flowId !== st.id) {
        flowId = st.id;
        flowStep = 0;
        view = "flow";
        render();
        fitAll();
      }
      openFlow(st.id);
    } else if (st.type === "problems") openProblems();
  } finally {
    restoring = false;
  }
}
function goTo(ref) {
  // ref: "table:x", "service:x", "column:t.c", "enum:x", "persona:x", "area:x", "connection:x"
  if (!VM || typeof ref !== "string" || ref.indexOf(":") < 1) return;
  var i = ref.indexOf(":"),
    kind = ref.slice(0, i),
    id = ref.slice(i + 1);
  if (kind === "column") {
    kind = "table";
    id = id.split(".")[0];
  }
  if (kind === "connection") {
    var c = own(VM.B.connections, id);
    if (!c || !VM.S[c.from]) return;
    kind = "service";
    id = c.from;
  }
  if (kind === "enum") {
    if (view !== "schema") setView("schema");
    openEnums(id);
    return;
  }
  if (kind === "persona") {
    if (!VM.PER[id]) return;
    if (view !== "schema") setView("schema");
    if (per !== id) selectPersona(id);
    return;
  }
  if (kind === "table") {
    if (!VM.T[id]) return;
    if (view !== "schema") setView("schema");
    if (VM.T[id]) {
      select(id);
      centerOn(id);
    }
    return;
  }
  if (kind === "service") {
    if (!VM.S[id]) return;
    // A part is a row in its service's tables, not a box.
    if (VM.S[id].s.parent && VM.S[VM.S[id].s.parent]) {
      view = "arch";
      diag = false;
      path = pathFor(id);
      per = null;
      hov = null;
      list.focus = id;
      render();
      select("svc:" + id);
      return;
    }
    // Back from a part to its service keeps the tables open.
    if (view === "arch" && path.length > 1 && path[path.length - 1] === id) {
      sel = null;
      apply();
      openService(id);
      syncHash(false);
      return;
    }
    view = "arch";
    path = pathFor(id);
    sel = null;
    per = null;
    hov = null;
    render();
    fitAll();
    select("svc:" + id);
    centerOn("svc:" + id);
    return;
  }
  if (kind === "area") {
    if (view !== "schema") setView("schema");
  }
}
// A doc's text: the summary, "How it works", and "For developers" with its code paths.
// The text is HTML that `archmap build` rendered from the doc's markdown.
function docBlocks(id) {
  var d = own(DOCS, id);
  if (!d) return "";
  var code = Array.isArray(d.code) ? d.code : [],
    b = d.summary ? '<div class="doc lead">' + d.summary + "</div>" : "";
  if (d.how) b += '<h3>How it works</h3><div class="doc">' + d.how + "</div>";
  if (d.dev || code.length)
    b +=
      '<section class="doc-dev"><h3>For developers</h3>' +
      (d.dev ? '<div class="doc">' + d.dev + "</div>" : "") +
      (code.length
        ? '<ul class="code">' +
          code
            .map(function (c) {
              return "<li><code>" + esc(c) + "</code></li>";
            })
            .join("") +
          "</ul>"
        : "") +
      "</section>";
  return b;
}
function linkBtn(ref, title, sub, z) {
  return (
    '<button type="button" class="lnk" data-go="' +
    esc(ref) +
    '" style="--z:' +
    esc(z) +
    '"><i></i><span><b>' +
    esc(title) +
    "</b><small>" +
    esc(sub) +
    "</small></span></button>"
  );
}
function openTable(name) {
  var t = VM.T[name],
    vm = VM;
  if (!t) return;
  var area = vm.areas[t.t.area] || { name: t.t.area };
  var out = dict(),
    inc = dict();
  vm.edges.forEach(function (e) {
    if (e.s === name) (out[e.t] = out[e.t] || []).push(e.col);
    if (e.t === name) (inc[e.s] = inc[e.s] || []).push(e.col);
  });
  var b =
    '<div class="meta"><span class="pill" style="--z:' +
    esc(zvar(t.t.area)) +
    '"><i></i>' +
    esc(area.name) +
    "</span>" +
    (t.st ? '<span class="pill">' + esc(t.st) + "</span>" : "") +
    '<span class="pill">' +
    t.cols.length +
    " columns</span></div>";
  b += '<p class="lead">' + esc(t.t.purpose || "") + "</p>";
  var ok = Object.keys(out),
    ik = Object.keys(inc);
  b +=
    "<h3>Points to · " +
    ok.length +
    "</h3>" +
    (ok.length
      ? '<div class="links">' +
        ok
          .map(function (k) {
            return linkBtn(
              "table:" + k,
              k,
              out[k].join(", "),
              zvar(vm.T[k].t.area),
            );
          })
          .join("") +
        "</div>"
      : '<p class="small">No foreign keys.</p>');
  b +=
    "<h3>Referenced by · " +
    ik.length +
    "</h3>" +
    (ik.length
      ? '<div class="links">' +
        ik
          .map(function (k) {
            return linkBtn(
              "table:" + k,
              k,
              inc[k]
                .map(function (c) {
                  return k + "." + c;
                })
                .join(", "),
              zvar(vm.T[k].t.area),
            );
          })
          .join("") +
        "</div>"
      : '<p class="small">Nothing points here.</p>');
  var users = vm.personas.filter(function (x) {
    return x.tables[name];
  });
  if (vm.personaTables)
    b +=
      "<h3>Used by personas · " +
      users.length +
      "</h3>" +
      (users.length
        ? '<div class="links">' +
          users
            .map(function (x) {
              var jobs = (x.p.jobs || [])
                .filter(function (j) {
                  return j.t && j.t[name];
                })
                .map(function (j) {
                  return j.job;
                });
              return (
                '<button type="button" class="lnk" data-persona="' +
                esc(x.id) +
                '" style="--z:var(--persona)"><i></i><span><b>' +
                esc(x.p.name) +
                " · " +
                (x.tables[name] === "w" ? "writes" : "reads") +
                "</b><small>" +
                esc(jobs.join("; ")) +
                "</small></span></button>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="small">No persona works with this table directly.</p>');
  b += "<h3>Columns</h3>";
  t.cols.forEach(function (x) {
    var c = x.c,
      m = vm.B,
      tags = [];
    if (c.pk) tags.push("primary key");
    if (c.unique) tags.push("unique");
    if (c.fk) tags.push("→ " + c.fk);
    var en = c.enum ? own(m.enums, c.enum) || {} : null;
    b +=
      '<div class="col' +
      (x.st ? " " + esc(x.st) : "") +
      '"><div class="cl1"><code>' +
      esc(c.name) +
      '</code><span class="t">' +
      esc(colType(c, m)) +
      (tags.length ? " · " + esc(tags.join(" · ")) : "") +
      "</span></div>";
    if (c.desc) b += "<p>" + esc(c.desc) + "</p>";
    if (en && en.values)
      b +=
        '<div class="chips">' +
        en.values
          .map(function (v) {
            return "<span>" + esc(v) + "</span>";
          })
          .join("") +
        "</div>";
    b += "</div>";
  });
  b +=
    '<div class="col"><div class="cl1"><code>created_at</code><span class="t">timestamptz</span></div><p>When the row was written. Every table has it.</p></div>' +
    '<div class="col"><div class="cl1"><code>updated_at</code><span class="t">timestamptz</span></div><p>Last change; doubles as the edit-conflict check.</p></div>';
  showPanel(name, b, true, { type: "table", id: name });
}
// A parameter or body field list as a small table.
function fieldTable(rows, withIn) {
  return (
    '<table class="ftable"><thead><tr><th scope="col">Name</th>' +
    (withIn ? '<th scope="col">In</th>' : "") +
    '<th scope="col">Type</th><th scope="col">Description</th></tr></thead><tbody>' +
    rows
      .map(function (f) {
        return (
          "<tr><td><code>" +
          esc(f.name) +
          "</code>" +
          (f.required === true ? ' <span class="req">required</span>' : "") +
          "</td>" +
          (withIn ? "<td>" + esc(f.in || "") + "</td>" : "") +
          "<td>" +
          (f.type ? "<code>" + esc(f.type) + "</code>" : "") +
          "</td><td>" +
          esc(f.desc || "") +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table>"
  );
}
// One endpoint, job, library or environment variable: what it does and, for an
// endpoint, how to call it.
function openPart(id) {
  var x = VM.S[id],
    s = x.s,
    t = stype(s),
    params = Array.isArray(s.params) ? s.params : [],
    body = Array.isArray(s.body) ? s.body : [];
  var b =
    '<div class="meta"><span class="pill">' +
    esc(TYPE_LABEL[t]) +
    "</span>" +
    (s.public === true
      ? '<span class="pill">shipped to the browser</span>'
      : "") +
    "</div>";
  b += s.purpose
    ? '<p class="lead">' + esc(s.purpose) + "</p>"
    : '<p class="small">' +
      (t === "endpoint"
        ? "No documentation recorded for this endpoint yet."
        : "No description recorded yet.") +
      " Ask your AI agent to run <code>archmap brief --task review</code> and follow it.</p>";
  if (s.public === true)
    b +=
      '<p class="small">Its value is built into the app people download, so anyone can read it. It must never hold a secret.</p>';
  function fact(title, value, mono) {
    if (value)
      b +=
        "<h3>" +
        title +
        '</h3><p class="fact">' +
        (mono ? "<code>" + esc(value) + "</code>" : esc(value)) +
        "</p>";
  }
  fact("Who can call it", s.auth);
  if (params.length)
    b +=
      "<h3>Parameters · " + params.length + "</h3>" + fieldTable(params, true);
  if (body.length)
    b += "<h3>Request body · " + body.length + "</h3>" + fieldTable(body);
  fact("Returns", s.returns);
  fact("Runs", s.schedule);
  fact("Package", s.package, true);
  if (s.version)
    b +=
      '<h3>Version</h3><p class="fact"><code>' +
      esc(s.version) +
      "</code>" +
      (s.latest ? " · latest <code>" + esc(s.latest) + "</code>" : "") +
      (own(FRESH, s.fresh)
        ? ' <span class="fresh f-' +
          esc(s.fresh) +
          '">' +
          esc(FRESH[s.fresh]) +
          "</span>"
        : "") +
      "</p>";
  if (s.evidence)
    b +=
      '<section class="doc-dev"><h3>Where in the code</h3><ul class="code"><li><code>' +
      esc(s.evidence) +
      "</code></li></ul></section>";
  showPanel(s.name || id, b, t === "endpoint" || t === "env", {
    type: "service",
    id: id,
  });
}
function openService(id) {
  var x = VM.S[id],
    vm = VM;
  if (!x) return;
  var s = x.s;
  if (s.parent && vm.S[s.parent]) {
    openPart(id);
    return;
  }
  var b =
    '<div class="meta"><span class="pill" style="--z:' +
    esc(lvar(catOf(id))) +
    '"><i></i>' +
    esc(catName(catOf(id))) +
    "</span>" +
    (s.status ? '<span class="pill">' + esc(s.status) + "</span>" : "") +
    (x.st ? '<span class="pill">' + esc(x.st) + "</span>" : "") +
    "</div>";
  if (s.tech)
    b += '<h3>Built with</h3><p class="fact">' + esc(s.tech) + "</p>";
  if (hostOf(x))
    b +=
      '<h3>Runs on</h3><div class="links">' +
      linkBtn(
        "service:" + s.host,
        vm.S[s.host].s.name,
        vm.S[s.host].s.tech || "",
        lvar(catOf(s.host)),
      ) +
      "</div>";
  if (Array.isArray(s.options) && s.options.length)
    b +=
      '<h3>Still to confirm</h3><p class="fact">Not chosen yet. The options:</p><div class="chips">' +
      s.options
        .map(function (o) {
          return "<span>" + esc(o) + "</span>";
        })
        .join("") +
      "</div>";
  if (Array.isArray(s.questions) && s.questions.length)
    b +=
      "<h3>Open questions · " +
      s.questions.length +
      '</h3><ul class="qs">' +
      s.questions
        .map(function (q) {
          return "<li>" + esc(q) + "</li>";
        })
        .join("") +
      "</ul>";
  if (own(DOCS, id)) b += docBlocks(id);
  else b += '<p class="lead">' + esc(s.purpose || "") + "</p>";
  // Parts, docs and history stay off the drawer to keep it short; parts open by drilling into the box.
  if (s.opens === "schema" && layerCount("data") === 0) b += emptyState("data");
  else if (s.opens === "schema")
    b +=
      '<p><button type="button" class="tbtn primary" id="openSchema">Open the database tables</button></p>';
  var outs = vm.conns.filter(function (c) {
      return c.c.from === id;
    }),
    ins = vm.conns.filter(function (c) {
      return c.c.to === id;
    });
  b +=
    "<h3>Calls · " +
    outs.length +
    "</h3>" +
    (outs.length
      ? '<div class="links">' +
        outs
          .map(function (c) {
            return linkBtn(
              "service:" + c.c.to,
              vm.S[c.c.to].s.name,
              (c.c.label || "") +
                (c.c.protocol ? " · " + c.c.protocol : "") +
                (c.c.status === "planned" ? " · planned" : ""),
              lvar(vm.S[c.c.to].s.lane),
            );
          })
          .join("") +
        "</div>"
      : '<p class="small">None.</p>');
  b +=
    "<h3>Called by · " +
    ins.length +
    "</h3>" +
    (ins.length
      ? '<div class="links">' +
        ins
          .map(function (c) {
            return linkBtn(
              "service:" + c.c.from,
              vm.S[c.c.from].s.name,
              (c.c.label || "") +
                (c.c.protocol ? " · " + c.c.protocol : "") +
                (c.c.status === "planned" ? " · planned" : ""),
              lvar(vm.S[c.c.from].s.lane),
            );
          })
          .join("") +
        "</div>"
      : '<p class="small">None.</p>');
  showPanel(s.name || id, b, false, { type: "service", id: id });
  if ($("openSchema"))
    $("openSchema").onclick = function () {
      clearSel();
      setView("schema");
    };
}
function openPersona(id) {
  var x = VM.PER[id];
  if (!x) return;
  var p = x.p,
    jobs = Array.isArray(p.jobs) ? p.jobs : [],
    names = Object.keys(x.tables),
    nw = names.filter(function (n) {
      return x.tables[n] === "w";
    }).length;
  var b =
    '<div class="meta">' +
    (p.kind ? '<span class="pill">' + esc(p.kind) + "</span>" : "") +
    (p.who ? '<span class="pill">' + esc(p.who) + "</span>" : "") +
    (VM.personaTables
      ? '<span class="pill">' +
        names.length +
        " tables · writes " +
        nw +
        "</span>"
      : "") +
    "</div>";
  b += own(DOCS, id)
    ? docBlocks(id)
    : '<p class="lead">' + esc(p.blurb || "") + "</p>";
  b += "<h3>Jobs to be done · " + jobs.length + "</h3>";
  jobs.forEach(function (j) {
    var t = j && j.t && typeof j.t === "object" ? j.t : {},
      keys = Object.keys(t);
    b += '<div class="job"><p>' + esc(j && j.job) + "</p>";
    if (keys.length)
      b +=
        '<div class="tl">' +
        keys
          .map(function (n) {
            return (
              '<button type="button" class="tchip ' +
              (t[n] === "w" ? "w" : "r") +
              '" data-go="table:' +
              esc(n) +
              '">' +
              esc(n) +
              "</button>"
            );
          })
          .join("") +
        "</div>";
    if (j && j.note) b += '<p class="small">' + esc(j.note) + "</p>";
    b += "</div>";
  });
  if (p.source)
    b +=
      '<p class="small">Source: ' +
      esc(p.source) +
      ". Filled chips: the persona writes; outlined: reads.</p>";
  showPanel(p.name || id, b, false, { type: "persona", id: id });
}
function openEnums(focus) {
  var B = VM.B,
    names = Object.keys(B.enums);
  names.sort();
  var uses = dict();
  Object.keys(B.tables).forEach(function (t) {
    B.tables[t].columns.forEach(function (c) {
      if (c.enum) (uses[c.enum] = uses[c.enum] || []).push(t + "." + c.name);
    });
  });
  var b =
    '<p class="lead">Fixed lists of allowed values. <b>Native</b> means a Postgres enum type; <b>check</b> means text with a CHECK constraint. Lists staff edit themselves are lookup tables instead.</p>';
  names.forEach(function (n) {
    var cur = B.enums[n];
    b +=
      '<div class="col" id="enum-' +
      esc(n) +
      '"><div class="cl1"><code>' +
      esc(n) +
      '</code><span class="t">' +
      esc(cur.style || "check") +
      "</span></div>";
    b +=
      '<div class="chips">' +
      (cur.values || [])
        .map(function (v) {
          return "<span>" + esc(v) + "</span>";
        })
        .join("") +
      "</div>";
    b +=
      '<div class="chips">' +
      (uses[n] || [])
        .map(function (u) {
          return (
            '<button type="button" class="tchip plain" data-go="table:' +
            esc(u.split(".")[0]) +
            '">' +
            esc(u) +
            "</button>"
          );
        })
        .join("") +
      "</div></div>";
  });
  showPanel("Enum types · " + names.length, b, false, {
    type: "enums",
    id: focus || "",
  });
  if (focus && $("enum-" + focus))
    $("enum-" + focus).scrollIntoView({ block: "center" });
}
function openProblems() {
  var line = function (cls) {
    return function (p) {
      return (
        '<p class="note ' + cls + '">' + esc(p.file + ": " + p.message) + "</p>"
      );
    };
  };
  var head = function (title, n) {
    return n ? "<h3>" + title + " · " + n + "</h3>" : "";
  };
  showPanel(
    "Check · " + checkSummary(),
    '<p class="lead">What <code>archmap check</code> found. Errors are mistakes in the map files and must be fixed. ' +
      "To confirm lists what the code scan found that no map entry covers yet: add it to the map with evidence, or to <code>ignore</code> if it doesn&rsquo;t belong.</p>" +
      head("Errors", CHECK.errors.length) +
      CHECK.errors.map(line("gap")).join("") +
      head("To confirm", CHECK.warnings.length) +
      CHECK.warnings.map(line("open")).join(""),
    false,
    { type: "problems" },
  );
}
function activate(key) {
  lastActivated = key;
  if (view === "schema") {
    select(key);
    return;
  }
  if (key.indexOf("act:") === 0) {
    per = null;
    sel = { view: view, key: key };
    apply();
    openPersona(key.slice(4));
    return;
  }
  if (view === "flow") {
    select(key);
    return;
  }
  if (key.indexOf("cat:") === 0) {
    drill([key.slice(4)]);
    return;
  }
  var id = key.slice(4),
    x = VM.S[id];
  if (!x) return;
  var here =
    path.length &&
    (path.length === 1
      ? x.s.lane === path[0] && !x.s.parent
      : x.s.parent === path[path.length - 1]);
  if (!here) {
    goTo("service:" + id);
    return;
  }
  if (x.s.opens === "schema") {
    path = path.concat([id]);
    view = "schema";
    sel = null;
    per = null;
    hov = null;
    hidePanel();
    NAV = [];
    render();
    fitAll();
    openService(id);
    syncHash(true);
    return;
  }
  if (childrenOf(id).length) {
    drill(path.concat([id]));
    openService(id);
    return;
  }
  select(key);
}
function drill(p) {
  diag = false;
  path = p;
  view = "arch";
  sel = null;
  per = null;
  hov = null;
  hidePanel();
  NAV = [];
  render();
  fitAll();
  syncHash(true);
}
function schemaPath() {
  var pg = VM.services.filter(function (x) {
    return x.s.opens === "schema";
  })[0];
  return pg ? pathFor(pg.id).concat([pg.id]) : [];
}
function renderCrumbs() {
  var parts = [{ label: "All", p: [] }];
  path.forEach(function (seg, i) {
    var label =
      i === 0
        ? (
            VM.cats.filter(function (c) {
              return c.id === seg;
            })[0] || { c: { name: seg } }
          ).c.name
        : VM.S[seg]
          ? VM.S[seg].s.name
          : seg;
    parts.push({ label: label, p: path.slice(0, i + 1) });
  });
  if (view === "flow" && VM.FL[flowId])
    parts = [
      { label: "All", p: [] },
      { label: "Flow: " + VM.FL[flowId].f.name, p: null },
    ];
  if (diag)
    parts = [
      { label: "All", p: [] },
      { label: "Diagram", p: null },
    ];
  var last = parts.length - 1,
    isSchema = view === "schema";
  $("crumbs").innerHTML = parts
    .map(function (x, i) {
      var sep = i ? '<span class="sep">›</span>' : "";
      return (
        sep +
        (i === last
          ? "<b>" + esc(x.label) + (isSchema ? " · tables" : "") + "</b>"
          : '<button type="button" data-crumb="' +
            i +
            '">' +
            esc(x.label) +
            "</button>")
      );
    })
    .join("");
  $("crumbs")
    .querySelectorAll("[data-crumb]")
    .forEach(function (b) {
      b.onclick = function () {
        var x = parts[+b.dataset.crumb];
        if (isSchema && x.p.length === path.length) {
          view = "arch";
        }
        drill(x.p);
      };
    });
}
function select(key) {
  per = null;
  sel = { view: view, key: key };
  hov = null;
  apply();
  if (view === "schema") openTable(key);
  else openService(key.slice(4));
  syncHash(false);
}
function selectPersona(id) {
  if (per === id) {
    clearSel();
    return;
  }
  if (!VM.PER[id]) return;
  per = id;
  sel = null;
  hov = null;
  apply();
  openPersona(id);
  syncHash(false);
  var keys = Object.keys(VM.PER[id].tables).filter(function (k) {
    return cardEls[k] && VM.T[k];
  });
  if (keys.length)
    fitTo(
      bounds(
        keys.map(function (k) {
          var q = posOf(k, DEF);
          return { x: q.x, y: q.y, w: W, h: VM.T[k].h };
        }),
      ),
      true,
    );
}
// Closes the drawer; with restore (Close or Escape), focus goes back to what opened it.
function clearSel(restore) {
  var wasOpen = !panel.hidden;
  sel = null;
  per = null;
  NAV = [];
  hidePanel();
  apply();
  syncHash(false);
  if (restore === true && wasOpen) restoreFocus();
}
function setView(v) {
  if (view === v) return;
  if (v === "schema") path = schemaPath();
  else if (path.length) path = path.slice(0, -1);
  view = v;
  sel = null;
  per = null;
  hov = null;
  hidePanel();
  render();
  fitAll();
  syncHash(true);
}

// ---------- the URL: #schema, #c-<category>, #in-<service>, #s-<service>,
// #t-<table>, #p-<persona>, #flow-<flow>. Selecting replaces the entry;
// drilling in or following a link in the drawer adds one, so Back returns.
var routing = false,
  pushNext = false,
  lastHash = location.hash;
function hashFor() {
  var e = encodeURIComponent;
  if (view === "flow") return VM.FL[flowId] ? "flow-" + e(flowId) : "";
  if (view === "schema") {
    if (per && VM.PER[per]) return "p-" + e(per);
    if (sel && sel.view === "schema") return "t-" + e(sel.key);
    return "schema";
  }
  if (sel && sel.view === "arch" && sel.key.indexOf("svc:") === 0)
    return "s-" + e(sel.key.slice(4));
  if (diag) return "diagram";
  if (!path.length) return "";
  if (path.length === 1) return "c-" + e(path[0]);
  return "in-" + e(path[path.length - 1]);
}
function syncHash(push) {
  push = push || pushNext;
  pushNext = false;
  if (routing || !VM) return;
  var h = hashFor();
  if ((h ? "#" + h : "") === location.hash) return;
  try {
    history[push ? "pushState" : "replaceState"](
      null,
      "",
      h ? "#" + h : location.pathname + location.search,
    );
  } catch (e) {
    /* a sandboxed page can't write history */
  }
  lastHash = location.hash;
}
// Goes where a hash points; anything it doesn't name is ignored.
function applyHash(raw) {
  if (!VM) return;
  var h = String(raw || "").replace(/^#/, ""),
    m = /^(t|s|c|in|p|flow)-(.+)$/.exec(h),
    id = null;
  if (m)
    try {
      id = decodeURIComponent(m[2]);
    } catch (e) {
      return;
    }
  routing = true;
  try {
    if (!h) {
      if (view !== "arch" || path.length || diag) drill([]);
      clearSel();
    } else if (h === "diagram") {
      if (!diag) openDiagram();
    } else if (h === "schema") {
      if (view !== "schema") setView("schema");
      clearSel();
    } else if (!m) return;
    else if (m[1] === "t") goTo("table:" + id);
    else if (m[1] === "s") goTo("service:" + id);
    else if (m[1] === "p") goTo("persona:" + id);
    else if (m[1] === "flow") {
      if (view !== "flow" || flowId !== id) enterFlow(id);
    } else if (m[1] === "c") {
      if (
        VM.cats.some(function (c) {
          return c.id === id;
        })
      )
        drill([id]);
    } else if (m[1] === "in" && VM.S[id] && childrenOf(id).length) {
      drill(pathFor(id).concat([id]));
      openService(id);
    }
  } finally {
    routing = false;
    lastHash = location.hash;
  }
}
function onRoute() {
  if (location.hash === lastHash) return;
  showStart(false);
  applyHash(location.hash);
}
window.addEventListener("popstate", onRoute);
window.addEventListener("hashchange", onRoute);

// ---------- pan and zoom
var V = { x: 0, y: 0, k: 1 };
// Controls drawn over the map: pointers and wheels on them don't pan or zoom it.
var OVERLAYS =
  ".panel, .controls, .bottombar, .mini, .legend, .msg div, .start, .lists";
function setT() {
  world.style.transform =
    "translate(" + V.x + "px," + V.y + "px) scale(" + V.k + ")";
  scheduleMini();
}
function zoomAt(px, py, k) {
  k = Math.max(0.12, Math.min(2.2, k));
  V.x = px - (px - V.x) * (k / V.k);
  V.y = py - (py - V.y) * (k / V.k);
  V.k = k;
  setT();
}
function bounds(list) {
  var x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  list.forEach(function (b) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Fits the box in the view, zoomed in no further than maxK (1.2 by default).
function fitTo(b, leavePanel, maxK) {
  if (!b || !isFinite(b.w)) return;
  var r = vp.getBoundingClientRect(),
    m = 40,
    w = r.width,
    h = r.height;
  if (leavePanel && !panel.hidden) {
    if (r.width > 720) w -= 400;
    else h *= 0.4;
  }
  var k = Math.max(
    0.12,
    Math.min(maxK || 1.2, Math.min((w - m * 2) / b.w, (h - m * 2) / b.h)),
  );
  V.k = k;
  V.x = (w - b.w * k) / 2 - b.x * k;
  V.y = (h - b.h * k) / 2 - b.y * k;
  setT();
}
function fitAll() {
  var boxes = zoneEls
    .map(function (z) {
      return z.box;
    })
    .filter(Boolean)
    .concat(
      Object.keys(cardEls).map(function (k) {
        var q = posOf(k, DEF),
          s = SIZE[k] || (VM.T[k] ? { w: W, h: VM.T[k].h } : { w: SW, h: SH });
        return { x: q.x, y: q.y, w: s.w, h: s.h };
      }),
    );
  if (boxes.length) fitTo(bounds(boxes));
}
function centerOn(key) {
  var q = posOf(key, DEF);
  if (!q || !cardEls[key]) return;
  var r = vp.getBoundingClientRect(),
    w = view === "schema" ? W : (SIZE[key] || { w: SW }).w,
    h =
      view === "schema"
        ? Math.min(VM.T[key] ? VM.T[key].h : SH, 300)
        : (SIZE[key] || { h: SH }).h;
  var k = Math.max(V.k, 0.8),
    vw = panel.hidden || r.width <= 720 ? r.width : r.width - 400,
    vh = panel.hidden || r.width > 720 ? r.height : r.height * 0.4;
  V.k = k;
  V.x = vw / 2 - (q.x + w / 2) * k;
  V.y = vh / 2 - (q.y + h / 2) * k;
  setT();
}
$("zin").onclick = function () {
  var r = vp.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, V.k * 1.25);
};
$("zout").onclick = function () {
  var r = vp.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, V.k / 1.25);
};
$("fit").onclick = fitAll;
$("reset").onclick = function () {
  var sc = scope() + "|";
  Object.keys(P).forEach(function (k) {
    if (k.indexOf(sc) === 0) delete P[k];
  });
  savePos();
  place();
  fitAll();
};
vp.addEventListener(
  "wheel",
  function (ev) {
    if (ev.target.closest(OVERLAYS)) return;
    ev.preventDefault();
    var r = vp.getBoundingClientRect(),
      unit = ev.deltaMode === 1 ? 16 : 1,
      dx = ev.deltaX * unit,
      dy = ev.deltaY * unit;
    // Like Figma and Miro: scroll moves the canvas; a trackpad pinch (sent as ctrl+wheel) or Ctrl/⌘+scroll zooms.
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(
        ev.clientX - r.left,
        ev.clientY - r.top,
        V.k * Math.exp(-dy * 0.01),
      );
      return;
    }
    V.x -= dx;
    V.y -= dy;
    setT();
  },
  { passive: false },
);
// Safari reports trackpad pinches as gesture events rather than ctrl+wheel.
var gesture = null;
vp.addEventListener("gesturestart", function (ev) {
  ev.preventDefault();
  gesture = { k: V.k };
});
vp.addEventListener("gesturechange", function (ev) {
  if (!gesture) return;
  ev.preventDefault();
  var r = vp.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, gesture.k * ev.scale);
});
vp.addEventListener("gestureend", function () {
  gesture = null;
});
// Nothing on the canvas is draggable as a file, link or image.
vp.addEventListener("dragstart", function (ev) {
  ev.preventDefault();
});
var pointers = new Map(),
  drag = null,
  pinch = null,
  dragFrame = 0;
// Moves the dragged box once a frame, with only its own zones and edges.
function scheduleDrag() {
  if (dragFrame) return;
  dragFrame = requestAnimationFrame(function () {
    dragFrame = 0;
    if (drag && drag.kind === "card") {
      place(drag.key);
      scheduleMini();
    }
  });
}
function flushDrag() {
  if (!dragFrame) return;
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  if (drag && drag.kind === "card") place(drag.key);
}
// Stops any pan, pinch or box drag in progress (the map was redrawn under it).
function cancelDrag() {
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  pointers.forEach(function (_, id) {
    try {
      if (vp.hasPointerCapture(id)) vp.releasePointerCapture(id);
    } catch (e) {
      /* already released */
    }
  });
  pointers.clear();
  drag = null;
  pinch = null;
  vp.classList.remove("panning");
}
vp.addEventListener("pointerdown", function (ev) {
  if (ev.target.closest(OVERLAYS)) return;
  // Stops the browser starting a text selection while the canvas is dragged.
  if (ev.pointerType === "mouse") {
    ev.preventDefault();
    // preventDefault also stops the click from taking focus, so leave the search box by hand.
    if (document.activeElement && document.activeElement.blur)
      document.activeElement.blur();
  }
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    var pts = Array.from(pointers.values());
    pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), k: V.k };
    drag = null;
    return;
  }
  var card = ev.target.closest(".card");
  // Dragging a box moves it (a click without moving still opens it); dragging
  // the empty canvas moves the canvas.
  var q = card && cardEls[card.dataset.key] && posOf(card.dataset.key, DEF);
  if (q) {
    drag = {
      kind: "card",
      key: card.dataset.key,
      sx: ev.clientX,
      sy: ev.clientY,
      ox: q.x,
      oy: q.y,
      moved: false,
    };
  } else {
    drag = {
      kind: "pan",
      key: null,
      sx: ev.clientX,
      sy: ev.clientY,
      ox: V.x,
      oy: V.y,
      moved: false,
    };
    vp.classList.add("panning");
  }
  try {
    vp.setPointerCapture(ev.pointerId);
  } catch (e) {
    /* the pointer is already gone */
  }
});
vp.addEventListener("pointermove", function (ev) {
  if (pointers.has(ev.pointerId))
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && pointers.size === 2) {
    var pts = Array.from(pointers.values()),
      r = vp.getBoundingClientRect();
    zoomAt(
      (pts[0].x + pts[1].x) / 2 - r.left,
      (pts[0].y + pts[1].y) / 2 - r.top,
      (pinch.k * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) /
        pinch.d,
    );
    return;
  }
  if (!drag) {
    var c = ev.target.closest && ev.target.closest(".card"),
      n = c ? c.dataset.key : null;
    if (n !== hov && !sel && !per) {
      hov = n;
      apply();
    }
    return;
  }
  var dx = ev.clientX - drag.sx,
    dy = ev.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  if (drag.kind === "pan") {
    V.x = drag.ox + dx;
    V.y = drag.oy + dy;
    setT();
  } else {
    P[scope() + "|" + drag.key] = {
      x: Math.round(drag.ox + dx / V.k),
      y: Math.round(drag.oy + dy / V.k),
    };
    scheduleDrag();
  }
});
function end(ev) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drag) return;
  flushDrag();
  var d = drag;
  drag = null;
  vp.classList.remove("panning");
  if (!d.moved && d.key) activate(d.key);
  else if (d.kind === "card") savePos();
  else if (!d.moved && (sel || per)) clearSel();
}
vp.addEventListener("pointerup", end);
vp.addEventListener("pointercancel", end);
vp.addEventListener("pointerleave", function () {
  if (hov && !drag) {
    hov = null;
    apply();
  }
});
cardLayer.addEventListener("keydown", function (ev) {
  var c = ev.target.closest(".card");
  if (c && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    activate(c.dataset.key);
  }
});
// A box reached with Tab is brought into view by panning the map; the browser's
// own scroll of the viewport (which clips the map) is undone.
vp.addEventListener("focusin", function (ev) {
  var c = ev.target.closest && ev.target.closest(".card");
  if (!c || cardEls[c.dataset.key] !== c) return;
  var keyboard = true;
  try {
    keyboard = c.matches(":focus-visible");
  } catch (e) {
    keyboard = true;
  }
  var reset = function () {
    vp.scrollTop = 0;
    vp.scrollLeft = 0;
  };
  reset();
  requestAnimationFrame(reset);
  if (!keyboard) return;
  var r = c.getBoundingClientRect(),
    v = vp.getBoundingClientRect(),
    right = panel.hidden || v.width <= 720 ? v.right : v.right - 400;
  if (
    r.left < v.left ||
    r.top < v.top ||
    r.right > right ||
    r.bottom > v.bottom
  )
    centerOn(c.dataset.key);
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") clearSel(true);
  if (
    view === "flow" &&
    !/INPUT|TEXTAREA|SELECT/.test((ev.target && ev.target.tagName) || "")
  ) {
    if (ev.key === "ArrowRight") stepTo(flowStep + 1);
    if (ev.key === "ArrowLeft") stepTo(flowStep - 1);
  }
});

// ---------- header controls
$("q").addEventListener("input", function () {
  query = $("q").value.trim().toLowerCase();
  apply();
});
$("q").addEventListener("keydown", function (ev) {
  if (ev.key !== "Enter" || !query) return;
  showStart(false);
  // Inside a service the search has already narrowed the table.
  if (!$("lists").hidden && $("lists").querySelector("tbody tr:not([hidden])"))
    return;
  var hit = Object.keys(cardEls).filter(matchKey)[0];
  if (!hit) {
    // look in the other view
    var svc = VM.services.filter(serviceMatches)[0];
    var tbl = VM.tables.filter(tableMatches)[0];
    if (view === "schema" ? svc : !tbl && svc) goTo("service:" + svc.id);
    else if (tbl) goTo("table:" + tbl.name);
    return;
  }
  // A category or persona opens the way a click on it does.
  if (/^(cat|act):/.test(hit)) {
    activate(hit);
    return;
  }
  lastActivated = hit;
  select(hit);
  centerOn(hit);
});
$("fadePerson").onchange = apply;
$("bFlows").onclick = openFlows;
$("bDiagram").onclick = function () {
  showStart(false);
  if (diag) drill([]);
  else openDiagram();
};
$("mini").addEventListener("pointerdown", function (ev) {
  miniPan(ev);
  var mv = function (e) {
    miniPan(e);
  };
  var up = function () {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
});
$("bExport").onclick = exportDiagram;
$("bEnums").onclick = function () {
  openEnums();
};
$("bStart").onclick = function () {
  showStart(true);
};
$("startGo").onclick = function () {
  showStart(false);
};

// ---------- the diagram as a picture: an SVG file drawn from what is on screen,
// to paste into a document or a slide.
var SVG_PAINT = [
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "fill",
  "opacity",
  "paint-order",
  "font-family",
  "font-size",
  "font-weight",
];
function px(v) {
  return parseFloat(v) || 0;
}
function painted(colour) {
  return !!colour && colour !== "transparent" && !/, 0\)$/.test(colour);
}
// A copy of an SVG node with the page's styles written onto it.
function paintedCopy(node) {
  var copy = node.cloneNode(false),
    cs = getComputedStyle(node);
  if (cs.display === "none" || cs.visibility === "hidden") return null;
  SVG_PAINT.forEach(function (p) {
    var v = cs.getPropertyValue(p);
    if (v) copy.setAttribute(p, v);
  });
  copy.removeAttribute("class");
  Array.prototype.forEach.call(node.childNodes, function (ch) {
    if (ch.nodeType === 3) copy.appendChild(ch.cloneNode(false));
    else if (ch.nodeType === 1) {
      var c = paintedCopy(ch);
      if (c) copy.appendChild(c);
    }
  });
  return copy;
}
// Where `el` sits inside `root`, in the map's own units (zoom doesn't count).
function insideOf(el, root) {
  var x = 0,
    y = 0;
  while (el && el !== root) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent;
  }
  return { x: x, y: y };
}
// `text` broken into lines no wider than `width`, as the browser wrapped it.
function wrapText(ctx, text, width) {
  var lines = [],
    line = "";
  text.split(/\s+/).forEach(function (word) {
    var next = line ? line + " " + word : word;
    if (line && ctx.measureText(next).width > width + 1) {
      lines.push(line);
      line = word;
    } else line = next;
  });
  if (line) lines.push(line);
  return lines;
}
// One box or frame as SVG: its outline, then every piece of text and icon in it.
function boxSvg(el, ctx) {
  var cs = getComputedStyle(el),
    x = px(el.style.left),
    y = px(el.style.top),
    w = el.offsetWidth,
    h = el.offsetHeight,
    bw = px(cs.borderLeftWidth),
    tw = px(cs.borderTopWidth),
    // A box drawn with a shadow and no border still needs an edge in a picture.
    line =
      !bw && el.classList.contains("card")
        ? getComputedStyle(document.documentElement)
            .getPropertyValue("--line")
            .trim()
        : "",
    out = "";
  out +=
    '<rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" rx="' +
    px(cs.borderTopLeftRadius) +
    '" fill="' +
    esc(painted(cs.backgroundColor) ? cs.backgroundColor : "none") +
    '" stroke="' +
    esc(bw ? cs.borderLeftColor : line || "none") +
    '" stroke-width="' +
    (bw || (line ? 1 : 0)) +
    '"' +
    (cs.borderLeftStyle === "dashed"
      ? ' stroke-dasharray="5 4"'
      : cs.borderLeftStyle === "dotted"
        ? ' stroke-dasharray="1.5 3.5" stroke-linecap="round"'
        : "") +
    (px(cs.opacity) < 1 ? ' opacity="' + px(cs.opacity) + '"' : "") +
    "/>";
  // A box's coloured top edge, when it differs from the rest of its outline.
  if (tw && cs.borderTopColor !== cs.borderLeftColor)
    out +=
      '<rect x="' +
      x +
      '" y="' +
      y +
      '" width="' +
      w +
      '" height="' +
      tw +
      '" fill="' +
      esc(cs.borderTopColor) +
      '"/>';
  el.querySelectorAll("*").forEach(function (n) {
    if (!n.offsetParent && !(n instanceof SVGElement)) return;
    var at;
    if (n instanceof SVGSVGElement) {
      var icon = paintedCopy(n),
        box = n.parentElement;
      if (!icon || !box.offsetParent) return;
      at = insideOf(box, el);
      icon.setAttribute("x", x + at.x + (box.offsetWidth - px(getComputedStyle(n).width)) / 2);
      icon.setAttribute("y", y + at.y + (box.offsetHeight - px(getComputedStyle(n).height)) / 2);
      icon.setAttribute("width", px(getComputedStyle(n).width));
      icon.setAttribute("height", px(getComputedStyle(n).height));
      out += new XMLSerializer().serializeToString(icon);
      return;
    }
    if (n instanceof SVGElement) return;
    var ns = getComputedStyle(n);
    at = insideOf(n, el);
    // A tag or badge keeps its own filled shape.
    if (painted(ns.backgroundColor) && n.offsetWidth < w)
      out +=
        '<rect x="' +
        (x + at.x) +
        '" y="' +
        (y + at.y) +
        '" width="' +
        n.offsetWidth +
        '" height="' +
        n.offsetHeight +
        '" rx="' +
        px(ns.borderTopLeftRadius) +
        '" fill="' +
        esc(ns.backgroundColor) +
        '"/>';
    var text = "";
    Array.prototype.forEach.call(n.childNodes, function (ch) {
      if (ch.nodeType === 3) text += ch.nodeValue;
    });
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (ns.textTransform === "uppercase") text = text.toUpperCase();
    var size = px(ns.fontSize),
      lh = px(ns.lineHeight) || size * 1.35,
      padL = px(ns.paddingLeft),
      inner = n.offsetWidth - padL - px(ns.paddingRight);
    ctx.font = ns.fontWeight + " " + size + "px " + ns.fontFamily;
    var inline = ns.display.indexOf("inline") === 0,
      lines = inline ? [text] : wrapText(ctx, text, inner);
    lines.forEach(function (line, i) {
      out +=
        '<text x="' +
        (x + at.x + padL) +
        '" y="' +
        (y + at.y + px(ns.paddingTop) + lh * i + lh / 2 + size * 0.35) +
        '" font-family="' +
        esc(ns.fontFamily) +
        '" font-size="' +
        size +
        '" font-weight="' +
        esc(ns.fontWeight) +
        '" fill="' +
        esc(ns.color) +
        '"' +
        (px(ns.letterSpacing)
          ? ' letter-spacing="' + px(ns.letterSpacing) + '"'
          : "") +
        ">" +
        esc(line) +
        "</text>";
    });
  });
  return out;
}
function diagramSvg() {
  var ctx = document.createElement("canvas").getContext("2d"),
    boxes = zoneEls
      .map(function (z) {
        return z.el;
      })
      .concat(
        Object.keys(cardEls).map(function (k) {
          return cardEls[k];
        }),
      ),
    x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    body = "";
  boxes.forEach(function (el) {
    var x = px(el.style.left),
      y = px(el.style.top);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + el.offsetWidth);
    y1 = Math.max(y1, y + el.offsetHeight);
    body += boxSvg(el, ctx);
  });
  if (!boxes.length) return "";
  // The arrows go on top, as on screen, at full strength.
  edgeEls.forEach(function (g) {
    var copy = paintedCopy(g.g);
    if (!copy) return;
    copy.setAttribute("opacity", "0.8");
    body += new XMLSerializer().serializeToString(copy);
    try {
      var b = g.g.getBBox();
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    } catch (e) {
      /* an arrow that isn't drawn has no box */
    }
  });
  var m = 32,
    title = (CONFIG.name || "Architecture map") + " · architecture",
    W0 = x1 - x0 + m * 2,
    H0 = y1 - y0 + m * 2 + 28;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    Math.ceil(W0) +
    '" height="' +
    Math.ceil(H0) +
    '" viewBox="' +
    [Math.floor(x0 - m), Math.floor(y0 - m - 28), Math.ceil(W0), Math.ceil(H0)].join(" ") +
    '"><title>' +
    esc(title) +
    '</title><rect x="' +
    Math.floor(x0 - m) +
    '" y="' +
    Math.floor(y0 - m - 28) +
    '" width="' +
    Math.ceil(W0) +
    '" height="' +
    Math.ceil(H0) +
    '" fill="' +
    esc(getComputedStyle(document.body).backgroundColor) +
    '"/><text x="' +
    (x0 + (x1 - x0) / 2) +
    '" y="' +
    (y0 - m - 6) +
    '" text-anchor="middle" font-family="' +
    esc(getComputedStyle(document.body).fontFamily) +
    '" font-size="15" font-weight="600" fill="' +
    esc(getComputedStyle(document.body).color) +
    '">' +
    esc(title) +
    "</text>" +
    body +
    "</svg>"
  );
}
function exportDiagram() {
  if (!diag) return;
  var text = diagramSvg();
  if (!text) return;
  var a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  a.href = url;
  a.download =
    (CONFIG.name || "architecture")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") + "-architecture.svg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);
}

// ---------- Start here: the map's README, shown first
function showStart(on) {
  $("start").hidden = !on;
  $("bStart").setAttribute("aria-pressed", String(on));
  if (on) $("start").scrollTop = 0;
}
function renderStart() {
  $("startBody").innerHTML =
    README ||
    "<p>This map has no README.md yet. Add one to the map folder to introduce the system.</p>";
}

// ---------- Simple / Detailed: Simple hides the "For developers" sections
var DETAIL = "archmap-detail-v1";
function setSimple(on, remember) {
  document.body.classList.toggle("simple", on);
  $("bSimple").setAttribute("aria-pressed", String(on));
  $("bDetailed").setAttribute("aria-pressed", String(!on));
  if (remember)
    try {
      localStorage.setItem(DETAIL, on ? "simple" : "detailed");
    } catch (e) {
      /* ignore */
    }
}
$("bSimple").onclick = function () {
  setSimple(true, true);
};
$("bDetailed").onclick = function () {
  setSimple(false, true);
};
function initDetail() {
  $("detail").hidden = PUBLIC;
  if (PUBLIC) return setSimple(true, false);
  var saved = null;
  try {
    saved = localStorage.getItem(DETAIL);
  } catch (e) {
    saved = null;
  }
  setSimple(saved === "simple", false);
}

// ---------- loading
function showMsg(h, p) {
  $("msg").hidden = !h;
  $("msgH").textContent = h || "";
  $("msgP").textContent = p || "";
}
var firstFit = false;
function onData() {
  showMsg("");
  render();
  if (!firstFit) {
    firstFit = true;
    var h = location.hash || "";
    // A link to a place on the map goes there; otherwise the README comes first.
    showStart(h.length < 2);
    requestAnimationFrame(function () {
      fitAll();
      applyHash(h);
    });
  }
}
// Redraws the open drawer after new data, if what it shows is still on the map.
function reopenPanel(st) {
  if (!st) return false;
  if (st.type === "table") return !!VM.T[st.id] && (openTable(st.id), true);
  if (st.type === "service") return !!VM.S[st.id] && (openService(st.id), true);
  if (st.type === "persona")
    return !!VM.PER[st.id] && (openPersona(st.id), true);
  if (st.type === "flow") {
    var f = VM.FL[st.id];
    if (!f || view !== "flow" || flowId !== st.id) return false;
    flowStep = Math.max(0, Math.min(flowStep, (f.f.steps || []).length - 1));
    openFlow(st.id);
    return true;
  }
  if (st.type === "flows") return (openFlows(), true);
  if (st.type === "enums") return (openEnums(st.id), true);
  if (st.type === "problems") return (openProblems(), true);
  return false;
}
window.addEventListener("resize", function () {
  if (!sel && !per) fitAll();
});

function applyBrand(cfg) {
  CONFIG = cfg || CONFIG;
  LABELS = CONFIG.labels || {};
  var name = CONFIG.name || "Architecture map",
    product = CONFIG.product || "Architecture map";
  document.title = name + " · " + product;
  $("title").textContent = name;
  var logo = safeHref(CONFIG.logo);
  if (logo) {
    $("logo").src = logo;
    $("logo").hidden = false;
  } else $("logo").hidden = true;
  // The build drops unsafe links too; this is the second check.
  $("hlinks").innerHTML = (Array.isArray(CONFIG.links) ? CONFIG.links : [])
    .map(function (l) {
      var href = l && safeHref(l.url);
      return href
        ? '<a href="' +
            esc(href) +
            '" target="_blank" rel="noopener noreferrer">' +
            esc(l.label) +
            "</a>"
        : "";
    })
    .join("");
  var sheet = CONFIG.fonts && safeStylesheet(CONFIG.fonts.stylesheet);
  if (sheet && $("fontsheet").getAttribute("href") !== sheet)
    $("fontsheet").href = sheet;
  miniColours = null;
  function block(vars) {
    return Object.keys(vars || {})
      .filter(function (k) {
        return /^--[a-z0-9-]+$/i.test(k);
      })
      .map(function (k) {
        return k + ": " + String(vars[k]).replace(/[;{}<>]/g, "") + ";";
      })
      .join(" ");
  }
  var t = CONFIG.theme || {},
    f = CONFIG.fonts || {},
    fonts = "";
  if (f.sans)
    fonts += "--sans: " + String(f.sans).replace(/[;{}<>]/g, "") + ";";
  if (f.mono)
    fonts += "--mono: " + String(f.mono).replace(/[;{}<>]/g, "") + ";";
  $("brandvars").textContent =
    ":root { " +
    block(t.light) +
    fonts +
    " }\n" +
    '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ' +
    block(t.dark) +
    " } }\n" +
    ':root[data-theme="dark"] { ' +
    block(t.dark) +
    " }";
}
var rev = null;
function load(data) {
  var again = !!VM,
    active = document.activeElement,
    focusCard =
      active && active.closest && active.closest(".card")
        ? active.closest(".card").dataset.key
        : null,
    drawer = panel.hidden ? null : NAV[NAV.length - 1] || panelSt;
  // New data redraws every box: a drag or pan in progress would hold a stale one.
  cancelDrag();
  hov = null;
  applyBrand(data.config);
  MODEL = data.model || emptyModel();
  DOCS = data.docs || dict();
  CHECK = {
    errors: (data.check && data.check.errors) || [],
    warnings: (data.check && data.check.warnings) || [],
  };
  README = data.readme || "";
  PUBLIC = !!data.public;
  rev = data.rev;
  buildVM();
  loadPositions();
  if (per && !VM.PER[per]) per = null;
  initDetail();
  renderStart();
  onData();
  if (!again) return;
  if (sel && !cardEls[sel.key]) sel = null;
  apply();
  // The drawer shows the same thing with the new data, or closes if it's gone.
  if (drawer) {
    restoring = true;
    quietPanel = true;
    var ok = false;
    try {
      ok = reopenPanel(drawer);
    } finally {
      restoring = false;
      quietPanel = false;
    }
    if (!ok) clearSel();
  }
  if (focusCard && cardEls[focusCard])
    cardEls[focusCard].focus({ preventScroll: true });
}
function fetchData() {
  return fetch("data.json", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error("data.json: " + r.status);
    return r.json();
  });
}
showMsg("Loading the map…", "Reading the architecture files.");
fetchData().then(
  function (data) {
    load(data);
    // `archmap dev` serves fresh data: pick up saved files without a reload.
    if (data.dev)
      setInterval(function () {
        fetchData().then(
          function (d) {
            if (d.rev !== rev) load(d);
          },
          function () {},
        );
      }, 2000);
  },
  function (err) {
    showMsg(
      "Couldn't load the map",
      (err && err.message) ||
        "data.json is missing. Build the site with archmap build, or run archmap dev.",
    );
  },
);
