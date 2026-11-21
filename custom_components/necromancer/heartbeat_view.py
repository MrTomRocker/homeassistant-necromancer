"""HTTP endpoint for heartbeat pings: `POST /api/necromancer/heartbeat/<name>_<token>`.

A sender outside HA (systemd job, cron, NAS task) reports "I ran" here. Only POST
counts; aiohttp answers every other method (GET too) with 405, so a link preview,
a browser prefetch or a proxy's cache never passes for a heartbeat. Unlike HA's
webhook component (which answers 200 for everything it drops, to hide whether a hook
exists) every answer is honest, so a sender can tell "processed" from "retry":

    200 {"health": …}     ping applied to the running source
    200 {"dormant": true} guard's device disabled: ping stored, not evaluated
    403                   caller not local and the guard is `local_only`
    404                   unknown token (or Necromancer not loaded yet — no route)
    429                   more than RATE_LIMIT pings in RATE_WINDOW for this guard
    503                   guard configured but its source is not running right now
    500                   unexpected error in Necromancer

No authentication (like `camera`/`auth` in core): the token is the only secret.
Therefore the order of the checks is fixed and tested — token lookup, then
`local_only`, then the rate limit, then the query — so a 403 or 429 only tells
something to whoever already holds a valid token. The body is never read.

HA can register a view after start but cannot unregister it, so the view is
registered once per HA run and all routing lives in the token table
(`core/heartbeat_registry.py`).
"""

from __future__ import annotations

from http import HTTPStatus
from ipaddress import ip_address
import logging

from aiohttp import web

from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import KEY_HASS, HomeAssistantView
from homeassistant.helpers.network import is_cloud_connection
from homeassistant.util.network import is_local

from .const import DOMAIN, HEARTBEAT_PATH
from .core.health.heartbeat import (
    HeartbeatClosedError,
    parse_status,
    token_from_slug,
)
from .core.heartbeat_registry import (
    STATE_ACTIVE,
    STATE_DORMANT,
    HeartbeatRegistry,
)

LOGGER = logging.getLogger(__name__)

URL = HEARTBEAT_PATH + "{slug}"
# Flag in hass.data[DOMAIN]: the view is registered once per HA run, not per setup.
_VIEW_REGISTERED = "heartbeat_view"


def async_register_view(hass: HomeAssistant) -> None:
    """Register the endpoint on the first entry setup of this HA run.

    aiohttp routes cannot be removed, so a reload must not add a second one; the
    flag survives reloads because it lives in `hass.data[DOMAIN]`.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_VIEW_REGISTERED):
        return
    hass.http.register_view(HeartbeatView())
    domain_data[_VIEW_REGISTERED] = True


def _caller_is_local(hass: HomeAssistant, request: web.Request) -> bool:
    """Same notion of "local" as HA's webhook, but an unparsable IP is never local.

    Loopback, link-local, RFC1918 and ULA count as local; a cloud (Nabu Casa)
    connection, global IPv6 and 100.64.0.0/10 do not. `request.remote` is the
    connection's IP unless HA's `use_x_forwarded_for` + `trusted_proxies` are set.
    """
    if is_cloud_connection(hass) or not request.remote:
        return False
    try:
        return is_local(ip_address(request.remote))
    except ValueError:
        return False


class HeartbeatView(HomeAssistantView):
    """Accept heartbeat pings by POST (the query decides; GET and others get 405)."""

    url = URL
    name = "api:necromancer:heartbeat"
    requires_auth = False
    # The body is never read; this only caps it should someone read it later.
    max_body_size = 1024

    async def post(self, request: web.Request, slug: str) -> web.Response:
        """Handle a ping (the only method; there is deliberately no `get`)."""
        token = token_from_slug(slug)
        try:
            return await self._process(request, token)
        except web.HTTPException:
            raise
        except Exception:
            # Never log the full token: only its first 6 characters.
            LOGGER.exception("Heartbeat ping for token %s… failed", (token or "")[:6])
            return web.Response(status=HTTPStatus.INTERNAL_SERVER_ERROR)

    async def _process(self, request: web.Request, token: str | None) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        # 1. Token -> table. Unknown (or not loaded yet) -> 404, the sender retries.
        entry = HeartbeatRegistry.get(hass).lookup(token)
        if entry is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        # 2. local_only — only after the lookup, so a 403 reveals nothing to a
        #    caller who does not already hold the token.
        if entry.local_only and not _caller_is_local(hass, request):
            return web.Response(status=HTTPStatus.FORBIDDEN)
        # 3. Rate limit per guard, so a token holder cannot flood Store and alarms.
        if not entry.allow():
            return web.Response(status=HTTPStatus.TOO_MANY_REQUESTS)
        # 4. Query -> source. Every status value is success or failure, never a 400.
        ok, code = parse_status(request.query.get("status"))
        if entry.state == STATE_ACTIVE and entry.source is not None:
            try:
                health = await entry.source.async_handle_ping(ok, code)
            except HeartbeatClosedError:
                # The source stopped while we got here (reload): retry reaches
                # the next source.
                return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)
            return self.json({"health": health.value})
        if entry.state == STATE_DORMANT and entry.dormant_apply is not None:
            entry.dormant_apply(ok, code)
            return self.json({"dormant": True})
        # waiting: configured, but its source is not running (reload, start, failed
        # setup, entry unloaded) -> the sender retries.
        return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)
