---
name: necromancer
description: >
  Necromancer, the Home Assistant custom integration that watches devices and jobs and repairs
  them (self-healing guards, heartbeat URLs for jobs outside Home Assistant). Load this whenever
  a request touches Necromancer or its entities: a guard and its status (ok, suspect, blind,
  recovering, verify, cooldown, escalated, snoozed), the necromancer.* actions, automations or
  dashboards on sensor.*_status / event.*_recovery, creating or changing a guard, a heartbeat
  guard or its ping URL, a recovery action, PoE port repair, or why a guard did or did not react.
license: MIT
metadata:
  integration: necromancer
  docs: https://github.com/MrTomRocker/homeassistant-necromancer
---

# Necromancer

Necromancer is a Home Assistant custom integration (domain `necromancer`). Each **guard** pairs
one health signal with one recovery and runs both through a fixed lifecycle: detect, wait
(debounce), recover, verify, cool down, or escalate. A guard can also just notify.

Use the Home Assistant API through your tools. If you have no tool for a step, tell the user what
to do in the UI. Read the matching reference before you act:

| Task | Read |
|---|---|
| Design or create a guard, change its settings, pick a strategy for a use case | [references/creating-guards.md](references/creating-guards.md) |
| A guard did or did not react, is stuck, escalated, blind; a sender gets an error | [references/troubleshooting.md](references/troubleshooting.md) |

## First: find the guard and read it

- **Guards are found by their status sensor.** Every guard has one enum sensor of the
  `necromancer` integration whose entity ID ends in `_status`. Its attribute `guard_name` is the
  guard's name. Search the integration's entities. Don't build entity IDs from the name.
- **Other entity IDs depend on the language** Home Assistant had when the guard was created. A
  German install has `switch.<guard>_auto_reparatur`, `button.<guard>_reparieren`,
  `event.<guard>_wiederbelebung` and `sensor.<guard>_letztes_lebenszeichen` instead of
  `_auto_recovery`, `_revive`, `_recovery` and `_last_heartbeat`. Read them from the status
  sensor's attributes `health_entity` (always set), `auto_recovery_entity`, `revive_entity` and
  `recovery_event_entity`. The last three are `null` for a notify-only guard, which has no
  switch, button or event entity. The *Last heartbeat* sensor has no such attribute: find it on
  the guard's device.
- **Why is it in this state?** Read the status sensor's `health_type` (`entity_state`,
  `template` or `heartbeat`), `health_detail` (the reason in words), `attempt`,
  `last_recover_driver_result` (`good` / `failed`), `snooze_until`, and for heartbeat guards
  `last_status`, `last_code` and `awaiting_first_success`. Check **Settings → Repairs** for
  config problems.

## States of `sensor.<guard>_status`

| State | Meaning |
|---|---|
| `ok` | healthy, watching |
| `suspect` | unhealthy, waiting out the debounce; a blip clears silently |
| `blind` | health unknown: the source entity or attribute is missing, `unavailable`/`unknown`, matches neither value list, or the template doesn't render true/false. Also a new heartbeat guard in its first period. Not a fault, nothing is repaired |
| `recovering` | the recovery is running |
| `verify` | waiting up to the boot window for health to come back |
| `cooldown` | recovered, short pause |
| `escalated` | needs a human: attempts used up, recovery blocked, auto-recovery off, a linked repair failed, or a notify-only guard found a problem. Clears itself to `ok` when health returns |
| `snoozed` | suspended by `necromancer.snooze`, resumes at `snooze_until` |

An unknown verdict is never a fault. Exception by design: an entity-state guard that lists
`unavailable` or `unknown` among its unhealthy (off) values treats that state as a fault.

## Creating and changing guards

There is one Necromancer config entry; each guard is a **config subentry** of it. There is no
YAML configuration; never edit `.storage`. Details and the flow steps:
[references/creating-guards.md](references/creating-guards.md).

- **Saving any guard (add, reconfigure, remove) reloads the whole integration.** Every guard
  restarts and a running recovery on any guard is cancelled; a power-cycle cut off between off
  and on can leave a switch off. Before saving, check that no status sensor is `recovering` or
  `verify`.
- **Linked guards** share one repair: one leads, the others wait and re-check. Only guards with
  a recovery strategy can be linked, not notify-only or heartbeat guards.

## Actions

Targeted actions take the guard's status sensor, its device or an area in `target:`. Actions
with a `guard` field take the status sensor's entity ID **in `data`**.

| Action | Use | Notes |
|---|---|---|
| `necromancer.reset` | clear an `escalated` guard and re-check | does nothing unless `escalated`. Still unhealthy → `suspect`, then the debounce, then a recovery only if auto-recovery is on. Not for a lost heartbeat (use `heartbeat_ping`). To repair right now, press the revive button |
| `necromancer.snooze` / `unsnooze` | planned maintenance for one guard | `data.duration` like `"00:30:00"`; refused while a recovery runs |
| `necromancer.snooze_all` / `unsnooze_all` | maintenance mode for every guard | no target; guards mid-recovery are skipped |
| `necromancer.notify_guard` | send a custom text through the guard's notify action | `message`, optional `event` (default `custom`), `event_text`, `attempt`, `max` |
| `necromancer.check_health` | health right now | `data.guard`; returns `{health: ok / unhealthy / unknown}` |
| `necromancer.wait_for_health` | wait until healthy, e.g. between recovery stages | `data.guard`, `timeout` (s, default boot window), `check_first`; returns `{health, timed_out, waited_s}` |
| `necromancer.heartbeat_ping` | record a successful heartbeat by hand | target a heartbeat guard; for a ping that got lost although the job ran |
| `necromancer.heartbeat_url` | the ping URL for a deploy script | heartbeat guards only, **admin only**; `data.guard`; returns `{url, path}`. **Both contain the token**: never print either. `url` is `null` when HA has no URL of its own; then the sender needs `http://<ha-ip>:8123` + `path` |
| `necromancer.repair_poe_port` | power-cycle whatever is on a device's PoE port | `data.id` = MAC, IP or static label; blocks until done. Returns nothing and doesn't fail when no port or several ports match; it only logs. Check the log before you say it worked |

`check_health`, `wait_for_health` and `heartbeat_url` only return data: always request the
response (`return_response: true` through the API, `response_variable:` in a script), or Home
Assistant rejects the call.

**Revive button:** recovers now, bypassing the debounce and the auto-recovery switch, and lifts
a snooze. It is ignored while the guard is already recovering (`recovering` / `verify`) or
following a linked repair, so check the status before and after. **Auto-recovery switch:** arm
or disarm automatic repair. Notify-only guards have neither.

## Automations

**Alert on every escalation:** a state trigger on the status sensor `to: escalated`. This is the
only trigger that covers all causes, including auto-recovery off, notify-only guards and failed
linked repairs.

```yaml
triggers:
  - trigger: state
    entity_id: sensor.hue_bridge_status
    to: escalated
actions:
  - action: notify.mobile_app_phone
    data:
      message: "{{ state_attr('sensor.hue_bridge_status', 'guard_name') }} needs attention."
```

**Back to normal:** a state trigger `from: escalated` `to: ok`. There is no separate event.

**Outcome of a recovery cycle:** `event.received` on the recovery event entity (read it from
`recovery_event_entity`) with `options: {event_type: [...]}`. Types: `recovered`, `escalated`
(attempts used up), `blocked` (the recovery could not start: missing action or switch, PoE port
not found; a config problem). It does not fire when the guard escalates without trying.

**The guard's notify action** gets `message`, `name`, `event_text`, `event`, `attempt`, `max`,
`attempts`, `reason`, `health_detail`; unused ones are `""`. For built-in alerts `event` is
`problem_detected`, `recovery_attempt`, `recovery_success`, `recovery_failed`,
`recovery_blocked`, `no_auto_recovery` or `linked_repair_failed`, and `message` is
"<name>: <event_text>". For `necromancer.notify_guard` `event` is the caller's value and
`message` is the caller's text without the name, so a notify action that branches on `event`
needs a default branch.

**A recovery action** (strategies *Run an action*, *Off/on actions*) gets `attempt`, `max`,
`name` and `guard_entity_id`. It can report via `necromancer.notify_guard`
(`target: {entity_id: "{{ guard_entity_id }}"}`) and verify between stages with
`necromancer.wait_for_health` (`data: {guard: "{{ guard_entity_id }}"}`,
`response_variable: result`, then check `result.timed_out`). A `variables:` step
`recover_failed: true` reports a failed repair; it decides the outcome only when the guard's
Health Check is off. With the Health Check on (default), health within the boot window decides.
Variables set in the off action are readable in the on action.

## Heartbeat guards

For jobs outside Home Assistant (backups, cron, systemd, NAS or Windows tasks). The job sends
`POST` to `http://<ha-ip>:8123/api/necromancer/heartbeat/<name>_<token>`, optionally with
`?status=<s>`. No status, `ok` or `0` is success, anything else is a failure (the code shows in
the alert).

- **The token is the only secret.** Its one place is the sender host's environment (see *Deploy
  a sender*). Never print the URL or path, never write it into an automation, script, dashboard,
  git repo or chat, and never put it on a command line. Use `necromancer.heartbeat_url` only when
  the user asks for it. If it leaked: reconfigure the guard and tick *Generate a new token*.
- **Timing:** the deadline is last success + **period**; before the first success (new guard,
  or a regenerated token) it counts from setup or regeneration. After the deadline the guard is
  `suspect` for the **grace**, which is the debounce (default 1 h), then it reacts. A failure
  ping reacts at once, and there is no deadline until the next success. The *Last heartbeat*
  sensor has `next_due` (`null` after a failure ping), `period` and `grace`.
- **A new guard** (or one with a regenerated token) is `blind` for at most one period. With no
  success by then it turns `suspect` ("Never reported success").
- **A ping got lost** although the job ran: `necromancer.heartbeat_ping`. `reset` doesn't help,
  the heartbeat would still be overdue.
- **Sender answers:** `200` applied (`{"dormant": true}`: the guard's device is disabled, the
  ping is stored but not evaluated); `404` wrong or regenerated token, or Necromancer not loaded;
  `403` not a local address while *Local network only* is on (use Home Assistant's IPv4
  address); `405` the sender used `GET`; `429` more than 5 pings in 10 s; `503` the guard isn't
  running (Necromancer starting or reloading; if it persists, check Repairs and the logs).
- A guard inside Home Assistant can't report that Home Assistant itself is down.

### Deploy a sender

Don't write your own `curl` call: use a ready-made sender. They retry for about 10 minutes while
Home Assistant restarts, stop at once on `400`/`403`, never follow redirects and read the URL from
the `HEARTBEAT_URL` environment variable.

| Host | Sender | Needs |
|---|---|---|
| Linux, macOS, NAS (cron, Synology, systemd) | `ping.sh` | bash, curl |
| anything with Python | `ping.py` | Python 3.8+ |
| anything with Node.js | `ping.cjs` (keep the `.cjs` name) | Node.js 18+ |
| Windows (Task Scheduler) | `ping.ps1` | Windows PowerShell 5.1 or PowerShell 7 |

1. **Get it** from `https://raw.githubusercontent.com/MrTomRocker/homeassistant-necromancer/main/docs/examples/heartbeat/<file>`
   and read it. Copy it to the host (e.g. `/usr/local/bin/ping.sh`, `chmod 755`) and call it by
   its full path. Don't edit the URL into it.
2. **Put the URL in the host's environment**, readable only by the job's user, as
   `HEARTBEAT_URL=http://<ha-ipv4>:8123/api/necromancer/heartbeat/<name>_<token>` (Home
   Assistant's IPv4 address, not a host name):
   - Linux/NAS: an env file with mode 600, loaded with `set -a; . <file>; set +a` (systemd:
     `EnvironmentFile=`). A plain `. <file>` doesn't export it and the sender exits 1.
   - Windows: a **user** environment variable of the task's account (a system variable is
     readable by every local user), set by the user in System Properties, not with `setx`.
   - **Best: ask the user to paste the URL** into that file or variable. If they want you to do
     it, use a shell pipe, never a tool or MCP call whose result you see: call
     `POST /api/services/necromancer/heartbeat_url?return_response` with `{"guard": "<status
     sensor>"}` (an admin token, passed to curl on stdin or from a file, never as an argument),
     build the line with `jq -r '"HEARTBEAT_URL=http://<ha-ipv4>:8123" + .service_response.path'`
     (`path`, not `url`: `url` can be a host name or `null`) and write it with `umask 077` into the
     file on the host. Check it with `grep -c '^HEARTBEAT_URL=http' <file>`, never `cat`.
3. **Call it as the job's last step** with the job's exit code:
   `/usr/local/bin/backup.sh; /usr/local/bin/ping.sh $?` (PowerShell: a wrapper with
   `& "$PSScriptRoot\ping.ps1" $LASTEXITCODE`). Its retries can block for up to 10 minutes; under
   systemd hand it to a transient unit. Exit codes: `0` delivered, `1` refused, `2` gave up.
4. **Test it:** run the sender once by hand with the env file loaded
   (`sh -c 'set -a; . <file>; set +a; exec /usr/local/bin/ping.sh'`, never `HEARTBEAT_URL=… ping.sh`)
   and check that the guard leaves `blind` and `last_status` reads `ok`. On a notify-only guard,
   `ping.sh fail` must then alert and the next `ping.sh` clears it. On a guard with a recovery, a
   failure ping starts the repair at once: test `fail` only with the user's OK.

Ready setups for crontab, Synology, systemd and Windows Task Scheduler (`-ExecutionPolicy Bypass`,
a wrapper with `$PSScriptRoot` and `exit $LASTEXITCODE`):
[job heartbeat recipe](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/job-heartbeat.md#send-the-ping)
and [senders README](https://github.com/MrTomRocker/homeassistant-necromancer/tree/main/docs/examples/heartbeat).

## Turning a guard off

| Goal | Do |
|---|---|
| quiet for planned work | `necromancer.snooze` (auto-resumes) |
| never repair, still alarm | turn off the auto-recovery switch; the guard still turns `escalated` and runs its notify action (`no_auto_recovery`), but the recovery event doesn't fire |
| off completely | disable the guard's **device** (reversible, keeps its counters) |

Disabling single entities of a guard does not turn it off.

## Docs

- README (all features): https://github.com/MrTomRocker/homeassistant-necromancer#readme
- Cookbook (ready-made guards): https://github.com/MrTomRocker/homeassistant-necromancer/tree/main/docs/cookbook
- State machine and internals: https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/arch/architecture.md
