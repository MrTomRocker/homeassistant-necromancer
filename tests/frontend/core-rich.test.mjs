// Opt-in core logic for the cards: the guard's own main value
// (mainValue rich + entityValue) and the PoE id mapping (poePortRows
// mapping + formatPortId). Without the opt-in the plain results stay
// unchanged, which the last tests pin.
// Run with `node --test tests/frontend/*.test.mjs`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_ORDER,
  actionsFor,
  entityValue,
  formatPortId,
  guardInfo,
  mainValue,
  poePortRows,
  portDisplayName,
} from "../../custom_components/necromancer/frontend/necromancer-core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

function status(attrs, state = "ok", changedAgo = 19 * 60) {
  return {
    entity_id: "sensor.pool_status",
    state,
    attributes: {
      guard_name: "Pool",
      health_entity: "binary_sensor.pool_health",
      auto_recovery_entity: "switch.pool_auto_recovery",
      revive_entity: "button.pool_revive",
      recovery_event_entity: "event.pool_recovery",
      health_type: "entity_state",
      driver_type: "switch",
      driver_entity: "switch.pool_plug",
      ...attrs,
    },
    last_changed: ago(changedAgo),
  };
}

const POWER = { entity_id: "sensor.pool_power", state: "200", attributes: { unit_of_measurement: "W", friendly_name: "Pool power" } };

function hassWith(statusObj, extra = {}, more = {}) {
  return { states: { [statusObj.entity_id]: statusObj, ...extra }, ...more };
}

// ---------------------------------------------------------------------------

describe("guardInfo: source entity", () => {
  test("from source_entity / source_attribute, null when absent", () => {
    const i = guardInfo(status({ source_entity: "sensor.pool_power", source_attribute: null }));
    assert.equal(i.sourceEntity, "sensor.pool_power");
    assert.equal(i.sourceAttribute, null);
    const a = guardInfo(status({ source_entity: "sensor.x", source_attribute: "rssi" }));
    assert.equal(a.sourceAttribute, "rssi");
    const none = guardInfo(status({}));
    assert.equal(none.sourceEntity, null);
  });
});

describe("entityValue", () => {
  const so = (state, attrs = {}, id = "sensor.v") => ({ entity_id: id, state, attributes: attrs });

  test("number with unit, HA style per language", () => {
    assert.deepEqual(entityValue(so("200", { unit_of_measurement: "W" }), {}, "en"), { text: "200 W", number: 200, unit: "W" });
    assert.equal(entityValue(so("1234.5", { unit_of_measurement: "W" }), {}, "en").text, "1,234.5 W");
    assert.equal(entityValue(so("1234.5", { unit_of_measurement: "W" }), {}, "de").text, "1.234,5 W");
    // A numeric string keeps its own decimals, like HA.
    assert.equal(entityValue(so("529.0", { unit_of_measurement: "W" }), {}, "en").text, "529.0 W");
    // display_precision wins.
    assert.equal(entityValue(so("2.345", { unit_of_measurement: "ms" }), { entities: { "sensor.v": { display_precision: 1 } } }, "en").text, "2.3 ms");
    // An input_number with a whole step and a whole value: no decimals (HA's rule).
    assert.equal(entityValue(so("200.0", { unit_of_measurement: "W", step: 1 }, "input_number.p"), {}, "en").text, "200 W");
    assert.equal(entityValue(so("200.5", { unit_of_measurement: "W", step: 0.5 }, "input_number.p"), {}, "en").text, "200.5 W");
  });

  test("blank before % per language, none before °", () => {
    const pct = so("50", { unit_of_measurement: "%" });
    assert.equal(entityValue(pct, {}, "en").text, "50%");
    assert.equal(entityValue(pct, {}, "de").text, "50 %");
    assert.equal(entityValue(so("21.5", { unit_of_measurement: "°" }), {}, "de").text, "21,5°");
    assert.equal(entityValue(so("21.5", { unit_of_measurement: "°C" }), {}, "en").text, "21.5 °C");
  });

  test("the user's number format", () => {
    const v = so("1234.5", { unit_of_measurement: "W" });
    assert.equal(entityValue(v, { locale: { language: "en", number_format: "decimal_comma" } }, "en").text, "1.234,5 W");
    assert.equal(entityValue(v, { locale: { language: "de", number_format: "comma_decimal" } }, "de").text, "1,234.5 W");
    assert.equal(entityValue(v, { locale: { language: "de", number_format: "none" } }, "de").text, "1234.5 W");
  });

  test("non-numeric, unavailable, missing, attribute", () => {
    assert.deepEqual(entityValue(so("on"), {}, "en"), { text: "on", number: null, unit: null });
    assert.equal(entityValue(so("running", { unit_of_measurement: "x" }), {}, "en").number, null);
    assert.deepEqual(entityValue(so("unavailable", { unit_of_measurement: "W" }), {}, "en"), { text: "–", number: null, unit: null });
    assert.deepEqual(entityValue(undefined, {}, "en"), { text: "–", number: null, unit: null });
    for (const bad of ["", "0x1f", "1e", "12 W", "NaN", "Infinity"]) assert.equal(entityValue(so(bad), {}, "en").number, null, bad);
    // An attribute: its value, no unit (the unit belongs to the state).
    const rssi = so("home", { rssi: -60, unit_of_measurement: "W" });
    assert.deepEqual(entityValue(rssi, {}, "en", "rssi"), { text: "-60", number: -60, unit: null });
    assert.deepEqual(entityValue(rssi, {}, "en", "missing"), { text: "–", number: null, unit: null });
  });
});

describe("mainValue rich", () => {
  const rich = { rich: true };
  const stateGuard = status({ source_entity: "sensor.pool_power", source_attribute: null });
  const info = guardInfo(stateGuard);

  test("numeric source: the value, caption '<State> for <duration>'", () => {
    const mv = mainValue(info, hassWith(stateGuard, { "sensor.pool_power": POWER }), {}, NOW, "en", rich);
    assert.equal(mv.value, "200 W");
    assert.equal(mv.caption, "Healthy for 19 min");
    assert.equal(mv.kind, "source");
    assert.equal(mv.entity, "sensor.pool_power");
    assert.equal(mv.number, 200);
    assert.equal(mv.unit, "W");
    assert.equal(mv.stateWord, "Healthy");
    assert.equal(mv.duration, "19 min");
    assert.equal(mv.late, false);
    assert.equal(mv.age, 19 * 60);
    assert.ok(mv.title.startsWith("Pool power"));
    const de = mainValue(info, hassWith(stateGuard, { "sensor.pool_power": POWER }), {}, NOW, "de", rich);
    assert.equal(de.caption, "Gesund seit 19 Min.");
  });

  test("the state word follows the guard state", () => {
    const esc = { ...stateGuard, state: "escalated" };
    const mv = mainValue(info, hassWith(esc, { "sensor.pool_power": POWER }), {}, NOW, "de", rich);
    assert.equal(mv.value, "200 W");
    assert.equal(mv.caption, "Eskaliert seit 19 Min.");
  });

  test("opts.since: the real start of the state beats last_changed (restart)", () => {
    const h = hassWith(stateGuard, { "sensor.pool_power": POWER });
    const since = new Date(NOW - 2 * 3600e3);
    const mv = mainValue(info, h, {}, NOW, "en", { rich: true, since });
    assert.equal(mv.caption, "Healthy for 2 h");
    assert.equal(mv.age, 7200);
    const iso = mainValue(info, h, {}, NOW, "en", { rich: true, since: since.toISOString() });
    assert.equal(iso.caption, "Healthy for 2 h");
    const tmpl = status({ health_type: "template", source_entity: null });
    assert.equal(mainValue(guardInfo(tmpl), hassWith(tmpl), {}, NOW, "en", { rich: true, since: since.getTime() }).value, "for 2 h");
    // Unknown or bad since: last_changed as before; without rich it is ignored.
    assert.equal(mainValue(info, h, {}, NOW, "en", { rich: true, since: null }).caption, "Healthy for 19 min");
    assert.equal(mainValue(info, h, {}, NOW, "en", { rich: true, since: "garbage" }).caption, "Healthy for 19 min");
    assert.equal(mainValue(guardInfo(tmpl), hassWith(tmpl), {}, NOW, "en", { since }).value, "for 19 min");
  });

  test("numeric attribute source", () => {
    const g = status({ source_entity: "device_tracker.ap", source_attribute: "rssi" });
    const ap = { entity_id: "device_tracker.ap", state: "home", attributes: { rssi: "-61", friendly_name: "AP" } };
    const mv = mainValue(guardInfo(g), hassWith(g, { "device_tracker.ap": ap }), {}, NOW, "en", rich);
    assert.equal(mv.value, "-61");
    assert.equal(mv.kind, "source");
    assert.ok(mv.title.startsWith("AP · rssi"));
  });

  test("on/off, text, unavailable or missing source: 'for 19 min' as before", () => {
    for (const st of ["on", "off", "running", "unavailable", "unknown"]) {
      const src = { entity_id: "sensor.pool_power", state: st, attributes: {} };
      const mv = mainValue(info, hassWith(stateGuard, { "sensor.pool_power": src }), {}, NOW, "en", rich);
      assert.equal(mv.value, "for 19 min", st);
      assert.equal(mv.caption, "", st);
      assert.equal(mv.kind, "duration", st);
      assert.equal(mv.duration, "19 min", st);
      assert.equal(mv.stateWord, null, st);
    }
    const missing = mainValue(info, hassWith(stateGuard), {}, NOW, "de", rich);
    assert.equal(missing.value, "seit 19 Min.");
  });

  test("template guard (no source_entity): 'for 19 min'", () => {
    const g = status({ health_type: "template", source_entity: null });
    const mv = mainValue(guardInfo(g), hassWith(g), {}, NOW, "en", rich);
    assert.equal(mv.value, "for 19 min");
    assert.equal(mv.kind, "duration");
    assert.equal(mv.entity, null);
  });

  test("a status sensor that is unavailable never shows the source", () => {
    const g = { ...stateGuard, state: "unavailable" };
    const mv = mainValue(info, hassWith(g, { "sensor.pool_power": POWER }), {}, NOW, "en", rich);
    assert.equal(mv.kind, "duration");
  });

  test("value_entity overrides the source", () => {
    const lat = { entity_id: "sensor.lat", state: "12.50", attributes: { unit_of_measurement: "ms", friendly_name: "Latency" } };
    const mv = mainValue(info, hassWith(stateGuard, { "sensor.pool_power": POWER, "sensor.lat": lat }), { value_entity: "sensor.lat" }, NOW, "en", rich);
    assert.equal(mv.value, "12.50 ms");
    assert.equal(mv.caption, "Latency");
    assert.equal(mv.kind, "custom");
    assert.equal(mv.entity, "sensor.lat");
    assert.equal(mv.number, 12.5);
  });

  test("heartbeat keeps '1 h ago' + 'Last heartbeat · expected every 1 h'", () => {
    const hb = status(
      {
        health_type: "heartbeat",
        driver_type: "notify",
        revive_entity: null,
        auto_recovery_entity: null,
        recovery_event_entity: null,
        last_heartbeat_entity: "sensor.job_last_heartbeat",
        last_status: "ok",
        source_entity: null,
      },
      "ok",
    );
    const last = { entity_id: "sensor.job_last_heartbeat", state: ago(3600), attributes: { period: 3600, next_due: ago(0 - 60) } };
    const mv = mainValue(guardInfo(hb), hassWith(hb, { "sensor.job_last_heartbeat": last }), {}, NOW, "en", rich);
    assert.equal(mv.value, "1 h ago");
    assert.equal(mv.caption, "Last heartbeat · expected every 1 h");
    assert.equal(mv.kind, "heartbeat");
    assert.equal(mv.entity, "sensor.job_last_heartbeat");
  });

  test("without the opt-in: unchanged (no source value, old shape)", () => {
    const mv = mainValue(info, hassWith(stateGuard, { "sensor.pool_power": POWER }), {}, NOW, "en");
    assert.deepEqual(Object.keys(mv).sort(), ["age", "caption", "late", "title", "value"]);
    assert.equal(mv.value, "for 19 min");
  });
});

// ---------------------------------------------------------------------------

describe("formatPortId", () => {
  test("MACs in any spelling -> AA:BB:…, other ids as is", () => {
    assert.equal(formatPortId("3c:22:fb:12:34:56"), "3C:22:FB:12:34:56");
    assert.equal(formatPortId("3c-22-fb-12-34-56"), "3C:22:FB:12:34:56");
    assert.equal(formatPortId("3c22.fb12.3456"), "3C:22:FB:12:34:56");
    assert.equal(formatPortId(" 3C22FB123456 "), "3C:22:FB:12:34:56");
    assert.equal(formatPortId("3c:22-fb:12:34:56"), "3c:22-fb:12:34:56"); // mixed separators: not a MAC
    assert.equal(formatPortId("123412"), "123412");
    assert.equal(formatPortId(" camera-garage "), "camera-garage");
    for (const v of ["-", "none", "", null, undefined, "unavailable"]) assert.equal(formatPortId(v), null, String(v));
  });
});

describe("poePortRows mapping", () => {
  const port = (label, extra) => ({
    label,
    actuator: `switch.${label}`,
    status_on: ["on"],
    status_off: ["off"],
    fabric_status: "good",
    guards: [],
    ...extra,
  });
  const guard = (name, expected, match, extra = {}) => ({ name, status_entity: `sensor.${name}_status`, expected_id: expected, match, ...extra });
  const payload = {
    ports: [
      port("p3", {
        id_source: "entity",
        id_entity: "input_text.switch_port_3_mac",
        id: "3c:22:fb:12:34:56",
        guards: [guard("doorbell", "3C:22:FB:12:34:56", "live", { expected_norm: "3c:22:fb:12:34:56" })],
      }),
      port("p4", {
        id_source: "entity",
        id_entity: "sensor.sw",
        id_attribute: "port_4_mac",
        id: "-",
        guards: [guard("cam", "aa-bb-cc-dd-ee-ff", "last_known")],
      }),
      port("p5", { id_source: "entity", id_entity: "sensor.p5", id: "11:22:33:44:55:66", guards: [guard("old", "AA:BB:CC:00:11:22", "last_known")] }),
      port("p23", { id_source: "static", id_static: "123412", id: "123412", guards: [guard("a", "123412", "ambiguous")] }),
      port("p25", { id_source: "static", id_static: "123412", id: "123412", guards: [guard("a", "123412", "ambiguous")] }),
      port("p7", { id_source: "conflict", id_static: "x", id_entity: "sensor.y", id: null }),
      port("p8", { id_source: "none", id: null }),
    ],
  };
  const hass = {
    states: {
      "input_text.switch_port_3_mac": { state: "3c:22:fb:12:34:56", attributes: { friendly_name: "Switch port 3 MAC" } },
      "sensor.sw": { state: "x", attributes: { port_4_mac: "-" } },
    },
  };
  const rows = (h = hass, lang = "en") => poePortRows(payload, h, lang, { mapping: true });

  test("id origin: live from entity[.attribute], fixed, conflict, none", () => {
    const [p3, p4, , p23, , p7, p8] = rows();
    assert.deepEqual(p3.idOrigin, {
      kind: "live",
      entity: "input_text.switch_port_3_mac",
      attribute: null,
      entityName: "Switch port 3 MAC",
      empty: false,
      staticId: null,
      label: "live · from input_text.switch_port_3_mac",
    });
    assert.equal(p4.idOrigin.label, "live · from sensor.sw.port_4_mac");
    assert.equal(p4.idOrigin.attribute, "port_4_mac");
    assert.equal(p23.idOrigin.kind, "fixed");
    assert.equal(p23.idOrigin.label, "Static label");
    assert.equal(p7.idOrigin.kind, "conflict");
    assert.equal(p8.idOrigin.kind, "none");
    assert.equal(rows(hass, "de")[0].idOrigin.label, "live über input_text.switch_port_3_mac");
    assert.equal(rows(hass, "de")[3].idOrigin.label, "Statisches Label");
  });

  test("id origin: an empty live entity says so, a conflict names both sources", () => {
    const [p3, p4, , , , p7] = rows();
    assert.equal(p3.idOrigin.empty, false);
    assert.equal(p4.idOrigin.empty, true);
    // Empty: the same words (the "Nothing connected" line says the rest).
    assert.equal(p4.idOrigin.label, "live · from sensor.sw.port_4_mac");
    assert.equal(rows(hass, "de")[1].idOrigin.label, "live über sensor.sw.port_4_mac");
    assert.equal(p7.idStatic, "x");
    assert.equal(p7.idOrigin.staticId, "x");
    assert.equal(p7.idOrigin.entity, "sensor.y");
    assert.equal(p7.idOrigin.label, "conflict · label x and sensor.y");
    assert.equal(rows(hass, "de")[5].idOrigin.label, "Konflikt · Label x und sensor.y");
    assert.equal(p7.idDisplay, null, "a conflict shows no id");
  });

  test("ids: normalised for the fabric, MACs for display", () => {
    const [p3, p4, p5, p23, , p7] = rows();
    assert.equal(p3.idNorm, "3c:22:fb:12:34:56");
    assert.equal(p3.idDisplay, "3C:22:FB:12:34:56");
    assert.equal(p4.idNorm, null);
    assert.equal(p4.idDisplay, null);
    assert.equal(p5.idDisplay, "11:22:33:44:55:66");
    assert.equal(p23.idDisplay, "123412");
    assert.equal(p7.idNorm, null);
    assert.equal(p7.idDisplay, null);
  });

  test("per guard: live, last known, ambiguous, mismatch", () => {
    const [p3, p4, p5, p23, p25] = rows();
    assert.equal(p3.guards[0].relation, "live");
    assert.equal(p3.guards[0].relationLabel, "matches");
    assert.equal(p3.guards[0].expectedDisplay, "3C:22:FB:12:34:56");
    assert.equal(p3.guards[0].expectedNorm, "3c:22:fb:12:34:56");
    assert.equal(p4.guards[0].relation, "last_known");
    assert.equal(p4.guards[0].relationLabel, "last known");
    assert.equal(p5.guards[0].relation, "mismatch");
    assert.equal(p5.mismatch, true);
    assert.equal(p3.mismatch, false);
    // A mismatch names what the port reports instead.
    assert.equal(p5.guards[0].reportedDisplay, "11:22:33:44:55:66");
    assert.equal(p5.guards[0].relationLabel, "port reports 11:22:33:44:55:66");
    assert.deepEqual(p5.guards[0].otherPorts, []);
    // Ambiguous names the other port(s).
    assert.equal(p23.guards[0].relation, "ambiguous");
    assert.equal(p25.guards[0].relation, "ambiguous");
    assert.deepEqual(p23.guards[0].otherPorts, ["p25"]);
    assert.equal(p23.guards[0].relationLabel, "ambiguous · also on p25");
    assert.equal(p25.guards[0].relationLabel, "ambiguous · also on p23");
    assert.equal(p3.guards[0].reportedDisplay, null);
    const de = rows(hass, "de");
    assert.equal(de[0].guards[0].relationLabel, "passt");
    assert.equal(de[1].guards[0].relationLabel, "zuletzt bekannt");
    assert.equal(de[2].guards[0].relationLabel, "Port meldet 11:22:33:44:55:66");
    assert.equal(de[3].guards[0].relationLabel, "mehrdeutig · auch an p25");
    // A bare number is a "Port N".
    const num = poePortRows({ ports: [{ ...payload.ports[3], label: "23" }, { ...payload.ports[4], label: "25" }] }, hass, "en", { mapping: true });
    assert.equal(num[0].guards[0].relationLabel, "ambiguous · also on Port 25");
    assert.equal(portDisplayName("7", "de"), "Port 7");
    assert.equal(portDisplayName("Uplink"), "Uplink");
    // Old fields stay.
    assert.equal(p4.guards[0].match, "last_known");
    assert.equal(p4.guards[0].expectedId, "aa-bb-cc-dd-ee-ff");
  });

  test("empty port that a guard still expects", () => {
    const [p3, p4, , p23, , , p8] = rows();
    assert.equal(p4.empty, true);
    assert.deepEqual(p4.emptyExpected, ["AA:BB:CC:DD:EE:FF"]);
    assert.equal(p4.emptyLabel, "Nothing connected · expected: AA:BB:CC:DD:EE:FF (last known)");
    assert.equal(rows(hass, "de")[1].emptyLabel, "Nichts angeschlossen · erwartet: AA:BB:CC:DD:EE:FF (zuletzt bekannt)");
    assert.equal(p3.empty, false);
    assert.equal(p23.empty, false);
    assert.equal(p8.empty, true);
    assert.deepEqual(p8.emptyExpected, []);
    assert.equal(p8.emptyLabel, null);
  });

  test("live hass values re-derive the relation", () => {
    // The doorbell leaves port 3: last known (the fabric cache keeps it).
    const gone = { states: { ...hass.states, "input_text.switch_port_3_mac": { state: "", attributes: {} } } };
    const [p3] = rows(gone);
    assert.equal(p3.guards[0].relation, "last_known");
    assert.deepEqual(p3.emptyExpected, ["3C:22:FB:12:34:56"]);
    // Another device is plugged in there: mismatch.
    const other = { states: { ...hass.states, "input_text.switch_port_3_mac": { state: "de:ad:be:ef:00:01", attributes: {} } } };
    assert.equal(rows(other)[0].guards[0].relation, "mismatch");
    // The cam turns up on port 4 again (any case, trimmed): live.
    const back = { states: { ...hass.states, "sensor.sw": { state: "x", attributes: { port_4_mac: " AA-BB-CC-DD-EE-FF " } } } };
    assert.equal(rows(back)[1].guards[0].relation, "live");
    // The doorbell's MAC now shows on port 4 while port 3 is empty: elsewhere.
    const moved = {
      states: {
        "input_text.switch_port_3_mac": { state: "unknown", attributes: {} },
        "sensor.sw": { state: "x", attributes: { port_4_mac: "3C:22:FB:12:34:56" } },
      },
    };
    const [m3, m4] = rows(moved);
    assert.equal(m3.guards[0].relation, "elsewhere");
    assert.equal(m3.guards[0].relationLabel, "now on p4");
    assert.equal(m4.guards[0].relation, "mismatch"); // the cam's port now serves the doorbell
    assert.equal(m4.guards[0].relationLabel, "port reports 3C:22:FB:12:34:56");
    // Mismatch while the expected id is live on another port: both said.
    const swapped = { states: { ...hass.states, "input_text.switch_port_3_mac": { state: "11:22:33:44:55:66", attributes: {} }, "sensor.p5": { state: "3c:22:fb:12:34:56", attributes: {} } } };
    assert.equal(rows(swapped)[0].guards[0].relationLabel, "port reports 11:22:33:44:55:66 · now on p5");
  });

  test("without expected_norm (older backend) the core normalises", () => {
    const [p4] = poePortRows({ ports: [payload.ports[1]] }, hass, "en", { mapping: true });
    assert.equal(p4.guards[0].expectedNorm, "aa-bb-cc-dd-ee-ff");
  });

  test("without the opt-in: the old row shape", () => {
    const [p3] = poePortRows(payload, hass, "en");
    assert.equal(p3.idOrigin, undefined);
    assert.equal(p3.idNorm, undefined);
    assert.deepEqual(Object.keys(p3.guards[0]).sort(), ["expectedId", "match", "name", "state", "statusEntity"]);
  });
});
