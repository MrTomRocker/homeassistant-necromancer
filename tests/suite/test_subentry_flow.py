"""Device subentry (guard) config-flow tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.helpers.network import NoURLAvailableError, get_url

from .conftest import (
    HEARTBEAT_TOKEN,
    SetupGuards,
    entity_id_for,
    make_guard,
)

type ClientFactory = Any

# Mirror const.DEFAULT_DEBOUNCE / DEFAULT_HEARTBEAT_DEBOUNCE (the suite does not
# import the component). A heartbeat's grace after a missed ping is its debounce.
DEFAULT_DEBOUNCE = 120
DEFAULT_HEARTBEAT_DEBOUNCE = 3600

STATE_HEALTH = {
    "entity_id": "binary_sensor.guard_health",
    "on_value": ["on"],
    "off_value": ["off"],
}


async def _init(hass: HomeAssistant, entry_id: str) -> dict:
    return await hass.config_entries.subentries.async_init(
        (entry_id, "device"), context={"source": SOURCE_USER}
    )


async def _cfg(hass: HomeAssistant, flow_id: str, data: dict) -> dict:
    return await hass.config_entries.subentries.async_configure(flow_id, data)


async def test_create_switch_guard(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Full happy path: source → device → strategy → switch → created subentry."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards()

    result = await _init(hass, entry.entry_id)
    assert result["step_id"] == "user"

    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    assert result["step_id"] == "device"

    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Switch Guard", **STATE_HEALTH},
    )
    assert result["step_id"] == "strategy"

    result = await _cfg(hass, result["flow_id"], {"strategy": "switch"})
    assert result["step_id"] == "switch"

    result = await _cfg(
        hass,
        result["flow_id"],
        {
            "switch_entity": "switch.guard_target",
            "off_on_delay": 2,
            "behavior": {"debounce": 5, "cooldown": 10},
            "notification": {},
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Switch Guard"

    data = result["data"]
    assert data["name"] == "Switch Guard"
    assert data["driver"] == {
        "type": "switch_cycle",
        "switch_entity": "switch.guard_target",
        "off_on_delay": 2,
    }
    assert data["policy"] == {"type": "standard"}
    assert data["health"]["type"] == "entity_state"
    # Health-check now defaults on (toggle omitted -> verify is the default).
    assert data["behavior"]["health_check"] is True


async def test_strategy_step_lists_options(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The strategy step offers notify first, then the four recovery strategies."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Opt Guard", **STATE_HEALTH},
    )
    assert result["step_id"] == "strategy"
    schema = result["data_schema"].schema
    selector = next(v for k, v in schema.items() if str(k) == "strategy")
    options = selector.config["options"]
    assert options == [
        "notify",
        "switch",
        "action",
        "actions",
        "poe_port",
    ]


async def test_notify_strategy_routes_to_notify_step(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Picking 'notify' routes to the notify-only step, not a recovery step."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Notify Guard", **STATE_HEALTH},
    )
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    assert result["step_id"] == "notify"


async def test_duplicate_name_rejected(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A second guard reusing an existing name is rejected at the device step."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    entry = await setup_guards(make_guard("Existing", strategy="notify"))

    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Existing", **STATE_HEALTH},
    )
    assert result["step_id"] == "device"
    assert result["errors"] == {"name": "duplicate_name"}


async def test_broken_template_rejected(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """An invalid Jinja health template is rejected by TemplateSelector validation.

    In-process the selector raises `InvalidData` (the REST layer turns this into a
    form `errors` dict); either way the guard is never created.
    """
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "template_based"})
    assert result["step_id"] == "device"
    with pytest.raises(InvalidData):
        await _cfg(
            hass,
            result["flow_id"],
            {"name": "Bad Jinja", "template": "{{ 1 + }}"},
        )


async def test_empty_action_rejected(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """An action guard with no action sequence is rejected at the action step."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Empty Action", **STATE_HEALTH},
    )
    result = await _cfg(hass, result["flow_id"], {"strategy": "action"})
    assert result["step_id"] == "action"
    result = await _cfg(
        hass,
        result["flow_id"],
        {
            "recovery_action": {"action": []},
            "behavior": {"debounce": 5, "cooldown": 10},
            "notification": {},
        },
    )
    assert result["step_id"] == "action"
    assert result["errors"] == {"action": "action_required"}


# ---------------- heartbeat source ----------------

HB_URL = "http://192.168.1.8:8123"
HB_PATH = "/api/necromancer/heartbeat/"
DAY = {"days": 1, "hours": 0, "minutes": 0, "seconds": 0}
HB_DEVICE = {"period": DAY, "local_only": True}


def _default(result: dict, key: str, section: str | None = None) -> Any:
    """The default a form field shows (optionally inside a section)."""
    fields = result["data_schema"].schema
    if section is not None:
        fields = next(v for k, v in fields.items() if str(k) == section).schema.schema
    return next(k for k in fields if str(k) == key).default()


def _keys(result: dict) -> set[str]:
    return {str(k) for k in result["data_schema"].schema}


def _hb_guard(name: str = "Job", **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("strategy", "notify")
    kwargs.setdefault("debounce", 0)
    return make_guard(name, source="heartbeat_based", **kwargs)


async def _reconfigure(hass: HomeAssistant, entry_id: str, sid: str = "guard0") -> dict:
    return await hass.config_entries.subentries.async_init(
        (entry_id, "device"), context={"source": "reconfigure", "subentry_id": sid}
    )


async def _set_internal_url(hass: HomeAssistant, url: str | None = HB_URL) -> None:
    await hass.config.async_update(internal_url=url)


async def test_source_step_offers_three_types(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The first step offers state, template and heartbeat (HQ1)."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    selector = next(
        v for k, v in result["data_schema"].schema.items() if str(k) == "source_type"
    )
    assert selector.config["options"] == [
        "state_based",
        "template_based",
        "heartbeat_based",
    ]


async def test_heartbeat_create_shows_url_before_creating(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Create: heartbeat fields, notify default, debounce 1 h, URL step, then entry."""
    await _set_internal_url(hass)
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    assert result["step_id"] == "device"
    keys = _keys(result)
    assert {"name", "period", "local_only", "device_id"} <= keys
    assert "entity_id" not in keys
    # The grace is the debounce of the last step, not a field of its own.
    assert "grace" not in keys
    assert "regenerate_token" not in keys  # a new guard gets a token anyway
    assert _default(result, "period") == DAY
    assert _default(result, "local_only") is True

    result = await _cfg(hass, result["flow_id"], {"name": "PVE Sicherung", **HB_DEVICE})
    assert result["step_id"] == "strategy"
    assert _default(result, "strategy") == "notify"

    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    assert result["step_id"] == "notify"
    assert _default(result, "debounce") == DEFAULT_HEARTBEAT_DEBOUNCE

    result = await _cfg(hass, result["flow_id"], {"notification": {}})
    # The URL comes BEFORE the entry exists: closing here leaves no guard behind.
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "heartbeat_url"
    assert not entry.subentries
    url = result["description_placeholders"]["url"]
    assert url.startswith(f"{HB_URL}{HB_PATH}pve_sicherung_")
    token = url.rpartition("_")[2]
    assert len(token) == 64
    assert int(token, 16) >= 0
    # POST only: GET is refused with 405 (a GET can be prefetched or cached).
    placeholders = result["description_placeholders"]
    assert placeholders["example_ok"] == f'curl -fsS -X POST "{url}"'
    assert placeholders["example_fail"] == f'curl -fsS -X POST "{url}?status=fail"'
    assert placeholders["example"] == f'curl -fsS -X POST "{url}?status=$?"'

    result = await _cfg(hass, result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    data = result["data"]
    assert data["health"] == {
        "type": "heartbeat",
        "token": token,
        "period": 86400,
        "local_only": True,
    }
    assert data["policy"] == {"type": "notify"}
    assert data["behavior"]["debounce"] == DEFAULT_HEARTBEAT_DEBOUNCE
    assert "linked_guards" not in data


@pytest.mark.parametrize(
    ("period", "errors"),
    [
        ({"seconds": 59}, {"period": "period_too_short"}),
        ({"seconds": 0}, {"period": "period_too_short"}),
    ],
)
async def test_heartbeat_period_below_a_minute_rejected(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    period: dict,
    errors: dict,
) -> None:
    """A period under 60 s is rejected; the form keeps the entered values."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Short", "period": period, "local_only": True},
    )
    assert result["step_id"] == "device"
    assert result["errors"] == errors
    assert _default(result, "period") == period

    # Exactly one minute is fine.
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Short", "period": {"minutes": 1}, "local_only": True},
    )
    assert result["step_id"] == "strategy"


async def test_heartbeat_device_step_has_no_grace_field(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The grace is the debounce now: a `grace` field is not part of the schema."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    with pytest.raises(InvalidData):
        await _cfg(
            hass,
            result["flow_id"],
            {"name": "Old", "period": DAY, "grace": {"hours": 1}},
        )


@pytest.mark.parametrize(("debounce", "ok"), [(86400, True), (86401, False)])
async def test_debounce_up_to_one_day_for_every_guard(
    hass: HomeAssistant, setup_guards: SetupGuards, debounce: int, ok: bool
) -> None:
    """The debounce box accepts up to 1 day (a heartbeat's grace can be long)."""
    entry = await setup_guards()
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(hass, result["flow_id"], {"name": "Slow", **STATE_HEALTH})
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    data = {"debounce": debounce, "notification": {}}
    if not ok:
        with pytest.raises(InvalidData):
            await _cfg(hass, result["flow_id"], data)
        return
    result = await _cfg(hass, result["flow_id"], data)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["behavior"]["debounce"] == 86400


async def test_heartbeat_url_without_any_ha_url_is_path_only(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """No internal/external URL known: the step shows only the path."""
    entry = await setup_guards(_hb_guard())
    result = await _reconfigure(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    result = await _cfg(hass, result["flow_id"], {"name": "Job", **HB_DEVICE})
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    with patch(
        "custom_components.necromancer.core.health.heartbeat.get_url",
        side_effect=NoURLAvailableError,
    ):
        result = await _cfg(hass, result["flow_id"], {"notification": {}})
    assert result["step_id"] == "heartbeat_url"
    assert result["description_placeholders"]["url"] == (
        f"{HB_PATH}job_{HEARTBEAT_TOKEN}"
    )


@pytest.mark.parametrize("local_only", [True, False])
async def test_heartbeat_url_prefers_internal_and_respects_local_only(
    hass: HomeAssistant, setup_guards: SetupGuards, local_only: bool
) -> None:
    """Internal URL wins even with an external one; local_only forbids external."""
    await hass.config.async_update(
        internal_url=HB_URL, external_url="https://ha.example.com"
    )
    entry = await setup_guards(_hb_guard())
    result = await _reconfigure(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    with patch(
        "custom_components.necromancer.core.health.heartbeat.get_url", wraps=get_url
    ) as spy:
        result = await _cfg(
            hass,
            result["flow_id"],
            {"name": "Job", **HB_DEVICE, "local_only": local_only},
        )
        result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
        result = await _cfg(hass, result["flow_id"], {"notification": {}})
    assert result["description_placeholders"]["url"].startswith(HB_URL + HB_PATH)
    kwargs = spy.call_args.kwargs
    assert kwargs["allow_external"] is (not local_only)
    assert kwargs["prefer_external"] is False
    assert kwargs["allow_ip"] is True


async def test_heartbeat_reconfigure_unchanged_shows_same_url(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Reconfigure without change: same token, info step with the same URL.

    The stored health still carries a `grace` (dev data from before it became the
    debounce): it loads without error, is not offered and is dropped on save.
    """
    await _set_internal_url(hass)
    guard = _hb_guard(period=7200, local_only=False)
    guard["health"]["grace"] = 600
    entry = await setup_guards(guard)
    result = await _reconfigure(hass, entry.entry_id)
    assert result["step_id"] == "reconfigure"
    assert _default(result, "source_type") == "heartbeat_based"

    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    assert result["step_id"] == "device"
    assert "regenerate_token" in _keys(result)
    assert _default(result, "regenerate_token") is False
    assert _default(result, "period") == {
        "days": 0,
        "hours": 2,
        "minutes": 0,
        "seconds": 0,
    }
    assert "grace" not in _keys(result)
    assert _default(result, "local_only") is False

    result = await _cfg(
        hass,
        result["flow_id"],
        {
            "name": "Job",
            "period": _default(result, "period"),
            "local_only": False,
            "regenerate_token": False,
        },
    )
    assert _default(result, "strategy") == "notify"
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    assert _default(result, "debounce") == 0
    result = await _cfg(hass, result["flow_id"], {"notification": {}})
    assert result["step_id"] == "heartbeat_url"
    assert result["description_placeholders"]["url"] == (
        f"{HB_URL}{HB_PATH}job_{HEARTBEAT_TOKEN}"
    )

    result = await _cfg(hass, result["flow_id"], {})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    health = entry.subentries["guard0"].data["health"]
    assert health["token"] == HEARTBEAT_TOKEN
    assert (health["period"], health["local_only"]) == (7200, False)
    assert "grace" not in health


async def test_heartbeat_regenerate_token(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
) -> None:
    """New token: own info step with the new URL, old URL 404, guard waits again."""
    await _set_internal_url(hass)
    entry = await setup_guards(_hb_guard())
    client = await hass_client_no_auth()
    status_id = entity_id_for(hass, "guard0", "sensor", "status")
    old_path = f"{HB_PATH}job_{HEARTBEAT_TOKEN}"
    assert (await client.post(old_path)).status == 200
    await hass.async_block_till_done()
    assert hass.states.get(status_id).attributes["awaiting_first_success"] is False

    result = await _reconfigure(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    result = await _cfg(
        hass,
        result["flow_id"],
        {"name": "Job", **HB_DEVICE, "regenerate_token": True},
    )
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    result = await _cfg(hass, result["flow_id"], {"notification": {}})
    assert result["step_id"] == "heartbeat_url_new"
    url = result["description_placeholders"]["url"]
    new_token = url.rpartition("_")[2]
    assert len(new_token) == 64
    assert new_token != HEARTBEAT_TOKEN
    # Not saved yet: the old URL still works until the step is submitted.
    assert entry.subentries["guard0"].data["health"]["token"] == HEARTBEAT_TOKEN

    result = await _cfg(hass, result["flow_id"], {})
    assert result["reason"] == "reconfigure_successful"
    await hass.async_block_till_done()
    assert entry.subentries["guard0"].data["health"]["token"] == new_token

    attrs = hass.states.get(status_id).attributes
    assert attrs["awaiting_first_success"] is True
    assert hass.states.get(status_id).state == "blind"
    assert (await client.post(old_path)).status == 404
    assert (await client.post(f"{HB_PATH}job_{new_token}")).status == 200


async def test_type_switch_state_to_heartbeat(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """State -> heartbeat: fresh token, notify default, debounce 1 h, leaves its group."""
    await _set_internal_url(hass)
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(
        make_guard("Job", debounce=30, linked_guards=["guard1"]),
        make_guard("Partner", linked_guards=["guard0"]),
    )
    result = await _reconfigure(hass, entry.entry_id)
    assert _default(result, "source_type") == "state_based"
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    assert "regenerate_token" not in _keys(result)  # the switch makes a new one
    assert _default(result, "period") == DAY

    result = await _cfg(hass, result["flow_id"], {"name": "Job", **HB_DEVICE})
    # The stored strategy is switch, but a heartbeat starts as notify-only.
    assert _default(result, "strategy") == "notify"
    result = await _cfg(hass, result["flow_id"], {"strategy": "action"})
    assert result["step_id"] == "action"
    # Stored debounce 30 is replaced by the heartbeat default; no link section.
    assert _default(result, "debounce", "behavior") == DEFAULT_HEARTBEAT_DEBOUNCE
    assert "linked_guards" not in _keys(result)

    result = await _cfg(
        hass,
        result["flow_id"],
        {
            "recovery_action": {"action": [{"action": "test.restart_job"}]},
            "behavior": {"debounce": 0, "cooldown": 10},
            "notification": {},
        },
    )
    assert result["step_id"] == "heartbeat_url"
    token = result["description_placeholders"]["url"].rpartition("_")[2]
    result = await _cfg(hass, result["flow_id"], {})
    assert result["reason"] == "reconfigure_successful"

    data = entry.subentries["guard0"].data
    assert data["health"]["type"] == "heartbeat"
    assert data["health"]["token"] == token
    assert len(token) == 64
    assert "linked_guards" not in data
    # The partner's group no longer contains the switched guard.
    assert entry.subentries["guard1"].data.get("linked_guards") == []


async def test_type_switch_heartbeat_to_state(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """Heartbeat -> state: no info step, token gone, debounce back to its default."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    entry = await setup_guards(_hb_guard())
    result = await _reconfigure(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    assert result["step_id"] == "device"
    assert "regenerate_token" not in _keys(result)
    result = await _cfg(hass, result["flow_id"], {"name": "Job", **STATE_HEALTH})
    assert _default(result, "strategy") == "notify"  # the stored strategy
    result = await _cfg(hass, result["flow_id"], {"strategy": "notify"})
    assert _default(result, "debounce") == DEFAULT_DEBOUNCE

    result = await _cfg(hass, result["flow_id"], {"notification": {}})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    health = entry.subentries["guard0"].data["health"]
    assert health["type"] == "entity_state"
    assert "token" not in health


async def test_heartbeat_guards_stay_out_of_links(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """No link section on a heartbeat guard; not offered to other guards either."""
    await _set_internal_url(hass)
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    entry = await setup_guards(
        make_guard("Rec"),
        _hb_guard("Job", strategy="action_check", action=[{"action": "test.x"}]),
    )

    # The heartbeat guard's own recovery form has no link section ...
    result = await _reconfigure(hass, entry.entry_id, "guard1")
    result = await _cfg(hass, result["flow_id"], {"source_type": "heartbeat_based"})
    result = await _cfg(hass, result["flow_id"], {"name": "Job", **HB_DEVICE})
    assert _default(result, "strategy") == "action"  # stored, not a type switch
    result = await _cfg(hass, result["flow_id"], {"strategy": "switch"})
    assert result["step_id"] == "switch"
    assert "linked_guards" not in _keys(result)

    # ... and a new state guard can pick only the other recover guard.
    result = await _init(hass, entry.entry_id)
    result = await _cfg(hass, result["flow_id"], {"source_type": "state_based"})
    result = await _cfg(hass, result["flow_id"], {"name": "New", **STATE_HEALTH})
    result = await _cfg(hass, result["flow_id"], {"strategy": "switch"})
    link = next(
        v for k, v in result["data_schema"].schema.items() if str(k) == "linked_guards"
    ).schema.schema
    options = next(v for k, v in link.items() if str(k) == "linked_guards")
    assert [o["value"] for o in options.config["options"]] == ["guard0"]
