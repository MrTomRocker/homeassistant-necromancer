"""Status sensor tests."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from freezegun.api import FrozenDateTimeFactory
import pytest

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ._compat import MockConfigEntry, async_fire_time_changed
from .conftest import SetupGuards, entity_id_for, make_guard


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
