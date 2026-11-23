// Pure helpers of the PoE card (necromancer-poe-card): the port
// name, the column headings of the wide list (en/de), the wide column template
// (fixed outer columns so rows line up), when the restart pill gets the strong
// fill, and the markup of one port row (every fact with its key for screen
// readers, the restart confirm/running states, nothing "undefined"), and the
// id mapping (where the id comes from, the guards' expected ids and how they
// relate to the port: matches / last known / ambiguous / mismatch). The
// element itself is covered by panel.test.mjs (DOM stubs); here only
// HTMLElement/customElements are stubbed so the module loads under node.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

let mod;
let core;

before(async () => {
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { get: () => undefined, define: () => {} };
  mod = await import("../../custom_components/necromancer/frontend/necromancer-poe-card.js?v=test");
  core = await import("../../custom_components/necromancer/frontend/necromancer-core.js?v=test");
});

const NOW = Date.parse("2026-11-22T12:00:00Z");

function payload(extra = {}) {
  return {
    entry_id: "e1",
    ports: [
      {
        label: "5",
        actuator: "switch.port_5_poe",
        actuator_state: "on",
        id_source: "entity",
        id_entity: "sensor.port_5_lldp",
        id: "aa:bb:cc:dd:ee:ff",
        status_entity: "binary_sensor.cam",
        status_on: ["on"],
        status_off: ["off"],
        fabric_status: "good",
        last_cycle: { time: new Date(NOW - 2 * 3600e3).toISOString(), ok: false },
        guards: [{ name: "Camera", status_entity: "sensor.cam_status", expected_id: "aa:bb:cc:dd:ee:ff", match: "live" }],
        ...extra,
      },
    ],
  };
}

function hass(states = {}) {
  return {
    states: {
      "switch.port_5_poe": { entity_id: "switch.port_5_poe", state: "on", attributes: { friendly_name: "USW Port 5 PoE" } },
      "sensor.port_5_lldp": { entity_id: "sensor.port_5_lldp", state: "aa:bb:cc:dd:ee:ff", attributes: {} },
      "binary_sensor.cam": { entity_id: "binary_sensor.cam", state: "on", attributes: {} },
      "sensor.cam_status": { entity_id: "sensor.cam_status", state: "ok", attributes: { guard_name: "Camera" } },
      ...states,
    },
  };
}

const rowOf = (p = payload(), h = hass(), lang = "en") => core.poePortRows(p, h, lang)[0];

describe("PoE card: names and headings", () => {
  test("a bare number becomes 'Port N', a label stays as configured", () => {
    assert.equal(mod.portName("23", "en"), "Port 23");
    assert.equal(mod.portName(" 7 ", "de"), "Port 7");
    assert.equal(mod.portName("Port 1 · Camera", "en"), "Port 1 · Camera");
    assert.equal(mod.portName(undefined, "en"), "");
  });

  test("column headings in en and de, empty over the bubble and the pill", () => {
    assert.deepEqual(mod.columnHeads("en"), ["", "Port", "Switch", "Connected", "Used by", "Last restart", ""]);
    assert.deepEqual(mod.columnHeads("de"), ["", "Port", "Schalter", "Angeschlossen", "Genutzt von", "Letzter Neustart", ""]);
    const html = mod.colsHtml("de");
    assert.match(html, /aria-hidden="true"/);
    assert.ok(html.includes("Letzter Neustart"));
  });

  test("wide template: seven columns, fixed bubble and pill columns", () => {
    const cols = mod.WIDE_COLS.match(/minmax\([^)]*\)|\S+/g);
    assert.equal(cols.length, mod.columnHeads("en").length);
    assert.equal(cols[0], "40px");
    assert.equal(cols[cols.length - 1], "150px");
  });
});

describe("PoE card: restart pill", () => {
  test("strong only when the port or a guard on it needs a hand", () => {
    assert.equal(mod.portNeedsHand(rowOf()), false);
    assert.equal(mod.portNeedsHand(rowOf(payload({ fabric_status: "failed" }))), true);
    const esc = hass({ "sensor.cam_status": { entity_id: "sensor.cam_status", state: "escalated", attributes: { guard_name: "Camera" } } });
    assert.equal(mod.portNeedsHand(rowOf(payload(), esc)), true);
    const blind = hass({ "sensor.cam_status": { entity_id: "sensor.cam_status", state: "blind", attributes: { guard_name: "Camera" } } });
    assert.equal(mod.portNeedsHand(rowOf(payload(), blind)), false);
  });

  test("tonal, armed ('Sure?') and running states", () => {
    const r = rowOf();
    const idle = mod.portRowHtml(r, 0, "en", { now: NOW });
    assert.match(idle, /class="pill go "/);
    assert.ok(idle.includes(">Restart<"));
    assert.ok(!idle.includes("aria-disabled"));
    const armed = mod.portRowHtml(r, 0, "en", { armed: true, now: NOW });
    assert.match(armed, /class="pill go confirm"/);
    assert.ok(armed.includes("Sure?"));
    const running = mod.portRowHtml(r, 0, "de", { running: true, now: NOW });
    assert.ok(running.includes('aria-disabled="true"'));
    assert.ok(running.includes("Startet neu"));
    const failed = mod.portRowHtml(rowOf(payload({ fabric_status: "failed" })), 0, "en", { now: NOW });
    assert.match(failed, /class="pill go strong"/);
  });
});

describe("PoE card: port row markup", () => {
  test("every fact in its own cell with its key, values and tags", () => {
    const html = mod.portRowHtml(rowOf(), 0, "en", { now: NOW });
    for (const cls of ["sw", "id", "used", "last"]) assert.ok(html.includes(`class="cell ${cls}"`), cls);
    for (const key of ["Switch", "Connected", "Used by", "Last restart"]) assert.ok(html.includes(`<span class="k">${key}</span>`), key);
    assert.ok(html.includes("Port 5"));
    assert.ok(html.includes("USW Port 5 PoE"));
    assert.ok(html.includes("Power on"));
    assert.ok(html.includes("aa:bb:cc:dd:ee:ff"));
    assert.ok(html.includes("Online"));
    assert.ok(html.includes("Camera"));
    assert.ok(html.includes("2 h ago") || /2\s*h/.test(html), "relative time of the last restart");
    assert.ok(html.includes('class="bad">failed<'));
    assert.ok(!html.includes("undefined"));
    assert.ok(!html.includes("null"));
  });

  test("fixed id: the online tag next to the id, 'Static label' on the line below", () => {
    const p = payload({ id_source: "static", id_static: "demo-camera", id_entity: null });
    const html = mod.portRowHtml(rowOf(p), 1, "de", { now: NOW });
    assert.match(html, /demo-camera<\/span><button class="tag"[^>]*><ha-icon icon="mdi:lan-connect"><\/ha-icon>Online<\/button><\/span><span class="cx"><span class="src"><span>Statisches Label<\/span><\/span><\/span>/);
    assert.ok(html.includes("Angeschlossen"));
  });

  test("no actuator, nothing connected, no guard, never restarted", () => {
    const p = { ports: [{ label: "Spare", id_source: "none", guards: [] }] };
    const html = mod.portRowHtml(rowOf(p, { states: {} }), 0, "de", { now: NOW });
    assert.ok(html.includes("Nichts angeschlossen"));
    assert.ok(html.includes("Kein Guard"));
    assert.ok(html.includes("Noch nie"));
    assert.ok(html.includes('aria-disabled="true"'), "no id to repair by: restart disabled");
    assert.ok(!html.includes("undefined"));
  });

  test("labels and names are escaped", () => {
    const p = payload({ label: "<b>x</b>", guards: [{ name: "<i>g</i>", status_entity: null, match: "last_known" }] });
    const html = mod.portRowHtml(rowOf(p, hass()), 0, "en", { now: NOW });
    assert.ok(!html.includes("<b>x</b>"));
    assert.ok(!html.includes("<i>g</i>"));
    assert.ok(html.includes("last known"));
  });
});

// ---------------------------------------------------------------------------
// Id mapping (core.poePortRows with { mapping: true }, as the card renders)
// ---------------------------------------------------------------------------

const MAC3 = "3c:22:fb:12:34:56";
const MAC4 = "3c:22:fb:ab:cd:ef";
const MAC25 = "a4:cf:12:9b:00:7e";
const OTHER = "b8:27:eb:44:55:66";

/** Four ports like the dev demo: fixed id, live MAC from a helper, an empty
 *  port the cache remembers, and a port that now reports another device. */
function mapPayload({ p25 = OTHER } = {}) {
  const port = (label, extra, guards = []) => ({
    label,
    actuator: `input_boolean.p${label}`,
    actuator_state: "on",
    status_entity: `input_boolean.p${label}`,
    status_on: ["on"],
    status_off: ["off"],
    fabric_status: "good",
    last_cycle: null,
    guards,
    ...extra,
  });
  const g = (name, slug, expected, match) => ({ name, status_entity: `sensor.${slug}_status`, expected_id: expected, expected_norm: expected.toLowerCase(), match });
  return {
    entry_id: "e1",
    ports: [
      port("23", { id_source: "static", id_static: "123412", id: "123412" }),
      port("3", { id_source: "entity", id_entity: "input_text.switch_port_3_mac", id: "3C:22:FB:12:34:56" }, [g("Demo Doorbell", "doorbell", "3C:22:FB:12:34:56", "live")]),
      port("4", { id_source: "entity", id_entity: "input_text.switch_port_4_mac", id: "" }, [g("Demo Garden Cam", "garden", MAC4, "last_known")]),
      port("25", { id_source: "entity", id_entity: "input_text.switch_port_25_mac", id: p25 }, [g("Demo Sprinkler", "sprinkler", MAC25.toUpperCase(), "last_known")]),
    ],
  };
}

function mapHass({ p3 = "3C:22:FB:12:34:56", p4 = "", p25 = OTHER } = {}) {
  const st = (id, state, attributes = {}) => ({ entity_id: id, state, attributes });
  const states = {};
  for (const l of ["23", "3", "4", "25"]) states[`input_boolean.p${l}`] = st(`input_boolean.p${l}`, "on");
  states["input_text.switch_port_3_mac"] = st("input_text.switch_port_3_mac", p3, { friendly_name: "Switch port 3 MAC" });
  states["input_text.switch_port_4_mac"] = st("input_text.switch_port_4_mac", p4, { friendly_name: "Switch port 4 MAC" });
  states["input_text.switch_port_25_mac"] = st("input_text.switch_port_25_mac", p25, { friendly_name: "Switch port 25 MAC" });
  for (const [slug, name] of [["doorbell", "Demo Doorbell"], ["garden", "Demo Garden Cam"], ["sprinkler", "Demo Sprinkler"]]) {
    states[`sensor.${slug}_status`] = st(`sensor.${slug}_status`, "ok", { guard_name: name });
  }
  return { states };
}

const mapRows = (lang = "en", p = mapPayload(), h = mapHass()) => core.poePortRows(p, h, lang, { mapping: true });
const rowHtml = (lang = "en", i = 0, p, h) => mod.portRowHtml(mapRows(lang, p, h)[i], i, lang, { now: NOW });

describe("PoE card: id mapping", () => {
  test("fixed id: the id in mono and 'Static label' as its origin, no source link", () => {
    const html = rowHtml("en", 0);
    assert.ok(html.includes('<span class="v mono" title="123412">123412</span>'));
    assert.ok(html.includes('<span class="src"><span>Static label</span></span>'));
    assert.ok(!html.includes('data-key="src0"'));
  });

  test("live id: MAC shown as AA:BB:…, origin 'live · from <entity>' links to its more-info", () => {
    const html = rowHtml("en", 1, mapPayload(), mapHass({ p3: "3c22.fb12.3456" }));
    assert.ok(html.includes(">3C:22:FB:12:34:56<"), "MAC normalised for display");
    assert.ok(html.includes('title="3C:22:FB:12:34:56 (3c22.fb12.3456)"'), "raw spelling in the tooltip");
    assert.match(html, /<span class="src live"><span>live · from <button data-action="more-info" data-entity="input_text.switch_port_3_mac" data-key="src1"/);
    assert.ok(html.includes('title="Switch port 3 MAC (input_text.switch_port_3_mac)"'));
    // The entity's name, not its long id (the id stays in the tooltip).
    assert.match(html, /data-key="src1" title="Switch port 3 MAC \(input_text.switch_port_3_mac\)">Switch port 3 MAC<\/button>/);
    const de = rowHtml("de", 1);
    assert.ok(de.includes("live über <button"));
  });

  test("live id and its guard: 'matches', without repeating the id", () => {
    const html = rowHtml("en", 1);
    assert.match(html, /<span class="n">Demo Doorbell<\/span><\/button><span class="rel"[^>]*><ha-icon icon="mdi:check-circle"><\/ha-icon><span>matches<\/span><\/span>/);
    assert.ok(!html.includes("expected:"));
    assert.ok(rowHtml("de", 1).includes("<span>passt</span>"));
  });

  test("empty port the cache remembers: 'Nothing connected · expected: … (last known)'", () => {
    const html = rowHtml("en", 2);
    assert.ok(html.includes('<span class="v empty"'));
    assert.ok(html.includes('Nothing connected · expected: <span class="mono">3C:22:FB:AB:CD:EF</span> (last known)'));
    // The guard says "last known" without repeating the id the line already names.
    assert.match(html, /<ha-icon icon="mdi:history"><\/ha-icon><span>last known<\/span>/);
    const de = rowHtml("de", 2);
    assert.ok(de.includes('Nichts angeschlossen · erwartet: <span class="mono">3C:22:FB:AB:CD:EF</span> (zuletzt bekannt)'));
    assert.ok(de.includes("<span>zuletzt bekannt</span>"));
  });

  test("empty live entity: hollow dot, no 'currently empty' and no 'Offline' tag beside 'Nothing connected'", () => {
    const p = mapPayload();
    const h = mapHass();
    h.states["input_boolean.p4"] = { entity_id: "input_boolean.p4", state: "off", attributes: {} };
    p.ports[2].actuator = "input_boolean.p4_power";
    h.states["input_boolean.p4_power"] = { entity_id: "input_boolean.p4_power", state: "on", attributes: {} };
    const rows = mapRows("en", p, h);
    assert.equal(rows[2].online, false);
    const html = mod.portRowHtml(rows[2], 2, "en", { now: NOW });
    assert.match(html, /<span class="src live empty"><span>live · from <button[^>]*>[^<]*(<wbr>[^<]*)*<\/button><\/span><\/span>/);
    assert.ok(!html.includes("currently empty"), "'Nothing connected' already says it");
    assert.ok(!html.includes("mdi:lan-disconnect"), "no Offline tag: 'Nothing connected' and the header say it");
    assert.ok(html.includes("Nothing connected · expected:"));
    const de = mod.portRowHtml(mapRows("de", p, h)[2], 2, "de", { now: NOW });
    assert.ok(!de.includes("gerade leer"));
    assert.ok(de.includes('<span class="src live empty"><span>live über <button'));
    // A port that reports an id keeps its green dot and its Online/Offline tag.
    const live = mod.portRowHtml(rows[1], 1, "en", { now: NOW });
    assert.ok(live.includes('<span class="src live"><span>'));
    assert.ok(live.includes("mdi:lan-connect"));
  });

  test("mismatch: the cache points here, the port reports another id", () => {
    const rows = mapRows();
    assert.equal(rows[3].mismatch, true);
    const html = mod.portRowHtml(rows[3], 3, "en", { now: NOW });
    assert.ok(html.includes(">B8:27:EB:44:55:66<"), "the id the port reports now");
    // Both ids in mono: what the guard expects and what the port reports instead.
    assert.match(html, /<ha-icon icon="mdi:alert-circle"><\/ha-icon><span>expected: <span class="mono">A4:CF:12:9B:00:7E<\/span> · port reports <span class="mono">B8:27:EB:44:55:66<\/span><\/span>/);
    assert.match(html, /--rc:var\(--error-color/);
    assert.ok(html.includes('title="Demo Sprinkler: expected: A4:CF:12:9B:00:7E · port reports B8:27:EB:44:55:66"'));
    const de = mod.portRowHtml(mapRows("de")[3], 3, "de", { now: NOW });
    assert.ok(de.includes('erwartet: <span class="mono">A4:CF:12:9B:00:7E</span> · Port meldet <span class="mono">B8:27:EB:44:55:66</span>'));
    // The expected id live on another port: named too.
    const p = mapPayload();
    const moved = mapRows("en", p, mapHass({ p3: MAC25 }));
    assert.equal(moved[3].guards[0].relation, "mismatch");
    assert.deepEqual(moved[3].guards[0].otherPorts, ["Port 3"]);
    const mh = mod.portRowHtml(moved[3], 3, "en", { now: NOW });
    assert.ok(mh.includes('port reports <span class="mono">B8:27:EB:44:55:66</span> · now on Port 3'));
  });

  test("ambiguous: two ports report the guard's id", () => {
    const p = mapPayload();
    p.ports[3].guards.push({ ...p.ports[1].guards[0], match: "ambiguous" });
    p.ports[1].guards[0].match = "ambiguous";
    const h = mapHass({ p25: MAC3 });
    const rows = mapRows("en", p, h);
    for (const i of [1, 3]) {
      const html = mod.portRowHtml(rows[i], i, "en", { now: NOW });
      const other = i === 1 ? "Port 25" : "Port 3";
      assert.match(html, new RegExp(`<span class="n">Demo Doorbell</span></button><span class="rel"[^>]*><ha-icon icon="mdi:call-split"></ha-icon><span>ambiguous · also on ${other}</span>`), `port ${i}`);
    }
    const de = mod.portRowHtml(mapRows("de", p, h)[1], 1, "de", { now: NOW });
    assert.ok(de.includes("<span>mehrdeutig · auch an Port 25</span>"));
  });

  test("elsewhere: the expected id turned up live on another port", () => {
    // Garden cam's MAC now on port 25; the payload still lists it on port 4.
    const rows = mapRows("en", mapPayload(), mapHass({ p25: MAC4 }));
    const html = mod.portRowHtml(rows[2], 2, "en", { now: NOW });
    assert.match(html, /<ha-icon icon="mdi:swap-horizontal"><\/ha-icon><span>expected: <span class="mono">3C:22:FB:AB:CD:EF<\/span> · now on Port 25<\/span>/);
    assert.ok(!html.includes('class="v empty"'), "no 'last known' line once the id is live elsewhere");
  });

  test("misconfigured port: the conflict as the value, both sources as its origin (red)", () => {
    const p = { ports: [{ label: "9", id_source: "conflict", id_static: "aa-bb-cc-00-11-22", id_entity: "input_text.x", guards: [] }] };
    const html = mod.portRowHtml(core.poePortRows(p, { states: {} }, "en", { mapping: true })[0], 0, "en", { now: NOW });
    assert.ok(html.includes("Misconfigured"));
    assert.match(html, /<span class="src conflict"><span>conflict · label <span class="mono">AA:BB:CC:00:11:22<\/span> and <button data-action="more-info" data-entity="input_text.x"/);
    const de = mod.portRowHtml(core.poePortRows(p, { states: {} }, "de", { mapping: true })[0], 0, "de", { now: NOW });
    assert.ok(de.includes('Konflikt · Label <span class="mono">AA:BB:CC:00:11:22</span> und <button'));
  });

  test("no id source: 'No id source' under 'Nothing connected'", () => {
    const p = { ports: [{ label: "Spare", id_source: "none", guards: [] }] };
    const html = mod.portRowHtml(core.poePortRows(p, { states: {} }, "de", { mapping: true })[0], 0, "de", { now: NOW });
    assert.ok(html.includes("Nichts angeschlossen"));
    assert.ok(html.includes("Keine Kennungsquelle"));
  });

  test("every mapping row renders without undefined/null and escapes names", () => {
    const p = mapPayload();
    p.ports[1].guards[0].name = "<i>x</i>";
    const h = mapHass();
    delete h.states["sensor.doorbell_status"];
    for (const lang of ["en", "de"]) {
      mapRows(lang, p, h).forEach((r, i) => {
        const html = mod.portRowHtml(r, i, lang, { now: NOW });
        assert.ok(!html.includes("undefined"), `${lang} ${i}`);
        assert.ok(!/>null</.test(html), `${lang} ${i}`);
        assert.ok(!html.includes("<i>x</i>"));
        assert.ok(!html.includes("\u0001"), "no split marker left");
      });
    }
  });
});

describe("PoE card: ports filter", () => {
  test("a port name matches the label as configured and as shown, numbers too", () => {
    assert.ok(mod.portMatches("Port 5 · Chime", "Port 5"));
    assert.ok(mod.portMatches("Port 5 · Chime", "port 5 · chime"));
    assert.ok(!mod.portMatches("Port 50 · Cam", "Port 5"));
    assert.ok(mod.portMatches("5", "Port 5"), "a bare number shows as Port 5");
    assert.ok(mod.portMatches("5", 5));
    assert.ok(mod.portMatches("5", "5"));
    assert.ok(!mod.portMatches("25", "Port 2"));
    assert.ok(!mod.portMatches("Port 5", ""));
  });
});

describe("PoE card: switch column", () => {
  test("the device is not repeated when the switch's name already says it", () => {
    const base = rowOf();
    const same = mod.portRowHtml({ ...base, switch: "PoE-Switch-Serverschrank Port 18", switchDevice: "PoE-Switch-Serverschrank" }, 0, "en", { now: NOW });
    assert.ok(!same.includes("· PoE-Switch-Serverschrank"));
    const other = mod.portRowHtml({ ...base, switch: "Port 18 PoE", switchDevice: "Core switch" }, 0, "en", { now: NOW });
    assert.ok(other.includes("· Core switch"));
  });
});

