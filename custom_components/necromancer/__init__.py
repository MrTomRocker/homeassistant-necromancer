"""The Necromancer integration — revives dead devices.

HealthSource -> Engine (RecoveryPolicy) -> RecoveryDriver.
One config entry = the Necromancer service. Each **guarded device** is a config
*subentry* (added via "Add device"). One DeviceEngine per subentry lives in
entry.runtime_data.engines, keyed by subentry_id.

HA lifecycle entry points:
    async_setup_entry                 load an entry (boot / add / after reload)
    async_unload_entry                tear it down (shutdown / before reload)
    async_remove_config_entry_device  user deletes a guarded device in the UI
Plus the registered reload hook (_async_reload_entry) on options/subentry change.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging
import time

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import (
    CALLBACK_TYPE,
    Event,
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import (
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
    issue_registry as ir,
)
from homeassistant.helpers.event import (
    async_track_device_registry_updated_event,
    async_track_state_change_event,
)
from homeassistant.helpers.service import async_register_admin_service
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    ATTR_CHECK_FIRST,
    ATTR_DURATION,
    ATTR_GUARD,
    ATTR_ID,
    ATTR_TIMEOUT,
    CONF_BEHAVIOR,
    CONF_DEVICE_ID,
    CONF_DRIVER,
    CONF_ENTITY_ID,
    CONF_HEALTH,
    CONF_LINKED_GUARDS,
    CONF_LOCAL_ONLY,
    CONF_POLICY,
    CONF_PORTS,
    CONF_SHOW_PANEL,
    CONF_TOKEN,
    CONF_TYPE,
    DEFAULT_LOCAL_ONLY,
    DEFAULT_SHOW_PANEL,
    DOMAIN,
    HEALTH_TYPE_HEARTBEAT,
    MODE_NOTIFY,
    PLATFORMS,
    SAVE_DELAY,
    SERVICE_CHECK_HEALTH,
    SERVICE_HEARTBEAT_URL,
    SERVICE_REPAIR_POE_PORT,
    SERVICE_SNOOZE_ALL,
    SERVICE_UNSNOOZE_ALL,
    SERVICE_WAIT_FOR_HEALTH,
    STORAGE_VERSION,
    SUBENTRY_TYPE_DEVICE,
)
from .core.drivers import create_driver
from .core.engine import DeviceEngine, reset_engine_verdict
from .core.health import create_health
from .core.health.heartbeat import (
    apply_ping,
    ping_path,
    ping_url,
    reconcile_token,
    require_heartbeat,
)
from .core.heartbeat_registry import DormantApply, HeartbeatRegistry, HeartbeatSpec
from .core.links import link_components
from .core.poe import PoeFabric
from .core.policies import create_policy
from .frontend import (
    async_register_frontend,
    async_register_panel,
    async_unregister_frontend,
    async_unregister_panel,
)
from .heartbeat_view import async_register_view
from .websocket import async_register_websocket

LOGGER = logging.getLogger(__name__)


@dataclass
class NecromancerData:
    """Typed per-entry runtime state (``entry.runtime_data``).

    One engine per guarded-device subentry, plus the Store + its serializer so
    unload can flush without a side `hass.data` registry. The PoE fabric stays in
    `hass.data[DOMAIN]` on purpose: it outlives a single entry's reload.
    """

    engines: dict[str, DeviceEngine]
    store: Store
    serialize: Callable[[], dict]


type NecromancerConfigEntry = ConfigEntry[NecromancerData]


# ---------- setup helpers ----------
def _build_engine(
    hass: HomeAssistant,
    name: str,
    cfg: dict,
    persisted: dict | None,
    save: CALLBACK_TYPE,
    on_health_renamed: Callable[[str], None],
    subentry_id: str,
    linked_guards: list[str],
    engines: dict[str, DeviceEngine],
) -> DeviceEngine:
    """Construct a DeviceEngine from a subentry's config dict."""
    return DeviceEngine(
        hass,
        name,
        create_health(hass, cfg[CONF_HEALTH]),
        create_driver(hass, cfg[CONF_DRIVER]),
        create_policy(cfg.get(CONF_POLICY, {CONF_TYPE: "standard"})),
        cfg.get(CONF_BEHAVIOR, {}),
        cfg.get(CONF_DEVICE_ID),
        persisted,
        save,
        on_health_renamed,
        subentry_id=subentry_id,
        linked_guards=linked_guards,
        engines=engines,
    )


def _guard_device_ids(hass: HomeAssistant, entry: NecromancerConfigEntry) -> list[str]:
    """Device ids of our guards, for the enable/disable watch.

    Read after the platforms ran, so a guard added at runtime is included too.
    """
    dev_reg = dr.async_get(hass)
    return [
        device.id
        for subentry_id in entry.subentries
        if (
            device := dev_reg.async_get_device_by_identifier(
                (DOMAIN, subentry_id), entry.entry_id
            )
        )
        is not None
    ]


def _dormant_guards(hass: HomeAssistant, entry: NecromancerConfigEntry) -> set[str]:
    """Subentry ids whose guard device is disabled in the device registry.

    Disabling a guard's device is the only UI gesture for "this guard off", and HA
    core stops at the entity registry: it disables our view-entities but neither
    unloads the subentry nor tells us, so without this the engine keeps detecting,
    recovering and notifying headlessly — with its auto switch gone, so the operator
    cannot even stop it. A brand-new guard has no device yet (the platforms create it
    from DeviceInfo, after this runs), and an absent device is not a disabled one.
    """
    dev_reg = dr.async_get(hass)
    return {
        subentry_id
        for subentry_id, subentry in entry.subentries.items()
        if subentry.subentry_type == SUBENTRY_TYPE_DEVICE
        and (
            device := dev_reg.async_get_device_by_identifier(
                (DOMAIN, subentry_id), entry.entry_id
            )
        )
        is not None
        and device.disabled
    }


def _rename_handler(
    hass: HomeAssistant, entry: NecromancerConfigEntry, subentry_id: str
) -> Callable[[str], None]:
    """Persist a health-entity rename into the subentry (triggers a reload)."""

    @callback
    def _renamed(new_entity_id: str) -> None:
        subentry = entry.subentries.get(subentry_id)
        if subentry is None:
            return
        health = {**subentry.data.get(CONF_HEALTH, {}), CONF_ENTITY_ID: new_entity_id}
        hass.config_entries.async_update_subentry(
            entry, subentry, data={**subentry.data, CONF_HEALTH: health}
        )

    return _renamed


def _is_heartbeat(subentry) -> bool:
    """A guard whose health source is the heartbeat endpoint."""
    return (
        subentry.subentry_type == SUBENTRY_TYPE_DEVICE
        and subentry.data.get(CONF_HEALTH, {}).get(CONF_TYPE) == HEALTH_TYPE_HEARTBEAT
    )


def _dormant_apply(
    stored: dict, subentry_id: str, token: str, save: Callable[[], None]
) -> DormantApply:
    """Store (not evaluate) a ping for a dormant heartbeat guard.

    A dormant guard has no engine, but its job keeps running: without this its
    `last_ok` would stay at the last ping before the disable, and re-enabling a
    guard that was off longer than its period would alarm `heartbeat_overdue`
    at once although the job ran all along. The same pure `apply_ping` as the live
    source writes into the stored blob that `_serialize` carries over verbatim.
    """

    @callback
    def _apply(ok: bool, code: str | None) -> None:
        now = dt_util.utcnow()
        guard = dict(stored.get(subentry_id) or {})
        source, changed = reconcile_token(guard.get("source") or {}, token, now)
        # Created asleep or token regenerated in its sleep: the stored verdict was
        # judged under another token. Drop it here — on wake-up restore() sees a
        # matching fingerprint and would keep a stale ESCALATED otherwise.
        if changed and guard:
            guard = reset_engine_verdict(guard)
        guard["source"] = apply_ping(source, ok, code, now)
        stored[subentry_id] = guard
        save()

    return _apply


def _heartbeat_specs(
    entry: NecromancerConfigEntry,
    dormant: set[str],
    stored: dict,
    save: Callable[[], None],
) -> list[HeartbeatSpec]:
    """One token-table spec per configured heartbeat guard (from subentry data)."""
    specs: list[HeartbeatSpec] = []
    for subentry_id, subentry in entry.subentries.items():
        if not _is_heartbeat(subentry):
            continue
        health = subentry.data[CONF_HEALTH]
        if not (token := health.get(CONF_TOKEN)):
            continue
        asleep = subentry_id in dormant
        specs.append(
            HeartbeatSpec(
                token=token,
                subentry_id=subentry_id,
                local_only=bool(health.get(CONF_LOCAL_ONLY, DEFAULT_LOCAL_ONLY)),
                dormant=asleep,
                dormant_apply=_dormant_apply(stored, subentry_id, token, save)
                if asleep
                else None,
            )
        )
    return specs


# ---------- HA lifecycle: setup ----------
def _engine_for_guard(
    hass: HomeAssistant, entry: NecromancerConfigEntry, guard_entity_id: str
) -> DeviceEngine:
    """Resolve a guard's status entity to its engine (for the health services)."""
    ent = er.async_get(hass).async_get(guard_entity_id)
    engine = (
        entry.runtime_data.engines.get(ent.config_subentry_id)
        if ent is not None and ent.platform == DOMAIN
        else None
    )
    if engine is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_guard",
            translation_placeholders={"entity_id": guard_entity_id},
        )
    return engine


_ISSUE_SEVERITY = {
    "health_entity_missing": ir.IssueSeverity.ERROR,
    "health_entity_disabled": ir.IssueSeverity.ERROR,
    "health_template_blind": ir.IssueSeverity.ERROR,
    "health_template_missing_entity": ir.IssueSeverity.WARNING,
    "recovery_action_invalid": ir.IssueSeverity.ERROR,
    "link_device_missing": ir.IssueSeverity.WARNING,
    "port_no_id": ir.IssueSeverity.WARNING,
    "port_entity_missing": ir.IssueSeverity.ERROR,
}


def _reconcile_issues(
    hass: HomeAssistant, engines: dict[str, DeviceEngine], fabric: PoeFabric
) -> None:
    """Surface user-fixable config problems in Repairs, clearing resolved ones.

    Idempotent: re-run at startup and on every reload — so fixing the config and
    saving (which reloads the entry) makes a stale issue disappear by itself.
    """
    desired: dict[str, dict] = {}
    for eng in engines.values():
        for problem in eng.config_problems():
            desired[problem["id"]] = problem
    for problem in fabric.port_problems():
        desired[problem["id"]] = problem

    reg = ir.async_get(hass)
    ours = {
        iid
        for (dom, iid), issue in reg.issues.items()
        if dom == DOMAIN and issue.translation_key in _ISSUE_SEVERITY
    }
    for iid, problem in desired.items():
        ir.async_create_issue(
            hass,
            DOMAIN,
            iid,
            is_fixable=False,
            severity=_ISSUE_SEVERITY[problem["key"]],
            translation_key=problem["key"],
            translation_placeholders=problem["placeholders"],
        )
    for iid in ours - set(desired):
        ir.async_delete_issue(hass, DOMAIN, iid)


async def async_setup_entry(hass: HomeAssistant, entry: NecromancerConfigEntry) -> bool:
    """Set up the service: one engine per guarded-device subentry."""
    store: Store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
    stored = await store.async_load() or {}
    engines: dict[str, DeviceEngine] = {}

    # A guard whose own device the user disabled is dormant: no engine is built, so
    # it detects nothing, recovers nothing, notifies nothing and raises no Repairs.
    # Resolved up here because _serialize below has to carry its stored state.
    dormant = _dormant_guards(hass, entry)

    # PoE fabric: shared id->port resolver + per-port status/lock, driving the
    # necromancer.repair_poe_port service. A domain-level singleton so it survives
    # reloads (and the service handler keeps a stable reference).
    domain_data = hass.data.setdefault(DOMAIN, {})
    fabric: PoeFabric = domain_data.get("fabric") or PoeFabric(hass)
    domain_data["fabric"] = fabric

    configured = {
        sid
        for sid, se in entry.subentries.items()
        if se.subentry_type == SUBENTRY_TYPE_DEVICE
    }

    @callback
    def _serialize() -> dict:
        data: dict = {sid: engine.snapshot() for sid, engine in engines.items()}
        # A configured guard without a running engine — dormant, or its setup
        # failed — has nothing to snapshot, so carry its stored state over verbatim.
        # Otherwise disabling a device would silently reset its counters and its
        # ESCALATED verdict, and the next save (another guard's ping) would wipe a
        # failed heartbeat guard's last_ok/armed_at/token_fp. Removed guards are not
        # configured any more and drop out here.
        for subentry_id in configured - engines.keys():
            if (persisted := stored.get(subentry_id)) is not None:
                data[subentry_id] = persisted
        data["_poe_cache"] = fabric.cache
        return data

    def _save() -> None:
        store.async_delay_save(_serialize, SAVE_DELAY)

    # Heartbeat endpoint: the view once per HA run, the token table rebuilt from
    # the subentry data *before* any engine starts — every token is `waiting`
    # (503) or `dormant` until its source's async_setup makes it `active`.
    async_register_view(hass)
    HeartbeatRegistry.get(hass).rebuild(
        entry.entry_id, _heartbeat_specs(entry, dormant, stored, _save)
    )

    # Lovelace cards: static path once per HA run, module URL while loaded; the
    # sidebar page while loaded and the option is on; the cards' read-only WS API.
    await async_register_frontend(hass)
    if entry.options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL):
        await async_register_panel(hass)
    async_register_websocket(hass)

    # PoE ports are a flat list in the entry's options; every poe_port guard
    # searches the whole list, so inject it into each such driver at setup. An
    # options change reloads us (the update listener below), keeping it fresh.
    ports = entry.options.get(CONF_PORTS, [])
    fabric.set_ports(ports, cache=stored.get("_poe_cache"))
    for port in ports:
        LOGGER.debug("PoE port loaded — %s", port)

    if not hass.services.has_service(DOMAIN, SERVICE_REPAIR_POE_PORT):

        async def _repair_poe_port(call: ServiceCall) -> None:
            port_id = call.data[ATTR_ID]
            LOGGER.info("repair_poe_port requested for %s", port_id)
            await fabric.repair(port_id)

        hass.services.async_register(
            DOMAIN,
            SERVICE_REPAIR_POE_PORT,
            _repair_poe_port,
            schema=vol.Schema({vol.Required(ATTR_ID): cv.string}),
        )

    # Bulk "maintenance mode" services (no target — every guard, incl. notify-only).
    # Re-registered each setup so the handler closes over the current entry's engines.
    async def _snooze_all(call: ServiceCall) -> None:
        duration = call.data[ATTR_DURATION]
        busy: list[str] = []
        for engine in entry.runtime_data.engines.values():
            try:
                engine.snooze(duration)
            except ServiceValidationError:
                busy.append(engine.name)  # mid-recovery — best-effort, skip it
        if busy:
            LOGGER.warning(
                "snooze_all: skipped %s guard(s) busy recovering: %s",
                len(busy),
                ", ".join(busy),
            )

    async def _unsnooze_all(call: ServiceCall) -> None:
        for engine in entry.runtime_data.engines.values():
            engine.unsnooze()

    hass.services.async_register(
        DOMAIN,
        SERVICE_SNOOZE_ALL,
        _snooze_all,
        schema=vol.Schema({vol.Required(ATTR_DURATION): cv.positive_time_period}),
    )
    hass.services.async_register(DOMAIN, SERVICE_UNSNOOZE_ALL, _unsnooze_all)

    # Per-guard health primitives (response services) — a recovery script passes the
    # guard's status entity and re-uses the guard's own health-check.
    async def _check_health(call: ServiceCall) -> ServiceResponse:
        engine = _engine_for_guard(hass, entry, call.data[ATTR_GUARD])
        return {"health": engine.current_health().value}

    async def _wait_for_health(call: ServiceCall) -> ServiceResponse:
        engine = _engine_for_guard(hass, entry, call.data[ATTR_GUARD])
        start = time.monotonic()
        ok = await engine.async_service_wait_health(
            call.data.get(ATTR_TIMEOUT), check_first=call.data[ATTR_CHECK_FIRST]
        )
        return {
            "health": engine.current_health().value,
            "timed_out": not ok,
            "waited_s": round(time.monotonic() - start),
        }

    hass.services.async_register(
        DOMAIN,
        SERVICE_CHECK_HEALTH,
        _check_health,
        schema=vol.Schema({vol.Required(ATTR_GUARD): cv.entity_id}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_WAIT_FOR_HEALTH,
        _wait_for_health,
        schema=vol.Schema(
            {
                vol.Required(ATTR_GUARD): cv.entity_id,
                vol.Optional(ATTR_TIMEOUT): vol.All(vol.Coerce(int), vol.Range(min=1)),
                vol.Optional(ATTR_CHECK_FIRST, default=True): cv.boolean,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    # The heartbeat URL contains the guard's secret token, so it is admin-only,
    # like reading it from the subentry would be. HA's admin wrapper checks the
    # caller before the handler runs; calls without a user (automations, scripts)
    # are trusted as for every admin service.
    async def _heartbeat_url(call: ServiceCall) -> ServiceResponse:
        guard = call.data[ATTR_GUARD]
        engine = _engine_for_guard(hass, entry, guard)
        source = require_heartbeat(engine.health, guard)
        return {
            # None when HA knows no own URL: the caller adds its address to `path`.
            "url": ping_url(hass, engine.name, source.config),
            "path": ping_path(engine.name, source.token),
        }

    async_register_admin_service(
        hass,
        DOMAIN,
        SERVICE_HEARTBEAT_URL,
        _heartbeat_url,
        schema=vol.Schema({vol.Required(ATTR_GUARD): cv.entity_id}),
        supports_response=SupportsResponse.ONLY,
    )

    # Guard linking: resolve each guard's group (clique-closed) from the declared
    # links. Only **recover** guards can link (matching the config flow's options),
    # so notify-only guards are excluded from the closure — a guard reconfigured to
    # notify-only therefore drops out of every group instead of lingering inertly.
    # Dormant guards drop out the same way: no leading, no following, no re-verify.
    # Heartbeat guards never link: as a leader with a job restart they would hold
    # every auto partner for up to max_attempts * boot_window, during which a real
    # partner outage goes unnoticed — and a job restart rarely fixes a shared cause.
    def _is_recover(se) -> bool:
        return (
            se.subentry_type == SUBENTRY_TYPE_DEVICE
            and se.data.get(CONF_POLICY, {}).get(CONF_TYPE) != MODE_NOTIFY
            and not _is_heartbeat(se)
        )

    device_ids = {
        sid
        for sid, se in entry.subentries.items()
        if _is_recover(se) and sid not in dormant
    }
    declared_links = {
        sid: set(se.data.get(CONF_LINKED_GUARDS, []) or [])
        for sid, se in entry.subentries.items()
        if _is_recover(se) and sid not in dormant
    }
    groups = link_components(declared_links, device_ids)

    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SUBENTRY_TYPE_DEVICE:
            continue
        if subentry_id in dormant:
            LOGGER.info(
                "Guard %r is dormant — its device is disabled, so it is not loaded",
                subentry.data.get(CONF_NAME, subentry.title),
            )
            continue
        cfg = dict(subentry.data)
        name = cfg.get(CONF_NAME, subentry.title)
        # poe_port guards resolve + cycle through the shared fabric (which owns the
        # port list), so nothing port-specific needs injecting into the driver here.
        linked = sorted(groups.get(subentry_id, {subentry_id}) - {subentry_id})
        try:
            engine = _build_engine(
                hass,
                name,
                cfg,
                stored.get(subentry_id),
                _save,
                _rename_handler(hass, entry, subentry_id),
                subentry_id,
                linked,
                engines,
            )
            await engine.async_start()
        except Exception:
            # One malformed guard must not take down the whole entry (all guards):
            # log which one and carry on with the rest.
            LOGGER.exception("Failed to set up guard %r — skipping", name)
            continue
        engines[subentry_id] = engine
        LOGGER.info(
            "Guard %r loaded — mode=%s, health=%s, strategy=%s (%s), "
            "behavior=%s, device_link=%s, linked=%s, auto=%s",
            engine.name,
            "notify-only" if not engine.allows_recovery else "recover",
            engine.health.describe(),
            cfg.get(CONF_DRIVER, {}).get(CONF_TYPE, "—"),
            engine.driver.target_info(),
            cfg.get(CONF_BEHAVIOR, {}),
            engine.link_device_id or "none",
            linked or "none",
            engine.auto,
        )

    entry.runtime_data = NecromancerData(
        engines=engines, store=store, serialize=_serialize
    )
    LOGGER.info("Service set up with %s guarded device(s)", len(engines))

    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _reconcile_devices(hass, entry, engines, dormant)
    _reconcile_entities(hass, entry, engines)

    # Status sensors resolve their sibling entity_ids from the registry, which is
    # only complete once every platform set up above — nudge one re-render so the
    # sibling attributes populate (instead of waiting for the next engine tick).
    for engine in engines.values():
        engine.refresh_entities()

    # Validate guard configs once HA is started AND the platforms above have
    # registered each guard's own view-entities — so the self-reference (feedback
    # loop) check sees them even when a guard is added at runtime. async_at_started
    # defers to "started" on boot (avoids false positives) and runs right away at
    # runtime, by which point the entities exist (forward_entry_setups is awaited).
    @callback
    def _validate_configs(_hass: HomeAssistant) -> None:
        for eng in engines.values():
            eng._check_config(_hass)
        _reconcile_issues(_hass, engines, fabric)

    entry.async_on_unload(async_at_started(hass, _validate_configs))

    # Live config re-validation: re-reconcile when a watched entity appears or
    # disappears (a state-only entity loading, an entity removed or disabled). Only
    # existence transitions matter — a value change doesn't affect config issues.
    watched: set[str] = set(fabric.referenced_entities())
    for eng in engines.values():
        watched.update(eng.health.watched_entities)
        watched.update(eng.health.referenced_entities())

    @callback
    def _on_watched_change(event: Event) -> None:
        old, new = event.data.get("old_state"), event.data.get("new_state")
        if (old is None) != (new is None):  # appeared or disappeared
            _reconcile_issues(hass, engines, fabric)

    if watched:
        entry.async_on_unload(
            async_track_state_change_event(hass, list(watched), _on_watched_change)
        )

    # Enabling/disabling a guard's device must take effect now, not at the next
    # restart. HA core only cascades the disable into the entity registry, so we
    # watch our own devices and reload: setup then builds (or skips) their engines.
    # Scheduled, not awaited — this is a registry callback, and reloading the entry
    # it fires from would re-enter the very setup that registered this listener.
    if guard_device_ids := _guard_device_ids(hass, entry):

        @callback
        def _on_guard_device_change(event: Event) -> None:
            if event.data["action"] == "update" and "disabled_by" in event.data.get(
                "changes", {}
            ):
                LOGGER.debug(
                    "Guard device %s toggled — reloading", event.data["device_id"]
                )
                hass.config_entries.async_schedule_reload(entry.entry_id)

        entry.async_on_unload(
            async_track_device_registry_updated_event(
                hass, guard_device_ids, _on_guard_device_change
            )
        )
    return True


# ---------- reconciliation helpers ----------
def _reconcile_entities(
    hass: HomeAssistant,
    entry: NecromancerConfigEntry,
    engines: dict[str, DeviceEngine],
) -> None:
    """Drop entities a guard no longer has after a reconfigure.

    A guard reconfigured recover -> notify-only would otherwise leave its
    auto-restart switch and recover button behind as orphans, and one switched
    away from the heartbeat source its last-heartbeat sensor.
    """
    ent_reg = er.async_get(hass)
    for subentry_id, engine in engines.items():
        stale: list[tuple[str, str, str]] = []
        if not engine.allows_recovery:
            stale += [
                ("switch", "auto_restart", "notify-only"),
                ("button", "recover", "notify-only"),
                ("event", "recovery_event", "notify-only"),
            ]
        if engine.health.config.get(CONF_TYPE) != HEALTH_TYPE_HEARTBEAT:
            stale.append(("sensor", "last_heartbeat", "no heartbeat source"))
        for domain, key, why in stale:
            eid = ent_reg.async_get_entity_id(domain, DOMAIN, f"{subentry_id}_{key}")
            if eid is not None:
                LOGGER.debug("Removing %s of guard %s (%s)", eid, engine.name, why)
                ent_reg.async_remove(eid)


def _reconcile_devices(
    hass: HomeAssistant,
    entry: NecromancerConfigEntry,
    engines: dict[str, DeviceEngine],
    dormant: set[str],
) -> None:
    """Drop devices of ours that no longer belong to a live guard.

    Every guard owns exactly one device, identified by its subentry. Anything else
    under our entry is a leftover: the device of a deleted guard, or one carrying a
    foreign integration's identifiers from before HA 2026.8 tied a device to a
    single config entry. Entities have already moved to their guard's device by the
    time this runs (platforms are set up first), so removing those is safe.

    A dormant guard has no engine but must keep its device: the registry lists
    disabled devices like any other, so removing it here would delete the very
    device carrying the user's disable — and the next reload would recreate a fresh,
    *enabled* one, turning the guard back on by itself.
    """
    dev_reg = dr.async_get(hass)
    live = set(engines) | dormant
    for device in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        ours = {ident for domain, ident in device.identifiers if domain == DOMAIN}
        if ours & live:
            continue
        LOGGER.debug("Removing stale guard device %s", device.name or device.id)
        dev_reg.async_remove_device(device.id)


# ---------- HA lifecycle: reload / remove / unload ----------
async def _async_reload_entry(
    hass: HomeAssistant, entry: NecromancerConfigEntry
) -> None:
    """Reload the service when subentries (devices) are added/changed/removed."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_remove_config_entry_device(
    hass: HomeAssistant,
    config_entry: NecromancerConfigEntry,
    device_entry: dr.DeviceEntry,
) -> bool:
    """Allow manual deletion of a guarded-device entry from the UI."""
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: NecromancerConfigEntry
) -> bool:
    """Unload the service and stop all engines."""
    data = entry.runtime_data
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        # Stop first, flush second. Stopping sets every heartbeat token `waiting`,
        # so a ping from here on gets 503 (and is retried into the next source)
        # instead of landing in a source whose state was already written — and no
        # late delayed save can overwrite the flush with older data.
        for engine in data.engines.values():
            await engine.async_stop()
        HeartbeatRegistry.get(hass).set_entry_waiting(entry.entry_id)
        if (fabric := hass.data.get(DOMAIN, {}).get("fabric")) is not None:
            fabric.shutdown()
        async_unregister_frontend(hass)
        async_unregister_panel(hass)
    # Flush the final runtime state (stopped engines still hold it), so a reload
    # (rename/reconfigure) does not read a stale store.
    await data.store.async_save(data.serialize())
    return unload_ok


async def async_remove_entry(
    hass: HomeAssistant, entry: NecromancerConfigEntry
) -> None:
    """Drop our config-health repair issues and heartbeat tokens on removal.

    Without this they would linger in Settings → Repairs until the next restart
    (they are non-persistent), even though the guards they referred to are gone.
    """
    reg = ir.async_get(hass)
    stale = [
        iid
        for (dom, iid), issue in reg.issues.items()
        if dom == DOMAIN and issue.translation_key in _ISSUE_SEVERITY
    ]
    for iid in stale:
        ir.async_delete_issue(hass, DOMAIN, iid)
    # The integration is gone: its heartbeat URLs are unknown from now on (404).
    HeartbeatRegistry.get(hass).remove_entry(entry.entry_id)
