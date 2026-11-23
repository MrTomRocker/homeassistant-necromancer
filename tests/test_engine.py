"""Level-2 engine state-machine tests (testing.md §3) against a real hass.

Drives the DeviceEngine through its lifecycle with deterministic time-travel
(`async_fire_time_changed`) instead of the flaky live dev runtime: happy path,
max-attempts → escalated, auto-off → escalated, manual recover, cooldown →
suspect, and persistence/restore. A stub health + driver stand in for the real
sources so the *engine* logic is what's under test.

    PYTHONPATH=<ha-core>:<ha-core>/config python tests/test_engine.py
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
import sys
from types import SimpleNamespace
from unittest.mock import patch

from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState
from homeassistant.helpers.event import async_track_point_in_utc_time
import homeassistant.helpers.issue_registry as ir
from homeassistant.util import dt as dt_util

try:
    from pytest_homeassistant.common import (
        MockConfigEntry,
        async_fire_time_changed,
        async_test_home_assistant,
    )
except ImportError:  # core checkouts older than home-assistant/core#187095
    from tests.common import (
        MockConfigEntry,
        async_fire_time_changed,
        async_test_home_assistant,
    )

from custom_components.necromancer import _reconcile_issues, async_remove_entry
from custom_components.necromancer.core.drivers.base import RecoveryDriver
from custom_components.necromancer.core.engine import (
    DeviceEngine,
    GState,
    reset_engine_verdict,
)
from custom_components.necromancer.core.health import heartbeat as hb
from custom_components.necromancer.core.health.base import Health, HealthSource
from custom_components.necromancer.core.health.entity_state import EntityStateHealth
from custom_components.necromancer.core.health.template import TemplateHealth
import custom_components.necromancer.core.notify as notify_mod
from custom_components.necromancer.core.poe import PoeFabric
from custom_components.necromancer.core.policies.notify import NotifyPolicy
from custom_components.necromancer.core.policies.standard import StandardPolicy


class FakeHealth(HealthSource):
    def __init__(self, hass, verdict=Health.OK):
        super().__init__(hass, {})
        self.verdict = verdict

    @property
    def watched_entities(self):
        return []

    def evaluate(self):
        return self.verdict

    async def async_setup(self, on_change):
        return None


class StubDriver(RecoveryDriver):
    def __init__(self, hass, on_recover=None):
        super().__init__(hass, {"type": "stub"})
        self.calls = 0
        self.on_recover = on_recover
        self.raise_it = False
        self.result = True  # driver verdict returned by recover()

    async def can_recover(self):
        return True, ""

    async def recover(self, variables=None):
        self.calls += 1
        if self.raise_it:
            raise RuntimeError("boom")
        if self.on_recover:
            self.on_recover()
        return self.result


def make(hass, health, driver, **behavior):
    b = {
        "debounce": 30,
        "boot_window": 30,
        "cooldown": 30,
        "max_attempts": 2,
        "health_check": True,
    }
    b.update(behavior)
    return DeviceEngine(
        hass, "G", health, driver, StandardPolicy({}), b, subentry_id="g", engines={}
    )


def make_pair(hass, h1, d1, h2, d2, **behavior):
    """Two mutually-linked recover guards sharing one engines registry."""
    b = {
        "debounce": 30,
        "boot_window": 30,
        "cooldown": 30,
        "max_attempts": 2,
        "health_check": True,
    }
    b.update(behavior)
    engines: dict[str, DeviceEngine] = {}
    e1 = DeviceEngine(
        hass,
        "G1",
        h1,
        d1,
        StandardPolicy({}),
        dict(b),
        subentry_id="g1",
        linked_guards=["g2"],
        engines=engines,
    )
    e2 = DeviceEngine(
        hass,
        "G2",
        h2,
        d2,
        StandardPolicy({}),
        dict(b),
        subentry_id="g2",
        linked_guards=["g1"],
        engines=engines,
    )
    engines["g1"], engines["g2"] = e1, e2
    return e1, e2


async def _advance(hass, seconds):
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=seconds))
    await hass.async_block_till_done()


# ---------------- state machine ----------------


async def test_happy_path(hass, _):
    health = FakeHealth(hass, Health.OK)
    driver = StubDriver(hass, on_recover=lambda: setattr(health, "verdict", Health.OK))
    eng = make(hass, health, driver)
    await eng.async_start()
    assert eng.state is GState.OK
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT
    await _advance(hass, 30)  # debounce -> recover -> verify(OK) -> cooldown
    assert eng.state is GState.COOLDOWN, eng.state
    assert eng.recover_count == 1 and driver.calls == 1
    await _advance(hass, 30)  # cooldown -> ok (healthy)
    assert eng.state is GState.OK
    await eng.async_stop()


async def test_max_attempts_escalates(hass, _):
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)  # recover() never fixes health
    eng = make(hass, health, driver, boot_window=0, max_attempts=2)
    await eng.async_start()  # already unhealthy -> suspect
    assert eng.state is GState.SUSPECT
    await _advance(hass, 30)  # debounce -> 2 attempts, both verify-timeout -> escalated
    assert eng.state is GState.ESCALATED, eng.state
    assert driver.calls == 2
    await eng.async_stop()


async def test_raising_driver_is_failed_attempt(hass, _):
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)
    driver.raise_it = True
    eng = make(hass, health, driver, boot_window=0, max_attempts=1)
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.ESCALATED  # raise = failed, not false success
    await eng.async_stop()


async def test_health_check_off_driver_failure_escalates(hass, _):
    # Model B: with no health-check, a driver that reports failure is a failed
    # attempt (not a blind success) -> escalate + fail_count + driver result.
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)
    driver.result = False  # driver runs but reports failure
    eng = make(hass, health, driver, health_check=False, boot_window=0, max_attempts=1)
    await eng.async_start()
    await _advance(hass, 30)  # debounce -> recover (driver failed) -> escalate
    assert eng.state is GState.ESCALATED, eng.state
    assert eng.fail_count == 1 and eng.last_fail is not None
    assert eng.last_recover_driver_result == "failed"
    await eng.async_stop()


async def test_health_check_off_driver_ok_succeeds(hass, _):
    # Model B: no health-check + driver reports good -> success (unchanged path).
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)  # result True
    eng = make(hass, health, driver, health_check=False, max_attempts=1)
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.COOLDOWN
    assert eng.recover_count == 1 and eng.last_recover_driver_result == "good"
    await eng.async_stop()


async def test_fail_count_and_driver_good_on_verify_timeout(hass, _):
    # health-check on, driver runs clean but the device never returns: overall
    # failure (fail_count) yet the *driver* result is good (the diagnostic split).
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)  # never fixes health -> verify times out
    eng = make(hass, health, driver, boot_window=0, max_attempts=1)
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.ESCALATED
    assert eng.fail_count == 1 and eng.last_fail is not None
    assert eng.last_recover_driver_result == "good"  # driver ran; device didn't return
    await eng.async_stop()


async def test_new_fields_persist(hass, _):
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)
    eng = make(hass, health, driver, boot_window=0, max_attempts=1)
    await eng.async_start()
    await _advance(hass, 30)  # escalate -> fail_count, driver result recorded
    snap = eng.snapshot()
    eng2 = make(hass, FakeHealth(hass, Health.OK), StubDriver(hass))
    eng2._apply_persisted(snap)
    assert eng2.fail_count == 1 and eng2.last_fail is not None
    assert eng2.last_recover_driver_result == "good"
    assert eng2.last_cycle_start == eng.last_cycle_start is not None
    await eng.async_stop()


async def test_auto_off_escalates(hass, _):
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)
    eng = make(hass, health, driver)
    eng.auto = False
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.ESCALATED and driver.calls == 0
    await eng.async_stop()


async def test_manual_recover(hass, _):
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass, on_recover=lambda: setattr(health, "verdict", Health.OK))
    eng = make(hass, health, driver, boot_window=0)
    await eng.async_start()
    await eng.async_manual_recover()  # bypass debounce + auto gate
    await hass.async_block_till_done()
    assert driver.calls >= 1 and eng.state in (GState.COOLDOWN, GState.OK)
    await eng.async_stop()


async def test_manual_recover_ignored_while_busy(hass, _):
    # A press while a cycle is in flight must be ignored — not reset `attempt`
    # under the running loop (which would defeat max_attempts).
    health = FakeHealth(hass, Health.UNHEALTHY)
    gate = asyncio.Event()

    class BlockingDriver(StubDriver):
        async def recover(self, variables=None):
            self.calls += 1
            await gate.wait()  # hold the cycle in flight
            health.verdict = Health.OK

    driver = BlockingDriver(hass)
    eng = make(hass, health, driver, boot_window=0)
    await eng.async_start()
    await eng.async_manual_recover()  # spawns the cycle task
    await asyncio.sleep(0.05)  # let it run up to the blocked recover() (don't await it)
    assert eng.state is GState.RECOVERING and driver.calls == 1 and eng.attempt == 1
    await eng.async_manual_recover()  # busy → ignored
    await asyncio.sleep(0.05)
    assert driver.calls == 1 and eng.attempt == 1  # no second cycle, attempt intact
    gate.set()
    await hass.async_block_till_done()  # now the cycle can finish
    assert eng.state in (GState.COOLDOWN, GState.OK)
    await eng.async_stop()


async def test_manual_recover_during_snooze_lifts_snooze(hass, _):
    # A manual-recover press while snoozed must LIFT the snooze and recover — not
    # leave the guard snoozed-but-timerless, deaf to every future health change.
    health = FakeHealth(hass, Health.OK)
    driver = StubDriver(hass, on_recover=lambda: setattr(health, "verdict", Health.OK))
    eng = make(hass, health, driver, boot_window=0)
    await eng.async_start()
    eng.snooze(timedelta(seconds=300))
    assert eng.state is GState.SNOOZED
    await eng.async_manual_recover()
    await hass.async_block_till_done()
    assert eng._snoozed is False  # snooze lifted, not stranded
    await _advance(hass, 30)  # cooldown elapses -> OK (health is OK)
    assert eng.state is GState.OK
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT  # guard is live again, honoring health
    await eng.async_stop()


async def test_manual_recover_while_following_is_ignored(hass, _):
    # In follow-hold we have no cycle task yet, so _busy() is False — a manual
    # recover must still be ignored, not launch a competing cycle (the double
    # recovery linking exists to prevent).
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    d2 = StubDriver(hass)
    _e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.UNHEALTHY),
        StubDriver(hass),
        h2,
        d2,
        boot_window=0,
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")  # enter follow-hold (no cycle task yet)
    assert e2._following is True and not e2._busy()
    await e2.async_manual_recover()  # following -> must be ignored
    await hass.async_block_till_done()
    assert d2.calls == 0  # no competing own recovery ran
    await e2.async_stop()


async def test_cooldown_to_suspect(hass, _):
    health = FakeHealth(hass, Health.OK)
    driver = StubDriver(hass, on_recover=lambda: setattr(health, "verdict", Health.OK))
    eng = make(hass, health, driver)
    await eng.async_start()
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    await _advance(hass, 30)  # -> cooldown
    assert eng.state is GState.COOLDOWN
    health.verdict = Health.UNHEALTHY  # broke again during cooldown
    await _advance(hass, 30)  # cooldown elapsed, still unhealthy -> suspect
    assert eng.state is GState.SUSPECT, eng.state
    await eng.async_stop()


async def test_debounce_blip_absorbed(hass, _):
    health = FakeHealth(hass, Health.OK)
    driver = StubDriver(hass)
    eng = make(hass, health, driver)
    await eng.async_start()
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT
    health.verdict = Health.OK  # recovered before debounce elapsed
    await _advance(hass, 30)
    assert eng.state is GState.OK and driver.calls == 0
    await eng.async_stop()


# ---------------- guard linking + lifecycle ----------------


async def test_linked_follower_recovers_with_leader(hass, _):
    # Shared root cause: the leader's fix heals both. The follower holds (no own
    # cycle) and settles through the same success path (cooldown + a counted stat).
    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)

    def fix_both():
        h1.verdict = Health.OK
        h2.verdict = Health.OK

    d1 = StubDriver(hass, on_recover=fix_both)
    d2 = StubDriver(hass)
    e1, e2 = make_pair(hass, h1, d1, h2, d2)
    await e1.async_start()
    await e2.async_start()
    await e1.async_manual_recover()  # e1 leads, notifies g2 -> e2 follows
    await hass.async_block_till_done()
    assert e1.state is GState.COOLDOWN and e1.recover_count == 1
    assert e2.state is GState.COOLDOWN, e2.state  # follower validated healthy
    assert d2.calls == 0  # follower never launched its own recovery
    assert e2.recover_count == 1  # by design: a settled follower counts a recovery
    await e1.async_stop()
    await e2.async_stop()


async def test_linked_follower_escalates_when_leader_fails(hass, _):
    # Leader can't fix it and the follower is still down -> the follower escalates
    # (no cascade into a competing recovery that would re-trigger the group).
    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    d1 = StubDriver(hass)  # recover() never heals
    d2 = StubDriver(hass)
    e1, e2 = make_pair(hass, h1, d1, h2, d2, boot_window=0, max_attempts=1)
    await e1.async_start()
    await e2.async_start()
    await e1.async_manual_recover()
    await hass.async_block_till_done()
    assert e1.state is GState.ESCALATED
    assert e2.state is GState.ESCALATED, e2.state
    assert d2.calls == 0  # follower never ran a competing recovery
    await e1.async_stop()
    await e2.async_stop()


async def test_linked_auto_off_follower_escalates(hass, _):
    # Auto-off means off: the follower does not silently follow a group repair —
    # if its own device is affected it escalates instead.
    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    d1 = StubDriver(hass, on_recover=lambda: setattr(h1, "verdict", Health.OK))
    d2 = StubDriver(hass)
    e1, e2 = make_pair(hass, h1, d1, h2, d2)
    e2.auto = False
    await e1.async_start()
    await e2.async_start()
    await e1.async_manual_recover()
    await asyncio.sleep(0.05)  # let e1's cycle notify the partner
    assert e2.state is GState.ESCALATED, e2.state
    assert d2.calls == 0
    await hass.async_block_till_done()
    await e1.async_stop()
    await e2.async_stop()


async def test_debounce_arbitration_second_follows(hass, _):
    # Both trip together; the first to clear debounce leads (claims RECOVERING
    # synchronously) and the second follows instead of double-cycling.
    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)

    def fix_both():
        h1.verdict = Health.OK
        h2.verdict = Health.OK

    d1 = StubDriver(hass, on_recover=fix_both)
    d2 = StubDriver(hass, on_recover=fix_both)
    e1, e2 = make_pair(hass, h1, d1, h2, d2)
    await e1.async_start()
    await e2.async_start()
    assert e1.state is GState.SUSPECT and e2.state is GState.SUSPECT
    await _advance(hass, 30)  # both debounce -> one leads, one follows
    assert d1.calls + d2.calls == 1, (d1.calls, d2.calls)  # exactly one cycled
    assert e1.state is GState.COOLDOWN and e2.state is GState.COOLDOWN
    await e1.async_stop()
    await e2.async_stop()


async def test_validate_after_repair_blocks_manual_recover(hass, _):
    # B2: the follow-up verify is tracked as the cycle task, so a button press
    # while verifying is ignored (no second cycle, no _verify_event clobber).
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    d2 = StubDriver(hass)
    e1, e2 = make_pair(
        hass, FakeHealth(hass, Health.OK), StubDriver(hass), h2, d2, boot_window=5
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")  # follow
    assert e2.state is GState.RECOVERING and e2._following is True
    e2._on_partner_repair_done("g1", True)  # schedule validate as the cycle task
    await asyncio.sleep(0.05)  # let validate reach its health wait
    assert e2._busy() and e2.state is GState.VERIFY
    await e2.async_manual_recover()  # busy -> ignored
    await asyncio.sleep(0.02)
    assert d2.calls == 0 and e2._busy()  # no competing cycle started
    h2.verdict = Health.OK
    e2._evaluate()  # fires the verify event
    await hass.async_block_till_done()
    assert e2.state is GState.COOLDOWN and e2.recover_count == 1 and d2.calls == 0
    await e1.async_stop()
    await e2.async_stop()


async def test_async_stop_cancels_validate_no_escalation(hass, _):
    # B2: stopping mid-verify cancels the validate cleanly — no terminal state set
    # on a torn-down engine, link state reset.
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        h2,
        StubDriver(hass),
        boot_window=5,
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")
    e2._on_partner_repair_done("g1", True)
    await asyncio.sleep(0.05)
    assert e2._busy() and e2.state is GState.VERIFY
    await e2.async_stop()  # cancels the validate task
    await asyncio.sleep(0.05)
    assert e2.state is not GState.ESCALATED
    assert e2._following is False and e2._stopping is True
    assert not e2._busy()  # cycle slot cleared
    await hass.async_block_till_done()
    assert e2.state is not GState.ESCALATED  # no late mutation
    await e1.async_stop()


async def test_leader_stop_does_not_escalate_follower(hass, _):
    # B2: a reload/unload cancelling the leader mid-cycle must NOT fire a failed
    # repair to followers (which would escalate them off a half-finished cycle).
    gate = asyncio.Event()

    class BlockingDriver(StubDriver):
        async def recover(self, variables=None):
            self.calls += 1
            await gate.wait()  # hold the leader's cycle in flight

    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    e1, e2 = make_pair(
        hass, h1, BlockingDriver(hass), h2, StubDriver(hass), boot_window=5
    )
    await e1.async_start()
    await e2.async_start()
    await e1.async_manual_recover()
    await asyncio.sleep(0.05)  # e1 blocked in recover(); e2 following
    assert e1._busy() and e2._following is True and e2.state is GState.RECOVERING
    await e1.async_stop()  # cancel the leader mid-recover
    await asyncio.sleep(0.05)
    assert e2.state is not GState.ESCALATED  # finally skipped the partner notify
    assert e2._following is True  # never notified -> still holding
    gate.set()
    await e2.async_stop()
    assert e2._following is False
    await hass.async_block_till_done()


async def test_notify_only_guard_ignores_partner_start(hass, _):
    # A notify-only guard (allows_recovery False) is excluded from group repair.
    eng = DeviceEngine(
        hass,
        "N",
        FakeHealth(hass, Health.UNHEALTHY),
        StubDriver(hass),
        NotifyPolicy({}),
        {"debounce": 30},
        subentry_id="n",
        engines={},
    )
    eng._on_partner_repair_start("x")
    assert eng._following is False and eng.state is GState.OK
    await eng.async_stop()


async def test_partner_start_auto_off_but_healthy_no_escalation(hass, _):
    # Auto off + our own device is fine when a partner repairs: we neither follow
    # nor escalate — nothing is wrong with us.
    _e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
    )
    e2.auto = False
    await e2.async_start()
    e2._on_partner_repair_start("g1")
    assert e2._following is False and e2.state is GState.OK
    await e2.async_stop()


async def test_partner_done_ignored_when_not_following(hass, _):
    # A done-notification we never followed (or from a different leader) is a no-op.
    _e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
    )
    await e2.async_start()
    e2._on_partner_repair_done("g1", True)  # not following -> ignored
    assert e2.state is GState.OK and not e2._busy()
    e2._on_partner_repair_start("g1")  # now following g1
    e2._on_partner_repair_done("other", True)  # wrong leader -> ignored
    assert e2._following is True
    await e2.async_stop()


async def test_find_repairing_partner_skips_follower(hass, _):
    # A partner that is itself only FOLLOWING is not a leader to follow.
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.UNHEALTHY),
        StubDriver(hass),
        FakeHealth(hass, Health.UNHEALTHY),
        StubDriver(hass),
    )
    await e1.async_start()
    await e2.async_start()
    e1._set_state(GState.RECOVERING)
    e1._following = True  # recovering, but only as a follower
    assert e2._find_repairing_partner() is None
    e1._following = False
    assert e2._find_repairing_partner() is e1  # now a genuine leader
    await e1.async_stop()
    await e2.async_stop()


async def test_validate_follower_still_down_does_own_recovery(hass, _):
    # Leader fixed its device but ours is still down -> fall back to our own
    # recovery (not escalation): the "still unhealthy, leader succeeded" branch.
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    d2 = StubDriver(hass, on_recover=lambda: setattr(h2, "verdict", Health.OK))
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        h2,
        d2,
        boot_window=0,
        debounce=1,
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")
    e2._on_partner_repair_done("g1", True)  # leader ok, but h2 still unhealthy
    await hass.async_block_till_done()  # validate -> OK -> _evaluate -> own SUSPECT
    assert e2.state is GState.SUSPECT, e2.state
    await _advance(hass, 1)  # own debounce -> recover -> verify ok -> cooldown
    assert d2.calls == 1 and e2.state is GState.COOLDOWN
    await e1.async_stop()
    await e2.async_stop()


class ConfirmedFakeHealth(FakeHealth):
    """A fake whose fault is confirmed (like a heartbeat's failure ping)."""

    def confirmed(self):
        return self.verdict == Health.UNHEALTHY


async def test_validate_follower_confirmed_fault_starts_own_recovery(hass, _):
    # A follower whose fault is confirmed (a failure ping arrived while it held for
    # the leader) skips the debounce, so _evaluate starts its own cycle from inside
    # validate_after_repair. That must not be swallowed by the validate task still
    # holding the cycle slot (stuck in SUSPECT with no timer, no repair, no alarm).
    h2 = ConfirmedFakeHealth(hass, Health.OK)
    d2 = StubDriver(hass, on_recover=lambda: setattr(h2, "verdict", Health.OK))
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        h2,
        d2,
        boot_window=0,
        debounce=3600,
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")
    h2.verdict = Health.UNHEALTHY  # failure ping while following: only stored
    e2._evaluate()
    assert e2.state is GState.RECOVERING and d2.calls == 0
    e2._on_partner_repair_done("g1", True)  # leader ok, but h2 still failed
    await hass.async_block_till_done()  # validate -> OK -> own cycle at once
    assert d2.calls == 1, (d2.calls, e2.state)
    assert e2.state is GState.COOLDOWN, e2.state
    assert not e2._busy()  # the cycle finished and released its slot
    await e1.async_stop()
    await e2.async_stop()


async def test_validate_follower_confirmed_fault_escalates_and_notifies(hass, _):
    # Same handoff, but the follower's own repair cannot fix it: the fallback cycle
    # must still run to its end and raise the alarm instead of idling in SUSPECT.
    h2 = ConfirmedFakeHealth(hass, Health.OK)
    d2 = StubDriver(hass)
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.OK),
        StubDriver(hass),
        h2,
        d2,
        boot_window=0,
        debounce=3600,
        max_attempts=1,
        notify_action=[{"action": "test.sink"}],
    )
    with _NotifySink() as sent:
        await e2.async_start()
        e2._on_partner_repair_start("g1")
        h2.verdict = Health.UNHEALTHY
        e2._on_partner_repair_done("g1", True)
        await hass.async_block_till_done()
        assert d2.calls == 1, (d2.calls, e2.state)
        assert e2.state is GState.ESCALATED, e2.state
        assert [v["event"] for v in sent] == [
            "recovery_attempt",
            "recovery_failed",
        ], sent
    await e1.async_stop()
    await e2.async_stop()


async def test_suspect_clears_on_health_event(hass, _):
    # SUSPECT -> OK when health recovers via an event (not via the debounce timer).
    health = FakeHealth(hass, Health.OK)
    eng = make(hass, health, StubDriver(hass))
    await eng.async_start()
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT
    health.verdict = Health.OK
    eng._evaluate()  # health-event recovery cancels the timer + clears suspect
    assert eng.state is GState.OK
    await eng.async_stop()


async def test_following_guard_holds_on_health_change(hass, _):
    # While following, our own health dropping does NOT launch a competing cycle.
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    _e1, e2 = make_pair(
        hass, FakeHealth(hass, Health.OK), StubDriver(hass), h2, StubDriver(hass)
    )
    await e2.async_start()
    e2._on_partner_repair_start("g1")  # follow -> RECOVERING, _following
    h2.verdict = Health.OK
    e2._evaluate()  # following -> just emit, no transition
    assert e2._following is True and e2.state is GState.RECOVERING
    await e2.async_stop()


async def test_notify_only_debounce_problem_detected(hass, _):
    # A notify-only guard reports a confirmed problem and goes ESCALATED.
    health = FakeHealth(hass, Health.UNHEALTHY)
    eng = DeviceEngine(
        hass,
        "N",
        health,
        StubDriver(hass),
        NotifyPolicy({}),
        {"debounce": 1},
        subentry_id="n",
        engines={},
    )
    await eng.async_start()
    assert eng.state is GState.SUSPECT
    await _advance(hass, 1)  # debounce -> observe -> problem_detected -> escalated
    assert eng.state is GState.ESCALATED
    await eng.async_stop()


async def test_raising_driver_retries_then_escalates(hass, _):
    # A raising recover() is a failed attempt: retry up to max, then escalate.
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)
    driver.raise_it = True
    eng = make(hass, health, driver, boot_window=0, max_attempts=2)
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.ESCALATED and driver.calls == 2  # raised twice
    await eng.async_stop()


async def test_debounce_follows_recovering_partner(hass, _):
    # Arbitration via the debounce path: a partner already RECOVERING (that didn't
    # notify us) is picked up by _find_repairing_partner and we follow it.
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    e1, e2 = make_pair(
        hass,
        FakeHealth(hass, Health.UNHEALTHY),
        StubDriver(hass),
        h2,
        StubDriver(hass),
        debounce=1,
    )
    await e2.async_start()  # e2 -> SUSPECT
    e1._set_state(GState.RECOVERING)  # e1 recovering, but never notified e2
    await _advance(hass, 1)  # e2 debounce -> finds repairing partner -> follows
    assert e2._following is True and e2.state is GState.RECOVERING
    assert e2.driver.calls == 0  # followed instead of cycling
    await e1.async_stop()
    await e2.async_stop()


async def test_plain_strategy_success_without_verify(hass, _):
    # A plain (no health-check) strategy counts success as soon as recover() runs.
    health = FakeHealth(hass, Health.UNHEALTHY)
    driver = StubDriver(hass)  # does NOT change health -> success is assumed
    eng = make(hass, health, driver, health_check=False)
    await eng.async_start()
    await _advance(hass, 30)  # debounce -> recover -> immediate success (no verify)
    assert eng.state is GState.COOLDOWN and eng.recover_count == 1 and driver.calls == 1
    await eng.async_stop()


async def test_malformed_timing_falls_back_to_default(hass, _):
    # A non-numeric behaviour value must not crash; _int falls back to the default.
    health = FakeHealth(hass, Health.OK)
    eng = make(hass, health, StubDriver(hass), debounce="not-a-number")
    await eng.async_start()
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT  # used the default debounce, no crash
    await eng.async_stop()


# ---------------- persistence ----------------


async def test_persistence_escalated_stays(hass, _):
    snap = {"state": "escalated", "attempt": 2, "recover_count": 3, "auto": False}
    health = FakeHealth(hass, Health.UNHEALTHY)
    eng = DeviceEngine(
        hass,
        "G",
        health,
        StubDriver(hass),
        StandardPolicy({}),
        {"debounce": 30},
        subentry_id="g",
        engines={},
        persisted=snap,
    )
    assert eng.state is GState.ESCALATED  # restored, no free retry
    assert eng.recover_count == 3 and eng.auto is False
    await eng.async_start()
    await hass.async_block_till_done()
    assert eng.state is GState.ESCALATED  # still unhealthy -> stays
    await eng.async_stop()


async def test_persistence_escalated_autoclears(hass, _):
    snap = {"state": "escalated", "attempt": 1, "recover_count": 1, "auto": True}
    health = FakeHealth(hass, Health.OK)  # healthy again at restart
    eng = DeviceEngine(
        hass,
        "G",
        health,
        StubDriver(hass),
        StandardPolicy({}),
        {"debounce": 30},
        subentry_id="g",
        engines={},
        persisted=snap,
    )
    assert eng.state is GState.ESCALATED
    await eng.async_start()  # _evaluate: escalated + healthy -> ok
    await hass.async_block_till_done()
    assert eng.state is GState.OK
    await eng.async_stop()


async def test_snapshot_roundtrip(hass, _):
    health = FakeHealth(hass, Health.OK)
    eng = make(hass, health, StubDriver(hass))
    eng.recover_count = 5
    eng.auto = False
    snap = eng.snapshot()
    assert snap["recover_count"] == 5 and snap["auto"] is False
    assert "resolved_port" not in snap  # dropped in the fabric refactor (H1b)
    await eng.async_stop()


async def test_reload_device_entry_on_repair(hass, _):
    from homeassistant.helpers import device_registry as dr

    entry = MockConfigEntry(domain="demo")
    entry.add_to_hass(hass)
    # Identifier tied to the (per-run unique) entry_id so the shared/persisted test
    # device registry can't accumulate config entries on a fixed device across runs.
    dev = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={("demo", entry.entry_id)}
    )
    reloaded: list[str] = []

    async def _fake_reload(eid):
        reloaded.append(eid)

    orig = hass.config_entries.async_reload
    hass.config_entries.async_reload = _fake_reload
    try:
        eng = DeviceEngine(
            hass,
            "RL",
            FakeHealth(hass),
            StubDriver(hass),
            StandardPolicy({}),
            {"reload_entry": True, "reload_delay": 0},
            link_device_id=dev.id,
            subentry_id="rl",
            engines={},
        )
        await eng._maybe_reload_device_entry()
        assert reloaded == [entry.entry_id], reloaded
        # flag off -> no reload
        reloaded.clear()
        eng2 = DeviceEngine(
            hass,
            "RL2",
            FakeHealth(hass),
            StubDriver(hass),
            StandardPolicy({}),
            {},
            link_device_id=dev.id,
            subentry_id="rl2",
            engines={},
        )
        await eng2._maybe_reload_device_entry()
        assert reloaded == [], reloaded
    finally:
        hass.config_entries.async_reload = orig


async def test_escalate_blocked_no_recovered_error(hass, _):
    import logging

    records: list[tuple[int, str]] = []

    class _Cap(logging.Handler):
        def emit(self, record):
            records.append((record.levelno, record.getMessage()))

    cap = _Cap()
    logger = logging.getLogger("custom_components.necromancer")
    logger.addHandler(cap)
    try:
        eng = make(hass, FakeHealth(hass), StubDriver(hass))
        # blocked (pre-flight refusal): no "could not be recovered after N" error
        eng._escalate("recovery_blocked", reason="no port matches")
        await hass.async_block_till_done()
        assert not any("could not be recovered" in m for _, m in records), records
        # genuine failure: ERROR with the give-up message
        records.clear()
        eng._escalate()
        await hass.async_block_till_done()
        assert any(
            lvl == logging.ERROR and "could not be recovered" in m for lvl, m in records
        ), records
    finally:
        logger.removeHandler(cap)


async def test_raising_driver_warns_on_retry_traces_on_final(hass, _):
    import logging

    records: list[logging.LogRecord] = []

    class _Cap(logging.Handler):
        def emit(self, record):
            records.append(record)

    cap = _Cap()
    logger = logging.getLogger("custom_components.necromancer")
    logger.addHandler(cap)
    eng = None
    try:
        driver = StubDriver(hass)
        driver.raise_it = True
        eng = make(
            hass,
            FakeHealth(hass, Health.UNHEALTHY),
            driver,
            boot_window=0,
            max_attempts=2,
        )
        await eng.async_start()
        await _advance(hass, 60)  # debounce -> attempt 1 (retry) -> attempt 2 (final)
        assert eng.state is GState.ESCALATED, eng.state
        msgs = [(r.levelno, r.getMessage(), r.exc_info is not None) for r in records]
        # non-final attempt: WARNING, no traceback
        retry = [
            m for m in msgs if m[0] == logging.WARNING and "attempt 1/2 failed" in m[1]
        ]
        assert retry and retry[0][2] is False, msgs
        # final attempt: ERROR with traceback
        final = [m for m in msgs if "Recovery driver failed" in m[1]]
        assert final and final[0][0] == logging.ERROR and final[0][2] is True, msgs
    finally:
        logger.removeHandler(cap)
        if eng:
            await eng.async_stop()


async def test_follower_success_notify_gated(hass, _):
    notified: list[str] = []

    async def _rec(key, **kw):
        notified.append(key)

    # follower (via_link) + flag off (default) -> silent on success
    eng = make(hass, FakeHealth(hass), StubDriver(hass))
    eng._notify = _rec
    eng._recover_success(via_link=True)
    await hass.async_block_till_done()
    assert "recovery_success" not in notified, notified

    # follower (via_link) + flag on -> notifies
    notified.clear()
    eng2 = make(hass, FakeHealth(hass), StubDriver(hass), notify_follower_success=True)
    eng2._notify = _rec
    eng2._recover_success(via_link=True)
    await hass.async_block_till_done()
    assert "recovery_success" in notified, notified

    # leader / independent recovery (not via_link) -> always notifies
    notified.clear()
    eng3 = make(hass, FakeHealth(hass), StubDriver(hass))
    eng3._notify = _rec
    eng3._recover_success()
    await hass.async_block_till_done()
    assert "recovery_success" in notified, notified


async def test_ok_to_blind_on_unknown(hass, _):
    # Health unknown while monitoring -> a distinct `blind` status (not a stale ok),
    # and no recovery (unknown is never a fault).
    health = FakeHealth(hass, Health.OK)
    driver = StubDriver(hass)
    eng = make(hass, health, driver)
    await eng.async_start()
    assert eng.state is GState.OK
    health.verdict = Health.UNKNOWN
    eng._evaluate()
    assert eng.state is GState.BLIND
    assert driver.calls == 0
    await eng.async_stop()


async def test_blind_back_to_ok_on_healthy(hass, _):
    health = FakeHealth(hass, Health.UNKNOWN)
    eng = make(hass, health, StubDriver(hass))
    await eng.async_start()
    assert eng.state is GState.BLIND  # starts blind: health unknown
    health.verdict = Health.OK
    eng._evaluate()
    assert eng.state is GState.OK
    await eng.async_stop()


async def test_blind_to_suspect_on_unhealthy(hass, _):
    health = FakeHealth(hass, Health.UNKNOWN)
    eng = make(hass, health, StubDriver(hass))
    await eng.async_start()
    assert eng.state is GState.BLIND
    health.verdict = Health.UNHEALTHY
    eng._evaluate()
    assert eng.state is GState.SUSPECT  # re-detected unhealthy -> debounce -> recovery
    await eng.async_stop()


async def test_unknown_during_recovery_holds(hass, _):
    # Mid-recovery the device reads unknown (rebooting) -> hold, never blind.
    health = FakeHealth(hass, Health.UNKNOWN)
    eng = make(hass, health, StubDriver(hass))
    await eng.async_start()
    eng._set_state(GState.RECOVERING)
    eng._evaluate()
    assert eng.state is GState.RECOVERING
    await eng.async_stop()


async def test_template_missing_entity_warns_not_blind(hass, _):
    # A template that DEFAULTS a missing entity renders a concrete verdict, so the
    # guard isn't blind — warn about the missing entity, don't claim "blind".
    health = TemplateHealth(
        hass, {"template": "{{ states('sensor.gone')|float(0) > 150 }}"}
    )
    eng = make(hass, health, StubDriver(hass))
    keys = {p["key"] for p in eng.config_problems()}
    assert "health_template_missing_entity" in keys
    assert "health_template_blind" not in keys


async def test_template_truly_blind(hass, _):
    # A template that yields unknown (no usable value) is genuinely blind.
    health = TemplateHealth(hass, {"template": "{{ states('sensor.gone') }}"})
    eng = make(hass, health, StubDriver(hass))
    keys = {p["key"] for p in eng.config_problems()}
    assert "health_template_blind" in keys
    assert "health_template_missing_entity" not in keys


async def test_template_unavailable_input_not_blind(hass, _):
    # Boot / offline: the template's input EXISTS but reads `unavailable` -> verdict
    # UNKNOWN, yet it's not a CONFIG problem (the entity is there, just not ready) and
    # must NOT raise a "blind" repair issue. Regression for the false issues that hit
    # almost every guard on restart (validation runs at HA-started, before inputs settle).
    hass.states.async_set("sensor.flaky", "unavailable")
    health = TemplateHealth(hass, {"template": "{{ states('sensor.flaky') }}"})
    eng = make(hass, health, StubDriver(hass))
    assert health.evaluate() == Health.UNKNOWN  # genuinely blind right now …
    keys = {p["key"] for p in eng.config_problems()}
    assert "health_template_blind" not in keys  # … but NOT a config problem
    assert "health_template_missing_entity" not in keys


async def test_reconcile_creates_and_clears_config_issue(hass, _):
    # A guard whose health entity doesn't exist -> blind -> a repair issue; once
    # the entity exists, re-reconciling clears it (self-healing on reload).
    health = EntityStateHealth(hass, {"entity_id": "sensor.ghost"})
    eng = make(hass, health, StubDriver(hass))
    fabric = PoeFabric(hass)
    _reconcile_issues(hass, {"g": eng}, fabric)
    assert ("necromancer", "g_health_entity_missing") in ir.async_get(hass).issues
    hass.states.async_set("sensor.ghost", "on")  # entity exists now -> fixed
    _reconcile_issues(hass, {"g": eng}, fabric)
    assert ("necromancer", "g_health_entity_missing") not in ir.async_get(hass).issues


async def test_reconcile_clears_issue_for_removed_guard(hass, _):
    # Deleting a guard subentry (its engine gone) must clear its stale repair issue.
    health = EntityStateHealth(hass, {"entity_id": "sensor.ghost2"})
    eng = make(hass, health, StubDriver(hass))
    fabric = PoeFabric(hass)
    _reconcile_issues(hass, {"g": eng}, fabric)
    assert ("necromancer", "g_health_entity_missing") in ir.async_get(hass).issues
    _reconcile_issues(hass, {}, fabric)  # subentry deleted -> no engines
    assert ("necromancer", "g_health_entity_missing") not in ir.async_get(hass).issues


async def test_remove_entry_clears_issues(hass, _):
    # Deleting the whole integration must drop its repair issues immediately.
    health = EntityStateHealth(hass, {"entity_id": "sensor.ghost3"})
    eng = make(hass, health, StubDriver(hass))
    _reconcile_issues(hass, {"g": eng}, PoeFabric(hass))
    assert ("necromancer", "g_health_entity_missing") in ir.async_get(hass).issues
    # Only entry_id is read (to drop the entry's heartbeat tokens).
    await async_remove_entry(hass, SimpleNamespace(entry_id="e"))
    assert ("necromancer", "g_health_entity_missing") not in ir.async_get(hass).issues


# ---------------- heartbeat source (real HeartbeatHealth, patched clock) ----------------

# period 1 h -> deadline 3600 s after the last success; the grace after a missed
# ping is the engine's debounce (10 min here), not part of the source's verdict.
_HB_PERIOD, _HB_GRACE = 3600, 600


class _HbClock:
    """Time travel for the heartbeat source.

    The source judges with dt_util.utcnow(), which async_fire_time_changed does not
    move, so patch it to a clock that advances together with the fired timers.

    The engine's own timers (debounce = the heartbeat's grace, cooldown, snooze)
    use async_call_later, which counts on the loop clock: async_fire_time_changed
    compares its delay with the whole distance travelled so far, so a 10-minute
    debounce armed after an hour of travel would fire on the next tick. Inside
    the clock they run as a point in (patched) UTC time instead, which fires
    exactly when this clock passes it.
    """

    def __init__(self):
        self.now = dt_util.utcnow()
        self._patches = [
            patch("homeassistant.util.dt.utcnow", side_effect=lambda: self.now),
            patch(
                "custom_components.necromancer.core.engine.async_call_later",
                side_effect=self._call_later,
            ),
        ]

    def _call_later(self, hass, delay, action):
        if isinstance(delay, timedelta):
            delay = delay.total_seconds()
        return async_track_point_in_utc_time(
            hass, action, self.now + timedelta(seconds=delay)
        )

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in reversed(self._patches):
            p.stop()

    async def advance(self, hass, seconds):
        self.now += timedelta(seconds=seconds)
        async_fire_time_changed(hass, self.now)
        await hass.async_block_till_done()


class _NotifySink:
    """Capture the variables every notify action would receive."""

    def __init__(self):
        self.sent: list[dict] = []
        self._orig = None

    def __enter__(self):
        async def _cap(_hass, _action, _name, variables=None):
            self.sent.append(dict(variables or {}))
            return {}

        self._orig = notify_mod.async_run
        notify_mod.async_run = _cap
        return self.sent

    def __exit__(self, *exc):
        notify_mod.async_run = self._orig


class BlockedDriver(StubDriver):
    """A driver whose pre-flight check refuses (recovery_blocked)."""

    async def can_recover(self):
        """Refuse: the recovery action is missing."""
        return False, "no action"


def _hb_source(hass, pair):
    token = pair * 32
    return hb.HeartbeatHealth(
        hass, {"type": "heartbeat", "token": token, "period": _HB_PERIOD}
    )


def _hb_engine(hass, health, policy=None, driver=None, persisted=None, save=None, **b):
    behavior = {
        "debounce": _HB_GRACE,
        "boot_window": 0,
        "cooldown": 30,
        "max_attempts": 2,
        "health_check": True,
        "notify_action": [{"action": "test.sink"}],
    }
    behavior.update(b)
    return DeviceEngine(
        hass,
        "G",
        health,
        driver or StubDriver(hass),
        policy or NotifyPolicy({}),
        behavior,
        subentry_id="hb",
        engines={},
        persisted=persisted,
        save=save,
    )


async def test_hb_deadline_problem_detected_with_detail(hass, _):
    """Deadline passes -> SUSPECT -> debounce (the grace) -> problem_detected."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a1")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        # a new guard starts grey, waiting for its first success
        assert eng.state is GState.BLIND
        assert eng.health_detail == "Waiting for the first heartbeat."
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK and eng.health_detail is None
        await clock.advance(hass, _HB_PERIOD)  # exactly on the deadline
        assert eng.state is GState.OK
        await clock.advance(hass, 1)  # the source's own timer -> SUSPECT
        assert eng.state is GState.SUSPECT and sent == []
        # The grace counts from the deadline, not from the timer's margin second.
        await clock.advance(hass, _HB_GRACE - 2)  # grace not over yet
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 1)  # deadline + debounce -> notify-only -> ESCALATED
        assert eng.state is GState.ESCALATED
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        detail = "No heartbeat for 70 minutes, expected every 60 minutes."
        assert sent[0]["health_detail"] == detail, sent[0]
        assert sent[0]["event_text"] == f"Problem detected. {detail}", sent[0]
        assert sent[0]["message"] == f"G: Problem detected. {detail}", sent[0]
        # the text is the one at the finding: it does not drift as time passes
        await clock.advance(hass, 5 * 3600)
        assert eng.health_detail == detail and len(sent) == 1
        await eng.async_stop()


async def test_hb_ping_within_grace_back_to_ok_silently(hass, _):
    """Overdue -> SUSPECT; the late ping arrives within the debounce -> OK, no alarm."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "c1")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        await clock.advance(hass, _HB_PERIOD + 1)
        assert eng.state is GState.SUSPECT
        await clock.advance(hass, _HB_GRACE - 60)
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK
        # the debounce timer is gone: nothing fires once the grace would be over
        await clock.advance(hass, 120)
        assert eng.state is GState.OK and sent == []
        await eng.async_stop()


async def test_hb_failure_ping_from_ok_reacts_at_once(hass, _):
    """OK -> failure ping -> ESCALATED + problem_detected without the debounce."""
    with _HbClock(), _NotifySink() as sent:
        src = _hb_source(hass, "c2")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK
        await src.async_handle_ping(False, "3")
        assert eng.state is GState.ESCALATED
        await hass.async_block_till_done()
        assert [(v["event"], v["health_detail"]) for v in sent] == [
            ("problem_detected", "Failure reported, exit code 3.")
        ], sent
        # a success afterwards makes the guard OK again
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK
        await eng.async_stop()


async def test_hb_failure_ping_while_suspect_cuts_the_grace(hass, _):
    """Overdue (SUSPECT, debounce running) + failure ping -> ESCALATED at once."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "c3")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        await clock.advance(hass, _HB_PERIOD + 1)
        assert eng.state is GState.SUSPECT
        await src.async_handle_ping(False, "TERM")
        assert eng.state is GState.ESCALATED
        await hass.async_block_till_done()
        assert [(v["event"], v["health_detail"]) for v in sent] == [
            ("problem_detected", "Failure reported, code TERM.")
        ], sent
        # the cancelled debounce timer does not fire a second alarm later
        await clock.advance(hass, _HB_GRACE + 5)
        assert eng.state is GState.ESCALATED and len(sent) == 1
        await eng.async_stop()


async def test_hb_never_succeeded_waits_then_alarms(hass, _):
    """No success ever: BLIND until armed_at + period, then SUSPECT, then alarm."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "c4")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        assert eng.state is GState.BLIND
        await clock.advance(hass, _HB_PERIOD)  # exactly on the deadline
        assert eng.state is GState.BLIND
        await clock.advance(hass, 1)
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, _HB_GRACE)
        assert eng.state is GState.ESCALATED
        assert [(v["event"], v["health_detail"]) for v in sent] == [
            ("problem_detected", "Never reported success, set up 70 minutes ago.")
        ], sent
        await eng.async_stop()


def _hb_stored(src, last_ok, state="ok"):
    """Persisted guard data whose last success was at `last_ok`."""
    source = hb.apply_ping(
        hb.reconcile_token({}, src.token, last_ok)[0], True, None, last_ok
    )
    return {"state": state, "source": source}


async def _hb_reload(hass, eng, pair, **kw):
    """Stop the engine and start a fresh one from its snapshot (entry reload)."""
    stored = eng.snapshot()
    await eng.async_stop()
    src = _hb_source(hass, pair)
    eng = _hb_engine(hass, src, persisted=stored, **kw)
    await eng.async_start()
    return src, eng


async def test_hb_restart_overdue_reenters_suspect(hass, _):
    """Restart with an overdue guard (not escalated) -> SUSPECT, the rest of the grace.

    The grace counts from the deadline, not from the start: a sender retry inside
    what is left of it makes the guard OK again without an alarm; without one the
    alarm comes at deadline + debounce, not a full debounce after the start.
    """
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "c5")
        before = clock.now - timedelta(seconds=_HB_PERIOD + 300)
        eng = _hb_engine(hass, src, persisted=_hb_stored(src, before))
        await eng.async_start()
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 60)
        await src.async_handle_ping(True, None)  # the sender's retry
        assert eng.state is GState.OK
        await clock.advance(hass, _HB_GRACE)
        assert eng.state is GState.OK and sent == []
        await eng.async_stop()
        # Without a retry only the remaining 300 s of the grace are waited out.
        src2 = _hb_source(hass, "c6")
        before = clock.now - timedelta(seconds=_HB_PERIOD + 300)
        eng2 = _hb_engine(hass, src2, persisted=_hb_stored(src2, before))
        await eng2.async_start()
        assert eng2.state is GState.SUSPECT
        await clock.advance(hass, 299)
        assert eng2.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 1)  # deadline + debounce
        assert eng2.state is GState.ESCALATED
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await eng2.async_stop()


async def test_hb_reload_in_grace_keeps_the_alarm_time(hass, _):
    """Reloads during the grace do not postpone the alarm past deadline + debounce."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "d1")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        alarm_at = clock.now + timedelta(seconds=_HB_PERIOD + _HB_GRACE)
        await clock.advance(hass, _HB_PERIOD + 1)
        assert eng.state is GState.SUSPECT
        for _i in range(2):  # every reload used to restart the full debounce
            await clock.advance(hass, 250)
            src, eng = await _hb_reload(hass, eng, "d1")
            assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, (alarm_at - clock.now).total_seconds() - 1)
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 1)
        assert eng.state is GState.ESCALATED
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await eng.async_stop()


async def test_hb_reload_in_grace_late_ping_still_silent(hass, _):
    """After a reload in the grace, a ping within what is left of it -> OK, silent."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "d2")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        await clock.advance(hass, _HB_PERIOD + 1)
        await clock.advance(hass, 300)
        src, eng = await _hb_reload(hass, eng, "d2")
        assert eng.state is GState.SUSPECT
        await clock.advance(hass, _HB_GRACE - 302)  # one second of grace left
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK
        await clock.advance(hass, _HB_GRACE)
        assert eng.state is GState.OK and sent == []
        await eng.async_stop()


async def test_hb_restart_after_grace_reacts_at_once(hass, _):
    """A long outage used up the grace: the alarm comes right after the start.

    "A deadline is a deadline": a sender retry a moment later turns the guard OK
    again, but the alarm is already out.
    """
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "d3")
        before = clock.now - timedelta(seconds=_HB_PERIOD + _HB_GRACE + 3600)
        eng = _hb_engine(hass, src, persisted=_hb_stored(src, before))
        await eng.async_start()
        assert eng.state is GState.ESCALATED  # no time passed at all
        await hass.async_block_till_done()
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await clock.advance(hass, 1)
        await src.async_handle_ping(True, None)  # the retry, one second too late
        assert eng.state is GState.OK and len(sent) == 1
        await eng.async_stop()
        # Exactly at deadline + debounce counts as used up too.
        src2 = _hb_source(hass, "d4")
        before = clock.now - timedelta(seconds=_HB_PERIOD + _HB_GRACE)
        eng2 = _hb_engine(hass, src2, persisted=_hb_stored(src2, before))
        await eng2.async_start()
        assert eng2.state is GState.ESCALATED
        await eng2.async_stop()


async def test_hb_restart_after_grace_starts_recovery_at_once(hass, _):
    """With a repair action the cycle starts right after the start, too."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "d5")
        driver = StubDriver(
            hass,
            on_recover=lambda: hass.async_create_task(
                src.async_handle_ping(True, None)
            ),
        )
        before = clock.now - timedelta(seconds=_HB_PERIOD + _HB_GRACE + 60)
        eng = _hb_engine(
            hass,
            src,
            StandardPolicy({}),
            driver,
            persisted=_hb_stored(src, before),
            boot_window=30,
        )
        await eng.async_start()
        await clock.advance(hass, 1)
        assert driver.calls == 1 and eng.state is GState.COOLDOWN, eng.state
        assert [v["event"] for v in sent] == [
            "recovery_attempt",
            "recovery_success",
        ], sent
        await eng.async_stop()


async def test_hb_bootstrap_waits_only_the_remaining_grace(hass, _):
    """Overdue at boot: nothing until HA started, then only what is left of the grace.

    The time spent in bootstrap counts: the deadline is the same with or without
    the restart.
    """
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "d6")
        before = clock.now - timedelta(seconds=_HB_PERIOD + 300)
        hass.set_state(CoreState.starting)
        try:
            eng = _hb_engine(hass, src, persisted=_hb_stored(src, before))
            await eng.async_start()
            assert eng.state is GState.SUSPECT
            await clock.advance(hass, 100)  # a slow bootstrap
            assert eng.state is GState.SUSPECT and sent == []
        finally:
            hass.set_state(CoreState.running)
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await hass.async_block_till_done()
        assert eng.state is GState.SUSPECT
        await clock.advance(hass, _HB_GRACE - 400 - 1)
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 1)
        assert eng.state is GState.ESCALATED
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await eng.async_stop()
        # A bootstrap longer than what was left of the grace: react once started.
        src2 = _hb_source(hass, "d7")
        before = clock.now - timedelta(seconds=_HB_PERIOD + 300)
        hass.set_state(CoreState.starting)
        try:
            eng2 = _hb_engine(hass, src2, persisted=_hb_stored(src2, before))
            await eng2.async_start()
            await clock.advance(hass, 400)
            assert eng2.state is GState.SUSPECT and len(sent) == 1
        finally:
            hass.set_state(CoreState.running)
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await hass.async_block_till_done()
        assert eng2.state is GState.ESCALATED and len(sent) == 2
        await eng2.async_stop()


def _hb_repair_engine(hass, src, driver, **b):
    """A repairing heartbeat guard; no health check unless given (an action)."""
    b.setdefault("health_check", False)
    return _hb_engine(hass, src, StandardPolicy({}), driver, **b)


async def _hb_first_repair(hass, clock, src, eng):
    """Ping, let the deadline and the whole grace pass: the first cycle runs."""
    await eng.async_start()
    await src.async_handle_ping(True, None)
    await clock.advance(hass, _HB_PERIOD + 1)
    assert eng.state is GState.SUSPECT
    await clock.advance(hass, _HB_GRACE - 1)  # deadline + debounce


async def test_hb_still_overdue_after_repair_waits_cooldown_and_grace(hass, _):
    """A repair without check while the sender stays silent: no repair loop.

    The grace counts again from the end of the cooldown, as for any source: the
    next cycle comes a full debounce after it, not right at the cooldown end
    (the deadline's grace is long used up by then).
    """
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "e1")
        driver = StubDriver(hass)
        eng = _hb_repair_engine(hass, src, driver, cooldown=300)
        await _hb_first_repair(hass, clock, src, eng)
        assert driver.calls == 1 and eng.state is GState.COOLDOWN, eng.state
        await clock.advance(hass, 300)  # cooldown over, still overdue
        assert eng.state is GState.SUSPECT and driver.calls == 1
        await clock.advance(hass, _HB_GRACE - 1)
        assert eng.state is GState.SUSPECT and driver.calls == 1
        await clock.advance(hass, 1)
        assert driver.calls == 2, eng.state
        assert [v["event"] for v in sent] == [
            "recovery_attempt",
            "recovery_success",
        ] * 2, sent
        await eng.async_stop()


async def test_hb_reload_in_cooldown_does_not_repair_at_once(hass, _):
    """COOLDOWN is not persisted: a reload in it comes back OK, then SUSPECT.

    The fault is older than the debounce, yet the repair just made earns the
    full debounce again — from the reload, since the cooldown end lies ahead.
    """
    with _HbClock() as clock, _NotifySink():
        src = _hb_source(hass, "e2")
        eng = _hb_repair_engine(hass, src, StubDriver(hass), cooldown=300)
        await _hb_first_repair(hass, clock, src, eng)
        assert eng.state is GState.COOLDOWN
        await clock.advance(hass, 100)
        driver = StubDriver(hass)
        src, eng = await _hb_reload(
            hass,
            eng,
            "e2",
            policy=StandardPolicy({}),
            driver=driver,
            health_check=False,
            cooldown=300,
        )
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, _HB_GRACE - 1)
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, 1)
        assert driver.calls == 1, eng.state
        await eng.async_stop()


async def test_hb_restart_mid_cycle_waits_the_grace_from_the_cycle(hass, _):
    """The recovery restarts HA (the cycle is lost): no boot loop at boot speed.

    RECOVERING/VERIFY are not persisted, but the cycle start is: after the
    restart the debounce counts from it, also on the deferred bootstrap path.
    """
    with _HbClock() as clock, _NotifySink():
        src = _hb_source(hass, "e3")
        # The action restarts HA: the final write happens while it runs.
        written: list[dict] = []
        eng = None
        eng = _hb_repair_engine(
            hass,
            src,
            StubDriver(hass, on_recover=lambda: written.append(eng.snapshot())),
        )
        await _hb_first_repair(hass, clock, src, eng)
        stored = written[0]
        assert stored["state"] == "recovering"
        assert stored["last_cycle_start"] == clock.now.isoformat()
        await eng.async_stop()
        await clock.advance(hass, 200)
        driver = StubDriver(hass)
        src = _hb_source(hass, "e3")
        hass.set_state(CoreState.starting)
        try:
            eng = _hb_repair_engine(hass, src, driver, persisted=stored)
            await eng.async_start()
            assert eng.state is GState.SUSPECT
            await clock.advance(hass, 100)  # bootstrap
        finally:
            hass.set_state(CoreState.running)
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await hass.async_block_till_done()
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, _HB_GRACE - 300 - 1)
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, 1)  # cycle start + debounce
        assert driver.calls == 1, eng.state
        await eng.async_stop()


class FaultSinceFakeHealth(FakeHealth):
    """A fake that knows when its fault began (like an overdue heartbeat)."""

    def __init__(self, hass, verdict=Health.OK, since=None):
        super().__init__(hass, verdict)
        self.since = since

    def fault_since(self):
        return self.since


async def test_fault_since_shortens_the_debounce(hass, _):
    """The debounce runs only for its rest: debounce - (now - fault_since).

    A start in the future counts as no time elapsed (full debounce), and one
    further back than the debounce reacts at once.
    """
    with _HbClock() as clock:
        health = FaultSinceFakeHealth(hass, Health.OK)
        driver = StubDriver(hass)
        driver.on_recover = lambda: setattr(health, "verdict", Health.OK)
        eng = make(hass, health, driver, boot_window=0)
        await eng.async_start()
        health.since = clock.now - timedelta(seconds=20)
        health.verdict = Health.UNHEALTHY
        eng._evaluate()
        assert eng.state is GState.SUSPECT
        await clock.advance(hass, 9)
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, 1)  # 30 - 20 = 10 s
        assert driver.calls == 1, eng.state
        await eng.async_stop()

        health = FaultSinceFakeHealth(hass, Health.OK)
        driver = StubDriver(hass)
        driver.on_recover = lambda: setattr(health, "verdict", Health.OK)
        eng = make(hass, health, driver, boot_window=0)
        await eng.async_start()
        health.since = clock.now + timedelta(seconds=100)  # clock skew
        health.verdict = Health.UNHEALTHY
        eng._evaluate()
        await clock.advance(hass, 29)
        assert eng.state is GState.SUSPECT and driver.calls == 0
        await clock.advance(hass, 1)
        assert driver.calls == 1, eng.state
        await eng.async_stop()

        health = FaultSinceFakeHealth(hass, Health.OK)
        driver = StubDriver(hass)
        driver.on_recover = lambda: setattr(health, "verdict", Health.OK)
        eng = make(hass, health, driver, boot_window=0)
        await eng.async_start()
        health.since = clock.now - timedelta(hours=1)
        health.verdict = Health.UNHEALTHY
        eng._evaluate()  # used up: the cycle starts without any time passing
        await hass.async_block_till_done()
        assert driver.calls == 1 and eng.state is GState.COOLDOWN, eng.state
        await eng.async_stop()


async def test_no_fault_since_keeps_the_full_debounce(hass, _):
    """A source without fault_since (the default None) waits the whole debounce."""
    hass.states.async_set("binary_sensor.fs_probe", "on")
    health = EntityStateHealth(hass, {"entity_id": "binary_sensor.fs_probe"})
    tpl = TemplateHealth(hass, {"type": "template", "template": "{{ false }}"})
    assert health.fault_since() is None and tpl.fault_since() is None
    with _HbClock() as clock, _NotifySink() as sent:
        eng = _hb_engine(hass, health, debounce=60)
        await eng.async_start()
        await clock.advance(hass, 3600)  # long healthy: nothing to count from
        hass.states.async_set("binary_sensor.fs_probe", "off")
        await hass.async_block_till_done()
        assert eng.state is GState.SUSPECT
        await clock.advance(hass, 59)
        assert eng.state is GState.SUSPECT and sent == []
        await clock.advance(hass, 1)
        assert eng.state is GState.ESCALATED
        # Nor do our own reaction marks give such a source a start to count from.
        eng.last_cycle_start = eng.last_recover = clock.now
        assert eng._debounce_anchor() is None
        await eng.async_stop()


async def test_entity_state_guard_ignores_confirmed(hass, _):
    """Sources without a confirmed verdict keep waiting out the debounce."""
    hass.states.async_set("binary_sensor.conf_probe", "on")
    health = EntityStateHealth(hass, {"entity_id": "binary_sensor.conf_probe"})
    assert health.confirmed() is False
    with _NotifySink() as sent:
        eng = _hb_engine(hass, health, debounce=60)
        await eng.async_start()
        assert eng.state is GState.OK
        hass.states.async_set("binary_sensor.conf_probe", "off")
        await hass.async_block_till_done()
        assert eng.state is GState.SUSPECT
        # another unhealthy update while SUSPECT does not cut the debounce short
        hass.states.async_set("binary_sensor.conf_probe", "off", {"x": 1})
        await _advance(hass, 59)
        assert eng.state is GState.SUSPECT and sent == []
        await _advance(hass, 61)  # _advance counts from now, not cumulative
        assert eng.state is GState.ESCALATED
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await eng.async_stop()


async def test_hb_no_detail_source_unchanged_texts(hass, _):
    """A source without detail(): health_detail "" and the plain event text."""
    with _NotifySink() as sent:
        eng = _hb_engine(hass, FakeHealth(hass, Health.UNHEALTHY), debounce=1)
        await eng.async_start()
        await _advance(hass, 1)
        assert eng.state is GState.ESCALATED and eng.health_detail is None
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        assert sent[0]["health_detail"] == "", sent[0]
        assert sent[0]["event_text"] == "Problem detected.", sent[0]
        await eng.async_stop()


async def test_hb_recovery_detail_first_attempt_only(hass, _):
    """A failing job (failure pings, no success) -> max_attempts -> ESCALATED.

    The detail rides on attempt 1 and on recovery_failed, not on attempt 2.
    """
    hass.config.language = "de"
    try:
        with _HbClock() as clock, _NotifySink() as sent:
            src = _hb_source(hass, "a2")
            driver = StubDriver(
                hass,
                on_recover=lambda: hass.async_create_task(
                    src.async_handle_ping(False, "3")
                ),
            )
            eng = _hb_engine(hass, src, StandardPolicy({}), driver)
            await eng.async_start()
            await src.async_handle_ping(False, "3")  # job reports exit code 3
            # A reported failure needs no confirmation: the repair starts at once,
            # before any time passes.
            assert driver.calls >= 1
            await clock.advance(hass, 1)  # 2 attempts -> ESCALATED
            assert eng.state is GState.ESCALATED and driver.calls == 2
            detail = "Fehler gemeldet, Exit-Code 3."
            got = {(v["event"], v["attempt"], v["health_detail"]) for v in sent}
            assert got == {
                ("recovery_attempt", 1, detail),
                ("recovery_attempt", 2, ""),
                ("recovery_failed", 2, detail),
            }, got
            for v in sent:
                assert v["message"] == f"G: {v['event_text']}", v
                assert v["event_text"].endswith(f". {detail}") == bool(
                    v["health_detail"]
                ), v
            await eng.async_stop()
    finally:
        hass.config.language = "en"


async def test_hb_auto_off_no_auto_recovery_with_detail(hass, _):
    """Auto off -> no_auto_recovery carries the detail, no repair runs."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a3")
        driver = StubDriver(hass)
        eng = _hb_engine(hass, src, StandardPolicy({}), driver)
        eng.auto = False
        await eng.async_start()
        await src.async_handle_ping(False, "TERM")
        assert eng.state is GState.ESCALATED  # no debounce wait
        await clock.advance(hass, 1)
        assert eng.state is GState.ESCALATED and driver.calls == 0
        assert [(v["event"], v["health_detail"]) for v in sent] == [
            ("no_auto_recovery", "Failure reported, code TERM.")
        ], sent
        await eng.async_stop()


async def test_hb_ping_in_boot_window_cooldown_no_detail_on_success(hass, _):
    """Action + health check: the restarted job pings within boot_window -> COOLDOWN."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a4")
        driver = StubDriver(
            hass,
            on_recover=lambda: hass.async_create_task(
                src.async_handle_ping(True, None)
            ),
        )
        eng = _hb_engine(hass, src, StandardPolicy({}), driver, boot_window=30)
        await eng.async_start()
        await src.async_handle_ping(False, None)
        await clock.advance(hass, 1)  # no debounce: recover -> ping -> VERIFY ok
        assert eng.state is GState.COOLDOWN and driver.calls == 1, eng.state
        got = [(v["event"], v["health_detail"]) for v in sent]
        assert got == [
            ("recovery_attempt", "Failure reported."),
            ("recovery_success", ""),
        ], got
        await eng.async_stop()


async def test_hb_recovery_blocked_without_detail(hass, _):
    """recovery_blocked has its own reason and carries no detail."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a5")
        eng = _hb_engine(hass, src, StandardPolicy({}), BlockedDriver(hass))
        await eng.async_start()
        await src.async_handle_ping(False, "3")
        await clock.advance(hass, 1)
        assert eng.state is GState.ESCALATED
        got = {v["event"]: v["health_detail"] for v in sent}
        assert got == {
            "recovery_attempt": "Failure reported, exit code 3.",
            "recovery_blocked": "",
        }, got
        await eng.async_stop()


async def test_hb_snooze_keeps_pings(hass, _):
    """Snooze holds; a ping meanwhile is stored and saved; right state afterwards."""
    saves = []
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a6")
        eng = _hb_engine(hass, src, save=lambda: saves.append(1))
        assert saves == [1]  # bind_persist flushed the fresh (armed) state
        await eng.async_start()
        await src.async_handle_ping(True, None)
        eng.snooze(timedelta(hours=10))
        await clock.advance(hass, _HB_PERIOD + _HB_GRACE + 5)  # overdue, but snoozed
        assert eng.state is GState.SNOOZED and src.evaluate() is Health.UNHEALTHY
        before = len(saves)
        await src.async_handle_ping(True, None)
        assert eng.state is GState.SNOOZED and len(saves) == before + 1
        assert eng.snapshot()["source"]["last_ok"] == clock.now.isoformat()
        eng.unsnooze()
        assert eng.state is GState.OK and sent == []
        await eng.async_stop()


async def test_hb_grace_ran_out_during_snooze_alarms_on_unsnooze(hass, _):
    """Decision 22: the grace ran out while snoozed -> alarm right after the snooze.

    The grace counts from the deadline, a snooze does not stop it: still broken
    afterwards is broken (no fresh debounce). Both ways out of a snooze: lifted
    early by unsnooze, and elapsed on its own while the grace was running.
    """
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a8")
        eng = _hb_engine(hass, src)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        eng.snooze(timedelta(hours=10))
        await clock.advance(hass, _HB_PERIOD + _HB_GRACE + 5)  # grace used up
        assert eng.state is GState.SNOOZED and sent == []
        eng.unsnooze()
        assert eng.state is GState.ESCALATED
        await hass.async_block_till_done()
        assert [(v["event"], v["health_detail"]) for v in sent] == [
            (
                "problem_detected",
                "No heartbeat for 70 minutes, expected every 60 minutes.",
            )
        ], sent
        await eng.async_stop()

        # Snoozed in the middle of the grace; the snooze outlasts it and elapses.
        sent.clear()
        src2 = _hb_source(hass, "a9")
        eng2 = _hb_engine(hass, src2)
        await eng2.async_start()
        await src2.async_handle_ping(True, None)
        await clock.advance(hass, _HB_PERIOD + 1)
        assert eng2.state is GState.SUSPECT
        eng2.snooze(timedelta(seconds=_HB_GRACE + 60))
        await clock.advance(hass, _HB_GRACE + 59)
        assert eng2.state is GState.SNOOZED and sent == []
        await clock.advance(hass, 1)  # the snooze ends -> no fresh debounce
        assert eng2.state is GState.ESCALATED
        await hass.async_block_till_done()
        assert [v["event"] for v in sent] == ["problem_detected"], sent
        await eng2.async_stop()


async def test_hb_persistence_overdue_escalated_stays(hass, _):
    """Same token: a stored ESCALATED survives a restart without a new alarm."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "a7")
        long_ago = clock.now - timedelta(days=2)
        state = hb.apply_ping(
            hb.reconcile_token({}, src.token, long_ago)[0], True, None, long_ago
        )
        stored = {"state": "escalated", "attempt": 2, "source": state}
        eng = _hb_engine(hass, src, persisted=stored)
        assert eng.state is GState.ESCALATED and eng.attempt == 2
        await eng.async_start()
        await hass.async_block_till_done()
        assert eng.state is GState.ESCALATED and sent == []
        assert eng.health_detail == (
            "No heartbeat for 2 days, expected every 60 minutes."
        )
        assert eng.snapshot()["source"] == state
        await eng.async_stop()


async def test_hb_persistence_new_token_drops_escalated(hass, _):
    """Another token's state drops a stored ESCALATED (not a snooze).

    Regenerated token or type switch: the verdict judged the old token -> OK,
    attempt 0, then grey (waiting); the reset is saved right away.
    """
    with _HbClock(), _NotifySink() as sent:
        old = _hb_source(hass, "b1")
        stale = hb.apply_ping(old.snapshot(), False, "3", dt_util.utcnow())
        stored = {"state": "escalated", "attempt": 2, "fail_count": 4, "source": stale}
        saves = []
        src = _hb_source(hass, "b2")
        eng = _hb_engine(hass, src, persisted=stored, save=lambda: saves.append(1))
        assert eng.state is GState.OK and eng.attempt == 0 and eng.fail_count == 4
        assert saves == [1]  # the reset reached the Store at once
        assert eng.snapshot()["source"]["token_fp"] == hb.token_fp(src.token)
        await eng.async_start()
        assert eng.state is GState.BLIND and sent == []
        await eng.async_stop()
        # A deliberate snooze survives the token change.
        snoozed = {
            "state": "snoozed",
            "snooze_until": (dt_util.utcnow() + timedelta(hours=1)).isoformat(),
            "source": stale,
        }
        eng2 = _hb_engine(hass, _hb_source(hass, "b3"), persisted=snoozed)
        assert eng2.state is GState.SNOOZED
        await eng2.async_stop()


async def test_reset_engine_verdict(hass, _):
    """The dormant-path helper resets state/attempt, keeps snooze, stats, source."""
    stored = {
        "state": "escalated",
        "attempt": 2,
        "recover_count": 3,
        "source": {"x": 1},
    }
    new = reset_engine_verdict(stored)
    assert new == {"state": "ok", "attempt": 0, "recover_count": 3, "source": {"x": 1}}
    assert stored["state"] == "escalated"  # input left alone
    snoozed = {"state": "snoozed", "attempt": 0, "snooze_until": "x"}
    assert reset_engine_verdict(snoozed) == snoozed
    assert reset_engine_verdict({}) == {"state": "ok", "attempt": 0}


async def test_snapshot_has_source_key(hass, _):
    """Sources without own state store {} (additive key, same STORAGE_VERSION)."""
    eng = make(hass, FakeHealth(hass), StubDriver(hass))
    assert eng.snapshot()["source"] == {}
    await eng.async_stop()


# ---------------- problem_cleared (escalated guard healthy again by itself) ----------------


def _record_notify(eng) -> list[tuple[str, dict]]:
    """Replace the engine's notify with a recorder of (key, params)."""
    notified: list[tuple[str, dict]] = []

    async def _rec(key, **kw):
        notified.append((key, kw))

    eng._notify = _rec
    return notified


async def _escalate(hass, eng, health):
    """Drive a recover guard into ESCALATED (debounce -> 1 failed attempt)."""
    health.verdict = Health.UNHEALTHY
    await eng.async_start()
    await _advance(hass, 30)
    assert eng.state is GState.ESCALATED, eng.state


async def test_escalated_at_follows_every_transition(hass, _):
    """Set on entering ESCALATED, cleared on leaving it (here: reset)."""
    health = FakeHealth(hass)
    eng = make(hass, health, StubDriver(hass), boot_window=0, max_attempts=1)
    assert eng.escalated_at is None
    before = dt_util.utcnow()
    await _escalate(hass, eng, health)
    assert eng.escalated_at is not None and eng.escalated_at >= before
    assert eng.snapshot()["escalated_at"] == eng.escalated_at.isoformat()
    eng.reset()  # still unhealthy -> OK -> SUSPECT (a fresh cycle)
    assert eng.state is GState.SUSPECT and eng.escalated_at is None
    assert eng.snapshot()["escalated_at"] is None
    await eng.async_stop()


async def test_problem_cleared_with_duration_when_on(hass, _):
    """ESCALATED -> OK by health + flag on -> problem_cleared with the duration."""
    health = FakeHealth(hass)
    eng = make(
        hass,
        health,
        StubDriver(hass),
        boot_window=0,
        max_attempts=1,
        notify_cleared=True,
    )
    notified = _record_notify(eng)
    events: list[str] = []
    eng.add_event_listener(lambda kind, _data: events.append(kind))
    await _escalate(hass, eng, health)
    eng.escalated_at = dt_util.utcnow() - timedelta(hours=26)  # alarm began 26 h ago
    notified.clear()
    events.clear()
    health.verdict = Health.OK
    eng._evaluate()
    await hass.async_block_till_done()
    assert eng.state is GState.OK and eng.escalated_at is None and eng.attempt == 0
    assert [k for k, _ in notified] == ["problem_cleared"], notified
    duration = notified[0][1]["duration"]
    assert abs(duration - 26 * 3600) < 60, duration
    assert events == []  # not a recovery: the event entity stays quiet
    await eng.async_stop()


async def test_problem_cleared_silent_when_off(hass, _):
    """Flag off, and a guard stored without the key: nothing on the way back."""
    for extra in ({"notify_cleared": False}, {}):
        health = FakeHealth(hass)
        eng = make(
            hass, health, StubDriver(hass), boot_window=0, max_attempts=1, **extra
        )
        notified = _record_notify(eng)
        await _escalate(hass, eng, health)
        notified.clear()
        health.verdict = Health.OK
        eng._evaluate()
        await hass.async_block_till_done()
        assert eng.state is GState.OK and eng.escalated_at is None
        assert notified == [], (extra, notified)
        await eng.async_stop()


async def test_problem_cleared_not_on_reset(hass, _):
    """An operator reset of a recovered guard is no "back to normal" message."""
    health = FakeHealth(hass)
    eng = make(
        hass,
        health,
        StubDriver(hass),
        boot_window=0,
        max_attempts=1,
        notify_cleared=True,
    )
    notified = _record_notify(eng)
    await _escalate(hass, eng, health)
    notified.clear()
    health.verdict = Health.OK  # healthy, but no evaluation yet
    eng.reset()
    await hass.async_block_till_done()
    assert eng.state is GState.OK and eng.escalated_at is None
    assert notified == [], notified
    await eng.async_stop()


async def test_problem_cleared_not_on_recovery_or_snooze(hass, _):
    """A successful manual recovery or a snooze out of ESCALATED stays silent."""
    health = FakeHealth(hass)
    driver = StubDriver(hass)
    eng = make(hass, health, driver, boot_window=0, max_attempts=1, notify_cleared=True)
    notified = _record_notify(eng)
    await _escalate(hass, eng, health)
    # manual recover from ESCALATED, this time the driver heals the device
    driver.on_recover = lambda: setattr(health, "verdict", Health.OK)
    notified.clear()
    await eng.async_manual_recover()
    await hass.async_block_till_done()
    assert eng.state is GState.COOLDOWN and eng.escalated_at is None, eng.state
    await _advance(hass, 30)  # cooldown -> ok
    assert eng.state is GState.OK
    keys = [k for k, _ in notified]
    assert "recovery_success" in keys and "problem_cleared" not in keys, notified
    await eng.async_stop()
    # snooze an escalated guard, it heals meanwhile, unsnooze -> OK silently
    health2 = FakeHealth(hass)
    eng2 = make(
        hass,
        health2,
        StubDriver(hass),
        boot_window=0,
        max_attempts=1,
        notify_cleared=True,
    )
    notified2 = _record_notify(eng2)
    await _escalate(hass, eng2, health2)
    notified2.clear()
    eng2.snooze(timedelta(hours=1))
    assert eng2.escalated_at is None
    health2.verdict = Health.OK
    eng2.unsnooze()
    await hass.async_block_till_done()
    assert eng2.state is GState.OK and notified2 == [], notified2
    await eng2.async_stop()


async def test_problem_cleared_linked_follower(hass, _):
    """A follower escalated by a failed group repair reports its own way back."""
    h1 = FakeHealth(hass, Health.UNHEALTHY)
    h2 = FakeHealth(hass, Health.UNHEALTHY)
    e1, e2 = make_pair(
        hass,
        h1,
        StubDriver(hass),
        h2,
        StubDriver(hass),
        boot_window=0,
        max_attempts=1,
        notify_cleared=True,
    )
    n2 = _record_notify(e2)
    await e1.async_start()
    await e2.async_start()
    await e1.async_manual_recover()
    await hass.async_block_till_done()
    assert e2.state is GState.ESCALATED and e2.escalated_at is not None
    n2.clear()
    h2.verdict = Health.OK
    e2._evaluate()
    await hass.async_block_till_done()
    assert e2.state is GState.OK and [k for k, _ in n2] == ["problem_cleared"], n2
    await e1.async_stop()
    await e2.async_stop()


async def test_problem_cleared_persisted_escalated_at(hass, _):
    """A restored ESCALATED keeps its start; the clear after restart has the duration."""
    began = dt_util.utcnow() - timedelta(hours=3)
    snap = {"state": "escalated", "attempt": 1, "escalated_at": began.isoformat()}
    with _NotifySink() as sent:
        eng = DeviceEngine(
            hass,
            "G",
            FakeHealth(hass, Health.UNHEALTHY),
            StubDriver(hass),
            StandardPolicy({}),
            {
                "debounce": 30,
                "notify_cleared": True,
                "notify_action": [{"action": "test.sink"}],
            },
            subentry_id="g",
            engines={},
            persisted=snap,
        )
        assert eng.state is GState.ESCALATED and eng.escalated_at == began
        assert eng.snapshot()["escalated_at"] == began.isoformat()
        await eng.async_start()
        await hass.async_block_till_done()
        assert eng.state is GState.ESCALATED and sent == []
        eng.health.verdict = Health.OK
        eng._evaluate()
        await hass.async_block_till_done()
        assert eng.state is GState.OK
        assert [v["event"] for v in sent] == ["problem_cleared"], sent
        assert sent[0]["message"] == "G: Back to normal after 3 hours.", sent[0]
        assert "duration" not in sent[0], sent[0]  # template-only, no new variable
        await eng.async_stop()


async def test_problem_cleared_legacy_escalated_without_start(hass, _):
    """ESCALATED stored by an older version (no escalated_at) -> no-duration text."""
    snap = {"state": "escalated", "attempt": 2}
    with _NotifySink() as sent:
        eng = DeviceEngine(
            hass,
            "G",
            FakeHealth(hass, Health.OK),
            StubDriver(hass),
            StandardPolicy({}),
            {
                "debounce": 30,
                "notify_cleared": True,
                "notify_action": [{"action": "test.sink"}],
            },
            subentry_id="g",
            engines={},
            persisted=snap,
        )
        assert eng.state is GState.ESCALATED and eng.escalated_at is None
        await eng.async_start()  # healthy at restart -> clears by itself
        await hass.async_block_till_done()
        assert eng.state is GState.OK
        assert [v["event"] for v in sent] == ["problem_cleared"], sent
        assert sent[0]["message"] == "G: Back to normal.", sent[0]
        assert sent[0]["event_text"] == "Back to normal.", sent[0]
        await eng.async_stop()


async def test_problem_cleared_during_bootstrap_waits_for_started(hass, _):
    """Healthy at a restart before HA has started: OK now, the message once started.

    The notify action may not be registered during bootstrap and a failed send is
    never retried, so only the send waits; a stop before the start drops it.
    """
    began = dt_util.utcnow() - timedelta(hours=3)
    behavior = {
        "debounce": 30,
        "notify_cleared": True,
        "notify_action": [{"action": "test.sink"}],
    }
    with _NotifySink() as sent:
        hass.set_state(CoreState.starting)
        try:
            eng = DeviceEngine(
                hass,
                "G",
                FakeHealth(hass, Health.OK),
                StubDriver(hass),
                StandardPolicy({}),
                behavior,
                subentry_id="g",
                engines={},
                persisted={
                    "state": "escalated",
                    "attempt": 1,
                    "escalated_at": began.isoformat(),
                },
            )
            await eng.async_start()
            await hass.async_block_till_done()
            assert eng.state is GState.OK and eng.escalated_at is None
            assert sent == [], sent
            # a guard stopped (unloaded) before the start sends nothing later
            eng2 = DeviceEngine(
                hass,
                "H",
                FakeHealth(hass, Health.OK),
                StubDriver(hass),
                StandardPolicy({}),
                behavior,
                subentry_id="h",
                engines={},
                persisted={"state": "escalated", "attempt": 1},
            )
            await eng2.async_start()
            await eng2.async_stop()
        finally:
            hass.set_state(CoreState.running)
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await hass.async_block_till_done()
        assert [v["event"] for v in sent] == ["problem_cleared"], sent
        assert sent[0]["message"] == "G: Back to normal after 3 hours.", sent[0]
        await eng.async_stop()


async def test_hb_success_ping_after_failure_reports_cleared(hass, _):
    """Failure ping -> ESCALATED; a success ping 26 h later -> problem_cleared."""
    with _HbClock() as clock, _NotifySink() as sent:
        src = _hb_source(hass, "e1")
        eng = _hb_engine(hass, src, notify_cleared=True)
        await eng.async_start()
        await src.async_handle_ping(True, None)
        await src.async_handle_ping(False, "3")
        assert eng.state is GState.ESCALATED
        await clock.advance(hass, 26 * 3600 - 1)  # still escalated (overdue too)
        await src.async_handle_ping(True, None)
        assert eng.state is GState.OK
        await hass.async_block_till_done()
        assert [v["event"] for v in sent] == ["problem_detected", "problem_cleared"]
        assert sent[1]["event_text"] == "Back to normal after 26 hours.", sent[1]
        assert sent[1]["health_detail"] == "", sent[1]
        await eng.async_stop()


async def test_reset_engine_verdict_drops_escalated_at(hass, _):
    """A dropped verdict (new heartbeat identity) takes its start time with it."""
    stored = {"state": "escalated", "attempt": 1, "escalated_at": "2026-01-01T00:00"}
    assert "escalated_at" not in reset_engine_verdict(stored)
    assert stored["escalated_at"]  # input left alone


async def test_state_since_follows_every_transition(hass, _):
    """state_since: when the guard entered its current state, persisted with it."""
    health = FakeHealth(hass)
    eng = make(hass, health, StubDriver(hass), boot_window=0, max_attempts=1)
    assert eng.state_since is not None
    assert eng.snapshot()["state_since"] == eng.state_since.isoformat()
    await _escalate(hass, eng, health)
    assert eng.state_since == eng.escalated_at
    escalated = eng.state_since
    eng.reset()  # still unhealthy -> OK -> SUSPECT: a fresh start
    assert eng.state is GState.SUSPECT and eng.state_since >= escalated
    assert eng.snapshot()["state_since"] == eng.state_since.isoformat()
    before = eng.state_since
    eng._set_state(GState.SUSPECT)  # no change: the clock keeps running
    assert eng.state_since == before
    await eng.async_stop()


async def test_state_since_survives_a_restart(hass, _):
    """A stored start of the state survives a restart.

    Kept for the restored state, for a state the first evaluation re-derives
    (SUSPECT), and taken from escalated_at for an older blob.
    """
    began = dt_util.utcnow() - timedelta(hours=3)

    def engine(snap, verdict):
        return DeviceEngine(
            hass,
            "G",
            FakeHealth(hass, verdict),
            StubDriver(hass),
            StandardPolicy({}),
            {"debounce": 3600, "boot_window": 0, "max_attempts": 1},
            subentry_id="g",
            engines={},
            persisted=snap,
        )

    ok = engine({"state": "ok", "state_since": began.isoformat()}, Health.OK)
    assert ok.state_since == began
    await ok.async_start()
    assert ok.state is GState.OK and ok.state_since == began
    await ok.async_stop()

    sus = engine(
        {"state": "suspect", "state_since": began.isoformat()}, Health.UNHEALTHY
    )
    await sus.async_start()
    await hass.async_block_till_done()
    assert sus.state is GState.SUSPECT and sus.state_since == began, sus.state_since
    await sus.async_stop()

    gone = engine({"state": "suspect", "state_since": began.isoformat()}, Health.OK)
    await gone.async_start()
    assert gone.state is GState.OK and gone.state_since > began
    assert gone._restored_since is None  # spent by the first evaluation
    await gone.async_stop()

    old = engine(
        {"state": "escalated", "attempt": 1, "escalated_at": began.isoformat()},
        Health.UNHEALTHY,
    )
    assert old.state is GState.ESCALATED and old.state_since == began
    await old.async_stop()

    assert "state_since" not in reset_engine_verdict(
        {"state": "escalated", "state_since": began.isoformat()}
    )

    # A blob without state_since is saved once after the start (no transition
    # needed), so the start survives the next restart; one with it is not.
    for snap, want in (
        ({"state": "ok"}, 1),
        ({"state": "ok", "state_since": began.isoformat()}, 0),
    ):
        saves = []
        eng = DeviceEngine(
            hass,
            "G",
            FakeHealth(hass, Health.OK),
            StubDriver(hass),
            StandardPolicy({}),
            {"debounce": 30, "boot_window": 0},
            subentry_id="g",
            engines={},
            persisted=snap,
            save=lambda saves=saves: saves.append(1),
        )
        await eng.async_start()
        assert len(saves) == want, (snap, saves)
        await eng.async_stop()


def _since_engine(hass, snap, health, saves=None, store=None):
    """A guard restored from `snap`; each save writes its snapshot to `store`."""
    eng = None

    def _save():
        if saves is not None:
            saves.append(1)
        if store is not None:
            store.clear()
            store.update(eng.snapshot())

    eng = DeviceEngine(
        hass,
        "G",
        health,
        StubDriver(hass),
        StandardPolicy({}),
        {"debounce": 3600, "boot_window": 0, "max_attempts": 1},
        subentry_id="g",
        engines={},
        persisted=snap,
        save=_save,
    )
    return eng


async def test_restored_since_is_dropped_after_the_first_evaluation(hass, _):
    """A stored start is offered to the first evaluation only.

    Regression: a stored SUSPECT (or BLIND) whose health was fine again at the
    start left the one-shot pending, so a fault days later took the start from
    before the restart ("suspect for 3 days" for a fault that just began).
    """
    began = dt_util.utcnow() - timedelta(days=3)
    for stored, later, want in (
        ("suspect", Health.UNHEALTHY, GState.SUSPECT),
        ("blind", Health.UNKNOWN, GState.BLIND),
        ("recovering", None, GState.RECOVERING),
    ):
        health = FakeHealth(hass, Health.OK)
        eng = _since_engine(
            hass, {"state": stored, "state_since": began.isoformat()}, health
        )
        await eng.async_start()
        assert eng.state is GState.OK and eng._restored_since is None, stored
        start = dt_util.utcnow()
        if want is GState.RECOVERING:
            eng._set_state(GState.RECOVERING)  # as when following a linked partner
        else:
            health.verdict = later
            eng._evaluate()
        assert eng.state is want, (stored, eng.state)
        assert eng.state_since >= start, (stored, eng.state_since)
        assert eng.snapshot()["state_since"] == eng.state_since.isoformat()
        await eng.async_stop()


async def test_state_since_survives_a_boot_blind(hass, _):
    """A BLIND during bootstrap (source not loaded yet) keeps the stored start.

    Regression: the boot-time OK->BLIND spent the restored start, so every
    state-based guard loading before its source read "ok for 1 min" after each
    restart, and a stored SUSPECT lost its start the same way.
    """
    began = dt_util.utcnow() - timedelta(days=5)
    hass.set_state(CoreState.starting)
    try:
        for stored, later, want in (
            ("ok", Health.OK, GState.OK),
            ("suspect", Health.UNHEALTHY, GState.SUSPECT),
        ):
            store: dict = {}
            health = FakeHealth(hass, Health.UNKNOWN)
            eng = _since_engine(
                hass,
                {"state": stored, "state_since": began.isoformat()},
                health,
                store=store,
            )
            await eng.async_start()
            assert eng.state is GState.BLIND, stored
            health.verdict = later
            eng._evaluate()
            assert eng.state is want and eng.state_since == began, (
                stored,
                eng.state,
                eng.state_since,
            )
            assert eng._restored_since is None
            assert store["state_since"] == began.isoformat(), store
            await eng.async_stop()

        # Back to another state than the stored one: a fresh start.
        health = FakeHealth(hass, Health.UNKNOWN)
        eng = _since_engine(
            hass, {"state": "ok", "state_since": began.isoformat()}, health
        )
        await eng.async_start()
        health.verdict = Health.UNHEALTHY
        eng._evaluate()
        assert eng.state is GState.SUSPECT and eng.state_since > began
        await eng.async_stop()

        # A BLIND that outlasts the hold is a real one: the start is not kept.
        health = FakeHealth(hass, Health.UNKNOWN)
        eng = _since_engine(
            hass, {"state": "ok", "state_since": began.isoformat()}, health
        )
        await eng.async_start()
        assert eng._restored_until is not None
        eng._restored_until = dt_util.utcnow() - timedelta(seconds=1)
        health.verdict = Health.OK
        eng._evaluate()
        assert eng.state is GState.OK and eng.state_since > began
        await eng.async_stop()
    finally:
        hass.set_state(CoreState.running)

    # Once HA runs, an unknown source is a finding: no hold.
    health = FakeHealth(hass, Health.UNKNOWN)
    eng = _since_engine(hass, {"state": "ok", "state_since": began.isoformat()}, health)
    await eng.async_start()
    assert eng.state is GState.BLIND and eng._restored_since is None
    health.verdict = Health.OK
    eng._evaluate()
    assert eng.state is GState.OK and eng.state_since > began
    await eng.async_stop()


async def test_state_since_is_saved_when_the_start_changes_it(hass, _):
    """A start that changes (state, since) without a transition saves it once.

    Regression: a stored transient state (cooldown, suspect, …) gone at the
    start, or a snooze that ran out while HA was down, changed nothing in the
    Store, so each later restart started the clock again.
    """
    began = dt_util.utcnow() - timedelta(hours=3)
    ended = dt_util.utcnow() - timedelta(hours=1)
    for snap, want_since in (
        ({"state": "cooldown", "state_since": began.isoformat()}, None),
        (
            {
                "state": "snoozed",
                "state_since": began.isoformat(),
                "snooze_until": ended.isoformat(),
            },
            ended,  # ok since the snooze ran out, not since this start
        ),
    ):
        store: dict = {}
        saves: list = []
        eng = _since_engine(hass, snap, FakeHealth(hass, Health.OK), saves, store)
        await eng.async_start()
        assert eng.state is GState.OK and saves, (snap, saves)
        first = eng.state_since
        if want_since is not None:
            assert first == want_since, (snap, first)
        assert store["state"] == "ok" and store["state_since"] == first.isoformat()
        await eng.async_stop()

        # The next restart reads what was saved: same start, nothing to save.
        saves2: list = []
        again = _since_engine(
            hass, dict(store), FakeHealth(hass, Health.OK), saves2, store
        )
        await again.async_start()
        assert again.state is GState.OK and again.state_since == first
        assert saves2 == [], (snap, saves2)
        await again.async_stop()


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


async def main() -> int:
    passed, failed = 0, 0
    async with async_test_home_assistant() as hass:
        for t in TESTS:
            try:
                await t(hass, None)
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL  {t.__name__}: {err!r}")
            else:
                passed += 1
                print(f"ok    {t.__name__}")
        await hass.async_stop()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
