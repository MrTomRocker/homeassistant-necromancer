"""Level-1 unit tests (testing.md §2) against a real Home Assistant core.

Covers the pure-logic rows of the test spec: health sources, driver pre-flight
(`can_recover`), config-flow helpers, the port-YAML import/export, `actions`
normalisation and `links` closure. PoE fabric + poe_port driver have their own
module (`test_poe.py`).

    PYTHONPATH=<ha-core>:<ha-core>/config python tests/test_units.py
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
import json
import sys
from unittest.mock import patch

# Must precede the voluptuous import: importing `homeassistant` runs
# `install_as_voluptuous()`, which swaps the voluptuous module for probatio's shim.
# Import voluptuous first and `vol.Invalid` stays the real voluptuous one, which HA's
# validators no longer raise — an `except vol.Invalid` here would then miss.
import homeassistant  # noqa: F401

# isort: split

import voluptuous as vol

try:
    from pytest_homeassistant.common import (
        async_mock_service,
        async_test_home_assistant,
    )
except ImportError:  # core checkouts older than home-assistant/core#187095
    from tests.common import async_mock_service, async_test_home_assistant

from custom_components.necromancer.config_flow import (
    DeviceSubentryFlow,
    NecromancerOptionsFlow,
)
from custom_components.necromancer.config_flow_helpers import schemas as cf
from custom_components.necromancer.core.actions import async_run, async_validate
from custom_components.necromancer.core.drivers import create_driver
from custom_components.necromancer.core.health import create_health, heartbeat as hb
from custom_components.necromancer.core.health.base import Health
from custom_components.necromancer.core.links import group_of, link_components
from homeassistant.util import dt as dt_util

# ---------------- core/health/entity_state ----------------


async def test_entity_state_on_off_unknown(hass, _):
    h = create_health(
        hass,
        {
            "type": "entity_state",
            "entity_id": "sensor.x",
            "on_value": ["on", "home"],
            "off_value": ["off"],
        },
    )
    hass.states.async_set("sensor.x", "home")
    assert h.evaluate() is Health.OK
    hass.states.async_set("sensor.x", "off")
    assert h.evaluate() is Health.UNHEALTHY
    hass.states.async_set("sensor.x", "weird")
    assert h.evaluate() is Health.UNKNOWN  # not in on/off lists -> unknown
    hass.states.async_set("sensor.x", "unavailable")
    assert h.evaluate() is Health.UNKNOWN  # ambiguous -> no false alarm
    hass.states.async_set("sensor.x", "unknown")
    assert h.evaluate() is Health.UNKNOWN  # ambiguous -> no false alarm


async def test_entity_state_unavailable_as_off(hass, _):
    h = create_health(
        hass,
        {
            "type": "entity_state",
            "entity_id": "sensor.y",
            "on_value": ["on"],
            "off_value": ["unavailable"],
        },
    )
    hass.states.async_set("sensor.y", "unavailable")
    assert h.evaluate() is Health.UNHEALTHY  # explicit off wins over ambiguity
    assert (
        create_health(
            hass,
            {"type": "entity_state", "entity_id": "sensor.absent", "on_value": ["on"]},
        ).evaluate()
        is Health.UNKNOWN
    )


async def test_entity_state_unknown_as_off(hass, _):
    h = create_health(
        hass,
        {
            "type": "entity_state",
            "entity_id": "sensor.z",
            "on_value": ["on"],
            "off_value": ["unknown"],
        },
    )
    hass.states.async_set("sensor.z", "unknown")
    assert h.evaluate() is Health.UNHEALTHY  # explicit off wins over ambiguity


async def test_entity_state_legacy_healthy_state(hass, _):
    # no off_value -> anything not in on counts as unhealthy
    h = create_health(
        hass, {"type": "entity_state", "entity_id": "sensor.z", "healthy_state": "on"}
    )
    hass.states.async_set("sensor.z", "on")
    assert h.evaluate() is Health.OK
    hass.states.async_set("sensor.z", "off")
    assert h.evaluate() is Health.UNHEALTHY


# ---------------- core/health/template ----------------


async def test_template_boolean_and_unknown(hass, _):
    def verdict(tmpl):
        return create_health(hass, {"type": "template", "template": tmpl}).evaluate()

    # healthy whitelist: true / on / 1 / yes
    assert verdict("{{ true }}") is Health.OK
    assert verdict("{{ 1 == 1 }}") is Health.OK
    assert verdict("{{ 'on' }}") is Health.OK
    assert verdict("{{ 'yes' }}") is Health.OK
    assert verdict("{{ 1 }}") is Health.OK
    # faulty: the inverse (false / off / 0 / no)
    assert verdict("{{ false }}") is Health.UNHEALTHY
    assert verdict("{{ 0 }}") is Health.UNHEALTHY
    assert verdict("{{ 'off' }}") is Health.UNHEALTHY
    assert verdict("{{ 'no' }}") is Health.UNHEALTHY
    # everything else -> unknown (no false alarm)
    assert verdict("{{ '' }}") is Health.UNKNOWN
    assert verdict("{{ none }}") is Health.UNKNOWN
    assert verdict("{{ 'unavailable' }}") is Health.UNKNOWN
    assert (
        verdict("{{ 'kaputt' }}") is Health.UNKNOWN
    )  # unrecognized -> unknown, not faulty
    assert verdict("{{ states('sensor.does_not_exist') }}") is Health.UNKNOWN
    assert verdict("{{ 1/0 }}") is Health.UNKNOWN  # render error -> unknown


# ---------------- drivers.can_recover ----------------


async def test_switch_cycle_can_recover(hass, _):
    d = create_driver(hass, {"type": "switch_cycle", "switch_entity": "switch.missing"})
    ok, reason = await d.can_recover()
    assert not ok and "not found" in reason, reason
    hass.states.async_set("switch.present", "on")
    d2 = create_driver(
        hass, {"type": "switch_cycle", "switch_entity": "switch.present"}
    )
    ok2, _r = await d2.can_recover()
    assert ok2


async def test_action_cycle_can_recover(hass, _):
    missing = create_driver(
        hass, {"type": "action_cycle", "off_action": None, "on_action": [{"delay": 1}]}
    )
    ok, reason = await missing.can_recover()
    assert not ok and "off" in reason, reason
    good = create_driver(
        hass,
        {
            "type": "action_cycle",
            "off_action": [{"delay": 1}],
            "on_action": [{"delay": 1}],
        },
    )
    ok2, _r = await good.can_recover()
    assert ok2


# ---------------- config_flow helpers ----------------


async def test_flatten_sections_and_as_list(hass, _):
    assert cf._flatten_sections({"a": 1, "sec": {"b": 2, "c": 3}}) == {
        "a": 1,
        "b": 2,
        "c": 3,
    }
    assert cf._as_list(None) == []
    assert cf._as_list("x") == ["x"]
    assert cf._as_list(["x", "y"]) == ["x", "y"]


async def test_source_type_and_current_strategy(hass, _):
    assert cf._source_type_of({"health": {"type": "template"}}) == cf.SOURCE_TEMPLATE
    assert cf._source_type_of({"health": {"type": "entity_state"}}) == cf.SOURCE_STATE
    assert cf._source_type_of({"health": {"type": "heartbeat"}}) == cf.SOURCE_HEARTBEAT
    assert cf._source_type_of({}) == cf.SOURCE_STATE
    assert cf._current_strategy({"driver": {"type": "poe_port"}}) == cf.STRATEGY_POE
    assert (
        cf._current_strategy(
            {"driver": {"type": "action_call"}, "behavior": {"health_check": True}}
        )
        == cf.STRATEGY_ACTION
    )
    assert (
        cf._current_strategy(
            {"driver": {"type": "switch_cycle"}, "behavior": {"health_check": False}}
        )
        == cf.STRATEGY_SWITCH
    )


async def test_build_data_state_switch_check(hass, _):
    step1 = {
        cf.CONF_NAME: "G",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_STATE,
        cf.CONF_ENTITY_ID: "binary_sensor.p",
        cf.CONF_ATTRIBUTE: None,
        cf.CONF_ON_VALUE: ["on"],
        cf.CONF_OFF_VALUE: ["off"],
    }
    step2 = {
        cf.CONF_DEBOUNCE: 30,
        cf.CONF_COOLDOWN: 60,
        cf.CONF_BOOT_WINDOW: 90,
        cf.CONF_MAX_ATTEMPTS: 3,
        cf.CONF_SWITCH_ENTITY: "switch.s",
        cf.CONF_OFF_ON_DELAY: 5,
    }
    data = cf._build_data(step1, step2, cf.STRATEGY_SWITCH)
    assert data[cf.CONF_HEALTH]["type"] == "entity_state"
    assert data[cf.CONF_DRIVER]["type"] == "switch_cycle"
    assert data[cf.CONF_BEHAVIOR]["health_check"] is True
    assert data[cf.CONF_BEHAVIOR]["boot_window"] == 90


async def test_build_data_health_check_toggle(hass, _):
    step1 = {
        cf.CONF_NAME: "G",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_STATE,
        cf.CONF_ENTITY_ID: "binary_sensor.p",
        cf.CONF_ATTRIBUTE: None,
        cf.CONF_ON_VALUE: ["on"],
        cf.CONF_OFF_VALUE: ["off"],
    }
    step2 = {
        cf.CONF_DEBOUNCE: 30,
        cf.CONF_COOLDOWN: 60,
        cf.CONF_BOOT_WINDOW: 90,
        cf.CONF_MAX_ATTEMPTS: 3,
        cf.CONF_SWITCH_ENTITY: "switch.s",
        cf.CONF_OFF_ON_DELAY: 5,
        cf.CONF_HEALTH_CHECK: False,
    }
    # Toggle off -> not verified, but the numbers stay stored (editable later).
    off = cf._build_data(step1, step2, cf.STRATEGY_SWITCH)
    assert off[cf.CONF_BEHAVIOR]["health_check"] is False
    assert off[cf.CONF_BEHAVIOR]["boot_window"] == 90
    assert off[cf.CONF_BEHAVIOR]["max_attempts"] == 3
    # Absent toggle defaults to on (verify is the default).
    no_toggle = {k: v for k, v in step2.items() if k != cf.CONF_HEALTH_CHECK}
    on = cf._build_data(step1, no_toggle, cf.STRATEGY_SWITCH)
    assert on[cf.CONF_BEHAVIOR]["health_check"] is True


async def test_build_data_reload_entry(hass, _):
    base = {
        cf.CONF_NAME: "G",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_STATE,
        cf.CONF_DEVICE_ID: "dev1",
        cf.CONF_ENTITY_ID: "binary_sensor.p",
        cf.CONF_ATTRIBUTE: None,
        cf.CONF_ON_VALUE: ["on"],
        cf.CONF_OFF_VALUE: ["off"],
    }
    step2 = {
        cf.CONF_DEBOUNCE: 30,
        cf.CONF_COOLDOWN: 60,
        cf.CONF_BOOT_WINDOW: 90,
        cf.CONF_MAX_ATTEMPTS: 3,
        cf.CONF_SWITCH_ENTITY: "switch.s",
        cf.CONF_OFF_ON_DELAY: 5,
        cf.CONF_RELOAD_ENTRY: True,
        cf.CONF_RELOAD_DELAY: 7,
    }
    data = cf._build_data(base, step2, cf.STRATEGY_SWITCH)
    assert data[cf.CONF_BEHAVIOR][cf.CONF_RELOAD_ENTRY] is True
    assert data[cf.CONF_BEHAVIOR][cf.CONF_RELOAD_DELAY] == 7
    # no assigned device -> reload not stored even with the flag set
    nodev = {k: v for k, v in base.items() if k != cf.CONF_DEVICE_ID}
    data2 = cf._build_data(nodev, step2, cf.STRATEGY_SWITCH)
    assert cf.CONF_RELOAD_ENTRY not in data2[cf.CONF_BEHAVIOR]


async def test_build_data_template_notify(hass, _):
    step1 = {
        cf.CONF_NAME: "N",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_TEMPLATE,
        cf.CONF_TEMPLATE: "{{ true }}",
    }
    step2 = {cf.CONF_DEBOUNCE: 30}
    data = cf._build_data(step1, step2, cf.MODE_NOTIFY)
    assert data[cf.CONF_HEALTH]["type"] == "template"
    assert data[cf.CONF_DRIVER]["type"] == "noop"
    assert data[cf.CONF_POLICY]["type"] == cf.MODE_NOTIFY


async def test_build_data_heartbeat(hass, _):
    """Heartbeat: token from step1, durations as seconds, never linked."""
    step1 = {
        cf.CONF_NAME: "Job",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_HEARTBEAT,
        cf.CONF_TOKEN: _HB_TOKEN,
        # The flow stores seconds; a raw selector dict is accepted as well.
        cf.CONF_PERIOD: {"days": 7},
        cf.CONF_LOCAL_ONLY: False,
    }
    step2 = {
        cf.CONF_DEBOUNCE: 0,
        cf.CONF_COOLDOWN: 60,
        cf.CONF_BOOT_WINDOW: 90,
        cf.CONF_MAX_ATTEMPTS: 2,
        cf.CONF_ACTION: [{"action": "test.x"}],
        "linked_guards": {cf.CONF_LINKED_GUARDS: ["other"]},
        cf.CONF_NOTIFY_FOLLOWER_SUCCESS: True,
    }
    data = cf._build_data(step1, step2, cf.STRATEGY_ACTION)
    assert data[cf.CONF_HEALTH] == {
        "type": "heartbeat",
        "token": _HB_TOKEN,
        "period": 7 * 86400,
        "local_only": False,
    }
    assert cf.CONF_LINKED_GUARDS not in data
    assert cf.CONF_NOTIFY_FOLLOWER_SUCCESS not in data[cf.CONF_BEHAVIOR]
    # Durations are dict-valued fields, not sections: flattening keeps them whole.
    flat = cf._flatten_sections({cf.CONF_PERIOD: {"days": 1}, "sec": {"a": 1}})
    assert flat == {cf.CONF_PERIOD: {"days": 1}, "a": 1}


async def test_duration_round_trip(hass, _):
    """Stored seconds <-> DurationSelector dict, with fallback for missing."""
    week = {"days": 7, "hours": 0, "minutes": 0, "seconds": 0}
    assert cf._as_duration(604800, 0) == week
    assert cf._as_duration(None, 3661) == {
        "days": 0,
        "hours": 1,
        "minutes": 1,
        "seconds": 1,
    }
    assert cf._as_duration(week, 0) is week  # re-shown input stays as entered
    assert cf._as_seconds(week) == 604800
    assert cf._as_seconds({"minutes": 1}) == 60
    assert cf._as_seconds(90) == 90


async def test_behavior_defaults_debounce_per_source(hass, _):
    """Stored debounce is kept unless the edit crosses the heartbeat boundary."""
    state = {"health": {"type": "entity_state"}, "behavior": {"debounce": 30}}
    beat = {"health": {"type": "heartbeat"}, "behavior": {"debounce": 5}}

    def debounce(data, source_type=None):
        return cf._behavior_defaults(data, source_type)[cf.CONF_DEBOUNCE]

    assert debounce(state) == 30
    assert debounce(state, cf.SOURCE_TEMPLATE) == 30  # state <-> template keeps it
    # The heartbeat's grace after a missed ping is its debounce: 1 h by default.
    assert cf.DEFAULT_HEARTBEAT_DEBOUNCE == 3600
    assert debounce(state, cf.SOURCE_HEARTBEAT) == cf.DEFAULT_HEARTBEAT_DEBOUNCE
    assert debounce(beat) == 5
    assert debounce(beat, cf.SOURCE_HEARTBEAT) == 5
    assert debounce(beat, cf.SOURCE_STATE) == cf.DEFAULT_DEBOUNCE
    nothing_stored = {"health": {"type": "heartbeat"}}
    assert debounce(nothing_stored) == cf.DEFAULT_HEARTBEAT_DEBOUNCE
    # The strategy-specific builders pass the source type through.
    assert cf._switch_defaults(state, cf.SOURCE_HEARTBEAT)[cf.CONF_DEBOUNCE] == (
        cf.DEFAULT_HEARTBEAT_DEBOUNCE
    )
    assert cf._poe_defaults(beat, cf.SOURCE_STATE)[cf.CONF_DEBOUNCE] == (
        cf.DEFAULT_DEBOUNCE
    )
    # Create mode: the schema default follows the source type.
    for source_type, expected in (
        (cf.SOURCE_HEARTBEAT, cf.DEFAULT_HEARTBEAT_DEBOUNCE),
        (cf.SOURCE_STATE, cf.DEFAULT_DEBOUNCE),
    ):
        schema = cf._notify_schema(None, source_type=source_type).schema
        key = next(k for k in schema if str(k) == cf.CONF_DEBOUNCE)
        assert key.default() == expected, source_type


async def test_debounce_field_up_to_a_day(hass, _):
    """The debounce box allows up to 1 day for every guard (a heartbeat's grace)."""
    for source_type, default in (
        (cf.SOURCE_STATE, cf.DEFAULT_DEBOUNCE),
        (cf.SOURCE_TEMPLATE, cf.DEFAULT_DEBOUNCE),
        (cf.SOURCE_HEARTBEAT, cf.DEFAULT_HEARTBEAT_DEBOUNCE),
    ):
        ((key, sel),) = cf._debounce_field({}, source_type).items()
        assert str(key) == cf.CONF_DEBOUNCE and key.default() == default
        assert sel.config["max"] == 86400, (source_type, sel.config)
    # Defaults of the device step carry no grace any more, even if one is stored.
    stored = {"health": {"type": "heartbeat", "period": 600, "grace": 7200}}
    assert "grace" not in cf._health_defaults(stored)


# ---------------- config_flow ports YAML ----------------


async def test_ports_yaml_valid_and_normalise(hass, _):
    text = """
- label:  P1
  actuator: switch.a
  status_entity: binary_sensor.s
  status_on: on
  id_static: 42
  off_timeout: 30
"""
    ports = cf._parse_ports_yaml(text)
    assert len(ports) == 1
    p = ports[0]
    assert p[cf.CONF_LABEL] == "P1"  # trimmed
    assert p[cf.CONF_STATUS_ON] == ["on"]  # scalar -> list, bool-safe
    assert p[cf.CONF_ID_STATIC] == "42"  # int -> str
    assert p[cf.CONF_STATUS_OFF] == ["off"]  # default


async def test_ports_yaml_rejections(hass, _):
    bad = [
        "not: a list",  # a dict, not a list
        "- {label: x}",  # missing actuator
        "- {label: x, actuator: switch.a}",  # missing status_entity
        "- label: x\n  actuator: switch.a\n  status_entity: s\n  off_timeout: -1",  # negative
        "- label: x\n  actuator: switch.a\n  status_entity: s\n  off_timeout: abc",  # non-numeric
        "- just_a_scalar",  # list of scalar (not a mapping)
        ": : bad yaml :",  # malformed YAML
        "",  # nothing
        "null",  # explicit null
        "- {label: x, actuator: switch.a, status_entity: s, id_static: dev, id_entity: sensor.n}",  # two id sources
        "- {label: x, actuator: switch.a, status_entity: s, id_attribute: mac}",  # attribute, no id entity
    ]
    for t in bad:
        try:
            cf._parse_ports_yaml(t)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for: {t!r}")
    # an explicit empty list is valid (it just means "no ports")
    assert cf._parse_ports_yaml("[]") == []


async def test_validate_port_identity(hass, _):
    v = cf._validate_port_identity
    assert v({cf.CONF_ID_STATIC: "x", cf.CONF_ID_ENTITY: "sensor.a"}) == (
        cf.CONF_ID_STATIC,
        "id_conflict",
    )
    assert v({cf.CONF_ID_ATTRIBUTE: "mac"}) == (
        cf.CONF_ID_ATTRIBUTE,
        "attribute_needs_entity",
    )
    assert v({cf.CONF_ID_STATIC: "x"}) is None
    assert v({cf.CONF_ID_ENTITY: "sensor.a", cf.CONF_ID_ATTRIBUTE: "mac"}) is None


async def test_ports_yaml_roundtrip_and_merge(hass, _):
    ports = [
        {
            cf.CONF_LABEL: "P1",
            cf.CONF_ACTUATOR: "switch.a",
            cf.CONF_STATUS_ENTITY: "binary_sensor.s",
            cf.CONF_STATUS_ON: ["on"],
            cf.CONF_STATUS_OFF: ["off"],
            cf.CONF_OFF_ON_DELAY: 5,
            cf.CONF_OFF_TIMEOUT: 20,
            cf.CONF_ON_TIMEOUT: 60,
        }
    ]
    dumped = cf._ports_to_yaml(ports)
    again = cf._parse_ports_yaml(dumped)
    assert again[0][cf.CONF_LABEL] == "P1" and again[0][cf.CONF_STATUS_ON] == ["on"]
    # merge upserts by label; replace overwrites
    flow = NecromancerOptionsFlow()
    flow._ports = list(ports)
    flow._merge_ports(
        [
            {
                cf.CONF_LABEL: "P1",
                cf.CONF_ACTUATOR: "switch.NEW",
                cf.CONF_STATUS_ENTITY: "binary_sensor.s",
                cf.CONF_STATUS_ON: ["on"],
                cf.CONF_STATUS_OFF: ["off"],
                cf.CONF_OFF_ON_DELAY: 5,
                cf.CONF_OFF_TIMEOUT: 20,
                cf.CONF_ON_TIMEOUT: 60,
            },
            {
                cf.CONF_LABEL: "P2",
                cf.CONF_ACTUATOR: "switch.b",
                cf.CONF_STATUS_ENTITY: "binary_sensor.s2",
                cf.CONF_STATUS_ON: ["on"],
                cf.CONF_STATUS_OFF: ["off"],
                cf.CONF_OFF_ON_DELAY: 5,
                cf.CONF_OFF_TIMEOUT: 20,
                cf.CONF_ON_TIMEOUT: 60,
            },
        ]
    )
    assert len(flow._ports) == 2  # P1 updated in place, P2 added
    assert flow._ports[0][cf.CONF_ACTUATOR] == "switch.NEW"


# ---------------- actions ----------------


async def test_actions_normalise_and_invalid(hass, _):
    seq = await async_validate(
        hass, {"service": "homeassistant.turn_on", "entity_id": "light.x"}
    )
    assert isinstance(seq, list) and "action" in seq[0], seq  # service -> action
    raised = False
    try:
        await async_validate(hass, [{"not_a_valid_action_key": 1}])
    except vol.Invalid:
        raised = True
    assert raised, "invalid action should raise vol.Invalid"


# ---------------- links ----------------


async def test_links_closure(hass, _):
    valid = {"A", "B", "C", "D"}
    links = {"A": {"B"}, "B": {"C"}, "C": set(), "D": set()}  # one-sided chain
    assert group_of(links, valid, "A") == {"B", "C"}  # transitive
    assert group_of(links, valid, "C") == {"A", "B"}  # symmetric read
    assert group_of(links, valid, "D") == set()
    assert group_of({"A": {"Z"}}, {"A"}, "A") == set()  # stale id dropped
    comp = link_components(links, valid)
    assert comp["A"] == comp["B"] == comp["C"] == {"A", "B", "C"}


async def test_flow_rejects_empty_action(hass, _):
    flow = DeviceSubentryFlow()
    flow.hass = hass
    flow._reconfig = False
    flow._strategy = "action"
    flow._step1 = {
        cf.CONF_NAME: "X",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_TEMPLATE,
        cf.CONF_TEMPLATE: "{{ true }}",
    }
    flow._with_link = lambda schema: schema  # avoid needing a real config entry
    captured: dict = {}
    flow.async_show_form = lambda **kw: captured.update(kw) or kw
    await flow.async_step_action(
        {
            "action": [],
            "behavior": {"debounce": 2, "cooldown": 2},
            "notification": {},
            "linked_guards": {"linked_guards": []},
        }
    )
    assert captured.get("errors", {}).get(cf.CONF_ACTION) == "action_required", captured


async def test_own_guard_entities_only_self(hass, _):
    from custom_components.necromancer.config_flow_helpers.schemas import (
        _own_guard_entities,
    )
    from homeassistant.helpers import entity_registry as er

    reg = er.async_get(hass)
    a = reg.async_get_or_create("sensor", "necromancer", "GUARDA_status")
    b = reg.async_get_or_create("sensor", "necromancer", "GUARDB_status")
    own = _own_guard_entities(hass, "GUARDA")
    # only this guard's entity is excluded; another guard's stays pickable
    assert a.entity_id in own, own
    assert b.entity_id not in own, own
    # adding a new guard (no subentry yet) excludes nothing necromancer-wise
    assert _own_guard_entities(hass, None) == []


async def test_notify_resolve_tts_and_event_text(hass, _):
    from custom_components.necromancer.core.notify import _resolve

    # TTS: number as "von", not a slash; message = "name: text", event_text = text only
    msg, ev = _resolve("de", "G", "recovery_attempt", {"attempt": 1, "max": 2})
    assert (
        ev == "Reparaturversuch 1 von 2." and msg == "G: Reparaturversuch 1 von 2."
    ), (msg, ev)
    # plural-correct attempts (de), dative after "nach"; the `attempts` variable
    # itself keeps the plain plural for user templates
    p1, p3 = {"attempt": 1}, {"attempt": 3}
    _m, a1 = _resolve("de", "G", "recovery_failed", p1)
    _m, a3 = _resolve("de", "G", "recovery_failed", p3)
    assert a1 == "Reparatur fehlgeschlagen nach 1 Versuch.", a1
    assert a3 == "Reparatur fehlgeschlagen nach 3 Versuchen.", a3
    assert p3["attempts"] == "3 Versuche" and "attempts_dative" not in p3, p3
    # plural-correct attempts (en)
    _m, e1 = _resolve("en", "G", "recovery_failed", {"attempt": 1})
    assert "1 attempt" in e1 and "attempts" not in e1, e1
    # unknown language -> english fallback
    _m, efb = _resolve("xx", "G", "recovery_success", {})
    assert efb == "Recovery succeeded.", efb


async def test_notify_custom(hass, _):
    """async_notify_custom passes the documented notify variables to the action."""
    from custom_components.necromancer.core.notify import async_notify_custom

    calls = async_mock_service(hass, "test", "notify_sink")
    action = [
        {
            "action": "test.notify_sink",
            "data": {
                "message": "{{ message }}",
                "name": "{{ name }}",
                "event_text": "{{ event_text }}",
                "event": "{{ event }}",
                # no `| default` — the integration must supply "" so this never errors
                "attempt": "{{ attempt }}",
                "attempts": "{{ attempts }}",
                "max": "{{ max }}",
                "reason": "{{ reason }}",
            },
        }
    ]
    # minimal: unset optionals arrive as "" (no | default needed), event_text = message
    await async_notify_custom(hass, "Markise", action, "Lege hart nach")
    await hass.async_block_till_done()
    d = calls[0].data
    assert d["message"] == "Lege hart nach" and d["event_text"] == "Lege hart nach", d
    assert d["name"] == "Markise" and d["event"] == "custom", d
    assert d["attempt"] == "" and d["attempts"] == "" and d["max"] == "", d
    assert d["reason"] == "", d
    # explicit event_text + attempt + max -> attempts derived (plural-correct, en)
    await async_notify_custom(
        hass,
        "Markise",
        action,
        "Härter",
        event="retry",
        event_text="nur Text",
        attempt=2,
        max=2,
    )
    await hass.async_block_till_done()
    d2 = calls[1].data
    assert d2["event_text"] == "nur Text" and d2["event"] == "retry", d2
    assert d2["attempt"] == 2 and d2["max"] == 2 and d2["attempts"] == "2 attempts", d2
    # no action configured -> silent no-op
    await async_notify_custom(hass, "Markise", None, "x")
    await hass.async_block_till_done()
    assert len(calls) == 2, calls


async def test_notify_full_variable_set(hass, _):
    """Every notify path always passes the exact same variable set (>= "" each).

    Locks the contract that a notify action template can reference any documented
    variable without a `| default` guard, across every lifecycle event and the
    custom (notify_guard) path. Captures the variables dict handed to the action.
    """
    from custom_components.necromancer.const import NOTIFY_MESSAGES
    import custom_components.necromancer.core.notify as notify_mod

    # health_detail is the only new action variable of the heartbeat source; the
    # detail placeholders (since, period, code) are rendered, never exposed.
    full = {
        "message",
        "name",
        "event_text",
        "event",
        "attempt",
        "max",
        "attempts",
        "reason",
        "health_detail",
    }
    captured: list[dict] = []

    async def _cap(_hass, _action, _name, variables=None):
        captured.append(dict(variables or {}))
        return {}

    orig = notify_mod.async_run
    notify_mod.async_run = _cap
    try:
        action = [{"action": "test.sink"}]
        # built-in path: every lifecycle event delivers exactly the full set
        for key in NOTIFY_MESSAGES["en"]:
            captured.clear()
            await notify_mod.async_notify(hass, "G", action, key)
            await hass.async_block_till_done()
            assert captured and set(captured[0]) == full, (key, captured)
        # custom path (notify_guard): same full set, unset optionals are ""
        captured.clear()
        await notify_mod.async_notify_custom(hass, "G", action, "hi")
        await hass.async_block_till_done()
        assert set(captured[0]) == full, captured[0]
        assert captured[0]["reason"] == "" and captured[0]["attempt"] == "", captured[0]
        assert captured[0]["health_detail"] == "", captured[0]
        # attempts is derived from attempt on the custom path too
        captured.clear()
        await notify_mod.async_notify_custom(hass, "G", action, "hi", attempt=3)
        await hass.async_block_till_done()
        assert captured[0]["attempts"] == "3 attempts", captured[0]
    finally:
        notify_mod.async_run = orig


async def test_policy_reasons(hass, _):
    from custom_components.necromancer.const import REASON_AUTO_OFF, REASON_OBSERVE
    from custom_components.necromancer.core.policies.notify import NotifyPolicy
    from custom_components.necromancer.core.policies.standard import StandardPolicy

    assert StandardPolicy({}).should_attempt(auto_enabled=True) == (True, "")
    assert StandardPolicy({}).should_attempt(auto_enabled=False) == (
        False,
        REASON_AUTO_OFF,
    )
    assert NotifyPolicy({}).should_attempt(auto_enabled=True) == (False, REASON_OBSERVE)
    assert REASON_AUTO_OFF == "auto_off"  # english, no more "auto_aus"


async def test_template_referenced_entities(hass, _):
    h = create_health(
        hass, {"type": "template", "template": "{{ is_state('sensor.foo', 'on') }}"}
    )
    assert "sensor.foo" in h.referenced_entities(), h.referenced_entities()


# ---------------- core/drivers/action_cycle: off → on variable scope ----------------


async def test_action_cycle_passes_off_vars_to_on(hass, _):
    """A `variables:` set in the off action is readable in the on action."""
    calls = async_mock_service(hass, "test", "cycle_vars")
    drv = create_driver(
        hass,
        {
            "type": "action_cycle",
            "off_on_delay": 0,
            "off_action": [{"variables": {"marker": "carried"}}],
            "on_action": [{"action": "test.cycle_vars", "data": {"v": "{{ marker }}"}}],
        },
    )
    await drv.recover()
    await hass.async_block_till_done()
    assert len(calls) == 1, calls
    assert calls[0].data["v"] == "carried", calls[0].data


async def test_action_cycle_no_vars_backward_compatible(hass, _):
    """Without a `variables:` carry-over, both phases still run as before."""
    calls = async_mock_service(hass, "test", "cycle_plain")
    drv = create_driver(
        hass,
        {
            "type": "action_cycle",
            "off_on_delay": 0,
            "off_action": [{"action": "test.cycle_plain", "data": {"phase": "off"}}],
            "on_action": [{"action": "test.cycle_plain", "data": {"phase": "on"}}],
        },
    )
    await drv.recover()
    await hass.async_block_till_done()
    assert [c.data["phase"] for c in calls] == ["off", "on"], calls


async def test_async_run_returns_vars_without_context(hass, _):
    """Returned scope carries real variables, not HA's injected run `context`."""
    out = await async_run(hass, [{"variables": {"x": "1"}}], "ctxprobe")
    assert out.get("x") == "1", out
    assert "context" not in out, out


async def test_action_cycle_seeds_engine_vars(hass, _):
    """Engine vars passed to recover() are readable in both off and on phases."""
    calls = async_mock_service(hass, "test", "cycle_seed")
    drv = create_driver(
        hass,
        {
            "type": "action_cycle",
            "off_on_delay": 0,
            "off_action": [
                {"action": "test.cycle_seed", "data": {"a": "{{ attempt }}"}}
            ],
            "on_action": [
                {"action": "test.cycle_seed", "data": {"a": "{{ attempt }}"}}
            ],
        },
    )
    await drv.recover(
        {"attempt": 2, "max": 3, "name": "X", "guard_entity_id": "sensor.x"}
    )
    await hass.async_block_till_done()
    assert [c.data["a"] for c in calls] == [2, 2], calls


async def test_action_call_seeds_engine_vars(hass, _):
    """Engine vars passed to recover() are readable in an action_call recovery."""
    calls = async_mock_service(hass, "test", "call_seed")
    drv = create_driver(
        hass,
        {
            "type": "action_call",
            "action": [{"action": "test.call_seed", "data": {"a": "{{ attempt }}"}}],
        },
    )
    await drv.recover({"attempt": 5})
    await hass.async_block_till_done()
    assert calls[0].data["a"] == 5, calls[0].data


async def test_action_call_recover_failed_var(hass, _):
    """An action that sets `recover_failed` makes the driver report failure."""
    drv = create_driver(
        hass,
        {"type": "action_call", "action": [{"variables": {"recover_failed": True}}]},
    )
    assert await drv.recover() is False


async def test_action_call_clean_run_is_good(hass, _):
    """An action that doesn't flag failure reports good."""
    calls = async_mock_service(hass, "test", "ok_run")
    drv = create_driver(
        hass, {"type": "action_call", "action": [{"action": "test.ok_run"}]}
    )
    assert await drv.recover() is True
    assert len(calls) == 1


# ---------------- core/health/heartbeat (pure functions + source) ----------------

_HB_T0 = datetime(2026, 11, 21, 3, 0, tzinfo=UTC)
_HB_TOKEN = "a1" * 32  # 64 hex chars, the shape secrets.token_hex(32) produces
_HB_CFG = {"type": "heartbeat", "token": _HB_TOKEN, "period": 86400}


def _hb_at(seconds: float) -> datetime:
    return _HB_T0 + timedelta(seconds=seconds)


def _hb_armed() -> dict:
    return hb.reconcile_token({}, _HB_TOKEN, _HB_T0)[0]


async def test_heartbeat_evaluate_table(hass, _):
    """Every row of the evaluation table, in order; deadline = basis + period.

    The grace after a missed ping is the engine's debounce, not part of the verdict.
    """
    frist = 86400
    armed = _hb_armed()
    ok_at_0 = hb.apply_ping(armed, True, None, _HB_T0)
    fail_new = hb.apply_ping(armed, False, "3", _hb_at(10))
    fail_after_ok = hb.apply_ping(ok_at_0, False, "TERM", _hb_at(60))
    cases = [
        # (name, state, now, health, detail key, detail params)
        ("waiting", armed, _hb_at(60), Health.UNKNOWN, "heartbeat_waiting", {}),
        (
            "waiting on deadline",
            armed,
            _hb_at(frist),
            Health.UNKNOWN,
            "heartbeat_waiting",
            {},
        ),
        (
            "never",
            armed,
            _hb_at(frist + 1),
            Health.UNHEALTHY,
            "heartbeat_never",
            {"since": frist + 1},
        ),
        (
            "only a failure",
            fail_new,
            _hb_at(20),
            Health.UNHEALTHY,
            "heartbeat_failed",
            {"code": "3"},
        ),
        (
            "fail after ok",
            fail_after_ok,
            _hb_at(61),
            Health.UNHEALTHY,
            "heartbeat_failed",
            {"code": "TERM"},
        ),
        (
            "fail without code",
            hb.apply_ping(ok_at_0, False, None, _hb_at(5)),
            _hb_at(6),
            Health.UNHEALTHY,
            "heartbeat_failed",
            {"code": None},
        ),
        ("ok", ok_at_0, _hb_at(60), Health.OK, None, None),
        ("exactly on deadline", ok_at_0, _hb_at(frist), Health.OK, None, None),
        (
            "overdue",
            ok_at_0,
            _hb_at(frist + 3600),
            Health.UNHEALTHY,
            "heartbeat_overdue",
            {"since": frist + 3600, "period": 86400},
        ),
        (
            "ok after fail",
            hb.apply_ping(fail_after_ok, True, None, _hb_at(120)),
            _hb_at(121),
            Health.OK,
            None,
            None,
        ),
    ]
    for name, state, now, health, key, params in cases:
        got, detail = hb.evaluate(state, _HB_CFG, now)
        assert got is health, (name, got)
        if key is None:
            assert detail is None, (name, detail)
        else:
            assert detail == (key, params), (name, detail)
    # A failure keeps last_ok (the basis), and a success clears the code again.
    assert fail_after_ok["last_ok"] == ok_at_0["last_ok"]
    recovered = hb.apply_ping(fail_after_ok, True, None, _hb_at(120))
    assert recovered["last_code"] is None and recovered["last_status"] == "ok"
    # The default period applies when it is absent (1 day).
    assert hb.next_deadline(ok_at_0, {}) == _hb_at(86400)
    # A `grace` left in a stored config (dev data) is ignored, without error.
    legacy = {**_HB_CFG, "grace": 7200}
    assert hb.next_deadline(ok_at_0, legacy) == _hb_at(frist)
    assert hb.evaluate(ok_at_0, legacy, _hb_at(frist + 1))[0] is Health.UNHEALTHY
    # No deadline after a failure (UNHEALTHY regardless of time).
    assert hb.next_deadline(fail_after_ok, _HB_CFG) is None
    # Changing the period only moves the deadline, it resets nothing.
    assert (
        hb.evaluate(ok_at_0, {**_HB_CFG, "period": 60}, _hb_at(61))[0]
        is Health.UNHEALTHY
    )


async def test_heartbeat_no_basis_and_datetime_values(hass, _):
    """No basis at all -> no deadline, waiting; datetimes count like ISO strings."""
    for state in ({}, {"last_status": "ok"}, {"armed_at": None, "last_ok": None}):
        assert hb.next_deadline(state, _HB_CFG) is None, state
        assert hb.evaluate(state, _HB_CFG, _hb_at(10**7)) == (
            Health.UNKNOWN,
            ("heartbeat_waiting", {}),
        ), state
    # A state holding datetime objects (not yet through the Store's JSON).
    as_dt = {"armed_at": _HB_T0, "last_ok": _hb_at(10), "last_status": "ok"}
    as_iso = hb.apply_ping(_hb_armed(), True, None, _hb_at(10))
    assert hb.next_deadline(as_dt, _HB_CFG) == _hb_at(10 + 86400)
    assert hb.next_deadline(as_dt, _HB_CFG) == hb.next_deadline(as_iso, _HB_CFG)
    late = _hb_at(10 + 86400 + 3600)
    assert hb.evaluate(as_dt, _HB_CFG, late) == hb.evaluate(as_iso, _HB_CFG, late)
    assert hb.evaluate(as_dt, _HB_CFG, late)[1] == (
        "heartbeat_overdue",
        {"since": 86400 + 3600, "period": 86400},
    )
    never = {"armed_at": _HB_T0}
    assert hb.evaluate(never, _HB_CFG, _hb_at(86401))[1] == (
        "heartbeat_never",
        {"since": 86401},
    )


async def test_heartbeat_restart_has_no_grace(hass, _):
    """Evaluation knows no restart: overdue stays overdue, a late retry makes it OK."""
    state = hb.apply_ping(_hb_armed(), True, None, _HB_T0)
    # Stored before the stop, already overdue -> UNHEALTHY right after the start.
    restored = json.loads(json.dumps(state))  # round-trip through the Store's JSON
    assert hb.evaluate(restored, _HB_CFG, _hb_at(100000))[0] is Health.UNHEALTHY
    # Deadline passed during the outage -> UNHEALTHY after the start.
    assert hb.evaluate(restored, _HB_CFG, _hb_at(86400 + 1))[0] is Health.UNHEALTHY
    # The sender's retry arrives afterwards -> OK.
    retried = hb.apply_ping(restored, True, None, _hb_at(100060))
    assert hb.evaluate(retried, _HB_CFG, _hb_at(100061))[0] is Health.OK


async def test_heartbeat_parse_status(hass, _):
    """Missing/ok/0 = success; everything else fails, code kept only if harmless."""
    for raw in (None, "ok", "OK", "Ok", "0"):
        assert hb.parse_status(raw) == (True, None), raw
    for raw in ("fail", "FAIL", "", "RTMIN 3", "a;b", "x" * 20, "3\n"):
        assert hb.parse_status(raw) == (False, None), raw
    for raw in ("3", "255", "TERM", "start", "x" * 16, "core-dump_1"):
        assert hb.parse_status(raw) == (False, raw), raw


async def test_heartbeat_token_fp_and_slug(hass, _):
    """Fingerprint is stable and hides the token; the slug's name part is ignored."""
    fp = hb.token_fp(_HB_TOKEN)
    assert fp == hb.token_fp(_HB_TOKEN) and len(fp) == 12
    assert fp != hb.token_fp("b2" * 32)
    assert _HB_TOKEN not in fp and fp not in _HB_TOKEN
    assert hb.token_from_slug(f"pve_sicherung_{_HB_TOKEN}") == _HB_TOKEN
    assert hb.token_from_slug(f"other-name_{_HB_TOKEN}") == _HB_TOKEN  # renamed guard
    assert hb.token_from_slug(_HB_TOKEN) == _HB_TOKEN  # bare token
    for slug in (None, "", "name_"):
        assert hb.token_from_slug(slug) is None, slug
    # The path the flow shows round-trips through the view's token lookup.
    path = hb.ping_path("PVE Sicherung", _HB_TOKEN)
    assert path == f"/api/necromancer/heartbeat/pve_sicherung_{_HB_TOKEN}"
    assert hb.token_from_slug(path.rpartition("/")[2]) == _HB_TOKEN
    bare = hb.ping_path("", _HB_TOKEN)
    assert bare == f"/api/necromancer/heartbeat/{_HB_TOKEN}"
    assert hb.token_from_slug(bare.rpartition("/")[2]) == _HB_TOKEN


async def test_heartbeat_reconcile_token(hass, _):
    """Same token keeps everything; missing/other fingerprint resets to armed-now."""
    state = hb.apply_ping(_hb_armed(), False, "3", _hb_at(10))
    same, changed = hb.reconcile_token(state, _HB_TOKEN, _hb_at(99))
    assert not changed and same == state
    new_token = "c3" * 32
    reset, changed = hb.reconcile_token(state, new_token, _hb_at(99))
    assert changed
    assert reset["armed_at"] == _hb_at(99).isoformat()
    assert reset["token_fp"] == hb.token_fp(new_token)
    assert all(
        reset[k] is None for k in ("last_ping", "last_ok", "last_status", "last_code")
    )
    assert hb.evaluate(reset, _HB_CFG, _hb_at(100))[1] == ("heartbeat_waiting", {})
    fresh, changed = hb.reconcile_token({}, _HB_TOKEN, _HB_T0)
    assert changed and fresh["token_fp"] == hb.token_fp(_HB_TOKEN)


async def test_heartbeat_registry_rate_limit_and_lifecycle(hass, _):
    """5 pings per 10 s per token; rebuild/activate/deactivate/unload/remove states."""
    from custom_components.necromancer.core import heartbeat_registry as hr

    reg = hr.HeartbeatRegistry()
    entry = hr.HeartbeatEntry(state=hr.STATE_ACTIVE)
    assert [entry.allow(100.0 + i) for i in range(6)] == [True] * 5 + [False]
    assert not entry.allow(109.9)  # still inside the window; rejection not counted
    assert entry.allow(110.0)  # the first hit aged out
    # Separate guards have separate budgets.
    other = hr.HeartbeatEntry(state=hr.STATE_ACTIVE)
    assert other.allow(105.0)

    t_a, t_b, t_c = "a" * 64, "b" * 64, "c" * 64
    reg.rebuild(
        "E1",
        [
            hr.HeartbeatSpec(t_a, "sa"),
            hr.HeartbeatSpec(
                t_b, "sb", local_only=False, dormant=True, dormant_apply=print
            ),
        ],
    )
    assert reg.lookup(t_a).state == hr.STATE_WAITING
    assert (
        reg.lookup(t_b).state == hr.STATE_DORMANT
        and reg.lookup(t_b).dormant_apply is print
    )
    assert (
        reg.lookup(t_c) is None and reg.lookup(None) is None and reg.lookup("") is None
    )

    src = create_health(hass, {**_HB_CFG, "token": t_a, "local_only": False})
    reg.activate(t_a, src)
    assert reg.lookup(t_a).state == hr.STATE_ACTIVE and reg.lookup(t_a).source is src
    assert reg.lookup(t_a).local_only is False
    for _i in range(3):
        reg.lookup(t_a).allow(200.0)
    # Rebuild (reload) keeps the rate window but drops the source and removed tokens.
    reg.rebuild("E1", [hr.HeartbeatSpec(t_a, "sa")])
    assert reg.lookup(t_a).state == hr.STATE_WAITING and reg.lookup(t_a).source is None
    assert len(reg.lookup(t_a).hits) == 3
    assert reg.lookup(t_b) is None
    # A stale unsub of an old source does not knock out the new one.
    new_src = create_health(hass, {**_HB_CFG, "token": t_a})
    reg.activate(t_a, new_src)
    reg.deactivate(t_a, src)
    assert reg.lookup(t_a).source is new_src
    reg.deactivate(t_a, new_src)
    assert reg.lookup(t_a).state == hr.STATE_WAITING
    # Unload -> waiting (dormant too); remove -> unknown. Other entries untouched.
    reg.rebuild("E1", [hr.HeartbeatSpec(t_a, "sa", dormant=True, dormant_apply=print)])
    reg.rebuild("E2", [hr.HeartbeatSpec(t_c, "sc")])
    reg.set_entry_waiting("E1")
    assert (
        reg.lookup(t_a).state == hr.STATE_WAITING
        and reg.lookup(t_a).dormant_apply is None
    )
    reg.remove_entry("E1")
    assert reg.lookup(t_a) is None and reg.lookup(t_c) is not None
    assert reg.tokens() == [t_c] and reg.tokens("E2") == [t_c]
    # The shared table lives in hass.data and is created once.
    assert hr.HeartbeatRegistry.get(hass) is hr.HeartbeatRegistry.get(hass)


async def test_heartbeat_source_lifecycle(hass, _):
    """Setup -> active + timer; ping persists/notifies; unsub closes and goes waiting."""
    from custom_components.necromancer.core import heartbeat_registry as hr

    token = "d4" * 32
    src = create_health(hass, {**_HB_CFG, "token": token})
    assert src.watched_entities == [] and src.referenced_entities() == []
    assert src.describe() == "heartbeat" and src.health_source == "heartbeat"
    assert src.local_only is True  # default
    # Fresh source: waiting, and the armed state is flushed once save is bound.
    assert src.evaluate() is Health.UNKNOWN
    assert src.detail() == ("heartbeat_waiting", {})
    assert src.confirmed() is False  # waiting is no finding at all
    assert src.period == 86400
    saves, changes = [], []
    src.bind_persist(lambda: saves.append(1))
    assert len(saves) == 1
    # Not open before async_setup.
    try:
        await src.async_handle_ping(True, None)
    except hb.HeartbeatClosedError:
        pass
    else:
        raise AssertionError("ping before async_setup must be refused")

    unsub = await src.async_setup(lambda: changes.append(1))
    reg = hr.HeartbeatRegistry.get(hass)
    assert (
        reg.lookup(token).state == hr.STATE_ACTIVE and reg.lookup(token).source is src
    )
    assert src._unsub_timer is not None  # armed on the waiting deadline

    assert await src.async_handle_ping(True, None) is Health.OK
    assert len(saves) == 2 and changes == [1] and src.detail() is None
    assert src._unsub_timer is not None
    assert src.confirmed() is False
    assert await src.async_handle_ping(False, "3") is Health.UNHEALTHY
    assert src.detail() == ("heartbeat_failed", {"code": "3"})
    # A reported failure is unambiguous: the engine skips the debounce for it.
    assert src.confirmed() is True
    assert src._unsub_timer is None  # no deadline while failed
    await src.async_handle_ping(True, None)
    assert src.confirmed() is False
    # The deadline fires: the engine re-evaluates; a past deadline is not re-armed.
    late = dt_util.utcnow() + timedelta(seconds=86400 + 5)
    with patch("homeassistant.util.dt.utcnow", return_value=late):
        src._deadline_passed(late)
        assert src.evaluate() is Health.UNHEALTHY
        assert src.detail()[0] == "heartbeat_overdue"
        # Overdue is a missed ping: it waits out the debounce (the grace).
        assert src.confirmed() is False
    assert src._unsub_timer is None and changes[-1] == 1 and len(changes) == 4

    snap = src.snapshot()
    assert snap["token_fp"] == hb.token_fp(token) and token not in json.dumps(snap)
    unsub()
    assert (
        reg.lookup(token).state == hr.STATE_WAITING and reg.lookup(token).source is None
    )
    try:
        await src.async_handle_ping(True, None)
    except hb.HeartbeatClosedError:
        pass
    else:
        raise AssertionError("ping after unsub must be refused")
    assert src.snapshot() == snap  # a refused ping leaves the state alone

    # restore(): same token keeps state (no save), another token resets and saves.
    again = create_health(hass, {**_HB_CFG, "token": token})
    assert again.restore(snap) is False and again.snapshot() == snap
    again_saves = []
    again.bind_persist(lambda: again_saves.append(1))
    assert again_saves == []
    regen = create_health(hass, {**_HB_CFG, "token": "e5" * 32})
    regen_saves = []
    regen.bind_persist(lambda: regen_saves.append(1))
    assert regen.restore(snap) is True and len(regen_saves) == 2
    assert regen.detail() == ("heartbeat_waiting", {})
    # Other sources keep the no-op hooks.
    plain = create_health(hass, {"type": "template", "template": "{{ true }}"})
    assert plain.snapshot() == {} and plain.restore({"x": 1}) is False
    assert plain.detail() is None and plain.bind_persist(print) is None
    assert plain.confirmed() is False


async def test_heartbeat_closed_source_arms_and_reports_nothing(hass, _):
    """After its unsub the source arms no timer and no longer calls the engine.

    A deadline callback already queued when the source closed (reload) must not
    reach the stopped engine nor leave a new timer behind.
    """
    src = create_health(hass, {**_HB_CFG, "token": "c7" * 32})
    src._arm()  # closed until async_setup
    assert src._unsub_timer is None
    changes = []
    unsub = await src.async_setup(lambda: changes.append(1))
    assert src._unsub_timer is not None
    unsub()
    assert src._unsub_timer is None
    src._arm()
    assert src._unsub_timer is None
    late = dt_util.utcnow() + timedelta(seconds=86400 + 5)
    with patch("homeassistant.util.dt.utcnow", return_value=late):
        src._deadline_passed(late)
    assert changes == [] and src._unsub_timer is None


async def test_heartbeat_fault_since(hass, _):
    """fault_since(): the passed deadline while overdue, None otherwise.

    The engine counts the debounce (the grace) from it, so it must come from the
    stored state alone and be the same before and after a reload/restart.
    """
    src = create_health(hass, {**_HB_CFG, "token": "f6" * 32})
    period = timedelta(seconds=src.period)
    t0 = dt_util.utcnow()
    armed = hb.reconcile_token({}, src.token, t0)[0]

    def at(when):
        return patch("homeassistant.util.dt.utcnow", return_value=when)

    # Never succeeded: waiting is no fault; past armed_at + period it is overdue
    # since exactly then (evaluate() is strict, so the deadline itself is OK).
    src.restore(armed)
    with at(t0 + period):
        assert src.evaluate() is Health.UNKNOWN and src.fault_since() is None
    with at(t0 + period + timedelta(seconds=5)):
        assert src.fault_since() == t0 + period
    # A success moves the basis; overdue since last_ok + period.
    t1 = t0 + timedelta(seconds=10)
    pinged = hb.apply_ping(armed, True, None, t1)
    src.restore(pinged)
    with at(t1 + period):
        assert src.evaluate() is Health.OK and src.fault_since() is None
    with at(t1 + period * 3):
        assert src.evaluate() is Health.UNHEALTHY
        assert src.fault_since() == t1 + period
    # A reported failure skips the debounce anyway (confirmed): no start needed.
    src.restore(hb.apply_ping(pinged, False, "3", t1))
    with at(t1 + period * 3):
        assert src.confirmed() is True and src.fault_since() is None
    # Sources without own state keep the default: no known start.
    plain = create_health(hass, {"type": "template", "template": "{{ false }}"})
    assert plain.fault_since() is None


async def test_detail_messages_symmetric(hass, _):
    """DETAIL_MESSAGES covers the four heartbeat keys in de and en, no parentheses."""
    from custom_components.necromancer.const import DETAIL_CODE_PHRASES, DETAIL_MESSAGES

    keys = {
        "heartbeat_overdue",
        "heartbeat_failed",
        "heartbeat_never",
        "heartbeat_waiting",
    }
    assert set(DETAIL_MESSAGES) == {"de", "en"} == set(DETAIL_CODE_PHRASES)
    for lang, table in DETAIL_MESSAGES.items():
        assert set(table) == keys, lang
        for text in table.values():
            assert "(" not in text and ")" not in text, text  # TTS rule
        assert set(DETAIL_CODE_PHRASES[lang]) == {"exit", "word"}


async def test_services_yaml_mirrors_en_json(hass, _):
    """services.yaml carries the English names/descriptions of translations/en.json.

    The frontend shows the translations; the services API (and every agent or MCP
    server reading it) only sees services.yaml. Both must say the same.
    """
    from pathlib import Path

    import yaml

    import custom_components.necromancer as pkg

    base = Path(pkg.__file__).parent
    services = yaml.safe_load((base / "services.yaml").read_text(encoding="utf-8"))
    en = json.loads((base / "translations/en.json").read_text(encoding="utf-8"))
    tr = en["services"]
    assert set(services) == set(tr)
    for name, svc in services.items():
        for key in ("name", "description"):
            assert svc.get(key) == tr[name].get(key), f"{name}.{key}"
        fields = svc.get("fields") or {}
        assert set(fields) == set(tr[name].get("fields", {})), name
        for field, spec in fields.items():
            for key in ("name", "description"):
                assert spec.get(key) == tr[name]["fields"][field].get(key), (
                    f"{name}.{field}.{key}"
                )


async def test_format_duration(hass, _):
    """de/en, singular/plural, German dative after seit/vor, rounding boundaries."""
    from custom_components.necromancer.core.notify import _format_duration as fd

    # minutes below 2 h (at least 1), hours below 2 days, days beyond
    assert fd("en", 0) == "1 minute" and fd("en", 89) == "1 minute"
    assert fd("en", 90) == "2 minutes" and fd("en", 7199) == "120 minutes"
    assert fd("en", 7200) == "2 hours" and fd("en", 26 * 3600) == "26 hours"
    assert fd("en", 2 * 86400 - 1) == "48 hours" and fd("en", 2 * 86400) == "2 days"
    assert fd("en", 86400) == "24 hours" and fd("en", 7 * 86400) == "7 days"
    # German: minutes/hours do not inflect, days do (dative plural "Tagen")
    assert fd("de", 60) == "1 Minute" and fd("de", 600, dative=True) == "10 Minuten"
    assert fd("de", 3 * 3600, dative=True) == "3 Stunden"
    assert fd("de", 7 * 86400) == "7 Tage"  # "alle 7 Tage"
    assert fd("de", 3 * 86400, dative=True) == "3 Tagen"  # "seit 3 Tagen"
    assert fd("de", 2 * 86400 + 3600, dative=True) == "2 Tagen"
    assert fd("en", 2.4 * 86400) == "2 days" and fd("de", 2.6 * 86400) == "3 Tage"
    assert fd("xx", 120) == "2 minutes"  # any other language -> English forms


async def test_render_detail(hass, _):
    """Every DETAIL_MESSAGES key renders with the params detail() produces."""
    from custom_components.necromancer.const import DETAIL_MESSAGES
    from custom_components.necromancer.core.notify import render_detail

    armed = _hb_armed()
    ok_at_0 = hb.apply_ping(armed, True, None, _HB_T0)
    # (state, now) per key, straight from evaluate() — so a param the renderer
    # does not know would fail here, not in an alarm.
    produced = {
        "heartbeat_waiting": hb.evaluate(armed, _HB_CFG, _hb_at(60))[1],
        "heartbeat_never": hb.evaluate(armed, _HB_CFG, _hb_at(3 * 86400))[1],
        "heartbeat_overdue": hb.evaluate(ok_at_0, _HB_CFG, _hb_at(26 * 3600 + 1))[1],
        "heartbeat_failed": hb.evaluate(
            hb.apply_ping(ok_at_0, False, "3", _hb_at(5)), _HB_CFG, _hb_at(6)
        )[1],
    }
    assert set(produced) == set(DETAIL_MESSAGES["en"])
    for lang in DETAIL_MESSAGES:
        for key, detail in produced.items():
            text = render_detail(lang, detail)
            assert text and "{" not in text and "None" not in text, (lang, key, text)
    assert render_detail("de", produced["heartbeat_overdue"]) == (
        "Kein Lebenszeichen seit 26 Stunden, erwartet alle 24 Stunden."
    )
    assert render_detail("de", produced["heartbeat_never"]) == (
        "Noch nie erfolgreich gemeldet, eingerichtet vor 3 Tagen."
    )
    assert render_detail("en", produced["heartbeat_never"]) == (
        "Never reported success, set up 3 days ago."
    )
    weekly = hb.evaluate(ok_at_0, {**_HB_CFG, "period": 7 * 86400}, _hb_at(10 * 86400))[
        1
    ]
    assert render_detail("de", weekly) == (
        "Kein Lebenszeichen seit 10 Tagen, erwartet alle 7 Tage."
    )
    # the code clause: digits = exit code, a word = code, none = nothing
    fail = ("heartbeat_failed", {"code": "3"})
    assert render_detail("de", fail) == "Fehler gemeldet, Exit-Code 3."
    assert render_detail("en", fail) == "Failure reported, exit code 3."
    assert (
        render_detail("de", ("heartbeat_failed", {"code": "TERM"}))
        == "Fehler gemeldet, Code TERM."
    )
    assert render_detail("de", ("heartbeat_failed", {"code": None})) == (
        "Fehler gemeldet."
    )
    # no detail / unknown key / unknown language
    assert render_detail("de", None) == "" and render_detail("de", ("nope", {})) == ""
    assert render_detail("xx", fail) == "Failure reported, exit code 3."


async def test_notify_appends_health_detail(hass, _):
    """health_detail is a second sentence of message/event_text; event unchanged."""
    from custom_components.necromancer.core.notify import _resolve

    params = {"attempt": 2, "health_detail": "Fehler gemeldet, Exit-Code 3."}
    msg, ev = _resolve("de", "pve-sicherung", "recovery_failed", params)
    first = "Reparatur fehlgeschlagen nach 2 Versuchen."  # dative after "nach"
    assert ev == f"{first} Fehler gemeldet, Exit-Code 3.", ev
    assert msg == f"pve-sicherung: {ev}", msg
    # empty detail -> text unchanged (other sources)
    _m, plain = _resolve("de", "G", "problem_detected", {"health_detail": ""})
    assert plain == "Problem erkannt.", plain


# ---------------- problem_cleared: the "back to normal" toggle + text ----------------


async def test_notify_problem_cleared_texts(hass, _):
    """Spoken duration after "nach" (German dative); no duration -> short text."""
    from custom_components.necromancer.core.notify import _resolve

    day = 86400
    cases = [
        ("en", 26 * 3600, "Back to normal after 26 hours."),
        ("de", 26 * 3600, "Wieder in Ordnung nach 26 Stunden."),
        ("de", 3 * day, "Wieder in Ordnung nach 3 Tagen."),  # dative, not "3 Tage"
        ("en", 3 * day, "Back to normal after 3 days."),
        ("de", 60, "Wieder in Ordnung nach 1 Minute."),
        ("de", 3600, "Wieder in Ordnung nach 60 Minuten."),
        ("xx", 26 * 3600, "Back to normal after 26 hours."),  # English fallback
    ]
    for lang, seconds, text in cases:
        params: dict = {}
        msg, ev = _resolve(lang, "Backup", "problem_cleared", params, duration=seconds)
        assert ev == text and msg == f"Backup: {text}", (lang, seconds, msg, ev)
        assert "duration" not in params, params  # never leaks into the variables
    # unknown start (stored by an older version) -> the no-duration variant
    assert _resolve("en", "G", "problem_cleared", {})[1] == "Back to normal."
    assert _resolve("de", "G", "problem_cleared", {})[1] == "Wieder in Ordnung."
    assert _resolve("xx", "G", "problem_cleared", {})[1] == "Back to normal."
    # other events are not affected by the variant table
    assert _resolve("de", "G", "problem_detected", {})[1] == "Problem erkannt."


async def test_notify_problem_cleared_variables(hass, _):
    """The event is problem_cleared with or without a duration; same variables."""
    import custom_components.necromancer.core.notify as notify_mod

    full = {
        "message",
        "name",
        "event_text",
        "event",
        "attempt",
        "max",
        "attempts",
        "reason",
        "health_detail",
    }
    captured: list[dict] = []

    async def _cap(_hass, _action, _name, variables=None):
        captured.append(dict(variables or {}))
        return {}

    orig = notify_mod.async_run
    notify_mod.async_run = _cap
    try:
        action = [{"action": "test.sink"}]
        await notify_mod.async_notify(
            hass, "G", action, "problem_cleared", duration=26 * 3600
        )
        await notify_mod.async_notify(hass, "G", action, "problem_cleared")
        await hass.async_block_till_done()
        assert [v["event"] for v in captured] == ["problem_cleared"] * 2, captured
        assert all(set(v) == full for v in captured), captured
        assert captured[0]["message"] == "G: Back to normal after 26 hours."
        assert captured[1]["message"] == "G: Back to normal."
    finally:
        notify_mod.async_run = orig


def _section_default(schema_dict: dict, section_key: str, field: str):
    """The default of `field` inside the section `section_key` of a schema dict."""
    for key, value in schema_dict.items():
        if str(key) == section_key:
            for inner in value.schema.schema:
                if str(inner) == field:
                    return inner.default()
    raise AssertionError(f"{section_key}.{field} not in schema")


async def test_notify_cleared_form_defaults(hass, _):
    """On for a new guard; reconfigure shows the stored value, legacy = off."""
    sec, key = cf.SECTION_NOTIFY, cf.CONF_NOTIFY_CLEARED
    assert _section_default(cf._notification_section({}), sec, key) is True
    legacy = {cf.CONF_BEHAVIOR: {cf.CONF_DEBOUNCE: 30}}
    d = cf._behavior_defaults(legacy)
    assert d[key] is False
    assert _section_default(cf._notification_section(d), sec, key) is False
    stored = {cf.CONF_BEHAVIOR: {cf.CONF_DEBOUNCE: 30, key: True}}
    d = cf._behavior_defaults(stored)
    assert _section_default(cf._notification_section(d), sec, key) is True
    # every strategy form carries the toggle (None = create -> on)
    for schema in (
        cf._switch_schema(),
        cf._action_schema(),
        cf._actions_schema(),
        cf._poe_schema(),
        cf._notify_schema(),
    ):
        assert _section_default(schema.schema, sec, key) is True


async def test_build_data_stores_notify_cleared(hass, _):
    """Always stored as a bool: recover, notify-only and heartbeat guards."""
    state1 = {
        cf.CONF_NAME: "N",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_TEMPLATE,
        cf.CONF_TEMPLATE: "{{ true }}",
    }
    hb1 = {
        cf.CONF_NAME: "Job",
        cf.CONF_SOURCE_TYPE: cf.SOURCE_HEARTBEAT,
        cf.CONF_TOKEN: _HB_TOKEN,
        cf.CONF_PERIOD: 3600,
    }
    recover2 = {
        cf.CONF_DEBOUNCE: 30,
        cf.CONF_COOLDOWN: 60,
        cf.CONF_BOOT_WINDOW: 90,
        cf.CONF_MAX_ATTEMPTS: 2,
        cf.CONF_ACTION: [{"action": "test.x"}],
    }
    for step1, strategy in (
        (state1, cf.MODE_NOTIFY),
        (state1, cf.STRATEGY_ACTION),
        (hb1, cf.MODE_NOTIFY),
        (hb1, cf.STRATEGY_ACTION),
    ):
        for value in (True, False):
            step2 = {
                **recover2,
                cf.SECTION_NOTIFY: {cf.CONF_NOTIFY_CLEARED: value},
            }
            behavior = cf._build_data(step1, step2, strategy)[cf.CONF_BEHAVIOR]
            assert behavior[cf.CONF_NOTIFY_CLEARED] is value, (strategy, behavior)
    # a submission without the field (never from the form) stores off, not missing
    behavior = cf._build_data(state1, {cf.CONF_DEBOUNCE: 30}, cf.MODE_NOTIFY)[
        cf.CONF_BEHAVIOR
    ]
    assert behavior[cf.CONF_NOTIFY_CLEARED] is False


async def test_translations_notify_cleared(hass, _):
    """Every notification section names the toggle and the back-to-normal case."""
    from pathlib import Path

    base = Path(cf.__file__).resolve().parent.parent / "translations"
    expect = {
        "en": ("or is back to normal", "Also notify when it's back to normal"),
        "de": (
            "Eskalation oder Entwarnung",
            "Auch melden, wenn es wieder in Ordnung ist",
        ),
    }
    for lang, (phrase, label) in expect.items():
        tr = json.loads((base / f"{lang}.json").read_text(encoding="utf-8"))
        steps = tr["config_subentries"]["device"]["step"]
        for step in ("switch", "action", "actions", "poe_port", "notify"):
            sec = steps[step]["sections"]["notification"]
            desc = sec["description"]
            assert phrase in desc and "health_detail" in desc, (lang, step)
            assert sec["data"][cf.CONF_NOTIFY_CLEARED] == label, (lang, step)
            help_text = sec["data_description"][cf.CONF_NOTIFY_CLEARED]
            assert "problem_cleared" in help_text, (lang, step)
            for text in (desc, help_text):
                assert "{" not in text and "}" not in text, (lang, step)


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


async def main() -> int:
    passed, failed = 0, 0
    async with async_test_home_assistant() as hass:
        for t in TESTS:
            try:
                await t(hass, None)
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL  {t.__name__}: {err!r}")
            else:
                passed += 1
                print(f"ok    {t.__name__}")
        await hass.async_stop()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
