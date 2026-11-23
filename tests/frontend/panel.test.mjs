// Smoke tests for the sidebar panel and the cards, with generic DOM stubs (no
// npm, no browser): the entry module (necromancer.js) defines the four
// elements, and each renders a guard list, a single guard and the PoE ports
// from a stub hass without throwing and without leaking the heartbeat URL;
// the panel applies the per-user settings.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// ---- generic DOM stubs -----------------------------------------------------
//
// A small DOM, no npm: `innerHTML` is parsed into a node tree (tags, attributes,
// classes, data-*, text; registered custom elements are upgraded), and
// `querySelector`/`closest`/`matches` understand tag, .class, #id, [attr],
// [attr="v"] and the descendant/child combinators. A selector outside that
// subset (pseudo-classes) gets a stand-in node, so the code under test runs on.
// Everything written stays readable for the assertions via `dump()`.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["style", "script", "textarea"]);
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const unescape = (v) => String(v).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const camel = (k) => k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

function parseInto(parent, html) {
  const stack = [parent];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const i = stack.map((n) => n.localName).lastIndexOf(m[1].toLowerCase());
      if (i > 0) stack.length = i;
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const C = registry.get(tag);
      const el = C ? new C() : new FakeNode(tag);
      el.localName = tag;
      let a;
      ATTR.lastIndex = 0;
      while ((a = ATTR.exec(m[3] || ""))) el.setAttribute(a[1].toLowerCase(), unescape(a[2] ?? a[3] ?? a[4] ?? ""));
      top._kids.push(el);
      el.parent = top;
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
        const stop = end < 0 ? html.length : end;
        el._text = html.slice(TOKEN.lastIndex, stop);
        TOKEN.lastIndex = stop;
      } else if (!VOID.has(tag) && !m[4]) stack.push(el);
      continue;
    }
    const text = new FakeNode("#text");
    text.nodeType = 3;
    text._text = unescape(m[0]);
    text.parent = top;
    top._kids.push(text);
  }
}

function parseSelector(sel) {
  const out = [];
  for (const part of String(sel).split(",")) {
    const src = part.trim();
    if (!src || /[:+~]|\*=|\^=|\$=|\|=|~=/.test(src.replace(/\[[^\]]*\]/g, (x) => x.replace(/[:+~]/g, "")))) return null;
    const toks = src.replace(/\s*>\s*/g, " > ").split(/\s+/);
    const chain = [];
    let comb = " ";
    for (const tok of toks) {
      if (tok === ">") {
        comb = ">";
        continue;
      }
      const cm = /^(\*|[a-zA-Z][\w-]*)?((?:\.[\w-]+|#[\w-]+|\[[^\]]+\])*)$/.exec(tok);
      if (!cm) return null;
      const c = { tag: cm[1] && cm[1] !== "*" ? cm[1].toLowerCase() : null, cls: [], id: null, attrs: [], comb };
      for (const p of cm[2].match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || []) {
        if (p[0] === ".") c.cls.push(p.slice(1));
        else if (p[0] === "#") c.id = p.slice(1);
        else {
          const am = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/.exec(p);
          if (!am) return null;
          c.attrs.push([am[1].toLowerCase(), am[2] ?? am[3] ?? am[4]]);
        }
      }
      chain.push(c);
      comb = " ";
    }
    out.push(chain);
  }
  return out;
}

function matchCompound(n, c) {
  if (!n || n.nodeType !== 1) return false;
  if (c.tag && n.localName !== c.tag) return false;
  if (c.id && n.attrs.id !== c.id) return false;
  for (const k of c.cls) if (!n.classList.contains(k)) return false;
  for (const [k, v] of c.attrs) if (!(k in n.attrs) || (v !== undefined && n.attrs[k] !== v)) return false;
  return true;
}

function matchChain(n, chain, i = chain.length - 1) {
  if (!matchCompound(n, chain[i])) return false;
  if (i === 0) return true;
  if (chain[i].comb === ">") return matchChain(n.parent, chain, i - 1);
  for (let p = n.parent; p; p = p.parent) if (matchChain(p, chain, i - 1)) return true;
  return false;
}

class FakeNode {
  constructor(tag = "div") {
    this.localName = tag;
    this.nodeType = 1;
    this._kids = [];
    this.parent = null;
    this._html = "";
    this._text = "";
    this.attrs = {};
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this._subs = new Map();
    this._listeners = {};
    const props = {};
    this.style = {
      props,
      cssText: "",
      setProperty: (k, v) => (props[k] = v),
      removeProperty: (k) => delete props[k],
      getPropertyValue: (k) => props[k] ?? "",
    };
    const set = new Set();
    this.classList = {
      set,
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !set.has(c) : Boolean(on);
        if (want) set.add(c);
        else set.delete(c);
        return want;
      },
    };
  }
  get tagName() {
    return this.localName.toUpperCase();
  }
  get id() {
    return this.attrs.id || "";
  }
  set id(v) {
    this.setAttribute("id", v);
  }
  get className() {
    return [...this.classList.set].join(" ");
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get hidden() {
    return "hidden" in this.attrs;
  }
  set hidden(v) {
    if (v) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  set innerHTML(v) {
    this._html = String(v);
    this._subs = new Map();
    for (const c of this._kids) c.parent = null;
    this._kids = [];
    this._text = "";
    parseInto(this, this._html);
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(v) {
    for (const c of this._kids) c.parent = null;
    this._kids = [];
    this._text = v == null ? "" : String(v);
  }
  get textContent() {
    return this._text + this._kids.map((k) => k.textContent).join("");
  }
  get children() {
    return this._kids.filter((k) => k.nodeType === 1);
  }
  get childNodes() {
    return this._kids;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    const c = this.children;
    return c[c.length - 1] || null;
  }
  get parentElement() {
    return this.parent;
  }
  get parentNode() {
    return this.parent;
  }
  get nextElementSibling() {
    const sib = this.parent ? this.parent.children : [];
    return sib[sib.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    const sib = this.parent ? this.parent.children : [];
    return sib[sib.indexOf(this) - 1] || null;
  }
  get offsetWidth() {
    return 400;
  }
  get clientWidth() {
    return 400;
  }
  get scrollWidth() {
    return 400;
  }
  *_descendants() {
    for (const k of this._kids) {
      if (k.nodeType !== 1) continue;
      yield k;
      yield* k._descendants();
    }
  }
  _standIn(sel) {
    if (!this._subs.has(sel)) {
      const n = new FakeNode(sel);
      n.parent = this;
      this._subs.set(sel, n);
    }
    return this._subs.get(sel);
  }
  querySelectorAll(sel) {
    const chains = parseSelector(sel);
    if (!chains) return [this._standIn(sel)];
    return [...this._descendants()].filter((n) => chains.some((ch) => matchChain(n, ch)));
  }
  querySelector(sel) {
    const chains = parseSelector(sel);
    if (!chains) return this._standIn(sel);
    for (const n of this._descendants()) if (chains.some((ch) => matchChain(n, ch))) return n;
    return null;
  }
  matches(sel) {
    const chains = parseSelector(sel);
    return Boolean(chains) && chains.some((ch) => matchChain(this, ch));
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (n.nodeType === 1 && n.matches(sel)) return n;
    return null;
  }
  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  getRootNode() {
    let x = this;
    while (x.parent) x = x.parent;
    return x;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    events.push([ev.type, ev.detail]);
    return true;
  }
  setAttribute(k, v) {
    v = String(v);
    this.attrs[k] = v;
    if (k === "class") {
      this.classList.set.clear();
      for (const c of v.split(/\s+/).filter(Boolean)) this.classList.set.add(c);
    } else if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
  }
  getAttribute(k) {
    if (k === "class") return this.className || this.attrs.class || null;
    return this.attrs[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k.startsWith("data-")) delete this.dataset[camel(k.slice(5))];
  }
  toggleAttribute(k, on) {
    const want = on === undefined ? !(k in this.attrs) : Boolean(on);
    if (want) this.setAttribute(k, "");
    else this.removeAttribute(k);
    return want;
  }
  _adopt(nodes) {
    const out = [];
    for (const n of nodes) {
      const node = typeof n === "string" ? Object.assign(new FakeNode("#text"), { nodeType: 3, _text: n }) : n;
      if (node.parent) node.parent._kids = node.parent._kids.filter((c) => c !== node);
      node.parent = this;
      out.push(node);
    }
    return out;
  }
  append(...nodes) {
    this._kids.push(...this._adopt(nodes));
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  prepend(...nodes) {
    this._kids.unshift(...this._adopt(nodes));
  }
  insertBefore(n, ref) {
    this._adopt([n]);
    const i = ref ? this._kids.indexOf(ref) : -1;
    if (i < 0) this._kids.push(n);
    else this._kids.splice(i, 0, n);
    return n;
  }
  replaceChildren(...nodes) {
    for (const c of this._kids) c.parent = null;
    this._kids = [];
    this.append(...nodes);
  }
  removeChild(n) {
    n.remove();
    return n;
  }
  remove() {
    if (this.parent) this.parent._kids = this.parent._kids.filter((c) => c !== this);
    this.parent = null;
  }
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  show() {}
  showModal() {}
  close() {}
  animate() {
    return { cancel() {}, finished: Promise.resolve() };
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 400, bottom: 40, width: 400, height: 40, x: 0, y: 0 };
  }
}

/** Everything a node and its subtree ever got written, as one string. */
// Event texts keep a number with its noun (no-break spaces): compare them
// as plain text.
const sp = (s) => String(s).replace(/\u00a0/g, " ");

function dump(node, seen = new Set()) {
  if (!node || seen.has(node)) return "";
  seen.add(node);
  const own = [node._html, node._text, ...Object.values(node.attrs || {})].filter(Boolean).join("\n");
  const kids = [...(node._kids || []), ...((node._subs && node._subs.values()) || []), node.shadowRoot];
  return [own, ...kids.map((k) => dump(k, seen))].filter(Boolean).join("\n");
}

class FakeObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe(target) {
    // Everything is on screen: cards that pause while hidden render at once.
    queueMicrotask(() => this.cb([{ target, isIntersecting: true, intersectionRatio: 1, contentRect: { width: 400, height: 300 } }], this));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const registry = new Map();
const events = [];
const mounted = [];
// The test's own waits keep the event loop alive; the cards' tick and confirm
// timers must not, or a card left mounted would hold the run open.
const realSetTimeout = setTimeout;
const unref = (fn) => (...a) => {
  const h = fn(...a);
  if (h && typeof h.unref === "function") h.unref();
  return h;
};
const logs = [];
const CONNECTED = Symbol("connected");

before(async () => {
  globalThis.HTMLElement = class extends FakeNode {
    constructor() {
      super();
      // An element HA created and fed before the module defined it (upgrade).
      for (const [k, v] of Object.entries(globalThis.__preUpgrade || {})) {
        Object.defineProperty(this, k, { value: v, writable: true, configurable: true, enumerable: true });
      }
    }
    attachShadow() {
      this.shadowRoot = new FakeNode("#shadow");
      this.shadowRoot.host = this;
      this.shadowRoot.adoptedStyleSheets = [];
      this.shadowRoot.activeElement = null;
      return this.shadowRoot;
    }
    get isConnected() {
      return Boolean(this[CONNECTED]);
    }
  };
  globalThis.customElements = {
    get: (n) => registry.get(n),
    define: (n, c) => registry.set(n, c),
    whenDefined: async () => {},
  };
  globalThis.window = globalThis;
  globalThis.location = { origin: "http://ha.local:8123", pathname: "/necromancer", search: "", hash: "" };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.isSecureContext = true;
  globalThis.CSSStyleSheet = class {
    replaceSync(css) {
      this.css = css;
    }
    async replace(css) {
      this.css = css;
      return this;
    }
  };
  globalThis.setTimeout = unref(realSetTimeout);
  globalThis.setInterval = unref(setInterval);
  globalThis.IntersectionObserver = FakeObserver;
  globalThis.ResizeObserver = FakeObserver;
  globalThis.MutationObserver = FakeObserver;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.history = { pushState() {}, replaceState() {} };
  const win = new FakeNode("#window");
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  const body = new FakeNode("body");
  globalThis.document = {
    body,
    documentElement: new FakeNode("html"),
    activeElement: null,
    addEventListener: body.addEventListener.bind(body),
    removeEventListener: body.removeEventListener.bind(body),
    createElement: (tag) => {
      const C = registry.get(tag);
      const el = C ? new C() : new FakeNode(tag);
      el.localName = tag;
      return el;
    },
    createTextNode: (text) => Object.assign(new FakeNode("#text"), { textContent: String(text) }),
    execCommand: () => false,
  };
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[k];
    console[k] = (...a) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    };
  }
  await import("../../custom_components/necromancer/frontend/necromancer.js?v=test");
});

function guard(slug, state, name) {
  return {
    entity_id: `sensor.${slug}_status`,
    state,
    last_changed: new Date().toISOString(),
    attributes: { guard_name: name, health_type: "template", revive_entity: null, driver_type: "notify" },
  };
}

function makeHass(states, stored) {
  const all = Object.fromEntries(states.map((s) => [s.entity_id, s]));
  return {
    language: "en",
    locale: { language: "en", time_format: "24" },
    user: { is_admin: true },
    entities: Object.fromEntries(states.map((s) => [s.entity_id, { platform: "necromancer", translation_key: "status" }])),
    states: all,
    ws: [],
    async callWS(msg) {
      this.ws.push(msg);
      return { value: stored };
    },
    async callService() {
      return {};
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("properties set before the upgrade still reach the panel", async () => {
  const Panel = registry.get("necromancer-panel");
  const hass = makeHass([guard("a", "escalated", "Alpha")]);
  globalThis.__preUpgrade = { hass, narrow: true };
  let panel;
  try {
    panel = new Panel();
  } finally {
    globalThis.__preUpgrade = null;
  }
  await tick();
  assert.ok(!Object.prototype.hasOwnProperty.call(panel, "hass"));
  assert.equal(panel.hass, hass);
});

// ---- the real elements -------------------------------------------------------

const SECRET = "/api/necromancer/heartbeat/backup_SECRETTOKEN";

/** A small but complete guard set: every type, problems and quiet ones. */
function cardHass() {
  const now = Date.now();
  const iso = (s) => new Date(now - s * 1000).toISOString();
  const states = {};
  const entities = {};
  const add = (so, entry) => {
    states[so.entity_id] = so;
    if (entry) entities[so.entity_id] = entry;
  };
  const status = (slug, state, name, attrs = {}) =>
    add(
      {
        entity_id: `sensor.${slug}_status`,
        state,
        last_changed: iso(900),
        last_updated: iso(900),
        attributes: {
          guard_name: name,
          friendly_name: `${name} Status`,
          health_type: "entity_state",
          health_entity: `binary_sensor.${slug}_health`,
          auto_recovery_entity: `switch.${slug}_auto_recovery`,
          revive_entity: `button.${slug}_revive`,
          recovery_event_entity: `event.${slug}_recovery`,
          driver_type: "switch",
          driver_entity: `switch.${slug}_power`,
          recover_count: 2,
          fail_count: 1,
          ...attrs,
        },
      },
      { platform: "necromancer", translation_key: "status", device_id: `dev_${slug}` },
    );
  status("alpha", "escalated", "Alpha", { health_detail: "Device offline" });
  status("bravo", "ok", "Bravo");
  status("charlie", "snoozed", "Charlie", { snooze_until: new Date(now + 3600e3).toISOString() });
  status("delta", "recovering", "Delta", { driver_type: "poe_port", driver_entity: null });
  status("backup", "blind", "Nightly Backup", {
    health_type: "heartbeat",
    revive_entity: null,
    auto_recovery_entity: null,
    driver_type: "notify",
    driver_entity: null,
    last_heartbeat_entity: "sensor.backup_last_heartbeat",
  });
  for (const slug of ["alpha", "bravo", "charlie", "delta", "backup"]) {
    add({ entity_id: `binary_sensor.${slug}_health`, state: slug === "alpha" ? "off" : "on", attributes: {} });
    add({ entity_id: `switch.${slug}_auto_recovery`, state: slug === "bravo" ? "off" : "on", attributes: {} });
    add({ entity_id: `event.${slug}_recovery`, state: slug === "alpha" ? iso(600) : "unknown", attributes: { event_type: "escalated", attempt: 2 } });
  }
  add({ entity_id: "sensor.backup_last_heartbeat", state: "unknown", attributes: { period: 3600 } });
  add({ entity_id: "switch.port_5_poe", state: "off", attributes: { friendly_name: "USW Port 5 PoE" } });
  const poe = [
    {
      label: "Port 5",
      actuator: "switch.port_5_poe",
      actuator_state: "off",
      id_source: "entity",
      id_entity: "sensor.port_5_lldp",
      id: "AA:BB",
      status_entity: null,
      status_on: [],
      status_off: [],
      fabric_status: "good",
      last_cycle: { time: iso(7200), ok: true },
      guards: [{ name: "Delta", status_entity: "sensor.delta_status", expected_id: "aa:bb", match: "live" }],
    },
  ];
  return {
    language: "en",
    locale: { language: "en", time_format: "24", time_zone: "server" },
    config: { time_zone: "Europe/Berlin" },
    user: { is_admin: true },
    entities,
    devices: {},
    areas: {},
    states,
    themes: { darkMode: false },
    ws: [],
    calls: [],
    async callWS(msg) {
      this.ws.push(msg);
      if (msg.type === "necromancer/poe/ports") return { entry_id: "e1", ports: poe };
      if (msg.type === "frontend/get_user_data") return { value: null };
      return {};
    },
    async callService(domain, service, data, target) {
      this.calls.push([domain, service, data, target]);
      if (service === "heartbeat_url") return { response: { url: null, path: SECRET } };
      return { context: {} };
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => realSetTimeout(r, 0));
};

after(() => {
  for (const el of mounted) {
    el[CONNECTED] = false;
    if (typeof el.disconnectedCallback === "function") el.disconnectedCallback();
  }
});

/** Create, connect, configure and feed one element like HA does. */
async function mount(tag, config, hass, extra = {}) {
  const C = registry.get(tag);
  assert.ok(C, `${tag} is defined`);
  const el = document.createElement(tag);
  el[CONNECTED] = true;
  mounted.push(el);
  if (config !== undefined) el.setConfig(config);
  Object.assign(el, extra);
  el.hass = hass;
  if (typeof el.connectedCallback === "function") el.connectedCallback();
  await settle();
  el.hass = { ...hass }; // a second update, as HA sends on every state change
  await settle();
  return el;
}

describe("the real elements", () => {
  {
    describe("cards and panel", () => {
      test("defines its four elements", () => {
        for (const kind of ["guard-card", "guards-card", "poe-card", "panel"]) {
          const C = registry.get(`necromancer-${kind}`);
          assert.equal(typeof C, "function", kind);
          assert.ok(C.prototype instanceof HTMLElement, kind);
        }
        for (const kind of ["guard-card", "guards-card", "poe-card"]) {
          assert.equal(typeof registry.get(`necromancer-${kind}`).prototype.setConfig, "function", kind);
        }
      });

      test("guard card renders every state and type", async () => {
        const hass = cardHass();
        for (const slug of ["alpha", "bravo", "charlie", "delta", "backup"]) {
          for (const layout of [undefined, "compact"]) {
            const config = { entity: `sensor.${slug}_status`, ...(layout ? { layout } : {}) };
            const el = await mount(`necromancer-guard-card`, config, hass);
            const out = dump(el);
            const name = hass.states[config.entity].attributes.guard_name;
            assert.ok(out.includes(name), `${slug} ${layout || "full"}: shows its name`);
            assert.ok(!out.includes("undefined"), `${slug} ${layout || "full"}: no "undefined" in the markup`);
          }
        }
        assert.throws(() => document.createElement(`necromancer-guard-card`).setConfig({}), /entity/i);
      });

      test("guards card lists the guards, problems first", async () => {
        const hass = cardHass();
        const el = await mount(`necromancer-guards-card`, {}, hass);
        const out = dump(el);
        for (const name of ["Alpha", "Charlie", "Delta", "Nightly Backup"]) assert.ok(out.includes(name), name);
        assert.ok(!out.includes("undefined"));
      });

      test("PoE card loads and shows the ports", async () => {
        const hass = cardHass();
        const el = await mount(`necromancer-poe-card`, {}, hass);
        assert.ok(hass.ws.some((m) => m.type === "necromancer/poe/ports"));
        assert.ok(dump(el).includes("Port 5"));
      });

      test("panel renders with tabs and guards", async () => {
        const hass = cardHass();
        const panel = { url_path: "necromancer", config: {} };
        const route = { prefix: "/necromancer", path: "" };
        for (const narrow of [false, true]) {
          const el = await mount(`necromancer-panel`, undefined, hass, { narrow, panel, route });
          const out = dump(el);
          assert.ok(out.includes("Alpha"), `narrow=${narrow}`);
          assert.ok(hass.ws.some((m) => m.type === "frontend/get_user_data"));
        }
      });

      test("the heartbeat URL never reaches the DOM or the console", async () => {
        const hass = cardHass();
        const el = await mount(`necromancer-guard-card`, { entity: "sensor.backup_status" }, hass);
        const { runAction } = await import("../../custom_components/necromancer/frontend/necromancer-actions.js?v=test");
        const info = (await import("../../custom_components/necromancer/frontend/necromancer-core.js?v=test")).guardInfo(hass.states["sensor.backup_status"]);
        await runAction(el, hass, info, "url");
        el.hass = { ...hass };
        await settle();
        assert.ok(!dump(el).includes("SECRETTOKEN"));
        assert.ok(!logs.some((l) => l.includes("SECRETTOKEN")));
        assert.ok(!events.some(([, d]) => JSON.stringify(d || {}).includes("SECRETTOKEN")));
      });
    });
  }
});

// ---- row detail, the opened guard, buttons, main value ----------------------

describe("row_detail and the opened guard", () => {
  const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
  const historyCalls = (hass) => hass.ws.filter((m) => m.type === "history/history_during_period");
  let tlStore;
  // The timeline store is page-wide (one cache for every element): start
  // each test with an empty one, so earlier tests' cached guards do not hide
  // a query.
  const resetTimeline = async () => {
    if (!tlStore) tlStore = (await import("../../custom_components/necromancer/frontend/necromancer-timeline.js?v=test")).timeline;
    clearTimeout(tlStore.timer);
    tlStore.timer = null;
    tlStore.queue.clear();
    tlStore.data.clear();
    tlStore.lastHass = null;
  };

  test("collapsed rows with row_detail text: no history query, no subscription, no strip", async () => {
    await resetTimeline();
    const hass = cardHass();
    const row = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", layout: "compact" }, hass);
    assert.equal(row._config.row_detail, "text", "a single compact card: text by default");
    assert.equal(row._tlUnsub, null);
    assert.ok(!dump(row).includes("data-tl="));
    const list = await mount("necromancer-guards-card", { row_detail: "text" }, hass);
    assert.ok(!dump(list).includes("data-tl="));
    await wait(200);
    assert.equal(historyCalls(hass).length, 0);
  });

  test("full card, timeline off (default): no section, no history query, no subscription", async () => {
    await resetTimeline();
    const hass = cardHass();
    const full = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.ok(!("timeline" in full._config), "the default stays out of the config");
    await wait(200);
    await settle();
    assert.equal(historyCalls(hass).length, 0);
    assert.equal(full._tlUnsub, null);
    assert.equal(tlStore.entry("sensor.alpha_status"), null, "nothing asked from the store");
    const f = dump(full);
    assert.ok(!f.includes("Last 24 h") && !f.includes("data-tl="));
    assert.ok(!full._html.includes('class="tlsec') && !full._html.includes("tl-axis"));
    assert.ok(f.includes('class="hero'), "hero");
    assert.ok(sp(f).includes(">2 attempts · "), "the event text in the tray");
    assert.ok(!sp(f).includes("Escalated · 2 attempts"), "without the status word the badge already shows");
    assert.ok(f.includes('class="tray'));
    // Explicit false: the same.
    full.setConfig({ entity: "sensor.alpha_status", timeline: false });
    full.hass = { ...hass };
    await wait(200);
    assert.equal(historyCalls(hass).length, 0);
    assert.ok(!dump(full).includes("data-tl="));
    // The old show_timeline does not switch it on (it is the row detail).
    full.setConfig({ entity: "sensor.alpha_status", show_timeline: true });
    full.hass = { ...hass };
    await wait(200);
    assert.equal(historyCalls(hass).length, 0);
    assert.ok(!dump(full).includes("Last 24 h"));
    assert.throws(() => full.setConfig({ entity: "sensor.alpha_status", timeline: "yes" }), /timeline must be true or false/);
  });

  test("full card with timeline: true shows the 24 h section and the detail text; switching it off drops it", async () => {
    await resetTimeline();
    const hass = cardHass();
    const full = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", timeline: true }, hass);
    await wait(200);
    const calls = historyCalls(hass);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].entity_ids, ["sensor.alpha_status"]);
    await settle();
    const f = dump(full);
    assert.ok(f.includes("Last 24 h"));
    assert.ok(f.includes('data-tl="sensor.alpha_status"'));
    assert.ok(f.includes("tl-axis"));
    assert.ok(sp(f).includes(">2 attempts · "), "the event text under the timeline");
    assert.equal(typeof full._tlUnsub, "function");
    // A guard without an event shows the quiet context instead.
    const ok = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", timeline: true }, hass);
    assert.ok(dump(ok).includes('class="ev quiet"'));
    assert.ok(dump(ok).includes("Auto-recovery off"));
    assert.ok(!f.includes("undefined"));
    full.setConfig({ entity: "sensor.alpha_status" });
    assert.equal(full._tlUnsub, null, "off: no subscription");
    assert.ok(!dump(full).includes("data-tl="));
    assert.ok(sp(dump(full)).includes(">2 attempts · "));
  });

  test("an opened row shows the section whatever its `timeline` says", async () => {
    await resetTimeline();
    const hass = cardHass();
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact", expandable: true, embedded: true, timeline: false }, hass);
    row._toggleExpand();
    await wait(200);
    await settle();
    assert.equal(historyCalls(hass).length, 1);
    assert.ok(dump(row).includes("Last 24 h"));
  });

  test("opening a row: one query for that guard only, cached; closing drops the subscription", async () => {
    await resetTimeline();
    const hass = cardHass();
    const row = await mount("necromancer-guard-card", { entity: "sensor.delta_status", layout: "compact", expandable: true, embedded: true }, hass);
    await wait(200);
    assert.equal(historyCalls(hass).length, 0, "collapsed: nothing");
    row._toggleExpand();
    await wait(200);
    await settle();
    const calls = historyCalls(hass);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].entity_ids, ["sensor.delta_status"]);
    const open = dump(row);
    assert.ok(open.includes("Last 24 h") && open.includes("tl-axis"), "timeline section");
    assert.ok(open.includes('class="tray'), "detail text and pills below it");
    assert.equal(typeof row._tlUnsub, "function");
    row._toggleExpand();
    assert.equal(row._tlUnsub, null, "closed with row_detail text: no subscription");
    assert.ok(!dump(row).includes("data-tl="));
    row._toggleExpand();
    await wait(200);
    assert.equal(historyCalls(hass).length, 1, "opened again: from the cache");
  });

  test("row_detail timeline (and the old show_timeline): thin strip, one batched query", async () => {
    await resetTimeline();
    const hass = cardHass();
    const a = await mount("necromancer-guard-card", { entity: "sensor.delta_status", layout: "compact", row_detail: "timeline" }, hass);
    const b = await mount("necromancer-guard-card", { entity: "sensor.charlie_status", layout: "compact", show_timeline: true }, hass);
    assert.equal(b._config.row_detail, "timeline");
    assert.ok(!("show_timeline" in b._config));
    await wait(200);
    const calls = historyCalls(hass);
    assert.equal(calls.length, 1, "one query for both rows");
    assert.deepEqual(calls[0].entity_ids, ["sensor.delta_status", "sensor.charlie_status"]);
    await settle();
    for (const row of [a, b]) {
      const r = dump(row);
      assert.ok(r.includes("tl-strip thin"));
      assert.ok(!r.includes("Last 24 h"), "no section in the collapsed row");
    }
    a.setConfig({ entity: "sensor.delta_status", layout: "compact", row_detail: "text" });
    assert.equal(a._tlUnsub, null);
    assert.ok(!dump(a).includes("data-tl="));
    assert.throws(() => a.setConfig({ entity: "sensor.delta_status", row_detail: "strip" }), /row_detail/);
    assert.throws(() => a.setConfig({ entity: "sensor.delta_status", show_timeline: "yes" }), /show_timeline/);
  });

  test("wide list row: the last event fills the free column only with row_detail text", async () => {
    await resetTimeline();
    const hass = cardHass();
    const off = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    const o = dump(off);
    assert.ok(o.includes('class="revent"'), "event cell in the row");
    assert.ok(o.includes("Escalated"), "event text");
    const on = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact", row_detail: "timeline" }, hass);
    assert.ok(!dump(on).includes('class="revent"'), "the strip takes that column");
    const nofoot = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact", show_footer: false }, hass);
    assert.ok(!dump(nofoot).includes('class="revent"'));
  });

  test("sizes and HA's form editor", () => {
    const C = registry.get("necromancer-guard-card");
    const el = document.createElement("necromancer-guard-card");
    el.setConfig({ entity: "sensor.alpha_status" });
    assert.equal(el.getGridOptions().min_rows, 3, "full card without the timeline: hero + tray");
    assert.equal(el.getCardSize(), 3);
    el.setConfig({ entity: "sensor.alpha_status", show_footer: false, show_actions: "none" });
    assert.equal(el.getCardSize(), 2, "no tray");
    el.setConfig({ entity: "sensor.alpha_status", timeline: true });
    assert.equal(el.getGridOptions().min_rows, 4, "with the timeline: hero + timeline + tray");
    assert.equal(el.getCardSize(), 5);
    el.setConfig({ entity: "sensor.alpha_status", layout: "compact" });
    assert.equal(el.getCardSize(), 1);
    // No fixed row count: a compact card with its detail line is taller than
    // one grid row and would overlap the next card in a sections view.
    assert.equal(el.getGridOptions().rows, undefined);
    assert.equal(el.getGridOptions().min_rows, 1);
    el.setConfig({ entity: "sensor.alpha_status", layout: "compact", timeline: true });
    assert.equal(el.getCardSize(), 1, "`timeline` is for the full card only");
    // HA's own form: the stub writes the layout out (an unset select shows
    // empty), the switches show their default, every select names its default.
    assert.deepEqual(C.getStubConfig({ states: {} }), { entity: "sensor.my_guard_status", layout: "full" });
    assert.equal(typeof C.getConfigElement, "undefined", "no own editor element");
    const form = C.getConfigForm("en");
    const names = (f) => f.schema.flatMap((x) => (x.schema ? x.schema.map((y) => y.name) : [x.name]));
    for (const k of ["entity", "name", "icon", "layout", "timeline", "row_detail", "show_counters", "show_footer", "show_actions"]) {
      assert.ok(names(form).includes(k), k);
      assert.equal(typeof form.computeLabel({ name: k }), "string", k);
    }
    assert.ok(!names(form).includes("actions") && !names(form).includes("show_timeline"));
    assert.equal(form.schema.find((s) => s.name === "show_footer").default, true);
    assert.equal(form.schema.find((s) => s.name === "show_counters").default, false);
    assert.equal(form.schema.find((s) => s.name === "show_actions").default, true);
    assert.match(form.computeHelper({ name: "layout" }), /default/);
    assert.match(C.getConfigForm("de").computeHelper({ name: "layout" }), /Standard/);
    assert.match(form.computeHelper({ name: "show_actions" }), /Snooze/);
    // Only Necromancer status sensors in the guard picker.
    assert.deepEqual(form.schema[0].selector.entity.filter, { domain: "sensor", integration: "necromancer", device_class: "enum" });
    // The detail option follows the layout through HA's visible conditions.
    assert.deepEqual(form.schema.find((x) => x.name === "timeline").visible, { field: "layout", value: "compact", operator: "not_eq" });
    assert.deepEqual(form.schema.find((x) => x.name === "row_detail").visible, { field: "layout", value: "compact" });
    assert.equal(form.computeLabel({ name: "timeline" }), "Show 24 h timeline");
    assert.equal(C.getConfigForm("de").computeLabel({ name: "row_detail" }), "Zeile zeigt");
    assert.equal(C.getConfigForm("de").computeLabel({ name: "timeline" }), "Zeitverlauf anzeigen");
    // `show_actions: "none"` (older) still reads as off.
    el.setConfig({ entity: "sensor.alpha_status", show_actions: "none" });
    assert.equal(el._config.show_actions, false);
  });

  test("guards card passes row_detail to its rows: thin strips, at most one batched query", async () => {
    await resetTimeline();
    const hass = cardHass();
    const list = await mount("necromancer-guards-card", { row_detail: "timeline" }, hass);
    await wait(200);
    await settle();
    const rows = [...list._cards.values()].map((e) => e.el);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row._config.row_detail, "timeline");
      assert.ok(dump(row).includes("tl-strip thin"), row._config.entity);
    }
    assert.equal(historyCalls(hass).length, 1, "one batched query for all rows");
    list.setConfig({ row_detail: "text" });
    list.hass = { ...hass };
    await settle();
    for (const row of [...list._cards.values()].map((e) => e.el)) {
      assert.equal(row._config.row_detail, "text");
      assert.equal(row._tlUnsub, null);
      assert.ok(!dump(row).includes("data-tl="));
    }
    assert.throws(() => list.setConfig({ show_timeline: 1 }), /show_timeline/);
  });
});

// Repro of the round-2 smoke miss, as a fixed chain on one card: heartbeat
// ping ("Sure?" then send) -> snooze 30 min from its pill -> auto-recovery off
// in the recovery popup -> Copy URL from the ⋮ menu after a small scroll. The miss
// was the menu closing on any scroll (Copy URL never ran); every step must run
// its call in this order, and the URL reach only the clipboard.
describe("chained actions (ping -> snooze -> auto-recovery -> copy URL)", () => {
  test("each step runs once, in order; the menu survives a nudge; the URL stays out of the DOM", async () => {
    const hass = cardHass();
    const so = hass.states["sensor.backup_status"];
    hass.states["sensor.backup_status"] = {
      ...so,
      state: "ok",
      attributes: { ...so.attributes, driver_type: "switch", driver_entity: "switch.backup_power", revive_entity: "button.backup_revive", auto_recovery_entity: "switch.backup_auto_recovery" },
    };
    const copied = [];
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (v) => copied.push(v) } }, configurable: true, writable: true });
    const toasts = () => events.filter(([type]) => type === "hass-notification").map(([, d]) => d.message);
    const before = toasts().length;
    try {
      // Two pills on a healthy heartbeat card: ping (main) and snooze.
      const el = await mount("necromancer-guard-card", { entity: "sensor.backup_status" }, hass);
      assert.deepEqual([el._ctx.acts.main, el._ctx.acts.second], ["ping", "snooze"]);
      const card = el._card;
      const pop = el._pop.el;
      const click = async (node, what) => {
        assert.ok(node, `${what} is on screen`);
        el._click({ target: node, stopPropagation() {} });
        await settle();
      };
      const calls = () => hass.calls.map(([d, sv]) => `${d}.${sv}`);

      // 1. ping: the first tap arms, the second sends.
      await click(card.querySelector('[data-action="ping"]'), "ping pill");
      assert.deepEqual(calls(), [], "armed only");
      assert.ok(card.innerHTML.includes("Sure?"));
      await click(card.querySelector('[data-action="ping"]'), "armed ping pill");
      assert.deepEqual(calls(), ["necromancer.heartbeat_ping"]);

      // 2. snooze 30 min from the pill's duration list.
      await click(card.querySelector('[data-action="snooze"]'), "snooze pill");
      assert.equal(el._pop.kind, "snooze");
      await click(pop.querySelector('[data-action="snooze-for"][data-seconds="1800"]'), "30 min");
      assert.deepEqual(calls().slice(1), ["necromancer.snooze"]);
      assert.equal(hass.calls[1][2].duration, 1800);
      assert.equal(el._pop.state, null, "the list closed");

      // 3. auto-recovery off in the recovery popup ("Sure?" first); the menu
      //    has no auto-recovery entry any more.
      await click(card.querySelector('[data-action="menu"]'), "⋮");
      assert.equal(el._pop.kind, "menu");
      assert.ok(!pop.querySelector('[data-action="auto"]'), "not in the menu");
      el._pop.close();
      await click(card.querySelector('[data-action="recovery"]'), "actor chip");
      await click(el._rec.el.querySelector('[data-action="rec-auto"]'), "auto switch");
      await click(el._rec.el.querySelector('[data-action="rec-auto"]'), "armed auto switch");
      assert.deepEqual(calls().slice(2), ["switch.turn_off"]);
      el._rec.close();
      assert.deepEqual(hass.calls[2][3], { entity_id: "switch.backup_auto_recovery" });

      // 4. copy URL from the menu, after the 2 px scroll of a click retry.
      await click(card.querySelector('[data-action="menu"]'), "⋮ again");
      el._pop._onScroll();
      assert.equal(el._pop.kind, "menu", "a nudge keeps the menu open");
      await click(pop.querySelector('[data-action="url"]'), "Copy URL item");
      assert.deepEqual(calls().slice(3), ["necromancer.heartbeat_url"]);
      assert.deepEqual(copied, [`http://ha.local:8123${SECRET}`]);
      assert.deepEqual(toasts().slice(before).filter((m) => /copied|URL/i.test(m)), ["Heartbeat URL copied"]);
      assert.equal(hass.calls.length, 4, "no step ran twice");
      assert.ok(!dump(el).includes("SECRETTOKEN"), "the URL never reaches the DOM");
      assert.ok(!toasts().some((m) => m.includes("SECRETTOKEN")));
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete globalThis.navigator;
    }
  });
});

describe("guards card: empty states", () => {
  test("a filtered list with no match says all clear, not 'add a guard'", async () => {
    const hass = cardHass();
    const el = await mount("necromancer-guards-card", { filter: { states: ["verify"] } }, hass);
    const out = dump(el);
    assert.ok(out.includes("All clear — no guard matches right now."));
    assert.ok(!out.includes("No guards yet"));
  });
});

describe("observe only for non-admins; calm healthy rows", () => {
  const tap = (el, action, data = {}) =>
    el._click({ target: { closest: () => ({ dataset: { action, ...data }, getAttribute: () => null }) }, stopPropagation() {} });

  test("a non-admin gets no buttons, no menu, chips and popup only inform; no bulk actions", async () => {
    const hass = cardHass();
    hass.user = { is_admin: false };
    hass.states["switch.alpha_auto_recovery"] = { entity_id: "switch.alpha_auto_recovery", state: "off", attributes: {} };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.deepEqual(el._ctx.acts.actions, []);
    const out = dump(el);
    assert.ok(!out.includes('data-action="reset"') && !out.includes('data-action="menu"') && !out.includes('data-action="auto-chip"'));
    tap(el, "recovery");
    await settle();
    const pop = el._rec.el.innerHTML;
    assert.ok(!pop.includes('data-action="rec-auto"') && !pop.includes('data-action="rec-repair"'));
    const list = await mount("necromancer-guards-card", {}, hass);
    assert.ok(!dump(list).includes('data-action="snooze-all"'), "no maintenance mode");
    hass.user = { is_admin: true };
    const admin = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.equal(admin._ctx.acts.main, "reset");
  });

  test("healthy: the main pill is tinted, a problem keeps the strong fill", async () => {
    const ok = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, cardHass());
    assert.match(dump(ok), /class="pill accent main "/);
    assert.ok(!/class="pill accent strong "/.test(dump(ok)));
    const bad = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, cardHass());
    assert.match(dump(bad), /class="pill accent strong "/);
  });
});

describe("guards card in HA's card picker", () => {
  test("the picker preview shows a short sample, the added card everything", async () => {
    const hass = cardHass();
    const full = await mount("necromancer-guards-card", { collapse_ok: false }, hass);
    const all = full._cards.size;
    assert.ok(all > 4, `fixture has ${all} guards`);
    const el = document.createElement("necromancer-guards-card");
    el.setConfig({ collapse_ok: false });
    el.hass = hass;
    // As inside hui-card-picker's shadow root.
    el.getRootNode = () => ({ host: { tagName: "HUI-CARD-PICKER" } });
    el.connectedCallback();
    await settle();
    assert.equal(el._cards.size, 4);
  });
});

describe("panel: tabs without overlap", () => {
  const panelExtra = { narrow: false, panel: { url_path: "necromancer", config: {} }, route: { prefix: "/necromancer", path: "" } };

  test("with heartbeat guards: Guards shows the others, Heartbeat the jobs, badges count each tab", async () => {
    const hass = cardHass();
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    await settle();
    assert.deepEqual(el._cards.guards._config.filter, { types: ["recovery", "notify"] });
    const tabs = el._el.tabs.innerHTML;
    assert.ok(tabs.includes('data-tab="heartbeat"'));
    // alpha escalated + delta recovering in Guards; the blind backup in Heartbeat.
    assert.match(tabs, /data-tab="guards".*?class="tbadge"[^>]*>2</s);
    assert.match(tabs, /data-tab="heartbeat".*?class="tbadge"[^>]*>1</s);
    // The hero counts the open tab only.
    assert.ok(!el._el.bubbles.innerHTML.includes("Blind"));
    el._selectTab("heartbeat");
    await settle();
    assert.deepEqual(el._cards.heartbeat._config.filter, { types: ["heartbeat"] });
    assert.ok(el._el.bubbles.innerHTML.includes("Blind"));
  });

  test("without heartbeat guards: no Heartbeat tab, Guards shows everything, one tab = no tab bar", async () => {
    const hass = cardHass();
    for (const id of Object.keys(hass.states)) {
      const so = hass.states[id];
      if (so.attributes && so.attributes.health_type === "heartbeat") delete hass.states[id];
    }
    const ws = hass.callWS;
    hass.callWS = async function callWS(msg) {
      if (msg.type === "necromancer/poe/ports") {
        this.ws.push(msg);
        return { entry_id: "e1", ports: [] };
      }
      return ws.call(this, msg);
    };
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    await settle();
    assert.ok(!el._el.tabs.innerHTML.includes('data-tab="heartbeat"'));
    assert.equal(el._cards.guards._config.filter, undefined);
    assert.equal(el._el.tabs.hidden, true, "Guards alone (no PoE ports): no tab bar");
  });

  test("a non-admin sees no maintenance mode in the panel", async () => {
    const hass = cardHass();
    hass.user = { is_admin: false };
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    await settle();
    assert.ok(!el._el.bulk.innerHTML.includes("snooze-all"));
  });
});

describe("buttons: main pill and snooze pill (design §16)", () => {
  const pills = (el) => [el._ctx.acts.main, el._ctx.acts.second];
  const tap = (el, action, data = {}) =>
    el._click({ target: { closest: () => ({ dataset: { action, ...data }, getAttribute: () => null }) }, stopPropagation() {} });

  test("full card: the state's main pill and snooze; a row has both, the narrow one shows only the main", async () => {
    const hass = cardHass();
    const full = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.deepEqual(pills(full), ["reset", "snooze"]);
    const out = dump(full);
    assert.match(out, /class="pill accent strong "[^>]*data-action="reset"/);
    assert.match(out, /class="pill accent second "[^>]*data-action="snooze"/);
    assert.ok(!full._ctx.acts.menu.includes("snooze"), "snooze is never in the menu");
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    assert.match(dump(row), /class="row tx pin"/, "the main pill as an icon button in the narrow row");
    assert.match(dump(row), /<div class="ract">.*data-action="reset".*class="pill accent second "/s);
  });

  test("snoozed: wake up is the main pill, no snooze pill; revive in the menu says it ends the snooze", async () => {
    const hass = cardHass();
    hass.states["sensor.alpha_status"] = { ...hass.states["sensor.alpha_status"], state: "snoozed" };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.deepEqual(pills(el), ["unsnooze", null]);
    el._openMenu("menu", "more");
    await settle();
    assert.match(el._pop.el.innerHTML, /Revive \(ends the snooze\)/);
  });

  test("busy: no pills; healthy: check (or ping) and snooze", async () => {
    const hass = cardHass();
    hass.states["sensor.alpha_status"] = { ...hass.states["sensor.alpha_status"], state: "recovering" };
    const busy = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.deepEqual(pills(busy), [null, null]);
    const ok = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, cardHass());
    assert.equal(pills(ok)[1], "snooze");
  });

  test("the menu: rare entries after a rule; a narrow row's menu takes snooze", async () => {
    const hass = cardHass();
    hass.user = { ...(hass.user || {}), is_admin: true };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    el._openMenu("menu", "more");
    await settle();
    const html = el._pop.el.innerHTML;
    assert.ok(html.indexOf('class="sep"') > html.indexOf('data-action="revive"'));
    assert.ok(html.indexOf('class="sep"') < html.indexOf('data-action="details"'));
    assert.ok(!html.includes('data-action="snooze"'), "full card: snooze is a pill");
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    // The stub DOM has no layout: the hidden pill reads as hidden, the menu takes it.
    row._openMenu("menu", "more");
    await settle();
    assert.ok(row._pop.el.innerHTML.includes('data-action="snooze"'));
  });

  test("show_actions false: no pills and no menu; chips and popup only inform", async () => {
    const hass = cardHass();
    hass.states["switch.alpha_auto_recovery"] = { entity_id: "switch.alpha_auto_recovery", state: "off", attributes: {} };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", show_actions: false }, hass);
    assert.deepEqual(el._ctx.acts.actions, []);
    const out = dump(el);
    assert.ok(!out.includes('data-action="menu"') && !out.includes('data-action="reset"'));
    assert.ok(!out.includes('data-action="auto-chip"'), "the auto-off chip opens the popup instead");
    tap(el, "recovery");
    await settle();
    const pop = el._rec.el.innerHTML;
    assert.ok(!pop.includes('data-action="rec-auto"') && !pop.includes('data-action="rec-repair"'));
    assert.ok(pop.includes("Off — problems are only reported"));
    el._click({ target: { closest: () => ({ dataset: { action: "rec-repair" }, getAttribute: () => null }) }, stopPropagation() {} });
    await settle();
    assert.equal(hass.calls.length, 0, "nothing runs");
    // Older values still read.
    const old = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", show_actions: "none", actions: { ping: "pill" } }, hass);
    assert.deepEqual(old._ctx.acts.actions, []);
  });
});

describe("main value of a numeric state guard", () => {
  function numericHass(lang = "en") {
    const hass = cardHass();
    const now = Date.now();
    hass.language = lang;
    hass.locale = { ...(hass.locale || {}), language: lang };
    const s = hass.states["sensor.bravo_status"];
    hass.states["sensor.bravo_status"] = {
      ...s,
      last_changed: new Date(now - 19 * 60e3).toISOString(),
      attributes: { ...s.attributes, source_entity: "sensor.bravo_power", source_attribute: null },
    };
    hass.states["sensor.bravo_power"] = { entity_id: "sensor.bravo_power", state: "200", attributes: { unit_of_measurement: "W", friendly_name: "Bravo Power" } };
    return hass;
  }

  test("'200 W' with 'Healthy for 19 min' beside it; the value opens the watched entity", async () => {
    const el = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, numericHass());
    const out = dump(el);
    assert.ok(out.includes('class="vline"'));
    assert.ok(out.includes("200 W"));
    assert.ok(out.includes("Healthy for 19 min"));
    assert.ok(out.includes('data-action="more-info"') && out.includes('data-entity="sensor.bravo_power"'));
    const de = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, numericHass("de"));
    assert.ok(dump(de).includes("Gesund seit 19 Min."));
    // The collapsed row shows the value in its pill.
    const row = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", layout: "compact" }, numericHass());
    assert.ok(dump(row).includes("200 W"));
  });

  test("a text source keeps 'for 19 min'; value_entity still wins", async () => {
    const hass = numericHass();
    hass.states["sensor.bravo_power"] = { entity_id: "sensor.bravo_power", state: "on", attributes: {} };
    const el = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, hass);
    assert.ok(dump(el).includes("for 19 min"));
    assert.ok(!dump(el).includes('class="caption"'));
    hass.states["sensor.other"] = { entity_id: "sensor.other", state: "21.5", attributes: { unit_of_measurement: "°C", friendly_name: "Room" } };
    const custom = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", value_entity: "sensor.other" }, hass);
    assert.ok(dump(custom).includes("21.5 °C") && dump(custom).includes("Room"));
  });
});

// ---- text line, real "since", folded transitions ----

describe("row text line, real since, folded transitions", () => {
  test("a collapsed text row carries its event in the row (class tx) for the narrow second line", async () => {
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, cardHass());
    const out = dump(row);
    assert.match(out, /class="row tx( pin)?"/);
    assert.ok(out.includes('class="revent"'));
    // The status line above says "Escalated": the text line does not repeat it.
    assert.ok(sp(out).includes(">2 attempts · "), "event without the leading state word");
    assert.ok(!sp(out).includes("Escalated · 2 attempts"));
    const tlRow = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact", row_detail: "timeline" }, cardHass());
    assert.ok(!/class="row[^"]*\btx\b/.test(dump(tlRow)), "the timeline row has no text line");
  });

  test("escalated_at beats the restart-reset last_changed (value pill and context agree with the event)", async () => {
    const hass = cardHass();
    const so = hass.states["sensor.alpha_status"];
    hass.states["sensor.alpha_status"] = { ...so, last_changed: new Date(Date.now() - 14 * 60e3).toISOString(), attributes: { ...so.attributes, escalated_at: new Date(Date.now() - 95 * 60e3).toISOString() } };
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    const out = dump(row);
    assert.ok(out.includes("for 1 h 35 min"), "value from escalated_at");
    assert.ok(!out.includes("for 14 min"));
  });

  test("state_since (restart-proof, any state) wins in every mode: text and timeline rows agree", async () => {
    const hass = cardHass();
    const so = hass.states["sensor.delta_status"];
    const since = new Date(Date.now() - 221 * 60e3).toISOString();
    hass.states["sensor.delta_status"] = { ...so, state: "suspect", last_changed: new Date(Date.now() - 43 * 60e3).toISOString(), attributes: { ...so.attributes, state_since: since } };
    const text = dump(await mount("necromancer-guard-card", { entity: "sensor.delta_status", layout: "compact" }, hass));
    const strip = dump(await mount("necromancer-guard-card", { entity: "sensor.delta_status", layout: "compact", row_detail: "timeline" }, hass));
    for (const out of [text, strip]) {
      assert.ok(out.includes("for 3 h 41 min"), "value from state_since");
      assert.ok(!out.includes("for 43 min"));
    }
    const base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
    const points = { loaded: true, points: [{ s: "suspect", t: Date.now() - 9 * 3600e3 }] };
    assert.equal(base.stateSince(hass.states["sensor.delta_status"], points).toISOString(), since, "the history does not override it");
  });

  test("row text and heartbeat reason: no repeated state word, one period wording", async () => {
    const base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
    assert.equal(base.dropLeadingState("Escalated · 2 attempts · 2 h ago", "Escalated"), "2 attempts · 2 h ago");
    assert.equal(base.dropLeadingState("Eskaliert · 2 Versuche", "eskaliert"), "2 Versuche");
    assert.equal(base.dropLeadingState("Recovered · 5 min ago", "Healthy"), "Recovered · 5 min ago");
    assert.equal(base.dropLeadingState("Escalated", "Escalated"), "Escalated", "never the only part");
    assert.equal(base.withoutPeriodClause("No heartbeat for 3 hours, expected every 60 minutes."), "No heartbeat for 3 hours.");
    assert.equal(base.withoutPeriodClause("Kein Lebenszeichen seit 3 Stunden, erwartet alle 60 Minuten."), "Kein Lebenszeichen seit 3 Stunden.");
    assert.equal(base.withoutPeriodClause("Failure reported, exit code 3."), "Failure reported, exit code 3.");
    // The full heartbeat card: caption "expected every 1 h", reason without its own period.
    const hass = cardHass();
    const so = hass.states["sensor.backup_status"];
    hass.states["sensor.backup_status"] = { ...so, state: "escalated", attributes: { ...so.attributes, health_detail: "No heartbeat for 3 hours, expected every 60 minutes." } };
    hass.states["event.backup_recovery"] = { ...hass.states["event.backup_recovery"], state: "unknown" };
    const out = sp(dump(await mount("necromancer-guard-card", { entity: "sensor.backup_status" }, hass)));
    assert.ok(out.includes("expected every 1 h"), "the caption");
    assert.ok(out.includes("No heartbeat for 3 hours."));
    assert.ok(!out.includes("60 minutes"));
    // The compact row has no caption: the reason keeps its period, in the
    // same duration format as every other line ("1 h", not "60 minutes").
    const row = sp(dump(await mount("necromancer-guard-card", { entity: "sensor.backup_status", layout: "compact" }, hass)));
    assert.ok(row.includes("No heartbeat for 3 hours, expected every 1 h."), "one period wording in the list");
    assert.ok(!row.includes("60 minutes"));
  });

  test("counters: words under the event, not chips; nothing while both are zero", async () => {
    const hass = cardHass();
    const so = hass.states["sensor.alpha_status"];
    hass.states["sensor.alpha_status"] = { ...so, attributes: { ...so.attributes, recover_count: 4, fail_count: 1 } };
    const out = (await mount("necromancer-guard-card", { entity: "sensor.alpha_status", show_counters: true }, hass))._card.innerHTML;
    assert.ok(!out.includes('class="chip count"'));
    assert.match(out, /<div class="counts">4 repaired · 1 failed<\/div>/);
    hass.states["sensor.alpha_status"] = { ...so, attributes: { ...so.attributes, recover_count: 0, fail_count: 0 } };
    const none = (await mount("necromancer-guard-card", { entity: "sensor.alpha_status", show_counters: true }, hass))._card.innerHTML;
    assert.ok(!none.includes('class="counts"'));
    const de = cardHass();
    de.language = "de";
    de.locale = { ...(de.locale || {}), language: "de" };
    de.states["sensor.alpha_status"] = { ...so, attributes: { ...so.attributes, recover_count: 2, fail_count: 1 } };
    const deOut = (await mount("necromancer-guard-card", { entity: "sensor.alpha_status", show_counters: true }, de))._card.innerHTML;
    assert.match(deOut, /2 repariert · 1 fehlgeschlagen/);
  });

  test("own chips: after a rule, not repeating the actor's target; the actor takes its target's icon", async () => {
    const hass = cardHass();
    hass.states["switch.alpha_power"] = { entity_id: "switch.alpha_power", state: "on", attributes: { friendly_name: "Alpha plug", icon: "mdi:ethernet" } };
    hass.states["binary_sensor.ups"] = { entity_id: "binary_sensor.ups", state: "off", attributes: { friendly_name: "UPS" } };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", chips: ["switch.alpha_power", "binary_sensor.ups"] }, hass);
    const out = el._card.innerHTML;
    assert.match(out, /class="chip actor"[^>]*>.*?mdi:ethernet/s, "the target's own icon");
    assert.ok(!out.includes('data-entity="switch.alpha_power"'), "no second chip for the actor's target");
    assert.match(out, /class="chip own first"[^>]*data-entity="binary_sensor.ups"/);
    // One order everywhere: health, actor, then the rest.
    assert.ok(out.indexOf('class="chip health"') < out.indexOf('class="chip actor"'));
  });

  test("stateSince: escalated_at, else the start of the run in the loaded points, else last_changed", async () => {
    const base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
    const now = Date.now();
    const lc = new Date(now - 14 * 60e3).toISOString();
    const ok = { state: "ok", last_changed: lc, attributes: {} };
    assert.equal(base.stateSince(ok, null).getTime(), Date.parse(lc));
    const entry = { loaded: true, points: [{ s: "escalated", t: now - 5 * 3600e3 }, { s: "ok", t: now - 3 * 3600e3 }, { s: "ok", t: now - 14 * 60e3 }] };
    assert.equal(base.stateSince(ok, entry).getTime(), now - 3 * 3600e3);
    assert.equal(base.stateSince(ok, { ...entry, loaded: false }).getTime(), Date.parse(lc), "not loaded: last_changed");
    const esc = { state: "escalated", last_changed: lc, attributes: { escalated_at: new Date(now - 7200e3).toISOString() } };
    assert.equal(base.stateSince(esc, entry).getTime(), now - 7200e3);
    // A run newer than last_changed (live point of this page) never moves it forward.
    const newer = { loaded: true, points: [{ s: "ok", t: now - 60e3 }] };
    assert.equal(base.stateSince(ok, newer).getTime(), Date.parse(lc));
  });

  test("full card: more than three chips mark the hero 'many'; few chips let the value line span", async () => {
    const el = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, cardHass());
    assert.match(dump(el), /class="hero"/);
    const many = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", show_counters: true, chips: ["switch.alpha_auto_recovery"] }, cardHass());
    assert.match(dump(many), /class="hero many"/);
  });

  test("full card: two transitions plus '+N'; the button shows the rest", async () => {
    const tlMod = await import("../../custom_components/necromancer/frontend/necromancer-timeline.js?v=test");
    const store = tlMod.timeline;
    const now = Date.now();
    store.data.set("sensor.bravo_status", { points: [
      { s: "ok", t: now - 6 * 3600e3 }, { s: "suspect", t: now - 5 * 3600e3 }, { s: "recovering", t: now - 4 * 3600e3 },
      { s: "verify", t: now - 3 * 3600e3 }, { s: "ok", t: now - 2 * 3600e3 },
    ], loaded: true, history: true, lastSo: null, ver: 1 });
    const el = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", timeline: true }, cardHass());
    let out = el._html;
    assert.equal((out.match(/class="tl-x"/g) || []).length, 2);
    assert.match(out, /data-action="tl-more"[^>]*>\+2</);
    el._click({ target: { closest: () => ({ dataset: { action: "tl-more" }, getAttribute: () => null }) }, stopPropagation() {} });
    out = el._html;
    assert.ok(!out.includes("tl-x") && !out.includes('data-action="tl-more"'));
    assert.match(out, /class="tlsec all"/);
    store.data.delete("sensor.bravo_status");
  });
});

// ---- panel settings (row detail, list/cards, buttons) ----

describe("panel settings", () => {
  const PANEL = "../../custom_components/necromancer/frontend/necromancer-panel.js?v=test";
  const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
  const panelExtra = { narrow: false, panel: { url_path: "necromancer", config: {} }, route: { prefix: "/necromancer", path: "" } };
  const DEF = { row_detail: "text", display: "list", timeline: false, actions: {} };
  let PANEL_DEFAULTS;
  before(async () => {
    ({ PANEL_DEFAULTS } = await import("../../custom_components/necromancer/frontend/necromancer-actions.js?v=test"));
  });

  /** cardHass whose stored user data differs per key. */
  function storedHass(stored, lang = "en") {
    const hass = cardHass();
    hass.language = lang;
    hass.locale = { ...hass.locale, language: lang };
    hass.callWS = async function callWS(msg) {
      this.ws.push(msg);
      if (msg.type === "necromancer/poe/ports") return { entry_id: "e1", ports: [] };
      if (msg.type === "frontend/get_user_data") return { value: stored[msg.key] ?? null };
      return {};
    };
    return hass;
  }

  test("panelCardConfig: wide list with timeline rows by default, show_actions as on/off, filter", async () => {
    const { panelCardConfig } = await import(PANEL);
    const { PANEL_DEFAULTS } = await import("../../custom_components/necromancer/frontend/necromancer-actions.js?v=test");
    const def = panelCardConfig(PANEL_DEFAULTS, "guards");
    assert.equal(def.display, "list");
    assert.equal(def.row_detail, "timeline");
    assert.equal(def.collapse_ok, false);
    assert.ok(!("show_timeline" in def) && !("actions" in def));
    assert.equal(def.show_header, false);
    assert.equal(def.bulk, false);
    assert.equal(def.show_actions, true);
    assert.equal(def.filter, undefined);
    const off = panelCardConfig({ ...PANEL_DEFAULTS, show_actions: false, row_detail: "text", display: "cards", actions: { ping: "menu" } }, "heartbeat");
    assert.equal(off.display, "cards");
    assert.equal(off.row_detail, "text");
    assert.equal(off.actions, undefined, "the old modes are gone");
    assert.equal(off.show_actions, false);
    assert.deepEqual(off.filter, { types: ["heartbeat"] });
  });

  test("default (design §16): list, timeline rows, quiet guards open, one batched history query", async () => {
    const hass = storedHass({});
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    assert.ok(hass.ws.some((m) => m.type === "frontend/get_user_data" && m.key === "necromancer_panel"));
    const card = el._cards.guards;
    assert.ok(card, "guards tab is open");
    assert.equal(card._config.display, "list");
    assert.equal(card._config.row_detail, "timeline");
    assert.equal(card._config.collapse_ok, false);
    await wait(200);
    assert.ok(hass.ws.filter((m) => m.type === "history/history_during_period").length <= 1);
  });

  test("text rows: no history query at all", async () => {
    const hass = storedHass({ necromancer_panel: { row_detail: "text" } });
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    assert.equal(el._cards.guards._config.row_detail, "text");
    await wait(200);
    assert.equal(hass.ws.filter((m) => m.type === "history/history_during_period").length, 0);
    assert.ok(!dump(el).includes("data-tl="));
  });

  test("a stored old show_timeline reaches the card as row_detail; one key holds every setting", async () => {
    const hass = storedHass({ necromancer_panel: { show_timeline: false, sort: "name", actions: { ping: "menu" } } });
    const el = await mount("necromancer-panel", undefined, hass, panelExtra);
    const card = el._cards.guards;
    assert.equal(card._config.row_detail, "text");
    assert.equal(card._config.sort, "name", "shared settings still apply");
    assert.equal(card._config.actions, undefined);
    const sets = () => hass.ws.filter((m) => m.type === "frontend/set_user_data");
    await el._changeSetting("row_detail", "timeline");
    assert.equal(card._config.row_detail, "timeline");
    assert.deepEqual(sets().map((m) => [m.key, m.value]), [["necromancer_panel", { ...PANEL_DEFAULTS, sort: "name" }]]);
    await el._changeSetting("display", "cards");
    assert.equal(card._config.display, "cards");
    await el._changeSetting("sort", "state");
    const last = sets().at(-1);
    assert.equal(last.key, "necromancer_panel");
    assert.equal(last.value.sort, "state");
    assert.equal(last.value.display, "cards", "one key holds every setting");
    assert.ok(!("show_timeline" in last.value) && !("actions" in last.value), "old options are not written back");
  });

  test("the gear: row detail, list/cards and one 'Show actions' switch, no buttons section (en/de)", async () => {
    for (const [lang, label, tl, cards, show] of [
      ["en", "Row shows", "Timeline", "Cards", "Show actions"],
      ["de", "Zeile zeigt", "Zeitverlauf", "Karten", "Aktionen anzeigen"],
    ]) {
      const el = await mount("necromancer-panel", undefined, storedHass({ necromancer_panel: { actions: { ping: "menu" } } }, lang), panelExtra);
      el._openSheet();
      const out = dump(el._el.sheet);
      assert.ok(out.includes('data-key="row_detail"'), lang);
      assert.ok(out.includes(label) && out.includes(tl), `${lang}: ${label}`);
      assert.ok(!out.includes('data-key="show_timeline"'), lang);
      assert.ok(out.includes('data-key="display"') && out.includes(cards), lang);
      assert.ok(out.includes('data-key="show_actions"') && out.includes(show), lang);
      assert.ok(!out.includes("acts-open") && !out.includes('data-action="mode"') && !out.includes("ssub"), `${lang}: no per-action section`);
      assert.ok(!out.includes("undefined"), lang);
    }
    const off = await mount("necromancer-panel", undefined, storedHass({ necromancer_panel: { show_actions: false } }), panelExtra);
    assert.equal(off._cards.guards._config.show_actions, false);
  });

  test("the gear and the guards card editor show 'Row shows' for the same settings", async () => {
    const sheet = async (stored) => {
      const el = await mount("necromancer-panel", undefined, storedHass(stored), panelExtra);
      el._openSheet();
      return el._el.sheet.innerHTML;
    };
    const list = await sheet({ necromancer_panel: {} });
    assert.ok(list.includes('data-key="row_detail"') && !list.includes('class="shint"'));
    const cards = await sheet({ necromancer_panel: { display: "cards", collapse_ok: true } });
    assert.ok(cards.includes('data-key="row_detail"'));
    assert.ok(cards.includes("Cards: only the rows of the folded quiet group"));
    assert.ok(cards.indexOf('data-key="row_detail"') > cards.indexOf('data-key="display"'), "after the choice it depends on");
    const flat = await sheet({ necromancer_panel: { collapse_ok: false, display: "cards" } });
    assert.ok(!flat.includes('data-key="row_detail"') && !flat.includes("Row shows"));
    assert.ok(flat.includes('data-key="timeline"'), "the cards' own option stays");
    // HA evaluates the editor's `visible` condition; the same rule here.
    const gc = await import("../../custom_components/necromancer/frontend/necromancer-guards-card.js?v=test");
    const cond = gc.configForm("en").schema.find((x) => x.name === "row_detail").visible;
    const one = (c, data) => ((c.operator || "eq") === "eq" ? data[c.field] === c.value : data[c.field] !== c.value);
    const visible = (data) => cond.conditions.some((c) => one(c, data));
    for (const display of ["list", "cards"]) {
      for (const fold of [true, false]) {
        const gear = await sheet({ necromancer_panel: { collapse_ok: fold, display } });
        assert.equal(gear.includes('data-key="row_detail"'), visible({ display, collapse_ok: fold }), `${display}, fold ${fold}: gear and editor agree`);
      }
    }
  });
});

// ---- the full card's 24 h section is an option (default off) ----

describe("full card timeline option (G1) and the tray wording", () => {
  let store;
  const getStore = async () => {
    if (!store) store = (await import("../../custom_components/necromancer/frontend/necromancer-timeline.js?v=test")).timeline;
    clearTimeout(store.timer);
    store.timer = null;
    store.queue.clear();
    store.data.clear();
    store.lastHass = null;
    return store;
  };
  const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

  test("_showsTimeline: only timeline: true on a full card, row_detail on a compact one, always when opened", async () => {
    const el = document.createElement("necromancer-guard-card");
    const shows = (cfg) => {
      el.setConfig({ entity: "sensor.alpha_status", ...cfg });
      return el._showsTimeline;
    };
    assert.equal(shows({}), false, "full card, no key: off");
    assert.equal(shows({ timeline: false }), false);
    assert.equal(shows({ timeline: true }), true);
    assert.equal(shows({ show_timeline: true }), false, "the old key is the row detail, not the section");
    assert.equal(shows({ row_detail: "timeline" }), false, "row_detail does not touch the full card");
    assert.equal(shows({ layout: "compact" }), false);
    assert.equal(shows({ layout: "compact", timeline: true }), false, "`timeline` is for the full card only");
    assert.equal(shows({ layout: "compact", row_detail: "timeline" }), true);
    shows({ layout: "compact", expandable: true });
    el._expanded = true;
    assert.equal(el._showsTimeline, true, "an opened row always");
    // Both heights: hero + tray (3 rows, size 3) and with the section (4 rows, size 5).
    el.setConfig({ entity: "sensor.alpha_status" });
    assert.deepEqual([el.getCardSize(), el.getGridOptions().min_rows], [3, 3]);
    el.setConfig({ entity: "sensor.alpha_status", timeline: true });
    assert.deepEqual([el.getCardSize(), el.getGridOptions().min_rows], [5, 4]);
  });

  test("a full card without a timeline key never asks the store, across hass updates and config changes", async () => {
    const tl = await getStore();
    const seen = { want: 0, subscribe: 0, sync: 0 };
    const orig = { want: tl.want, subscribe: tl.subscribe, sync: tl.sync };
    for (const k of Object.keys(seen)) {
      tl[k] = function spy(...a) {
        seen[k] += 1;
        return orig[k].apply(this, a);
      };
    }
    try {
      const hass = cardHass();
      const card = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
      for (const state of ["recovering", "ok", "escalated"]) {
        const so = hass.states["sensor.alpha_status"];
        hass.states = { ...hass.states, "sensor.alpha_status": { ...so, state, last_changed: new Date().toISOString() } };
        card.hass = { ...hass, states: hass.states };
        await settle();
      }
      card.setConfig({ entity: "sensor.alpha_status", show_counters: true });
      card.hass = { ...hass };
      await wait(150);
      assert.deepEqual(seen, { want: 0, subscribe: 0, sync: 0 }, "default off: no store call at all");
      assert.equal(hass.ws.filter((m) => m.type === "history/history_during_period").length, 0);
      assert.equal(card._tlUnsub, null);
      // The spy itself works: switching it on asks.
      card.setConfig({ entity: "sensor.alpha_status", timeline: true });
      card.hass = { ...hass };
      assert.ok(seen.subscribe === 1 && seen.want >= 1, JSON.stringify(seen));
      card.setConfig({ entity: "sensor.alpha_status" });
    } finally {
      Object.assign(tl, orig);
      for (const k of Object.keys(orig)) delete tl[k];
    }
  });

  test("the form: the detail option follows the layout through HA's visible conditions", () => {
    const C = registry.get("necromancer-guard-card");
    const form = C.getConfigForm("en");
    const vis = (name) => form.schema.find((x) => x.name === name).visible;
    const shows = (c, data) => ((c.operator || "eq") === "eq" ? data[c.field] === c.value : data[c.field] !== c.value);
    assert.ok(shows(vis("timeline"), {}) && shows(vis("timeline"), { layout: "full" }), "full (also unset): timeline");
    assert.ok(!shows(vis("timeline"), { layout: "compact" }));
    assert.ok(shows(vis("row_detail"), { layout: "compact" }) && !shows(vis("row_detail"), {}), "compact: row shows");
  });

  test("helpers: one period format, numbers stay with their nouns, old failures go quiet", async () => {
    const base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
    assert.equal(base.withPeriodFormatted("No heartbeat for 5 hours, expected every 60 minutes.", 3600), "No heartbeat for 5 hours, expected every 1 h.");
    assert.equal(base.withPeriodFormatted("Kein Lebenszeichen seit 5 Stunden, erwartet alle 90 Minuten.", 5400), "Kein Lebenszeichen seit 5 Stunden, erwartet alle 1 Std. 30 Min.");
    assert.equal(base.withPeriodFormatted("Failure reported, exit code 3.", 3600), "Failure reported, exit code 3.");
    assert.equal(base.withPeriodFormatted("No heartbeat, expected every 60 minutes.", null), "No heartbeat, expected every 60 minutes.", "no period: as is");
    assert.equal(base.glueEventText("Escalated · 2 attempts · 4 h ago"), "Escalated\u00a0· 2\u00a0attempts\u00a0· 4\u00a0h\u00a0ago");
    assert.equal(base.glueEventText("Letzte Eskalation vor 150 Tg. · 2 Versuche"), "Letzte Eskalation vor\u00a0150\u00a0Tg.\u00a0· 2\u00a0Versuche");
    assert.equal(base.glueEventText("Blocked: link busy · 5 min ago"), "Blocked: link busy\u00a0· 5\u00a0min\u00a0ago", "free text keeps its spaces");
    const ev = { tone: "bad", text: "x", age: 150 * 86400 };
    assert.equal(base.quietOldEvent(ev, "ok").tone, "idle");
    assert.equal(base.quietOldEvent(ev, "escalated").tone, "bad", "while escalated it stays red");
    assert.equal(base.quietOldEvent({ ...ev, age: 3600 }, "ok").tone, "bad", "fresh: red");
    assert.equal(base.quietOldEvent({ ...ev, tone: "good" }, "ok").tone, "good");
    assert.equal(base.quietOldEvent(null, "ok"), null);
  });

  test("full tray and rows: no repeated status word, glued count, muted old failure on a healthy guard", async () => {
    const hass = cardHass();
    const full = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.ok(full._card.innerHTML.includes("2\u00a0attempts\u00a0· "), "count and noun stay together");
    assert.ok(!sp(full._card.innerHTML).includes("Escalated · 2"), "the badge says Escalated, the tray does not repeat it");
    assert.match(full._card.innerHTML, /class="evicon" style="--tone:var\(--error-color/);
    // A healthy guard with a failure from 150 days ago: a calm note.
    const so = hass.states["sensor.alpha_status"];
    hass.states["sensor.alpha_status"] = { ...so, state: "ok", attributes: { ...so.attributes, health_detail: null } };
    hass.states["event.alpha_recovery"] = { ...hass.states["event.alpha_recovery"], state: new Date(Date.now() - 150 * 86400e3).toISOString() };
    const old = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    assert.match(old._card.innerHTML, /class="evicon" style="--tone:var\(--disabled-color/);
    // C3: an escalation from before the current state reads as history, not as news.
    assert.ok(sp(old._card.innerHTML).includes("Last escalation 150 d ago · 2 attempts"), "on a healthy card: 'Last escalation …'");
    assert.ok(!sp(old._card.innerHTML).includes("Escalated · 2"), "no present-tense state word under a green badge");
    assert.match(old._card.innerHTML, /<div class="ev past">/, "in the secondary text colour, like the quiet line");
    assert.ok(!/<div class="ev past">/.test(full._card.innerHTML), "a current event keeps the text colour");
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    assert.match(row._card.innerHTML, /class="evicon" style="--tone:var\(--disabled-color/);
  });

  test("context line: glued clock time, no repeated 'Escalated'; the status text gets its ellipsis", async () => {
    const base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
    // A narrow tray breaks "Problem since 3:22 PM" between its parts only.
    assert.equal(base.glueEventText("Problem since 3:22 PM · Notify only"), "Problem since 3:22\u00a0PM\u00a0· Notify only");
    const hass = cardHass();
    const so = hass.states["sensor.alpha_status"];
    // No event: the context fills the tray and reads "Since <time>" (the badge says Escalated).
    hass.states["sensor.alpha_status"] = { ...so, state: "escalated", attributes: { ...so.attributes, health_detail: null } };
    hass.states["event.alpha_recovery"] = { ...hass.states["event.alpha_recovery"], state: "unknown" };
    const card = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    const txt = sp(card._card.textContent || card._card.innerHTML);
    assert.ok(!/Escalated since/.test(txt) && /Since \d/.test(txt), txt);
    // The status line's text span carries the ellipsis (a flex container clips without one).
    const css = card.shadowRoot.innerHTML || "";
    const style = [...(card.shadowRoot.querySelectorAll ? card.shadowRoot.querySelectorAll("style") : [])].map((x) => x.textContent).join("") || css;
    assert.match(style, /\.status > span:not\(\.dot\) \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  });
});

// ---- recovery popup behind the actor chip, chips, cards display ----

describe("recovery popup and chips", () => {
  const FE = "../../custom_components/necromancer/frontend/";
  const tap = (el, action, data = {}) =>
    el._click({ target: { closest: () => ({ dataset: { action, ...data }, getAttribute: () => null }) }, stopPropagation() {} });

  test("actor chip: neutral tone, 'Recovery: <target>' tooltip, opens the popup (never the switch)", async () => {
    const hass = cardHass();
    hass.states["switch.alpha_power"] = { entity_id: "switch.alpha_power", state: "on", attributes: { friendly_name: "Alpha plug" } };
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    const html = el._card.innerHTML;
    assert.match(html, /class="chip actor[^"]*" style="--chip:var\(--primary-text-color, #212121\)" data-action="recovery"[^>]*title="Recovery: Alpha plug"[^>]*data-anchor="rec" aria-haspopup="dialog"/);
    assert.ok(!html.includes('data-entity="switch.alpha_power"'), "no shortcut to the power switch");
    const row = await mount("necromancer-guard-card", { entity: "sensor.alpha_status", layout: "compact" }, hass);
    assert.match(row._card.innerHTML, /<div class="rhealth">.*class="chip health.*data-action="recovery"/s, "compact rows carry the actor chip too, in the full card's order");
  });

  test("auto off: orange chip, worded 'Auto off' on the full card, icon only in a row (also narrow: the value moves into the status line)", async () => {
    const hass = cardHass();
    const full = await mount("necromancer-guard-card", { entity: "sensor.bravo_status" }, hass);
    assert.match(full._card.innerHTML, /class="chip autooff wide" style="--chip:var\(--warning-color, #fb8c00\)" data-action="auto-chip"[^>]*><ha-icon icon="mdi:robot-off"><\/ha-icon><span aria-hidden="true">Auto off<\/span>/);
    assert.ok(!full._card.innerHTML.includes("struck"), "no grey struck-through robot any more");
    const row = await mount("necromancer-guard-card", { entity: "sensor.bravo_status", layout: "compact" }, hass);
    assert.match(row._card.innerHTML, /class="chip autooff" style="--chip:var\(--warning-color/);
    // No dot fallback any more: the orange chip itself stays in a narrow row.
    assert.ok(!row._card.innerHTML.includes("actor autooff"));
    const css = row.shadowRoot ? [...row.shadowRoot.querySelectorAll("style")].map((x) => x.textContent).join("") : "";
    if (css) assert.ok(!/\.row \.chip\.autooff[^{]*\{\s*display:\s*none/.test(css), "no narrow rule hides the auto-off chip");
    // The row's value is also in its status line (a narrow row shows it there).
    assert.match(row._card.innerHTML, /<div class="status"[^>]*>.*<span class="sval [^"]*"[^>]*data-tick="value">[^<]+<\/span><\/div>/s);
    // Double tap still turns it on.
    tap(full, "auto-chip");
    assert.match(full._card.innerHTML, /class="chip autooff wide confirm"[^>]*>.*Sure\?/s);
    tap(full, "auto-chip");
    await settle();
    assert.deepEqual(hass.calls.at(-1).slice(0, 2), ["switch", "turn_on"]);
  });

  test("popup: target, last repair, counters, auto switch with 'Sure?' before off, Repair now with 'Sure?'", async () => {
    const hass = cardHass();
    hass.states["sensor.alpha_status"].attributes.last_recover = new Date(Date.now() - 3 * 86400e3).toISOString();
    const el = await mount("necromancer-guard-card", { entity: "sensor.alpha_status" }, hass);
    tap(el, "recovery");
    await settle();
    assert.ok(el._rec.isOpen);
    let pop = sp(el._rec.el.innerHTML);
    assert.match(pop, /<h2 id="rec-title" tabindex="-1" data-key="title">Recovery<\/h2>/);
    assert.match(pop, /data-action="rec-link" data-entity="switch.alpha_power"/, "the target is a more-info link");
    assert.match(pop, /3 d ago · succeeded/);
    assert.match(pop, /2 succeeded · 1 failed/);
    assert.match(pop, /role="switch" aria-checked="true" data-action="rec-auto"/);
    assert.ok(!hass.ws.some((m) => m.type === "necromancer/guard/recovery"), "a switch guard needs no WS call");
    // Auto-recovery off asks first.
    tap(el, "rec-auto");
    assert.match(sp(el._rec.el.innerHTML), /Sure\?.*Turn auto-recovery off\? Problems are then only reported\. Tap again to turn it off\./s);
    assert.equal(hass.calls.length, 0);
    tap(el, "rec-auto");
    await settle();
    assert.deepEqual(hass.calls.at(-1), ["switch", "turn_off", {}, { entity_id: "switch.alpha_auto_recovery" }]);
    // Repair now: "Sure?", then the guard's Revive button.
    tap(el, "rec-repair");
    assert.match(sp(el._rec.el.innerHTML), /class="pill strong rrepair confirm"[^>]*>.*Sure\?/s);
    tap(el, "rec-repair");
    await settle();
    assert.deepEqual(hass.calls.at(-1), ["button", "press", {}, { entity_id: "button.alpha_revive" }]);
    // A link closes the popup and opens HA's more-info.
    tap(el, "rec-link", { entity: "switch.alpha_power" });
    assert.ok(!el._rec.isOpen);
    assert.deepEqual(events.at(-1), ["hass-more-info", { entityId: "switch.alpha_power" }]);
  });

  test("popup: busy and snoozed guards cannot repair now (reason shown); notify-only says so", async () => {
    const hass = cardHass();
    const busy = await mount("necromancer-guard-card", { entity: "sensor.delta_status" }, hass);
    tap(busy, "recovery");
    await settle();
    assert.ok(hass.ws.some((m) => m.type === "necromancer/guard/recovery" && m.entity_id === "sensor.delta_status"), "PoE asks the fabric (read-only)");
    assert.match(busy._rec.el.innerHTML, /A repair is running …/);
    assert.match(busy._rec.el.innerHTML, /data-action="rec-repair" data-key="repair" aria-disabled="true" aria-describedby="rec-reason"/);
    const snoozed = await mount("necromancer-guard-card", { entity: "sensor.charlie_status" }, hass);
    tap(snoozed, "recovery");
    assert.match(snoozed._rec.el.innerHTML, /Snoozed — wake it up first/);
    const notify = await mount("necromancer-guard-card", { entity: "sensor.backup_status" }, hass);
    // The bell is a working button: the same neutral tone as the other actors.
    assert.match(notify._card.innerHTML, /class="chip actor" style="--chip:var\(--primary-text-color[^"]*" data-action="recovery"[^>]*title="Recovery: Notify only — no repair"/);
    tap(notify, "recovery");
    const pop = notify._rec.el.innerHTML;
    assert.match(pop, /Notify only — no repair/);
    assert.ok(!pop.includes("rec-repair") && !pop.includes("rec-auto"), "no repair, no switch");
    tap(notify, "rec-close");
    assert.ok(!notify._rec.isOpen);
  });

  test("pure helpers: recoveryHtml has no power toggle; placeNear stays in the viewport", async () => {
    const rec = await import(`${FE}necromancer-recovery.js?v=test`);
    const core = await import("../../custom_components/necromancer/frontend/necromancer-core.js?v=test");
    const hass = cardHass();
    const info = core.guardInfo(hass.states["sensor.alpha_status"]);
    const html = rec.recoveryHtml(core.recoveryModel(info, null, hass, "de"), "de", { name: "Alpha" });
    assert.match(html, /Reparatur/);
    assert.match(html, /Jetzt reparieren/);
    assert.ok(!/turn_(on|off)|data-action="(toggle|more-info)"/.test(html));
    assert.deepEqual(rec.placeNear({ top: 100, bottom: 136, right: 1000 }, 344, 400, 1280, 900), { left: 656, top: 148 });
    assert.deepEqual(rec.placeNear({ top: 800, bottom: 836, right: 200 }, 344, 400, 1280, 900), { left: 8, top: 388 }, "above when no room below");
    assert.deepEqual(rec.placeNear({ top: 300, bottom: 336, right: 600 }, 344, 880, 1280, 900), { left: 256, top: 12 }, "too tall: kept on screen");
  });

  test("C2: the suspect badge reads as a complete label; C1: guards editor shows the timeline only for Cards", async () => {
    const base = await import(`${FE}necromancer-base.js?v=test`);
    const core = await import("../../custom_components/necromancer/frontend/necromancer-core.js?v=test");
    const info = core.guardInfo({ entity_id: "sensor.x", attributes: { revive_entity: "button.x" } });
    assert.equal(base.statusText(info, "suspect", {}, "en"), "Problem, confirming");
    assert.equal(base.statusText(info, "suspect", {}, "de"), "Problem, wird bestätigt");
    assert.equal(base.statusText(info, "ok", {}, "en"), core.statusLine(info, "ok", {}, "en"));
    const gc = await import(`${FE}necromancer-guards-card.js?v=test`);
    const names = (f) => f.schema.map((s) => s.name);
    assert.ok(names(gc.configForm("en")).includes("timeline"));
    assert.deepEqual(gc.configForm("en").schema.find((x) => x.name === "timeline").visible, { field: "display", value: "cards" }, "only for Cards");
    assert.equal(gc.configForm("de").computeLabel({ name: "timeline" }), "Zeitverlauf anzeigen");
    const { panelCardConfig } = await import(`${FE}necromancer-panel.js?v=test`);
    const s = { sort: "problems", collapse_ok: true, show_counters: false, show_footer: true, show_actions: true };
    assert.ok(!("timeline" in panelCardConfig({ ...s, display: "cards" }, "guards")), "panel cards: default off");
    assert.equal(panelCardConfig({ ...s, display: "cards", timeline: true }, "guards").timeline, true);
    assert.ok(!("timeline" in panelCardConfig({ ...s, display: "list", timeline: true }, "guards")), "a list has no full cards");
    // "Row shows" names the cards' folded quiet group in its helper.
    assert.match(gc.configForm("de").computeHelper({ name: "row_detail" }), /Karten: nur die Zeilen der eingeklappten ruhigen Gruppe/);
  });

});
