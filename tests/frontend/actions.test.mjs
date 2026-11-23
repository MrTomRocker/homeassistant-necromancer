// Tests for the shared DOM actions (necromancer-actions.js): every action's
// service call, the toasts, navigation, more-info, the clipboard (both paths),
// the panel settings, and that the heartbeat URL never leaves the clipboard.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const events = []; // [target, type, detail]
const logs = [];
let clipboard = null;
let execCopies = [];
let history = [];
let actions;

class Host {
  constructor(name) {
    this.name = name;
  }
  dispatchEvent(ev) {
    events.push([this.name, ev.type, ev.detail]);
    return true;
  }
}

before(async () => {
  globalThis.window = globalThis;
  globalThis.dispatchEvent = (ev) => {
    events.push(["window", ev.type, ev.detail]);
    return true;
  };
  globalThis.location = { origin: "http://ha.local:8123" };
  globalThis.history = {
    pushState: (_s, _t, path) => history.push(["push", path]),
    replaceState: (_s, _t, path) => history.push(["replace", path]),
  };
  globalThis.document = {
    body: { appendChild: (el) => (el.attached = true) },
    createElement: () => {
      const el = {
        value: "",
        style: {},
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        select() {
          this.selected = this.value;
        },
        remove() {
          this.attached = false;
        },
      };
      globalThis.lastTextarea = el;
      return el;
    },
    execCommand: (cmd) => {
      execCopies.push([cmd, globalThis.lastTextarea.selected]);
      return true;
    },
  };
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[k];
    console[k] = (...a) => {
      logs.push(a.join(" "));
      orig(...a);
    };
  }
  actions = await import("../../custom_components/necromancer/frontend/necromancer-actions.js");
});

beforeEach(() => {
  events.length = 0;
  logs.length = 0;
  history = [];
  execCopies = [];
  clipboard = null;
  globalThis.isSecureContext = true;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (s) => void (clipboard = s) } },
    configurable: true,
  });
});

const INFO = {
  type: "recovery",
  name: "Office <AP>",
  statusEntity: "sensor.ap_status",
  reviveEntity: "button.ap_recover",
  autoEntity: "switch.ap_auto",
  canRecover: true,
};

function makeHass({ fail = false, autoState = "on", urlResponse } = {}) {
  return {
    locale: { language: "en" },
    states: { "switch.ap_auto": { state: autoState, attributes: {} } },
    calls: [],
    ws: [],
    stored: undefined,
    async callService(domain, service, data, target, notify, returnResponse) {
      this.calls.push([domain, service, data, target, notify, returnResponse]);
      if (fail) throw new Error("Service failed");
      if (service === "heartbeat_url") {
        return { response: urlResponse ?? { url: null, path: "/api/necromancer/heartbeat/ap_SECRETTOKEN" } };
      }
      if (service === "check_health") return { response: { health: "unhealthy" } };
      return { context: {} };
    },
    async callWS(msg) {
      this.ws.push(msg);
      if (msg.type === "frontend/get_user_data") {
        if (this.stored === "throw") throw new Error("nope");
        return { value: this.stored };
      }
      if (msg.type === "frontend/set_user_data") {
        this.stored = msg.value;
        return null;
      }
      return { ports: [] };
    },
  };
}

const toasts = () => events.filter((e) => e[1] === "hass-notification").map((e) => e[2].message);

describe("runAction: service calls", () => {
  test("plain calls (revive, reset, unsnooze, ping and its alias)", async () => {
    const host = new Host("card");
    const hass = makeHass();
    for (const id of ["revive", "reset", "unsnooze", "ping", "heartbeat_ping"]) {
      await actions.runAction(host, hass, INFO, id);
    }
    assert.deepEqual(
      hass.calls.map((c) => c.slice(0, 5)),
      [
        ["button", "press", {}, { entity_id: "button.ap_recover" }, true],
        ["necromancer", "reset", {}, { entity_id: "sensor.ap_status" }, true],
        ["necromancer", "unsnooze", {}, { entity_id: "sensor.ap_status" }, true],
        ["necromancer", "heartbeat_ping", {}, { entity_id: "sensor.ap_status" }, true],
        ["necromancer", "heartbeat_ping", {}, { entity_id: "sensor.ap_status" }, true],
      ],
    );
    assert.deepEqual(toasts(), []);
  });

  test("snooze needs a duration and toasts it", async () => {
    const host = new Host("card");
    const hass = makeHass();
    assert.equal(await actions.runAction(host, hass, INFO, "snooze"), null);
    assert.equal(hass.calls.length, 0);
    for (const d of [1800, 3600, 14400, 86400]) await actions.runAction(host, hass, INFO, "snooze", { duration: d });
    assert.deepEqual(hass.calls.map((c) => c[2]), [{ duration: 1800 }, { duration: 3600 }, { duration: 14400 }, { duration: 86400 }]);
    assert.deepEqual(toasts(), [
      "Office <AP> snoozed for 30 min",
      "Office <AP> snoozed for 1 h",
      "Office <AP> snoozed for 4 h",
      "Office <AP> snoozed for 1 d",
    ]);
  });

  test("auto: turn_on / turn_off on the auto switch", async () => {
    const host = new Host("card");
    const on = makeHass({ autoState: "on" });
    await actions.runAction(host, on, INFO, "auto");
    const off = makeHass({ autoState: "off" });
    await actions.runAction(host, off, INFO, "auto");
    await actions.runAction(host, off, INFO, "auto", { autoOn: true });
    assert.deepEqual(on.calls[0].slice(0, 4), ["switch", "turn_off", {}, { entity_id: "switch.ap_auto" }]);
    assert.deepEqual(off.calls[0].slice(0, 4), ["switch", "turn_on", {}, { entity_id: "switch.ap_auto" }]);
    assert.deepEqual(off.calls[1].slice(0, 2), ["switch", "turn_off"]);
  });

  test("check (and its alias) asks for the response and toasts the health", async () => {
    const host = new Host("card");
    const hass = makeHass();
    const res = await actions.runAction(host, hass, INFO, "check_health", { lang: "de", name: "AP" });
    assert.deepEqual(res.response, { health: "unhealthy" });
    assert.deepEqual(hass.calls[0], ["necromancer", "check_health", { guard: "sensor.ap_status" }, undefined, true, true]);
    assert.deepEqual(toasts(), ["AP: Gestört"]);
  });

  test("an error: null, no own toast, nothing logged", async () => {
    const host = new Host("card");
    const hass = makeHass({ fail: true });
    assert.equal(await actions.runAction(host, hass, INFO, "reset"), null);
    assert.equal(await actions.runAction(host, hass, INFO, "snooze", { duration: 60 }), null);
    assert.equal(await actions.runAction(host, hass, INFO, "check"), null);
    assert.equal(await actions.runAction(host, hass, INFO, "url"), null);
    assert.deepEqual(toasts(), []);
    assert.deepEqual(logs, []);
  });

  test("bulk: snooze_all (needs a duration) and unsnooze_all", async () => {
    const host = new Host("panel");
    const hass = makeHass();
    assert.equal(await actions.runAction(host, hass, null, "snooze_all"), null);
    await actions.runAction(host, hass, null, "snooze_all", { duration: 14400 });
    await actions.runAction(host, hass, null, "unsnooze_all");
    assert.deepEqual(hass.calls.map((c) => c.slice(0, 4)), [
      ["necromancer", "snooze_all", { duration: 14400 }, undefined],
      ["necromancer", "unsnooze_all", {}, undefined],
    ]);
    assert.deepEqual(toasts(), ["All guards snoozed for 4 h", "All guards woken up"]);
  });

  test("repair_poe_port: needs an id, toasts at the start", async () => {
    const host = new Host("poe");
    const hass = makeHass();
    assert.equal(await actions.runAction(host, hass, null, "repair_poe_port"), null);
    await actions.runAction(host, hass, null, "repair_poe_port", { id: "aa:bb", port: "Port 5" });
    assert.deepEqual(hass.calls[0].slice(0, 4), ["necromancer", "repair_poe_port", { id: "aa:bb" }, undefined]);
    assert.deepEqual(toasts(), ["Restarting PoE port Port 5 …"]);
  });
});

describe("runAction: navigation and dialogs", () => {
  test("details and more-info open HA's dialog", async () => {
    const host = new Host("card");
    await actions.runAction(host, makeHass(), INFO, "details");
    await actions.runAction(host, makeHass(), INFO, "more-info", { entityId: "switch.ap_auto" });
    assert.equal(await actions.runAction(host, makeHass(), INFO, "more-info"), null);
    assert.deepEqual(events, [
      ["card", "hass-more-info", { entityId: "sensor.ap_status" }],
      ["card", "hass-more-info", { entityId: "switch.ap_auto" }],
    ]);
  });

  test("edit goes to the integration page (pushState + location-changed)", async () => {
    await actions.runAction(new Host("card"), makeHass(), INFO, "edit");
    assert.deepEqual(history, [["push", "/config/integrations/integration/necromancer"]]);
    assert.deepEqual(events, [["window", "location-changed", { replace: false }]]);
    actions.navigate("/x", { replace: true });
    assert.deepEqual(history[1], ["replace", "/x"]);
  });
});

describe("heartbeat URL: clipboard only", () => {
  test("secure context: Clipboard API; absolute URL from the path", async () => {
    const host = new Host("card");
    const hass = makeHass();
    const res = await actions.runAction(host, hass, { ...INFO, type: "heartbeat" }, "heartbeat_url");
    assert.deepEqual(res, { copied: true });
    assert.deepEqual(hass.calls[0], ["necromancer", "heartbeat_url", { guard: "sensor.ap_status" }, undefined, true, true]);
    assert.equal(clipboard, "http://ha.local:8123/api/necromancer/heartbeat/ap_SECRETTOKEN");
    assert.deepEqual(toasts(), ["Heartbeat URL copied"]);
    assert.doesNotMatch(JSON.stringify([events, logs, res]), /SECRETTOKEN/);
  });

  test("plain http: hidden textarea + execCommand, emptied and removed", async () => {
    globalThis.isSecureContext = false;
    const host = new Host("card");
    const hass = makeHass({ urlResponse: { url: "https://ha.example/api/necromancer/heartbeat/ap_SECRETTOKEN", path: "/x" } });
    const res = await actions.runAction(host, hass, INFO, "url");
    assert.deepEqual(res, { copied: true });
    assert.equal(clipboard, null);
    assert.deepEqual(execCopies, [["copy", "https://ha.example/api/necromancer/heartbeat/ap_SECRETTOKEN"]]);
    const ta = globalThis.lastTextarea;
    assert.equal(ta.value, "");
    assert.equal(ta.attached, false);
    assert.equal(ta.attrs["aria-hidden"], "true");
    assert.doesNotMatch(JSON.stringify([events, logs, res]), /SECRETTOKEN/);
  });

  test("no URL in the response: a toast, nothing copied", async () => {
    const res = await actions.runAction(new Host("card"), makeHass({ urlResponse: {} }), INFO, "url");
    assert.deepEqual(res, { copied: false });
    assert.deepEqual(toasts(), ["No heartbeat URL available"]);
    assert.equal(clipboard, null);
  });
});

describe("panel settings", () => {
  test("defaults (design §8)", () => {
    assert.deepEqual({ ...actions.PANEL_DEFAULTS }, {
      show_counters: false,
      show_actions: true,
      show_footer: true,
      collapse_ok: false,
      sort: "problems",
      start_tab: "guards",
      row_detail: "timeline",
      display: "list",
      timeline: false,
    });
    assert.equal(actions.PANEL_SETTINGS_KEY, "necromancer_panel");
  });

  test("normalize: row_detail, display, timeline; old show_timeline and actions", () => {
    const DEF = { ...actions.PANEL_DEFAULTS };
    const n = actions.normalizePanelSettings;
    assert.deepEqual(n([true]), DEF);
    assert.deepEqual(n({ row_detail: "strip", display: "grid", timeline: "yes" }), DEF);
    assert.deepEqual(n({ show_timeline: false, display: "cards" }), { ...DEF, row_detail: "text", display: "cards" });
    assert.deepEqual(n({ show_timeline: false, row_detail: "timeline" }), DEF);
    assert.deepEqual(n({ timeline: true }), { ...DEF, timeline: true });
    // The old per-action button modes are dropped (one fixed rule now).
    assert.deepEqual(n({ actions: { ping: "menu" } }), DEF);
    assert.ok(!("show_timeline" in n({ show_timeline: true })));
  });

  test("normalize drops bad values and unknown keys", () => {
    assert.deepEqual(
      actions.normalizePanelSettings({ show_counters: true, show_actions: "yes", sort: "name", start_tab: "nope", extra: 1 }),
      { ...actions.PANEL_DEFAULTS, show_counters: true, sort: "name" },
    );
    assert.deepEqual(actions.normalizePanelSettings(null), { ...actions.PANEL_DEFAULTS });
  });

  test("load: per-user data, defaults when absent or on error", async () => {
    const hass = makeHass();
    assert.deepEqual(await actions.loadPanelSettings(hass), { ...actions.PANEL_DEFAULTS });
    assert.deepEqual(hass.ws[0], { type: "frontend/get_user_data", key: "necromancer_panel" });
    hass.stored = { collapse_ok: false, start_tab: "poe" };
    assert.deepEqual(await actions.loadPanelSettings(hass), { ...actions.PANEL_DEFAULTS, collapse_ok: false, start_tab: "poe" });
    hass.stored = "throw";
    assert.deepEqual(await actions.loadPanelSettings(hass), { ...actions.PANEL_DEFAULTS });
  });

  test("save: stores the normalized settings under the key", async () => {
    const hass = makeHass();
    const saved = await actions.savePanelSettings(hass, { sort: "state", bogus: true });
    assert.deepEqual(saved, { ...actions.PANEL_DEFAULTS, sort: "state" });
    assert.deepEqual(hass.ws[0], { type: "frontend/set_user_data", key: "necromancer_panel", value: saved });
    assert.deepEqual(await actions.loadPanelSettings(hass), saved);
  });

  test("PoE ports come from the WS command", async () => {
    const hass = makeHass();
    assert.deepEqual(await actions.loadPoePorts(hass), { ports: [] });
    assert.deepEqual(hass.ws[0], { type: "necromancer/poe/ports" });
  });
});
