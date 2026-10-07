"""Integration init / setup / lifecycle tests.

Exercises async_setup_entry (engine construction, service registration, per-guard
isolation, view-entity reconciliation, device-registry footprint), async_unload_entry
and the deferred config-validation warnings (feedback loop / blind template).
"""

from __future__ import annotations

import logging

import pytest

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    device_registry as dr,
    entity_registry as er,
    issue_registry as ir,
)

from .conftest import DOMAIN, SetupGuards, entity_id_for, make_guard

from tests.common import MockConfigEntry


async def test_setup_builds_one_engine_per_guard(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Two guards yield two engines in runtime_data and a loaded entry."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("A"), make_guard("B"))

    assert entry.state is ConfigEntryState.LOADED
    assert len(entry.runtime_data.engines) == 2
    assert set(entry.runtime_data.engines) == {"guard0", "guard1"}


async def test_repair_poe_port_service_registered(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Setup registers the necromancer.repair_poe_port service."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Svc Guard"))

    assert hass.services.has_service("necromancer", "repair_poe_port")


async def test_malformed_guard_is_skipped(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A guard whose health type is unknown is skipped; the good one still loads."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    bad = make_guard("Bad")
    bad["health"] = {"type": "does_not_exist"}

    with caplog.at_level(logging.ERROR):
        entry = await setup_guards(bad, make_guard("Good"))

    assert entry.state is ConfigEntryState.LOADED
    assert set(entry.runtime_data.engines) == {"guard1"}
    assert "Failed to set up guard" in caplog.text
    assert "Bad" in caplog.text


async def test_notify_only_guard_has_no_control_entities(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A notify-only guard exposes status + health but no switch/button."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    await setup_guards(make_guard("Watcher", strategy="notify"))

    assert entity_id_for(hass, "guard0", "switch", "auto_restart") is None
    assert entity_id_for(hass, "guard0", "button", "recover") is None
    assert entity_id_for(hass, "guard0", "sensor", "status") is not None
    assert entity_id_for(hass, "guard0", "binary_sensor", "health") is not None


async def test_recover_guard_has_all_four_entities(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A recover guard exposes status, health, auto_restart and recover entities."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    await setup_guards(make_guard("Reviver"))

    assert entity_id_for(hass, "guard0", "sensor", "status") is not None
    assert entity_id_for(hass, "guard0", "binary_sensor", "health") is not None
    assert entity_id_for(hass, "guard0", "switch", "auto_restart") is not None
    assert entity_id_for(hass, "guard0", "button", "recover") is not None


async def test_standalone_recover_guard_creates_device(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A standalone recover guard registers a Necromancer device."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Phoenix"))

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier(
        ("necromancer", "guard0"), entry.entry_id
    )
    assert device is not None
    assert device.name == "Phoenix"
    assert device.manufacturer == "Necromancer"
    assert device.via_device_id is None


async def test_linked_guard_uses_target_as_via_device(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A linked guard owns its own device, nested under the assigned one."""
    dev_reg = dr.async_get(hass)
    foreign = MockConfigEntry(domain="demo", title="Demo")
    foreign.add_to_hass(hass)
    target = dev_reg.async_get_or_create(
        config_entry_id=foreign.entry_id,
        identifiers={("demo", "plug-1")},
        name="Shelly Plug X",
    )

    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Phoenix", device_id=target.id))

    device = dev_reg.async_get_device_by_identifier(
        ("necromancer", "guard0"), entry.entry_id
    )
    assert device is not None
    assert device.name == "Phoenix"
    assert device.via_device_id == target.id
    # The target keeps its own identity and owner - we never adopt it.
    assert dev_reg.async_get(target.id).config_entry_id == foreign.entry_id

    status = entity_id_for(hass, "guard0", "sensor", "status")
    assert er.async_get(hass).async_get(status).device_id == device.id


async def test_two_linked_guards_stay_distinct(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Two guards on one target device keep their own name and entities."""
    dev_reg = dr.async_get(hass)
    foreign = MockConfigEntry(domain="demo", title="Demo")
    foreign.add_to_hass(hass)
    target = dev_reg.async_get_or_create(
        config_entry_id=foreign.entry_id,
        identifiers={("demo", "inverter")},
        name="FoxEss Smart",
    )

    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(
        make_guard("Null trotz Sonne", device_id=target.id),
        make_guard("Ping", device_id=target.id),
    )

    first = dev_reg.async_get_device_by_identifier(
        ("necromancer", "guard0"), entry.entry_id
    )
    second = dev_reg.async_get_device_by_identifier(
        ("necromancer", "guard1"), entry.entry_id
    )
    assert first.id != second.id
    assert first.name == "Null trotz Sonne"
    assert second.name == "Ping"
    assert first.via_device_id == second.via_device_id == target.id


async def test_dangling_link_survives_and_raises_repair(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    issue_registry: ir.IssueRegistry,
) -> None:
    """A link target that no longer exists costs the guard nothing but a repair."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Orphan", device_id="gone-for-good"))

    device = dr.async_get(hass).async_get_device_by_identifier(
        ("necromancer", "guard0"), entry.entry_id
    )
    assert device is not None
    assert device.via_device_id is None
    assert entity_id_for(hass, "guard0", "sensor", "status") is not None

    issue = issue_registry.async_get_issue(DOMAIN, "guard0_link_device_missing")
    assert issue is not None
    assert issue.translation_key == "link_device_missing"


async def test_unload_sets_not_loaded(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Unloading the entry tears engines down and marks it NOT_LOADED."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Bye"))

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED


async def test_feedback_loop_warning(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A template health reading the guard's own status sensor warns about a loop."""
    hass.states.async_set("input_boolean.x", "off")
    with caplog.at_level(logging.WARNING):
        await setup_guards(
            make_guard(
                "Loopy",
                source="template_based",
                strategy="action_check",
                template="{{ is_state('sensor.loopy_status','ok') }}",
                action=[
                    {
                        "action": "input_boolean.turn_on",
                        "data": {"entity_id": "input_boolean.x"},
                    }
                ],
            )
        )
        await hass.async_block_till_done()

    assert "feedback loop" in caplog.text
    assert "references its own entit" in caplog.text


async def test_blind_template_warning(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A template reading only a missing entity warns the guard is blind."""
    with caplog.at_level(logging.WARNING):
        await setup_guards(
            make_guard(
                "Blind",
                source="template_based",
                strategy="notify",
                template="{{ is_state('binary_sensor.ghost_xyz','on') }}",
            )
        )
        await hass.async_block_till_done()

    assert "guard is blind" in caplog.text
    assert "binary_sensor.ghost_xyz" in caplog.text


# ---------- dormant guards (device disabled by the user) ----------
async def _disable_guard_device(
    hass: HomeAssistant, entry_id: str, subentry_id: str
) -> str:
    """Disable a guard's own device as the UI would; return the device id."""
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier((DOMAIN, subentry_id), entry_id)
    assert device is not None
    dev_reg.async_update_device(device.id, disabled_by=dr.DeviceEntryDisabler.USER)
    await hass.async_block_till_done()
    return device.id


async def test_dormant_guard_builds_no_engine(
    hass: HomeAssistant, setup_guards: SetupGuards, caplog: pytest.LogCaptureFixture
) -> None:
    """A guard whose device the user disabled is not loaded at all."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Dormant"), make_guard("Awake"))
    await _disable_guard_device(hass, entry.entry_id, "guard0")

    with caplog.at_level(logging.INFO):
        assert await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()

    assert set(entry.runtime_data.engines) == {"guard1"}
    assert "is dormant" in caplog.text


async def test_dormant_guard_keeps_its_device(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Reconciliation must not reap the device carrying the user's disable.

    Removing it would drop the disable *and* let the next reload recreate a fresh,
    enabled device — the guard would silently turn itself back on.
    """
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Dormant"))
    device_id = await _disable_guard_device(hass, entry.entry_id, "guard0")

    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    device = dr.async_get(hass).async_get(device_id)
    assert device is not None
    assert device.disabled_by is dr.DeviceEntryDisabler.USER


async def test_dormant_guard_raises_no_repairs(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    issue_registry: ir.IssueRegistry,
) -> None:
    """Dormant means silent: a pre-existing repair is cleared, none are raised."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Orphan", device_id="gone-for-good"))
    assert (
        issue_registry.async_get_issue(DOMAIN, "guard0_link_device_missing") is not None
    )

    await _disable_guard_device(hass, entry.entry_id, "guard0")
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    assert issue_registry.async_get_issue(DOMAIN, "guard0_link_device_missing") is None


async def test_dormant_guard_drops_out_of_link_group(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A dormant guard neither leads nor follows a group repair."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(
        make_guard("A", linked_guards=["guard1"]),
        make_guard("B", linked_guards=["guard0"]),
    )
    assert entry.runtime_data.engines["guard1"].links._linked == ["guard0"]

    await _disable_guard_device(hass, entry.entry_id, "guard0")
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.runtime_data.engines["guard1"].links._linked == []


async def test_dormant_guard_keeps_its_persisted_state(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Going dormant must not reset the guard's counters or its verdict."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Dormant"), make_guard("Awake"))
    engine = entry.runtime_data.engines["guard0"]
    engine.recover_count = 27
    engine.fail_count = 21

    await _disable_guard_device(hass, entry.entry_id, "guard0")
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    # Dormant now, so the serializer has no engine to snapshot — it must carry the
    # stored blob over instead of dropping the key.
    assert entry.runtime_data.serialize()["guard0"]["recover_count"] == 27

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier((DOMAIN, "guard0"), entry.entry_id)
    dev_reg.async_update_device(device.id, disabled_by=None)
    await hass.async_block_till_done()

    revived = entry.runtime_data.engines["guard0"]
    assert revived.recover_count == 27
    assert revived.fail_count == 21


async def test_toggling_guard_device_reloads_live(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Disabling and re-enabling takes effect at once, with no restart."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(make_guard("Toggle"))
    assert set(entry.runtime_data.engines) == {"guard0"}

    device_id = await _disable_guard_device(hass, entry.entry_id, "guard0")
    assert entry.runtime_data.engines == {}

    dr.async_get(hass).async_update_device(device_id, disabled_by=None)
    await hass.async_block_till_done()
    assert set(entry.runtime_data.engines) == {"guard0"}
