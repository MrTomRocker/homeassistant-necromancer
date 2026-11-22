# Troubleshooting a guard

How to find out why a guard did (or did not) do something. Read the guard first as described in
SKILL.md ("First: find the guard and read it"). States and actions are explained there too.

## Where to look

| Source | What it tells you |
|---|---|
| status sensor state and attributes | where the guard is now; `attempt`, `fail_count`, `last_fail`, `recover_count`, `last_recover`, `last_recover_driver_result`, `recover_driver` (what gets cycled, for Auto-PoE the resolved port) |
| status sensor history | the path it took, e.g. `ok → suspect → ok` (a blip) or `suspect → recovering → verify → escalated` |
| recovery event entity (logbook / history) | each outcome: `recovered` (`via_link`, `recover_count`), `escalated` or `blocked` (`attempt`, `reason`) |
| health binary sensor | `unavailable` while health is unknown; attribute `health_source` |
| `necromancer.check_health` | the verdict right now: `ok`, `unhealthy` or `unknown` |
| **Settings → Repairs** | config problems (see the table at the end) |
| Home Assistant log | the full story, see below |

The recovery event fires only for outcomes of a recovery cycle. A guard that escalates because
auto-recovery is off, because it is notify-only, or because a linked repair failed fires **no**
event. To catch every alarm, use a state trigger on the status sensor `to: escalated`.

**Logs.** Most lifecycle lines are `info`; Home Assistant shows only `warning` and above by
default. Turn on more detail without a restart with the action `logger.set_level`:

```yaml
action: logger.set_level
data:
  custom_components.necromancer: debug
```

Or in the UI: **Settings → Devices & services → Necromancer → Enable debug logging**. To keep it
across restarts: `custom_components.necromancer: debug` under `logger: logs:` in
`configuration.yaml`. Lines start with the guard's name:

| Line | Means |
|---|---|
| `<guard> unhealthy, waiting 120s (debounce)` | fault seen, debounce running |
| `<guard> recovery attempt 1/2 via …` | repair started |
| `<guard> recovery blocked: <reason>` | could not even try (`blocked`) |
| `<guard> could not be recovered after 2 attempt(s)` | gave up (`escalated`) |
| `<guard> still unhealthy but auto-recovery is off (auto_off)` | escalated without repair |
| `<guard>: health entity … is disabled — guard is blind` | config problem |
| `Guard '<guard>' is dormant — its device is disabled` | guard is off |
| `Failed to set up guard '<guard>' — skipping` | the guard has no engine; read the traceback |

Don't enable debug for `homeassistant.helpers.http` or `aiohttp.access`: they log ping tokens.

## The guard did not react when the device went offline

| Status shows | Cause | Fix |
|---|---|---|
| `blind` | health reads unknown, not faulty (see "Blind guard") | make the source report a fault |
| `ok` again, history shows `suspect` | the outage was shorter than the debounce | expected; lower *Wait before reacting* if needed |
| `suspect` | the debounce is still running | wait; it counts from when the fault was seen (heartbeat: from the deadline) |
| `snoozed` | `necromancer.snooze` or `snooze_all` is active | `necromancer.unsnooze`, or wait for `snooze_until` |
| `escalated`, `auto_recovery_entity` switch is off | auto-recovery off: it alarms but never repairs | turn the switch on, then `necromancer.reset` |
| `escalated`, `auto_recovery_entity` is `null` | notify-only guard: it only notifies | reconfigure to a recovery strategy |
| `recovering` with no own repair in the log | it follows a linked guard's repair | see "Both linked guards show recovering" |
| no status sensor in the states | guard device disabled (dormant), or the guard failed to set up | enable the device; for a failed setup read the log |

While Home Assistant starts, the debounce waits until it has started. A guard without a notify
action reacts but sends no message: check it in **Reconfigure**.

## Stuck in `recovering` or `verify`

- `verify` waits up to the **boot window** (default 180 s, max 1 h) for health to read OK. A slow
  device keeps it there. With retries, a cycle can take `max attempts × (action runtime + boot
  window)`.
- `recovering` lasts as long as the recovery itself. An action with long delays, an Auto-PoE
  cycle (up to off timeout 20 s + delay 5 s + on timeout 60 s by default) and an optional
  integration reload (10 s delay) all count.
- Health that reads unknown (a rebooting device) does not end a repair. A follower of a linked
  repair shows `recovering` and `verify` without doing anything.
- While a cycle runs, `snooze` is refused and Revive is ignored (`manual recover ignored`).
- Fix: raise the boot window if the device needs longer. Reloading the Necromancer integration
  stops a running cycle; the guard then re-reads its health and starts over.

## Escalated

**After N tries.** `attempt` equals *max attempts* (default 2). Each attempt ran and health did
not read OK within the boot window, or the action raised an error (the log has a warning per
retry and a traceback on the last). Fix the device. The guard goes back to `ok` by itself when
health returns; with the *Notification* checkbox `notify_cleared` on it then sends
`problem_cleared` ("Back to normal after …"). To try again: `necromancer.reset` re-checks and, if still unhealthy, waits out
the debounce and repairs again. For an immediate try, press the Revive button. If the device is
only slow, raise the boot window; more attempts rarely help.

**Although auto-recovery is off.** By design: off means "alarm, never touch", also when a linked
partner starts a repair (an auto-off guard escalates instead of following). Turning the switch
back on does not start a repair. Call `necromancer.reset` afterwards.

**Escalated or blocked?** Both end in the state `escalated`; the recovery event type differs:

| Event | Meaning | Typical `reason` / fix |
|---|---|---|
| `escalated` | attempts ran, the device did not come back | device problem; see above |
| `blocked` | the repair could not even start | `switch entity … not found`, `no recovery action configured`, `invalid recovery action: …`, `no port matches '…'`, `'…' matches 2 ports`; fix the guard's recovery in **Reconfigure** or the PoE ports, check Repairs |

## No "back to normal" message

`problem_cleared` comes only when an `escalated` guard turns healthy **by itself** and the
guard's *Notification* checkbox *Also notify when it's back to normal* (`notify_cleared`) is on.
Check, in this order:

- **The checkbox.** Guards created before the option have it off until someone ticks it in
  **Reconfigure**. New guards have it on.
- **The path.** No message after `necromancer.reset`, a successful repair (that sends
  `recovery_success`) or the end of a snooze. It counts only when health comes back while the
  guard is `escalated`.
- **The notify action.** Without one, nothing is sent. A notify action that branches on `event`
  needs a branch for `problem_cleared` (or a default branch).
- **No duration in the text** ("Back to normal." only): the alarm was raised by an older version,
  which stored no start time.

## Both linked guards show `recovering`

Expected. One guard leads and repairs; the others hold in `recovering`, then re-check in `verify`.
The log says `linked guard '<leader>' already repairing — following instead`. The bus event
`necromancer_guard_repair` (`phase: start` / `done`, `success`) names the leader. Afterwards each
follower: healthy → `cooldown` (silent by default); still unhealthy and the leader succeeded → its
own repair; still unhealthy and the leader failed → `escalated` with the notify event
`linked_repair_failed` (no recovery event).

## Blind guard

`blind` is not a fault and nothing gets repaired. Check `health_type`:

| `health_type` | Unknown when | Fix |
|---|---|---|
| `entity_state` | the entity is `unavailable`/`unknown`, missing or disabled; the attribute it reads is missing; or off-values are set and the state is in neither list | list `unavailable` as an off-value if that state means "down"; check Repairs |
| `template` | the template errors or renders anything but `true`/`on`/`1`/`yes` or `false`/`off`/`0`/`no` | render the template and fix it; handle missing values with `has_value()` |
| `heartbeat` | a new guard waits for its first success (`awaiting_first_success: true`) | see below |

## Heartbeat guards

Timing and sender basics are in SKILL.md ("Heartbeat guards"). Read the *Last heartbeat* sensor
(`next_due`, `period`, `grace`) and the status attributes `last_status`, `last_code`,
`health_detail`.

- **Blind after creation.** Normal until the first success. Without one it turns `suspect` at
  creation + period and reacts after the grace. Run the job once; read the sender's stderr.
- **Suspect or escalated although the job ran.** Compare the job's run time with `next_due`.
  - The ping got lost (Home Assistant was down longer than the sender's ~10 min of retries):
    call `necromancer.heartbeat_ping`. `reset` does not help.
  - The period is shorter than the job's real interval plus its run time: raise the period.
  - The job is sometimes late: raise the grace (*Wait before reacting*). A long Home Assistant
    outage can use up the grace, because it counts from the deadline.
  - The sender never reached Necromancer: check its log (next section).
- **Failure ping.** `last_status: fail`, `last_code` holds the code, `next_due` is `null`. It
  reacts at once, without the grace, and stays unhealthy until the next success. Fix the job and
  let it run again. If the job did succeed, use `heartbeat_ping`. An empty `status=` is a failure:
  usually an unset variable in the sender.
- **Sender errors.** The ready-made senders exit `0` (delivered), `1` (refused) or `2` (gave up).

| Answer | Cause | Fix |
|---|---|---|
| `400` | Home Assistant refused the request before Necromancer: odd characters in the query, or a proxy sends `X-Forwarded-For` without `use_x_forwarded_for` and `trusted_proxies` | plain status values; fix the proxy setup in Home Assistant's `http:` config |
| `403` | caller not local and *Local network only* is on (global IPv6, `100.64.0.0/10`, Home Assistant Cloud) | Home Assistant's IPv4 address in the URL, or turn the option off |
| `404` | wrong URL, token regenerated, guard deleted, or Necromancer not loaded yet | a 404 that outlasts the retries is a wrong URL: the sender needs the current one (below) |
| `405` | the sender used `GET`, or followed a redirect (a redirected `POST` becomes `GET`) | `POST`; use the final URL, not one that redirects |
| `429` | more than 5 pings in 10 s | send once per run |
| `503` | Necromancer is loading or reloading, or the integration was unloaded | transient; if it stays, check that Necromancer is loaded |

`200 {"dormant": true}`: the guard's device is disabled; the ping is stored, not judged.

- **Token leaked.** Reconfigure the guard and tick *Generate a new token*. The old URL answers
  `404` at once. The guard starts over `blind` until the first ping on the new URL. The user
  updates `HEARTBEAT_URL` on the sender; fetch the URL with `necromancer.heartbeat_url` only if
  they ask, and do not echo it (see SKILL.md).

## Auto-PoE cannot find the port

The guard escalates with the event `blocked` and a reason: `no port matches '<id>'`,
`'<id>' matches 2 ports` or `PoE fabric not ready`. Check:

- `recover_driver` on the status sensor: `<port> → <switch>` (found), `… (last-known)` (found
  from memory) or `id=<id> (N port(s) in scope)` (not found).
- Repairs: `port_no_id` (a port with neither static label nor id entity), `port_entity_missing`,
  or `recovery_action_invalid` with `no ports configured`.
- Debug log: one line per port, `port '<label>' reports id '<value>'`, with `<- MATCH` on a hit.
- Exactly one port must report the id. Ids are compared trimmed and case-insensitive. Values like
  `-`, `unknown`, `unavailable` and `none` mean "nothing connected". A port with both a static
  label and an id entity is ignored (warning in the log).
- The last-known port is used only while it reports nothing connected.

Fix the port list in Necromancer's **Configure** (options): the id entity and attribute, or a
static label that equals the guard's device id. If the port was found but did not come back
(`necromancer_poe_port` event `failed`, log `status never reached …`), check the port's status
entity and on timeout.

## The recovery ran but did not help

- **Health Check off.** A clean run counts as success: `cooldown`, then `ok`, and the fault is
  found again after the cooldown and the debounce. Signs: `recover_count` keeps rising,
  `last_recover_driver_result: good`, no `verify` in the history. Turn the Health Check on.
- With the Health Check off, only a raised error, `recover_failed: true` or an Auto-PoE port that
  did not come back counts as a failed attempt. An action that knows it failed should set `recover_failed` (see SKILL.md,
  "Automations").
- The device comes back and drops again: each round is a new cycle with `attempt` starting at 1,
  so it never escalates. Look for a root cause or a stronger recovery (supervisor guard).
- Repairs `link_device_missing`: the guard cannot reload the assigned device's integration after
  the repair. Pick the device again in **Reconfigure**.

## Home Assistant restarted during a recovery

The running cycle is dropped. On start the guard re-reads health: healthy → `ok`; unhealthy →
`suspect` and the debounce runs again (a heartbeat guard waits only the rest, counted from its
deadline or its last repair). `attempt` starts over. Only `escalated` (with its start time),
`snoozed` (with its remaining time), the counters, the auto-recovery switch and a heartbeat guard's pings survive. So a recovery that restarts
Home Assistant itself never reaches *max attempts*: every restart starts a new round. Give such a
guard a long debounce.

## Disabling entities does nothing

- **The guard's own entities.** Disabling its status sensor, switch or button only hides them.
  The guard keeps detecting, repairing and notifying. To turn it off see SKILL.md ("Turning a
  guard off"): snooze, auto-recovery switch, or disable the guard's **device**.
- **The watched device's entity, to test the guard.** A disabled entity has no state, so health
  reads unknown and the guard goes `blind` (plus a Repairs issue), not `suspect`. Test with a real
  outage (cut power, unplug) or override the entity's state.

## Repairs issues

| Issue | Meaning |
|---|---|
| `health_entity_missing` / `health_entity_disabled` | the watched entity is gone or disabled; the guard is blind |
| `health_template_blind` | every entity the template reads is gone or disabled |
| `health_template_missing_entity` (warning) | one entity is missing; the template's default decides, which may be wrong |
| `recovery_action_invalid` | the recovery cannot run (bad action, missing switch, no PoE ports) |
| `link_device_missing` (warning) | the assigned device is gone; no integration reload after a repair |
| `port_no_id` / `port_entity_missing` | a PoE port cannot match a device or cannot be cycled |

Issues clear themselves after the fix is saved. A dormant guard raises none.

More: [FAQ](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#faq),
[heartbeat answers](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/README.md#answers),
[timing and case reference](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/arch/timing.md).
