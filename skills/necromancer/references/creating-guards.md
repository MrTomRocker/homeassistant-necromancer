# Creating guards

How to design a guard with the user and create it through the Home Assistant API. Entities,
states and actions are in SKILL.md. Recipes: https://github.com/MrTomRocker/homeassistant-necromancer/tree/main/docs/cookbook

**Always confirm the design with the user before you create anything**: Health Source, strategy,
the recovery itself, timing and the notify action.

## Part 1: Pick the design

| The user wants | Health Source | Strategy | Key timing | Recipe |
|---|---|---|---|---|
| a device that drops off the network | entity state: ping or reachability sensor, on `on`, off `off` | power-cycle a switch, Auto-PoE, or notify only | debounce 120 s; boot window = full boot | [README](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#health-sources) |
| a device that is online but idle (inverter at 0 W in full sun) | template that is `false` only when it should work and doesn't | notify only | long debounce (900 s) against clouds, dusk | [inverter-sun-check](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/inverter-sun-check.md) |
| data that stopped updating (Node-RED, MQTT, scrape) | template: `{{ (now() - states.sensor.x.last_reported) < timedelta(minutes=15) }}` | notify only, or run an action (redeploy) | debounce 120 s; boot window = time to write again | [nodered-heartbeat](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/nodered-heartbeat.md) |
| a bridge or hub whose lamps go `unavailable` | template counting unavailable lamps (one dead bulb is fine), plus a ping guard | run an action (`necromancer.repair_poe_port`, wait, reload the integration) | debounce 480 s, boot window 180 s, same on both guards | [bridge-belt-and-braces](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/bridge-belt-and-braces.md) |
| a hung PoE access point, camera or phone | template on the device's state, with gates (firmware update, controller down) | Auto-PoE, `expected_id` = MAC, IP or static label | debounce 600 s, boot window 300 s | [poe-access-point](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/poe-access-point.md) |
| a container, add-on or service | template on its health | run an action: soft restart, `wait_template`, then hard restart | debounce 180-300 s, boot window 240 s, max attempts 1-2 | [escalating-recovery](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/escalating-recovery.md) |
| a device on a smart plug (Pi, modem) | entity state (ping) | power-cycle a switch (the plug) | off/on delay 5-15 s; boot window = full boot | [README](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#recovery-strategies) |
| a pump with an interlocked device | template: switch on but power near zero | off/on actions; save state in the off action, restore it in the on action | long debounce and cooldown | [pool-pump-restart](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/pool-pump-restart.md), [chlorinator-restart](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/chlorinator-restart.md) |
| a device Home Assistant can't restart itself | template | run an action that pokes another system (MQTT, REST, SSH) | debounce 1200 s, boot window 300 s | [recover-via-another-system](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/recover-via-another-system.md) |
| a nightly backup, cron, NAS or Windows task | heartbeat: period = schedule (1 day, 7 days), grace = debounce (how late a run may be, e.g. 2 h) | notify only (the default), or run an action (wake the host, re-run a wrapper that also pings) | repair: Health Check on, boot window ≤ 1 h and ≥ job runtime, max attempts 1 | [job-heartbeat](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/job-heartbeat.md) |
| several guards with one root cause | one guard per signal, linked in `linked_guards` | the same recovery on each | identical timing | [bridge-belt-and-braces](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/bridge-belt-and-braces.md), [README](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#linked-guards-groups) |
| staged escalation | supervisor: template on other guards' `_status` (e.g. both `escalated`) | a heavier recovery | debounce longer than the guards it watches | [README](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#supervisor-guards-watch-other-guards), [verified-staged-recovery](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/verified-staged-recovery.md) |

### Rules of thumb

- **Keep the Health Check on** (default) unless the action is reliable and can't fail silently.
  With it off, a clean run counts as success and the boot window is not used; retries only
  happen when the recovery reports failure (`recover_failed: true`, or an Auto-PoE port that never comes back).
- **Boot window = the slowest comeback**: boot time plus the time until Home Assistant's entity
  reads healthy again (with *Restart device integration* on, it starts after the reload delay
  and the reload). Max 3600 s.
- **Debounce** longer than normal blips. A disruptive fix (a bridge reboot) gets a longer one.
- **Notify only** when the user prefers to fix things by hand, when no safe recovery exists, or
  when a job runs longer than 1 h (a repair could not be verified in the boot window).
- **`unavailable` in the off values** only when "the entity is gone" is the fault. By default
  `unavailable` / `unknown` read as unknown (`blind`) and trigger nothing, which is usually right.
- **Templates** return `true` / `false`. Point them at the device, never at the guard's own
  entities. Use `| float(<safe value>)` so a missing value doesn't read as a fault.
- **Never guard a device with a recovery that cuts its own lifeline.** Don't power-cycle the
  switch, PoE port or plug that Home Assistant, its network path or the plug's own hub depends on:
  the off runs, the on can't, the device stays off. Home Assistant itself can't be watched from
  inside Home Assistant; that needs a check outside it.
- **Auto-PoE** needs the PoE port list first (the entry's **Configure**, an options flow with the
  menu `add_port`, `edit_port`, `delete_port`, `import_ports`, `export_ports`, `save`).
  Exactly one port must match `expected_id` (with none, only the last-known port is used, and
  only if it now reports nothing connected), or recovery is blocked.

## Part 2: Create it through the API

There is one Necromancer config entry (domain `necromancer`). Each guard is a **config subentry**
of it with subentry type **`device`**. Add and reconfigure use the same steps. There is no YAML and
no other way; never edit `.storage`.

**Read the live form before you send anything.** Field keys, sections and options can change
between versions. Each flow response lists the form's fields, defaults and help texts; send
exactly those keys. The tables below describe the current code.

### Find the entry

| Goal | ha-mcp call |
|---|---|
| entry ID | `ha_get_integration(domain="necromancer")` |
| existing guards (subentry IDs, names) | `ha_get_integration(entry_id=E, include_subentries=True)` |
| first form of a new guard | `ha_get_integration(entry_id=E, include_subentry_schema=True, subentry_type="device")` |
| first form of a reconfigure | same, plus `subentry_id=S` |

No entry: Necromancer is installed but not set up. With the user's OK, add it with
`ha_set_integration(domain="necromancer")` (no fields). A second one aborts with
`already_configured`. A heartbeat guard's subentry data holds `health.token`: never quote it.

### Drive the flow

One call per step. The first call starts the flow, the next ones answer it with `flow_id`:

```
ha_config_set_helper(helper_type="config_subentry", entry_id=E, subentry_type="device")
ha_config_set_helper(helper_type="config_subentry", entry_id=E, subentry_type="device",
                     flow_id=F, config={...answers to the step shown...})
```

- Every step is a **form**; the guard flow has no menu step, so `menu_choice` is not used. (The
  PoE port options flow is a menu: `ha_set_integration(entry_id=E, menu_choice="add_port")`.)
- Fields inside a **section** are nested under the section key, e.g.
  `"behavior": {"debounce": 300}`. Send every section the form shows; `{}` takes its defaults.
- Go step by step: later forms depend on earlier answers. Nothing is saved before the last step.
  To cancel: `flow_id=F, abort=True`.
- A rejected form returns the error key and the flow stays open. Fix the field and resend.

### Steps in order

`user` (or `reconfigure`) → `device` → `strategy` → one of `switch` / `action` / `actions` /
`poe_port` / `notify` → `heartbeat_url` or `heartbeat_url_new` (heartbeat guards only) → saved.

**1. `user` / `reconfigure`:** `source_type` = `state_based` (an entity's state),
`template_based` (Jinja template) or `heartbeat_based` (ping URL). Default `state_based`, or the
stored type on reconfigure. Switching a heartbeat guard to another type kills its URL (404).

**2. `device`** (flat, no sections). `name` (required, unique) and `device_id` (optional: the Home
Assistant device this guard belongs to; it unlocks the reload section) always. The rest depends
on `source_type`:

| Source | Field | Meaning | Default |
|---|---|---|---|
| `state_based` | `entity_id` | entity that shows health | required |
| | `attribute` | attribute to read; empty = the state | empty |
| | `on_value` / `off_value` | lists of values for OK / faulty; anything else is unknown | `["on"]` / `["off"]` |
| `template_based` | `template` | Jinja; `true`/`on`/`1`/`yes` = OK, `false`/`off`/`0`/`no` = faulty, else unknown | required |
| `heartbeat_based` | `period` | how often the job succeeds; a duration `{"days": 1, "hours": 0, "minutes": 0, "seconds": 0}` | 1 day, min 1 min |
| | `local_only` | only private-network senders (others get 403) | `true` |
| | `regenerate_token` | reconfigure of a heartbeat guard only: new token, old URL 404s after saving | `false` |

The health picker hides only this guard's own entities, so a supervisor can pick other guards'.

**3. `strategy`:** `strategy` = `notify`, `switch`, `action`, `actions` or `poe_port`. Default
`switch`; `notify` for a new heartbeat guard; the stored strategy on reconfigure.

**4. The strategy's form.** Top-level fields first, then sections:

| Step | Own fields | Sections |
|---|---|---|
| `switch` | `switch_entity` (required; switch, input_boolean, light, fan, siren, humidifier, remote, media_player or group), `off_on_delay` (5 s, max 600) | behavior, reload, notification, linked_guards |
| `action` | — | `recovery_action`: `action` (an action sequence, script syntax), then behavior, reload, notification, linked_guards |
| `actions` | — | `recovery_action`: `off_action`, `on_action`, `off_on_delay` (5 s, max 600), then behavior, reload, notification, linked_guards |
| `poe_port` | `expected_id` (required: MAC, IP or static label of the device) | behavior, reload, notification, linked_guards |
| `notify` | `debounce` (120 s, 3600 s for heartbeat, max 86400) | notification |

| Section | Fields and defaults | Shown when |
|---|---|---|
| `behavior` | `debounce` 120 s (3600 s heartbeat, max 86400), `cooldown` 600 s (max 86400), `health_check` `true`, `boot_window` 180 s (max 3600), `max_attempts` 2 (1-10) | always (recovery steps) |
| `reload` | `reload_entry` `false`: reload the assigned device's integration after the repair; `reload_delay` 10 s (max 600): wait before the reload | `device_id` is set |
| `notification` | `notify_action`: optional action sequence; variables in SKILL.md | always |
| `linked_guards` | `linked_guards`: list of partner **subentry IDs** (options come from the form); `notify_follower_success` `false` | other recovery guards exist and this is not a heartbeat guard |

All times are seconds. Notify-only and heartbeat guards are never offered as link partners.
Linking is transitive; to leave a group, clear all partners.

**5. `heartbeat_url` / `heartbeat_url_new`** (heartbeat guards, on create *and* every
reconfigure). An empty form; `config={}` saves the guard. `heartbeat_url_new` is shown after
`regenerate_token`. The response carries the full URL with its token (in the description
placeholders and curl examples).

- **Never print, log, store or repeat that URL**, and don't pass it to another tool. Tell the user
  to copy it from the dialog in the Home Assistant UI (reconfigure the guard to see it again), or
  fetch it with `necromancer.heartbeat_url` only if they ask (see SKILL.md).
- Aborting here saves nothing: a new guard is not created, and a regenerated token is discarded
  (the old URL keeps working).
- Renaming a heartbeat guard keeps its URL working; only the token routes the ping.

### Validation errors

| Error key | Field | Meaning |
|---|---|---|
| `duplicate_name` | `name` | another guard has this name (ignores case and leading/trailing spaces) |
| `no_self_link` | `device_id` | a Necromancer guard device was picked; pick the real device |
| `period_too_short` | `period` | under 1 minute |
| `action_required` | `action`, `off_action`, `on_action` | a recovery without its action would only escalate |

Other errors come from Home Assistant's selectors (wrong type, value out of range, missing
required field). `already_configured` only comes from adding a second Necromancer entry.

### Reconfigure

`ha_config_set_helper(helper_type="config_subentry", entry_id=E, subentry_type="device",
subentry_id=S)` runs the same steps, starting at `reconfigure`, with the stored values as
defaults (a field you omit keeps the value the form shows). It ends with the abort reason
`reconfigure_successful`. Switching to or from heartbeat resets the debounce to the new type's
default. To leak-proof a heartbeat guard, set `regenerate_token: true` in the `device` step.

### After saving

Saving reloads the whole Necromancer entry: **every** guard restarts its watch and any running
recovery is cancelled. Don't save while a guard is `recovering` or `verify`. Counters, snooze and
`escalated` survive. Then find the new guard by its status sensor (see SKILL.md) and check it
reads `ok`, or `blind` for a heartbeat guard waiting for its first ping. A config problem shows in
**Settings → Repairs**.
