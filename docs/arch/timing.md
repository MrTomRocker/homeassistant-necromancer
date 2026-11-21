# Necromancer — Timing & case reference

A complete map of **every timer** in the engine and **every case** the system
handles, grouped by area. This is the companion to [architecture.md](architecture.md)
(structure) and [testing.md](testing.md) (what each case asserts). Defaults are the
shipped values from `const.py`; all of them are per-guard configurable in the wizard
(except the fixed internals noted as such).

---

## 1. Timing parameters

| Parameter | Default | Scope | Where it bites | Meaning |
|---|---|---|---|---|
| `debounce` | **120 s** (heartbeat: **3600 s**) | per guard, 0 to **86400 s** (1 day) | `_enter_suspect` → `_arm_debounce` → `async_call_later` | How long a guard must stay unhealthy (`SUSPECT`) before recovery is allowed to start. Absorbs blips. For a heartbeat guard it is the **grace** after a missed ping (`DEFAULT_HEARTBEAT_DEBOUNCE`). A **confirmed** verdict (`HealthSource.confirmed()`: a heartbeat's failure ping) skips it — also cutting a running one short. A finding made before HA has started starts its debounce only at `EVENT_HOMEASSISTANT_STARTED` (`async_at_started`), so no alarm or repair runs against actions bootstrap has not registered yet; a confirmed one reacts right then. A source that knows when its fault began (`HealthSource.fault_since()`: a heartbeat's passed deadline) gets only the **rest**, `debounce − (now − anchor)` clamped to `[0, debounce]`, on every arming (start of `SUSPECT`, reload, restart, the deferred start at HA started); a rest of 0 reacts at once. The anchor is `fault_since`, but never before the guard's own last reaction: its latest cycle start (`last_cycle_start`, persisted) or the end of the cooldown after its latest repair (`last_recover + cooldown`). So a heartbeat reacts at `deadline + debounce`, however often the timer is rebuilt in between, and a fault that outlives a repair waits a full debounce again (no repair or boot loop). Other sources (`None`) get the full debounce from the moment the engine sees the fault. |
| `boot_window` | **180 s** | per guard (Health Check on) | `VERIFY` → `_wait_health_ok` | How long to wait for the Health State to read OK again after the recovery action before counting the attempt as failed. |
| `cooldown` | **600 s** | per guard | `_recover_success` → `async_call_later` | Settle pause after a successful recovery before returning to `OK`. While cooling down a fresh fault re-enters `SUSPECT` directly. |
| `max_attempts` | **2** | per guard | `_run_recovery_cycle` loop | How many recovery attempts before `ESCALATED`. With Health Check off the **driver's own verdict** decides each attempt: a clean result succeeds at once, a reported failure (raise / `recover_failed` / port not online) retries up to `max_attempts`. |
| `off_on_delay` | **5 s** | per guard (switch / actions / poe) | the cycle | Pause between *off* and *on* in a power-cycle. |
| `reload_delay` | **10 s** | per guard (recover, only if a device is assigned + `reload_entry` on) | `_maybe_reload_device_entry`, after `recover()` and before VERIFY | Wait before reloading the assigned device's integration (config entry), so the just-repaired device has time to come up before HA reconnects. |
| `off_timeout` | **20 s** | per **port** | `poe_port` / fabric `_await_status` | Max wait for the port's status entity to read *offline* after cutting power (staged verify). |
| `on_timeout` | **60 s** | per **port** | `poe_port` / fabric `_await_status` | Max wait for the port's status entity to read *online* after restoring power. |
| `SAVE_DELAY` | **5 s** | global (fixed) | `Store.async_delay_save` | Debounce on writing runtime state to disk; a flush on unload guarantees no loss across a reload. |
| boot grace | — | global (fixed) | `async_at_started` | Referenced-entity/service existence is only checked **after** HA has fully started, so a not-yet-registered dependency during boot is not flagged. |
| auto-recovery | **on** | per guard (runtime) | `switch.<guard>_auto_recovery` | Not a setup timer but gates whether recovery (own *or* following a link) runs at all. |
| `period` | **86400 s** (1 day) | per guard (heartbeat source) | `core/health/heartbeat.py` `evaluate` / `next_deadline` | The expected interval between two successful pings. Deadline = basis + `period`, basis = last success (else `armed_at`, creation or new token); overdue is `now > deadline` (strict). There is no separate grace: the slack after the deadline is the guard's `debounce` in `SUSPECT`. No startup grace: after an HA restart the same arithmetic applies. A `grace` left in stored dev data is ignored. |

`debounce` is the only timer for a **notify-only** guard; it has no recovery, verify,
cooldown or attempts. A **heartbeat** guard has one more, owned by its source: a
point-in-time timer on the next deadline (+1 s, since the check is strict), which
calls `on_change` so the engine re-evaluates. It is re-armed on every ping, on
start/restore and after it fires if the new deadline is still ahead; there is none
while the last ping was a failure (that is UNHEALTHY regardless of time).

---

## 2. The recovery clock (one full cycle, Health Check on)

```
t0   health entity changes → _evaluate() → UNHEALTHY
       │  state OK → SUSPECT, start debounce timer
       ▼
t0+debounce   _debounce_done
       │  still UNHEALTHY?  no  → back to OK (blip absorbed)
       │  auto off?         yes → ESCALATED (no_auto_recovery)
       │  partner repairing? yes → follow (see §5)
       │  else → _start_cycle: claim RECOVERING *synchronously*, spawn cycle task
       ▼
       RECOVERING   attempt n/max
       │  driver.can_recover() → (False) → ESCALATED (recovery_blocked)
       │  driver.recover()      → raises  → failed attempt (retry/escalate)
       │  Health Check off?     → driver's bool verdict decides:
       │                           True  → success now
       │                           False → failed attempt (retry/escalate)
       ▼
       VERIFY   _wait_health_ok(boot_window)
       │  health OK within boot_window → success
       │  timeout & attempt < max      → next attempt (back to RECOVERING)
       │  timeout & attempt == max     → ESCALATED (recovery_failed)
       ▼
t_ok   COOLDOWN   _recover_success: recover_count++, last_recover=now, start cooldown timer
       ▼
t_ok+cooldown   _cooldown_done
          unhealthy again → SUSPECT (straight back in)
          else            → OK
```

There is **no inter-attempt delay** beyond the action's own runtime: a failed VERIFY
loops straight into the next `RECOVERING`. The "pause after an attempt" the UI mentions
is the **cooldown** (post-success), not a retry gap.

---

## 3. State machine — per-state timing & exits

| State | Entered when | Timer running | Exits |
|---|---|---|---|
| `OK` | healthy, or after cooldown | none | → `SUSPECT` on UNHEALTHY |
| `SUSPECT` | OK→UNHEALTHY (a heartbeat: deadline passed — its grace starts) | **debounce** (none if confirmed: left in the same tick; only its rest counted from `fault_since()` for a heartbeat, none once used up) | → `OK` (recovered/blip; a heartbeat's late success, no notification) · → `ESCALATED` (auto off / policy) · → follow (partner) · → `RECOVERING` (start cycle). A confirmed fault (heartbeat failure ping) cancels the debounce and takes the same exits at once. |
| `BLIND` | health `UNKNOWN` while idle (OK/SUSPECT/BLIND) — source unavailable / template render error / a heartbeat guard waiting for its first success (new guard or new token, until `armed_at + period`) | none (a waiting heartbeat source keeps its own deadline timer) | → `OK` (health reads OK) · → `SUSPECT` (health reads UNHEALTHY). No recovery; `UNKNOWN` is never a fault. |
| `RECOVERING` | cycle starts (or claimed) | none (driver runs) | → `VERIFY` (with check) · → `COOLDOWN`/`OK` (no check, driver `True`) · → `RECOVERING` (no check, driver `False`, retry) · → `ESCALATED` (blocked / out of attempts) |
| `VERIFY` | after the action, Health Check on | **boot_window** | → `COOLDOWN` (healthy) · → `RECOVERING` (retry) · → `ESCALATED` (out of attempts) |
| `COOLDOWN` | success | **cooldown** | → `OK` (healthy) · → `SUSPECT` (unhealthy) |
| `ESCALATED` | gave up / blocked / auto-off | none | → `OK` automatically once health returns (clears the verdict) |
| `SNOOZED` | operator `necromancer.snooze` / `snooze_all` | **remaining snooze duration** | → `OK` (auto-resume on elapse, re-derives from health) · → `OK` (`unsnooze` / `unsnooze_all`, early). Health is ignored while snoozed. |

`ESCALATED` and `SNOOZED` are the **persisted transients** — a dead device gets no free
retry on reboot (`ESCALATED` self-clears via `ESCALATED → OK` when health comes back),
and a deliberate snooze survives a restart (re-arms the remaining time, or resumes
immediately if it already elapsed). `BLIND` is **not** persisted — it is re-derived from
live health on boot, and a device that reads `UNKNOWN` *mid-recovery* (e.g. rebooting)
holds its current state rather than dropping to `BLIND` (that path is idle-only).

---

## 4. PoE cycle timing

Both the `poe_port` driver and the `repair_poe_port` fabric run the same staged cycle
against a port's actuator + status entity:

```
cut power (turn_off actuator)
  → await status == off,  up to off_timeout (20 s)   [timeout = WARNING, continue]
  → sleep off_on_delay (5 s)
  → restore power (turn_on actuator)
  → await status == on,   up to on_timeout (60 s)    [timeout → cycle reports not-online]
```

- `_await_status` returns **immediately** if the status already matches (so a port that
  is already off, or whose SNMP status lags, doesn't stall the cycle) and otherwise
  waits on a state-change listener up to the timeout.
- A `poe_port` **driver** then hands off to the engine's `VERIFY` (boot_window) against
  the *device* health — so there are two verifies: the port came back (staged) **and**
  the device came back (health).
- The **fabric** (`repair_poe_port`) only does the port cycle; the *caller's* action
  (e.g. wait-ping → reload → delay) and the engine VERIFY do the rest. Concurrent
  callers on one port **coalesce** onto a single in-flight cycle (they join it, they
  don't queue a second); status changes fire `necromancer_poe_port`
  (`good` / `recovering` / `failed`).
- A **raising actuator** (the `turn_off`/`turn_on` service throws) sets the port status
  to `failed` and re-raises — it never strands the port on `recovering`.

---

## 5. Guard-link timing

Leader + follower of a linked group. The **leader** runs the normal §2 clock and, in
addition, signals the group:

```
leader: _start_cycle → claim RECOVERING (sync) → task: links.notify_start
            (direct call to each partner + necromancer_guard_repair "start" event)
   ... leader runs its recovery + VERIFY ...
        → finally: links.notify_done(success)  ("done" event)

follower (auto on): links.on_partner_repair_start
            → hold: RECOVERING, _following=True, debounce timer cancelled
            → _evaluate suppressed while following (device drop is expected)
        on links.notify_done → links.validate_after_repair(leader_success):
            VERIFY (boot_window):
              healthy            → _recover_success (COOLDOWN + stats), same as leader
              unhealthy + leader OK   → own recovery (only our device is still down)
              unhealthy + leader FAIL → ESCALATED (linked_repair_failed), no cascade
```

**Claim window (arbitration).** A guard sets `RECOVERING` *synchronously* in
`_start_cycle`, before the cycle task runs. So if two linked guards' debounces elapse in
the same event-loop tick, the first to reach `_debounce_done` claims, and the second —
checking `links.find_repairing_partner` — sees it and follows. Without the synchronous claim
both would start (the state was still `SUSPECT` until the task ran): the bug fixed in
`a2d4a03`.

**Auto-off follower.** A follower whose `auto` switch is off never holds; if its device
is actually unhealthy it `ESCALATED`s (`no_auto_recovery`) instead. Off means off — it is
never silently fixed by a partner.

**Manual recover while following.** A revive-button press on a guard that is *following* a
linked partner's repair is ignored (logged) — it must not launch a competing cycle for the
shared root cause.

**Timing note for the Hue recipe.** Ping returns ~seconds after a PoE cycle, but a Hue
bridge's API (and thus the lamps leaving `unavailable`) can lag ~2–3 min. So the action
does *wait-ping → reload → delay*, and `boot_window` must be generous (≥ the lamp-return
lag) or the verify fails while the device is genuinely on its way back.

---

## 6. Case catalogue

Every distinct case the system handles. *(C = confirmed by a test/probe; L = seen live.)*

### Health

| Case | Behaviour |
|---|---|
| entity value ∈ `on_value` | `OK`. |
| entity value ∈ `off_value` | `UNHEALTHY`. |
| `unavailable`/`unknown`, not listed in off | `UNKNOWN` → never triggers (no false alarm); while idle the guard shows `BLIND` (see below). C |
| `unavailable` listed in `off_value` | treated as the fault that triggers recovery. |
| template renders `true`/`on`/`1`/`yes` | `OK`. |
| template renders `false`/`off`/`0`/`no` | `UNHEALTHY`. |
| template renders anything else (unrecognised text / blank / `none` / `unknown` / `unavailable`) or errors | `UNKNOWN` (whitelist only — no false alarm). C |
| **disabled entity** in a template | `states()` = `unknown`, **not** `unavailable` — a template checking `unavailable` will *not* fire. (Sharp edge; use a real outage or a state override to simulate.) C |
| health reads `UNKNOWN` while idle (OK/SUSPECT) | guard enters `BLIND` instead of holding a stale `OK`; no recovery. → `OK`/`SUSPECT` when health reads again. C |
| health reads `UNKNOWN` mid-recovery | holds the current state (RECOVERING/VERIFY/COOLDOWN/ESCALATED) — does **not** go `BLIND`. |
| health entity renamed | the registry listener re-points; guard keeps watching. |
| health entity removed / disabled | logged at ERROR ("guard is blind"); re-enabled → INFO. Also raised as a Repair (see Config-health). |
| referenced entity missing **at boot** | not flagged until after HA start (`async_at_started`). |
| unhealthy **at boot** (e.g. heartbeat overdue, or a stored failure ping) | `SUSPECT` at once, but the debounce starts only once HA has started; then alarm/recovery as usual. Without this the notify or repair action may not be registered yet: the alarm is lost, every attempt fails in one tick, and the persisted `ESCALATED` never alarms again. C |

### Recovery

| Case | Behaviour |
|---|---|
| unhealthy < debounce then healthy | blip absorbed, no recovery. |
| confirmed fault (`confirmed()` true: heartbeat failure ping) | no debounce: reacts at once on the elapsed-debounce path (notify / no_auto_recovery / cycle); while `SUSPECT` it cancels the running debounce. Other sources never confirm. C |
| `can_recover()` false (missing switch / no port / invalid action) | `ESCALATED` (`recovery_blocked`), no blind action. C |
| `recover()` raises (e.g. missing service) | failed attempt → retry/escalate, never false success. C |
| Health Check off | the driver's bool verdict decides the attempt: clean → success; reported failure (raise / `recover_failed` / port not online) → retry/escalate. Continuous monitoring still re-triggers if it didn't work. C |
| health returns within boot_window | success → cooldown. L |
| boot_window times out, attempts left | next attempt. |
| boot_window times out, no attempts left | `ESCALATED` (`recovery_failed`). |
| auto-recovery off + unhealthy | `ESCALATED` (`no_auto_recovery`), no action. C |
| notify-only guard | raises `problem_detected`, never recovers. |
| manual recover button | bypasses debounce + auto gate, runs a cycle now; lifts an active snooze. Ignored while busy or following a linked repair. |
| unhealthy again during cooldown | straight back to `SUSPECT`. |

### Persistence (across restart)

| Case | Behaviour |
|---|---|
| `ESCALATED` + still unhealthy | restored as `ESCALATED` (no free retry). |
| `ESCALATED` + healthy again | auto-clears to `OK`. |
| `recover_count`, `last_recover`, `last_seen`, `auto` | restored from the Store. |
| `fail_count`, `last_fail`, `last_recover_driver_result`, `last_recover_driver_time` | restored from the Store. |
| `last_cycle_start` (start of the latest own recovery cycle) | restored from the Store; a source with `fault_since()` counts its debounce from no earlier than this, so a reload or a restart in the middle of a cycle (also one the recovery action caused itself) does not start the next cycle at once. C |
| transient `RECOVERING`/`VERIFY`/`COOLDOWN`/`BLIND` | **not** restored — re-derived from live health. |
| PoE last-known port (fabric `_poe_cache`) | restored, so a `poe_port` guard keeps its fallback target across a reboot. |
| `SNOOZED` + snooze still active | restored as `SNOOZED`; the remaining snooze time is re-armed on start. |
| `SNOOZED` + snooze already elapsed | resumes to `OK` and re-derives from live health. |
| heartbeat source state (`source`: `last_ping`, `last_ok`, `last_status`, `last_code`, `armed_at`, `token_fp`) | restored by `HealthSource.restore()`; a fingerprint mismatch (new token, type switch) resets it to "armed now" and drops a stored `ESCALATED` (a `SNOOZED` stays). C |
| heartbeat guard overdue before the restart, or its deadline passed during the outage | `UNHEALTHY` at once after the start — no startup grace — so it re-enters `SUSPECT` and waits the rest of its debounce counted from the deadline (armed at HA started, see Health); the sender's retry within it makes it `OK` without an alarm. Rest used up → the reaction right after HA started. A stored `ESCALATED` stays without a new alarm. C |
| guard without a running engine (dormant, or its setup failed) | its stored blob is carried over verbatim on every save, so another guard's save cannot wipe it. C |

### Snooze (operator `necromancer.snooze` / `unsnooze`)

| Case | Behaviour |
|---|---|
| `snooze` a guard | `SNOOZED` for the duration; health ignored (no detection/recovery). |
| snooze timer elapses | auto-resumes to `OK`, re-deriving from live health. |
| `unsnooze` / `unsnooze_all` | lifts the snooze early, back to `OK` + re-derive. |
| manual recover button while snoozed | lifts the snooze and runs a cycle now (an explicit recover overrides it). |
| `snooze` during an active recovery (`RECOVERING`/`VERIFY`) | refused — raises `ServiceValidationError` (`snooze_during_recovery`). |
| `snooze_all` with some guards recovering | snoozes the rest; busy guards skipped (WARNING), no error raised. |
| snooze persisted across restart | restored as `SNOOZED`; remaining time re-armed (or resumes if elapsed). |

### Heartbeat (`heartbeat` source + `/api/necromancer/heartbeat/<name>_<token>`)

Evaluation — first matching row wins (`deadline = basis + period`, basis = last
success, else `armed_at`). The source has no grace: the wait after the deadline is
the engine's debounce (default 1 h for heartbeat guards).

| Case | Behaviour |
|---|---|
| last ping a failure (`status` anything but missing/`ok`/`0`, also empty or `start`) | `UNHEALTHY` at once, regardless of time; detail `heartbeat_failed`; `confirmed()` → no debounce: `ESCALATED` + alarm (or the repair) at once, also from `SUSPECT`. No deadline timer while failed. C |
| failure with `3` / `TERM` | kept as `last_code`, the alarm reads "Exit-Code 3" / "Code TERM". C |
| failure with `fail`, empty, or not `^[A-Za-z0-9_-]{1,16}$` (`RTMIN 3`, `a;b`, 20 chars) | no code kept, just "failure". C |
| no success yet, deadline ahead (new guard or new token) | `UNKNOWN` → `BLIND`, detail `heartbeat_waiting` (attribute only). C |
| no success yet, deadline past | `UNHEALTHY` → `SUSPECT`; at `armed_at + period + debounce` `ESCALATED`, `heartbeat_never` (since `armed_at`). C |
| `now > deadline` | `UNHEALTHY` → `SUSPECT` (the grace = debounce runs, counted from the deadline via `fault_since()`, not from the source timer's +1 s); `heartbeat_overdue` (since last success, expected period). Exactly on the deadline is still OK. C |
| success while `SUSPECT` (within the grace) | `OK`, debounce cancelled, **no notification**. C |
| debounce elapses without a success | at `deadline + debounce` the normal reaction: notify-only → `ESCALATED` + `problem_detected`; recovery → the cycle. C |
| entry reload while `SUSPECT` (any guard of the entry changed) | the new engine waits only the rest of the grace: the reaction stays at `deadline + debounce`, also after several reloads; a success within the rest → `OK`, silent. C |
| still overdue after a repair (an action without health check, no ping yet) | `COOLDOWN` ends → `SUSPECT` for a **full** debounce counted from the cooldown end, then the next cycle — not at once. C |
| entry reload while `COOLDOWN` or `RECOVERING`, still overdue | comes back `OK` → `SUSPECT`; the debounce counts from the cycle start / cooldown end (a future cooldown end = a full debounce from the reload), never a cycle in the same tick. C |
| the recovery restarts HA (or the host) while still overdue | after the boot the debounce counts from the stored cycle start (the bootstrap time counts), so restarts come at most once per debounce, not once per boot. C |
| success after a failure | `OK` at once. C |
| `period` or debounce changed | only the deadline / the wait moves; nothing resets. C |
| HA restart | same arithmetic, no startup grace: overdue stays overdue and re-enters `SUSPECT` for the **rest** of the grace (from HA started; the bootstrap time counts); a sender retry within it makes it `OK` silently. Down past `deadline + debounce`: the reaction comes right after HA started, and a retry a moment later turns it `OK` but the alarm is out. A stored `ESCALATED` stays. C |
| snooze ends after `deadline + debounce` (deadline passed during the snooze) | the grace is used up: the reaction comes right after the snooze. Deliberate (KISS): still broken after maintenance is broken. |
| `period` shortened so that the new `deadline + debounce` is already past | the reaction comes right after saving (the reload). Deliberate (KISS): under the new period the job is overdue. |

Endpoint and lifecycle — the answer a sender gets:

| Case | Behaviour |
|---|---|
| ping accepted (POST only, query only, body never read) | `200 {"health": "ok"/"unhealthy"/"unknown"}`; apply, re-arm the deadline timer, save (also OK→OK via `bind_persist`), `on_change`. C |
| other method (`GET`, `PUT`, `HEAD`…) | `405` (aiohttp) — no `get` handler, so a link preview or prefetch never counts as a ping. C |
| unknown token, or Necromancer not loaded yet (no route) | `404` — sender retries. C |
| guard `local_only`, caller not local (global IPv6, `100.64.0.0/10`, cloud, unparsable IP) | `403`, nothing changes, rate counter untouched. C |
| more than 5 pings in 10 s for one guard | `429` — sender retries; a rejected ping is not counted. C |
| unknown token from a non-local caller | `404` (lookup comes first). C |
| reload in progress (between unload and setup) | `503` (`waiting`) — sender retries into the next source. C |
| ping races the unload (source already closed) | `503` (`HeartbeatClosedError`), state untouched, no timer left. C |
| engine start raised after the source's setup | the source is unsubscribed → `waiting`, `503`; its stored state is kept. C |
| entry unloaded and not reloaded (integration disabled) | `503` until the next HA restart, then `404`. C |
| integration deleted | `404` at once. C |
| guard deleted | `404`; its stored blob drops out at the next save. C |
| guard dormant (device disabled) | `200 {"dormant": true}`: written into the stored source state, not evaluated, no timer, no alarm. Re-enabled after more than `period` → `OK`, not overdue. C |
| dormant guard created asleep / token regenerated in its sleep | the dormant ping resets the stored state to the new token (and drops a stored `ESCALATED`) before applying; wake-up → `OK`. C |
| `ESCALATED`, then token regenerated | `BLIND` (awaiting the first success); after `period` without one → `SUSPECT`, after the debounce → `problem_detected`. C |
| unexpected exception in Necromancer | `500` — sender retries; only the first 6 token characters are logged. C |
| HA shutting down | `503` (HA itself). |
| query with control chars / SQL-script patterns, or `X-Forwarded-For` without `use_x_forwarded_for` | `400` (HA itself, before Necromancer) — final, not retried. |

### PoE (`poe_port` driver & fabric)

| Case | Behaviour |
|---|---|
| exactly one live id match | wins, refreshes the cache. |
| zero live matches, cached port known | falls back to last-known (WARNING). C |
| zero live, no cache | blocked ("no port matches"). |
| ambiguous (>1 live match) | blocked / `resolve_with_reason` returns `(None, …)` (ERROR). C |
| device aged out of the switch table while down | learned-while-healthy cache lets recovery still fire. |
| port status sensor lags / already off | `_await_status` returns immediately or times out (WARNING) but the cycle continues. |
| actuator service raises mid-cycle | port status set to `failed` (re-raised), never stranded on `recovering`. |
| port did not read online within `on_timeout` | cycle reports failure (driver verdict `False`). |
| concurrent `repair_poe_port` on one port | coalesced — callers join the in-flight cycle; one cycle, not N. C |
| `repair_poe_port` with unresolvable id | logs ERROR, returns False; the calling action continues (the attempt verdict — VERIFY with check, driver bool without — still gates success). |

### Guard linking

| Case | Behaviour |
|---|---|
| link A→B (one-sided) | reads + behaves as a mutual group (closure). C |
| A–B, B–C | transitive: `{A,B,C}` one group; next edit shows all. C |
| stale partner id (partner deleted) | dropped from the effective group at runtime; self-cleans on next reconfigure. C |
| notify-only guard in the mix | excluded from the closure and from the flow options. C |
| heartbeat guard in the mix | excluded from the closure at runtime (a stale `linked_guards` is ignored) and from the flow: no link section, not offered to other guards, nothing stored. C |
| linked guard switched to heartbeat | removed from every partner on save (`_apply_link_removals`); the rest of the group stays. C |
| one guard trips | it leads; linked partners follow (hold + re-verify), no parallel recovery. L |
| both trip simultaneously | first to `_debounce_done` claims `RECOVERING`; the other follows (no double-cycle). C |
| follower healthy after the shared repair | settles through `_recover_success` (cooldown + stats) like the leader. L |
| follower still unhealthy, **leader succeeded** | follower runs its own recovery (only its device is down). |
| follower still unhealthy, **leader failed** | follower `ESCALATED`s (`linked_repair_failed`); no cascade. C |
| follower with auto off | does not follow; escalates if affected (`no_auto_recovery`). C |
| unlink one side | the edge is cleared on both ends (`_apply_link_removals`). |
| uncheck one partner in a clique of 3 | re-forms via the shared partner — must clear *all* to leave. |
| `necromancer_guard_repair` event | fired on every leader start/done for outside automations. |

### Config flow

| Case | Behaviour |
|---|---|
| broken template at submit | rejected (invalid). |
| missing service in an action | escalates at run time, not a false success. |
| bad notify action | logged, no crash (notify runs detached). |
| port YAML import invalid | `import_failed` with the reason; list untouched. |
| import merge vs replace | upsert by `label` / overwrite. |
| reactive attribute/state pickers | follow the sibling entity field live (device step is flat; the port editor binds within its section). |
| own entities in pickers | excluded (no self-watch / self-switch). |
| heartbeat `period` < 60 s | rejected (`period_too_short`) after the duration is converted to seconds; exactly 60 s is accepted. The device step has no `grace` field (sending one is `InvalidData`); a stored one is not pre-filled and is dropped on save. |
| debounce > 86400 s | rejected by the selector (`InvalidData`) for every guard; exactly 1 day is accepted. |
| heartbeat guard saved | only after the URL info step (`heartbeat_url`) is submitted — on create and on every reconfigure that ends as heartbeat. Closing the dialog there saves nothing (a new guard has no token). |
| reconfigure, nothing changed | same token, the info step shows the same URL; the source keeps its state (no reset). |
| "Generate a new token" | new token before saving, info step `heartbeat_url_new` with the new URL; on submit the old URL answers `404`, the reload resets the source (new `token_fp`) → `blind` + `awaiting_first_success`, `problem_detected` after `period` + debounce without success. |
| type switch → heartbeat | new token, strategy default `notify`, stored debounce replaced by 3600 (the grace), link removed from partners. The reset rule is the same as for a new token. |
| type switch heartbeat → other | no info step; the source-step field text warns that the URL becomes invalid (`404`); debounce default back to `DEFAULT_DEBOUNCE`; the token is not stored. |
| no internal/external URL | the info step shows only the path; its text says to put the HA address in front. |

### Config-health (Repairs)

Surfaced in **Settings → Repairs** via the issue registry, reconciled at startup/reload and
on a state-change listener over the watched entities (**event-driven, not polled**). An issue
clears the moment the cause is fixed or the guard/port is removed.

| Case | Behaviour |
|---|---|
| guard's health entity missing / disabled | Repair `health_entity_missing` / `health_entity_disabled` (ERROR). |
| guard's template reads only missing/disabled entities (blind template) | Repair `health_template_blind` (ERROR). |
| recovery action invalid (e.g. bad PoE action) | Repair `recovery_action_invalid` (ERROR). |
| port with no id source (no static label, no id-entity) | Repair `port_no_id` (WARNING). |
| port's actuator / status entity missing | Repair `port_entity_missing` (ERROR). |
| cause fixed, or guard/port removed | issue auto-deleted (`async_delete_issue`). |

---

## 7. Timing footguns (known sharp edges)

- **Ping ≠ API-ready.** A device answering ping is not the same as its integration being
  usable again (Hue lamps lag minutes). Verify against the *real* signal and size
  `boot_window` to the slowest return.
- **SNMP / neighbour-table lag.** Port `*_aktiv` and `*_nachbarn` sensors update on a
  poll, so they can lag a real power state by seconds; the cycle tolerates this
  (immediate-match + timeout-continue), but don't set `off_timeout`/`on_timeout` below
  the poll interval.
- **Disabling an entity ≠ making it `unavailable`.** Registry-disable yields `unknown`;
  a template watching `unavailable` won't trigger. Simulate outages by cutting power or
  overriding state, not by disabling.
- **Disabling the guard's own device stops the clocks entirely.** No engine is built, so
  no debounce, boot_window, cooldown or snooze timer exists to elapse — the guard is
  dormant, not paused. A snooze does **not** tick down while dormant. Re-enabling is the
  same path as a restart: `_apply_persisted` restores the stats, `auto`, and a terminal
  ESCALATED or a SNOOZED (whose remaining time is re-armed, or resumes at once if it
  elapsed meanwhile); every transient state is re-derived by the first `_evaluate()` in
  `async_start`.
- **A dormant heartbeat guard still takes pings — stored, not evaluated.** Its URL
  answers `200` + `{"dormant": true}` and moves `last_ok` in the Store, but no
  deadline timer runs and nothing alarms. The sender's journal shows a notice, not
  an error, so "dormant" does not look like a broken job.
- **`local_only` is about the connection's IP.** Loopback, link-local, RFC1918 and
  ULA are local — also other VLANs and Docker networks. A **global IPv6** address and
  `100.64.0.0/10` (e.g. Tailscale) are not: a sender whose hostname resolves to IPv6
  gets `403`, so senders use HA's IPv4 address. Behind a reverse proxy, HA uses the
  `X-Forwarded-For` address only with `use_x_forwarded_for` **and**
  `trusted_proxies`; a proxy that sends the header without that config makes HA
  answer `400` before Necromancer, and a proxy that sends no header at all makes
  every caller look local (its own private IP).
- **Integration disabled or deleted ≠ silence at the sender.** Unloaded and not
  reloaded, the tokens answer `503` until the next HA restart, then `404` (no route);
  deleted, `404` at once. Senders retry ~10 min and then log an error — the
  monitoring really is off.
- **`boot_window` ≥ the job's runtime.** A heartbeat repair (restart the job) is only
  verified if the success ping arrives within `boot_window` (up to 1 h). Longer jobs
  belong on `notify`.
- **An HA outage over a ping time alarms although the job ran.** There is no startup
  grace: if a ping fell into an outage longer than the sender's retries (~10 min),
  the guard alarms once its deadline passes and its debounce (the grace) has run
  out. A retry that does get through within the debounce clears it silently.
- **A long HA outage uses up the grace.** The debounce of a heartbeat guard counts
  from the deadline, not from the start (so a reload or restart cannot postpone the
  alarm). Down for longer than `deadline + debounce`, the alarm (or the repair)
  follows right after HA started — even if the sender's retry arrives a second
  later and turns the guard `OK` again. A deadline is a deadline. This holds only
  until the guard's own reaction: a fault that outlives a repair counts its debounce
  from the cycle start or the cooldown end again (both persisted), so repeated
  repairs — or restarts made by the recovery action — are a full debounce apart.
  `max_attempts` still does not span restarts (a cycle cut short by one is not
  restored), so a recovery that restarts HA repeats once per debounce until the
  sender pings again.
- **A debounce of 0 on a heartbeat guard has no grace.** The alarm follows the
  missed deadline at once; a job whose runtime varies then alarms on every slow run.
- **The last-heartbeat sensor writes one recorder row per ping.** That is its job (the
  history of pings). A job pinging every 5 min costs 288 rows a day; exclude
  `sensor.*_last_heartbeat` from the recorder if that is too much. The status sensor
  does not move per ping (its heartbeat attributes only follow the verdict), and its
  `health_detail` is the text at the time of the finding — `{since}` does not count up.
- **Notify action runs detached.** A user `delay` in the notify action never stalls the
  engine — but it also means a notify is not awaited; failures only show in the log.
- **Cooldown is post-success, not a retry gap.** Retries are back-to-back (only the
  action's own runtime separates them). Use `boot_window` to give a device time to come
  back *within* an attempt, not `cooldown`.
- **MCP is down right after a Core restart.** Operational, not engine: drive the live
  API via the Supervisor proxy (`http://supervisor/core/...` + `$SUPERVISOR_TOKEN`)
  until the MCP add-ons reconnect.
