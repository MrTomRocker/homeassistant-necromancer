"""Health source: a job outside HA reports a heartbeat to a secret URL.

Every guard of this type owns a token; a sender (systemd job, cron, NAS task)
POSTs `/api/necromancer/heartbeat/<name>_<token>[?status=<s>]` when it ran. The
verdict is "was there a success within the period" — a continuous judgement like
the other sources, so the recovery VERIFY step and `check_health` keep working.

There is no grace here: the grace of healthchecks.io is the engine's normal
debounce. An overdue guard turns UNHEALTHY at `basis + period`, the engine waits
out its debounce in SUSPECT, and a late ping in that window ends it silently. The
debounce counts from that deadline (`fault_since()`), so a reload or restart in
the grace does not postpone the alarm. A reported failure is unambiguous, so
`confirmed()` lets the engine skip the debounce for it.

Split like the rest of the core: the pure functions below (parse, apply, evaluate,
deadline, token reconciliation) know nothing about HA and are unit-tested
directly; `HeartbeatHealth` only wires them to a deadline timer, the token table
(`core/heartbeat_registry.py`) and the engine's persistence. The HTTP view reads
the request and calls `async_handle_ping`; the same `apply_ping` also updates the
stored state of a dormant guard (no engine), so both paths agree.

Stored state (`snapshot()`, JSON-ready, timestamps as ISO strings): `last_ping`
(any ping), `last_ok` (last success), `last_status` (`ok`/`fail`), `last_code`,
`armed_at` (creation or new token) and `token_fp` (fingerprint, never the token).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
import hashlib
import re

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.network import NoURLAvailableError, get_url
from homeassistant.util import dt as dt_util, slugify

from ...const import (
    CONF_LOCAL_ONLY,
    CONF_PERIOD,
    CONF_TOKEN,
    DEFAULT_LOCAL_ONLY,
    DEFAULT_PERIOD,
    DOMAIN,
    HEARTBEAT_PATH,
)
from ..heartbeat_registry import HeartbeatRegistry
from .base import Health, HealthSource

STATUS_OK = "ok"
STATUS_FAIL = "fail"

# Success is only a missing status, `ok` or `0`. Everything else is a failure, even
# an empty `status=`: that is almost always an unset variable at the sender
# (`status=$RC`), and reading it as success would silently hide failures.
_SUCCESS_VALUES = {"ok", "0"}
# A failure value is kept for the message only if it is short and harmless (an exit
# code like `3` or a signal name like `TERM`); anything else is just "failure".
_CODE_RE = re.compile(r"[A-Za-z0-9_-]{1,16}")

# The timer fires at the deadline plus this margin: evaluate() is strict
# (`now > deadline`), so a timer firing exactly on the deadline would still read OK
# and nothing would re-arm it.
_TIMER_MARGIN = timedelta(seconds=1)

_RESET_KEYS = ("last_ping", "last_ok", "last_status", "last_code")


class HeartbeatClosedError(Exception):
    """The source was stopped (reload/unload) — the view answers 503 so it retries."""


# ---------------- pure functions ----------------


def parse_status(raw: str | None) -> tuple[bool, str | None]:
    """Map the `status` query value to (success, code-to-keep).

    Missing/`ok`/`0` (any case) = success. Anything else is a failure; its value is
    kept as `last_code` only if it matches `^[A-Za-z0-9_-]{1,16}$` and is not
    `fail` (that carries no information beyond "failure").
    """
    if raw is None or raw.lower() in _SUCCESS_VALUES:
        return True, None
    if _CODE_RE.fullmatch(raw) and raw.lower() != STATUS_FAIL:
        return False, raw
    return False, None


def token_from_slug(slug: str | None) -> str | None:
    """The token is the part after the last `_` of the URL's last path segment.

    The name before it is only for readable logs and is ignored, so renaming a
    guard keeps old URLs working, and a bare token works too (a token has no `_`).
    """
    if not slug:
        return None
    return slug.rpartition("_")[2] or None


def ping_path(name: str, token: str) -> str:
    """The endpoint path a sender calls: `<prefix><slug(name)>_<token>`.

    The name is only there to make sender configs and logs readable; a name that
    slugifies to nothing yields the bare-token form, which the view accepts too.
    """
    slug = slugify(name or "")
    return f"{HEARTBEAT_PATH}{slug}_{token}" if slug else f"{HEARTBEAT_PATH}{token}"


def ping_url(hass: HomeAssistant, name: str, config: dict) -> str | None:
    """The full ping URL of a guard (health `config`), or None if HA has no URL.

    The one builder behind the config flow's info step and the `heartbeat_url`
    service, so both always show the same URL. `prefer_external=False` is
    explicit: with SSL configured `get_url` would otherwise prefer the external
    URL, which contradicts `local_only`. Only a guard that accepts non-local
    callers may get an external/cloud URL.
    """
    try:
        base = get_url(
            hass,
            allow_external=not config.get(CONF_LOCAL_ONLY, DEFAULT_LOCAL_ONLY),
            prefer_external=False,
            allow_ip=True,
        )
    except NoURLAvailableError:
        return None  # callers fall back to the path (the user adds the address)
    return base.rstrip("/") + ping_path(name, config[CONF_TOKEN])


def token_fp(token: str) -> str:
    """Fingerprint of a token (first 12 hex of SHA-256) — safe to store and compare."""
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def _ts(state: dict, key: str) -> datetime | None:
    """A stored timestamp (ISO string, or a datetime) as an aware datetime."""
    value = state.get(key)
    if isinstance(value, datetime):
        return value
    return dt_util.parse_datetime(value) if value else None


def apply_ping(state: dict, ok: bool, code: str | None, now: datetime) -> dict:
    """Return the state after a ping received at `now` (input left untouched).

    A success clears the code; a failure keeps `last_ok` (the deadline basis) so
    the next success simply makes the guard OK again, as on healthchecks.io.
    """
    new = dict(state)
    new["last_ping"] = now.isoformat()
    if ok:
        new["last_ok"] = now.isoformat()
        new["last_status"] = STATUS_OK
        new["last_code"] = None
    else:
        new["last_status"] = STATUS_FAIL
        new["last_code"] = code
    return new


def reconcile_token(state: dict, token: str, now: datetime) -> tuple[dict, bool]:
    """Match stored state against the configured token by fingerprint.

    A missing or different `token_fp` means the state belongs to another token
    (new guard, regenerated token, type switch): start over — armed now, no pings —
    and report True so the caller also drops verdicts judged under the old one.
    """
    fp = token_fp(token)
    if state.get("token_fp") == fp:
        return state, False
    new = {key: value for key, value in state.items() if key not in _RESET_KEYS}
    new.update(dict.fromkeys(_RESET_KEYS))
    new["armed_at"] = now.isoformat()
    new["token_fp"] = fp
    return new, True


def period_of(config: dict) -> int:
    """The expected interval between two successes, in seconds.

    Only `period` is read: a `grace` left in stored dev data (from before the grace
    became the engine's debounce) is ignored rather than rejected.
    """
    return int(config.get(CONF_PERIOD, DEFAULT_PERIOD))


def next_deadline(state: dict, config: dict) -> datetime | None:
    """When the guard turns overdue: basis + period, basis = last_ok or armed_at.

    None when no deadline applies: a failure is UNHEALTHY regardless of time, and
    without any basis there is nothing to count from.
    """
    if state.get("last_status") == STATUS_FAIL:
        return None
    basis = _ts(state, "last_ok") or _ts(state, "armed_at")
    if basis is None:
        return None
    return basis + timedelta(seconds=period_of(config))


def evaluate(
    state: dict, config: dict, now: datetime
) -> tuple[Health, tuple[str, dict] | None]:
    """Verdict + detail from (state, config, now); first matching row wins.

    1. last ping failed               -> UNHEALTHY, heartbeat_failed (code)
    2. no success yet, deadline ahead -> UNKNOWN,   heartbeat_waiting
    3. no success yet, deadline past  -> UNHEALTHY, heartbeat_never (since armed)
    4. now > deadline                 -> UNHEALTHY, heartbeat_overdue (since, period)
    5. otherwise                      -> OK, no detail

    There is no startup grace: after an HA restart the same arithmetic applies, so
    a guard overdue before the restart is overdue after it (the engine then waits
    out the rest of its debounce, counted from the deadline, so a sender's retry
    within it can still clear it silently).
    """
    if state.get("last_status") == STATUS_FAIL:
        return Health.UNHEALTHY, ("heartbeat_failed", {"code": state.get("last_code")})
    last_ok = _ts(state, "last_ok")
    deadline = next_deadline(state, config)
    if deadline is None:
        # No basis at all (state never armed) — nothing to judge yet.
        return Health.UNKNOWN, ("heartbeat_waiting", {})
    if last_ok is None:
        if now > deadline:
            armed_at = _ts(state, "armed_at") or now
            since = int((now - armed_at).total_seconds())
            return Health.UNHEALTHY, ("heartbeat_never", {"since": since})
        return Health.UNKNOWN, ("heartbeat_waiting", {})
    if now > deadline:
        since = int((now - last_ok).total_seconds())
        return Health.UNHEALTHY, (
            "heartbeat_overdue",
            {"since": since, "period": period_of(config)},
        )
    return Health.OK, None


# ---------------- the source ----------------


class HeartbeatHealth(HealthSource):
    """Period over pings delivered by the heartbeat endpoint (grace = debounce)."""

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        """Start armed now; `restore()` replaces this with the stored state."""
        super().__init__(hass, config)
        self._state, _ = reconcile_token({}, self.token, dt_util.utcnow())
        # A fresh state must reach the Store (armed_at), so it starts dirty and is
        # flushed as soon as the engine binds its save callback.
        self._dirty = True
        self._save: Callable[[], None] | None = None
        self._on_change: CALLBACK_TYPE | None = None
        self._unsub_timer: CALLBACK_TYPE | None = None
        # Open only between async_setup and its unsub. A ping racing a reload must
        # not touch a stopped source: it would arm a timer nobody cancels and call
        # the dead engine's on_change. The view turns the refusal into a 503.
        self._closed = True

    # ---- identity ----
    @property
    def token(self) -> str:
        """The secret token (never log/expose it in full)."""
        return self.config[CONF_TOKEN]

    @property
    def local_only(self) -> bool:
        """Accept pings only from private/loopback addresses."""
        return bool(self.config.get(CONF_LOCAL_ONLY, DEFAULT_LOCAL_ONLY))

    @property
    def period(self) -> int:
        """Expected interval between two successes, in seconds."""
        return period_of(self.config)

    @property
    def watched_entities(self) -> list[str]:
        """No entity dependency — pings arrive over HTTP, the timer is our own."""
        return []

    # ---- verdict ----
    def evaluate(self) -> Health:
        """Current verdict from the stored pings and the deadline."""
        return evaluate(self._state, self.config, dt_util.utcnow())[0]

    def detail(self) -> tuple[str, dict] | None:
        """Reason for the current verdict (incl. `heartbeat_waiting` while blind)."""
        return evaluate(self._state, self.config, dt_util.utcnow())[1]

    def confirmed(self) -> bool:
        """True while the last ping reported a failure.

        The sender said outright that the job failed, so there is nothing to wait
        out. A missed ping is different: the job may only be late, which is what
        the debounce (the grace) absorbs.
        """
        return self._state.get("last_status") == STATUS_FAIL

    def fault_since(self) -> datetime | None:
        """The passed deadline while overdue (also "never succeeded"), else None.

        Derived from the stored state alone, so it is the same before and after a
        reload or HA restart: the grace (the engine's debounce) counts from the
        deadline and an alarm cannot be postponed by restarting it. After a
        failure ping there is no deadline, and `confirmed()` skips the debounce
        anyway. Strict like `evaluate()`: on the deadline itself it is not overdue.
        """
        deadline = next_deadline(self._state, self.config)
        if deadline is None or dt_util.utcnow() <= deadline:
            return None
        return deadline

    @property
    def state(self) -> dict:
        """A copy of the current source state (for entities/diagnostics)."""
        return dict(self._state)

    def next_due(self) -> datetime | None:
        """The current deadline, basis + period (None after a failure ping)."""
        return next_deadline(self._state, self.config)

    # ---- persistence ----
    def snapshot(self) -> dict:
        """JSON-ready source state for the Store."""
        return dict(self._state)

    def restore(self, data: dict) -> bool:
        """Adopt stored state; True if it was for another token (state reset).

        A reset is saved right away (or as soon as the save callback is bound) so
        the new `armed_at` survives a restart before the next ping.
        """
        self._state, changed = reconcile_token(
            dict(data or {}), self.token, dt_util.utcnow()
        )
        self._dirty = changed
        if changed:
            self._persist()
        return changed

    def bind_persist(self, save: Callable[[], None]) -> None:
        """Keep the engine's save callback; flush a pending reset/fresh state."""
        self._save = save
        if self._dirty:
            self._persist()

    def _persist(self) -> None:
        if self._save is None:
            self._dirty = True
            return
        self._dirty = False
        self._save()

    # ---- lifecycle ----
    async def async_setup(self, on_change: CALLBACK_TYPE) -> CALLBACK_TYPE | None:
        """Route our token to us (active) and arm the deadline timer."""
        registry = HeartbeatRegistry.get(self.hass)
        self._on_change = on_change
        self._closed = False
        registry.activate(self.token, self)
        self._arm()

        @callback
        def _unsub() -> None:
            self._closed = True
            self._cancel_timer()
            registry.deactivate(self.token, self)

        return _unsub

    async def async_handle_ping(self, ok: bool, code: str | None) -> Health:
        """Apply a ping, re-arm, save, notify the engine; return the new verdict.

        Raises HeartbeatClosedError when the source is stopped (the view answers
        503, the sender retries and the next source gets the ping). Nothing here
        awaits, so the closed check and the state change cannot interleave with an
        unsub.
        """
        if self._closed:
            raise HeartbeatClosedError
        self._state = apply_ping(self._state, ok, code, dt_util.utcnow())
        self._arm()
        self._persist()
        if self._on_change is not None:
            self._on_change()
        return self.evaluate()

    def _arm(self) -> None:
        """(Re-)arm the timer for the next deadline, if it lies in the future."""
        self._cancel_timer()
        if self._closed:
            return
        deadline = next_deadline(self._state, self.config)
        if deadline is None:
            return
        fire_at = deadline + _TIMER_MARGIN
        if fire_at <= dt_util.utcnow():
            return
        self._unsub_timer = async_track_point_in_utc_time(
            self.hass, self._deadline_passed, fire_at
        )

    @callback
    def _deadline_passed(self, _now: datetime) -> None:
        self._unsub_timer = None
        if self._closed:
            return
        if self._on_change is not None:
            self._on_change()
        self._arm()

    def _cancel_timer(self) -> None:
        if self._unsub_timer is not None:
            self._unsub_timer()
            self._unsub_timer = None

    def describe(self) -> str:
        """Only the type — the token is a secret and must not reach diagnostics."""
        return "heartbeat"


def require_heartbeat(health: HealthSource, entity_id: str) -> HeartbeatHealth:
    """The guard's source if it is a heartbeat source, else a service error.

    Shared by the `heartbeat_url` and `heartbeat_ping` services: a state or
    template guard has neither a URL nor pings.
    """
    if not isinstance(health, HeartbeatHealth):
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="not_a_heartbeat_guard",
            translation_placeholders={"entity_id": entity_id},
        )
    return health
