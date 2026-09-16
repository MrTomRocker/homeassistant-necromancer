"""Base entity wiring to a DeviceEngine.

One guarded device = one config subentry. Entities are linked to the subentry
via `config_subentry_id` at add time.

Device association: one device per guard, always ours, named after the guard. A
subentry pointing at an existing HA device adds that device as our `via_device`,
which nests the guard under it in the UI. Borrowing the target's identifiers
instead would build a second, competing device: since HA 2026.8 a device belongs
to a single config entry, so identifiers no longer merge across integrations.
"""

from __future__ import annotations

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .core.engine import DeviceEngine


class NecromancerEntity(Entity):
    """Common base: device info + live updates from the engine."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, engine: DeviceEngine, subentry_id: str, key: str) -> None:
        """Initialize the entity."""
        self._engine = engine
        self._subentry_id = subentry_id
        self._attr_unique_id = f"{subentry_id}_{key}"

        linked = self._linked_device(engine)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, subentry_id)},
            name=engine.name,
            manufacturer="Necromancer",
            model="Necromancer guard monitored device",
            # A link target that no longer resolves is reported via Repairs, not
            # forced here — a dangling via_device_id would abort the entity.
            **({"via_device_id": linked.id} if linked is not None else {}),
        )

    @staticmethod
    def _linked_device(engine: DeviceEngine) -> dr.DeviceEntry | None:
        """Return the linked target device, or None when standalone."""
        if engine.link_device_id:
            return dr.async_get(engine.hass).async_get(engine.link_device_id)
        return None

    async def async_added_to_hass(self) -> None:
        """Subscribe to engine updates when added to hass."""
        await super().async_added_to_hass()
        self.async_on_remove(self._engine.add_listener(self.async_write_ha_state))
