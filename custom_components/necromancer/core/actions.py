"""Run user-defined action sequences (script syntax) from the action selector.

The action selector stores its value raw, so before a `Script` can run it the
sequence needs the static schema (`cv.SCRIPT_SCHEMA`, which also normalises the
legacy `service` key to `action`) plus the async pass for dynamic actions
(device/condition/trigger). Shared by recovery drivers (blocking) and notify
(detached).
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script, async_validate_actions_config

from ..const import DOMAIN


async def async_validate(hass: HomeAssistant, action: list | dict | None) -> list:
    """Normalise + validate a raw action-selector value into a runnable sequence."""
    if not action:
        return []
    sequence = action if isinstance(action, list) else [action]
    return await async_validate_actions_config(hass, cv.SCRIPT_SCHEMA(sequence))


async def async_run(
    hass: HomeAssistant,
    action: list | dict | None,
    name: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate and run an action sequence, blocking until it finishes.

    Returns the script's final variable scope (including any set via a
    `variables:` action), so a caller can chain one run's variables into the
    next — e.g. `action_cycle` passing its off phase into its on phase. Empty
    dict when there is nothing to run or the run produced no result.
    """
    sequence = await async_validate(hass, action)
    if not sequence:
        return {}
    script = Script(hass, sequence, name, DOMAIN)
    result = await script.async_run(variables or {}, context=Context())
    if not result:
        return {}
    # `.variables` is the run's final scope; HA injects its run `context` there.
    # Carry only real variables forward, not the (stale) Context object.
    return {k: v for k, v in result.variables.items() if k != "context"}


def static_errors(action: list | dict | None) -> list[str]:
    """Sync, best-effort validation for startup config checks."""
    if not action:
        return []
    sequence = action if isinstance(action, list) else [action]
    try:
        cv.SCRIPT_SCHEMA(sequence)
    except vol.Invalid as err:
        return [f"invalid action: {err}"]
    return []


# Script services that act on scripts as a whole, not run one: `script.<name>`
# with one of these names is no script entity.
_SCRIPT_SERVICES = {"turn_on", "turn_off", "toggle", "reload"}
_OTHER_TARGETS = ("device_id", "area_id", "floor_id", "label_id")


def action_steps(action: list | dict | None) -> int:
    """Number of top-level steps in a raw action-selector value (0 when empty)."""
    if not action:
        return 0
    return len(action) if isinstance(action, list) else 1


def _entity_ids(value: Any) -> list[str] | None:
    """An `entity_id` value as a list; None when it is templated or not a string."""
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    out: list[str] = []
    for item in items:
        if not isinstance(item, str) or "{{" in item or "{%" in item:
            return None
        out += [part.strip() for part in item.split(",") if part.strip()]
    return out


def single_script(action: list | dict | None) -> str | None:
    """The script entity a recovery action runs, when it runs exactly one.

    True for a one-step sequence that is `script.<name>` (the script as its own
    service) or `script.turn_on` with exactly one script target (in `target`,
    `data` or the legacy top level). Anything else — several steps, templates,
    other services, a disabled step — is None: the cards then say "Action (n
    steps)" instead of naming a script. Static (config only), so it can be a
    status-sensor attribute without recorder churn.
    """
    if action_steps(action) != 1:
        return None
    step = action[0] if isinstance(action, list) else action
    if not isinstance(step, dict) or step.get("enabled") is False:
        return None
    service = step.get("action", step.get("service"))
    if not isinstance(service, str) or not service.startswith("script."):
        return None
    name = service.removeprefix("script.").strip()
    if not name or "{" in name:
        return None
    if name not in _SCRIPT_SERVICES:
        return f"script.{name}"
    if name != "turn_on":
        return None
    targets: list[str] = []
    for holder in (step, step.get("target"), step.get("data")):
        if not isinstance(holder, dict):
            continue
        # A device/area/label/floor target may expand to more scripts.
        if any(holder.get(key) for key in _OTHER_TARGETS):
            return None
        if "entity_id" in holder:
            ids = _entity_ids(holder["entity_id"])
            if ids is None:
                return None
            targets += ids
    scripts = set(targets)
    if len(scripts) != 1:
        return None
    (entity_id,) = scripts
    return entity_id if entity_id.startswith("script.") else None
