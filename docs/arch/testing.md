# Necromancer — Test concept

Three levels, smallest-first. The manual regression checklist proves end-to-end
behaviour today; pure logic should move into `pytest` over time.

> The exhaustive list of cases each test guards — with their timing — lives in
> **[timing.md](timing.md)** (§6 case catalogue). This file says *how* to test them.

---

## 1. Invariants to protect

These are the properties a change must never break — every test exists to guard
one of them:

1. **No false alarm.** Ambiguous health (missing entity, render error, empty,
   `unknown`/`unavailable`) → `UNKNOWN`, never `UNHEALTHY`. No recovery is
   triggered on `UNKNOWN`; an idle guard shows `BLIND` instead of a stale `OK`,
   and returns to `OK`/`SUSPECT` once health reads again (mid-recovery it holds,
   never going `BLIND`).
2. **No false success.** A recovery only counts as success if the action ran
   without raising *and* the attempt verdict is good — with the Health Check on
   the device VERIFY decides, with it off the **driver's own bool verdict** does
   (a raising `recover()`, a `recover_failed` action, or a port that never came
   online is a failed attempt → retry/escalate, never an assumed success).
3. **Verify is possible.** Every `HealthSource.evaluate()` is callable on demand,
   so the VERIFY step works: health is a judgement that can be evaluated at any
   time (an entity state, a template, or the deadline of a heartbeat), never a
   momentary trigger.
4. **State survives restart.** `ESCALATED`, `recover_count`, and the `auto` flag
   are restored from the `Store`; transient states are not. The health source's own
   state (`source`, e.g. a heartbeat's last pings) survives too; a stored
   `ESCALATED` is dropped only when the source reports a new identity (regenerated
   token), a `SNOOZED` never.
5. **Pre-flight blocks blind actions.** `can_recover()` returns `(False, reason)`
   when a referenced thing is missing → `recovery_blocked`, no blind cycling.
6. **UI correctness.** Reactive selectors resolve within their section; config
   translations carry no ICU `{…}` braces; every step has a description; own
   entities are excluded from pickers.
7. **Linked guards coordinate, never compete.** When one guard in a group repairs,
   the others *follow* (hold + re-verify afterwards) and never launch a parallel
   recovery for the same root cause. The link relation stays symmetric and
   clique-closed; the only way out of a group is to clear all of its partners.
8. **Shared port recovery is coalesced.** `repair_poe_port` cycles a port via a
   per-port in-flight task, so concurrent callers join one cycle and share its
   result instead of double-cycling.
9. **Operator snooze suspends cleanly.** A snoozed guard ignores health entirely
   (no transitions, no alerts), survives a restart (re-arming the *remaining* time),
   auto-resumes on elapse, and is refused (`ServiceValidationError`) mid-recovery —
   distinct from auto-off, which still detects and escalates. A manual recover press
   lifts an active snooze; a press while *following* a linked repair is ignored.
10. **Config-health is visible, not silent.** A mis-wired guard/port (blind guard,
    blind template, invalid action, port without an id, port entity missing) raises
    a Repair in Settings → Repairs; the issue clears the moment the cause is fixed or
    the guard/port is removed. Reconciliation is event-driven (startup/reload + a
    state-change listener), never polled.
11. **The token stays secret.** Necromancer never writes a heartbeat token in full
    into attributes, events, notifications or logs (there is no diagnostics
    platform; `describe()` is
    just `heartbeat`, the Store keeps only its fingerprint `token_fp`). It is shown
    only where it is the point: the flow's URL info step and the admin-only
    `heartbeat_url` service response.
12. **A ping is processed or honestly refused.** The heartbeat endpoint answers `2xx`
    only when it applied the ping or deliberately stored it without evaluating
    (`dormant`). Everything the sender should retry is `404`, `429` or `5xx`; `403`
    and HA's own `400` are final. The checks run in the fixed order token →
    `local_only` → rate limit → query, and the body is never read.

---

## 2. Level 1 — unit (pure logic / real `hass`)

Fast, deterministic. Three runnable in-process modules cover this level today (run
them with the dev venv, see §5): **`tests/test_units.py`** (51), **`tests/test_poe.py`**
(22), **`tests/test_engine.py`** (80); a fourth script, **`tests/test_integration.py`**
(12 checks), covers the health-registry robustness path (disable / rename / remove)
and PoE pre-flight blocking against a real `hass` (§3). On top sits a **pytest suite
on HA's native test harness** (`tests/suite/`, 181 tests) that automates Level 2
in-process — see §3. In a core checkout it is linked to `tests/necromancer/` (under
`tests/` but not `tests/components/`, so only core's `tests/conftest.py` applies) and
run via `pytest tests/necromancer/`, as CI does. Each row maps to an invariant:

| Module | What to assert | Covered by |
|---|---|---|
| `core/health/entity_state.py` | value-list mapping → OK/UNHEALTHY/UNKNOWN; unavailable/unknown → UNKNOWN; explicit-off-wins; legacy `healthy_state` fallback. | `test_units` |
| `core/health/template.py` | whitelist: `true`/`on`/`1`/`yes` → OK, `false`/`off`/`0`/`no` → UNHEALTHY; everything else (`unavailable`, `none`, blank, unrecognized, render error) → UNKNOWN. | `test_units` |
| `core/health/heartbeat.py` + `core/heartbeat_registry.py` | evaluation table in order, deadline = basis + period (failure → UNHEALTHY; waiting → UNKNOWN before and exactly on the deadline; never; overdue; OK; OK after a failure); a stored `grace` is ignored; no startup grace across a restart; `confirmed()` only while the last ping is a failure (not while waiting or overdue), `False` for other sources; `fault_since()` = the passed deadline while overdue (also never succeeded), `None` on the deadline itself, while waiting/OK, after a failure ping and for other sources; `parse_status` (missing/`ok`/`0` = success, empty/`fail`/`start`/anything else = failure, code kept only if `^[A-Za-z0-9_-]{1,16}$` and not `fail`); `token_fp` stable and token-free; slug → token after the last `_`; `reconcile_token` resets on a missing/other fingerprint; no basis at all → no deadline, waiting; `datetime` values count like ISO strings; source lifecycle (active + timer on setup, ping persists + notifies, unsub → waiting + closed, refused pings, a closed source arms no timer and no longer calls the engine); registry: 5 pings per 10 s per token, rebuild/activate/deactivate/unload/remove. | `test_units` |
| `core/drivers/*.can_recover` | missing switch / missing+invalid action → `(False, reason)`; the poe_port adapter blocks on no/ambiguous match. | `test_units`, `test_poe` |
| `config_flow` helpers | `_flatten_sections` (nested→flat, duration dicts stay whole), `_as_list`, `_build_data` (health block per source type incl. heartbeat token/seconds and never `linked_guards`, behaviour per check), `_current_strategy`, `_source_type_of` (three types), `_as_duration`/`_as_seconds`, debounce default per source type (heartbeat 3600 s = the grace) and its replacement on a switch across heartbeat (`_behavior_defaults`); the debounce box goes up to 86400 s for every source type; `_health_defaults` carries no `grace`. | `test_units` |
| `config_flow` ports YAML | `_parse_ports_yaml`/`_normalize_imported_port`: required `label`/`actuator`/`status_entity`; reject not-a-list / empty / `null` / list-of-scalar / malformed YAML / non-numeric **or negative** timing; trim, scalar→list, missing/empty status→default, int→str. `_ports_to_yaml` round-trips; import **merge** = upsert by `label`, **replace** = overwrite. `_validate_port_identity`: a port gives its id ONE way — an entity (+ optional attribute) or a static label — setting both is rejected (`id_conflict`), and an attribute with no id-entity is rejected (`attribute_needs_entity`). | `test_units` |
| `core/notify.py` | every notify path passes the same full variable set (incl. `health_detail`, `""` when unset); `_format_duration` (de/en, singular/plural, German dative after "seit"/"vor", minute/hour/day boundaries); every `DETAIL_MESSAGES` key renders with the params `detail()` produces (code clause: digits = exit code, word = code, none = nothing); a detail is appended as a second sentence, `event` unchanged. | `test_units` |
| `core/actions.py` | `async_validate` normalises `service`→`action`; invalid sequence raises `vol.Invalid`. | `test_units` |
| `core/links.py` | `link_components` / `group_of`: undirected union → connected components (clique closure); transitive (A–B, B–C ⇒ `{A,B,C}`); a one-sided link reads symmetric; stale ids dropped. | `test_units` |
| `core/poe.py` (fabric) + `poe_port` driver | `resolve_with_reason`: one live match wins (refreshes cache) → last-known cache → ambiguous/none with a reason; a port that sets both an id-entity and a static label is misconfigured → `_port_id` ignores it and warns (`test_port_with_both_id_sources_is_ignored`); `repair` sets status `recovering`→`good`/`failed`, with concurrent callers **coalescing** onto one in-flight cycle (`test_concurrent_callers_coalesce`); a status change fires `necromancer_poe_port`; the `poe_port` driver delegates resolve+cycle to the fabric (one cache, one cycle, **shared with the service** — `test_driver_and_service_coalesce`). | `test_poe` |

## 3. Level 2 — integration (HA test harness or dev container)

Most of this is now **automated in `tests/suite/`** — the HA-harness pytest suite
(`MockConfigEntry` + `subentries_data` → real `async_setup_entry`, platforms, registries):
config/subentry/options flow (every step + reject path), the view entities, the operator
services, and per-guard setup isolation. The dev-container REST/WS harness (§5) remains for
exploratory and true end-to-end live checks. Drive the real flows and the engine:

- **Config flow → engine setup**: each strategy + source type builds a valid
  guard; sections flatten; `poe_port` injects the flat port list.
- **State machine** *(automated: `tests/test_engine.py`, real hass + time-travel)*:
  happy path (recover→verify→cooldown→ok, `recover_count++`); debounce blip
  absorbed; max-attempts → `ESCALATED`; raising driver = failed attempt; with Health
  Check off the driver's `False` verdict is also a failed attempt (retry/escalate),
  `True` succeeds at once; auto-off → `ESCALATED`; idle `UNKNOWN` → `BLIND` (back to
  `OK`/`SUSPECT` on the next read, holds mid-recovery); manual recover (ignored while
  a cycle is running or while following a linked repair; lifts an active snooze);
  cooldown→suspect.
- **Engine with a heartbeat source** *(automated: `tests/test_engine.py`, real
  `HeartbeatHealth` + a patched clock; inside it the engine's `async_call_later` runs
  as a point in patched UTC time, so a long debounce fires exactly when the clock
  passes it)*: a new guard starts `BLIND` (waiting); the deadline passes →
  `SUSPECT`, still `SUSPECT` one second before the debounce (the grace) ends, then
  `problem_detected` with the detail sentence and `health_detail`, which does not
  drift afterwards; a ping within the debounce → `OK` and no notification ever; a
  failure ping from `OK` → `ESCALATED` + `problem_detected` at once, and from
  `SUSPECT` (overdue) at once with no second alarm from the cancelled timer; never
  succeeded → `BLIND` until `armed_at + period`, then `SUSPECT`, after the debounce
  `heartbeat_never`; a restart with an overdue guard → `SUSPECT`, cleared silently by
  a retry or alarming after only the rest of the debounce (counted from the
  deadline via `fault_since()`); two reloads in the grace leave the alarm at
  deadline + debounce, and a ping within the rest after a reload stays silent; a
  restart past deadline + debounce → `problem_detected` (or the repair) right after
  the start, a retry a second later → `OK` with no second alarm; HA `starting`: held
  in `SUSPECT`, at `EVENT_HOMEASSISTANT_STARTED` only the rest (bootstrap time
  counts), or at once when the rest is used up; a generic `fault_since()` fake: the
  rest only, a start in the future = full debounce, one further back = at once;
  the grace counts again after the guard's own reaction: still overdue after a
  repair without check → the next cycle a full debounce after the cooldown end, a
  reload in `COOLDOWN` → a full debounce from the reload, an HA restart made by the
  recovery (`last_cycle_start` stored) → at started only the rest counted from the
  cycle start; `entity_state`/`template` return `None`, ignore those marks and keep
  the full debounce; an `entity_state` guard keeps waiting out
  its debounce (another unhealthy update does not cut it short); a source without `detail()` sends
  `""` and unchanged texts; the detail rides on `recovery_attempt` 1 (not 2),
  `recovery_failed` and `no_auto_recovery`, never on `recovery_success` or
  `recovery_blocked`; strategy action + Health Check: a ping within `boot_window` →
  `COOLDOWN`, a job that keeps failing → `ESCALATED` after `max_attempts`; a ping
  during a snooze is stored and saved while the snooze holds; a grace that ran out
  during a snooze alarms right after it (lifted by `unsnooze` or elapsed), with no
  fresh debounce.
- **Persistence across restart** *(automated: `tests/test_engine.py`)*: ESCALATED
  stays (still unhealthy) / auto-clears (healthy again); `recover_count`, `fail_count`,
  `last_fail`, `last_recover_driver_result`/`_time`, `last_cycle_start` and `auto` survive; snapshot
  round-trip incl. `source`. Heartbeat: an overdue `ESCALATED` stays across a restart
  without a new alarm; another token's state drops a stored `ESCALATED` (not a
  `SNOOZED`) and saves the reset at once; `reset_engine_verdict` (dormant path).
- **Heartbeat endpoint, lifecycle, persistence** *(automated:
  `tests/suite/test_heartbeat.py`, real HTTP via `hass_client_no_auth`, a non-local
  caller simulated by patching the view's `is_local`, `freezer` for deadlines and
  the delayed save)*:
  - *Endpoint*: POST is a success, `GET` and `PUT` → `405` (nothing stored); a bare
    token or another name before the last `_` reach the same guard; unknown token →
    `404`, also before setup (no route); `status=` empty → failure, `TERM` kept as
    code; `local_only` + a non-local caller → `403` over HTTP and nothing changes —
    also a cloud connection, an unparsable, a `100.64.0.0/10` (CGNAT, e.g. Tailscale)
    or a global IPv6 address (the connection's address patched, the real `is_local`
    decides), while an RFC 1918 or ULA caller gets `200`; without `local_only` → `200`; the sixth ping in 10 s → `429`; **order**: unknown token from
    outside → `404`, a valid token from outside over the limit → `403` with the rate
    counter untouched; a 64 KiB body is not read (same `200`); an exception in
    `async_handle_ping` → `500` with only 6 token characters in our log, while an
    aiohttp `HTTPException` keeps its own status (no `500`); the URL needs no auth while
    `/api/services/…` still does.
  - *Token secrecy* (invariant 11): two heartbeat guards (notify-only and repairing)
    go through creation (one at runtime), success and failure pings over HTTP and by
    service, an overdue alarm, a recovery cycle and a reload; after every step no
    Necromancer state, no bus event, no notification, no Store blob and no own log
    line contains the token.
  - *Lifecycle*: two reloads register the view once and leave the token `active`;
    unloaded → `503`, set up again → `200`, entry removed → `404`; guard removed →
    `404` and its blob gone after the next save; a closed source still in the table
    → `503`, state untouched, no timer; `async_start` raising after the source's
    setup → `waiting` (`503`), another guard's save keeps the failed guard's
    `last_ok`/`armed_at`/`token_fp`, and the next reload has them; dormant → `200` +
    `dormant`, stored not evaluated, re-enabled after more than `period` →
    `OK` without an alarm; created asleep (no blob) → a `{"source": …}` blob → `OK` on
    wake-up; token regenerated in its sleep → old URL `404`, the stale `ESCALATED`
    dropped, `OK` on wake-up; `ESCALATED` + new token → `BLIND` awaiting the first
    success, after `period` + debounce → `problem_detected`; a heartbeat guard with a
    stale `linked_guards` never joins a group; a heartbeat subentry without a token
    (broken stored data) gets no route and no engine while the entry and the other
    guards still load.
  - *Grace = debounce*: overdue → `SUSPECT` for the debounce, a ping in it → `OK`
    silently, the next miss without a ping → `ESCALATED` + `problem_detected`; a
    failure ping from `OK` → `ESCALATED` at once (before any timer), from `SUSPECT`
    too, with one alarm only; a restart past the deadline → `SUSPECT`, the sender's
    retry → `OK` without an alarm; a `grace` left in stored health loads and moves
    no deadline. *Rest of the grace* (`fault_since()`): a reload in the grace →
    alarm still at deadline + debounce, a ping within the rest after a reload →
    silent; a restart in the grace → only the rest; a restart past deadline +
    debounce → `ESCALATED` + `problem_detected` right after the setup, the retry
    then → `OK`, one alarm; HA `starting` → at started only the rest; strategy
    action, still overdue after the repair → the next cycle only a full debounce
    after the cooldown, also after a reload during the cooldown (no repair loop).
    *Shorter period by reconfigure*: the last ping stays (no reset, not `blind`);
    deadline and grace already passed → the alarm as soon as the change is saved;
    only the deadline passed → `SUSPECT` and the alarm at the new deadline + debounce.
  - *Persistence*: an OK→OK ping reaches the Store after `SAVE_DELAY` without an
    unload (`bind_persist`); ping → reload → state and deadline timer back; the last
    ping before an unload is in the Store and a ping after it gets `503` without
    touching the Store (stop before flush); stop → start after the deadline (debounce
    0) → `UNHEALTHY` and `problem_detected`, a stored `ESCALATED` then stays without
    a new alarm; the same while HA is `starting` → `UNHEALTHY` but held in `SUSPECT`,
    the alarm (notify service registered late) or the `action` repair (service
    registered late, no attempt burnt) only after `EVENT_HOMEASSISTANT_STARTED`.
- **Entities of the heartbeat source** *(automated: `tests/suite/test_sensor.py`)*:
  `health_type` on every status sensor (`entity_state`/`template`/`heartbeat`), the
  heartbeat attributes only on heartbeat guards; waiting → `blind` with
  `awaiting_first_success` and `health_detail` "Waiting for the first heartbeat.", first
  success → `ok` without `health_detail`, an OK→OK ping leaves the status sensor's
  attributes and `last_updated` untouched, a failure → `last_status`/`last_code` and the
  failure detail; only failures → not awaiting; the `health_detail` attribute keeps the
  wording of the finding as time passes (a later state write does not re-render it); `sensor.*_last_heartbeat` only for
  heartbeat guards, value = `last_ping`, `next_due` = basis + period (from `armed_at`
  while waiting, `None` after a failure), `period` and `grace` (= the debounce) in
  seconds, refreshed by every ping; a failure ping escalates without a debounce; removed from the registry
  after a type change heartbeat → state.
- **Config flow of the heartbeat source** *(automated:
  `tests/suite/test_subentry_flow.py`)*: three source types offered; create shows
  period/local-only (no grace, no entity, no regenerate toggle), strategy default
  `notify`, debounce default 3600, and the URL info step **before** the entry exists
  with its three example calls `example_ok` (`curl -fsS -X POST …`), `example_fail`
  (`?status=fail`) and `example` (`?status=$?`); `period` < 60 s rejected, a `grace` field
  refused (`InvalidData`); debounce 86400 accepted, 86401 refused; no HA URL → path
  only;
  `get_url` called with `allow_external=not local_only`, `prefer_external=False`,
  `allow_ip=True`; reconfigure without change keeps the token and shows the same URL
  (a stored `grace` is not offered and dropped on save);
  "Generate a new token" → `heartbeat_url_new` with the new URL, nothing saved before
  submit, then old URL `404`, new URL `200`, status `blind` with
  `awaiting_first_success`; type switch state → heartbeat (new token, `notify`
  default, stored debounce replaced by 3600, no link section, partner unlinked) and back
  (no info step, `DEFAULT_DEBOUNCE`, no token); heartbeat guards get no link section
  and are not offered to other guards.
- **Health robustness**: rename-following; disable/enable live; remove; startup
  already-unhealthy detection; idle `UNKNOWN` → `BLIND` and recovery from it.
- **Corner cases**: broken template rejected at submit; missing service in an
  action → escalate (not false success); bad notify action → logged, no crash.
- **Port import/export (options flow)**: the menu exposes import + export; import
  **merge** (upsert by `label`) vs **replace**; an invalid paste returns
  `import_failed` with the reason in `description_placeholders` and leaves the list
  untouched; `import_mode` omitted defaults to merge; export multi-select (all
  pre-selected, empty selection tolerated) → round-trip YAML. Driven
  **non-destructively** (never call `save`), so the entry's real ports are safe.
- **Auto-PoE fallback**: build a poe_port guard whose device id is a settable
  entity state; let it learn the port while healthy, then make the device vanish
  (id gone) **and** go unhealthy → the recovery must cycle the *cached* port
  (WARNING "falling back to last-known port"), not block with "no port matches".
- **Guard linking**: two linked guards on a shared Health Source; trip one → the
  other logs "linked guard is repairing — following", holds (no own action), and
  re-validates after → both end OK and the follower also enters cooldown. Closure:
  a one-sided link still shows the partner on *both* guards' next edit; unlinking
  from one side clears the edge on both; a notify-only guard never appears in a
  group. Corner cases (all covered by a standalone engine probe):
  - **Arbitration**: simultaneous debounce → the leader claims `RECOVERING`
    synchronously in `_start_cycle`, so the other follows (no double-cycle).
  - **Auto-off**: a follower with its `auto` switch off does **not** follow — if its
    device is affected it escalates (`no_auto_recovery`). Off means off.
  - **Leader failed**: leader escalates and the follower is still unhealthy → the
    follower escalates (`linked_repair_failed`), it does **not** self-recover and
    re-trigger the group (no cascade).
- **`repair_poe_port` service**: a call resolves the id and cycles the port
  (status `recovering`→`good`, or `failed` if the port never comes online or the actuator
  service raises — never stranded on `recovering`); a second concurrent call **joins the
  in-flight cycle** instead of double-cycling. Verified live end-to-end via a real
  PoE-bridge outage (pull power → linked ping+lamps guards → one cycles the port → both
  verify OK).
- **View entities** *(`tests/suite/test_{sensor,binary_sensor,switch,button,event}.py`)*:
  status (enum incl. `blind`; lean attributes — `recover_driver` (renamed from `target`),
  `fail_count`, `last_fail`, `last_recover_driver_result`/`_time`), health
  (connectivity; `UNKNOWN` → `unavailable`),
  auto-recovery switch (`entity_category: config`, writes through to `auto`), revive
  button (manual cycle, bypasses debounce), and the recovery `event` (fires
  `recovered` / `escalated` / `blocked`; absent on notify-only guards).
- **Operator services** *(`tests/suite/test_services.py`)*: `reset` (clears `ESCALATED`,
  re-derives); `snooze`/`unsnooze` (→ `SNOOZED`, ignores health, auto-resumes, refused
  mid-recovery); `snooze_all`/`unsnooze_all` (bulk, no target, busy guards skipped
  best-effort).
  Heartbeat services (same file, `freezer` for deadlines and the delayed save):
  `heartbeat_url` returns `url` + `path` from the shared `ping_url` (the same `get_url`
  arguments as the flow's info step), `url` `None` without any HA URL (path only), a
  non-heartbeat guard → `not_a_heartbeat_guard`, a foreign entity → `unknown_guard`, a
  read-only user → `Unauthorized` while an admin gets the URL; `heartbeat_ping` turns an
  overdue `ESCALATED` guard `OK` with `next_due` = now + `period` and the ping in the
  Store, ends a `SUSPECT` grace without a notification (also past the old debounce),
  rejects a non-heartbeat guard (`not_a_heartbeat_guard`) and a closed source
  (`heartbeat_not_running`, state untouched), writes nothing for a dormant guard (HA's
  missing-target WARNING), logs one INFO line with the user id and never the token, and
  keeps a snoozed guard `SNOOZED` while storing the ping. A `device_id` target on a
  heartbeat guard calls only the status sensor (`heartbeat_ping`, `reset`), and naming
  the `last_heartbeat` sensor raises `ServiceNotSupported` (device-class filter).
- **Health primitives** *(`tests/suite/test_health_primitives.py`)*: the response
  services `check_health` (returns the guard's current Health verdict; unknown guard
  raises) and `wait_for_health` (waits up to a timeout / the boot window for OK,
  `check_first` short-circuits when already healthy, reports `timed_out` + `waited_s`,
  uses its own waiter not the verify event) — both keyed by the guard's status entity.
- **Device footprint** *(`tests/suite/test_init.py`)*: a guard owns exactly one device,
  keyed by its subentry and named after the guard; an assigned device becomes its
  `via_device_id` and keeps its own name and owner (we never adopt it); two guards on the
  same target stay distinct devices; an assigned id that no longer resolves leaves the
  guard fully working with `via_device_id=None` and raises `link_device_missing`.
- **Repairs (config-health)**: each problem type (blind guard, blind template, invalid
  action, dead assigned device, port no-id, port entity missing) raises an issue in the
  registry with the right
  severity; assert the issue *appears* when the cause is introduced and *clears* when the
  entity reappears or the guard/port is removed — reconciled on the state-change listener
  (event-driven), not on a poll.

These run today against the dev container by driving the REST/WS flow API and
asserting on `sensor.*_status` + the error log (see the regression checklist for
exact steps).

## 4. Level 3 — agent regression checklist

[`AGENT_REGRESSION.md`](AGENT_REGRESSION.md) is the agent-runnable, priority-ordered
checklist (P0/P1/P2): each item is a tickable *Prüft / Files / Treiber / Assert /
Cleanup* block an agent drives via file inspection and the live-test helper API. Run
the **P0** block after any engine, persistence, health, or config-flow change. Each
item names the expected log line / entity state so a run is unambiguous.

---

## 5. Dev-container live harness

The integration is developed inside an HA-core dev container with the package
mounted live. Two complementary harnesses are used:

**Standalone logic (no HA, no token).** Run a script with the dev venv python and
`PYTHONPATH=<config dir>` so `from custom_components.necromancer import config_flow`
resolves. For flow methods, instantiate the flow and monkeypatch `async_show_form`
/ `async_show_menu` / `async_step_init` to capture their result, then call the real
`async_step_*` and assert on the mutated state. This is how the port import/export
logic is covered (parse / validate / merge / replace / export round-trip), fast and
without a running instance.

**Live flow (running HA + token).** Pattern used throughout development:

- Drive subentry/options flows via `POST /api/config/config_entries/{subentries,options}/flow`
  — open with `{"handler": …}`, navigate a menu with `{"next_step_id": …}`, submit a
  step by posting its fields. For read-only checks (import/export) **don't call
  `save`** and `DELETE` the flow at the end, so the real config stays untouched.
- Toggle test helpers (`input_boolean.test_*`, `input_select.test_state`, …) and
  read back `GET /api/states/...` + `/api/error_log`.
- Fetch served translations via WS `frontend/get_translations` to confirm keys
  render (and that selectors actually surface labels).

**Restart** — code changes need a module re-import. The process runs as
`python -m homeassistant -c ./config`; stop it with `pkill -f "[h]omeassistant -c"`
(the `[h]` keeps pkill from matching its own command line), relaunch in the
background, then poll `GET /api/config` until `state == "RUNNING"`.

A clean run starts from an empty service entry (delete leftover `device` subentries via WS
`config_entries/subentries/delete` and clear options ports).

---

## 6. Pre-commit gates

- `ruff check` / `ruff format` (custom-component exceptions: `D10x` docstrings and
  `TID25x` absolute-import/`__future__` rules don’t apply).
- `python -m py_compile` over all modules.
- Translation symmetry: `translations/en.json` keys == `de.json` (custom components
  ship no `strings.json`); placeholder sets per key consistent; **no `{{`** in any
  description; every step has a `description`.
