"""Operator service tests: reset / snooze / unsnooze and the heartbeat services."""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any
from unittest.mock import patch

from freezegun.api import FrozenDateTimeFactory
import pytest

from homeassistant.core import Context, HomeAssistant, ServiceCall
from homeassistant.exceptions import (
    ServiceNotSupported,
    ServiceValidationError,
    Unauthorized,
)
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.network import NoURLAvailableError
from homeassistant.util import dt as dt_util

from ._compat import async_fire_time_changed, async_mock_service
from .conftest import HEARTBEAT_TOKEN, SetupGuards, entity_id_for, make_guard

type MockUser = Any

DOMAIN = "necromancer"


async def _snooze(hass: HomeAssistant, eid: str, **dur: int) -> None:
    await hass.services.async_call(
        DOMAIN, "snooze", {"entity_id": eid, "duration": dur}, blocking=True
    )
    await hass.async_block_till_done()


async def test_reset_clears_escalation(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Reset on an ESCALATED guard returns it to OK (health is fine again)."""
    from custom_components.necromancer.core.state import GState

    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Reset Guard"))
    engine = entry.runtime_data.engines["guard0"]
    engine.state = GState.ESCALATED

    eid = entity_id_for(hass, "guard0", "sensor", "status")
    await hass.services.async_call(DOMAIN, "reset", {"entity_id": eid}, blocking=True)
    await hass.async_block_till_done()

    assert engine.state is GState.OK
    assert hass.states.get(eid).state == "ok"


async def test_snooze_ignores_health(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A snoozed guard ignores its health entirely — no SUSPECT on a break."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Snooze Guard"))
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    await _snooze(hass, eid, hours=1)
    assert hass.states.get(eid).state == "snoozed"
    assert engine._snoozed is True
    assert engine._snooze_until is not None

    hass.states.async_set("binary_sensor.guard_health", "off")
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == "snoozed"


async def test_unsnooze_rederives_state(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Unsnooze lifts the snooze and re-derives from live health (OK here)."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Unsnooze Guard"))
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    await _snooze(hass, eid, hours=1)
    assert hass.states.get(eid).state == "snoozed"

    await hass.services.async_call(
        DOMAIN, "unsnooze", {"entity_id": eid}, blocking=True
    )
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == "ok"


async def test_snooze_auto_resumes_on_elapse(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The snooze timer fires after its duration and the guard resumes."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Auto Resume"))
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    await _snooze(hass, eid, seconds=30)
    assert hass.states.get(eid).state == "snoozed"

    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=31))
    await hass.async_block_till_done()
    assert hass.states.get(eid).state == "ok"


async def test_snooze_during_recovery_raises(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Snooze is refused while a recovery cycle is in flight (busy)."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Busy Guard"))
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    pending = hass.loop.create_future()  # a non-done "cycle" -> _busy() is True
    engine._cycle_task = pending
    try:
        with pytest.raises(ServiceValidationError):
            await hass.services.async_call(
                DOMAIN,
                "snooze",
                {"entity_id": eid, "duration": {"hours": 1}},
                blocking=True,
            )
    finally:
        pending.cancel()


async def test_snooze_persisted_in_snapshot(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The snooze (state + snooze_until) is captured in the persisted snapshot."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Persist Guard"))
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    await _snooze(hass, eid, hours=1)
    snapshot = engine.snapshot()
    assert snapshot["state"] == "snoozed"
    assert snapshot["snooze_until"] is not None


async def test_snooze_all_and_unsnooze_all(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """snooze_all suspends every guard; unsnooze_all resumes them (no target)."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("All A"), make_guard("All B"))
    engines = entry.runtime_data.engines

    await hass.services.async_call(
        DOMAIN, "snooze_all", {"duration": {"hours": 1}}, blocking=True
    )
    await hass.async_block_till_done()
    assert engines["guard0"]._snoozed is True
    assert engines["guard1"]._snoozed is True

    await hass.services.async_call(DOMAIN, "unsnooze_all", {}, blocking=True)
    await hass.async_block_till_done()
    assert engines["guard0"]._snoozed is False
    assert engines["guard1"]._snoozed is False


async def test_snooze_all_skips_busy_guard(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """snooze_all is best-effort: a guard mid-recovery is skipped, not raised on."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Bz A"), make_guard("Bz B"))
    engines = entry.runtime_data.engines

    pending = engines["guard1"]._cycle_task = hass.loop.create_future()  # busy
    try:
        await hass.services.async_call(
            DOMAIN, "snooze_all", {"duration": {"hours": 1}}, blocking=True
        )
        await hass.async_block_till_done()
        assert engines["guard0"]._snoozed is True  # free guard snoozed
        assert engines["guard1"]._snoozed is False  # busy guard skipped
    finally:
        pending.cancel()


# ---------------- heartbeat services (heartbeat_url / heartbeat_ping) ----------------

HB_URL = "http://192.168.1.2:8123"
HB_PATH = f"/api/necromancer/heartbeat/job_{HEARTBEAT_TOKEN}"
STORE_KEY = f"{DOMAIN}.necro_test_entry"
_GET_URL = "custom_components.necromancer.core.health.heartbeat.get_url"


def _hb(name: str = "Job", **kwargs: Any) -> dict[str, Any]:
    """A notify-only heartbeat guard, period 60 s, no grace unless given."""
    kwargs.setdefault("period", 60)
    kwargs.setdefault("debounce", 0)
    return make_guard(
        name,
        source="heartbeat_based",
        strategy="notify",
        notify_action=[{"action": "test.sink", "data": {"event": "{{ event }}"}}],
        **kwargs,
    )


@pytest.fixture
def sink(hass: HomeAssistant) -> list[ServiceCall]:
    """Notification calls of the heartbeat guards (`test.sink`)."""
    return async_mock_service(hass, "test", "sink")


async def _advance(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, seconds: float
) -> None:
    freezer.tick(timedelta(seconds=seconds))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()


async def _url(
    hass: HomeAssistant, guard: str, context: Context | None = None
) -> dict[str, Any]:
    return await hass.services.async_call(
        DOMAIN,
        "heartbeat_url",
        {"guard": guard},
        blocking=True,
        return_response=True,
        context=context,
    )


async def _hb_ping(
    hass: HomeAssistant, eid: str, context: Context | None = None
) -> None:
    await hass.services.async_call(
        DOMAIN, "heartbeat_ping", {"entity_id": eid}, blocking=True, context=context
    )
    await hass.async_block_till_done()


async def test_heartbeat_url_returns_url_and_path(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The full URL from HA's own (internal) URL, plus the bare path."""
    await hass.config.async_update(internal_url=HB_URL)
    await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    assert await _url(hass, eid) == {"url": HB_URL + HB_PATH, "path": HB_PATH}


async def test_heartbeat_url_same_builder_as_the_flow(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Same get_url arguments as the config flow's info step (shared helper)."""
    await hass.config.async_update(
        internal_url=HB_URL, external_url="https://ha.example.com"
    )
    await setup_guards(_hb(local_only=False))
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    with patch(_GET_URL, return_value=HB_URL) as spy:
        await _url(hass, eid)
    assert spy.call_args.kwargs == {
        "allow_external": True,
        "prefer_external": False,
        "allow_ip": True,
    }


async def test_heartbeat_url_without_any_ha_url_is_path_only(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """HA knows no own URL: only the path, `url` is None."""
    await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    with patch(_GET_URL, side_effect=NoURLAvailableError):
        assert await _url(hass, eid) == {"url": None, "path": HB_PATH}


async def test_heartbeat_url_rejects_non_heartbeat_guard(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A guard with another health source has no URL."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(make_guard("State", strategy="notify"))
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    with pytest.raises(ServiceValidationError) as err:
        await _url(hass, eid)
    assert err.value.translation_key == "not_a_heartbeat_guard"


async def test_heartbeat_url_unknown_guard_raises(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Same resolution as check_health: a foreign entity is unknown_guard."""
    await setup_guards(_hb())
    with pytest.raises(ServiceValidationError) as err:
        await _url(hass, "sensor.not_a_guard")
    assert err.value.translation_key == "unknown_guard"


async def test_heartbeat_url_is_admin_only(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_admin_user: MockUser,
    hass_read_only_user: MockUser,
) -> None:
    """The URL carries the secret token: a non-admin user gets Unauthorized."""
    await hass.config.async_update(internal_url=HB_URL)
    await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")

    with pytest.raises(Unauthorized):
        await _url(hass, eid, Context(user_id=hass_read_only_user.id))
    resp = await _url(hass, eid, Context(user_id=hass_admin_user.id))
    assert resp["url"] == HB_URL + HB_PATH


async def test_heartbeat_ping_clears_overdue_escalation(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Overdue + ESCALATED -> manual ping -> OK, the deadline counts from now.

    `reset` would not help here: the deadline stays passed and the guard turns
    red again at once. The ping is saved like an endpoint ping.
    """
    entry = await setup_guards(_hb())
    engine = entry.runtime_data.engines["guard0"]
    await _advance(hass, freezer, 62)  # deadline -> SUSPECT
    await _advance(hass, freezer, 1)  # debounce 0 -> ESCALATED
    assert engine.state.value == "escalated"

    pinged_at = dt_util.utcnow()
    await _hb_ping(hass, entity_id_for(hass, "guard0", "sensor", "status"))

    assert engine.state.value == "ok"
    assert engine.health.state["last_status"] == "ok"
    ts = hass.states.get(entity_id_for(hass, "guard0", "sensor", "last_heartbeat"))
    assert ts.attributes["next_due"] == pinged_at + timedelta(seconds=60)
    await _advance(hass, freezer, 6)  # delayed save
    stored = hass_storage[STORE_KEY]["data"]["guard0"]["source"]
    assert dt_util.parse_datetime(stored["last_ok"]) == pinged_at


async def test_heartbeat_ping_on_suspect_is_silent(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """In the grace (SUSPECT) a manual ping ends it like a late ping: no alarm."""
    entry = await setup_guards(_hb(period=3600, debounce=600))
    engine = entry.runtime_data.engines["guard0"]
    await _advance(hass, freezer, 3602)
    assert engine.state.value == "suspect"

    await _hb_ping(hass, entity_id_for(hass, "guard0", "sensor", "status"))
    assert engine.state.value == "ok"
    await _advance(hass, freezer, 601)  # past the old debounce, within the period
    assert engine.state.value == "ok"
    assert sink == []


async def test_heartbeat_ping_rejects_non_heartbeat_guard(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Pinging a state/template guard makes no sense: ServiceValidationError."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(make_guard("State", strategy="notify"))
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    with pytest.raises(ServiceValidationError) as err:
        await _hb_ping(hass, eid)
    assert err.value.translation_key == "not_a_heartbeat_guard"


async def test_heartbeat_ping_on_stopped_source_raises(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_storage: dict[str, Any]
) -> None:
    """A source closed by a reload in flight refuses the ping with a clear error."""
    entry = await setup_guards(_hb())
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    before = engine.health.state
    engine.health._closed = True  # as between unload and the next setup
    try:
        with pytest.raises(ServiceValidationError) as err:
            await _hb_ping(hass, eid)
    finally:
        engine.health._closed = False
    assert err.value.translation_key == "heartbeat_not_running"
    assert engine.health.state == before


async def test_heartbeat_ping_on_dormant_guard_changes_nothing(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A dormant guard has no status entity, so the entity service cannot reach it.

    HA itself reports the missing target (like reset/snooze on a dormant guard);
    no ping is written into the stored state.
    """
    entry = await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier((DOMAIN, "guard0"), entry.entry_id)
    dev_reg.async_update_device(device.id, disabled_by=dr.DeviceEntryDisabler.USER)
    await hass.async_block_till_done()
    assert entry.runtime_data.engines == {}
    await _advance(hass, freezer, 6)
    before = hass_storage[STORE_KEY]["data"]["guard0"]["source"]

    with caplog.at_level(logging.WARNING):
        await _hb_ping(hass, eid)
    await _advance(hass, freezer, 6)
    assert hass_storage[STORE_KEY]["data"]["guard0"]["source"] == before
    assert any(
        eid in r.getMessage() and "missing" in r.getMessage() for r in caplog.records
    )


async def test_heartbeat_ping_logs_user_never_token(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_admin_user: MockUser,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One INFO line names the guard and the triggering user, never the token."""
    await setup_guards(_hb())
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    with caplog.at_level(logging.DEBUG):
        await _hb_ping(hass, eid, Context(user_id=hass_admin_user.id))

    lines = [
        r for r in caplog.records if r.name.startswith("custom_components.necromancer")
    ]
    manual = [
        r for r in lines if r.levelno == logging.INFO and "manual" in r.getMessage()
    ]
    assert len(manual) == 1
    assert hass_admin_user.id in manual[0].getMessage()
    assert "Job" in manual[0].getMessage()
    assert all(HEARTBEAT_TOKEN not in r.getMessage() for r in lines)


async def test_heartbeat_ping_while_snoozed_is_stored(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
) -> None:
    """Snoozed: the guard stays SNOOZED, the ping is stored like any ping."""
    entry = await setup_guards(_hb())
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    await _snooze(hass, eid, hours=1)

    pinged_at = dt_util.utcnow()
    await _hb_ping(hass, eid)
    assert hass.states.get(eid).state == "snoozed"
    assert engine.health.state["last_ok"] == pinged_at.isoformat()
    await _advance(hass, freezer, 6)
    stored = hass_storage[STORE_KEY]["data"]["guard0"]
    assert stored["state"] == "snoozed"
    assert dt_util.parse_datetime(stored["source"]["last_ok"]) == pinged_at


async def test_heartbeat_ping_device_target_skips_last_heartbeat(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """A device target expands to both sensors; only the status sensor is called.

    Regression: the last_heartbeat sensor has no service methods, so without the
    device-class filter the call raised AttributeError after the ping was applied.
    The same holds for the other per-guard services (reset shown here).
    """
    entry = await setup_guards(_hb())
    engine = entry.runtime_data.engines["guard0"]
    eid = entity_id_for(hass, "guard0", "sensor", "status")
    device_id = er.async_get(hass).async_get(eid).device_id
    assert device_id is not None
    await _advance(hass, freezer, 62)
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"

    await hass.services.async_call(
        DOMAIN, "heartbeat_ping", {"device_id": device_id}, blocking=True
    )
    await hass.async_block_till_done()
    assert engine.state.value == "ok"

    await hass.services.async_call(
        DOMAIN, "reset", {"device_id": device_id}, blocking=True
    )
    await hass.async_block_till_done()
    assert engine.state.value == "ok"


@pytest.mark.parametrize("service", ["heartbeat_ping", "reset", "unsnooze"])
async def test_entity_services_reject_last_heartbeat_sensor(
    hass: HomeAssistant, setup_guards: SetupGuards, service: str
) -> None:
    """Naming the last_heartbeat sensor gives HA's translated not-supported error."""
    entry = await setup_guards(_hb())
    engine = entry.runtime_data.engines["guard0"]
    before = engine.health.state
    ts = entity_id_for(hass, "guard0", "sensor", "last_heartbeat")
    with pytest.raises(ServiceNotSupported):
        await hass.services.async_call(
            DOMAIN, service, {"entity_id": ts}, blocking=True
        )
    assert engine.health.state == before
