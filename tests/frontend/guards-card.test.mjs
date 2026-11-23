// Pure helpers of the guards card (necromancer-guards-card):
// config defaults and validation, the row config it hands each guard card
// (row_detail "timeline" by default: one batched history query for the list;
// the old show_timeline still reads), the problems-first order with the
// newest escalation on top, and the form editor schema.
// The element itself is covered by panel.test.mjs (DOM stubs); here only
// HTMLElement/customElements are stubbed so the module loads under node.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

let mod;

before(async () => {
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { get: () => undefined, define: () => {} };
  mod = await import("../../custom_components/necromancer/frontend/necromancer-guards-card.js?v=test");
});

describe("guards card: config", () => {
  test("defaults (design §16): timeline rows, quiet guards not folded, list, bulk and header on", () => {
    const c = mod.normalizeConfig(undefined);
    assert.equal(c.row_detail, "timeline");
    assert.ok(!("show_timeline" in c));
    assert.ok(!("actions" in c));
    assert.equal(c.display, "list");
    assert.equal(c.sort, "problems");
    assert.equal(c.collapse_ok, false);
    assert.equal(c.show_counters, false);
    assert.equal(c.show_footer, true);
    assert.equal(c.show_actions, true);
    assert.equal(c.bulk, true);
    assert.equal(c.show_header, true);
    assert.equal(mod.normalizeConfig({ row_detail: "text" }).row_detail, "text");
  });

  test("back-compat: show_timeline true reads as row_detail timeline, an explicit row_detail wins", () => {
    const old = mod.normalizeConfig({ show_timeline: true });
    assert.equal(old.row_detail, "timeline");
    assert.ok(!("show_timeline" in old), "only row_detail is kept");
    assert.equal(mod.normalizeConfig({ show_timeline: false }).row_detail, "text");
    assert.equal(mod.normalizeConfig({ show_timeline: true, row_detail: "text" }).row_detail, "text");
  });

  test("old options: actions ignored, show_actions auto/none/list read as on/off", () => {
    assert.ok(!("actions" in mod.normalizeConfig({ actions: { ping: "menu" } })));
    assert.ok(!("actions" in mod.normalizeConfig({ actions: ["ping"] })), "no error either");
    assert.equal(mod.normalizeConfig({ show_actions: "none" }).show_actions, false);
    assert.equal(mod.normalizeConfig({ show_actions: "auto" }).show_actions, true);
    assert.equal(mod.normalizeConfig({ show_actions: ["reset"] }).show_actions, true);
  });

  test("rejects bad options", () => {
    assert.throws(() => mod.normalizeConfig({ row_detail: "strip" }), /row_detail/);
    assert.throws(() => mod.normalizeConfig({ show_timeline: "yes" }), /show_timeline/);
    assert.throws(() => mod.normalizeConfig({ display: "grid" }), /display/);
    assert.throws(() => mod.normalizeConfig({ sort: "random" }), /sort/);
    assert.throws(() => mod.normalizeConfig({ filter: [] }), /filter/);
    assert.throws(() => mod.normalizeConfig({ entities: "sensor.a_status" }), /entities/);
    assert.throws(() => mod.normalizeConfig({ value_entities: ["x"] }), /value_entities/);
  });
});

describe("guards card: row config", () => {
  test("compact, expandable, embedded rows; row_detail always written out", () => {
    const off = mod.rowConfig(mod.normalizeConfig({}), "sensor.a_status", true);
    assert.deepEqual(off, {
      entity: "sensor.a_status",
      layout: "compact",
      expandable: true,
      embedded: true,
      show_counters: false,
      show_footer: true,
      show_actions: true,
      row_detail: "timeline",
    });
    const text = mod.rowConfig(mod.normalizeConfig({ row_detail: "text" }), "sensor.a_status", true);
    assert.equal(text.row_detail, "text", "text rows ask for no history");
    const on = mod.rowConfig(mod.normalizeConfig({ show_timeline: true, show_counters: true }), "sensor.a_status", false);
    assert.equal(on.row_detail, "timeline");
    assert.ok(!("show_timeline" in on));
    assert.equal(on.layout, "full");
    assert.ok(!("timeline" in on), "C1: the cards display has no 24 h section by default");
    const tlOn = mod.rowConfig(mod.normalizeConfig({ display: "cards", timeline: true }), "sensor.a_status", false);
    assert.equal(tlOn.timeline, true, "timeline: true gives the full cards their section");
    assert.ok(!("timeline" in mod.rowConfig(mod.normalizeConfig({ timeline: true }), "sensor.a_status", true)), "a compact row never gets it");
    assert.throws(() => mod.normalizeConfig({ timeline: "yes" }), /timeline/);
    assert.equal(on.expandable, false);
    assert.equal(on.show_counters, true);
  });

  test("show_actions reaches every row as on/off; no actions key", () => {
    assert.equal(mod.rowConfig(mod.normalizeConfig({ show_actions: false }), "sensor.a_status", true).show_actions, false);
    assert.ok(!("actions" in mod.rowConfig(mod.normalizeConfig({ actions: { ping: "menu" } }), "sensor.a_status", true)));
  });

  test("value entity only for its own guard, only a non-empty string", () => {
    const cfg = mod.normalizeConfig({ value_entities: { "sensor.a_status": "sensor.a_ping", "sensor.b_status": "" } });
    assert.equal(mod.rowConfig(cfg, "sensor.a_status", true).value_entity, "sensor.a_ping");
    assert.ok(!("value_entity" in mod.rowConfig(cfg, "sensor.b_status", true)));
    assert.ok(!("value_entity" in mod.rowConfig(cfg, "sensor.c_status", true)));
  });
});

describe("guards card: newest escalation first", () => {
  const so = (state, changed) => ({ state, last_changed: changed, attributes: {} });
  const hass = {
    states: {
      "sensor.old_status": so("escalated", "2026-01-01T08:00:00Z"),
      "sensor.new_status": so("escalated", "2026-01-01T10:00:00Z"),
      "sensor.mid_status": so("escalated", "2026-01-01T09:00:00Z"),
      "sensor.ok_status": so("ok", "2026-01-01T11:00:00Z"),
    },
  };
  const order = ["sensor.old_status", "sensor.mid_status", "sensor.new_status", "sensor.ok_status"];

  test("problems: the escalated block is newest first, the rest keeps its place", () => {
    assert.deepEqual(mod.newestEscalationsFirst(order, hass, "problems"), [
      "sensor.new_status",
      "sensor.mid_status",
      "sensor.old_status",
      "sensor.ok_status",
    ]);
  });

  test("other sort modes are left alone", () => {
    assert.deepEqual(mod.newestEscalationsFirst(order, hass, "name"), order);
  });
});

describe("guards card: form editor", () => {
  const names = (schema) => schema.flatMap((s) => (s.schema ? [s.name, ...names(s.schema)] : [s.name]));
  test("HA's own form: fields, labels and helpers in en and de, no buttons section", () => {
    for (const lang of ["en", "de"]) {
      const form = mod.configForm(lang);
      const all = names(form.schema);
      assert.ok(!all.includes("show_timeline") && !all.includes("actions"));
      for (const k of ["title", "sort", "display", "row_detail", "timeline", "collapse_ok", "show_counters", "show_footer", "show_actions", "bulk"]) {
        assert.ok(all.includes(k), `${lang}: ${k}`);
        assert.equal(typeof form.computeLabel({ name: k }), "string", `${lang}: label ${k}`);
      }
      // Every select names its default (HA shows an unset select empty).
      for (const k of ["sort", "display", "row_detail"]) assert.match(form.computeHelper({ name: k }), lang === "de" ? /Standard/ : /[Dd]efault/, `${lang}: ${k}`);
    }
    assert.equal(mod.configForm("en").computeLabel({ name: "row_detail" }), "Row shows");
    assert.equal(mod.configForm("de").computeLabel({ name: "display" }), "Darstellung");
    assert.match(mod.configForm("de").computeHelper({ name: "bulk" }), /YAML/);
    const de = mod.configForm("de").schema.find((x) => x.name === "row_detail").selector.select.options.map((o) => o.label);
    assert.deepEqual(de, ["Text", "Zeitverlauf"]);
  });

  test("visible conditions: timeline only for Cards, Row shows where there are rows", () => {
    const form = mod.configForm("en");
    assert.deepEqual(form.schema.find((x) => x.name === "timeline").visible, { field: "display", value: "cards" });
    const rd = form.schema.find((x) => x.name === "row_detail").visible;
    assert.equal(rd.condition, "or");
    assert.deepEqual(rd.conditions, [{ field: "display", value: "cards", operator: "not_eq" }, { field: "collapse_ok", value: true }]);
    assert.equal(form.schema.find((x) => x.name === "collapse_ok").default, false);
  });

  test("stub config writes the selects out (HA shows an unset select empty)", () => {
    assert.deepEqual(mod.NecromancerGuardsCard.getStubConfig(), { sort: "problems", display: "list", row_detail: "timeline" });
    assert.equal(typeof mod.NecromancerGuardsCard.getConfigElement, "undefined", "no own editor element");
  });

  test("'' (an older editor's default entry) reads as the default", () => {
    const c = mod.normalizeConfig({ sort: "", display: "", row_detail: "" });
    assert.equal(c.sort, "problems");
    assert.equal(c.display, "list");
    assert.equal(c.row_detail, "timeline");
  });
});

describe("row context line (fills the wide row's free column)", () => {
  let base;
  before(async () => {
    base = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test");
  });
  const NOW = Date.parse("2026-11-22T12:00:00Z");
  const so = (state, attrs = {}, changed = "2026-11-22T10:22:00Z") => ({
    entity_id: "sensor.x_status",
    state,
    last_changed: changed,
    attributes: { guard_name: "X", health_type: "template", ...attrs },
  });
  const opts = (extra = {}) => ({ now: NOW, timeZone: "UTC", timeFormat: "24", ...extra });

  test("escalated with auto-recovery off: since + auto off (en/de)", () => {
    const s = so("escalated", { revive_entity: "button.x", driver_type: "switch", auto_recovery_entity: "switch.x_auto" });
    const info = base.core.guardInfo(s);
    assert.equal(base.contextLine(info, s, "en", opts({ autoOn: false })), "Since 10:22 · Auto-recovery off");
    assert.equal(base.contextLine(info, s, "de", opts({ autoOn: false })), "Seit 10:22 · Auto-Reparatur aus");
  });

  test("notify-only guard: problem since + notify only", () => {
    const s = so("suspect", { driver_type: "notify" });
    const info = base.core.guardInfo(s);
    assert.equal(base.contextLine(info, s, "en", opts()), "Problem since 10:22 · Notify only");
    assert.equal(base.contextLine(info, s, "de", opts()), "Problem seit 10:22 · Nur benachrichtigen");
  });

  test("healthy guard: repair counts, or none so far", () => {
    const s = so("ok", { revive_entity: "button.x", driver_type: "switch", recover_count: 3, last_recover: "2026-11-21T08:05:00Z", fail_count: 1 });
    const info = base.core.guardInfo(s);
    assert.equal(base.contextLine(info, s, "en", opts()), "3 repairs (last Sat 08:05) · 1 failed");
    const fresh = so("ok", { revive_entity: "button.x", driver_type: "switch" });
    assert.equal(base.contextLine(base.core.guardInfo(fresh), fresh, "de", opts()), "Noch keine Reparatur");
  });

  test("heartbeat guard: clock time of the last ping, period only without an event", () => {
    const s = so("escalated", { health_type: "heartbeat", driver_type: "notify" });
    const info = base.core.guardInfo(s);
    const last = "2026-11-22T11:02:00Z";
    assert.equal(
      base.contextLine(info, s, "en", opts({ lastHeartbeat: last, period: 3600, hasEvent: true })),
      "Last heartbeat at 11:02",
    );
    assert.equal(
      base.contextLine(info, s, "de", opts({ lastHeartbeat: last, period: 3600 })),
      "Letztes Lebenszeichen um 11:02 · erwartet alle 1 Std.",
    );
    assert.equal(base.contextLine(info, s, "en", opts({ lastHeartbeat: "unknown", period: 60 })), "Expected every 1 min");
  });
});
