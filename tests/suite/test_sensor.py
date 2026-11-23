"""Status sensor tests."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from freezegun.api import FrozenDateTimeFactory
import pytest

from homeassistant.core import CoreState, HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_component import async_update_entity
from homeassistant.util import dt as dt_util

from ._compat import MockConfigEntry, async_fire_time_changed
from .conftest import DOMAIN, SetupGuards, entity_id_for, make_guard


async def test_status_sensor_reflects_engine_state(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A healthy guard's status sensor reads 'ok' with the expected attributes."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Status Guard"))

    eid = entity_id_for(hass, "guard0", "sensor", "status")
    assert eid == "sensor.status_guard_status"
    state = hass.states.get(eid)
    assert state is not None
    assert state.state == "ok"
    assert set(state.attributes) >= {
        "guard_name",
        "health_entity",
        "auto_recovery_entity",
        "revive_entity",
        "recovery_event_entity",
        "attempt",
        "recover_count",
        "fail_count",
        "last_recover",
        "last_fail",
        "recover_driver",
        "last_recover_driver_result",
        "last_recover_driver_time",
        "snooze_until",
    }
    # auto_restart (use the switch) and last_seen are intentionally not attributes.
    assert "auto_restart" not in state.attributes
    assert "last_seen" not in state.attributes
    # guard_name carries the subentry title so dashboards can label guards generically.
    assert state.attributes["guard_name"] == "Status Guard"
    # Sibling entity_ids are resolved live from the unique_id, so they survive renames.
    assert state.attributes["health_entity"] == entity_id_for(
        hass, "guard0", "binary_sensor", "health"
    )
    assert state.attributes["auto_recovery_entity"] == entity_id_for(
        hass, "guard0", "switch", "auto_restart"
    )
    assert state.attributes["attempt"] == 0
    assert state.attributes["recover_count"] == 0


async def test_status_sensor_enum_device_class(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The status sensor is an enum sensor exposing all lifecycle states."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(make_guard("Enum Guard", strategy="notify"))

    eid = entity_id_for(hass, "guard0", "sensor", "status")
    state = hass.states.get(eid)
    assert state.attributes["device_class"] == "enum"
    assert {"ok", "suspect", "recovering", "escalated", "cooldown"} <= set(
        state.attributes["options"]
    )


@pytest.mark.parametrize("strategy", ["switch_check", "notify"])
async def test_status_sensor_present_for_every_mode(
    hass: HomeAssistant, setup_guards: SetupGuards, strategy: str
) -> None:
    """Both recover and notify-only guards expose a status sensor."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Mode Guard", strategy=strategy))

    eid = entity_id_for(hass, "guard0", "sensor", "status")
    assert eid is not None
    assert hass.states.get(eid).state == "ok"


# ---------------- heartbeat source ----------------

_HEARTBEAT_ATTRS = {"last_status", "last_code", "awaiting_first_success"}


def _hb(name: str = "Job", **kwargs: Any) -> dict[str, Any]:
    """A notify-only heartbeat guard: 60 s period, 30 s grace (= its debounce)."""
    kwargs.setdefault("period", 60)
    kwargs.setdefault("debounce", 30)
    return make_guard(name, source="heartbeat_based", strategy="notify", **kwargs)


async def _tick(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, seconds: float
) -> None:
    """Move frozen time forward and fire due timers."""
    freezer.tick(timedelta(seconds=seconds))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()


async def _ping(
    hass: HomeAssistant, entry: MockConfigEntry, ok: bool = True, code=None
) -> None:
    """Deliver a ping straight to the source (the HTTP path is test_heartbeat's)."""
    await entry.runtime_data.engines["guard0"].health.async_handle_ping(ok, code)
    await hass.async_block_till_done()


@pytest.mark.parametrize(
    ("source", "health_type"),
    [
        ("state_based", "entity_state"),
        ("template_based", "template"),
        ("heartbeat_based", "heartbeat"),
    ],
)
async def test_health_type_on_every_status_sensor(
    hass: HomeAssistant, setup_guards: SetupGuards, source: str, health_type: str
) -> None:
    """Every status sensor names its source type; only heartbeat adds its fields.

    `health_source` sits on the health binary sensor, which is unavailable (no
    attributes) while health is unknown — a waiting heartbeat guard would be
    invisible there, so the always-available status sensor carries the type.
    """
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(make_guard("Typed", source=source, strategy="notify"))

    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert attrs["health_type"] == health_type
    if health_type == "heartbeat":
        assert set(attrs) >= _HEARTBEAT_ATTRS
    else:
        assert not _HEARTBEAT_ATTRS & set(attrs)
        assert "health_detail" not in attrs


async def test_heartbeat_attributes_follow_the_verdict_not_each_ping(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """Waiting -> OK -> OK ping -> failure; an OK->OK ping writes no new state.

    Any attribute change fires state_changed and costs a recorder row, so the
    status sensor carries no per-ping timestamp (that is the timestamp sensor's job).
    """
    entry = await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    waiting = hass.states.get(eid)
    assert waiting.state == "blind"
    assert waiting.attributes["awaiting_first_success"] is True
    assert waiting.attributes["last_status"] is None
    assert waiting.attributes["last_code"] is None
    assert waiting.attributes["health_detail"] == "Waiting for the first heartbeat."

    await _ping(hass, entry)
    first = hass.states.get(eid)
    assert first.state == "ok"
    assert first.attributes["awaiting_first_success"] is False
    assert first.attributes["last_status"] == "ok"
    assert "health_detail" not in first.attributes

    await _tick(hass, freezer, 20)
    await _ping(hass, entry)
    second = hass.states.get(eid)
    assert second.attributes == first.attributes
    assert second.last_updated == first.last_updated

    await _ping(hass, entry, ok=False, code="3")  # confirmed: no debounce
    failed = hass.states.get(eid)
    assert failed.state == "escalated"
    assert failed.attributes["last_status"] == "fail"
    assert failed.attributes["last_code"] == "3"
    assert failed.attributes["awaiting_first_success"] is False
    assert failed.attributes["health_detail"] == "Failure reported, exit code 3."


async def test_escalated_at_survives_writes_and_clears_with_the_state(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """`escalated_at` is when the guard entered ESCALATED, None outside it.

    The cards count "for 2 h" from it: HA's last_changed restarts with every
    HA restart, the engine's escalated_at is persisted with the restored state.
    A later write of the sensor (time passing) does not move it.
    """
    entry = await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    await _ping(hass, entry)
    assert hass.states.get(eid).attributes["escalated_at"] is None

    await _ping(hass, entry, ok=False)  # confirmed failure: escalated now
    escalated = hass.states.get(eid)
    assert escalated.state == "escalated"
    at = escalated.attributes["escalated_at"]
    assert at == entry.runtime_data.engines["guard0"].escalated_at
    assert at is not None
    assert abs((dt_util.utcnow() - at).total_seconds()) < 5

    await _tick(hass, freezer, 600)
    await async_update_entity(hass, eid)
    await hass.async_block_till_done()
    assert hass.states.get(eid).attributes["escalated_at"] == at

    await _ping(hass, entry)  # back to OK
    back = hass.states.get(eid)
    assert back.state == "ok"
    assert back.attributes["escalated_at"] is None


async def test_state_since_moves_only_with_the_state(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """`state_since` is when the guard entered its current state, any state.

    The cards count "for 19 min" / "problem since 11:19" from it; the engine
    persists it with the state, so unlike last_changed it survives a restart.
    A later write of the sensor (time passing) does not move it.
    """
    entry = await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    await _ping(hass, entry)
    first = hass.states.get(eid).attributes["state_since"]
    engine = entry.runtime_data.engines["guard0"]
    assert first == engine.state_since
    assert engine.snapshot()["state_since"] == first.isoformat()

    await _tick(hass, freezer, 20)  # within the 60 s period: still ok
    await async_update_entity(hass, eid)
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == "ok"
    assert hass.states.get(eid).attributes["state_since"] == first

    await _ping(hass, entry, ok=False)  # confirmed failure: escalated now
    escalated = hass.states.get(eid)
    assert escalated.state == "escalated"
    assert escalated.attributes["state_since"] == escalated.attributes["escalated_at"]
    assert escalated.attributes["state_since"] > first


async def test_state_since_survives_a_restart_with_the_source_not_loaded(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
) -> None:
    """A restart keeps `state_since`, also while the watched entity loads late.

    At boot the source integration may not be set up yet (no state, or HA's
    restored `unavailable`): the guard reads BLIND for a moment. That must not
    restart the clock of the OK it returns to.
    """
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Since Guard"))
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    began = hass.states.get(eid).attributes["state_since"]

    await _tick(hass, freezer, 3600)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    stored = hass_storage[f"{DOMAIN}.{entry.entry_id}"]["data"]["guard0"]
    assert stored["state"] == "ok"
    assert dt_util.parse_datetime(stored["state_since"]) == began

    # "Restart": the health entity is not there yet while HA starts.
    hass.states.async_remove("binary_sensor.guard_health")
    hass.set_state(CoreState.starting)
    try:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        assert hass.states.get(eid).state == "blind"
        hass.states.async_set("binary_sensor.guard_health", "on")
        await hass.async_block_till_done()
    finally:
        hass.set_state(CoreState.running)
    state = hass.states.get(eid)
    assert state.state == "ok"
    assert state.attributes["state_since"] == began


async def test_health_detail_attribute_stays_as_time_passes(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """The reason on the status sensor is the one at the finding; it does not drift.

    An hour later the source would word it differently ("for 62 minutes"), but a
    re-rendered sensor (any later state write) still shows the text of the alarm.
    """
    entry = await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    await _ping(hass, entry)
    await _tick(hass, freezer, 62)  # overdue -> SUSPECT
    await _tick(hass, freezer, 30)  # grace (debounce 30) over -> ESCALATED
    state = hass.states.get(eid)
    assert state.state == "escalated"
    detail = "No heartbeat for 2 minutes, expected every 1 minute."
    assert state.attributes["health_detail"] == detail

    await _tick(hass, freezer, 3600)
    await async_update_entity(hass, eid)
    await hass.async_block_till_done()
    assert entry.runtime_data.engines["guard0"].health.detail()[1]["since"] > 3600
    assert hass.states.get(eid).attributes["health_detail"] == detail


async def test_only_failures_is_not_awaiting_first_success(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A new guard that only ever failed is a finding, not a waiting guard."""
    entry = await setup_guards(_hb())
    await _ping(hass, entry, ok=False)
    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert attrs["awaiting_first_success"] is False
    assert attrs["last_status"] == "fail"


async def test_last_heartbeat_sensor_only_for_heartbeat_guards(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """Value = last_ping; next_due = basis + period, plus period and grace.

    `grace` is the guard's debounce (the wait after a missed ping). Refreshed on
    every ping.
    """
    freezer.move_to("2026-11-21 10:00:00+00:00")
    hass.states.async_set("binary_sensor.guard_health", "on")
    entry = await setup_guards(_hb(), make_guard("Plain", strategy="notify"))

    assert entity_id_for(hass, "guard1", "sensor", "last_heartbeat") is None
    eid = entity_id_for(hass, "guard0", "sensor", "last_heartbeat")
    assert eid == "sensor.job_last_heartbeat"

    state = hass.states.get(eid)
    assert state.attributes["device_class"] == "timestamp"
    assert state.state == "unknown"  # no ping yet
    # Waiting: the deadline counts from armed_at (setup time).
    assert state.attributes["next_due"] == dt_util.parse_datetime(
        "2026-11-21 10:01:00+00:00"
    )
    assert state.attributes["period"] == 60
    assert state.attributes["grace"] == 30

    for _ in range(2):  # an OK->OK ping must refresh it too
        await _tick(hass, freezer, 20)
        now = dt_util.utcnow()
        await _ping(hass, entry)
        state = hass.states.get(eid)
        assert dt_util.parse_datetime(state.state) == now
        assert state.attributes["next_due"] == now + timedelta(seconds=60)

    # A failure has no deadline (it is unhealthy right away).
    await _ping(hass, entry, ok=False)
    assert hass.states.get(eid).attributes["next_due"] is None


async def test_last_heartbeat_sensor_removed_after_type_change(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Type change heartbeat -> state: the timestamp sensor leaves the registry."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    entry = await setup_guards(_hb())
    assert entity_id_for(hass, "guard0", "sensor", "last_heartbeat") is not None

    subentry = entry.subentries["guard0"]
    state_based = make_guard("Job", strategy="notify")
    hass.config_entries.async_update_subentry(
        entry, subentry, data={**subentry.data, "health": state_based["health"]}
    )
    await hass.async_block_till_done()

    assert entity_id_for(hass, "guard0", "sensor", "last_heartbeat") is None
    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert attrs["health_type"] == "entity_state"


# ---------------- card attributes (driver_type / driver_entity / last_heartbeat) ----


SCRIPT_ACTION = [
    {"action": "script.turn_on", "target": {"entity_id": "script.reboot_nas"}}
]
TWO_STEPS = [{"action": "script.reboot_nas"}, {"delay": {"seconds": 5}}]


@pytest.mark.parametrize(
    ("strategy", "kwargs", "expected"),
    [
        ("switch", {}, ("switch", "switch.guard_target", None, None)),
        ("switch_check", {}, ("switch", "switch.guard_target", None, None)),
        (
            "action",
            {"action": SCRIPT_ACTION},
            ("action", "script.reboot_nas", 1, None),
        ),
        (
            "action",
            {"action": [{"action": "script.nas_cycle"}]},
            ("action", "script.nas_cycle", 1, None),
        ),
        ("action", {"action": TWO_STEPS}, ("action", None, 2, None)),
        (
            "actions_check",
            {"off_action": SCRIPT_ACTION, "on_action": TWO_STEPS},
            ("actions", None, 3, None),
        ),
        (
            "poe_port",
            {"expected_id": "AA:BB:CC:00:11:22"},
            ("poe_port", None, None, "AA:BB:CC:00:11:22"),
        ),
        ("notify", {}, ("notify", None, None, None)),
    ],
)
async def test_driver_attributes_per_strategy(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    strategy: str,
    kwargs: dict[str, Any],
    expected: tuple,
) -> None:
    """The status sensor names the strategy and its static target.

    The cards pick their buttons from `driver_type`, so they never see the
    internal driver names (switch_cycle, action_call, action_cycle, noop).
    `driver_entity` is the switch for `switch` and the one script an `action`
    runs (None for anything else: the cards say "Action (n steps)");
    `driver_steps` counts the action steps (off + on for `actions`) and
    `driver_port_expected_id` is a PoE guard's id. Where that id is on the
    fabric right now is not an attribute (it moves): see the WS command.
    """
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Driven", strategy=strategy, **kwargs))

    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert (
        attrs["driver_type"],
        attrs["driver_entity"],
        attrs["driver_steps"],
        attrs["driver_port_expected_id"],
    ) == expected
    # Not a heartbeat guard: no last-heartbeat sensor to point at.
    assert "last_heartbeat_entity" not in attrs


async def test_last_heartbeat_entity_only_on_heartbeat_guards(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A heartbeat guard points at its timestamp sensor; a state guard has no key."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(_hb("Job"), make_guard("Plain", strategy="notify"))

    hb_attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert hb_attrs["last_heartbeat_entity"] == entity_id_for(
        hass, "guard0", "sensor", "last_heartbeat"
    )
    assert hb_attrs["last_heartbeat_entity"] is not None
    assert hb_attrs["driver_type"] == "notify"

    plain_attrs = hass.states.get(
        entity_id_for(hass, "guard1", "sensor", "status")
    ).attributes
    assert "last_heartbeat_entity" not in plain_attrs


async def test_last_heartbeat_entity_follows_a_rename(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Resolved live from the unique_id: a renamed timestamp sensor is found again."""
    await setup_guards(_hb("Job"))
    status_eid = entity_id_for(hass, "guard0", "sensor", "status")
    old = entity_id_for(hass, "guard0", "sensor", "last_heartbeat")

    er.async_get(hass).async_update_entity(old, new_entity_id="sensor.backup_ping")
    await hass.async_block_till_done()
    await async_update_entity(hass, status_eid)
    await hass.async_block_till_done()

    attrs = hass.states.get(status_eid).attributes
    assert attrs["last_heartbeat_entity"] == "sensor.backup_ping"


@pytest.mark.parametrize(
    ("source", "attribute", "source_entity", "source_attribute"),
    [
        ("state_based", None, "binary_sensor.guard_health", None),
        ("state_based", "rssi", "binary_sensor.guard_health", "rssi"),
        ("template_based", None, None, None),
        ("heartbeat_based", None, None, None),
    ],
)
async def test_source_entity_per_health_type(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    source: str,
    attribute: str | None,
    source_entity: str | None,
    source_attribute: str | None,
) -> None:
    """Only a state-based guard names the entity it watches (the card's main value).

    A template guard may read many entities and a heartbeat guard reads none, so
    both say None; `source_attribute` is set only when an attribute is judged.
    """
    hass.states.async_set("binary_sensor.guard_health", "on", {"rssi": "-60"})
    await setup_guards(
        make_guard("Watched", source=source, attribute=attribute, strategy="notify")
    )

    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert attrs["source_entity"] == source_entity
    assert attrs["source_attribute"] == source_attribute


@pytest.mark.parametrize("source", ["state_based", "heartbeat_based"])
async def test_card_attributes_static_across_a_transition(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    source: str,
) -> None:
    """A state transition rewrites the status sensor but none of the card fields.

    They only move on a reconfigure (reload), so they never add a recorder row
    on their own.
    """
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    if source == "heartbeat_based":
        guard = make_guard("Static", source=source, strategy="switch", period=60)
    else:
        guard = make_guard("Static", strategy="switch", debounce=60)
    entry = await setup_guards(guard)
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    keys = (
        "driver_type",
        "driver_entity",
        "driver_steps",
        "driver_port_expected_id",
        "last_heartbeat_entity",
        "source_entity",
        "source_attribute",
    )

    before = hass.states.get(eid)
    if source == "heartbeat_based":
        await _ping(hass, entry)  # blind (waiting) -> ok
    else:
        hass.states.async_set("binary_sensor.guard_health", "off")  # ok -> suspect
        await hass.async_block_till_done()
    after = hass.states.get(eid)

    assert after.state != before.state
    assert {k: after.attributes.get(k) for k in keys} == {
        k: before.attributes.get(k) for k in keys
    }
    assert after.attributes["driver_type"] == "switch"
    assert after.attributes["driver_entity"] == "switch.guard_target"
