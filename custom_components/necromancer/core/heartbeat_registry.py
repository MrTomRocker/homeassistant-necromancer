"""Token table behind the heartbeat endpoint (`hass.data[DOMAIN]["heartbeat"]`).

HA can register an HTTP view after start but never unregister it, so the view
stays up for the whole HA run and everything that changes lives in this table:
token -> entry. An entry's `state` decides the answer a ping gets:

- `active`  — the guard's engine runs and its HeartbeatHealth is registered
  (`source`); the ping is applied and evaluated.
- `waiting` — the guard is configured but its source is not running right now
  (reload, startup, failed guard setup, entry unloaded) -> 503, the sender retries
  and the next source gets the ping.
- `dormant` — the guard's device is disabled: no engine, the ping is only written
  into the guard's *stored* source state via `dormant_apply` (200 + dormant).
- token missing -> 404.

Lifecycle (wired by `__init__` and the view, see architecture.md §4):
`async_setup_entry` calls `rebuild()` from the subentry data (every token starts
`waiting`/`dormant`), then each source's `async_setup` calls `activate()` and its
unsub calls `deactivate()`. `async_unload_entry` calls `set_entry_waiting()`,
`async_remove_entry` calls `remove_entry()`. The view calls `lookup()`, checks
`local_only`, then `allow()` (rate limit), in that order.

Pure data + bookkeeping: no HTTP, no HA calls, so it is unit-testable as is.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
import time
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant

from ..const import DEFAULT_LOCAL_ONLY, DOMAIN

if TYPE_CHECKING:
    from .health.heartbeat import HeartbeatHealth

STATE_ACTIVE = "active"
STATE_WAITING = "waiting"
STATE_DORMANT = "dormant"

# At most RATE_LIMIT pings per RATE_WINDOW seconds per guard: enough headroom for a
# sender's retries after an outage, but someone holding a token cannot flood the
# Store and the notification chain (e.g. alternating fail/ok pings).
RATE_LIMIT = 5
RATE_WINDOW = 10.0

# Applies a ping (ok, code) to a dormant guard's stored source state and saves.
type DormantApply = Callable[[bool, str | None], None]


@dataclass(slots=True)
class HeartbeatSpec:
    """One configured heartbeat guard, as `__init__` reads it from subentry data."""

    token: str
    subentry_id: str
    local_only: bool = DEFAULT_LOCAL_ONLY
    dormant: bool = False
    dormant_apply: DormantApply | None = None


@dataclass(slots=True)
class HeartbeatEntry:
    """Routing state for one token."""

    state: str
    local_only: bool = DEFAULT_LOCAL_ONLY
    entry_id: str | None = None
    subentry_id: str | None = None
    source: HeartbeatHealth | None = None
    dormant_apply: DormantApply | None = None
    # Monotonic timestamps of the accepted pings inside the current window.
    hits: deque[float] = field(default_factory=deque)

    def allow(self, now: float | None = None) -> bool:
        """Count a ping against the rate limit; False = reject with 429.

        A rejected ping is not recorded, so a flood cannot keep the window full
        forever once it stops.
        """
        now = time.monotonic() if now is None else now
        while self.hits and now - self.hits[0] >= RATE_WINDOW:
            self.hits.popleft()
        if len(self.hits) >= RATE_LIMIT:
            return False
        self.hits.append(now)
        return True


class HeartbeatRegistry:
    """token -> HeartbeatEntry, shared by every entry for the whole HA run."""

    def __init__(self) -> None:
        """Start with an empty table."""
        self._entries: dict[str, HeartbeatEntry] = {}

    @classmethod
    def get(cls, hass: HomeAssistant) -> HeartbeatRegistry:
        """Return the domain-wide table, creating it on first use.

        Lives in `hass.data[DOMAIN]` (like the PoE fabric) because it has to
        outlive an entry reload: the view keeps answering 503 in between.
        """
        domain_data = hass.data.setdefault(DOMAIN, {})
        registry = domain_data.get("heartbeat")
        if registry is None:
            registry = domain_data["heartbeat"] = cls()
        return registry

    def lookup(self, token: str | None) -> HeartbeatEntry | None:
        """Entry for `token`, or None (-> 404)."""
        if not token:
            return None
        return self._entries.get(token)

    def tokens(self, entry_id: str | None = None) -> list[str]:
        """All tokens, or those of one config entry (for tests/diagnostics)."""
        return [
            t
            for t, e in self._entries.items()
            if entry_id is None or e.entry_id == entry_id
        ]

    # ---- maintained by __init__ ----
    def rebuild(self, entry_id: str, specs: Iterable[HeartbeatSpec]) -> None:
        """Reset the tokens of `entry_id` from its subentry data.

        Every configured token becomes `waiting` (or `dormant`); only a source's
        `async_setup` makes it `active`. Tokens of this entry that are no longer
        configured drop out (-> 404). The rate-limit window of a surviving token is
        kept, so a reload does not hand out a fresh burst.
        """
        wanted: dict[str, HeartbeatSpec] = {s.token: s for s in specs if s.token}
        for token in [t for t, e in self._entries.items() if e.entry_id == entry_id]:
            if token not in wanted:
                del self._entries[token]
        for token, spec in wanted.items():
            old = self._entries.get(token)
            self._entries[token] = HeartbeatEntry(
                state=STATE_DORMANT if spec.dormant else STATE_WAITING,
                local_only=spec.local_only,
                entry_id=entry_id,
                subentry_id=spec.subentry_id,
                dormant_apply=spec.dormant_apply if spec.dormant else None,
                hits=old.hits if old is not None else deque(),
            )

    def set_entry_waiting(self, entry_id: str) -> None:
        """Unload: every token of the entry answers 503 until it is set up again.

        Dormant tokens too: their store is no longer live, a write would be lost.
        """
        for entry in self._entries.values():
            if entry.entry_id == entry_id:
                entry.state = STATE_WAITING
                entry.source = None
                entry.dormant_apply = None

    def remove_entry(self, entry_id: str) -> None:
        """Integration entry deleted: its tokens are unknown from now on (404)."""
        for token in [t for t, e in self._entries.items() if e.entry_id == entry_id]:
            del self._entries[token]

    # ---- maintained by HeartbeatHealth ----
    def activate(self, token: str, source: HeartbeatHealth) -> None:
        """A source started: route pings for `token` to it.

        Creates the entry if `rebuild()` did not (e.g. a source set up in
        isolation); `local_only` always follows the running source's config.
        """
        entry = self._entries.get(token)
        if entry is None:
            entry = self._entries[token] = HeartbeatEntry(state=STATE_ACTIVE)
        entry.state = STATE_ACTIVE
        entry.source = source
        entry.local_only = source.local_only
        entry.dormant_apply = None

    def deactivate(self, token: str, source: HeartbeatHealth) -> None:
        """A source stopped: back to `waiting` (503) — but only if it is still ours.

        Guarded by identity so a late unsub of an old source cannot knock out a
        newer source that already took the token over.
        """
        entry = self._entries.get(token)
        if entry is not None and entry.source is source:
            entry.state = STATE_WAITING
            entry.source = None
