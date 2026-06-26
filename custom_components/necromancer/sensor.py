"""Status sensor for Necromancer (display only; state lives in the Store)."""

from __future__ import annotations

from datetime import timedelta

import voluptuous as vol

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    config_validation as cv,
    entity_platform,
    entity_registry as er,
)
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NecromancerConfigEntry
from .const import (
    ATTR_ATTEMPT,
    ATTR_DURATION,
    ATTR_EVENT,
    ATTR_EVENT_TEXT,
    ATTR_MAX,
    ATTR_MESSAGE,
    DOMAIN,
    SERVICE_NOTIFY_GUARD,
    SERVICE_RESET,
    SERVICE_SNOOZE,
    SERVICE_UNSNOOZE,
)
from .core.engine import DeviceEngine, GState
from .entity import NecromancerEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NecromancerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensor platform from a config entry."""
    for subentry_id, engine in entry.runtime_data.engines.items():
        subentry = entry.subentries.get(subentry_id)
        guard_name = subentry.title if subentry else engine.name
        async_add_entities(
            [StatusSensor(engine, subentry_id, guard_name)],
            config_subentry_id=subentry_id,
        )

    # Per-guard operator services, targeted at the status sensor (device/area
    # targets expand to it). The status sensor is every guard's stable anchor.
    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(SERVICE_RESET, None, "async_reset")
    platform.async_register_entity_service(
        SERVICE_SNOOZE,
        {vol.Required(ATTR_DURATION): cv.positive_time_period},
        "async_snooze",
    )
    platform.async_register_entity_service(SERVICE_UNSNOOZE, None, "async_unsnooze")
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
    )


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
        return {
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
        }

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
