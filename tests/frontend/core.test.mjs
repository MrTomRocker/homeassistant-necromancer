// Logic tests for the card core (design §12): run with `node --test tests/frontend/*.test.mjs`.
// No dependencies: node:test + node:assert only.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_ORDER,
  CONFIRM_ACTIONS,
  EDIT_PATH,
  SNOOZE_DURATIONS,
  actionLabel,
  actionsFor,
  actionsShown,
  MENU_TAIL,
  actorIcon,
  chipColor,
  chipEntities,
  chipSpecs,
  defaultIcon,
  entityTone,
  escapeHtml,
  findFirstGuard,
  footerEvent,
  formatClock,
  formatDuration,
  formatUntil,
  hassTimeZone,
  isMutedState,
  formatRelative,
  guardInfo,
  healthTone,
  langOf,
  mainValue,
  nextTickMs,
  relevantEntities,
  resolvePingUrl,
  serviceFor,
  stateColor,
  stateTextColor,
  statusLine,
  t,
  toneTextColor,
  versioned,
  I18N,
  SNOOZE_COLOR,
  TONE_COLORS,
  VERSION,
  VERSION_QUERY,
} from "../../custom_components/necromancer/frontend/necromancer-core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

const STATES = ["ok", "suspect", "blind", "recovering", "verify", "cooldown", "escalated", "snoozed"];

function status(id, attrs, state = "ok", extra = {}) {
  return {
    entity_id: `sensor.${id}_status`,
    state,
    attributes: {
      guard_name: id,
      health_entity: `binary_sensor.${id}_health`,
      auto_recovery_entity: `switch.${id}_auto_recovery`,
      revive_entity: `button.${id}_revive`,
      recovery_event_entity: `event.${id}_recovery`,
      recover_count: 3,
      fail_count: 1,
      health_type: "ping",
      ...attrs,
    },
    last_changed: ago(3 * 86400),
    ...extra,
  };
}

const HB = status("backup", {
  health_type: "heartbeat",
  driver_type: "notify",
  driver_entity: null,
  revive_entity: null,
  auto_recovery_entity: null,
  recovery_event_entity: null,
  last_heartbeat_entity: "sensor.backup_last_heartbeat",
  last_status: "ok",
});
const SWITCH = status("pool", { driver_type: "switch", driver_entity: "switch.pool_plug" });
const POE = status("ap", { driver_type: "poe_port", driver_entity: null });
const ACTION = status("nodered", { driver_type: "action", driver_entity: null });
const ACTIONS = status("tv", { driver_type: "actions", driver_entity: null });
const NOTIFY = status("nas", {
  driver_type: "notify",
  driver_entity: null,
  revive_entity: null,
  auto_recovery_entity: null,
  recovery_event_entity: null,
});
const HB_RECOVER = status("job", {
  health_type: "heartbeat",
  driver_type: "action",
  last_heartbeat_entity: "sensor.job_last_heartbeat",
});

// ---------------------------------------------------------------------------

describe("guardInfo", () => {
  test("heartbeat guard (notify-only)", () => {
    const i = guardInfo(HB);
    assert.equal(i.type, "heartbeat");
    assert.equal(i.canRecover, false);
    assert.equal(i.driverType, "notify");
    assert.equal(i.lastHeartbeatEntity, "sensor.backup_last_heartbeat");
    assert.equal(i.reviveEntity, null);
    assert.equal(i.eventEntity, null);
    assert.equal(i.statusEntity, "sensor.backup_status");
    assert.equal(i.name, "backup");
  });

  test("heartbeat guard with a recovery stays heartbeat but can recover", () => {
    const i = guardInfo(HB_RECOVER);
    assert.equal(i.type, "heartbeat");
    assert.equal(i.canRecover, true);
    assert.equal(i.driverType, "action");
  });

  for (const [so, driver, entity] of [
    [SWITCH, "switch", "switch.pool_plug"],
    [POE, "poe_port", null],
    [ACTION, "action", null],
    [ACTIONS, "actions", null],
  ]) {
    test(`recovery guard: ${driver}`, () => {
      const i = guardInfo(so);
      assert.equal(i.type, "recovery");
      assert.equal(i.canRecover, true);
      assert.equal(i.driverType, driver);
      assert.equal(i.targetEntity, entity);
      assert.equal(i.healthEntity, `binary_sensor.${so.attributes.guard_name}_health`);
      assert.equal(i.autoEntity, `switch.${so.attributes.guard_name}_auto_recovery`);
      assert.equal(i.reviveEntity, `button.${so.attributes.guard_name}_revive`);
      assert.equal(i.eventEntity, `event.${so.attributes.guard_name}_recovery`);
      assert.equal(i.lastHeartbeatEntity, null);
    });
  }

  test("notify-only guard", () => {
    const i = guardInfo(NOTIFY);
    assert.equal(i.type, "notify");
    assert.equal(i.canRecover, false);
    assert.equal(i.driverType, "notify");
  });

  test("older backend without driver_type: notify derived from revive_entity", () => {
    const a = { ...NOTIFY.attributes };
    delete a.driver_type;
    assert.equal(guardInfo({ ...NOTIFY, attributes: a }).driverType, "notify");
    const b = { ...SWITCH.attributes };
    delete b.driver_type;
    const i = guardInfo({ ...SWITCH, attributes: b });
    assert.equal(i.driverType, null);
    assert.equal(i.type, "recovery");
  });

  test("internal driver keys are mapped to strategy names", () => {
    for (const [internal, user] of [
      ["switch_cycle", "switch"],
      ["action_call", "action"],
      ["action_cycle", "actions"],
      ["noop", "notify"],
    ]) {
      const so = status("x", { driver_type: internal });
      assert.equal(guardInfo(so).driverType, user);
    }
  });

  test("missing state object gives an empty info", () => {
    const i = guardInfo(undefined);
    assert.equal(i.statusEntity, null);
    assert.equal(i.type, "notify");
    assert.equal(i.name, "");
  });

  test("name falls back to friendly_name, then entity id", () => {
    assert.equal(guardInfo({ entity_id: "sensor.a", attributes: { friendly_name: "A" } }).name, "A");
    assert.equal(guardInfo({ entity_id: "sensor.a", attributes: {} }).name, "sensor.a");
  });
});

describe("icons and entities", () => {
  test("default icon per type", () => {
    assert.equal(defaultIcon(guardInfo(HB)), "mdi:heart-flash");
    assert.equal(defaultIcon(guardInfo(SWITCH)), "mdi:medical-bag");
    assert.equal(defaultIcon(guardInfo(NOTIFY)), "mdi:bell-outline");
  });

  test("actor icon per driver type", () => {
    assert.equal(actorIcon("poe_port"), "mdi:ethernet");
    assert.equal(actorIcon("switch"), "mdi:power-plug");
    assert.equal(actorIcon("action"), "mdi:script-text-play");
    assert.equal(actorIcon("actions"), "mdi:toggle-switch");
    assert.equal(actorIcon(null), "mdi:wrench");
  });

  test("relevant entities include value entity and chips, deduplicated", () => {
    const ids = relevantEntities(guardInfo(SWITCH), {
      value_entity: "sensor.pool_power",
      chips: ["switch.pool_plug", { entity: "sensor.x" }, { icon: "mdi:x" }, "switch.pool_plug"],
    });
    assert.deepEqual(ids, [
      "sensor.pool_status",
      "binary_sensor.pool_health",
      "switch.pool_auto_recovery",
      "event.pool_recovery",
      "sensor.pool_power",
      "switch.pool_plug",
      "sensor.x",
    ]);
    assert.ok(relevantEntities(guardInfo(HB), {}).includes("sensor.backup_last_heartbeat"));
    assert.deepEqual(chipEntities({ chips: "nope" }), []);
  });

  test("chipSpecs keeps each spec with its own entity", () => {
    const chips = [{ icon: "mdi:x" }, null, { entity: "switch.a", name: "A", color: "red" }, "switch.b", { entity: "" }];
    assert.deepEqual(chipSpecs({ chips }), [
      { entity: "switch.a", icon: null, name: "A", color: "red" },
      { entity: "switch.b", icon: null, name: null, color: null },
    ]);
    assert.deepEqual(chipEntities({ chips }), ["switch.a", "switch.b"]);
  });

  test("findFirstGuard: registry first, sorted; states as fallback", () => {
    const hass = {
      entities: {
        "sensor.z_status": { platform: "necromancer", translation_key: "status" },
        "sensor.a_last_heartbeat": { platform: "necromancer", translation_key: "last_heartbeat" },
        "sensor.b_status": { platform: "necromancer", translation_key: "status" },
        "sensor.other": { platform: "demo", translation_key: "status" },
      },
      states: {},
    };
    assert.equal(findFirstGuard(hass), "sensor.b_status");
    assert.equal(
      findFirstGuard({ entities: {}, states: { "sensor.pool_status": SWITCH, "sensor.x": { attributes: {} } } }),
      "sensor.pool_status",
    );
    assert.equal(findFirstGuard(undefined), null);
  });
});

// ---------------------------------------------------------------------------

describe("stateColor", () => {
  test("design table colours with HA variable fallbacks", () => {
    assert.equal(stateColor("ok"), "var(--success-color, #43a047)");
    assert.equal(stateColor("suspect"), "var(--warning-color, #fb8c00)");
    assert.equal(stateColor("blind"), "var(--disabled-color, #9e9e9e)");
    assert.equal(stateColor("recovering"), "var(--warning-color, #fb8c00)");
    assert.equal(stateColor("verify"), "var(--info-color, #1e88e5)");
    assert.equal(stateColor("cooldown"), "#26a69a");
    assert.equal(stateColor("escalated"), "var(--error-color, #e53935)");
    assert.equal(stateColor("snoozed"), "var(--purple-color, #8e24aa)");
    assert.equal(stateColor("unavailable"), "var(--disabled-color, #9e9e9e)");
  });

  test("snoozed is the same violet as the snooze chip tone", () => {
    assert.equal(stateColor("snoozed"), SNOOZE_COLOR);
    assert.equal(TONE_COLORS.snooze, SNOOZE_COLOR);
  });

  test("text colour: grey and violet states use the secondary text colour, never --disabled-color", () => {
    const secondary = "var(--secondary-text-color, #727272)";
    for (const s of ["blind", "snoozed", "unavailable", "unknown", undefined, "bogus"]) {
      assert.equal(stateTextColor(s), secondary, String(s));
      assert.ok(isMutedState(s), String(s));
    }
    for (const s of ["ok", "suspect", "recovering", "verify", "cooldown", "escalated"]) {
      assert.equal(stateTextColor(s), stateColor(s), s);
      assert.ok(!isMutedState(s), s);
    }
    for (const tone of ["idle", "snooze", undefined, "bogus"]) assert.equal(toneTextColor(tone), secondary, String(tone));
    for (const tone of ["good", "bad", "warn", "active"]) assert.equal(toneTextColor(tone), TONE_COLORS[tone], tone);
    for (const s of [...STATES, "unavailable"]) assert.ok(!stateTextColor(s).includes("--disabled-color"), s);
  });
});

describe("version", () => {
  test("bare import: no version, no query; versioned() keeps the path", () => {
    assert.equal(VERSION, "");
    assert.equal(VERSION_QUERY, "");
    assert.equal(versioned("./sub/part.js", "file:///f/necromancer.js?v=1"), "file:///f/sub/part.js");
  });

  test("a core loaded with ?v= carries it into VERSION, VERSION_QUERY and versioned()", async () => {
    const c = await import("../../custom_components/necromancer/frontend/necromancer-core.js?v=0.5.0%2Bdev");
    assert.equal(c.VERSION, "0.5.0+dev");
    assert.equal(c.VERSION_QUERY, "?v=0.5.0%2Bdev");
    assert.equal(c.versioned("../../necromancer-actions.js", "file:///f/sub/deep/necromancer-x.js"), "file:///f/necromancer-actions.js?v=0.5.0%2Bdev");
  });
});

describe("statusLine", () => {
  const rec = guardInfo(SWITCH);
  const hb = guardInfo(HB);
  const opts = { now: NOW, timeZone: "UTC", timeFormat: "24" };
  const snooze = { snooze_until: "2026-11-22T14:30:00+00:00" };

  test("recovery guard, en", () => {
    const got = STATES.map((s) => statusLine(rec, s, snooze, "en", opts));
    assert.deepEqual(got, [
      "Healthy",
      "Problem, waiting …",
      "Health unknown",
      "Recovering …",
      "Verifying …",
      "Recovered",
      "Escalated",
      "Snoozed until 14:30",
    ]);
  });

  test("heartbeat guard, en", () => {
    const got = STATES.map((s) => statusLine(hb, s, snooze, "en", opts));
    assert.deepEqual(got, [
      "Healthy",
      "Heartbeat overdue",
      "Waiting for first heartbeat",
      "Repairing …",
      "Waiting for heartbeat …",
      "Recovered",
      "Escalated",
      "Snoozed until 14:30",
    ]);
  });

  test("recovery guard, de", () => {
    const got = STATES.map((s) => statusLine(rec, s, snooze, "de-DE", opts));
    assert.deepEqual(got, [
      "Gesund",
      "Problem, warte …",
      "Zustand unbekannt",
      "Repariere …",
      "Prüfe …",
      "Repariert",
      "Eskaliert",
      "Schlummert bis 14:30",
    ]);
  });

  test("heartbeat guard, de", () => {
    const got = STATES.map((s) => statusLine(hb, s, snooze, "de", opts));
    assert.deepEqual(got, [
      "Gesund",
      "Lebenszeichen überfällig",
      "Warte auf erstes Lebenszeichen",
      "Repariere …",
      "Warte auf Lebenszeichen …",
      "Repariert",
      "Eskaliert",
      "Schlummert bis 14:30",
    ]);
  });

  test("heartbeat suspect after a failure ping says so", () => {
    assert.equal(statusLine(hb, "suspect", { last_status: "fail" }, "en"), "Failure reported");
    assert.equal(statusLine(hb, "suspect", { last_status: "fail" }, "de"), "Fehler gemeldet");
  });

  test("snooze end on another day carries the weekday; missing end is plain", () => {
    const line = statusLine(rec, "snoozed", { snooze_until: "2026-11-23T09:00:00Z" }, "en", opts);
    assert.match(line, /^Snoozed until Mon,? 09:00/);
    assert.equal(statusLine(rec, "snoozed", {}, "en", opts), "Snoozed");
    assert.equal(statusLine(rec, "snoozed", { snooze_until: null }, "de", opts), "Schlummert");
  });

  test("snooze end follows the user's 12/24 h setting, else the language", () => {
    const at = { snooze_until: "2026-11-22T14:30:00Z" };
    const base = { now: NOW, timeZone: "UTC" };
    assert.equal(statusLine(rec, "snoozed", at, "en", { ...base, timeFormat: "12" }), "Snoozed until 2:30 PM");
    assert.equal(statusLine(rec, "snoozed", at, "en", { ...base, timeFormat: "language" }), "Snoozed until 2:30 PM");
    assert.equal(statusLine(rec, "snoozed", at, "de", base), "Schlummert bis 14:30");
  });

  test("unknown / unavailable status", () => {
    assert.equal(statusLine(rec, "unavailable", {}, "en"), "Unavailable");
    assert.equal(statusLine(rec, undefined, {}, "de"), "Nicht verfügbar");
  });

  test("formatUntil: short snooze end for narrow rows", () => {
    const now = NOW; // Sun 2026-11-22 12:00 UTC
    assert.equal(formatUntil("2026-11-22T14:30:00Z", now, "en", "UTC", "24"), "until 14:30");
    assert.equal(formatUntil("2026-11-23T03:58:00Z", now, "en", "UTC", "24"), "until Mon 03:58");
    assert.equal(formatUntil("2026-11-23T03:58:00Z", now, "de", "UTC"), "bis Mo 03:58");
    assert.equal(formatUntil("2026-11-23T03:58:00Z", now, "en", "UTC", "12"), "until Mon 3:58 AM");
    // Server time zone: 02:58 UTC is 03:58 in Berlin.
    assert.equal(formatUntil("2026-11-23T02:58:00Z", now, "de", "Europe/Berlin", "24"), "bis Mo 03:58");
    assert.equal(formatUntil("2026-12-10T03:58:00Z", now, "en", "UTC"), "until Dec 10");
    assert.equal(formatUntil(null, now, "en", "UTC"), "");
    assert.equal(formatUntil("garbage", now, "de", "UTC"), "");
  });

  test("hassTimeZone: server zone unless the profile says local", () => {
    const config = { time_zone: "Europe/Berlin" };
    assert.equal(hassTimeZone({ config, locale: { time_zone: "server" } }), "Europe/Berlin");
    assert.equal(hassTimeZone({ config, locale: {} }), "Europe/Berlin");
    assert.equal(hassTimeZone({ config, locale: { time_zone: "local" } }), undefined);
    assert.equal(hassTimeZone(null), undefined);
  });

  test("formatClock honours the time zone", () => {
    assert.equal(formatClock("2026-11-22T14:30:00Z", NOW, "de", "Europe/Berlin"), "15:30");
    assert.equal(formatClock("2026-11-22T08:05:00Z", NOW, "de", "UTC", "24"), "08:05");
    assert.equal(formatClock("garbage", NOW, "de", "UTC"), "");
  });
});

// ---------------------------------------------------------------------------

describe("formatRelative / formatDuration", () => {
  test("past, compact, en and de", () => {
    assert.equal(formatRelative(ago(2), NOW, "en"), "2 s ago");
    assert.equal(formatRelative(ago(59.9), NOW, "en"), "59 s ago");
    assert.equal(formatRelative(ago(60), NOW, "en"), "1 min ago");
    assert.equal(formatRelative(ago(3599), NOW, "en"), "59 min ago");
    assert.equal(formatRelative(ago(6 * 3600), NOW, "en"), "6 h ago");
    assert.equal(formatRelative(ago(6 * 3600), NOW, "de"), "vor 6 h");
    assert.equal(formatRelative(ago(86399), NOW, "en"), "23 h ago");
    assert.equal(formatRelative(ago(3 * 86400), NOW, "en"), "3 d ago");
    assert.equal(formatRelative(ago(3 * 86400), NOW, "de"), "vor 3 Tg.");
  });

  test("now and small clock skew read as just now", () => {
    assert.equal(formatRelative(NOW, NOW, "en"), "just now");
    assert.equal(formatRelative(ago(0.5), NOW, "de"), "gerade eben");
    assert.equal(formatRelative(NOW + 3000, NOW, "en"), "just now");
  });

  test("future", () => {
    assert.equal(formatRelative(NOW + 5 * 60000, NOW, "en"), "in 5 min");
    assert.equal(formatRelative(NOW + 2 * 3600000, NOW, "de"), "in 2 h");
  });

  test("accepts Date, epoch ms and ISO; invalid gives a dash", () => {
    assert.equal(formatRelative(new Date(NOW - 7000), new Date(NOW), "en"), "7 s ago");
    assert.equal(formatRelative(NOW - 7000, NOW, "en"), "7 s ago");
    for (const bad of [null, undefined, "", "unknown", "unavailable", "nope", NaN, new Date("x")]) {
      assert.equal(formatRelative(bad, NOW, "en"), "–");
    }
    assert.equal(formatRelative(ago(5), "nope", "en"), "–");
  });

  test("durations use at most two adjacent units", () => {
    assert.equal(formatDuration(0), "0 s");
    assert.equal(formatDuration(45), "45 s");
    assert.equal(formatDuration(60), "1 min");
    assert.equal(formatDuration(90), "1 min 30 s");
    assert.equal(formatDuration(5400), "1 h 30 min");
    assert.equal(formatDuration(7200), "2 h");
    assert.equal(formatDuration(86400 + 300), "1 d");
    assert.equal(formatDuration(3 * 86400 + 4 * 3600, "de"), "3 Tg. 4 h");
    assert.equal(formatDuration(-5), "0 s");
    assert.equal(formatDuration(null), "–");
    assert.equal(formatDuration("abc"), "–");
  });

  test("i18n: language normalisation and en fallback", () => {
    assert.equal(langOf("de-AT"), "de");
    assert.equal(langOf("en_GB"), "en");
    assert.equal(langOf("fr"), "en");
    assert.equal(langOf(undefined), "en");
    assert.equal(t("fr", "status.ok"), "Healthy");
    assert.equal(t("de", "no.such.key"), "no.such.key");
    assert.equal(t("de", "event.attempts_other", { n: 2 }), "2 Versuche");
  });

  test("i18n tables are symmetric", () => {
    assert.deepEqual(Object.keys(I18N.de).sort(), Object.keys(I18N.en).sort());
  });
});

// ---------------------------------------------------------------------------

describe("mainValue", () => {
  const hbStates = (hbState, hbAttrs, statusState = "ok", statusAttrs = {}) => ({
    states: {
      "sensor.backup_status": { ...HB, state: statusState, attributes: { ...HB.attributes, ...statusAttrs } },
      "sensor.backup_last_heartbeat": { entity_id: "sensor.backup_last_heartbeat", state: hbState, attributes: hbAttrs },
    },
  });
  const hb = guardInfo(HB);

  test("heartbeat: relative last ping and the expected period", () => {
    const mv = mainValue(hb, hbStates(ago(2), { period: 60, next_due: ago(-58) }), {}, NOW, "en");
    const caption = "Last heartbeat · expected every 1 min";
    assert.deepEqual(mv, { value: "2 s ago", caption, title: caption, late: false, age: 2 });
  });

  test("heartbeat: de wording", () => {
    const mv = mainValue(hb, hbStates(ago(6 * 3600), { period: 86400, next_due: ago(-18 * 3600) }), {}, NOW, "de");
    assert.equal(mv.value, "vor 6 h");
    assert.equal(mv.caption, "Letztes Lebenszeichen · erwartet alle 1 Tg.");
    assert.equal(mv.late, false);
  });

  test("heartbeat: late when past next_due, when escalated, or after a failure ping", () => {
    assert.equal(mainValue(hb, hbStates(ago(120), { period: 60, next_due: ago(60) }), {}, NOW, "en").late, true);
    assert.equal(mainValue(hb, hbStates(ago(10), { period: 60, next_due: ago(-50) }, "escalated"), {}, NOW, "en").late, true);
    const fail = mainValue(hb, hbStates(ago(10), { period: 60, next_due: null }, "suspect", { last_status: "fail" }), {}, NOW, "en");
    assert.equal(fail.late, true);
  });

  test("heartbeat: never pinged, no period", () => {
    const mv = mainValue(hb, hbStates("unknown", {}), {}, NOW, "en");
    assert.deepEqual(mv, { value: "Never", caption: "Last heartbeat", title: "Last heartbeat", late: false, age: null });
    assert.equal(mainValue(hb, hbStates("unknown", {}), {}, NOW, "de").value, "Noch nie");
  });

  test("heartbeat: a disabled or unavailable sensor is not 'Never'", () => {
    // Disabled: absent from the states.
    const missing = mainValue(hb, { states: { "sensor.backup_status": HB } }, {}, NOW, "de");
    assert.equal(missing.value, "–");
    assert.equal(missing.late, false);
    assert.equal(mainValue(hb, hbStates("unavailable", {}), {}, NOW, "en").value, "–");
    assert.equal(mainValue({ ...hb, lastHeartbeatEntity: null }, hbStates(ago(2), {}), {}, NOW, "en").value, "–");
    // Without the deadline the status still tells "overdue" (SUSPECT) apart.
    const overdue = { states: { "sensor.backup_status": { ...HB, state: "suspect" } } };
    assert.equal(mainValue(hb, overdue, {}, NOW, "en").late, true);
  });

  test("value_entity: state with unit, value_name or friendly name as caption", () => {
    const states = {
      "sensor.pool_status": SWITCH,
      "sensor.pool_power": { entity_id: "sensor.pool_power", state: "529.0", attributes: { unit_of_measurement: "W", friendly_name: "Pool power" } },
      "sensor.ap_latency": { entity_id: "sensor.ap_latency", state: "2.345", attributes: { unit_of_measurement: "ms" } },
    };
    const info = guardInfo(SWITCH);
    assert.deepEqual(mainValue(info, { states }, { value_entity: "sensor.pool_power" }, NOW, "en"), {
      value: "529 W",
      caption: "Pool power",
      title: "Pool power",
      late: false,
      age: null,
    });
    const named = mainValue(info, { states }, { value_entity: "sensor.ap_latency", value_name: "Latency" }, NOW, "de");
    assert.equal(named.value, "2,35 ms");
    assert.equal(named.caption, "Latency");
    const prec = mainValue(
      info,
      { states, entities: { "sensor.ap_latency": { display_precision: 0 } } },
      { value_entity: "sensor.ap_latency" },
      NOW,
      "en",
    );
    assert.equal(prec.value, "2 ms");
    assert.equal(prec.caption, "sensor.ap_latency");
  });

  test("value_entity unavailable, missing or non-numeric", () => {
    const info = guardInfo(SWITCH);
    const states = {
      "sensor.pool_status": SWITCH,
      "sensor.u": { entity_id: "sensor.u", state: "unavailable", attributes: {} },
      "sensor.txt": { entity_id: "sensor.txt", state: "running", attributes: {} },
    };
    assert.equal(mainValue(info, { states }, { value_entity: "sensor.u" }, NOW, "en").value, "–");
    assert.equal(mainValue(info, { states }, { value_entity: "sensor.gone" }, NOW, "en").value, "–");
    assert.equal(mainValue(info, { states }, { value_entity: "sensor.txt" }, NOW, "en").value, "running");
  });

  test("value_entity wins over the heartbeat default", () => {
    const states = { ...hbStates(ago(2), { period: 60 }).states, "sensor.size": { entity_id: "sensor.size", state: "12", attributes: { unit_of_measurement: "GB" } } };
    assert.equal(mainValue(hb, { states }, { value_entity: "sensor.size" }, NOW, "en").value, "12 GB");
  });

  test("otherwise: time in the current state, no caption (design §4)", () => {
    const info = guardInfo(SWITCH);
    const mv = mainValue(info, { states: { "sensor.pool_status": SWITCH } }, {}, NOW, "en");
    assert.equal(mv.value, "for 3 d");
    assert.equal(mv.caption, "");
    assert.match(mv.title, /restart/);
    assert.equal(mv.age, 3 * 86400);
    const de = mainValue(info, { states: { "sensor.pool_status": { ...SWITCH, last_changed: ago(5400) } } }, {}, NOW, "de");
    assert.equal(de.value, "seit 1 h 30 min");
    // It ticks once a minute, so it shows no seconds from a minute on.
    const m = mainValue(info, { states: { "sensor.pool_status": { ...SWITCH, last_changed: ago(65) } } }, {}, NOW, "en");
    assert.equal(m.value, "for 1 min");
    const s = mainValue(info, { states: { "sensor.pool_status": { ...SWITCH, last_changed: ago(42) } } }, {}, NOW, "en");
    assert.equal(s.value, "for 42 s");
    assert.equal(mainValue(info, { states: {} }, {}, NOW, "en").value, "–");
  });
});

// ---------------------------------------------------------------------------

describe("footerEvent", () => {
  const info = guardInfo(SWITCH);
  const ev = (type, at, extra = {}) => ({
    "sensor.pool_status": SWITCH,
    "event.pool_recovery": { entity_id: "event.pool_recovery", state: at, attributes: { event_type: type, ...extra } },
  });

  test("recovered", () => {
    assert.deepEqual(footerEvent(info, ev("recovered", ago(7200)), {}, NOW, "en"), {
      icon: "mdi:check-circle",
      tone: "good",
      text: "Recovery succeeded · 2 h ago",
      age: 7200,
    });
    assert.equal(footerEvent(info, ev("recovered", ago(7200)), {}, NOW, "de").text, "Reparatur erfolgreich · vor 2 h");
  });

  test("escalated with attempts (singular / plural)", () => {
    assert.equal(footerEvent(info, ev("escalated", ago(600), { attempt: 2 }), {}, NOW, "en").text, "Escalated · 2 attempts · 10 min ago");
    assert.equal(footerEvent(info, ev("escalated", ago(600), { attempt: 1 }), {}, NOW, "de").text, "Eskaliert · 1 Versuch · vor 10 min");
    const r = footerEvent(info, ev("escalated", ago(600), { attempt: 0 }), {}, NOW, "en");
    assert.equal(r.text, "Escalated · 10 min ago");
    assert.equal(r.tone, "bad");
    assert.equal(r.icon, "mdi:close-octagon");
  });

  test("blocked with its reason", () => {
    const r = footerEvent(info, ev("blocked", ago(60), { reason: "switch not found" }), {}, NOW, "en");
    assert.equal(r.text, "Recovery blocked: switch not found · 1 min ago");
    assert.equal(r.icon, "mdi:cancel");
    assert.equal(footerEvent(info, ev("blocked", ago(60)), {}, NOW, "de").text, "Reparatur blockiert · vor 1 min");
  });

  test("escalated without an event: health_detail", () => {
    const hb = guardInfo(HB);
    const states = { "sensor.backup_status": { ...HB, state: "escalated" } };
    const r = footerEvent(hb, states, { health_detail: "Failure reported, exit code 3." }, NOW, "en");
    assert.deepEqual(r, { icon: "mdi:alert", tone: "warn", text: "Failure reported, exit code 3.", age: null });
  });

  test("escalated with only a stale 'recovered' event prefers health_detail", () => {
    const states = { ...ev("recovered", ago(86400)), "sensor.pool_status": { ...SWITCH, state: "escalated" } };
    assert.equal(footerEvent(info, states, { health_detail: "Ping failed" }, NOW, "en").text, "Ping failed");
    // ...but without a detail the old event is still better than nothing.
    assert.equal(footerEvent(info, states, {}, NOW, "en").text, "Recovery succeeded · 1 d ago");
  });

  test("escalated through the policy gate: an older escalated/blocked event is stale", () => {
    const status = { ...SWITCH, state: "escalated", last_changed: ago(300) };
    const detail = { health_detail: "Device offline" };
    for (const type of ["escalated", "blocked"]) {
      const old = { ...ev(type, ago(7 * 86400), { attempt: 3, reason: "x" }), "sensor.pool_status": status };
      assert.equal(footerEvent(info, old, detail, NOW, "en").text, "Device offline", type);
      // The event of this very escalation is fired right after the state write.
      const current = { ...ev(type, ago(299), { attempt: 3 }), "sensor.pool_status": status };
      assert.notEqual(footerEvent(info, current, detail, NOW, "en").text, "Device offline", type);
    }
  });

  test("nothing to report: null, so the card hides the slot", () => {
    assert.equal(footerEvent(info, ev(undefined, "unknown"), {}, NOW, "en"), null);
    assert.equal(footerEvent(info, { "sensor.pool_status": SWITCH }, {}, NOW, "en"), null);
    assert.equal(footerEvent(guardInfo(HB), { "sensor.backup_status": HB }, { health_detail: "x" }, NOW, "en"), null);
    assert.equal(footerEvent(info, {}, {}, NOW, "en"), null);
  });
});

// ---------------------------------------------------------------------------

describe("actionsFor", () => {
  const types = {
    heartbeat: guardInfo(HB),
    heartbeat_recover: guardInfo(HB_RECOVER),
    recovery: guardInfo(SWITCH),
    notify: guardInfo(NOTIFY),
  };

  // Expected sets from the design §5 action table + decisions §16, per state
  // (auto-recovery is no action any more: its chip and the popup handle it).
  function expected(kind, state, isAdmin) {
    const busy = state === "recovering" || state === "verify";
    const snoozed = state === "snoozed";
    const hb = kind.startsWith("heartbeat");
    const rec = kind === "recovery" || kind === "heartbeat_recover";
    const set = new Set(["check", "details"]);
    if (rec && !busy) set.add("revive");
    if (state === "escalated") set.add("reset");
    if (!snoozed && !busy) set.add("snooze");
    if (snoozed) set.add("unsnooze");
    if (hb && !snoozed) set.add("ping");
    if (hb && isAdmin) set.add("url");
    if (isAdmin) set.add("edit");
    return ACTION_ORDER.filter((id) => set.has(id));
  }

  for (const [kind, info] of Object.entries(types)) {
    for (const state of STATES) {
      for (const isAdmin of [false, true]) {
        test(`${kind} / ${state} / ${isAdmin ? "admin" : "user"}`, () => {
          const r = actionsFor(info, state, {}, { isAdmin });
          assert.deepEqual(r.actions, expected(kind, state, isAdmin));
          // main + snooze pill + menu cover every action exactly once.
          const all = [r.main, r.second, ...r.menu].filter(Boolean);
          assert.deepEqual([...all].sort(), [...r.actions].sort());
          assert.equal(new Set(all).size, all.length);
          // Snooze is never in the menu; the rare entries come last.
          assert.ok(!r.menu.includes("snooze") && !r.menu.includes("unsnooze"));
          const tail = r.menu.findIndex((id) => MENU_TAIL.has(id));
          if (tail >= 0) assert.ok(r.menu.slice(tail).every((id) => MENU_TAIL.has(id)));
        });
      }
    }
  }

  test("main pill and snooze pill by state (design §16)", () => {
    const p = (kind, state) => {
      const r = actionsFor(types[kind], state, {}, { isAdmin: true });
      return [r.main, r.second];
    };
    assert.deepEqual(p("recovery", "escalated"), ["reset", "snooze"]);
    assert.deepEqual(p("heartbeat", "escalated"), ["ping", "snooze"]);
    assert.deepEqual(p("heartbeat_recover", "escalated"), ["ping", "snooze"]);
    assert.deepEqual(p("notify", "escalated"), ["reset", "snooze"]);
    assert.deepEqual(p("recovery", "suspect"), ["revive", "snooze"]);
    assert.deepEqual(p("heartbeat_recover", "suspect"), ["revive", "snooze"]);
    assert.deepEqual(p("heartbeat", "suspect"), ["ping", "snooze"]);
    assert.deepEqual(p("notify", "blind"), ["check", "snooze"]);
    assert.deepEqual(p("recovery", "recovering"), [null, null]);
    assert.deepEqual(p("heartbeat", "verify"), [null, null]);
    assert.deepEqual(p("recovery", "snoozed"), ["unsnooze", null]);
    assert.deepEqual(p("heartbeat", "snoozed"), ["unsnooze", null]);
    assert.deepEqual(p("recovery", "ok"), ["check", "snooze"]);
    assert.deepEqual(p("heartbeat", "ok"), ["ping", "snooze"]);
    assert.deepEqual(p("notify", "cooldown"), ["check", "snooze"]);
  });

  test("menu order: the rest canonical, then url, edit, details", () => {
    const r = actionsFor(types.heartbeat_recover, "escalated", {}, { isAdmin: true });
    assert.deepEqual(r.menu, ["revive", "reset", "check", "url", "edit", "details"]);
    const s = actionsFor(types.recovery, "snoozed", {}, { isAdmin: false });
    assert.deepEqual(s.menu, ["revive", "check", "details"], "revive while snoozed (it ends the snooze)");
  });

  test("heartbeat ping applies in every state except snoozed", () => {
    for (const state of STATES) {
      const has = actionsFor(types.heartbeat, state, {}, {}).actions.includes("ping");
      assert.equal(has, state !== "snoozed", state);
    }
  });

  test("show_actions: false / none hide everything; older auto and lists read as on", () => {
    const none = { actions: [], main: null, second: null, menu: [] };
    assert.deepEqual(actionsFor(types.recovery, "ok", {}, { show: false }), none);
    assert.deepEqual(actionsFor(types.recovery, "ok", {}, { show: "none" }), none);
    for (const show of [true, "auto", ["reset"], undefined]) {
      assert.deepEqual(actionsFor(types.recovery, "ok", {}, { show }).actions, expected("recovery", "ok", false));
    }
    assert.equal(actionsShown(false), false);
    assert.equal(actionsShown("none"), false);
    assert.equal(actionsShown(true), true);
    assert.equal(actionsShown(undefined), true);
  });

  test("auto-recovery is never an action (chip and popup)", () => {
    for (const state of STATES) assert.ok(!actionsFor(types.recovery, state, {}, { isAdmin: true }).actions.includes("auto"));
  });

  test("unavailable status: no pills, the menu has details (and edit for admins)", () => {
    assert.deepEqual(actionsFor(types.recovery, "unavailable", {}, { isAdmin: true }), { actions: ["edit", "details"], main: null, second: null, menu: ["edit", "details"] });
    assert.deepEqual(actionsFor(types.recovery, "unknown", {}, {}).menu, ["details"]);
  });

  test("labels exist for every action in both languages", () => {
    for (const lang of ["en", "de"]) {
      for (const id of ACTION_ORDER) {
        assert.ok(!actionLabel(id, lang, true).startsWith("action."), `${lang}/${id}`);
      }
      for (const s of SNOOZE_DURATIONS) assert.ok(!t(lang, `snooze.${s}`).startsWith("snooze."));
    }
  });

  test("snooze durations and confirmations per decisions", () => {
    assert.deepEqual(SNOOZE_DURATIONS, [1800, 3600, 14400, 86400]);
    assert.ok(CONFIRM_ACTIONS.has("revive"));
    assert.ok(CONFIRM_ACTIONS.has("ping"));
    assert.equal(EDIT_PATH, "/config/integrations/integration/necromancer");
  });
});

describe("serviceFor", () => {
  const info = guardInfo(SWITCH);
  test("service calls of the plain actions", () => {
    assert.deepEqual(serviceFor("revive", info), ["button", "press", {}, { entity_id: "button.pool_revive" }]);
    assert.deepEqual(serviceFor("reset", info), ["necromancer", "reset", {}, { entity_id: "sensor.pool_status" }]);
    assert.deepEqual(serviceFor("unsnooze", info), ["necromancer", "unsnooze", {}, { entity_id: "sensor.pool_status" }]);
    assert.deepEqual(serviceFor("snooze", info, { duration: 3600 }), [
      "necromancer",
      "snooze",
      { duration: 3600 },
      { entity_id: "sensor.pool_status" },
    ]);
    assert.equal(serviceFor("snooze", info), null);
    assert.deepEqual(serviceFor("ping", guardInfo(HB)), ["necromancer", "heartbeat_ping", {}, { entity_id: "sensor.backup_status" }]);
    assert.deepEqual(serviceFor("auto", info, { autoOn: true }), ["switch", "turn_off", {}, { entity_id: "switch.pool_auto_recovery" }]);
    assert.deepEqual(serviceFor("auto", info, { autoOn: false }), ["switch", "turn_on", {}, { entity_id: "switch.pool_auto_recovery" }]);
    assert.deepEqual(serviceFor("check", info), ["necromancer", "check_health", { guard: "sensor.pool_status" }, undefined]);
    for (const id of ["url", "edit", "details"]) assert.equal(serviceFor(id, info), null);
  });

  test("ping URL resolution prefers the full URL, else origin + path", () => {
    assert.equal(resolvePingUrl({ url: "https://h/api/x", path: "/api/x" }, "http://o"), "https://h/api/x");
    assert.equal(resolvePingUrl({ url: null, path: "/api/x" }, "http://o:8123/"), "http://o:8123/api/x");
    assert.equal(resolvePingUrl({ url: null, path: null }, "http://o"), null);
    assert.equal(resolvePingUrl(undefined, "http://o"), null);
  });
});

describe("chips and escaping", () => {
  test("health and entity tones", () => {
    assert.equal(healthTone({ state: "on" }), "good");
    assert.equal(healthTone({ state: "off" }), "bad");
    assert.equal(healthTone({ state: "unavailable" }), "idle");
    assert.equal(healthTone(undefined), "idle");
    assert.equal(entityTone({ state: "on" }), "good");
    assert.equal(entityTone({ state: "off" }), "idle");
    assert.equal(entityTone({ state: "12" }), "idle");
    assert.equal(entityTone({ state: "unknown" }), "idle");
    const problem = { entity_id: "binary_sensor.ups_problem", state: "on", attributes: { device_class: "problem" } };
    assert.equal(entityTone(problem), "bad");
    assert.equal(entityTone({ ...problem, state: "off" }), "idle");
    assert.equal(entityTone({ ...problem, attributes: { device_class: "connectivity" } }), "good");
  });

  test("configured chip colours", () => {
    assert.equal(chipColor("bad"), "var(--error-color, #e53935)");
    assert.equal(chipColor("red"), "var(--red-color, red)");
    assert.equal(chipColor("light-blue"), "var(--light-blue-color, lightblue)");
    assert.equal(chipColor("#ff8800"), "#ff8800");
    assert.equal(chipColor("red; background: url(x)"), null);
    assert.equal(chipColor(undefined), null);
  });

  test("next tick lands on the youngest age's next boundary", () => {
    assert.equal(nextTickMs([]), null);
    assert.equal(nextTickMs([null, undefined]), null);
    assert.equal(nextTickMs([5.25]), 770); // 750 ms to 6 s, plus a little slack
    assert.equal(nextTickMs([65]), 55020); // the next whole minute (2 min)
    assert.equal(nextTickMs([65, 3600 * 5 + 30]), 30020);
    assert.ok(nextTickMs([59.9999]) >= 250);
  });

  test("escapeHtml", () => {
    assert.equal(escapeHtml(`<b a="x">'&`), "&lt;b a=&quot;x&quot;&gt;&#39;&amp;");
    assert.equal(escapeHtml(null), "");
  });
});
