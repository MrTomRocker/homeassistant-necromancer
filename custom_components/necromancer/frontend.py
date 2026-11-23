"""Deliver Necromancer's Lovelace cards from the integration itself.

The cards live in the package's `frontend/` directory and are served under one
static path; `frontend.add_extra_js_url` makes every browser load the entry module,
so no dashboard resource has to be added by hand and the cards always match the
installed version. The module URL carries `?v=<version>`: browsers cache it
aggressively, and a stale card after an update is the classic support trap.

aiohttp routes cannot be removed, so the static path is registered once per HA run
(flag in `hass.data[DOMAIN]`, which survives reloads). The module URL, in contrast,
belongs to the loaded entry: setup adds it, unload removes it.

The sidebar page ("Necromancer", element `necromancer-panel` from the same module)
follows the entry too: registered on setup while the `show_panel` option is on,
removed on unload. Switching the option off reloads the entry, so it disappears
without a restart.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import (
    add_extra_js_url,
    async_panel_exists,
    async_register_built_in_panel,
    async_remove_panel,
    remove_extra_js_url,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.loader import async_get_integration

from .const import DOMAIN

URL_BASE = "/necromancer_frontend"
MODULE_FILE = "necromancer.js"
_FRONTEND_DIR = Path(__file__).parent / "frontend"

PANEL_URL_PATH = "necromancer"
PANEL_ELEMENT = "necromancer-panel"
PANEL_TITLE = "Necromancer"
PANEL_ICON = "mdi:skull-crossbones"

# Keys in hass.data[DOMAIN].
_STATIC_REGISTERED = "frontend_static_path"
_MODULE_URL = "frontend_module_url"
_PANEL = "frontend_panel"


async def _module_url(hass: HomeAssistant) -> str:
    """The entry module's URL, versioned so an update busts the browser cache."""
    integration = await async_get_integration(hass, DOMAIN)
    return f"{URL_BASE}/{MODULE_FILE}?v={integration.version}"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the cards and have the frontend load them (called on entry setup)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if not domain_data.get(_STATIC_REGISTERED):
        # cache_headers=False: the `?v=` query busts the cache on an update, but a
        # dev edit without a version bump should still reach the browser.
        await hass.http.async_register_static_paths(
            [StaticPathConfig(URL_BASE, str(_FRONTEND_DIR), cache_headers=False)]
        )
        domain_data[_STATIC_REGISTERED] = True

    url = await _module_url(hass)
    if domain_data.get(_MODULE_URL) != url:
        add_extra_js_url(hass, url)
        domain_data[_MODULE_URL] = url


@callback
def async_unregister_frontend(hass: HomeAssistant) -> None:
    """Stop loading the cards (called on entry unload; the static path stays)."""
    if (url := hass.data.get(DOMAIN, {}).pop(_MODULE_URL, None)) is not None:
        remove_extra_js_url(hass, url)


async def async_register_panel(hass: HomeAssistant) -> None:
    """Add the "Necromancer" sidebar page (visible to all users).

    A custom panel: HA loads the module and creates `necromancer-panel`, which
    shows the guards; admin-only actions stay hidden for other users. Each user
    can still hide the entry from the sidebar in their profile.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_PANEL) or async_panel_exists(hass, PANEL_URL_PATH):
        return
    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        config={
            "_panel_custom": {
                "name": PANEL_ELEMENT,
                "module_url": await _module_url(hass),
                "embed_iframe": False,
                "trust_external": False,
            }
        },
        require_admin=False,
    )
    domain_data[_PANEL] = True


@callback
def async_unregister_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar page again (entry unloaded or option switched off)."""
    if hass.data.get(DOMAIN, {}).pop(_PANEL, None):
        async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
