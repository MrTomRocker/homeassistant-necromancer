// Opt-in core logic for the recovery popup (the actor chip): recoveryTarget,
// actorTitle, recoveryModel from the status sensor's static `driver_*`
// attributes plus the `necromancer/guard/recovery` WS answer; the new
// guardInfo fields (targetEntity, scriptEntity, driverSteps);
// footerEvent's opt-in past wording; loadGuardRecovery's WS call.
// Run with `node --test tests/frontend/*.test.mjs`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIRM_ACTIONS,
  I18N,
  TONE_COLORS,
  actorTitle,
  footerEvent,
  guardInfo,
  recoveryModel,
  recoveryTarget,
  serviceFor,
} from "../../custom_components/necromancer/frontend/necromancer-core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

function guard(id, attrs, state = "ok") {
  return {
    entity_id: `sensor.${id}_status`,
    state,
    last_changed: ago(3600),
    attributes: {
      guard_name: id,
      health_type: "entity_state",
      health_entity: `binary_sensor.${id}_health`,
      auto_recovery_entity: `switch.${id}_auto_recovery`,
      revive_entity: `button.${id}_revive`,
      recovery_event_entity: `event.${id}_recovery`,
      recover_count: 0,
      fail_count: 0,
      ...attrs,
    },
  };
}

function hassWith(so, extra = {}, more = {}) {
  return {
    states: {
      [so.entity_id]: so,
      [so.attributes.auto_recovery_entity]: { entity_id: so.attributes.auto_recovery_entity, state: "on", attributes: {} },
      ...extra,
    },
    entities: more.entities || {},
    devices: more.devices || {},
  };
}

const SWITCH = guard("pool", { driver_type: "switch", driver_entity: "switch.pool_plug", driver_steps: null, driver_port_expected_id: null });
const SCRIPT = guard("nas", { driver_type: "action", driver_entity: "script.reboot_nas", driver_steps: 1, driver_port_expected_id: null });
const STEPS = guard("router", { driver_type: "action", driver_entity: null, driver_steps: 3, driver_port_expected_id: null });
const CYCLE = guard("modem", { driver_type: "actions", driver_entity: null, driver_steps: 2, driver_port_expected_id: null });
const POE = guard("ap", { driver_type: "poe_port", driver_entity: null, driver_steps: null, driver_port_expected_id: "aa:bb:cc:00:11:22" });
const NOTIFY = {
  entity_id: "sensor.watch_status",
  state: "ok",
  attributes: { guard_name: "watch", driver_type: "notify", revive_entity: null, auto_recovery_entity: null, health_type: "entity_state" },
};

const PORT5 = {
  label: "5",
  actuator: "switch.usw_port_5_poe",
  actuator_state: "on",
  id_source: "entity",
  id_entity: "sensor.usw_port_5_lldp",
  id_attribute: "mac",
  id_static: null,
  id: "AA:BB:CC:00:11:22",
  id_norm: "aa:bb:cc:00:11:22",
  status_entity: "binary_sensor.usw_port_5_link",
  status_attribute: null,
  status_state: "on",
  status_on: ["on"],
  status_off: ["off"],
  fabric_status: "good",
  last_cycle: null,
};

function poeWs(over = {}) {
  const port = over.port === undefined ? PORT5 : over.port;
  return {
    type: "poe_port",
    can_recover: true,
    expected_id: "aa:bb:cc:00:11:22",
    expected_norm: "aa:bb:cc:00:11:22",
    match: "live",
    port_label: port ? port.label : null,
    port_labels: port ? [port.label] : [],
    actuator: port ? port.actuator : null,
    actuator_name: port ? "USW Port 5 PoE" : null,
    target_entity: port ? port.actuator : null,
    fabric_status: port ? port.fabric_status : null,
    last_cycle: port ? port.last_cycle : null,
    script_entity: null,
    steps: null,
    ...over,
    port,
  };
}

const USW = {
  entities: { "switch.usw_port_5_poe": { entity_id: "switch.usw_port_5_poe", device_id: "dev1" } },
  devices: { dev1: { name: "USW-24", name_by_user: null } },
};

const row = (m, id) => m.rows.find((r) => r.id === id);

describe("guardInfo: static recovery fields", () => {
  test("targetEntity/scriptEntity/driverSteps/expectedId", () => {
    const sw = guardInfo(SWITCH);
    assert.equal(sw.targetEntity, "switch.pool_plug");
    assert.equal(sw.scriptEntity, null);
    const sc = guardInfo(SCRIPT);
    assert.equal(sc.targetEntity, "script.reboot_nas");
    assert.equal(sc.scriptEntity, "script.reboot_nas");
    assert.equal(sc.driverSteps, 1);
    assert.equal(guardInfo(STEPS).driverSteps, 3);
    assert.equal(guardInfo(POE).expectedId, "aa:bb:cc:00:11:22");
    assert.equal(guardInfo(POE).driverSteps, null);
    // An older backend without the attributes.
    const old = guardInfo(guard("x", { driver_type: "action" }));
    assert.equal(old.driverSteps, null);
    assert.equal(old.expectedId, null);
    assert.equal(old.scriptEntity, null);
  });
});

describe("recoveryTarget / actorTitle", () => {
  test("switch: the switch's friendly name, linked", () => {
    const hass = hassWith(SWITCH, { "switch.pool_plug": { state: "on", attributes: { friendly_name: "Pool plug" } } });
    const tg = recoveryTarget(guardInfo(SWITCH), hass, "en");
    assert.deepEqual(tg, { kind: "switch", kindLabel: "Switch", icon: "mdi:power-plug", label: "Pool plug", entity: "switch.pool_plug" });
    assert.equal(actorTitle(guardInfo(SWITCH), hass, "en"), "Recovery: Pool plug");
    assert.equal(actorTitle(guardInfo(SWITCH), hass, "de"), "Reparatur: Pool plug");
  });

  test("switch without a state: the entity id", () => {
    assert.equal(recoveryTarget(guardInfo(SWITCH), hassWith(SWITCH), "en").label, "switch.pool_plug");
  });

  test("one script: the script, linked; several steps: Action (n steps), no link", () => {
    const hass = hassWith(SCRIPT, { "script.reboot_nas": { state: "off", attributes: { friendly_name: "Reboot NAS" } } });
    const tg = recoveryTarget(guardInfo(SCRIPT), hass, "en");
    assert.equal(tg.kind, "script");
    assert.equal(tg.kindLabel, "Script");
    assert.equal(tg.label, "Reboot NAS");
    assert.equal(tg.entity, "script.reboot_nas");
    assert.equal(tg.icon, "mdi:script-text-play");
    const st = recoveryTarget(guardInfo(STEPS), hassWith(STEPS), "en");
    assert.deepEqual([st.kind, st.label, st.entity], ["action", "Action (3 steps)", null]);
    assert.equal(recoveryTarget(guardInfo(STEPS), hassWith(STEPS), "de").label, "Aktion (3 Schritte)");
    const one = guard("one", { driver_type: "action", driver_steps: 1 });
    assert.equal(recoveryTarget(guardInfo(one), hassWith(one), "en").label, "Action (1 step)");
    const cy = recoveryTarget(guardInfo(CYCLE), hassWith(CYCLE), "en");
    assert.deepEqual([cy.kind, cy.label, cy.entity], ["actions", "Off/on actions (2 steps)", null]);
  });

  test("PoE without the WS answer: the expected id; with it: port on the switch device", () => {
    const info = guardInfo(POE);
    assert.equal(recoveryTarget(info, hassWith(POE), "en").label, "PoE port for AA:BB:CC:00:11:22");
    assert.equal(actorTitle(info, hassWith(POE), "de"), "Reparatur: PoE-Port für AA:BB:CC:00:11:22");
    const tg = recoveryTarget(info, hassWith(POE, {}, USW), "en", poeWs());
    assert.deepEqual([tg.kind, tg.label, tg.entity, tg.icon], ["poe_port", "Port 5 on USW-24", "switch.usw_port_5_poe", "mdi:ethernet"]);
    assert.equal(recoveryTarget(info, hassWith(POE, {}, USW), "de", poeWs()).label, "Port 5 an USW-24");
    // No device: the actuator's name from the answer; it already names the
    // port, so it stands alone ("Port 5 on USW Port 5 PoE" said it twice).
    assert.equal(recoveryTarget(info, hassWith(POE), "en", poeWs()).label, "USW Port 5 PoE");
    const bell = poeWs({ port: { ...PORT5, label: "Port 3 · Doorbell" }, actuator_name: "Port 3 Doorbell PoE" });
    assert.equal(recoveryTarget(info, hassWith(POE), "en", bell).label, "Port 3 Doorbell PoE");
    assert.equal(actorTitle(info, hassWith(POE), "de", bell), "Reparatur: Port 3 Doorbell PoE");
    // The name alone carries the port only by its words: the port follows as
    // a muted line (sub), so the popup always says which port.
    assert.equal(recoveryTarget(info, hassWith(POE), "en", bell).sub, "Port 3 · Doorbell");
    assert.equal(recoveryTarget(info, hassWith(POE), "en", poeWs()).sub, "Port 5");
    const mt = recoveryModel(info, bell, hassWith(POE), "en", { now: Date.parse("2026-11-22T12:00:00Z") }).rows.find((r) => r.id === "target");
    assert.deepEqual([mt.value, mt.sub, mt.subTone, mt.tone], ["Port 3 Doorbell PoE", "Port 3 · Doorbell", "idle", "neutral"]);
    // "Port 5 on USW-24" already says it: no second line.
    assert.equal(recoveryTarget(info, hassWith(POE, {}, USW), "en", poeWs()).sub, undefined);
    // Words in a row, not loose ones: "Port 3" is not in "Port 13 switch".
    const p13 = poeWs({ port: { ...PORT5, label: "3" }, actuator_name: "Port 13 switch" });
    assert.equal(recoveryTarget(info, hassWith(POE), "en", p13).label, "Port 3 on Port 13 switch");
    // A non-admin without read access to the actuator: just the port.
    const hidden = poeWs({ actuator: null, actuator_name: null, target_entity: null });
    assert.deepEqual([recoveryTarget(info, hassWith(POE), "en", hidden).label, recoveryTarget(info, hassWith(POE), "en", hidden).entity], ["Port 5", null]);
  });

  test("PoE ambiguous / none / error", () => {
    const info = guardInfo(POE);
    const amb = poeWs({ match: "ambiguous", port: null, port_labels: ["5", "Uplink"] });
    assert.equal(recoveryTarget(info, hassWith(POE), "en", amb).label, "Port 5 or Uplink");
    assert.equal(recoveryTarget(info, hassWith(POE), "en", poeWs({ match: "none", port: null })).label, "No port found");
    assert.equal(recoveryTarget(info, hassWith(POE), "en", { error: "x" }).label, "PoE port for AA:BB:CC:00:11:22");
  });

  test("notify-only", () => {
    const tg = recoveryTarget(guardInfo(NOTIFY), { states: {} }, "en");
    assert.deepEqual([tg.kind, tg.label, tg.entity], ["notify", "Notify only — no repair", null]);
  });
});

describe("recoveryModel", () => {
  test("switch: target, last repair, counters, auto, repair", () => {
    const so = guard("pool", { ...SWITCH.attributes, recover_count: 4, fail_count: 1, last_recover: ago(3 * 86400), last_fail: ago(5 * 86400) });
    const hass = hassWith(so, { "switch.pool_plug": { state: "on", attributes: { friendly_name: "Pool plug" } } });
    const m = recoveryModel(guardInfo(so), null, hass, "en", { now: NOW });
    assert.equal(m.title, "Recovery");
    assert.equal(m.tooltip, "Recovery: Pool plug");
    assert.equal(m.loading, false, "a switch needs no WS answer");
    assert.deepEqual(
      m.rows.map((r) => r.id),
      ["target", "last_repair", "repairs"],
    );
    assert.deepEqual(row(m, "target"), { id: "target", icon: "mdi:power-plug", label: "Switch", value: "Pool plug", tone: "neutral", entity: "switch.pool_plug" });
    assert.deepEqual([row(m, "last_repair").value, row(m, "last_repair").tone], ["3 d ago · succeeded", "good"]);
    assert.deepEqual([row(m, "repairs").value, row(m, "repairs").tone], ["4 succeeded · 1 failed", "warn"]);
    assert.deepEqual(m.auto, { entity: "switch.pool_auto_recovery", on: true, label: "Auto-recovery", confirmOff: "Turn auto-recovery off? Problems are then only reported." });
    assert.deepEqual(m.repair, { action: "revive", label: "Repair now", enabled: true, reason: null, reasonKey: null });
    // The pill is Revive: same service, same confirm.
    assert.ok(CONFIRM_ACTIONS.has(m.repair.action));
    assert.deepEqual(serviceFor(m.repair.action, guardInfo(so)), ["button", "press", {}, { entity_id: "button.pool_revive" }]);
    // No row offers anything but a link.
    for (const r of m.rows) assert.ok(r.entity === null || r.entity === "switch.pool_plug");
    for (const r of m.rows) assert.ok(r.tone in TONE_COLORS, r.tone);
  });

  test("a newer failure wins the last-repair row; never repaired says Never", () => {
    const so = guard("pool", { ...SWITCH.attributes, last_recover: ago(5 * 86400), last_fail: ago(2 * 3600), fail_count: 2 });
    const m = recoveryModel(guardInfo(so), null, hassWith(so), "de", { now: NOW });
    assert.deepEqual([row(m, "last_repair").value, row(m, "last_repair").tone], ["vor 2 h · fehlgeschlagen", "bad"]);
    assert.equal(row(m, "repairs").value, "0 erfolgreich · 2 fehlgeschlagen");
    const fresh = recoveryModel(guardInfo(SWITCH), null, hassWith(SWITCH), "en", { now: NOW });
    assert.deepEqual([row(fresh, "last_repair").value, row(fresh, "last_repair").tone], ["Never", "idle"]);
    assert.equal(row(fresh, "repairs").tone, "idle");
  });

  test("auto switch off; no auto entity -> no auto row", () => {
    const hass = hassWith(SWITCH);
    hass.states["switch.pool_auto_recovery"].state = "off";
    assert.equal(recoveryModel(guardInfo(SWITCH), null, hass, "en").auto.on, false);
    const noAuto = guard("x", { ...SWITCH.attributes, auto_recovery_entity: null });
    assert.equal(recoveryModel(guardInfo(noAuto), null, hassWith(noAuto), "en").auto, null);
  });

  test("repair disabled with a reason: busy, snoozed, unavailable", () => {
    const cases = [
      ["recovering", "A repair is running …"],
      ["verify", "A repair is running …"],
      ["snoozed", "Snoozed — wake it up first"],
      ["unavailable", "Guard unavailable"],
    ];
    for (const [state, reason] of cases) {
      const so = guard("pool", SWITCH.attributes, state);
      const m = recoveryModel(guardInfo(so), null, hassWith(so), "en");
      assert.equal(m.repair.enabled, false, state);
      assert.equal(m.repair.reason, reason, state);
    }
    const esc = guard("pool", SWITCH.attributes, "escalated");
    assert.equal(recoveryModel(guardInfo(esc), null, hassWith(esc), "en").repair.enabled, true);
    const de = guard("pool", SWITCH.attributes, "snoozed");
    assert.equal(recoveryModel(guardInfo(de), null, hassWith(de), "de").repair.reason, "Schlummert — erst aufwecken");
  });

  test("notify-only: a notice, no rows, no auto, no repair", () => {
    const m = recoveryModel(guardInfo(NOTIFY), null, { states: { "sensor.watch_status": NOTIFY } }, "en");
    assert.equal(m.notice, "Notify only — no repair");
    assert.equal(m.canRecover, false);
    assert.deepEqual(m.rows, []);
    assert.equal(m.auto, null);
    assert.equal(m.repair, null);
    assert.equal(recoveryModel(guardInfo(NOTIFY), null, { states: {} }, "de").notice, "Nur melden — keine Reparatur");
  });

  test("script and steps", () => {
    const hass = hassWith(SCRIPT, { "script.reboot_nas": { state: "off", attributes: { friendly_name: "Reboot NAS" } } });
    const m = recoveryModel(guardInfo(SCRIPT), null, hass, "en");
    assert.deepEqual([row(m, "target").label, row(m, "target").value, row(m, "target").entity], ["Script", "Reboot NAS", "script.reboot_nas"]);
    const s = recoveryModel(guardInfo(STEPS), null, hassWith(STEPS), "en");
    assert.deepEqual([row(s, "target").label, row(s, "target").value, row(s, "target").entity], ["Action", "Action (3 steps)", null]);
  });

  test("PoE loading and error", () => {
    const loading = recoveryModel(guardInfo(POE), null, hassWith(POE), "en");
    assert.equal(loading.loading, true);
    assert.deepEqual([row(loading, "device").value, row(loading, "device").sub], ["AA:BB:CC:00:11:22", "Looking up the port …"]);
    assert.equal(row(loading, "port_status"), undefined);
    const err = recoveryModel(guardInfo(POE), { error: "unauthorized" }, hassWith(POE), "en");
    assert.equal(err.loading, false);
    assert.equal(row(err, "device").sub, "Port lookup not available");
    assert.equal(err.repair.enabled, true, "the lookup failing blocks nothing");
  });

  test("PoE live by entity: found via, port status from hass, last restart", () => {
    const ws = poeWs({ last_cycle: { time: ago(7200), ok: true } });
    const hass = hassWith(POE, {
      "switch.usw_port_5_poe": { state: "on", attributes: { friendly_name: "USW Port 5 PoE" } },
      "binary_sensor.usw_port_5_link": { state: "on", attributes: {} },
    }, USW);
    const m = recoveryModel(guardInfo(POE), ws, hass, "en", { now: NOW });
    assert.deepEqual(m.rows.map((r) => r.id), ["target", "device", "port_status", "last_restart", "last_repair", "repairs"]);
    assert.deepEqual([row(m, "target").label, row(m, "target").value, row(m, "target").entity], ["PoE port", "Port 5 on USW-24", "switch.usw_port_5_poe"]);
    const dev = row(m, "device");
    assert.deepEqual([dev.value, dev.sub, dev.tone], ["AA:BB:CC:00:11:22", "live · from sensor.usw_port_5_lldp.mac", "good"]);
    assert.deepEqual([row(m, "port_status").value, row(m, "port_status").tone], ["Ready", "good"]);
    assert.deepEqual([row(m, "last_restart").label, row(m, "last_restart").value, row(m, "last_restart").tone], ["Last restart", "2 h ago · succeeded", "good"]);
    assert.equal(m.repair.enabled, true);

    // The actuator turns off live: the port row follows hass, not the snapshot.
    hass.states["switch.usw_port_5_poe"].state = "off";
    assert.deepEqual([row(recoveryModel(guardInfo(POE), ws, hass, "en"), "port_status").value, row(recoveryModel(guardInfo(POE), ws, hass, "en"), "port_status").tone], ["Powered off", "bad"]);
  });

  test("PoE status a non-admin cannot see: never 'Ready'", () => {
    // The status entity blanked (`hidden`): the admin may see "Device offline".
    const port = { ...PORT5, status_entity: null, status_state: null };
    const blank = poeWs({ match: "last_known", port, hidden: ["port.status_entity"] });
    const m = recoveryModel(guardInfo(POE), blank, hassWith(POE), "en");
    assert.deepEqual([row(m, "port_status").value, row(m, "port_status").tone, row(m, "port_status").icon], ["Status not visible", "idle", "mdi:eye-off-outline"]);
    assert.equal(row(recoveryModel(guardInfo(POE), blank, hassWith(POE), "de"), "port_status").value, "Status nicht sichtbar");
    // The switch blanked and no status to say "online": not visible either.
    const noAct = { ...PORT5, actuator: null, actuator_state: null, status_entity: null, status_state: null };
    const a = recoveryModel(guardInfo(POE), poeWs({ port: noAct, hidden: ["actuator", "port.actuator"] }), hassWith(POE), "en");
    assert.equal(row(a, "port_status").value, "Status not visible");
    // The switch blanked but the status says online: that is visible, and true.
    const online = recoveryModel(guardInfo(POE), poeWs({ port: { ...PORT5, actuator: null, actuator_state: null }, hidden: ["port.actuator"] }), hassWith(POE), "en");
    assert.deepEqual([row(online, "port_status").value, row(online, "port_status").tone], ["Ready", "good"]);
    // What the fabric itself says still shows.
    const busy = poeWs({ port: { ...port, fabric_status: "recovering" }, fabric_status: "recovering", hidden: ["port.status_entity"] });
    assert.equal(row(recoveryModel(guardInfo(POE), busy, hassWith(POE), "en"), "port_status").value, "Restarting …");
    // Not configured (nothing hidden): the old wording.
    const none = poeWs({ port, hidden: [] });
    assert.equal(row(recoveryModel(guardInfo(POE), none, hassWith(POE), "en"), "port_status").value, "Ready");
  });

  test("PoE fixed id, last known, restarting port", () => {
    const fixed = poeWs({ port: { ...PORT5, id_source: "static", id_entity: null, id_static: "AP-1", id: "AP-1" } });
    assert.deepEqual([row(recoveryModel(guardInfo(POE), fixed, hassWith(POE), "en"), "device").sub], ["Fixed id"]);

    const lk = poeWs({ match: "last_known", port: { ...PORT5, id: "-", id_norm: null } });
    const m = recoveryModel(guardInfo(POE), lk, hassWith(POE), "de");
    assert.deepEqual([row(m, "device").sub, row(m, "device").tone], ["zuletzt bekannter Port · gerade nichts angeschlossen", "warn"]);
    assert.equal(m.repair.enabled, true, "the fabric cycles a last-known port");

    const busy = poeWs({ fabric_status: "recovering", port: { ...PORT5, fabric_status: "recovering" } });
    const b = recoveryModel(guardInfo(POE), busy, hassWith(POE), "en");
    assert.deepEqual([row(b, "port_status").value, row(b, "port_status").tone], ["Restarting …", "active"]);
    assert.deepEqual([b.repair.enabled, b.repair.reason], [false, "The port is restarting …"]);
  });

  test("PoE mismatch / ambiguous / none block the repair", () => {
    const mm = recoveryModel(guardInfo(POE), poeWs({ match: "mismatch", port: { ...PORT5, id: "3c22fb123456", id_norm: "3c22fb123456" } }), hassWith(POE), "en");
    assert.deepEqual([row(mm, "device").sub, row(mm, "device").tone], ["port now reports 3C:22:FB:12:34:56 · repair blocked", "bad"]);
    assert.deepEqual([mm.repair.enabled, mm.repair.reason], [false, "No unique port — a repair would be blocked"]);

    const amb = recoveryModel(guardInfo(POE), poeWs({ match: "ambiguous", port: null, port_labels: ["5", "6"] }), hassWith(POE), "en");
    assert.equal(row(amb, "device").sub, "ambiguous · id on several ports");
    assert.equal(row(amb, "port_status"), undefined);
    assert.equal(amb.repair.enabled, false);

    const none = recoveryModel(guardInfo(POE), poeWs({ match: "none", port: null }), hassWith(POE), "en");
    assert.equal(row(none, "device").sub, "no port reports this id · repair blocked");
    assert.equal(none.repair.reasonKey, "rec.blocked");
  });
});

describe("footerEvent: opt-in past wording", () => {
  const evState = (type, at, attrs = {}) => ({ state: at, attributes: { event_type: type, ...attrs } });

  test("an escalation before the current state is history, muted", () => {
    const so = guard("pool", { state_since: ago(10 * 86400) });
    const states = { [so.entity_id]: so, "event.pool_recovery": evState("escalated", ago(150 * 86400), { attempt: 2 }) };
    const info = guardInfo(so);
    const plain = footerEvent(info, states, so.attributes, NOW, "en");
    assert.equal(plain.text, "Escalated · 2 attempts · 150 d ago", "without the opt-in nothing changes");
    assert.equal(plain.tone, "bad");
    const past = footerEvent(info, states, so.attributes, NOW, "en", { past: true });
    assert.deepEqual(past, { icon: "mdi:close-octagon", tone: "idle", text: "Last escalation 150 d ago · 2 attempts", age: 150 * 86400, past: true });
    assert.equal(footerEvent(info, states, so.attributes, NOW, "de", { past: true }).text, "Letzte Eskalation vor 150 Tg. · 2 Versuche");
  });

  test("blocked repair from before; a current escalation keeps its words", () => {
    const so = guard("pool", { state_since: ago(3600) });
    const states = { [so.entity_id]: so, "event.pool_recovery": evState("blocked", ago(86400), { reason: "x" }) };
    assert.equal(footerEvent(guardInfo(so), states, so.attributes, NOW, "en", { past: true }).text, "Last blocked repair 1 d ago");

    const esc = guard("pool", { state_since: ago(7200) }, "escalated");
    const st2 = { [esc.entity_id]: esc, "event.pool_recovery": evState("escalated", ago(7199), { attempt: 1 }) };
    assert.equal(footerEvent(guardInfo(esc), st2, esc.attributes, NOW, "en", { past: true }).text, "Escalated · 1 attempt · 1 h ago");
  });

  test("an event after the state start, and a success, stay as they are", () => {
    const so = guard("pool", { state_since: ago(86400) }, "suspect");
    const states = { [so.entity_id]: so, "event.pool_recovery": evState("escalated", ago(600), { attempt: 2 }) };
    assert.equal(footerEvent(guardInfo(so), states, so.attributes, NOW, "en", { past: true }).text, "Escalated · 2 attempts · 10 min ago");
    const ok = guard("pool", { state_since: ago(60) });
    const st2 = { [ok.entity_id]: ok, "event.pool_recovery": evState("recovered", ago(3600)) };
    assert.equal(footerEvent(guardInfo(ok), st2, ok.attributes, NOW, "en", { past: true }).text, "Recovery succeeded · 1 h ago");
  });

  test("falls back to last_changed without state_since", () => {
    const so = guard("pool", {}); // last_changed 1 h ago
    const states = { [so.entity_id]: so, "event.pool_recovery": evState("escalated", ago(2 * 3600)) };
    assert.equal(footerEvent(guardInfo(so), states, so.attributes, NOW, "en", { past: true }).text, "Last escalation 2 h ago");
  });
});

describe("i18n and WS loader", () => {
  test("every new key exists in en and de", () => {
    const keys = Object.keys(I18N.en).filter((k) => k.startsWith("rec.") || k.startsWith("event.last_") || k === "chip.auto_off_short");
    assert.ok(keys.length > 30);
    for (const k of keys) assert.ok(I18N.de[k], k);
    assert.equal(I18N.en["chip.auto_off_short"], "Auto off");
    assert.equal(I18N.de["chip.auto_off_short"], "Auto aus");
  });

  test("loadGuardRecovery asks necromancer/guard/recovery for the entity", async () => {
    globalThis.window = globalThis.window || globalThis;
    const actions = await import("../../custom_components/necromancer/frontend/necromancer-actions.js");
    const calls = [];
    const hass = { callWS: async (msg) => (calls.push(msg), { type: "switch" }) };
    assert.deepEqual(await actions.loadGuardRecovery(hass, "sensor.pool_status"), { type: "switch" });
    assert.deepEqual(calls, [{ type: "necromancer/guard/recovery", entity_id: "sensor.pool_status" }]);
  });
});
