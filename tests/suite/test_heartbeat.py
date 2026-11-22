"""Heartbeat source over real HTTP: endpoint, lifecycle and persistence.

Pings go through `hass_client_no_auth` against the real `HeartbeatView`, so the
answer codes, the security order (token -> local_only -> rate limit -> query), the
token table across reload/unload/remove/dormant and the Store round-trip are all
exercised end to end. A non-local caller is simulated by patching the view's
`is_local` (the test client always connects from 127.0.0.1).
"""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any
from unittest.mock import PropertyMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient
from freezegun.api import FrozenDateTimeFactory
import pytest

from homeassistant.config_entries import ConfigEntryState, ConfigSubentry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, MATCH_ALL
from homeassistant.core import CoreState, Event, HomeAssistant, ServiceCall, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from ._compat import async_fire_time_changed, async_mock_service
from .conftest import DOMAIN, HEARTBEAT_TOKEN, SetupGuards, entity_id_for, make_guard

type ClientFactory = Any

URL = "/api/necromancer/heartbeat/"
TOKEN_B = "cd" * 32
STORE_KEY = f"{DOMAIN}.necro_test_entry"
_IS_LOCAL = "custom_components.necromancer.heartbeat_view.is_local"
_OWN_LOGGER = "custom_components.necromancer"


def _hb(name: str = "Job", **kwargs: Any) -> dict[str, Any]:
    """A notify-only heartbeat guard with a short period (60 s, no grace).

    The grace after a missed ping is the guard's debounce, 0 unless given.
    """
    kwargs.setdefault("period", 60)
    kwargs.setdefault("debounce", 0)
    return make_guard(
        name,
        source="heartbeat_based",
        strategy="notify",
        notify_action=[{"action": "test.sink", "data": {"event": "{{ event }}"}}],
        **kwargs,
    )


def _registry(hass: HomeAssistant):
    from custom_components.necromancer.core.heartbeat_registry import (
        HeartbeatRegistry,
    )

    return HeartbeatRegistry.get(hass)


async def _ping(
    client: TestClient,
    token: str = HEARTBEAT_TOKEN,
    *,
    status: str | None = None,
    method: str = "post",
    name: str = "job",
    **kwargs: Any,
) -> tuple[int, Any]:
    """Send one ping; return (status code, JSON body or None)."""
    params = {} if status is None else {"status": status}
    resp = await getattr(client, method)(
        f"{URL}{name}_{token}", params=params, **kwargs
    )
    body = await resp.json() if resp.content_type == "application/json" else None
    return resp.status, body


async def _advance(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, seconds: float
) -> None:
    """Move frozen time forward and fire due timers (deadline, delayed save)."""
    freezer.tick(timedelta(seconds=seconds))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()


def _stored(hass_storage: dict[str, Any], subentry_id: str = "guard0") -> dict | None:
    return hass_storage.get(STORE_KEY, {}).get("data", {}).get(subentry_id)


async def _set_device_disabled(
    hass: HomeAssistant, entry_id: str, disabled: bool, subentry_id: str = "guard0"
) -> None:
    """Toggle a guard's own device as the UI would (the entry reloads itself)."""
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier((DOMAIN, subentry_id), entry_id)
    assert device is not None
    dev_reg.async_update_device(
        device.id, disabled_by=dr.DeviceEntryDisabler.USER if disabled else None
    )
    await hass.async_block_till_done()


@pytest.fixture
def sink(hass: HomeAssistant) -> list[ServiceCall]:
    """Notification calls of the heartbeat guards (`test.sink`)."""
    return async_mock_service(hass, "test", "sink")


# ---------------- endpoint over HTTP ----------------


async def test_post_is_success_get_and_put_are_405(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """Only POST pings; GET (prefetchers, link previews) and the rest get 405."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "blind"

    for method in ("get", "put"):
        resp = await getattr(client, method)(f"{URL}job_{HEARTBEAT_TOKEN}")
        assert resp.status == 405, method
    assert engine.state.value == "blind"
    assert engine.health.state["last_ping"] is None

    assert await _ping(client) == (200, {"health": "ok"})
    assert engine.state.value == "ok"


async def test_bare_token_and_other_name_reach_the_same_guard(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """Only the part after the last `_` counts; a bare token works too."""
    await setup_guards(_hb())
    client = await hass_client_no_auth()

    resp = await client.post(f"{URL}{HEARTBEAT_TOKEN}")
    assert resp.status == 200
    assert (await _ping(client, name="renamed_guard"))[0] == 200


async def test_unknown_token_is_404(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """An unknown token gets 404 (the sender retries)."""
    await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client, TOKEN_B))[0] == 404


async def test_route_missing_before_setup_is_404(
    hass: HomeAssistant, hass_client_no_auth: ClientFactory
) -> None:
    """Before Necromancer is set up the route does not exist: 404, not 200."""
    assert await async_setup_component(hass, "http", {})
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 404


async def test_empty_status_is_failure(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """`status=` (an unset variable at the sender) is a failure, not a success."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()

    assert await _ping(client, status="") == (200, {"health": "unhealthy"})
    state = entry.runtime_data.engines["guard0"].health.state
    assert state["last_status"] == "fail"
    assert state["last_code"] is None
    assert await _ping(client, status="TERM") == (200, {"health": "unhealthy"})
    assert entry.runtime_data.engines["guard0"].health.state["last_code"] == "TERM"
    assert await _ping(client, status="0") == (200, {"health": "ok"})


async def test_local_only_rejects_non_local_caller(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """local_only + non-local caller -> 403 and nothing changes; without it -> 200."""
    entry = await setup_guards(_hb(), _hb("Open", token=TOKEN_B, local_only=False))
    client = await hass_client_no_auth()
    before = entry.runtime_data.engines["guard0"].health.state

    with patch(_IS_LOCAL, return_value=False):
        assert (await _ping(client))[0] == 403
        assert await _ping(client, TOKEN_B) == (200, {"health": "ok"})

    assert entry.runtime_data.engines["guard0"].health.state == before
    assert entry.runtime_data.engines["guard0"].state.value == "blind"


async def test_cloud_connection_is_not_local(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """A Nabu Casa connection never counts as local, even from a private IP."""
    await setup_guards(_hb())
    client = await hass_client_no_auth()
    with patch(
        "custom_components.necromancer.heartbeat_view.is_cloud_connection",
        return_value=True,
    ):
        assert (await _ping(client))[0] == 403


async def test_unparsable_remote_is_not_local(hass: HomeAssistant) -> None:
    """An IP that cannot be parsed (or none at all) is never local."""
    from custom_components.necromancer.heartbeat_view import (
        _caller_is_local,
    )

    class _Req:
        def __init__(self, remote: str | None) -> None:
            self.remote = remote

    assert _caller_is_local(hass, _Req("127.0.0.1"))
    assert _caller_is_local(hass, _Req("192.168.1.9"))
    assert not _caller_is_local(hass, _Req("not-an-ip"))
    assert not _caller_is_local(hass, _Req(None))
    assert not _caller_is_local(hass, _Req("100.64.0.1"))
    assert not _caller_is_local(hass, _Req("2001:db8::1"))


@pytest.mark.parametrize(
    ("remote", "code"),
    [
        ("100.64.0.1", 403),  # CGNAT (RFC 6598), e.g. a Tailscale address
        ("100.127.255.254", 403),
        ("2606:4700:4700::1111", 403),  # global IPv6
        ("not-an-ip", 403),
        ("192.168.1.9", 200),  # RFC 1918
        ("fd00::9", 200),  # ULA
    ],
)
async def test_local_only_over_http_by_caller_address(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    remote: str,
    code: int,
) -> None:
    """Over HTTP: CGNAT, global IPv6 and an unparsable address are not local.

    The test client always connects from 127.0.0.1, so the connection's address
    (`request.remote`) is patched; the real `is_local` decides.
    """
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    with patch.object(
        web.BaseRequest, "remote", new_callable=PropertyMock, return_value=remote
    ):
        assert (await _ping(client))[0] == code
    expected = "ok" if code == 200 else "blind"
    assert entry.runtime_data.engines["guard0"].state.value == expected


async def test_sixth_ping_in_ten_seconds_is_429(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
) -> None:
    """At most 5 pings per 10 s per guard; the next window accepts again."""
    await setup_guards(_hb())
    client = await hass_client_no_auth()

    codes = [(await _ping(client))[0] for _ in range(6)]
    assert codes == [200] * 5 + [429]
    with patch(
        "custom_components.necromancer.core.heartbeat_registry.time.monotonic",
        return_value=1e12,
    ):
        assert (await _ping(client))[0] == 200


async def test_check_order_token_local_rate(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """Order is token -> local_only -> rate limit.

    Unknown token from outside -> 404; known token from outside -> 403 even over
    the limit, and a rejected caller does not touch the rate counter.
    """
    await setup_guards(_hb())
    client = await hass_client_no_auth()
    for _ in range(5):
        assert (await _ping(client))[0] == 200
    entry = _registry(hass).lookup(HEARTBEAT_TOKEN)
    hits = list(entry.hits)

    with patch(_IS_LOCAL, return_value=False):
        assert (await _ping(client, TOKEN_B))[0] == 404
        assert (await _ping(client))[0] == 403
    assert list(entry.hits) == hits
    assert (await _ping(client))[0] == 429


async def test_large_body_is_never_read(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """A big POST body changes nothing: same answer as without one (no 413)."""
    await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert await _ping(client, data=b"x" * 64 * 1024) == (200, {"health": "ok"})


async def test_exception_is_500_and_token_truncated_in_log(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unexpected error answers 500 (retry) and logs only 6 token characters."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    source = entry.runtime_data.engines["guard0"].health

    with (
        caplog.at_level(logging.DEBUG),
        patch.object(source, "async_handle_ping", side_effect=RuntimeError("boom")),
    ):
        assert (await _ping(client))[0] == 500

    # Only our own log lines: aiohttp's access log and HA's DEBUG request line
    # carry the full path by design (documented limit, both off by default).
    ours = "\n".join(
        r.getMessage() for r in caplog.records if r.name.startswith(_OWN_LOGGER)
    )
    assert f"{HEARTBEAT_TOKEN[:6]}…" in ours
    assert HEARTBEAT_TOKEN not in ours


async def test_http_exception_passes_through_not_500(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An aiohttp HTTPException keeps its own answer; it is no error to log as 500."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    source = entry.runtime_data.engines["guard0"].health

    with patch.object(source, "async_handle_ping", side_effect=web.HTTPConflict()):
        assert (await _ping(client))[0] == 409
    assert not [
        r
        for r in caplog.records
        if r.name.startswith(_OWN_LOGGER) and r.levelno >= logging.ERROR
    ]


async def test_endpoint_needs_no_auth_other_api_stays_protected(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """The heartbeat URL works without a token; the rest of the API does not."""
    await setup_guards(_hb())
    assert await async_setup_component(hass, "api", {})
    client = await hass_client_no_auth()

    assert (await _ping(client))[0] == 200
    resp = await client.post(f"/api/services/{DOMAIN}/check_health")
    assert resp.status == 401


# ---------------- lifecycle ----------------


async def test_reload_twice_registers_view_once(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """The view is registered once per HA run; tokens are active after each reload."""
    entry = await setup_guards(_hb())
    for _ in range(2):
        assert await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()
    client = await hass_client_no_auth()

    resources = [
        r for r in hass.http.app.router.resources() if r.canonical == f"{URL}{{slug}}"
    ]
    assert len(resources) == 1
    assert _registry(hass).lookup(HEARTBEAT_TOKEN).state == "active"
    assert (await _ping(client))[0] == 200


async def test_waiting_between_unload_and_setup_is_503(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """Unloaded (reload gap, or integration disabled) -> 503; removed -> 404."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert (await _ping(client))[0] == 503

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (await _ping(client))[0] == 200

    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert (await _ping(client))[0] == 404


async def test_removed_guard_is_404_and_leaves_the_store(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
) -> None:
    """Deleting a guard drops its token (404) and, by the next save, its blob."""
    entry = await setup_guards(_hb(), _hb("Other", token=TOKEN_B))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    hass.config_entries.async_remove_subentry(entry, "guard0")
    await hass.async_block_till_done()
    assert (await _ping(client))[0] == 404

    assert (await _ping(client, TOKEN_B))[0] == 200
    await _advance(hass, freezer, 6)
    assert _stored(hass_storage, "guard0") is None
    assert _stored(hass_storage, "guard1") is not None


async def test_unload_closed_source_refuses_ping_without_timer(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """A ping racing the unload (source already closed) -> 503, nothing left armed."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    source = engine.health
    before = source.state

    # Close the source as its unsub does, but leave the table still pointing at
    # it: the moment between the lookup and async_handle_ping during an unload.
    source._closed = True
    source._cancel_timer()
    assert _registry(hass).lookup(HEARTBEAT_TOKEN).source is source
    assert (await _ping(client))[0] == 503
    assert source.state == before
    assert source._unsub_timer is None


async def test_heartbeat_guard_without_token_is_skipped(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A heartbeat subentry without a token gets no route and no engine.

    Only broken stored data looks like this (the flow always generates a token);
    the entry still loads and the other guards keep working.
    """
    broken = _hb("Broken")
    del broken["health"]["token"]
    entry = await setup_guards(broken, _hb("Other", token=TOKEN_B))
    client = await hass_client_no_auth()

    assert _registry(hass).tokens(entry.entry_id) == [TOKEN_B]
    assert set(entry.runtime_data.engines) == {"guard1"}
    assert "Failed to set up guard 'Broken'" in caplog.text
    assert await _ping(client, TOKEN_B) == (200, {"health": "ok"})


async def test_failed_start_is_waiting_and_keeps_stored_state(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
) -> None:
    """A guard whose start fails is `waiting` and keeps its stored state.

    async_start raising after health setup -> 503; another guard's save keeps
    the failed guard's last_ok/armed_at/token_fp, and the next reload has them.
    """
    from custom_components.necromancer.core.engine import (
        DeviceEngine,
    )

    entry = await setup_guards(_hb("Broken"), _hb("Other", token=TOKEN_B))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    kept = entry.runtime_data.engines["guard0"].health.state

    original = DeviceEngine._read_detail

    def _boom(self: Any) -> str:
        if self.name == "Broken":
            raise RuntimeError("start failed")
        return original(self)

    with patch.object(DeviceEngine, "_read_detail", _boom):
        assert await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()
    assert set(entry.runtime_data.engines) == {"guard1"}
    assert _registry(hass).lookup(HEARTBEAT_TOKEN).state == "waiting"
    assert (await _ping(client))[0] == 503

    # Another guard's ping saves the Store; the broken guard's blob must survive.
    assert (await _ping(client, TOKEN_B))[0] == 200
    await _advance(hass, freezer, 6)
    assert _stored(hass_storage)["source"] == kept

    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    state = entry.runtime_data.engines["guard0"].health.state
    for key in ("last_ok", "armed_at", "token_fp"):
        assert state[key] == kept[key]


async def test_dormant_guard_stores_pings_without_evaluating(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Dormant -> 200 + dormant: the ping is stored, not judged.

    Waking up after more than period + debounce is OK, not heartbeat_overdue.
    """
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    await _set_device_disabled(hass, entry.entry_id, True)
    assert entry.runtime_data.engines == {}
    assert _registry(hass).lookup(HEARTBEAT_TOKEN).state == "dormant"

    await _advance(hass, freezer, 300)
    pinged_at = dt_util.utcnow()
    assert await _ping(client) == (200, {"dormant": True})
    assert entry.runtime_data.engines == {}
    await _advance(hass, freezer, 6)
    last_ok = _stored(hass_storage)["source"]["last_ok"]
    assert dt_util.parse_datetime(last_ok) == pinged_at

    await _advance(hass, freezer, 30)
    await _set_device_disabled(hass, entry.entry_id, False)
    engine = entry.runtime_data.engines["guard0"]
    assert _registry(hass).lookup(HEARTBEAT_TOKEN).state == "active"
    assert engine.health.state["last_ok"] == last_ok
    assert engine.state.value == "ok"
    assert engine.current_health().value == "ok"
    assert sink == []


async def test_dormant_created_asleep_then_woken_is_ok(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
) -> None:
    """A guard with no stored blob at all gets `{"source": …}` from a dormant ping."""
    entry = await setup_guards(_hb())
    await _set_device_disabled(hass, entry.entry_id, True)
    # Restart with an empty Store while dormant: as if the guard was created asleep.
    assert await hass.config_entries.async_unload(entry.entry_id)
    hass_storage.pop(STORE_KEY, None)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_client_no_auth()

    assert await _ping(client) == (200, {"dormant": True})
    blob = entry.runtime_data.serialize()["guard0"]
    assert set(blob) == {"source"}
    assert blob["source"]["last_status"] == "ok"

    await _set_device_disabled(hass, entry.entry_id, False)
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "ok"
    assert engine.health.state["last_ok"] == blob["source"]["last_ok"]


async def test_dormant_token_regenerated_in_sleep(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """ESCALATED, then asleep, new token: a ping drops the stale verdict -> OK."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert await _ping(client, status="3") == (200, {"health": "unhealthy"})
    # A reported failure skips the debounce: escalated before any timer runs.
    assert entry.runtime_data.engines["guard0"].state.value == "escalated"

    await _set_device_disabled(hass, entry.entry_id, True)
    subentry = entry.subentries["guard0"]
    hass.config_entries.async_update_subentry(
        entry,
        subentry,
        data={**subentry.data, "health": {**subentry.data["health"], "token": TOKEN_B}},
    )
    await hass.async_block_till_done()

    assert (await _ping(client))[0] == 404
    assert await _ping(client, TOKEN_B) == (200, {"dormant": True})
    assert entry.runtime_data.serialize()["guard0"]["state"] == "ok"

    sink.clear()
    await _set_device_disabled(hass, entry.entry_id, False)
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "ok"
    assert engine.current_health().value == "ok"
    assert sink == []


async def test_escalated_then_new_token_waits_then_alarms(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """New token on an ESCALATED guard -> blind, awaiting the first success.

    After period + debounce without one -> problem_detected.
    """
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client, status="fail"))[0] == 200
    await _advance(hass, freezer, 1)
    assert entry.runtime_data.engines["guard0"].state.value == "escalated"
    sink.clear()

    subentry = entry.subentries["guard0"]
    hass.config_entries.async_update_subentry(
        entry,
        subentry,
        data={**subentry.data, "health": {**subentry.data["health"], "token": TOKEN_B}},
    )
    await hass.async_block_till_done()

    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "blind"
    status = hass.states.get(entity_id_for(hass, "guard0", "sensor", "status"))
    assert status.state == "blind"
    assert status.attributes["awaiting_first_success"] is True
    assert sink == []

    await _advance(hass, freezer, 62)  # deadline timer -> SUSPECT
    await _advance(hass, freezer, 1)  # debounce 0 (no grace) -> ESCALATED
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


# ---------------- persistence ----------------


async def test_ok_to_ok_ping_is_saved_without_unload(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
) -> None:
    """A ping with no state change still reaches the Store (bind_persist)."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    await _advance(hass, freezer, 6)
    first = _stored(hass_storage)["source"]["last_ok"]

    await _advance(hass, freezer, 20)
    assert (await _ping(client))[0] == 200
    assert entry.runtime_data.engines["guard0"].state.value == "ok"
    await _advance(hass, freezer, 6)
    second = _stored(hass_storage)["source"]["last_ok"]
    assert second != first
    assert second == entry.runtime_data.engines["guard0"].health.state["last_ok"]


async def test_ping_survives_reload_with_timer(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client_no_auth: ClientFactory
) -> None:
    """Ping -> reload: state and deadline timer are back."""
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client, status="ok"))[0] == 200
    kept = entry.runtime_data.engines["guard0"].health.state

    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    source = entry.runtime_data.engines["guard0"].health
    assert source.state == kept
    assert source._unsub_timer is not None
    assert entry.runtime_data.engines["guard0"].state.value == "ok"


async def test_unload_stops_before_flush(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
) -> None:
    """Unload stops the engines before it flushes the Store.

    The last ping before the unload is in the Store; one after it gets 503 and
    leaves the Store alone.
    """
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    last_ok = entry.runtime_data.engines["guard0"].health.state["last_ok"]

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert _stored(hass_storage)["source"]["last_ok"] == last_ok

    snapshot = dict(hass_storage[STORE_KEY]["data"])
    assert (await _ping(client))[0] == 503
    await hass.async_block_till_done()
    assert hass_storage[STORE_KEY]["data"] == snapshot


async def test_restart_after_deadline_is_unhealthy_escalated_stays_silent(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """A restart after the deadline is UNHEALTHY at once (no startup grace).

    Ping -> stop -> start after the deadline -> problem_detected; a stored
    ESCALATED then stays without a new alarm.
    """
    entry = await setup_guards(_hb())
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.tick(timedelta(seconds=600))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.current_health().value == "unhealthy"
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.tick(timedelta(seconds=600))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.engines["guard0"].state.value == "escalated"
    assert len(sink) == 1


async def _restart_overdue_while_starting(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    guard: dict[str, Any],
):
    """Ping, then load the guard again past its deadline while HA is starting.

    Returns the engine; HA is left in CoreState.starting.
    """
    entry = await setup_guards(guard)
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    freezer.tick(timedelta(seconds=600))
    hass.set_state(CoreState.starting)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry.runtime_data.engines["guard0"]


async def _finish_start(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    hass.set_state(CoreState.running)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    await _advance(hass, freezer, 1)


async def test_overdue_at_boot_alarms_only_after_started(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
) -> None:
    """Overdue at boot: UNHEALTHY at once, but the alarm waits for HA started.

    During bootstrap the notify action may not exist yet; alarming then would
    lose it and persist ESCALATED, so no alarm would ever follow.
    """
    engine = await _restart_overdue_while_starting(
        hass, setup_guards, hass_client_no_auth, freezer, _hb()
    )
    assert engine.current_health().value == "unhealthy"
    await _advance(hass, freezer, 5)
    assert engine.state.value == "suspect"

    # The notify service only appears late in bootstrap.
    sink = async_mock_service(hass, "test", "sink")
    await _finish_start(hass, freezer)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_overdue_at_boot_recovers_only_after_started(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
) -> None:
    """Strategy action: no attempt burns against a not yet registered service."""
    guard = make_guard(
        "Job",
        source="heartbeat_based",
        strategy="action",
        debounce=0,
        period=60,
        # The used-up debounce reacts at HA started itself; still overdue after
        # the cooldown, the next cycle follows it (debounce 0 here), so a
        # cooldown longer than the test's tick keeps it at exactly one attempt.
        cooldown=30,
        action=[{"action": "test.restart_job"}],
    )
    engine = await _restart_overdue_while_starting(
        hass, setup_guards, hass_client_no_auth, freezer, guard
    )
    await _advance(hass, freezer, 5)
    assert engine.state.value == "suspect"
    assert engine.attempt == 0

    restart = async_mock_service(hass, "test", "restart_job")
    await _finish_start(hass, freezer)
    assert len(restart) == 1
    assert engine.state.value != "escalated"


async def test_overdue_at_boot_waits_only_the_rest_of_the_grace(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
) -> None:
    """Deferred to HA started, the debounce still counts from the deadline.

    Deadline +60, debounce 600 -> alarm at +660, also when the guard was loaded
    during bootstrap at +600 and HA only started at +605.
    """
    engine = await _restart_overdue_while_starting(
        hass, setup_guards, hass_client_no_auth, freezer, _hb(debounce=600)
    )
    await _advance(hass, freezer, 5)
    assert engine.state.value == "suspect"

    sink = async_mock_service(hass, "test", "sink")
    await _finish_start(hass, freezer)  # +606
    assert engine.state.value == "suspect"
    await _advance(hass, freezer, 53)
    assert engine.state.value == "suspect"
    assert sink == []
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


# ---------------- grace = debounce, reported failure = confirmed ----------------


async def test_overdue_waits_the_grace_a_late_ping_is_silent(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Overdue -> SUSPECT for the debounce (the grace); a ping in it -> OK, silent.

    Without a ping the debounce elapses -> ESCALATED + problem_detected.
    """
    entry = await setup_guards(_hb(debounce=3600))
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    assert (await _ping(client))[0] == 200

    await _advance(hass, freezer, 62)
    assert engine.state.value == "suspect"
    await _advance(hass, freezer, 3000)
    assert engine.state.value == "suspect"
    assert await _ping(client) == (200, {"health": "ok"})
    assert engine.state.value == "ok"
    await _advance(hass, freezer, 700)  # the cancelled debounce never fires
    assert sink == []

    await _advance(hass, freezer, 3601)  # overdue again, grace runs out
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_failure_ping_reacts_at_once_also_while_suspect(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """A reported failure is confirmed: no debounce from OK, and it cuts SUSPECT short."""
    entry = await setup_guards(_hb(debounce=3600))
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    assert (await _ping(client))[0] == 200

    assert await _ping(client, status="3") == (200, {"health": "unhealthy"})
    assert engine.state.value == "escalated"
    await hass.async_block_till_done()
    assert [c.data["event"] for c in sink] == ["problem_detected"]

    sink.clear()
    assert (await _ping(client))[0] == 200
    assert engine.state.value == "ok"
    await _advance(hass, freezer, 62)
    assert engine.state.value == "suspect"
    assert await _ping(client, status="TERM") == (200, {"health": "unhealthy"})
    assert engine.state.value == "escalated"
    await _advance(hass, freezer, 3600)
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_restart_overdue_is_suspect_and_a_retry_clears_it(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Deadline passed while HA was down -> SUSPECT after the start, no alarm yet.

    The sender's retry arrives within the debounce -> OK, still no alarm.
    """
    entry = await setup_guards(_hb(debounce=3600))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.tick(timedelta(seconds=600))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "suspect"

    await _advance(hass, freezer, 60)
    assert await _ping(client) == (200, {"health": "ok"})
    assert engine.state.value == "ok"
    await _advance(hass, freezer, 3600)
    assert sink == []


async def test_reload_in_the_grace_keeps_the_alarm_time(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """A reload in the grace waits only its rest: alarm at deadline + debounce.

    Before, the debounce restarted in full after every reload of the entry.
    """
    entry = await setup_guards(_hb(debounce=600))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200  # deadline +60, alarm +660

    await _advance(hass, freezer, 62)
    assert entry.runtime_data.engines["guard0"].state.value == "suspect"
    await _advance(hass, freezer, 300)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "suspect"

    await _advance(hass, freezer, 297)
    assert engine.state.value == "suspect"
    assert sink == []
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_reload_in_the_grace_a_late_ping_is_still_silent(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """After a reload in the grace, a ping within its rest -> OK, no alarm."""
    entry = await setup_guards(_hb(debounce=600))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    await _advance(hass, freezer, 362)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    await _advance(hass, freezer, 290)
    assert engine.state.value == "suspect"
    assert await _ping(client) == (200, {"health": "ok"})
    assert engine.state.value == "ok"
    await _advance(hass, freezer, 600)
    assert sink == []


def _set_period(hass: HomeAssistant, entry: Any, period: int) -> None:
    """Change the period as the reconfigure step saves it (the entry reloads)."""
    subentry = entry.subentries["guard0"]
    hass.config_entries.async_update_subentry(
        entry,
        subentry,
        data={
            **subentry.data,
            "health": {**subentry.data["health"], "period": period},
        },
    )


async def test_shorter_period_keeps_last_ping_and_alarms_at_once(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Decision 22: period 3600 -> 60 with deadline and grace already passed.

    Saving only moves the deadline: the last ping stays (no reset, not blind),
    the grace counted from the new deadline is used up, so the alarm goes out
    as soon as the change is saved.
    """
    entry = await setup_guards(_hb(period=3600, debounce=60))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    kept = entry.runtime_data.engines["guard0"].health.state
    await _advance(hass, freezer, 300)  # new deadline +60, its grace ends at +120
    assert entry.runtime_data.engines["guard0"].state.value == "ok"

    _set_period(hass, entry, 60)
    await hass.async_block_till_done()

    engine = entry.runtime_data.engines["guard0"]
    assert engine.health.period == 60
    assert engine.health.state == kept
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]
    attrs = hass.states.get(
        entity_id_for(hass, "guard0", "sensor", "status")
    ).attributes
    assert attrs["awaiting_first_success"] is False
    assert attrs["health_detail"] == (
        "No heartbeat for 5 minutes, expected every 1 minute."
    )


async def test_shorter_period_within_grace_waits_only_its_rest(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """Period shortened so only the deadline passed: SUSPECT, alarm at its grace end.

    Deadline +60 after the change, debounce 600 -> alarm at +660, not 600 s
    after saving.
    """
    entry = await setup_guards(_hb(period=3600, debounce=600))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200
    await _advance(hass, freezer, 300)

    _set_period(hass, entry, 60)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "suspect"

    await _advance(hass, freezer, 359)
    assert engine.state.value == "suspect"
    assert sink == []
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_restart_in_the_grace_waits_only_its_rest(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """HA down across the deadline: after the start only the rest of the grace."""
    entry = await setup_guards(_hb(debounce=3600))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200  # deadline +60, alarm +3660

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.tick(timedelta(seconds=600))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "suspect"

    await _advance(hass, freezer, 3059)
    assert engine.state.value == "suspect"
    assert sink == []
    await _advance(hass, freezer, 1)
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]


async def test_restart_after_the_grace_alarms_right_after_start(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
) -> None:
    """A long outage used up the grace: problem_detected right after the start.

    A deadline is a deadline: the sender's retry a moment later turns the guard
    OK again, but the alarm is already out.
    """
    entry = await setup_guards(_hb(debounce=300))
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.tick(timedelta(seconds=3600))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "escalated"
    assert [c.data["event"] for c in sink] == ["problem_detected"]

    await _advance(hass, freezer, 1)
    assert await _ping(client) == (200, {"health": "ok"})
    assert engine.state.value == "ok"
    assert len(sink) == 1


def _hb_action(**kwargs: Any) -> dict[str, Any]:
    """A heartbeat guard that repairs by an action, without a check.

    Deadline +60 after a ping, debounce 600, cooldown 300.
    """
    return make_guard(
        "Job",
        source="heartbeat_based",
        strategy="action",
        period=60,
        debounce=600,
        cooldown=300,
        action=[{"action": "test.restart_job"}],
        **kwargs,
    )


async def test_still_overdue_after_a_repair_waits_the_grace_again(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
) -> None:
    """No repair loop: the next cycle comes a full debounce after the cooldown.

    The grace counted from the deadline is used up after the first repair; were
    it never counted again, every cooldown end would start the next cycle.
    """
    restart = async_mock_service(hass, "test", "restart_job")
    entry = await setup_guards(_hb_action())
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    assert (await _ping(client))[0] == 200

    await _advance(hass, freezer, 62)
    await _advance(hass, freezer, 598)  # +660: deadline + debounce
    assert len(restart) == 1
    assert engine.state.value == "cooldown"
    await _advance(hass, freezer, 300)  # cooldown over, still overdue
    assert engine.state.value == "suspect"
    await _advance(hass, freezer, 599)
    assert len(restart) == 1
    await _advance(hass, freezer, 1)
    assert len(restart) == 2


async def test_reload_in_the_cooldown_does_not_repair_at_once(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
) -> None:
    """COOLDOWN is not stored: after a reload in it the full debounce is waited."""
    restart = async_mock_service(hass, "test", "restart_job")
    entry = await setup_guards(_hb_action())
    client = await hass_client_no_auth()
    assert (await _ping(client))[0] == 200

    await _advance(hass, freezer, 62)
    await _advance(hass, freezer, 598)
    assert len(restart) == 1
    await _advance(hass, freezer, 100)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "suspect"
    assert len(restart) == 1

    await _advance(hass, freezer, 599)
    assert len(restart) == 1
    await _advance(hass, freezer, 1)
    assert len(restart) == 2


async def test_stored_grace_is_ignored(
    hass: HomeAssistant, setup_guards: SetupGuards, freezer: FrozenDateTimeFactory
) -> None:
    """A `grace` left in stored health (dev data) loads and moves no deadline."""
    guard = _hb()
    guard["health"]["grace"] = 7200
    entry = await setup_guards(guard)
    engine = entry.runtime_data.engines["guard0"]
    assert engine.state.value == "blind"
    await _advance(hass, freezer, 60)
    assert engine.state.value == "blind"
    # period 60, not 60 + 7200 -> overdue; debounce 0 leaves nothing to wait out
    await _advance(hass, freezer, 2)
    assert engine.state.value == "escalated"


async def test_heartbeat_guard_never_links(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """A heartbeat guard drops out of link groups, even with stale linked_guards."""
    hass.states.async_set("binary_sensor.guard_health", "on")
    hass.states.async_set("switch.guard_target", "on")
    job = make_guard("Job", source="heartbeat_based", strategy="action")
    # As left behind by a guard switched to heartbeat before the flow cleaned up.
    job["linked_guards"] = ["guard1"]
    entry = await setup_guards(job, make_guard("Plug", linked_guards=["guard0"]))

    engines = entry.runtime_data.engines
    assert engines["guard0"].links._linked == []
    assert engines["guard1"].links._linked == []


# ---------------- security: the token stays secret ----------------


def _hb_repair(name: str = "Fixer", **kwargs: Any) -> dict[str, Any]:
    """A heartbeat guard that repairs by an action (recovery events + texts)."""
    return make_guard(
        name,
        source="heartbeat_based",
        strategy="action",
        period=60,
        debounce=0,
        cooldown=1,
        action=[{"action": "test.restart_job"}],
        notify_action=[{"action": "test.sink", "data": {"event": "{{ event }}"}}],
        **kwargs,
    )


def _assert_no_token_in_states(hass: HomeAssistant, step: str) -> int:
    """No Necromancer entity's state or attributes carry a token; return the count."""
    entities = [e for e in er.async_get(hass).entities.values() if e.platform == DOMAIN]
    states = [s for e in entities if (s := hass.states.get(e.entity_id)) is not None]
    for state in states:
        text = repr(state.as_dict())
        for token in (HEARTBEAT_TOKEN, TOKEN_B):
            assert token not in text, (step, state.entity_id)
    return len(states)


async def test_token_never_in_attributes_events_or_notifications(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The token reaches no state, event, notification, Store or own log line.

    Two heartbeat guards — notify-only and repairing — go through creation (one
    added at runtime), success and failure pings over HTTP and by service, an
    overdue alarm, a recovery cycle and a reload. Every Necromancer state is
    checked after each step; every bus event (state changes, service calls,
    recovery events) and the variables of every notification at the end.
    """
    from custom_components.necromancer.core import notify as notify_mod

    restart = async_mock_service(hass, "test", "restart_job")
    events: list[Event] = []

    @callback
    def _capture(event: Event) -> None:
        events.append(event)

    hass.bus.async_listen(MATCH_ALL, _capture)

    with (
        caplog.at_level(logging.DEBUG),
        patch.object(notify_mod, "async_run", wraps=notify_mod.async_run) as run,
    ):
        # Creation: one guard at setup, the second added to the running entry.
        entry = await setup_guards(_hb())
        assert _assert_no_token_in_states(hass, "created") > 0
        hass.config_entries.async_add_subentry(
            entry,
            ConfigSubentry(
                data=_hb_repair(token=TOKEN_B),
                subentry_type="device",
                title="Fixer",
                unique_id=None,
            ),
        )
        await hass.async_block_till_done()
        assert len(entry.runtime_data.engines) == 2
        n_states = _assert_no_token_in_states(hass, "added")
        client = await hass_client_no_auth()

        # Success, then failure pings (notify-only: alarm; repairing: a cycle).
        for token in (HEARTBEAT_TOKEN, TOKEN_B):
            assert await _ping(client, token) == (200, {"health": "ok"})
        _assert_no_token_in_states(hass, "ping ok")
        for token in (HEARTBEAT_TOKEN, TOKEN_B):
            assert (await _ping(client, token, status="3"))[0] == 200
        await _advance(hass, freezer, 1)
        assert len(restart) >= 1
        _assert_no_token_in_states(hass, "ping fail")

        # Success by service, then overdue -> alarm (and a repair) after the period.
        status_eids = [
            entity_id_for(hass, sid, "sensor", "status") for sid in entry.subentries
        ]
        assert None not in status_eids
        await hass.services.async_call(
            DOMAIN, "heartbeat_ping", {"entity_id": status_eids}, blocking=True
        )
        await hass.async_block_till_done()
        _assert_no_token_in_states(hass, "service ping")
        sink.clear()
        await _advance(hass, freezer, 62)
        await _advance(hass, freezer, 1)
        assert "problem_detected" in [c.data["event"] for c in sink]
        _assert_no_token_in_states(hass, "overdue")

        # Reload: the restored guards come back without the token anywhere either.
        assert await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()
        assert _assert_no_token_in_states(hass, "reloaded") == n_states
        await _advance(hass, freezer, 6)  # flush the delayed Store save

    for event in events:
        text = repr(event.as_dict())
        for token in (HEARTBEAT_TOKEN, TOKEN_B):
            assert token not in text, event.event_type
    assert {"state_changed", "call_service"} <= {e.event_type for e in events}

    notified = [c.args[3] for c in run.call_args_list]
    sent = {v["event"] for v in notified}
    assert {"problem_detected", "recovery_attempt"} <= sent, sent
    for variables in notified:
        for token in (HEARTBEAT_TOKEN, TOKEN_B):
            assert token not in repr(variables), variables["event"]

    stored = repr(hass_storage[STORE_KEY]["data"])
    ours = "\n".join(
        r.getMessage() for r in caplog.records if r.name.startswith(_OWN_LOGGER)
    )
    for token in (HEARTBEAT_TOKEN, TOKEN_B):
        assert token not in stored
        assert token not in ours


@pytest.mark.parametrize("notify_cleared", [True, False])
async def test_success_ping_after_failure_reports_back_to_normal(
    hass: HomeAssistant,
    setup_guards: SetupGuards,
    hass_client_no_auth: ClientFactory,
    freezer: FrozenDateTimeFactory,
    sink: list[ServiceCall],
    notify_cleared: bool,
) -> None:
    """Escalated by a failure ping, healthy by a success ping: problem_cleared if on."""
    guard = _hb(notify_cleared=notify_cleared)
    guard["behavior"]["notify_action"] = [
        {
            "action": "test.sink",
            "data": {"event": "{{ event }}", "message": "{{ message }}"},
        }
    ]
    entry = await setup_guards(guard)
    client = await hass_client_no_auth()
    engine = entry.runtime_data.engines["guard0"]
    assert (await _ping(client))[0] == 200
    assert await _ping(client, status="3") == (200, {"health": "unhealthy"})
    assert engine.state.value == "escalated"
    await _advance(hass, freezer, 2 * 3600)
    assert engine.state.value == "escalated"

    assert await _ping(client) == (200, {"health": "ok"})
    await hass.async_block_till_done()
    assert engine.state.value == "ok"
    events = [c.data["event"] for c in sink]
    if notify_cleared:
        assert events == ["problem_detected", "problem_cleared"], events
        assert sink[1].data["message"] == "Job: Back to normal after 2 hours."
    else:
        assert events == ["problem_detected"], events
