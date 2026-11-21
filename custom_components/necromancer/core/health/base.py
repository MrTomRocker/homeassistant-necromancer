"""Base classes for Necromancer health sources.

A HealthSource answers one question: is this device healthy right now?
The most generic is `entity_state` (one on/off entity: binary_sensor, switch
or input_boolean); a list/group and technology-specific sources (ping/http/…)
layer on top later.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from datetime import datetime
from enum import StrEnum

from homeassistant.core import CALLBACK_TYPE, HomeAssistant


class Health(StrEnum):
    """Health verdict. UNKNOWN is explicitly NOT unhealthy (no false alarm)."""

    OK = "ok"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


class HealthSource(ABC):
    """Determines whether a guarded device is healthy.

    State sources expose `watched_entities` and the engine re-evaluates on every
    change. Sources that track something else (e.g. a template) register their
    own listener in `async_setup` and call `on_change`; their `watched_entities`
    is empty. Either way `evaluate()` is always callable (so recovery verify
    works).
    """

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        """Store hass and the source's config block."""
        self.hass = hass
        self.config = config

    @property
    @abstractmethod
    def watched_entities(self) -> list[str]:
        """Entity ids to subscribe to for change events."""

    @abstractmethod
    def evaluate(self) -> Health:
        """Return the current health verdict."""

    def referenced_entities(self) -> list[str]:
        """Entities the verdict depends on (for self-reference / loop checks).

        Defaults to `watched_entities`; a source that tracks something else (a
        template) overrides this with its real dependency set.
        """
        return list(self.watched_entities)

    async def async_setup(self, on_change: CALLBACK_TYPE) -> CALLBACK_TYPE | None:
        """Register own listeners (e.g. a template tracker). Returns an unsub."""
        return None

    # ---- optional hooks (no-op defaults, so existing sources are unaffected) ----
    def snapshot(self) -> dict:
        """Source-owned state to persist (stored under the guard's `source` key).

        Only sources with state of their own (a heartbeat's last ping) need this;
        entity/template sources re-read live state and keep nothing.
        """
        return {}

    def restore(self, data: dict) -> bool:
        """Seed source state from a stored `snapshot()` before `async_setup`.

        Returns True when the stored state belongs to a different identity (e.g.
        a regenerated heartbeat token): the engine then discards a persisted
        ESCALATED verdict, since it judged something that no longer exists.
        """
        return False

    def bind_persist(self, save: Callable[[], None]) -> None:
        """Receive the engine's save callback.

        The engine only saves on state transitions; a source whose own state
        changes without one (an OK->OK heartbeat ping) calls `save` itself.
        Sources without own state ignore it.
        """
        return

    def detail(self) -> tuple[str, dict] | None:
        """Why the current verdict is what it is: (DETAIL_MESSAGES key, params).

        Read synchronously by the engine at a transition and rendered as a
        second sentence of the alarm. None = no detail, behaviour unchanged.
        """
        return None

    def confirmed(self) -> bool:
        """True when the current UNHEALTHY verdict needs no debounce.

        The debounce exists to absorb blips of a signal that can flap. A source
        that was told outright about a fault (a heartbeat's reported failure)
        returns True, and the engine reacts at once instead of waiting it out —
        also cutting short a debounce already running. Default False keeps every
        other source on the normal debounce.
        """
        return False

    def fault_since(self) -> datetime | None:
        """When the current fault began, if the source knows it across restarts.

        The engine counts the debounce from here instead of from the moment it
        noticed the fault, so a reload or an HA restart inside the debounce does
        not start it over: only the rest is waited out, or none if it is used up.
        Only a source whose start lives in its own stored state may answer (a
        heartbeat's passed deadline). Default None: the debounce starts when the
        engine sees the fault, as before.
        """
        return None

    def describe(self) -> str:
        """Short human description for diagnostics."""
        return self.config.get("type", "")

    @property
    def health_source(self) -> str:
        """The watched entity_id or the raw template — for dashboards/diagnostics."""
        return self.describe()
