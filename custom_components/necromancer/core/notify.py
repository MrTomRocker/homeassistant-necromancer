"""Notification helper — resolve a message and run the user's action.

Kept out of the engine so the state machine stays focused. Log lines stay
English; the user-facing text comes from `NOTIFY_MESSAGES` (picked by the
instance language, English fallback).

Delivery is a user-defined action sequence (script syntax) rather than fixed
notify entities: the user decides whether and how to notify. The resolved text and
context are exposed to the sequence as variables so the user can either take the
ready-made `message` or compose their own from the parts:
  - `message`    — the full line, "<name>: <event_text>"
  - `name`       — the guard name
  - `event_text` — the localized event text without the name (e.g. "Reparatur erfolgreich.")
  - `event`      — the notify key (e.g. "recovery_success")
  - plus event params: `attempt`, `max`, `attempts` (plural-correct), `reason`
  - `health_detail` — why the source judged as it did ("" if it has no detail),
    from `DETAIL_MESSAGES`; also appended to `message`/`event_text` as a second
    sentence. Its own placeholders are rendered here, never exposed as variables.
The sequence runs detached so a user delay never stalls the engine.
"""

from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant

from ..const import DETAIL_CODE_PHRASES, DETAIL_MESSAGES, NOTIFY_MESSAGES
from .actions import async_run

LOGGER = logging.getLogger(__name__)

# Optional alert variables default to "" so a notify action template can reference
# them (`{{ attempt }}`) without an undefined-variable error when they don't apply.
_OPTIONAL_DEFAULTS = {
    "attempt": "",
    "max": "",
    "attempts": "",
    "reason": "",
    "health_detail": "",
}

# Spoken duration units: (seconds per unit, de forms, en forms). German forms are
# (singular, plural nominative/accusative, plural dative): "alle 7 Tage" but
# "seit 3 Tagen"; minutes and hours do not inflect.
_DURATION_UNITS = {
    "minute": (60, ("Minute", "Minuten", "Minuten"), ("minute", "minutes")),
    "hour": (3600, ("Stunde", "Stunden", "Stunden"), ("hour", "hours")),
    "day": (86400, ("Tag", "Tage", "Tagen"), ("day", "days")),
}


def _lang(hass: HomeAssistant) -> str:
    """The instance language as a bare code ("de-CH" -> "de")."""
    return (hass.config.language or "en").split("-")[0]


def _add_attempts(lang: str, params: dict) -> None:
    """Add a localized, plural-correct `attempts` phrase when `attempt` is present.

    Keeps messages TTS-friendly ("1 Versuch" / "3 Versuche", not "1 Versuchen").
    """
    if "attempt" in params:
        n = params["attempt"]
        if lang == "de":
            params["attempts"] = f"{n} Versuch" if n == 1 else f"{n} Versuche"
        else:
            params["attempts"] = f"{n} attempt" if n == 1 else f"{n} attempts"


def _format_duration(lang: str, seconds: float, *, dative: bool = False) -> str:
    """A TTS-friendly duration: minutes under 2 h, hours under 2 days, else days.

    Rounded to the unit, at least 1. German needs the case of the preposition in
    front of it: `dative` for "seit"/"vor" ("seit 3 Tagen", "vor 1 Tag"), the
    default accusative for "alle" ("alle 7 Tage"). Like `_add_attempts`.
    """
    seconds = max(float(seconds), 0.0)
    if seconds < 2 * 3600:
        unit = "minute"
    elif seconds < 2 * 86400:
        unit = "hour"
    else:
        unit = "day"
    size, de_forms, en_forms = _DURATION_UNITS[unit]
    n = max(round(seconds / size), 1)
    if lang == "de":
        word = de_forms[0] if n == 1 else de_forms[2 if dative else 1]
    else:
        word = en_forms[0] if n == 1 else en_forms[1]
    return f"{n} {word}"


def render_detail(lang: str, detail: tuple[str, dict] | None) -> str:
    """Plain text for a `HealthSource.detail()` result ("" when there is none).

    Raw params become spoken text here: `since` (seconds, after "seit"/"vor" ->
    dative), `period` (seconds, after "alle" -> accusative) and `code` (the raw
    `last_code`: digits are an exit code, anything else a code word, None adds
    nothing). An unknown key or a broken template yields "" rather than a half
    sentence in an alarm.
    """
    if not detail:
        return ""
    key, raw = detail
    if lang not in DETAIL_MESSAGES:
        lang = "en"
    template = DETAIL_MESSAGES[lang].get(key)
    if template is None:
        return ""
    params: dict[str, str] = {}
    if "since" in raw:
        params["since"] = _format_duration(lang, raw["since"], dative=True)
    if "period" in raw:
        params["period"] = _format_duration(lang, raw["period"])
    code = raw.get("code")
    if code:
        phrase = DETAIL_CODE_PHRASES[lang]["exit" if str(code).isdigit() else "word"]
        params["code"] = phrase.format(code=code)
    else:
        params["code"] = ""
    try:
        return template.format(**params)
    except (KeyError, IndexError, ValueError):
        return ""


def detail_text(hass: HomeAssistant, detail: tuple[str, dict] | None) -> str:
    """`render_detail` in the instance language (what the engine stores/sends)."""
    return render_detail(_lang(hass), detail)


def _resolve(lang: str, name: str, key: str, params: dict) -> tuple[str, str]:
    """Return (message, event_text) for `key` in `lang` (adds the `attempts` phrase).

    A non-empty `health_detail` is appended as a second sentence; the `event` key
    itself stays unchanged, so automations branching on it see no difference.
    """
    messages = NOTIFY_MESSAGES.get(lang, NOTIFY_MESSAGES["en"])
    template = messages.get(key) or NOTIFY_MESSAGES["en"].get(key, key)
    _add_attempts(lang, params)
    # German needs the dative after "nach" ("nach 2 Versuchen"); the `attempts`
    # action variable keeps the plain form, so this stays a template-only key.
    fmt = dict(params)
    if "attempt" in params:
        n = params["attempt"]
        fmt["attempts_dative"] = (
            (f"{n} Versuch" if n == 1 else f"{n} Versuchen")
            if lang == "de"
            else params["attempts"]
        )
    try:
        event_text = template.format(name=name, **fmt)
    except (KeyError, IndexError):
        event_text = key
    if detail := params.get("health_detail"):
        event_text = f"{event_text} {detail}"
    return f"{name}: {event_text}", event_text


async def async_notify(
    hass: HomeAssistant,
    name: str,
    action: list | dict | None,
    key: str,
    **params: object,
) -> None:
    """Resolve the message for `key` in the active language and run the action."""
    lang = _lang(hass)
    message, event_text = _resolve(lang, name, key, params)
    LOGGER.debug("Notify %s: %s", name, message)

    if not action:
        return
    _dispatch(
        hass,
        name,
        action,
        {
            **_OPTIONAL_DEFAULTS,
            **params,
            "message": message,
            "name": name,
            "event_text": event_text,
            "event": key,
        },
    )


def _dispatch(
    hass: HomeAssistant, name: str, action: list | dict, variables: dict
) -> None:
    """Run the notify action detached so a user delay never stalls the engine."""

    async def _run() -> None:
        try:
            await async_run(hass, action, f"{name} notify", variables)
        except vol.Invalid as err:
            LOGGER.error("Notify action invalid for %s: %s", name, err)
        except Exception:
            LOGGER.exception("Notify action failed for %s", name)

    hass.async_create_task(_run(), f"necromancer notify {name}")


async def async_notify_custom(
    hass: HomeAssistant,
    name: str,
    action: list | dict | None,
    message: str,
    event: str = "custom",
    event_text: str | None = None,
    **params: object,
) -> None:
    """Run the guard's notify action with a caller-supplied message.

    Unlike `async_notify`, the text is not resolved from `NOTIFY_MESSAGES` — the
    caller provides it (e.g. a recovery script reporting progress via the
    `necromancer.notify_guard` service). The same variables a built-in alert exposes
    are passed (`message`, `name`, `event_text`, `event`, plus optional `attempt` /
    `max` / `attempts` / `reason` / `health_detail`), so an existing notify action
    template works unchanged. `event_text` defaults to `message` when omitted.
    """
    LOGGER.debug("Notify (custom) %s: %s", name, message)
    if not action:
        return
    lang = _lang(hass)
    _add_attempts(lang, params)
    _dispatch(
        hass,
        name,
        action,
        {
            **_OPTIONAL_DEFAULTS,
            **params,
            "message": message,
            "name": name,
            "event_text": message if event_text is None else event_text,
            "event": event,
        },
    )
