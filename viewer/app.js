// archmap viewer: the map's UI. It reads data.json (written by `archmap build`, or served
// fresh by `archmap dev`), which carries the map's model, each doc's text and the check results.

var STORE = "archmap-pos-v1";
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
var LANES = [
  { id: "frontend", name: "Frontend" },
  { id: "backend", name: "Backend" },
  { id: "data", name: "Data stores" },
  { id: "platform", name: "Platform and delivery" },
  { id: "third_party", name: "Third-party and partners" },
  { id: "legacy", name: "Legacy (retiring)" },
];

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
function zvar(area) {
  return "var(--z-" + area + ", var(--z-records))";
}
function lvar(lane) {
  return "var(--l-" + lane + ", var(--l-platform))";
}

// ---------- data: the model, each doc's text (HTML) and what `archmap check` found
var MODEL = null,
  DOCS = {},
  CHECK = { errors: [], warnings: [] },
  README = "",
  PUBLIC = false,
  CONFIG = { name: "Architecture map" },
  LABELS = {};

function emptyModel() {
  return {
    categories: {},
    areas: {},
    tables: {},
    enums: {},
    services: {},
    connections: {},
    personas: {},
    flows: {},
    problems: [],
  };
}

// ---------- UI state
var view = "arch",
  path = [],
  sel = null,
  per = null,
  hov = null,
  query = "";
var P = {};
try {
  P = JSON.parse(localStorage.getItem(STORE) || "{}") || {};
} catch (e) {
  P = {};
}
function savePos() {
  try {
    localStorage.setItem(STORE, JSON.stringify(P));
  } catch (e) {
    /* ignore */
  }
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
var VM = null;
function buildVM() {
  var B = MODEL || emptyModel();
  var vm = {
    B: B,
    tables: [],
    services: [],
    conns: [],
    edges: [],
    areas: {},
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
  vm.T = {};
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
  vm.S = {};
  vm.services.forEach(function (s) {
    vm.S[s.id] = s;
  });
  Object.keys(B.connections).forEach(function (id) {
    var c = B.connections[id];
    if (vm.S[c.from] && vm.S[c.to]) vm.conns.push({ id: id, c: c, st: "" });
  });
  var catIds = Object.keys(B.categories);
  if (catIds.length)
    vm.cats = catIds.map(function (id) {
      // The "outside" lane holds external systems: drawn below the boundary.
      return {
        id: id,
        c: Object.assign({ external: id === "outside" }, B.categories[id]),
        st: "",
      };
    });
  else
    vm.cats = LANES.filter(function (l) {
      return vm.services.some(function (x) {
        return x.s.lane === l.id;
      });
    }).map(function (l, i) {
      return { id: l.id, c: { name: l.name, order: i }, st: "" };
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
        tables = {};
      (p.jobs || []).forEach(function (j) {
        Object.keys(j.t || {}).forEach(function (n) {
          if (j.t[n] === "w" || !tables[n]) tables[n] = j.t[n];
        });
      });
      return { id: id, p: p, tables: tables, st: "" };
    });
  vm.PER = {};
  vm.personas.forEach(function (x) {
    vm.PER[x.id] = x;
  });
  vm.actors = vm.personas.filter(function (x) {
    return (x.p.uses || []).length;
  });
  vm.flows = Object.keys(B.flows)
    .map(function (id) {
      return { id: id, f: B.flows[id], st: "" };
    })
    .sort(function (a, b) {
      return (a.f.order || 0) - (b.f.order || 0);
    });
  vm.FL = {};
  vm.flows.forEach(function (x) {
    vm.FL[x.id] = x;
  });
  VM = vm;
}
function colType(c, m) {
  if (c.enum && m.enums[c.enum])
    return m.enums[c.enum].style === "native"
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
function layoutSchema(vm) {
  var pos = {},
    rows = {};
  areaOrder(vm).forEach(function (id) {
    var r = vm.areas[id].row || 0;
    (rows[r] = rows[r] || []).push(id);
  });
  var y = 0;
  Object.keys(rows)
    .sort()
    .forEach(function (r) {
      var x = 0,
        rowH = 0;
      rows[r].forEach(function (aid) {
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
              y: y + PAD_T + colH[c],
            };
            colH[c] += t.h + GAP;
          });
        var zw = PAD * 2 + n * W + (n - 1) * GAP,
          zh = PAD_T + Math.max(0, Math.max.apply(null, colH) - GAP) + PAD;
        x += zw + ZGAP;
        rowH = Math.max(rowH, zh);
      });
      y += rowH + ZGAP;
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
  tool: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5a3 3 0 0 0-2.9 3.8L2.8 11.1a1.4 1.4 0 0 0 2 2l4.8-4.8a3 3 0 0 0 3.8-2.9l-1.8 1-1.6-.6-.4-1.6z"/></svg>',
  container:
    '<svg viewBox="0 0 16 16"><path d="M2 5.5h12v8H2zM3.5 5.5V3h9v2.5"/></svg>',
};
function stype(s) {
  return (
    s.type ||
    (s.lane === "third_party" || s.lane === "legacy"
      ? "external"
      : s.opens === "schema"
        ? "store"
        : "app")
  );
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
  var tip = s.latest ? ' title="Latest: ' + esc(s.latest) + '"' : "";
  return (
    '<span class="mt ver">· ' +
    esc(s.version) +
    "</span>" +
    (s.fresh && FRESH[s.fresh]
      ? '<span class="fresh f-' + s.fresh + '"' + tip + ">" + FRESH[s.fresh] + "</span>"
      : "")
  );
}
// Inside a service its parts are drawn in labelled groups.
var PART_GROUPS = [
  { type: "endpoint", name: "Endpoints" },
  { type: "job", name: "Jobs" },
  { type: "library", name: "Libraries" },
];
function partGroups(items) {
  var groups = PART_GROUPS.map(function (g) {
    return { name: g.name, items: items.filter(function (x) {
      return stype(x.s) === g.type;
    }) };
  });
  var rest = items.filter(function (x) {
    return !PART_GROUPS.some(function (g) {
      return g.type === stype(x.s);
    });
  });
  groups.push({ name: "Other parts", items: rest });
  return groups.filter(function (g) {
    return g.items.length;
  });
}
function svcCard(x, opts) {
  var s = x.s,
    k = "svc:" + x.id,
    t = stype(s),
    el = document.createElement("div"),
    stub = opts && opts.stub;
  var drillable =
    !stub && (s.opens === "schema" || childrenOf(x.id).length > 0);
  el.className =
    "card svc t-" + t + (stub ? " stub" : "") + (x.st ? " " + x.st : "");
  el.dataset.key = k;
  if (stub) el.title = s.name + " · click to go to it";
  el.style.setProperty("--z", lvar(catOf(x.id)));
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", (drillable ? "Open " : "") + s.name);
  var meta =
    '<div class="meta">' +
    (stub
      ? '<span class="mt">' + esc(catName(catOf(x.id))) + "</span>"
      : '<span class="mt">' +
        TYPE_LABEL[t] +
        "</span>" +
        (s.status && s.status !== "live"
          ? '<span class="mt">· ' + esc(s.status) + "</span>"
          : "") +
        versionBadge(s)) +
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
    (stub
      ? ""
      : '<div class="sbody"><span class="tech">' +
        esc(s.tech || "") +
        '</span><span class="pur">' +
        esc(s.purpose || "") +
        "</span></div>");
  return el;
}
function actorCard(a) {
  var el = document.createElement("div"),
    k = "act:" + a.id;
  el.className = "card actor" + (a.st ? " " + a.st : "");
  el.dataset.key = k;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "Persona " + a.p.name);
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
  });
}
// Architecture is browsed by level: path [] = categories, [cat] = items in a category, [cat, item, ...] = parts of an item.
var CW = 280,
  SIZE = {},
  MH = {},
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
  return VM.services.filter(function (x) {
    return x.s.parent === id;
  });
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
  if (path.length === 1)
    main = VM.services.filter(function (x) {
      return x.s.lane === path[0] && !(x.s.parent && VM.S[x.s.parent]);
    });
  else main = childrenOf(path[path.length - 1]);
  var inMain = {};
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
  var stubs = {},
    agg = {};
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
        c: { from: a.id, to: b.id, label: c.c.label || "", status: c.c.status },
        st: c.st,
        n: 1,
      };
    else {
      x.n++;
      x.c.label = x.n + " connections";
      if (c.c.status !== "planned") x.c.status = c.c.status;
      if (x.st !== c.st) x.st = "changed";
    }
  });
  var conns = Object.keys(agg).map(function (k) {
    return agg[k];
  });
  var actors = [],
    uses = [];
  VM.actors.forEach(function (a) {
    (a.p.uses || []).forEach(function (u) {
      if (inMain[u.to]) {
        if (actors.indexOf(a) === -1) actors.push(a);
        uses.push({ a: a, u: u });
      }
    });
  });
  var allStubs = Object.keys(stubs).length;
  if (!showOutside) {
    stubs = {};
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
  var pos = {};
  SIZE = {};
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
      var n = vm.services.filter(function (x) {
          return x.s.lane === c.id && !x.s.parent;
        }).length,
        h = catCardH(n, c.c.purpose);
      h = hOf("cat:" + c.id, h);
      pos["cat:" + c.id] = { x: i * GX, y: y0 };
      SIZE["cat:" + c.id] = { w: CW, h: h };
      maxH = Math.max(maxH, h);
    });
    var y1 = y0 + maxH + 180;
    outside.forEach(function (c, i) {
      var n = vm.services.filter(function (x) {
          return x.s.lane === c.id && !x.s.parent;
        }).length,
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
  var L = levelSets(),
    cols = Math.min(L.main.length > 9 ? 4 : 3, Math.max(1, L.main.length));
  var sorted = L.main.slice().sort(function (a, b) {
    return (a.s.order || 0) - (b.s.order || 0);
  });
  // Inside a service each group of parts starts its own block of rows.
  var blocks = path.length > 1 ? partGroups(sorted) : [{ items: sorted }];
  // Rows are as tall as their tallest card, so wrapped names never overlap.
  var rowY = PAD_T,
    rowH = 0;
  blocks.forEach(function (b, bi) {
    if (bi) {
      rowY += rowH + ZGAP + PAD_T;
      rowH = 0;
    }
    b.items.forEach(function (x, i) {
      if (i && i % cols === 0) {
        rowY += rowH + 60;
        rowH = 0;
      }
      var h = hOf("svc:" + x.id, SH);
      rowH = Math.max(rowH, h);
      pos["svc:" + x.id] = { x: PAD + (i % cols) * (SW + 70), y: rowY };
      SIZE["svc:" + x.id] = { w: SW, h: h };
    });
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
  var pos = {},
    f = vm.FL[flowId] && vm.FL[flowId].f;
  SIZE = {};
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
      : "arch/" + path.join("/");
}
function posOf(key, def) {
  return P[scope() + "|" + key] || def[key];
}

// ---------- render
var cardEls = {},
  zoneEls = [],
  edgeEls = [],
  DEF = {};
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
  buildVM();
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
  cardLayer.innerHTML = "";
  zoneLayer.innerHTML = "";
  svg.innerHTML = "";
  cardEls = {};
  edgeEls = [];
  zoneEls = [];
  MH = {};
  if (view === "schema") renderSchema();
  else if (view === "flow") renderFlow();
  else renderArch();
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
  drawMini();
}
function keyBadges(st) {
  return st ? '<span class="badge ' + st + '">' + st + "</span>" : "";
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
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", "Table " + t.name);
    var h =
      '<div class="head"><span class="tn">' +
      esc(t.name) +
      "</span>" +
      keyBadges(t.st) +
      (t.t.append ? '<span class="badge">append-only</span>' : "") +
      "</div>";
    t.cols.forEach(function (x, i) {
      var c = x.c,
        key = "<span></span>";
      if (c.pk) key = '<span class="k pk">PK</span>';
      else if (c.fk)
        key =
          '<span class="k fk" style="--zk:' +
          zvar(vm.T[c.fk] ? vm.T[c.fk].t.area : "records") +
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
    h +=
      '<div class="foot">' +
      (t.t.append ? "created_at" : "created_at · updated_at") +
      "</div>";
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
      var items = vm.services
        .filter(function (x) {
          return x.s.lane === c.id && !(x.s.parent && vm.S[x.s.parent]);
        })
        .sort(function (a, b) {
          return (a.s.order || 0) - (b.s.order || 0);
        });
      var st = c.st;
      var el = document.createElement("div"),
        k = "cat:" + c.id;
      el.className =
        "card cat" + (c.c.external ? " ext" : "") + (st ? " " + st : "");
      el.dataset.key = k;
      el.style.setProperty("--z", lvar(c.id));
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", "Open " + c.c.name);
      el.innerHTML =
        '<div class="head"><span class="tn">' +
        esc(c.c.name) +
        '</span></div><div class="meta"><span class="mt">' +
        (c.c.external ? LABELS.outside || "Outside" : "Category") +
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
              (x.st ? " " + x.st : "") +
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
      var byCat = {};
      (a.p.uses || []).forEach(function (u) {
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
    var agg = {};
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
  var L = levelSets(),
    lastName =
      path.length === 1
        ? (
            vm.cats.filter(function (c) {
              return c.id === path[0];
            })[0] || { c: { name: path[0] } }
          ).c.name
        : vm.S[path[path.length - 1]]
          ? vm.S[path[path.length - 1]].s.name + " · parts"
          : "Parts";
  var mainKeys = L.main.map(function (x) {
      return "svc:" + x.id;
    }),
    stubKeys = L.stubs.map(function (x) {
      return "svc:" + x.id;
    }),
    zoneColour = path.length === 1 ? path[0] : catOf(path[path.length - 1]);
  var mainZones =
    path.length > 1 && vm.S[path[path.length - 1]]
      ? partGroups(L.main).map(function (g) {
          return [
            g.items.map(function (x) {
              return "svc:" + x.id;
            }),
            vm.S[path[path.length - 1]].s.name + " · " + g.name,
            zoneColour,
          ];
        })
      : [[mainKeys, lastName, zoneColour]];
  mainZones
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
      "<span>Nothing recorded inside yet. Ask Claude to record its parts.</span></b>";
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
  var pairCount = {};
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
function place() {
  Object.keys(cardEls).forEach(function (k) {
    var q = posOf(k, DEF);
    cardEls[k].style.left = q.x + "px";
    cardEls[k].style.top = q.y + "px";
  });
  zoneEls.forEach(function (z) {
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
      z.box = {
        x: x0 - PAD,
        y: y0 - PAD_T,
        w: x1 - x0 + PAD * 2,
        h: y1 - y0 + PAD_T + PAD,
      };
    }
    z.el.style.left = z.box.x + "px";
    z.el.style.top = z.box.y + "px";
    z.el.style.width = z.box.w + "px";
    z.el.style.height = z.box.h + "px";
  });
  edgeEls.forEach(function (g) {
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
    var t = VM.T[k];
    return (
      !!t &&
      (t.name.indexOf(query) !== -1 ||
        t.cols.some(function (x) {
          return x.c.name.indexOf(query) !== -1;
        }))
    );
  }
  if (k.indexOf("cat:") === 0) {
    var c = VM.cats.filter(function (x) {
      return "cat:" + x.id === k;
    })[0];
    return !!c && c.c.name.toLowerCase().indexOf(query) !== -1;
  }
  var s = VM.S[k.slice(4)];
  return (
    !!s &&
    ((s.s.name || "").toLowerCase().indexOf(query) !== -1 ||
      (s.s.tech || "").toLowerCase().indexOf(query) !== -1)
  );
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
  document.querySelectorAll(".badge.w, .badge.r").forEach(function (b) {
    b.remove();
  });
  document.querySelectorAll(".row.hl").forEach(function (r) {
    r.classList.remove("hl");
  });
  var fade = view === "schema" && $("fadePerson").checked;
  if (per && view === "schema" && VM.PER[per]) {
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
      fl = !f && (filtHover || FILT);
    Object.keys(cardEls).forEach(function (k) {
      var el = cardEls[k],
        m = matchKey(k);
      el.classList.remove("pon");
      el.classList.toggle("on", k === f);
      el.classList.toggle("rel", !!rel && rel.has(k) && k !== f);
      el.classList.toggle("match", !f && m);
      el.classList.toggle(
        "dim",
        rel ? !rel.has(k) : fl ? !filterMatch(k, fl) : !!query && !m,
      );
    });
    edgeEls.forEach(function (g) {
      var a = g.e ? g.e.s : g.a,
        b = g.e ? g.e.t : g.b,
        touch = !!f && (a === f || b === f);
      g.g.classList.toggle("hl", touch);
      g.g.classList.toggle(
        "dim",
        f ? !touch : !!fl && !(filterMatch(a, fl) && filterMatch(b, fl)),
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
}

// ---------- filter bar (status and type), IcePanel-style: hover highlights, click focuses
var FILT = null,
  filtHover = null;
function svcsForKey(k) {
  if (k.indexOf("svc:") === 0)
    return VM.S[k.slice(4)] ? [VM.S[k.slice(4)]] : [];
  if (k.indexOf("cat:") === 0)
    return VM.services.filter(function (x) {
      return x.s.lane === k.slice(4);
    });
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
  var pool = Object.keys(cardEls).reduce(function (acc, k) {
    svcsForKey(k).forEach(function (x) {
      if (acc.indexOf(x) === -1) acc.push(x);
    });
    return acc;
  }, []);
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
    group(
      "Status",
      "status",
      ["live", "in build", "planned", "retiring", "external"],
      function (x) {
        return x.s.status || "live";
      },
    ) +
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
var mini = null;
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
    cs = getComputedStyle(document.documentElement);
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
  ctx.fillStyle = cs.getPropertyValue("--dot").trim() || "#ccc";
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
  ctx.strokeStyle = cs.getPropertyValue("--accent").trim() || "#2d6cdf";
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
  flowId = id;
  flowStep = 0;
  view = "flow";
  sel = null;
  per = null;
  hov = null;
  NAV = NAV.length ? NAV : [];
  render();
  fitAll();
  openFlow(id);
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
            (x.st ? " · " + x.st : "") +
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
  var b = DOCS[id]
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
  showPanel(esc(x.f.name), b, false, { type: "flow", id: id });
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
    );
    V.k = Math.min(V.k, 1);
  }
  drawMini();
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
          zvar(id) +
          '"><i></i>' +
          esc(VM.areas[id].name) +
          " <span>" +
          n +
          "</span></button>"
        );
      })
      .join("");
  } else {
    chips.innerHTML = LANES.filter(function (l) {
      return VM.services.some(function (s) {
        return s.s.lane === l.id;
      });
    })
      .map(function (l) {
        var n = VM.services.filter(function (s) {
          return s.s.lane === l.id;
        }).length;
        return (
          '<button type="button" class="chip" data-lane="' +
          l.id +
          '" style="--z:' +
          lvar(l.id) +
          '"><i></i>' +
          esc(l.name) +
          " <span>" +
          n +
          "</span></button>"
        );
      })
      .join("");
  }
  chips.querySelectorAll(".chip").forEach(function (b, i) {
    b.onclick = function () {
      fitTo(zoneEls[i].box);
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
          " · " +
          Object.keys(x.tables).length +
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
  restoring = false;
function showPanel(title, body, mono, st) {
  if (!restoring && st) {
    var top = NAV[NAV.length - 1];
    if (!top || !same(top, st)) NAV.push(st);
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
    "<h2" +
    (mono ? ' class="mono"' : "") +
    ">" +
    title +
    '</h2><button type="button" class="x" id="close" aria-label="Close details">Close</button></div>' +
    body;
  panel.hidden = false;
  panel.scrollTop = 0;
  // Start here sits above the drawer, so it closes whenever a drawer opens.
  showStart(false);
  $("close").onclick = clearSel;
  if ($("back")) $("back").onclick = goBack;
  panel.querySelectorAll("[data-go]").forEach(function (b) {
    b.onclick = function () {
      goTo(b.getAttribute("data-go"));
    };
  });
  panel.querySelectorAll("[data-persona]").forEach(function (b) {
    b.onclick = function () {
      if (view !== "schema") setView("schema");
      selectPersona(b.getAttribute("data-persona"));
    };
  });
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
  var i = ref.indexOf(":"),
    kind = ref.slice(0, i),
    id = ref.slice(i + 1);
  if (kind === "column") {
    kind = "table";
    id = id.split(".")[0];
  }
  if (kind === "connection") {
    var c = VM.B.connections[id];
    if (!c) return;
    kind = "service";
    id = c.from;
  }
  if (kind === "enum") {
    if (view !== "schema") setView("schema");
    openEnums(id);
    return;
  }
  if (kind === "persona") {
    if (view !== "schema") setView("schema");
    selectPersona(id);
    return;
  }
  if (kind === "table") {
    if (view !== "schema") setView("schema");
    if (VM.T[id]) {
      select(id);
      centerOn(id);
    }
    return;
  }
  if (kind === "service") {
    if (!VM.S[id]) return;
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
  var d = DOCS[id];
  if (!d) return "";
  var code = d.code || [],
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
    z +
    '"><i></i><span><b>' +
    esc(title) +
    "</b><small>" +
    esc(sub) +
    "</small></span></button>"
  );
}
function openTable(name) {
  var t = VM.T[name],
    vm = VM,
    area = vm.areas[t.t.area] || { name: t.t.area };
  var out = {},
    inc = {};
  vm.edges.forEach(function (e) {
    if (e.s === name) (out[e.t] = out[e.t] || []).push(e.col);
    if (e.t === name) (inc[e.s] = inc[e.s] || []).push(e.col);
  });
  var b =
    '<div class="meta"><span class="pill" style="--z:' +
    zvar(t.t.area) +
    '"><i></i>' +
    esc(area.name) +
    "</span>" +
    (t.t.append ? '<span class="pill">append-only</span>' : "") +
    (t.st ? '<span class="pill">' + t.st + "</span>" : "") +
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
    var en = c.enum ? m.enums[c.enum] || {} : null;
    b +=
      '<div class="col' +
      (x.st ? " " + x.st : "") +
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
    '<div class="col"><div class="cl1"><code>created_at</code><span class="t">timestamptz</span></div><p>When the row was written. Every table has it.</p></div>';
  if (!t.t.append)
    b +=
      '<div class="col"><div class="cl1"><code>updated_at</code><span class="t">timestamptz</span></div><p>Last change; doubles as the edit-conflict check.</p></div>';
  showPanel(esc(name), b, true, { type: "table", id: name });
}
function openService(id) {
  var x = VM.S[id],
    s = x.s,
    vm = VM;
  var b =
    '<div class="meta"><span class="pill" style="--z:' +
    lvar(catOf(id)) +
    '"><i></i>' +
    esc(catName(catOf(id))) +
    "</span>" +
    (s.status ? '<span class="pill">' + esc(s.status) + "</span>" : "") +
    (x.st ? '<span class="pill">' + x.st + "</span>" : "") +
    "</div>";
  var parent = s.parent && vm.S[s.parent];
  if (DOCS[id]) b += docBlocks(id);
  else if (parent)
    b +=
      "<h3>Part of</h3>" +
      '<div class="links">' +
      linkBtn(
        "service:" + s.parent,
        parent.s.name,
        TYPE_LABEL[stype(parent.s)] || "",
        lvar(catOf(s.parent)),
      ) +
      "</div>";
  else b += '<p class="lead">' + esc(s.purpose || "") + "</p>";
  if (s.tech)
    b +=
      '<p class="small"><b>' +
      esc(TYPE_LABEL[stype(s)] || "Tech") +
      ":</b> " +
      esc(s.tech) +
      "</p>";
  if (s.owner) b += '<p class="small"><b>Owner:</b> ' + esc(s.owner) + "</p>";
  if (s.env)
    b += '<p class="small"><b>Environments:</b> ' + esc(s.env) + "</p>";
  if (s.facts && s.facts.length)
    b +=
      '<h3>Facts</h3><dl class="facts">' +
      s.facts
        .map(function (f) {
          return "<dt>" + esc(f.k) + "</dt><dd>" + esc(f.v) + "</dd>";
        })
        .join("") +
      "</dl>";
  if (s.notes) b += '<p class="note open">' + esc(s.notes) + "</p>";
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
  showPanel(esc(s.name), b, false, { type: "service", id: id });
  if ($("openSchema"))
    $("openSchema").onclick = function () {
      clearSel();
      setView("schema");
    };
}
function openPersona(id) {
  var x = VM.PER[id],
    p = x.p,
    names = Object.keys(x.tables),
    nw = names.filter(function (n) {
      return x.tables[n] === "w";
    }).length;
  var open = (p.jobs || []).filter(function (j) {
    return (j.gap && !j.fix) || j.open;
  }).length;
  var b =
    '<div class="meta">' +
    (p.kind ? '<span class="pill">' + esc(p.kind) + "</span>" : "") +
    (p.who ? '<span class="pill">' + esc(p.who) + "</span>" : "") +
    '<span class="pill">' +
    names.length +
    " tables · writes " +
    nw +
    '</span><span class="pill">' +
    open +
    " open</span></div>";
  b += DOCS[id]
    ? docBlocks(id)
    : '<p class="lead">' + esc(p.blurb || "") + "</p>";
  if (p.subtypes && p.subtypes.length)
    b +=
      "<h3>Subtypes</h3>" +
      p.subtypes
        .map(function (s) {
          return (
            '<p class="small"><b>' +
            esc(s.name) +
            ".</b> " +
            esc(s.note) +
            "</p>"
          );
        })
        .join("");
  b += "<h3>Jobs to be done · " + (p.jobs || []).length + "</h3>";
  (p.jobs || []).forEach(function (j) {
    var keys = Object.keys(j.t || {});
    b += '<div class="job"><p>' + esc(j.job) + "</p>";
    if (keys.length)
      b +=
        '<div class="tl">' +
        keys
          .map(function (n) {
            return (
              '<button type="button" class="tchip ' +
              j.t[n] +
              '" data-go="table:' +
              esc(n) +
              '">' +
              esc(n) +
              "</button>"
            );
          })
          .join("") +
        "</div>";
    if (j.gap) b += '<p class="note gap"><b>Gap:</b> ' + esc(j.gap) + "</p>";
    if (j.fix)
      b +=
        '<p class="note ' +
        (j.open ? "open" : "fix") +
        '">' +
        esc(j.fix) +
        "</p>";
    if (j.note) b += '<p class="small">' + esc(j.note) + "</p>";
    b += "</div>";
  });
  if (p.source)
    b +=
      '<p class="small">Source: ' +
      esc(p.source) +
      ". Filled chips: the persona writes; outlined: reads.</p>";
  showPanel(esc(p.name), b, false, { type: "persona", id: id });
}
function openEnums(focus) {
  var B = VM.B,
    names = Object.keys(B.enums);
  names.sort();
  var uses = {};
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
    panel.hidden = true;
    NAV = [];
    render();
    fitAll();
    openService(id);
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
  path = p;
  view = "arch";
  sel = null;
  per = null;
  hov = null;
  panel.hidden = true;
  NAV = [];
  render();
  fitAll();
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
}
function selectPersona(id) {
  if (per === id) {
    clearSel();
    return;
  }
  per = id;
  sel = null;
  hov = null;
  apply();
  openPersona(id);
  var keys = Object.keys(VM.PER[id].tables).filter(function (k) {
    return cardEls[k];
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
function clearSel() {
  sel = null;
  per = null;
  NAV = [];
  panel.hidden = true;
  apply();
}
function setView(v) {
  if (view === v) return;
  if (v === "schema") path = schemaPath();
  else if (path.length) path = path.slice(0, -1);
  view = v;
  sel = null;
  per = null;
  hov = null;
  panel.hidden = true;
  render();
  fitAll();
}

// ---------- pan and zoom
var V = { x: 0, y: 0, k: 1 };
function setT() {
  world.style.transform =
    "translate(" + V.x + "px," + V.y + "px) scale(" + V.k + ")";
  drawMini();
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
function fitTo(b, leavePanel) {
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
    Math.min(1.2, Math.min((w - m * 2) / b.w, (h - m * 2) / b.h)),
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
  var r = vp.getBoundingClientRect(),
    q = posOf(key, DEF),
    w = view === "schema" ? W : (SIZE[key] || { w: SW }).w,
    h =
      view === "schema"
        ? Math.min(VM.T[key].h, 300)
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
    if (ev.target.closest(".panel, .legend, .controls, .msg div, .start"))
      return;
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
  pinch = null;
vp.addEventListener("pointerdown", function (ev) {
  if (ev.target.closest(".panel, .controls, .legend, .msg div, .start")) return;
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
  if (card) {
    var q = posOf(card.dataset.key, DEF);
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
      // A click on a box (no movement) still opens it.
      key: card ? card.dataset.key : null,
      sx: ev.clientX,
      sy: ev.clientY,
      ox: V.x,
      oy: V.y,
      moved: false,
    };
    vp.classList.add("panning");
  }
  vp.setPointerCapture(ev.pointerId);
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
    place();
  }
});
function end(ev) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drag) return;
  if (!drag.moved && drag.key) activate(drag.key);
  else if (drag.kind === "card") savePos();
  else if (!drag.moved && (sel || per)) clearSel();
  drag = null;
  vp.classList.remove("panning");
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
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") clearSel();
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
  var hit = Object.keys(cardEls).filter(matchKey)[0];
  if (!hit) {
    // look in the other view
    var svc = VM.services.filter(function (s) {
      return (
        (s.s.name || "").toLowerCase().indexOf(query) !== -1 ||
        (s.s.tech || "").toLowerCase().indexOf(query) !== -1
      );
    })[0];
    var tbl = VM.tables.filter(function (t) {
      return (
        t.name.indexOf(query) !== -1 ||
        t.cols.some(function (x) {
          return x.c.name.indexOf(query) !== -1;
        })
      );
    })[0];
    if (view === "schema" ? svc : !tbl && svc) goTo("service:" + svc.id);
    else if (tbl) goTo("table:" + tbl.name);
    return;
  }
  select(hit);
  centerOn(hit);
});
$("fadePerson").onchange = apply;
$("bFlows").onclick = openFlows;
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
$("bEnums").onclick = function () {
  openEnums();
};
$("bStart").onclick = function () {
  showStart(true);
};
$("startGo").onclick = function () {
  showStart(false);
};

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
    var h = (location.hash || "").slice(1);
    // A link to a place on the map goes there; otherwise the README comes first.
    showStart(!h);
    if (h === "schema") setView("schema");
    requestAnimationFrame(function () {
      fitAll();
      if (h.indexOf("t-") === 0 && VM.T[h.slice(2)])
        goTo("table:" + h.slice(2));
      if (h.indexOf("s-") === 0 && VM.S[h.slice(2)])
        goTo("service:" + h.slice(2));
    });
  }
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
  if (CONFIG.logo) {
    $("logo").src = CONFIG.logo;
    $("logo").hidden = false;
  } else $("logo").hidden = true;
  $("hlinks").innerHTML = (CONFIG.links || [])
    .map(function (l) {
      return (
        '<a href="' +
        esc(l.url) +
        '" target="_blank" rel="noopener">' +
        esc(l.label) +
        "</a>"
      );
    })
    .join("");
  if (CONFIG.fonts && CONFIG.fonts.stylesheet)
    $("fontsheet").href = CONFIG.fonts.stylesheet;
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
  applyBrand(data.config);
  MODEL = data.model || emptyModel();
  DOCS = data.docs || {};
  CHECK = {
    errors: (data.check && data.check.errors) || [],
    warnings: (data.check && data.check.warnings) || [],
  };
  README = data.readme || "";
  PUBLIC = !!data.public;
  rev = data.rev;
  initDetail();
  renderStart();
  onData();
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
