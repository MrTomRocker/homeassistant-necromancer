"""WebSocket API tests: `necromancer/poe/ports` (read-only, admin only).

The PoE card reads the port list through it: per port the actuator, where its
id comes from and the current id, the status entity and value, the fabric
status and last cycle, and the poe_port guards whose expected id points there.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from .conftest import DOMAIN, SetupGuards, entity_id_for, make_guard

type WsClientFactory = Any

PORT_LIVE: dict[str, Any] = {
    "label": "Port 5",
    "actuator": "switch.port_5_poe",
    "id_entity": "sensor.port_5_lldp",
    "id_attribute": "mac",
    "status_entity": "binary_sensor.port_5_link",
    "status_on": ["on"],
    "status_off": ["off"],
    "off_on_delay": 1,
    "off_timeout": 5,
    "on_timeout": 5,
}
PORT_STATIC: dict[str, Any] = {
    "label": "Port 6",
    "actuator": "switch.port_6_poe",
    "id_static": "camera-garage",
    "status_entity": "sensor.port_6",
    "status_attribute": "link",
    "status_on": ["up"],
    "status_off": ["down"],
}
PORT_CONFLICT: dict[str, Any] = {
    "label": "Port 7",
    "actuator": "switch.port_7_poe",
    "id_static": "x",
    "id_entity": "sensor.port_7_lldp",
    "status_entity": "sensor.port_7",
    "status_on": ["on"],
    "status_off": ["off"],
}


def _states(hass: HomeAssistant) -> None:
    hass.states.async_set("switch.port_5_poe", "on")
    hass.states.async_set("sensor.port_5_lldp", "ap", {"mac": "AA:BB:CC:00:11:22"})
    hass.states.async_set("binary_sensor.port_5_link", "on")
    hass.states.async_set("switch.port_6_poe", "off")
    hass.states.async_set("sensor.port_6", "x", {"link": "down"})


async def _setup(setup_guards: SetupGuards, hass: HomeAssistant):
    _states(hass)
    return await setup_guards(
        make_guard("Office AP", strategy="poe_port", expected_id="aa:bb:cc:00:11:22"),
        make_guard("Garage Cam", strategy="poe_port", expected_id="CAMERA-GARAGE"),
        make_guard("Lost Device", strategy="poe_port", expected_id="nowhere"),
        make_guard("Plug", strategy="switch_check"),
        options={"ports": [PORT_LIVE, PORT_STATIC, PORT_CONFLICT]},
    )


async def _ports(hass: HomeAssistant, hass_ws_client: WsClientFactory, **kw) -> dict:
    client = await hass_ws_client(hass, **kw)
    await client.send_json_auto_id({"type": "necromancer/poe/ports"})
    return await client.receive_json()


async def test_lists_ports_with_live_values_and_guards(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """Every port with its current id, status value and the guards using it."""
    entry = await _setup(setup_guards, hass)

    msg = await _ports(hass, hass_ws_client)
    assert msg["success"], msg
    result = msg["result"]
    assert result["entry_id"] == entry.entry_id
    p5, p6, p7 = result["ports"]

    assert p5["label"] == "Port 5"
    assert p5["actuator"] == "switch.port_5_poe"
    assert p5["actuator_state"] == "on"
    assert p5["id_source"] == "entity"
    assert p5["id_entity"] == "sensor.port_5_lldp"
    assert p5["id_attribute"] == "mac"
    assert p5["id"] == "AA:BB:CC:00:11:22"
    assert p5["id_norm"] == "aa:bb:cc:00:11:22"
    assert p5["status_entity"] == "binary_sensor.port_5_link"
    assert p5["status_state"] == "on"
    assert p5["status_on"] == ["on"]
    assert p5["status_off"] == ["off"]
    assert p5["fabric_status"] == "good"
    assert p5["last_cycle"] is None
    assert p5["guards"] == [
        {
            "subentry_id": "guard0",
            "name": "Office AP",
            "status_entity": entity_id_for(hass, "guard0", "sensor", "status"),
            "expected_id": "aa:bb:cc:00:11:22",
            "expected_norm": "aa:bb:cc:00:11:22",
            "match": "live",
        }
    ]
    assert p5["guards"][0]["status_entity"]

    assert p6["id_source"] == "static"
    assert p6["id"] == "camera-garage"
    assert p6["status_state"] == "down"  # from the status attribute
    assert p6["actuator_state"] == "off"
    assert [g["name"] for g in p6["guards"]] == ["Garage Cam"]  # case-insensitive
    assert p6["id_norm"] == p6["guards"][0]["expected_norm"] == "camera-garage"

    # Both a fixed id and an id entity: misconfigured, matches nothing.
    assert p7["id_source"] == "conflict"
    assert p7["id"] is None
    assert p7["id_norm"] is None
    assert p7["guards"] == []
    assert p7["actuator_state"] is None  # no such entity


async def test_last_known_port_and_last_cycle(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """A device that went away still shows on its last-known port; a cycle shows."""
    await _setup(setup_guards, hass)
    fabric = hass.data[DOMAIN]["fabric"]

    # The AP drops off the port: the cache keeps pointing at Port 5.
    hass.states.async_set("sensor.port_5_lldp", "none", {"mac": "-"})
    await hass.async_block_till_done()
    with patch.object(fabric, "_cycle", AsyncMock(return_value=True)):
        assert await fabric.repair("aa:bb:cc:00:11:22")

    p5 = (await _ports(hass, hass_ws_client))["result"]["ports"][0]
    assert p5["id"] == "-"
    assert p5["id_norm"] is None  # a placeholder: nothing connected
    assert p5["guards"][0]["match"] == "last_known"
    assert p5["fabric_status"] == "good"
    assert p5["last_cycle"]["ok"] is True
    assert p5["last_cycle"]["time"]


async def test_last_known_port_now_serving_another_id(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """Re-cabled away: the guard still points here by cache, the port reports another id.

    The card tells it apart from "nothing connected" by `id_norm` != the guard's
    `expected_norm`; reading the list must not drop the cache (read-only).
    """
    await _setup(setup_guards, hass)
    fabric = hass.data[DOMAIN]["fabric"]
    assert fabric.cache.get("aa:bb:cc:00:11:22") == "Port 5"

    hass.states.async_set("sensor.port_5_lldp", "cam", {"mac": " 3C:22:FB:12:34:56 "})
    await hass.async_block_till_done()

    p5 = (await _ports(hass, hass_ws_client))["result"]["ports"][0]
    assert p5["id_norm"] == "3c:22:fb:12:34:56"  # trimmed + lower case
    [guard] = p5["guards"]
    assert guard["match"] == "last_known"
    assert guard["expected_norm"] == "aa:bb:cc:00:11:22" != p5["id_norm"]
    assert fabric.cache.get("aa:bb:cc:00:11:22") == "Port 5"


async def test_read_only_user_is_refused(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_ws_client: WsClientFactory,
    hass_read_only_access_token: str,
) -> None:
    """The list names switches and ids: admins only."""
    await _setup(setup_guards, hass)
    msg = await _ports(hass, hass_ws_client, access_token=hass_read_only_access_token)
    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"


async def test_no_loaded_entry_gives_an_empty_list(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """After unload the command stays registered and answers with no ports."""
    entry = await _setup(setup_guards, hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    msg = await _ports(hass, hass_ws_client)
    assert msg["success"]
    assert msg["result"] == {"entry_id": None, "ports": []}


async def test_reload_does_not_register_twice(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """A reload keeps one working command."""
    entry = await _setup(setup_guards, hass)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    msg = await _ports(hass, hass_ws_client)
    assert msg["success"]
    assert len(msg["result"]["ports"]) == 3


# ---------------- necromancer/guard/recovery ----------------


async def _recovery(
    hass: HomeAssistant, hass_ws_client: WsClientFactory, *, access_token=None, **req
) -> dict:
    kw = {"access_token": access_token} if access_token else {}
    client = await hass_ws_client(hass, **kw)
    await client.send_json_auto_id({"type": "necromancer/guard/recovery", **req})
    return await client.receive_json()


def _status(hass: HomeAssistant, subentry_id: str) -> str:
    eid = entity_id_for(hass, subentry_id, "sensor", "status")
    assert eid
    return eid


async def _setup_mixed(setup_guards: SetupGuards, hass: HomeAssistant):
    """guard0-2: the PoE guards of `_setup`; guard3-6: switch, script, actions, notify."""
    _states(hass)
    hass.states.async_set("switch.guard_target", "on", {"friendly_name": "Pool plug"})
    hass.states.async_set("script.reboot_nas", "off", {"friendly_name": "Reboot NAS"})
    hass.states.async_set("switch.port_5_poe", "on", {"friendly_name": "SW1 Port 5"})
    return await setup_guards(
        make_guard("Office AP", strategy="poe_port", expected_id="aa:bb:cc:00:11:22"),
        make_guard("Garage Cam", strategy="poe_port", expected_id="CAMERA-GARAGE"),
        make_guard("Lost Device", strategy="poe_port", expected_id="nowhere"),
        make_guard("Pool", strategy="switch_check"),
        make_guard(
            "NAS",
            strategy="action",
            action=[
                {
                    "action": "script.turn_on",
                    "target": {"entity_id": "script.reboot_nas"},
                }
            ],
        ),
        make_guard(
            "Router",
            strategy="actions",
            off_action=[{"action": "script.a"}, {"delay": 1}],
            on_action=[{"action": "script.b"}],
        ),
        make_guard("Watch", strategy="notify"),
        options={"ports": [PORT_LIVE, PORT_STATIC, PORT_CONFLICT]},
    )


async def test_recovery_switch_guard(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """A switch guard names its switch; nothing PoE-related is set."""
    entry = await _setup_mixed(setup_guards, hass)
    msg = await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard3"))
    assert msg["success"], msg
    res = msg["result"]
    assert res["entry_id"] == entry.entry_id
    assert res["subentry_id"] == "guard3"
    assert res["status_entity"] == _status(hass, "guard3")
    assert res["name"] == "Pool"
    assert res["type"] == "switch"
    assert res["can_recover"] is True
    assert res["dormant"] is False
    assert res["running"] is True
    assert res["target_entity"] == "switch.guard_target"
    assert res["target_name"] == "Pool plug"
    assert res["script_entity"] is None
    assert res["steps"] is None
    assert res["match"] is None
    assert res["port"] is None
    assert res["port_labels"] == []
    assert res["hidden"] == []


async def test_recovery_action_guards(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """A one-script action names the script; off/on actions only count steps."""
    await _setup_mixed(setup_guards, hass)
    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard4")))[
        "result"
    ]
    assert res["type"] == "action"
    assert res["script_entity"] == res["target_entity"] == "script.reboot_nas"
    assert res["target_name"] == "Reboot NAS"
    assert res["steps"] == 1

    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard5")))[
        "result"
    ]
    assert res["type"] == "actions"
    assert res["script_entity"] is None
    assert res["target_entity"] is None
    assert res["target_name"] is None
    assert res["steps"] == 3


async def test_recovery_notify_guard(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """A notify-only guard repairs nothing."""
    await _setup_mixed(setup_guards, hass)
    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard6")))[
        "result"
    ]
    assert res["type"] == "notify"
    assert res["can_recover"] is False
    assert res["target_entity"] is None


async def test_recovery_poe_live_static_and_none(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """Live by an id entity, by a fixed id, and an id no port knows."""
    await _setup_mixed(setup_guards, hass)
    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard0")))[
        "result"
    ]
    assert res["type"] == "poe_port"
    assert res["expected_id"] == "aa:bb:cc:00:11:22"
    assert res["expected_norm"] == "aa:bb:cc:00:11:22"
    assert res["match"] == "live"
    assert res["port_label"] == "Port 5"
    assert res["port_labels"] == ["Port 5"]
    assert res["actuator"] == res["target_entity"] == "switch.port_5_poe"
    assert res["actuator_name"] == res["target_name"] == "SW1 Port 5"
    assert res["fabric_status"] == "good"
    assert res["last_cycle"] is None
    port = res["port"]
    assert port["label"] == "Port 5"
    assert port["id_source"] == "entity"
    assert port["id_entity"] == "sensor.port_5_lldp"
    assert port["id_norm"] == "aa:bb:cc:00:11:22"
    assert port["status_state"] == "on"
    assert port["actuator_state"] == "on"
    assert "guards" not in port  # one port of one guard, never the table

    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard1")))[
        "result"
    ]
    assert res["match"] == "live"
    assert res["port_label"] == "Port 6"
    assert res["port"]["id_source"] == "static"

    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard2")))[
        "result"
    ]
    assert res["match"] == "none"
    assert res["port_label"] is None
    assert res["port"] is None
    assert res["target_entity"] is None


async def test_recovery_poe_last_known_mismatch_and_ambiguous(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """Gone from the port (last known, with the last cycle), re-cabled, doubled.

    Reading never changes the fabric's cache (read-only, unlike a repair).
    """
    await _setup_mixed(setup_guards, hass)
    fabric = hass.data[DOMAIN]["fabric"]
    status = _status(hass, "guard0")

    hass.states.async_set("sensor.port_5_lldp", "none", {"mac": "-"})
    await hass.async_block_till_done()
    with patch.object(fabric, "_cycle", AsyncMock(return_value=False)):
        assert not await fabric.repair("aa:bb:cc:00:11:22")
    res = (await _recovery(hass, hass_ws_client, entity_id=status))["result"]
    assert res["match"] == "last_known"
    assert res["port_label"] == "Port 5"
    assert res["fabric_status"] == "failed"
    assert res["last_cycle"]["ok"] is False
    assert res["last_cycle"]["time"]
    assert res["port"]["id_norm"] is None

    # Another device on the port now: the fabric would refuse to cycle it.
    hass.states.async_set("sensor.port_5_lldp", "cam", {"mac": "3C:22:FB:12:34:56"})
    await hass.async_block_till_done()
    res = (await _recovery(hass, hass_ws_client, entity_id=status))["result"]
    assert res["match"] == "mismatch"
    assert res["port_label"] == "Port 5"
    assert res["port"]["id_norm"] == "3c:22:fb:12:34:56"
    assert fabric.cache.get("aa:bb:cc:00:11:22") == "Port 5"

    # The camera's fixed id now shows up on a second port: no single port.
    hass.states.async_set("sensor.port_5_lldp", "cam", {"mac": "camera-garage"})
    await hass.async_block_till_done()
    res = (await _recovery(hass, hass_ws_client, entity_id=_status(hass, "guard1")))[
        "result"
    ]
    assert res["match"] == "ambiguous"
    assert sorted(res["port_labels"]) == ["Port 5", "Port 6"]
    assert res["port_label"] is None
    assert res["port"] is None


async def test_recovery_by_subentry_id_and_other_entity(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """An admin may name the guard by subentry id or by any of its entities."""
    await _setup_mixed(setup_guards, hass)
    by_sub = await _recovery(hass, hass_ws_client, subentry_id="guard3")
    by_health = await _recovery(
        hass,
        hass_ws_client,
        entity_id=entity_id_for(hass, "guard3", "binary_sensor", "health"),
    )
    assert by_sub["success"] and by_health["success"]
    assert by_sub["result"] == by_health["result"]
    assert by_sub["result"]["target_entity"] == "switch.guard_target"


async def test_recovery_errors(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """Neither id, both ids, a foreign entity, an unknown subentry."""
    await _setup_mixed(setup_guards, hass)
    hass.states.async_set("sensor.other", "1")

    msg = await _recovery(hass, hass_ws_client)
    assert msg["error"]["code"] == "invalid_format"
    msg = await _recovery(
        hass, hass_ws_client, entity_id=_status(hass, "guard0"), subentry_id="guard0"
    )
    assert msg["error"]["code"] == "invalid_format"
    msg = await _recovery(hass, hass_ws_client, entity_id="sensor.other")
    assert msg["error"]["code"] == "not_found"
    msg = await _recovery(hass, hass_ws_client, subentry_id="nope")
    assert msg["error"]["code"] == "not_found"


async def test_recovery_non_admin(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_ws_client: WsClientFactory,
    hass_read_only_user,
    hass_read_only_access_token: str,
) -> None:
    """A user who may read the guard gets it, with unreadable entities blanked.

    Never by subentry id (no entity to check), never a guard they cannot read.
    """
    await _setup_mixed(setup_guards, hass)
    token = hass_read_only_access_token
    status = _status(hass, "guard0")

    # The read-only group reads every entity: the full answer.
    msg = await _recovery(hass, hass_ws_client, access_token=token, entity_id=status)
    assert msg["success"], msg
    assert msg["result"]["actuator"] == "switch.port_5_poe"
    assert msg["result"]["hidden"] == []

    msg = await _recovery(
        hass, hass_ws_client, access_token=token, subentry_id="guard0"
    )
    assert msg["error"]["code"] == "unauthorized"

    # Only the guard's own status sensor is readable.
    hass_read_only_user.mock_policy({"entities": {"entity_ids": {status: True}}})
    msg = await _recovery(hass, hass_ws_client, access_token=token, entity_id=status)
    assert msg["success"], msg
    res = msg["result"]
    assert res["match"] == "live"
    assert res["port_label"] == "Port 5"
    assert res["fabric_status"] == "good"
    assert res["actuator"] is None
    assert res["actuator_name"] is None
    assert res["target_entity"] is None
    assert res["target_name"] is None
    port = res["port"]
    assert port["actuator"] is None
    assert port["actuator_state"] is None
    assert port["status_entity"] is None
    assert port["status_state"] is None
    assert port["id_entity"] is None
    assert port["id"] is None
    assert port["id_norm"] is None
    # What was blanked, so the card says "not visible" instead of guessing
    # ("Ready" for a port whose status it cannot see).
    assert res["hidden"] == [
        "target_entity",
        "actuator",
        "port.actuator",
        "port.status_entity",
        "port.id_entity",
    ]

    msg = await _recovery(
        hass, hass_ws_client, access_token=token, entity_id=_status(hass, "guard3")
    )
    assert msg["error"]["code"] == "unauthorized"


async def test_recovery_non_admin_unreadable_status_entity(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_ws_client: WsClientFactory,
    hass_read_only_user,
    hass_read_only_access_token: str,
) -> None:
    """Asked by another guard entity, the unreadable status sensor is blanked too."""
    await _setup_mixed(setup_guards, hass)
    health = entity_id_for(hass, "guard0", "binary_sensor", "health")
    assert health
    hass_read_only_user.mock_policy({"entities": {"entity_ids": {health: True}}})
    msg = await _recovery(
        hass, hass_ws_client, access_token=hass_read_only_access_token, entity_id=health
    )
    assert msg["success"], msg
    assert msg["result"]["status_entity"] is None
    assert "status_entity" in msg["result"]["hidden"]

    # Readable: kept.
    status = _status(hass, "guard0")
    hass_read_only_user.mock_policy(
        {"entities": {"entity_ids": {health: True, status: True}}}
    )
    msg = await _recovery(
        hass, hass_ws_client, access_token=hass_read_only_access_token, entity_id=health
    )
    assert msg["result"]["status_entity"] == status
    assert "status_entity" not in msg["result"]["hidden"]


async def test_recovery_non_admin_mismatch_hides_other_device_id(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_ws_client: WsClientFactory,
    hass_read_only_user,
    hass_read_only_access_token: str,
) -> None:
    """A fixed-id port re-configured to another device: its id is admin-only.

    The cache still maps the guard's id to the port (nothing cycled since), so
    the answer is `mismatch` with that port; a non-admin must not learn the
    other device's id from it, even when every entity is readable.
    """
    await _setup_mixed(setup_guards, hass)
    fabric = hass.data[DOMAIN]["fabric"]
    other = "DD:EE:FF:00:00:01"
    ports = [dict(p) for p in fabric.ports]
    for port in ports:
        if port["label"] == "Port 6":
            port["id_static"] = other
    fabric.set_ports(ports)
    status = _status(hass, "guard1")

    res = (await _recovery(hass, hass_ws_client, entity_id=status))["result"]
    assert res["match"] == "mismatch"
    assert res["port"]["id_static"] == other  # the admin sees it

    token = hass_read_only_access_token
    for policy in (None, {"entities": {"entity_ids": {status: True}}}):
        if policy is not None:
            hass_read_only_user.mock_policy(policy)
        msg = await _recovery(
            hass, hass_ws_client, access_token=token, entity_id=status
        )
        assert msg["success"], msg
        res = msg["result"]
        assert res["match"] == "mismatch"
        assert res["port_label"] == "Port 6"
        port = res["port"]
        assert port["id_source"] == "static"
        assert port["id_static"] is None
        assert port["id"] is None
        assert port["id_norm"] is None
        assert other.lower() not in str(res).lower()


async def test_recovery_non_admin_keeps_own_id(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_ws_client: WsClientFactory,
    hass_read_only_access_token: str,
) -> None:
    """The guard's own id on its port (live, fixed) stays in a non-admin answer."""
    await _setup_mixed(setup_guards, hass)
    token = hass_read_only_access_token
    res = (
        await _recovery(
            hass, hass_ws_client, access_token=token, entity_id=_status(hass, "guard1")
        )
    )["result"]
    assert res["match"] == "live"
    assert res["port"]["id_static"] == "camera-garage"
    res = (
        await _recovery(
            hass, hass_ws_client, access_token=token, entity_id=_status(hass, "guard0")
        )
    )["result"]
    assert res["port"]["id_norm"] == "aa:bb:cc:00:11:22"


async def test_recovery_dormant_vs_failed_setup(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """`dormant` only for a disabled device; a guard that failed to set up is not.

    Both have no engine (`running` false).
    """
    # Imported here: the custom component loads only once the test enables it.
    from custom_components.necromancer import _build_engine as real_build

    def build(hass, name, *args, **kwargs):
        if name == "Pool":
            raise ValueError("malformed")
        return real_build(hass, name, *args, **kwargs)

    with patch("custom_components.necromancer._build_engine", side_effect=build):
        entry = await _setup_mixed(setup_guards, hass)
    assert "guard3" not in entry.runtime_data.engines
    res = (await _recovery(hass, hass_ws_client, subentry_id="guard3"))["result"]
    assert res["dormant"] is False
    assert res["running"] is False
    assert res["can_recover"] is True

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier((DOMAIN, "guard4"), entry.entry_id)
    assert device is not None
    dev_reg.async_update_device(device.id, disabled_by=dr.DeviceEntryDisabler.USER)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert "guard4" not in entry.runtime_data.engines
    res = (await _recovery(hass, hass_ws_client, subentry_id="guard4"))["result"]
    assert res["dormant"] is True
    assert res["running"] is False


async def test_recovery_is_registered_once_and_survives_unload(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_ws_client: WsClientFactory
) -> None:
    """After a reload it still answers; after unload a guard is not found."""
    entry = await _setup_mixed(setup_guards, hass)
    status = _status(hass, "guard3")
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert (await _recovery(hass, hass_ws_client, entity_id=status))["success"]

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    msg = await _recovery(hass, hass_ws_client, entity_id=status)
    assert msg["error"]["code"] == "not_found"
