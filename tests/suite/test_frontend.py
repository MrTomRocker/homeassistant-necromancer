"""Card delivery tests: static path, extra module URL, sidebar panel (`frontend.py`).

The static path is registered once per HA run (aiohttp routes cannot be removed);
the module URL and the sidebar panel belong to the loaded entry and go away on
unload. The panel also follows the `show_panel` option.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .conftest import DOMAIN, SetupGuards, make_guard

type ClientFactory = Any

_PREFIX = "/necromancer_frontend/necromancer.js?v="


def _our_urls(hass: HomeAssistant) -> list[str]:
    """Necromancer's entries in the frontend's extra module URL set."""
    return [u for u in hass.data[DATA_EXTRA_MODULE_URL].urls if u.startswith(_PREFIX)]


async def test_setup_adds_versioned_module_url(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The module URL carries the installed version, so updates bust the cache."""
    await setup_guards(make_guard("Card", strategy="notify"))

    version = (await async_get_integration(hass, DOMAIN)).version
    assert _our_urls(hass) == [f"{_PREFIX}{version}"]


async def test_module_is_served_as_javascript(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client: ClientFactory
) -> None:
    """The URL the frontend loads resolves to the package's JS module."""
    await setup_guards(make_guard("Card", strategy="notify"))
    (url,) = _our_urls(hass)

    client = await hass_client()
    resp = await client.get(url)
    assert resp.status == 200
    assert "javascript" in resp.content_type
    assert await resp.text()


async def test_shared_modules_are_served(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client: ClientFactory
) -> None:
    """The bundle's imports (core, actions) resolve under the same static path."""
    await setup_guards(make_guard("Card", strategy="notify"))
    client = await hass_client()
    for name in ("necromancer-core.js", "necromancer-actions.js"):
        resp = await client.get(f"/necromancer_frontend/{name}?v=1")
        assert resp.status == 200, name
        assert "javascript" in resp.content_type


async def test_unload_removes_module_url(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """An unloaded entry stops the browsers from loading the cards."""
    entry = await setup_guards(make_guard("Card", strategy="notify"))
    assert _our_urls(hass)

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert _our_urls(hass) == []


async def test_setup_unload_setup_registers_again(
    hass: HomeAssistant, setup_guards: SetupGuards, hass_client: ClientFactory
) -> None:
    """A second setup in the same HA run neither fails nor doubles the URL.

    The static path stays from the first setup (it cannot be removed), and the
    module URL comes back exactly once.
    """
    entry = await setup_guards(make_guard("Card", strategy="notify"))
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    (url,) = _our_urls(hass)

    # A reload (unload + setup in one go) must not trip over the static path either.
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert _our_urls(hass) == [url]

    client = await hass_client()
    resp = await client.get(url)
    assert resp.status == 200


# ---------- sidebar panel ----------

_PANEL = "necromancer"


def _panel(hass: HomeAssistant):
    """Our registered sidebar panel, or None."""
    return hass.data.get(DATA_PANELS, {}).get(_PANEL)


async def test_setup_registers_sidebar_panel(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """By default the entry adds the "Necromancer" page, visible to all users."""
    await setup_guards(make_guard("Card", strategy="notify"))

    panel = _panel(hass)
    assert panel is not None
    version = (await async_get_integration(hass, DOMAIN)).version
    assert panel.component_name == "custom"
    assert panel.sidebar_title == "Necromancer"
    assert panel.sidebar_icon == "mdi:skull-crossbones"
    assert panel.require_admin is False
    custom = panel.config["_panel_custom"]
    assert custom["name"] == "necromancer-panel"
    # Same module (and version) as the cards: one download, never a stale page.
    assert custom["module_url"] == f"{_PREFIX}{version}"
    assert custom["embed_iframe"] is False


async def test_show_panel_off_registers_no_panel(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The option switched off: no sidebar page, the cards still load."""
    await setup_guards(
        make_guard("Card", strategy="notify"), options={"show_panel": False}
    )
    assert _panel(hass) is None
    assert _our_urls(hass)


async def test_unload_removes_panel_and_reload_restores_it(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """The page lives only while the entry is loaded; a reload keeps one."""
    entry = await setup_guards(make_guard("Card", strategy="notify"))
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert _panel(hass) is None

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert _panel(hass) is not None
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert _panel(hass) is not None


async def test_switching_the_option_adds_and_removes_the_panel(
    hass: HomeAssistant, setup_guards: SetupGuards
) -> None:
    """An options change reloads the entry, which applies the switch at once."""
    entry = await setup_guards(make_guard("Card", strategy="notify"))
    assert _panel(hass) is not None

    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "show_panel": False}
    )
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert _panel(hass) is None

    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "show_panel": True}
    )
    await hass.async_block_till_done()
    assert _panel(hass) is not None
