"""Read-only WebSocket API for Necromancer's own cards.

`necromancer/poe/ports` lists the PoE ports for the PoE card: ports live in the
entry's options and have no entities, so the card cannot read them from the
state machine. Admin only (the list names switches, ids and status entities) and
strictly read-only: restarting a port stays the `repair_poe_port` service, and
editing the list stays the options flow (one validation, in Python).

`necromancer/guard/recovery` answers "what does this guard repair, and how does
that look right now" for one guard (the cards' recovery popup): the strategy,
the target entity, and for a PoE guard where its expected id resolves *now*
(port, actuator, match kind, port status, last cycle). These values move at
runtime, so they are read on demand instead of living in status-sensor
attributes (every attribute change is a recorder row). Any user who may read
the guard's entity may ask for that guard, never for the whole port table;
entity ids the user may not read are blanked (with their values) for non-admins,
and so is another device's id on the guard's port (a `mismatch`).
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers import (
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
)

from .const import (
    CONF_ACTION,
    CONF_ACTUATOR,
    CONF_DRIVER,
    CONF_EXPECTED_ID,
    CONF_ID_ATTRIBUTE,
    CONF_ID_ENTITY,
    CONF_ID_STATIC,
    CONF_LABEL,
    CONF_OFF_ACTION,
    CONF_ON_ACTION,
    CONF_STATUS_ATTRIBUTE,
    CONF_STATUS_ENTITY,
    CONF_STATUS_OFF,
    CONF_STATUS_ON,
    CONF_SWITCH_ENTITY,
    CONF_TYPE,
    DOMAIN,
    STRATEGY_POE,
    SUBENTRY_TYPE_DEVICE,
)
from .core.actions import action_steps, single_script
from .core.poe import PoeFabric, normalize_id

WS_TYPE_POE_PORTS = f"{DOMAIN}/poe/ports"
WS_TYPE_GUARD_RECOVERY = f"{DOMAIN}/guard/recovery"

# Engine driver type -> the flow's strategy name (as `driver_type` on the status
# sensor), so the cards never see the internal names.
_STRATEGY = {
    "switch_cycle": "switch",
    "action_call": "action",
    "action_cycle": "actions",
    "poe_port": "poe_port",
    "noop": "notify",
}

# Key in hass.data[DOMAIN]: commands are registered once per HA run.
_REGISTERED = "websocket_registered"


@callback
def async_register_websocket(hass: HomeAssistant) -> None:
    """Register the cards' WebSocket commands (idempotent across reloads)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_REGISTERED):
        return
    websocket_api.async_register_command(hass, ws_poe_ports)
    websocket_api.async_register_command(hass, ws_guard_recovery)
    domain_data[_REGISTERED] = True


def _read(hass: HomeAssistant, entity_id: str | None, attribute: str | None) -> Any:
    """An entity's state (or one attribute) as a string; None when absent."""
    if not entity_id or (state := hass.states.get(entity_id)) is None:
        return None
    value = state.attributes.get(attribute) if attribute else state.state
    return None if value is None else str(value)


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value]
    return [str(value)]


def _poe_guards(hass: HomeAssistant, entry, fabric: PoeFabric) -> dict[str, list]:
    """Port label -> the poe_port guards whose expected id points there."""
    ent_reg = er.async_get(hass)
    by_port: dict[str, list] = {}
    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SUBENTRY_TYPE_DEVICE:
            continue
        driver = subentry.data.get(CONF_DRIVER) or {}
        if driver.get(CONF_TYPE) != STRATEGY_POE:
            continue
        expected = str(driver.get(CONF_EXPECTED_ID) or "")
        labels, kind = fabric.locate(expected)
        guard = {
            "subentry_id": subentry_id,
            "name": subentry.data.get(CONF_NAME, subentry.title),
            "status_entity": ent_reg.async_get_entity_id(
                "sensor", DOMAIN, f"{subentry_id}_status"
            ),
            "expected_id": expected,
            # Compared with the port's `id_norm` by the card: a `last_known` guard
            # whose port now reports another id is a mismatch (the fabric refuses).
            "expected_norm": normalize_id(expected),
            "match": kind,
        }
        for label in labels:
            by_port.setdefault(label, []).append(guard)
    return by_port


@callback
def _port_payload(hass: HomeAssistant, fabric: PoeFabric, port: dict) -> dict:
    """One configured port with its live values, fabric status and last cycle."""
    label = port.get(CONF_LABEL)
    static = port.get(CONF_ID_STATIC)
    id_entity = port.get(CONF_ID_ENTITY)
    if static and id_entity:
        id_source = "conflict"
    elif static:
        id_source = "static"
    elif id_entity:
        id_source = "entity"
    else:
        id_source = "none"
    actuator = port.get(CONF_ACTUATOR)
    current = fabric.current_id(port)
    return {
        "label": label,
        "actuator": actuator,
        "actuator_state": _read(hass, actuator, None),
        "id_source": id_source,
        "id_entity": id_entity,
        "id_attribute": port.get(CONF_ID_ATTRIBUTE),
        "id_static": static,
        "id": current,
        # The fabric's own normalisation (trimmed, lower case); None for
        # a placeholder ("-", "none", …) = nothing connected right now.
        "id_norm": normalize_id(current),
        "status_entity": port.get(CONF_STATUS_ENTITY),
        "status_attribute": port.get(CONF_STATUS_ATTRIBUTE),
        "status_state": _read(
            hass,
            port.get(CONF_STATUS_ENTITY),
            port.get(CONF_STATUS_ATTRIBUTE),
        ),
        "status_on": _as_list(port.get(CONF_STATUS_ON)),
        "status_off": _as_list(port.get(CONF_STATUS_OFF)),
        "fabric_status": fabric.status(label),
        "last_cycle": fabric.last_cycle(label),
    }


@callback
def poe_ports_payload(hass: HomeAssistant, entry, fabric: PoeFabric) -> list[dict]:
    """Every configured port with its live values, fabric status and guards."""
    guards = _poe_guards(hass, entry, fabric)
    return [
        {
            **_port_payload(hass, fabric, port),
            "guards": guards.get(port.get(CONF_LABEL), []),
        }
        for port in fabric.ports
    ]


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_POE_PORTS})
@callback
def ws_poe_ports(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """List the PoE ports (read-only). Empty while no entry is loaded."""
    entry = next(iter(hass.config_entries.async_loaded_entries(DOMAIN)), None)
    fabric: PoeFabric | None = hass.data.get(DOMAIN, {}).get("fabric")
    if entry is None or fabric is None:
        connection.send_result(msg["id"], {"entry_id": None, "ports": []})
        return
    connection.send_result(
        msg["id"],
        {
            "entry_id": entry.entry_id,
            "ports": poe_ports_payload(hass, entry, fabric),
        },
    )


# ---------------------------------------------------------------------------
# necromancer/guard/recovery
# ---------------------------------------------------------------------------


def _entity_name(hass: HomeAssistant, entity_id: str | None) -> str | None:
    """An entity's display name: friendly_name, else the registry's, else the id."""
    if not entity_id:
        return None
    if (state := hass.states.get(entity_id)) is not None and (
        name := state.attributes.get("friendly_name")
    ):
        return str(name)
    if (entry := er.async_get(hass).async_get(entity_id)) is not None and (
        name := entry.name or entry.original_name
    ):
        return str(name)
    return entity_id


def _find_guard(hass: HomeAssistant, msg: dict) -> tuple[Any, str, str | None] | None:
    """(config entry, subentry id, the entity asked about) for a request, or None.

    By `entity_id`: any entity of a guard (the status sensor is the usual one);
    by `subentry_id`: the guard itself, even a dormant one without entities.
    """
    if entity_id := msg.get("entity_id"):
        reg = er.async_get(hass).async_get(entity_id)
        if reg is None or reg.platform != DOMAIN or not reg.config_subentry_id:
            return None
        entry = hass.config_entries.async_get_entry(reg.config_entry_id)
        subentry_id = reg.config_subentry_id
    else:
        subentry_id = msg["subentry_id"]
        entry = next(
            (
                e
                for e in hass.config_entries.async_loaded_entries(DOMAIN)
                if subentry_id in e.subentries
            ),
            None,
        )
        entity_id = None
    if (
        entry is None
        or entry.domain != DOMAIN
        or entry.state is not ConfigEntryState.LOADED
    ):
        return None
    subentry = entry.subentries.get(subentry_id)
    if subentry is None or subentry.subentry_type != SUBENTRY_TYPE_DEVICE:
        return None
    return entry, subentry_id, entity_id


def _poe_resolution(hass: HomeAssistant, fabric: PoeFabric | None, expected: str):
    """Where a PoE guard's expected id points now (read-only, nothing learned).

    `match`: `live` (exactly one port reports it), `ambiguous` (several do),
    `last_known` (none does; the cache's port reports nothing, so the fabric would
    cycle it), `mismatch` (the cache's port now reports another id: the fabric
    refuses) or `none`. Without a fabric (no entry loaded) everything is None.
    """
    if fabric is None:
        return {"match": None, "port_labels": [], "port": None}
    labels, kind = fabric.locate(expected)
    port = None
    if len(labels) == 1:
        port = next((p for p in fabric.ports if p.get(CONF_LABEL) == labels[0]), None)
    if (
        kind == "last_known"
        and port is not None
        and normalize_id(fabric.current_id(port))
    ):
        kind = "mismatch"
    return {
        "match": kind,
        "port_labels": labels,
        "port": _port_payload(hass, fabric, port) if port is not None else None,
    }


def _device_disabled(hass: HomeAssistant, entry, subentry_id: str) -> bool:
    """Whether the guard's device is disabled (the guard is dormant).

    The same test as setup's `_dormant_guards`: no device yet is not a disabled one.
    """
    device = dr.async_get(hass).async_get_device_by_identifier(
        (DOMAIN, subentry_id), entry.entry_id
    )
    return device is not None and device.disabled


@callback
def guard_recovery_payload(
    hass: HomeAssistant, entry, subentry_id: str, fabric: PoeFabric | None
) -> dict:
    """What a guard repairs and, for a PoE guard, where its port is right now."""
    subentry = entry.subentries[subentry_id]
    engine = entry.runtime_data.engines.get(subentry_id)
    # The running engine's driver config (the subentry's, as built); a dormant
    # guard has no engine, its subentry says the same.
    driver = (engine.driver.config if engine else None) or (
        subentry.data.get(CONF_DRIVER) or {}
    )
    driver_type = driver.get(CONF_TYPE)
    strategy = _STRATEGY.get(driver_type, "notify")
    out: dict[str, Any] = {
        "entry_id": entry.entry_id,
        "subentry_id": subentry_id,
        "status_entity": er.async_get(hass).async_get_entity_id(
            "sensor", DOMAIN, f"{subentry_id}_status"
        ),
        "name": subentry.data.get(CONF_NAME, subentry.title),
        "type": strategy,
        "can_recover": strategy != "notify",
        # Dormant = its device is disabled (no engine on purpose); a guard whose
        # setup failed has no engine either but is not dormant: `running` false.
        "dormant": _device_disabled(hass, entry, subentry_id),
        "running": engine is not None,
        "target_entity": None,
        "target_name": None,
        "script_entity": None,
        "steps": None,
        "expected_id": None,
        "expected_norm": None,
        "match": None,
        "port_label": None,
        "port_labels": [],
        "actuator": None,
        "actuator_name": None,
        "fabric_status": None,
        "last_cycle": None,
        "port": None,
        # The entity fields blanked for a non-admin ("actuator", "port.status_entity",
        # ...): a card tells "not visible to you" from "not configured".
        "hidden": [],
    }
    if driver_type == "switch_cycle":
        out["target_entity"] = driver.get(CONF_SWITCH_ENTITY)
    elif driver_type == "action_call":
        out["script_entity"] = single_script(driver.get(CONF_ACTION))
        out["target_entity"] = out["script_entity"]
        out["steps"] = action_steps(driver.get(CONF_ACTION))
    elif driver_type == "action_cycle":
        out["steps"] = action_steps(driver.get(CONF_OFF_ACTION)) + action_steps(
            driver.get(CONF_ON_ACTION)
        )
    elif driver_type == "poe_port":
        expected = str(driver.get(CONF_EXPECTED_ID) or "")
        res = _poe_resolution(hass, fabric, expected)
        port = res["port"]
        out.update(
            expected_id=expected,
            expected_norm=normalize_id(expected),
            match=res["match"],
            port_labels=res["port_labels"],
            port=port,
        )
        if port is not None:
            out.update(
                port_label=port["label"],
                actuator=port["actuator"],
                target_entity=port["actuator"],
                fabric_status=port["fabric_status"],
                last_cycle=port["last_cycle"],
            )
    out["target_name"] = _entity_name(hass, out["target_entity"])
    out["actuator_name"] = _entity_name(hass, out["actuator"])
    return out


# Entity fields of the payload and the values read from them: a non-admin who
# may not read the entity gets neither.
_ENTITY_FIELDS = {
    "status_entity": (),
    "target_entity": ("target_name",),
    "script_entity": (),
    "actuator": ("actuator_name",),
}
_PORT_ENTITY_FIELDS = {
    "actuator": ("actuator_state",),
    "status_entity": ("status_state",),
    "id_entity": ("id", "id_norm"),
}


def _redact(payload: dict, can_read) -> dict:
    """Blank what a non-admin user may not see.

    The entities they may not read (and the values read from them), and any id on
    the guard's port other than the guard's own expected id. Each blanked entity
    field is listed in `hidden` (port fields as `port.<field>`).
    """
    hidden: list[str] = payload["hidden"]
    for field, derived in _ENTITY_FIELDS.items():
        if payload[field] and not can_read(payload[field]):
            payload[field] = None
            hidden.append(field)
            for key in derived:
                payload[key] = None
    if (port := payload.get("port")) is not None:
        for field, derived in _PORT_ENTITY_FIELDS.items():
            if port[field] and not can_read(port[field]):
                port[field] = None
                hidden.append(f"port.{field}")
                # A fixed id is no entity value: only an id entity's reading goes.
                if field != "id_entity" or port["id_source"] != "static":
                    for key in derived:
                        port[key] = None
        # Only the guard's own expected id: another device's id on its port (a
        # re-cabled or re-configured port, `mismatch`) belongs to the port table,
        # which is admin-only. `match` alone tells the card the repair is blocked.
        expected = payload.get("expected_norm")
        if normalize_id(port["id_static"]) not in (None, expected):
            port["id_static"] = None
        if port["id_norm"] is not None and port["id_norm"] != expected:
            port["id"] = port["id_norm"] = None
    return payload


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_GUARD_RECOVERY,
        vol.Exclusive("entity_id", "guard"): cv.entity_id,
        vol.Exclusive("subentry_id", "guard"): str,
    }
)
@callback
def ws_guard_recovery(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """One guard's recovery target and live PoE resolution (read-only).

    Admins may ask for any guard (by entity or subentry id). Other users only by
    an entity of the guard they may read (HA's entity permissions), and get the
    entities they may not read blanked; the whole port table stays admin-only
    (`necromancer/poe/ports`).
    """
    if not msg.get("entity_id") and not msg.get("subentry_id"):
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            "entity_id or subentry_id is required",
        )
        return
    user = connection.user
    if not user.is_admin and not msg.get("entity_id"):
        # A subentry id names no entity to check a permission against.
        raise Unauthorized(permission=POLICY_READ)
    found = _find_guard(hass, msg)
    if found is None:
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, "Necromancer guard not found"
        )
        return
    entry, subentry_id, entity_id = found
    if not user.is_admin and not user.permissions.check_entity(entity_id, POLICY_READ):
        raise Unauthorized(entity_id=entity_id, permission=POLICY_READ)
    fabric: PoeFabric | None = hass.data.get(DOMAIN, {}).get("fabric")
    payload = guard_recovery_payload(hass, entry, subentry_id, fabric)
    if not user.is_admin:
        payload = _redact(
            payload, lambda eid: user.permissions.check_entity(eid, POLICY_READ)
        )
    connection.send_result(msg["id"], payload)
