"""Base classes for Necromancer recovery drivers.

A RecoveryDriver performs the actual repair: power-cycle a switch
(`switch_cycle`), run one or two user-defined action sequences (`action_call` /
`action_cycle`), or auto-resolve a device to its PoE port (`poe_port`). Whether
the result is verified against the device's health entity is the engine's job.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from homeassistant.core import HomeAssistant


class RecoveryDriver(ABC):
    """Performs a recovery action for a guarded device."""

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self.hass = hass
        self.config = config

    async def resolve(self) -> None:  # noqa: B027
        """Optional: refresh internal mapping (e.g. poe_port MAC->port)."""

    async def can_recover(self) -> tuple[bool, str]:
        """Guard right before recovering. Returns (allowed, reason)."""
        return True, ""

    @abstractmethod
    async def recover(self) -> None:
        """Perform the recovery. Should return once the action is done."""

    def target_info(self) -> str:
        """Short human description of the target (e.g. the service or port)."""
        return self.config.get("type", "")

    def config_errors(self) -> list[str]:
        """Return human-readable config errors (e.g. a missing service).

        Checked at startup and logged at ERROR. Empty list = all good.
        """
        return []
