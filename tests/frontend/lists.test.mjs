// Logic tests for the guard lists and the PoE rows (necromancer-core.js):
// discovery, filter, sort, counts, isUnfiltered, poePortRows.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_STATES,
  GUARD_STATES,
  SORT_MODES,
  attentionCount,
  configEntities,
  countByState,
  createGuardDiscovery,
  discoverGuards,
  filterGuards,
  guardArea,
  guardLabels,
  isProblem,
  isQuiet,
  isUnfiltered,
  lastActivity,
  needsAttention,
  normalizePortId,
  normalizeState,
  poePortRows,
  sortGuards,
  stateRank,
} from "../../custom_components/necromancer/frontend/necromancer-core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

function guard(slug, state, attrs = {}, lastChanged = 3600) {
  return {
    entity_id: `sensor.${slug}_status`,
    state,
    last_changed: ago(lastChanged),
    attributes: {
      guard_name: attrs.name || slug,
      health_type: "entity_state",
      health_entity: `binary_sensor.${slug}_health`,
      revive_entity: `button.${slug}_recover`,
      auto_recovery_entity: `switch.${slug}_auto`,
      driver_type: "switch",
      ...attrs,
    },
  };
}

const reg = (extra = {}) => ({ platform: "necromancer", translation_key: "status", ...extra });

function hassWith(guards, { entities = null, devices = {}, areas = {}, labels = undefined, extraStates = {} } = {}) {
  const states = { ...extraStates };
  for (const g of guards) states[g.entity_id] = g;
  const ents =
    entities ??
    Object.fromEntries(guards.map((g) => [g.entity_id, reg()]));
  return { states, entities: ents, devices, areas, ...(labels ? { labels } : {}) };
}

describe("discovery", () => {
  test("from the entity registry: platform + translation key, sorted", () => {
    const hass = hassWith([guard("b", "ok"), guard("a", "ok")], {
      entities: {
        "sensor.b_status": reg(),
        "sensor.a_status": reg(),
        "sensor.a_last_heartbeat": reg({ translation_key: "last_heartbeat" }),
        "sensor.other": { platform: "mqtt", translation_key: "status" },
      },
    });
    assert.deepEqual(discoverGuards(hass), ["sensor.a_status", "sensor.b_status"]);
  });

  test("without a registry: states that carry the status attributes", () => {
    const hass = { states: { "sensor.x_status": guard("x", "ok"), "sensor.temp": { state: "3", attributes: {} } } };
    assert.deepEqual(discoverGuards(hass), ["sensor.x_status"]);
    assert.deepEqual(discoverGuards(null), []);
  });

  test("memoised on the identity of hass.entities", () => {
    const discover = createGuardDiscovery();
    const entities = { "sensor.a_status": reg() };
    const first = discover({ entities, states: {} });
    assert.equal(discover({ entities, states: { other: {} } }), first); // same array: no rescan
    const next = discover({ entities: { ...entities, "sensor.b_status": reg() }, states: {} });
    assert.deepEqual(next, ["sensor.a_status", "sensor.b_status"]);
  });
});

describe("states", () => {
  test("normalize, rank, problem, quiet", () => {
    assert.equal(normalizeState("unknown"), "unavailable");
    assert.equal(normalizeState(undefined), "unavailable");
    assert.ok(stateRank("escalated") < stateRank("suspect"));
    assert.ok(stateRank("blind") < stateRank("snoozed"));
    assert.equal(stateRank("ok"), stateRank("cooldown"));
    for (const s of ["escalated", "suspect", "recovering", "verify", "blind", "unavailable", "unknown", undefined]) assert.ok(isProblem(s), String(s));
    for (const s of ["ok", "cooldown", "snoozed"]) assert.ok(!isProblem(s), s);
    assert.ok(isQuiet("ok") && isQuiet("cooldown") && !isQuiet("snoozed"));
    assert.deepEqual([...GUARD_STATES].sort(), ["blind", "cooldown", "escalated", "ok", "recovering", "snoozed", "suspect", "verify"]);
    assert.deepEqual(SORT_MODES, ["problems", "name", "state", "last_activity"]);
  });
});

describe("filter", () => {
  const guards = [
    guard("hb", "escalated", { health_type: "heartbeat", revive_entity: null, driver_type: "notify", name: "Nightly Backup" }),
    guard("plug", "ok", { name: "Office Plug" }),
    guard("note", "suspect", { revive_entity: null, driver_type: "notify", name: "Sensor" }),
    guard("cam", "blind", { driver_type: "poe_port", name: "Camera" }),
  ];
  const hass = hassWith(guards, {
    entities: {
      "sensor.hb_status": reg({ area_id: "office", labels: ["critical"] }),
      "sensor.plug_status": reg({ device_id: "dev_plug" }),
      "sensor.note_status": reg(),
      "sensor.cam_status": reg({ device_id: "dev_cam" }),
    },
    devices: { dev_plug: { area_id: "office" }, dev_cam: { area_id: "garage", labels: ["critical", "poe"] } },
    areas: { office: { area_id: "office", name: "Büro" }, garage: { area_id: "garage", name: "Garage" } },
    labels: { critical: { name: "Kritisch" } },
  });
  const all = discoverGuards(hass);

  test("no filter: everything", () => {
    assert.deepEqual(filterGuards(all, hass, {}), all);
  });

  test("states, types (one value or a list)", () => {
    assert.deepEqual(filterGuards(all, hass, { filter: { states: ["escalated", "blind"] } }), ["sensor.cam_status", "sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { states: "suspect" } }), ["sensor.note_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { types: ["heartbeat"] } }), ["sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { types: "notify" } }), ["sensor.note_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { types: "recovery" } }), ["sensor.cam_status", "sensor.plug_status"]);
  });

  test("area by id or name, the entity's own or its device's", () => {
    assert.deepEqual(filterGuards(all, hass, { filter: { area: "office" } }), ["sensor.hb_status", "sensor.plug_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { area: "büro" } }), ["sensor.hb_status", "sensor.plug_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { area: ["Garage"] } }), ["sensor.cam_status"]);
    assert.equal(guardArea("sensor.note_status", hass), null);
  });

  test("label by id or name, entity plus device labels", () => {
    assert.deepEqual(guardLabels("sensor.cam_status", hass), ["critical", "poe"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { label: "critical" } }), ["sensor.cam_status", "sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { label: "Kritisch" } }), ["sensor.cam_status", "sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { label: "poe" } }), ["sensor.cam_status"]);
  });

  test("keys combine with AND", () => {
    assert.deepEqual(filterGuards(all, hass, { filter: { area: "office", types: "heartbeat" } }), ["sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, { filter: { area: "garage", states: "ok" } }), []);
  });

  test("explicit list wins over discovery, keeps its order, drops duplicates", () => {
    const config = { entities: ["sensor.plug_status", { entity: "sensor.hb_status" }, "sensor.plug_status"] };
    assert.deepEqual(configEntities(config), ["sensor.plug_status", "sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, config), ["sensor.plug_status", "sensor.hb_status"]);
  });

  test("view: chip state and search (name or id)", () => {
    assert.deepEqual(filterGuards(all, hass, {}, { state: "escalated" }), ["sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, {}, { search: "nightly" }), ["sensor.hb_status"]);
    assert.deepEqual(filterGuards(all, hass, {}, { search: "CAM_st" }), ["sensor.cam_status"]);
  });

  test("a missing status entity counts as unavailable", () => {
    const h = hassWith([], { entities: { "sensor.gone_status": reg() } });
    assert.deepEqual(filterGuards(["sensor.gone_status"], h, { filter: { states: "unavailable" } }), ["sensor.gone_status"]);
  });
});

describe("isUnfiltered (bulk actions only then)", () => {
  test("cases", () => {
    assert.equal(isUnfiltered({}), true);
    assert.equal(isUnfiltered(undefined), true);
    assert.equal(isUnfiltered({ title: "x", sort: "name", filter: {} }), true);
    assert.equal(isUnfiltered({ filter: { states: [], label: "" } }), true);
    assert.equal(isUnfiltered({ filter: { states: ["ok"] } }), false);
    assert.equal(isUnfiltered({ filter: { types: "heartbeat" } }), false);
    assert.equal(isUnfiltered({ filter: { area: "office" } }), false);
    assert.equal(isUnfiltered({ filter: { label: "x" } }), false);
    assert.equal(isUnfiltered({ entities: ["sensor.a_status"] }), false);
    assert.equal(isUnfiltered({ entities: [] }), true);
  });
});

describe("sort", () => {
  const guards = [
    guard("a", "ok", { name: "Alpha" }, 10),
    guard("b", "escalated", { name: "Bravo" }, 500),
    guard("c", "suspect", { name: "Charlie" }, 50),
    guard("d", "snoozed", { name: "Delta" }, 5),
    guard("e", "escalated", { name: "Echo" }, 100),
    guard("f", "cooldown", { name: "bulk 10" }, 1000),
    guard("g", "ok", { name: "Bulk 2" }, 2000),
    guard("h", "blind", { name: "Hotel" }, 20),
  ];
  const hass = hassWith(guards);
  const ids = discoverGuards(hass);
  const names = (list) => list.map((id) => hass.states[id].attributes.guard_name);

  test("problems first (most urgent, then name), the rest by name (default)", () => {
    assert.deepEqual(names(sortGuards(ids, hass)), ["Bravo", "Echo", "Charlie", "Hotel", "Alpha", "Bulk 2", "bulk 10", "Delta"]);
    assert.deepEqual(sortGuards(ids, hass, "problems"), sortGuards(ids, hass, "bogus"));
  });

  test("name: numeric, case-insensitive", () => {
    assert.deepEqual(names(sortGuards(ids, hass, "name")), ["Alpha", "Bravo", "Bulk 2", "bulk 10", "Charlie", "Delta", "Echo", "Hotel"]);
  });

  test("state: rank, then name", () => {
    assert.deepEqual(names(sortGuards(ids, hass, "state")), ["Bravo", "Echo", "Charlie", "Hotel", "Delta", "Alpha", "Bulk 2", "bulk 10"]);
  });

  test("last_activity: newest first; recover/fail/heartbeat times count", () => {
    const h = hassWith(
      [
        guard("x", "ok", { name: "X" }, 1000),
        guard("y", "ok", { name: "Y", last_recover: ago(1) }, 5000),
        guard("z", "ok", { name: "Z", health_type: "heartbeat", last_heartbeat_entity: "sensor.z_last_heartbeat" }, 9000),
      ],
      { extraStates: { "sensor.z_last_heartbeat": { state: ago(30), attributes: {} } } },
    );
    assert.equal(lastActivity("sensor.y_status", h), NOW - 1000);
    assert.equal(lastActivity("sensor.missing", h), null);
    assert.deepEqual(sortGuards(discoverGuards(h), h, "last_activity"), ["sensor.y_status", "sensor.z_status", "sensor.x_status"]);
  });

  test("does not mutate its input", () => {
    const copy = [...ids];
    sortGuards(ids, hass, "name");
    assert.deepEqual(ids, copy);
  });
});

describe("needs attention (one definition)", () => {
  test("escalated, suspect, recovering, verify, blind, unavailable count; snoozed, cooldown, ok do not", () => {
    assert.deepEqual([...ATTENTION_STATES], ["escalated", "suspect", "recovering", "verify", "blind", "unavailable"]);
    assert.ok(Object.isFrozen(ATTENTION_STATES));
    for (const s of GUARD_STATES) assert.equal(needsAttention(s), ATTENTION_STATES.includes(s), s);
    // Anything unknown is "unavailable": not running, so it needs a look.
    for (const s of ["unavailable", "unknown", "", null, undefined, "weird"]) assert.equal(needsAttention(s), true, String(s));
    // In the most-urgent-first order of the sort.
    const ranks = ATTENTION_STATES.map(stateRank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  test("attentionCount == countByState().attention == .problems", () => {
    const hass = hassWith(
      ["ok", "cooldown", "snoozed", "weird", "escalated", "suspect", "recovering", "verify", "blind"].map((s, i) => guard(`g${i}`, s)),
    );
    const ids = discoverGuards(hass);
    assert.equal(attentionCount(ids, hass), 6); // the five problem states + "weird" (unavailable)
    const c = countByState(ids, hass);
    assert.equal(c.attention, 6);
    assert.equal(c.problems, 6);
    assert.equal(attentionCount([], hass), 0);
    assert.equal(attentionCount(["sensor.missing_status"], hass), 1);
  });
});

describe("countByState", () => {
  test("per state, total, attention; unknown counts as unavailable", () => {
    const hass = hassWith([guard("a", "ok"), guard("b", "ok"), guard("c", "escalated"), guard("d", "snoozed"), guard("e", "weird")]);
    const c = countByState(discoverGuards(hass), hass);
    assert.equal(c.total, 5);
    assert.equal(c.ok, 2);
    assert.equal(c.escalated, 1);
    assert.equal(c.snoozed, 1);
    assert.equal(c.unavailable, 1);
    assert.equal(c.attention, 2); // escalated + unavailable; snoozed does not count
    assert.equal(c.problems, 2);
    assert.equal(c.suspect, 0);
    assert.deepEqual(countByState([], hass).total, 0);
  });
});

describe("PoE rows", () => {
  const payload = {
    entry_id: "e1",
    ports: [
      {
        label: "Port 5",
        actuator: "switch.port_5_poe",
        actuator_state: "on",
        id_source: "entity",
        id_entity: "sensor.port_5_lldp",
        id_attribute: null,
        id_static: null,
        id: "AA:BB",
        status_entity: "binary_sensor.port_5_link",
        status_attribute: null,
        status_state: "on",
        status_on: ["on"],
        status_off: ["off"],
        fabric_status: "good",
        last_cycle: { time: ago(7200), ok: true },
        guards: [{ name: "Office AP", status_entity: "sensor.office_ap_status", expected_id: "aa:bb", match: "live" }],
      },
      {
        label: "Port 6",
        actuator: "switch.port_6_poe",
        id_source: "static",
        id_static: "camera-garage",
        id: "camera-garage",
        status_entity: "binary_sensor.port_6_link",
        status_state: "off",
        status_on: ["on"],
        status_off: ["off"],
        fabric_status: "recovering",
        last_cycle: null,
        guards: [],
      },
      {
        label: "Port 7",
        actuator: "switch.port_7_poe",
        id_source: "entity",
        id_entity: "sensor.port_7_lldp",
        id: "-",
        status_entity: "sensor.port_7",
        status_state: "booting",
        status_on: ["up"],
        status_off: ["down"],
        fabric_status: "failed",
        last_cycle: { time: ago(60), ok: false },
        guards: [{ name: "Doorbell", status_entity: "sensor.doorbell_status", expected_id: "door-1", match: "last_known" }],
      },
      { label: "Port 8", actuator: "switch.p8", id_source: "conflict", id_static: "x", id_entity: "sensor.y", guards: [] },
    ],
  };

  test("snapshot only (no hass states)", () => {
    const [p5, p6, p7, p8] = poePortRows(payload, { states: {} });
    assert.equal(p5.label, "Port 5");
    assert.equal(p5.power, "on");
    assert.equal(p5.idValue, "AA:BB");
    assert.equal(p5.online, true);
    assert.equal(p5.tone, "good");
    assert.deepEqual(p5.status, { key: "poe.status.good", tone: "idle", label: "Ready" });
    assert.equal(p5.switch, "switch.port_5_poe"); // no live state: the entity id
    assert.equal(p5.switchDevice, null);
    assert.equal(p5.lastCycle.ok, true);
    assert.equal(p5.lastCycle.at.getTime(), NOW - 7200 * 1000);
    assert.equal(p5.repairId, "AA:BB");
    assert.equal(p5.canRepair, true);
    assert.deepEqual(p5.guards, [{ name: "Office AP", statusEntity: "sensor.office_ap_status", state: "unavailable", expectedId: "aa:bb", match: "live" }]);

    assert.equal(p6.idSource, "static");
    assert.equal(p6.idValue, "camera-garage");
    assert.equal(p6.busy, true);
    assert.equal(p6.tone, "active");
    assert.deepEqual(p6.status, { key: "poe.status.recovering", tone: "active", label: "Restarting …" });
    assert.equal(p6.canRepair, false); // busy
    assert.equal(p6.online, false);

    assert.equal(p7.idValue, null); // "-" = nothing connected
    assert.equal(p7.online, null); // "booting" is neither on nor off
    assert.equal(p7.tone, "bad"); // failed
    assert.equal(p7.status.key, "poe.status.failed");
    assert.equal(p7.repairId, "door-1"); // falls back to the guard's expected id
    assert.equal(p7.guards[0].match, "last_known");

    assert.equal(p8.idSource, "conflict");
    assert.equal(p8.repairId, null);
    assert.equal(p8.canRepair, false);
    // Actuator without a known state: never a positive "Ready".
    assert.deepEqual(p8.status, { key: "poe.status.unknown", tone: "idle", label: "Switch unavailable" });
  });

  test("one coherent status: powered off is never 'Ready'", () => {
    const port = (extra) => [{ label: "P", actuator: "switch.p", status_entity: "binary_sensor.l", status_on: ["on"], status_off: ["off"], ...extra }];
    const st = (actuator, link, fabric = "good", lang = "en") => {
      const states = {};
      if (actuator) states["switch.p"] = { state: actuator, attributes: { friendly_name: "USW Port 5 PoE" } };
      if (link) states["binary_sensor.l"] = { state: link, attributes: {} };
      const [r] = poePortRows(port({ fabric_status: fabric }), { states }, lang);
      return [r.status.label, r.status.tone, r.tone];
    };
    assert.deepEqual(st("off", "off"), ["Powered off", "bad", "bad"]);
    assert.deepEqual(st("off", "on"), ["Powered off", "bad", "bad"]);
    assert.deepEqual(st("off", "off", "good", "de"), ["Ausgeschaltet", "bad", "bad"]);
    assert.deepEqual(st("off", "off", "recovering"), ["Restarting …", "active", "active"]); // the cycle turns it off on purpose
    assert.deepEqual(st("on", "off", "failed"), ["Restart failed", "bad", "bad"]);
    assert.deepEqual(st("on", "off"), ["Device offline", "bad", "bad"]);
    assert.deepEqual(st("on", "on"), ["Ready", "idle", "good"]);
    assert.deepEqual(st("on", null), ["Ready", "idle", "idle"]);
    assert.deepEqual(st("unavailable", "on"), ["Switch unavailable", "idle", "idle"]);
  });

  test("switch: actuator friendly name and its device", () => {
    const hass = {
      states: { "switch.p": { state: "on", attributes: { friendly_name: "USW Port 5 PoE" } } },
      entities: { "switch.p": { device_id: "d1" } },
      devices: { d1: { name: "USW Pro 24", name_by_user: "Rack switch" } },
    };
    const [r] = poePortRows([{ label: "P", actuator: "switch.p" }], hass);
    assert.equal(r.switch, "USW Port 5 PoE");
    assert.equal(r.switchDevice, "Rack switch");
    const [none] = poePortRows([{ label: "Q" }], { states: {} });
    assert.equal(none.switch, null);
    assert.equal(none.status.key, "poe.status.good"); // no actuator configured: nothing to contradict
  });

  test("live hass values win over the snapshot", () => {
    const hass = {
      states: {
        "switch.port_5_poe": { state: "off", attributes: {} },
        "sensor.port_5_lldp": { state: "CC:DD", attributes: {} },
        "binary_sensor.port_5_link": { state: "off", attributes: {} },
        "sensor.office_ap_status": { state: "escalated", attributes: { guard_name: "Office Access Point" } },
      },
    };
    const [p5] = poePortRows(payload, hass);
    assert.equal(p5.power, "off");
    assert.equal(p5.idValue, "CC:DD");
    assert.equal(p5.repairId, "CC:DD");
    assert.equal(p5.online, false);
    assert.equal(p5.tone, "bad");
    assert.equal(p5.status.label, "Powered off");
    assert.equal(p5.guards[0].name, "Office Access Point");
    assert.equal(p5.guards[0].state, "escalated");
  });

  test("id from an attribute; a bare list payload; empty payloads", () => {
    const rows = poePortRows(
      [{ label: "P", id_source: "entity", id_entity: "sensor.n", id_attribute: "mac", status_entity: "sensor.n", status_attribute: "link", status_on: "up" }],
      { states: { "sensor.n": { state: "x", attributes: { mac: "11:22", link: "up" } } } },
    );
    assert.equal(rows[0].idValue, "11:22");
    assert.equal(rows[0].online, true);
    assert.deepEqual(poePortRows(null, {}), []);
    assert.deepEqual(poePortRows({ ports: [] }, {}), []);
  });

  test("normalizePortId matches the backend's placeholders", () => {
    for (const v of ["", " - ", "unknown", "Unavailable", "none", null, undefined]) assert.equal(normalizePortId(v), null, String(v));
    assert.equal(normalizePortId(" AA:BB "), "aa:bb");
  });
});
