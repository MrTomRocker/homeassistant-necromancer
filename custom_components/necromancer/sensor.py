"""Status sensor for Necromancer (display only; state lives in the Store)."""

from __future__ import annotations

from datetime import datetime, timedelta
import logging

import voluptuous as vol

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import (
    config_validation as cv,
    entity_platform,
    entity_registry as er,
)
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import NecromancerConfigEntry
from .const import (
    ATTR_ATTEMPT,
    ATTR_DURATION,
    ATTR_EVENT,
    ATTR_EVENT_TEXT,
    ATTR_MAX,
    ATTR_MESSAGE,
    CONF_TYPE,
    DOMAIN,
    SERVICE_HEARTBEAT_PING,
    SERVICE_NOTIFY_GUARD,
    SERVICE_RESET,
    SERVICE_SNOOZE,
    SERVICE_UNSNOOZE,
)
from .core.engine import DeviceEngine, GState
from .core.health.heartbeat import (
    STATUS_FAIL,
    HeartbeatClosedError,
    HeartbeatHealth,
    require_heartbeat,
)
from .entity import NecromancerEntity

LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NecromancerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensor platform from a config entry."""
    for subentry_id, engine in entry.runtime_data.engines.items():
        subentry = entry.subentries.get(subentry_id)
        guard_name = subentry.title if subentry else engine.name
        entities: list[SensorEntity] = [StatusSensor(engine, subentry_id, guard_name)]
        if isinstance(engine.health, HeartbeatHealth):
            entities.append(LastHeartbeatSensor(engine, subentry_id, engine.health))
        async_add_entities(entities, config_subentry_id=subentry_id)

    # Per-guard operator services, targeted at the status sensor (device/area
    # targets expand to it). The status sensor is every guard's stable anchor.
    # A heartbeat guard also owns a last_heartbeat sensor (TIMESTAMP) without
    # these methods: the ENUM filter makes HA skip it when a device/area target
    # expands to it, and raise ServiceNotSupported when it is named explicitly,
    # instead of an AttributeError half-way through the call.
    only_status = [SensorDeviceClass.ENUM]
    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(
        SERVICE_RESET, None, "async_reset", entity_device_classes=only_status
    )
    platform.async_register_entity_service(
        SERVICE_SNOOZE,
        {vol.Required(ATTR_DURATION): cv.positive_time_period},
        "async_snooze",
        entity_device_classes=only_status,
    )
    platform.async_register_entity_service(
        SERVICE_UNSNOOZE, None, "async_unsnooze", entity_device_classes=only_status
    )
    platform.async_register_entity_service(
        SERVICE_NOTIFY_GUARD,
        {
            vol.Required(ATTR_MESSAGE): cv.string,
            vol.Optional(ATTR_EVENT, default="custom"): cv.string,
            vol.Optional(ATTR_EVENT_TEXT): cv.string,
            vol.Optional(ATTR_ATTEMPT): vol.Coerce(int),
            vol.Optional(ATTR_MAX): vol.Coerce(int),
        },
        "async_notify_guard",
        entity_device_classes=only_status,
    )
    # A function, not a method name: it needs the ServiceCall for the user id.
    platform.async_register_entity_service(
        SERVICE_HEARTBEAT_PING,
        None,
        _async_heartbeat_ping,
        entity_device_classes=only_status,
    )


async def _async_heartbeat_ping(entity: StatusSensor, call: ServiceCall) -> None:
    """necromancer.heartbeat_ping — hand the calling user to the entity."""
    await entity.async_heartbeat_ping(call.context.user_id)


class StatusSensor(NecromancerEntity, SensorEntity):
    """Current lifecycle state of the guarded device."""

    _attr_translation_key = "status"
    _attr_icon = "mdi:heart-pulse"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = [s.value for s in GState]

    def __init__(self, engine: DeviceEngine, subentry_id: str, guard_name: str) -> None:
        """Initialize the status sensor."""
        super().__init__(engine, subentry_id, "status")
        self._guard_name = guard_name

    @property
    def native_value(self) -> str:
        """Return the current lifecycle state."""
        return self._engine.state.value

    @property
    def extra_state_attributes(self) -> dict:
        """Return the status attributes."""
        e = self._engine
        attrs: dict = {
            "guard_name": self._guard_name,
            "health_entity": self._sibling("binary_sensor", "health"),
            "auto_recovery_entity": self._sibling("switch", "auto_restart"),
            "revive_entity": self._sibling("button", "recover"),
            "recovery_event_entity": self._sibling("event", "recovery_event"),
            "attempt": e.attempt,
            "recover_count": e.recover_count,
            "fail_count": e.fail_count,
            "last_recover": e.last_recover,
            "last_fail": e.last_fail,
            "recover_driver": e.driver.target_info(),
            "last_recover_driver_result": e.last_recover_driver_result,
            "last_recover_driver_time": e.last_recover_driver_time,
            "snooze_until": e._snooze_until,
            # Here, not only as `health_source` on the health binary sensor: that
            # one is unavailable (no attributes) while health is unknown, so a
            # heartbeat guard waiting for its first ping could not be found by it.
            "health_type": e.health.config.get(CONF_TYPE),
        }
        # Captured at the state transition, so it never changes between them.
        if e.health_detail is not None:
            attrs["health_detail"] = e.health_detail
        if isinstance(e.health, HeartbeatHealth):
            # Only values that move with the verdict: any attribute change turns
            # HA's state_reported into state_changed, one recorder row per ping.
            # The ping time itself lives on the LastHeartbeatSensor.
            src = e.health.state
            attrs["last_status"] = src.get("last_status")
            attrs["last_code"] = src.get("last_code")
            attrs["awaiting_first_success"] = (
                src.get("last_ok") is None and src.get("last_status") != STATUS_FAIL
            )
        return attrs

    def _sibling(self, domain: str, key: str) -> str | None:
        """Resolve a sibling entity's id from its unique_id (live, never stored)."""
        return er.async_get(self.hass).async_get_entity_id(
            domain, DOMAIN, f"{self._subentry_id}_{key}"
        )

    # ---------- operator services (registered above) ----------
    async def async_reset(self) -> None:
        """necromancer.reset — clear an ESCALATED guard."""
        self._engine.reset()

    async def async_snooze(self, duration: timedelta) -> None:
        """necromancer.snooze — suspend guarding for a while."""
        self._engine.snooze(duration)

    async def async_unsnooze(self) -> None:
        """necromancer.unsnooze — lift a snooze early."""
        self._engine.unsnooze()

    async def async_notify_guard(
        self,
        message: str,
        event: str,
        event_text: str | None = None,
        attempt: int | None = None,
        max: int | None = None,
    ) -> None:
        """necromancer.notify_guard — send a custom message via the guard's notify action."""
        params = {
            k: v for k, v in (("attempt", attempt), ("max", max)) if v is not None
        }
        await self._engine.async_notify_custom(message, event, event_text, **params)

    async def async_heartbeat_ping(self, user_id: str | None) -> None:
        """necromancer.heartbeat_ping — a manual success ping from HA.

        For a ping that got lost (HA was down) while the job demonstrably ran:
        `reset` would not help, the deadline would stay passed and the guard turn
        red again. This takes the endpoint's own path, so the deadline starts now,
        the engine re-evaluates (SUSPECT/ESCALATED -> OK) and the state is saved;
        while snoozed it is stored like any ping. A dormant guard has no entity,
        so it never gets here and nothing is written for it.
        """
        source = require_heartbeat(self._engine.health, self.entity_id)
        try:
            await source.async_handle_ping(True, None)
        except HeartbeatClosedError as err:
            # The source stopped under us (reload in flight): refuse loudly
            # rather than drop the ping silently.
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="heartbeat_not_running",
                translation_placeholders={"name": self._engine.name},
            ) from err
        # Otherwise indistinguishable from a real ping: record who set it. The
        # token stays out of the log (only the guard name and the user id).
        LOGGER.info(
            "%s: manual heartbeat ping by user %s",
            self._engine.name,
            user_id or "-",
        )


class LastHeartbeatSensor(NecromancerEntity, SensorEntity):
    """Time of the last ping of a heartbeat guard ("12 minutes ago" in the UI).

    Writes one recorder row per ping by design, which is why the ping time is
    kept off the status sensor. Users who don't want the history exclude it
    from the recorder.
    """

    _attr_translation_key = "last_heartbeat"
    _attr_icon = "mdi:heart-flash"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(
        self, engine: DeviceEngine, subentry_id: str, source: HeartbeatHealth
    ) -> None:
        """Initialize the last-heartbeat sensor (refreshed by every ping's emit)."""
        super().__init__(engine, subentry_id, "last_heartbeat")
        self._source = source

    @property
    def native_value(self) -> datetime | None:
        """Return the time of the last ping (success or failure)."""
        return dt_util.parse_datetime(self._source.state.get("last_ping") or "")

    @property
    def extra_state_attributes(self) -> dict:
        """Return the deadline plus the two times it is built from.

        `next_due` = basis + `period` (None after a failure ping). `grace` is the
        guard's debounce: how long SUSPECT waits after `next_due` before the
        reaction. Both are seconds and only move on a reconfigure (reload), so
        they cost no extra recorder rows.
        """
        return {
            "next_due": self._source.next_due(),
            "period": self._source.period,
            "grace": self._engine.debounce,
        }
