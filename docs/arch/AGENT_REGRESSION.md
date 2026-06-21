# Necromancer — Agent-Regressions-Checkliste

Diese Checkliste ist dafür gemacht, von einem **Agenten** ausgeführt zu werden — via **Files**
(Quelldateien unter `custom_components/necromancer/` lesen + Symbole/Zeilen bestätigen) und via **API**
(eine laufende HA-Instanz mit dem Live-Test-Helfer treiben). Jeder Test ist ein abhakbarer Block mit
*Prüft / Files / Treiber / Assert / Cleanup*.

## Voraussetzungen
- **Laufende HA-Instanz** mit eingebundener Integration; `N.g("/api/config")["state"] == "RUNNING"`.
- **Live-Test-Helfer** `necro_testkit.py` (REST/WS-Treiber gegen die laufende Instanz) stellt die `N.*`-API:
  `g · st · setstate · call · log · guard · create_guard · delete_subentry · list_subentries · add_port ·
  remove_port · wait · hub_id`. Import: `import necro_testkit as N`.
- **Code-Änderung (.py) → voller HA-Neustart** (Reload reicht nicht); danach auf RUNNING warten
  (Python-Sleep bzw. `N.wait`, kein bash-`sleep`).
- **Automatisierte Suiten** (Vorbedingung — müssen grün sein, ersetzen den Pflicht-Handlauf):
  `tests/test_units.py`, `tests/test_poe.py`, `tests/test_engine.py`, `tests/test_integration.py` — mit dem
  Test-Venv und `PYTHONPATH=<ha-core>:<ha-core>/config` fahren. Sie decken automatisch ab: PoE
  resolve/cycle/coalescing/Platzhalter/Stale-Cache, Engine-State-Machine + Linking/Lifecycle +
  Persistenz-Kernpfade, Health-Registry-Events, PoE-Pre-Flight. Die `[ ]`-Punkte hier sind der
  Live-Smoke-Test obendrauf.
- **Test-Helfer-Entities** (Dev-Setup): `input_boolean.test_1..6`, `sim_poe_port`, `sim_device_power`,
  `input_select.test_state`, `input_text.test_note`, `switch.test_template_switch`,
  `binary_sensor.test_reachable`, `sensor.test_device_info`.
- **Entity-Slugs** (de-Instanz): `sensor.<slug>_status`, `binary_sensor.<slug>_gesundheit`,
  `switch.<slug>_auto_reparatur`, `button.<slug>_reparieren`; `slug = Name.lower()`.
- **Beobachten:** schnelle States (RECOVERING/VERIFY) im **Log** asserten (`N.log()`), langsame
  (SUSPECT/COOLDOWN/OK/ESCALATED) per `N.guard("<slug>")`. **Heil-Trick:** Recovery-Aktion macht die
  Health-Entity wieder gesund → VERIFY gelingt; schreibt sie nur `input_text.test_note` → VERIFY-Timeout →
  Eskalation. **Jeder Test räumt seine Guards/Ports selbst weg.**

## Konventionen für Linking-Tests
- Bei zwei verlinkten Guards bestimmt die **Erstellungs-/Debounce-Reihenfolge**, wer **Leader** wird (wer
  zuerst durch den Debounce kommt) und wer **Follower** — das ist korrektes, by-design-Verhalten. Asserts
  daher **rollen-agnostisch** schreiben: Marker über **beide** Guards prüfen und „**genau ein** echter
  `recovery attempt 1/` insgesamt", statt einen festen Guard als Follower anzunehmen. Wer einen festen
  Leader braucht, erzwingt ihn (nur dessen Health zuerst brechen, oder `button.<slug>_reparieren` drücken).

Priorität: **P0** = nach Refactors zwingend · **P1** = wichtig · **P2** = Kür. `[ ]` = beim Lauf abhaken.

---

## Refactor-Regressionen — PoE-Stale-Cache (B1) · Linking-Teardown (B2) · LinkCoordinator (M1)

### B1 — PoE-Stale-Cache zykelt nie das falsche Gerät

- [ ] **B1.1 — resolve_with_reason: belegter last-known-Port wird verworfen** · `P0`
  - **Prüft:** Bei 0 Live-Matches vertraut die Fabric dem gecachten Port NUR, wenn dieser gerade nichts meldet; meldet er eine andere Live-id, wird der Cache-Eintrag verworfen und mit „no port matches" abgelehnt (kein Reboot des unschuldigen Nachbarn).
  - **Files:** `custom_components/necromancer/poe.py` → `resolve_with_reason` (Z. 151-198): Zweig `port = self._by_label(self._cache.get(target))` → `occupant = _norm(self._port_id(port))`; `occupant is None` → return cached port (WARNING „not in any port's neighbour data — last-known port"); sonst WARNING „last-known port %r for %r now serves %r — dropping stale cache", `self._cache.pop(target, None)`, return `None, "no port matches '…'"`. Bestätige, dass es KEINEN unbedingten `return port` mehr gibt.
  - **Treiber:** Referenz-Unittest fahren: `Suite `tests/test_poe.py` fahren (Voraussetzungen), Zeile `ok    test_resolve_last_known_skips_occupied_port` suchen`
  - **Assert:** Zeile `ok    test_resolve_last_known_skips_occupied_port` UND Suite endet mit `16 passed, 0 failed`. Test (test_poe.py:164) belegt: A war auf P1 gecacht (`cache={"aa:aa":"P1"}`), `sensor.nb1` meldet jetzt `mac=bb:bb` → `p is None`, `"no port matches" in reason`, `f.cache.get("aa:aa") is None` (stale gedroppt).
  - **Cleanup:** — (In-Process-Suite, kein Live-Guard)

- [ ] **B1.2 — Live: gecachter, jetzt fremd-belegter Port wird nicht zyklt** · `P1`
  - **Prüft:** Ein poe_port-Guard, dessen Gerät einst auf einem Port gelernt wurde, der jetzt eine andere reale id meldet, eskaliert (über `can_recover`-Block) statt den Port zu cyclen.
  - **Treiber:**
    1. Hinweis: `N.add_port(...)` im Testkit kennt KEIN `id_attribute` — die Port-id kommt aus dem **State** des `id_entity`. Daher die id über den State von `sensor.test_device_info` setzen (nicht über ein `mac`-Attribut): `N.setstate("sensor.test_device_info","aa:aa")`. Aktuator-Sim `N.setstate("switch.test_template_switch","on")`, Online-Status-Sim `N.setstate("binary_sensor.test_reachable","on")`.
    2. Testport anlegen: `N.add_port({"label":"PB1","actuator":"switch.test_template_switch","id_entity":"sensor.test_device_info","status_entity":"binary_sensor.test_reachable","off_on_delay":1,"off_timeout":5,"on_timeout":5})` → id `aa:aa` (= aktueller State) wird gelernt.
    3. poe_port-Guard erstellen (Health zuerst gesund: `N.call("input_boolean","turn_on",entity_id="input_boolean.test_6")`): `hub, sub = N.create_guard({"source_type":"state_based","name":"StaleB1","health":{"entity_id":"input_boolean.test_6","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"poe_port","expected_id":"aa:aa","behavior":{"debounce":2,"cooldown":3,"boot_window":5,"max_attempts":1}})`.
    4. Port auf andere reale id umkabeln: `N.setstate("sensor.test_device_info","bb:bb")` (relearn läuft via state-change des id_entity), dann `N.wait(1)`.
    5. Health brechen → Recovery anstoßen: `N.call("input_boolean","turn_off",entity_id="input_boolean.test_6")`, `N.wait(5)`.
  - **Assert:** `N.guard("staleb1")` → state `escalated`. Im `N.log()`: WARNING-Marker `last-known port 'PB1' for 'aa:aa' now serves 'bb:bb' — dropping stale cache` UND der Block-Marker des poe_port-Drivers `PoE aa:aa: no port matches 'aa:aa'` (drivers/poe_port.py:39, `can_recover` blockt VOR `repair()` → Engine eskaliert via `recovery_blocked`). Der `repair()`-Marker `cannot repair 'aa:aa'` wird NICHT erwartet (repair wird nie erreicht). Kein erfolgreicher Cycle des Ports nach dem Umkabeln.
  - **Cleanup:** `N.delete_subentry(hub, sub)`; `N.remove_port("PB1")`

### B2 — Linking-Teardown ist race-sicher

- [ ] **B2.1 — Follow-up-Verify als _cycle_task: Button während Follower-Verify ignoriert** · `P0`
  - **Prüft:** Die nach Leader-Repair gestartete `validate_after_repair` läuft als `engine._cycle_task`, sodass der Busy-Guard greift: ein manueller Recover (Button) mitten im Follower-Verify wird verworfen — kein zweiter, konkurrierender Cycle.
  - **Files:** `custom_components/necromancer/links.py` → `on_partner_repair_done` (Z. 169-183): `eng._cycle_task = eng.hass.async_create_task(self.validate_after_repair(...))`; `validate_after_repair` (Z. 185-222) setzt `GState.VERIFY`, im `finally` `eng._cycle_task = None`. `engine.py` → `async_manual_recover` (Z. 414-426): `if self._busy(): return`; `_busy` (Z. 298-300) = `self._cycle_task is not None and not self._cycle_task.done()`.
  - **Treiber:** Referenz-Engine-Test fahren: `Suite `tests/test_engine.py` fahren (Voraussetzungen), Zeile `ok    test_validate_after_repair_blocks_manual_recover` suchen`
  - **Assert:** Zeile `ok    test_validate_after_repair_blocks_manual_recover` + Suite `30 passed, 0 failed`. Test (test_engine.py:301) belegt: während VERIFY `e2._busy()` True, `async_manual_recover()` → `d2.calls == 0` (kein konkurrierender Cycle), nach Heilung `e2.state is GState.COOLDOWN`, `recover_count == 1`, `d2.calls == 0`.
  - **Cleanup:** —

- [ ] **B2.2 — async_stop bricht Follower-Verify ab, keine Eskalation** · `P0`
  - **Prüft:** Stop/Unload mitten im Follower-Verify canceled die `validate`-Task sauber: kein terminaler State auf der abgebauten Engine, Link-State zurückgesetzt.
  - **Files:** `engine.py` → `async_stop` (Z. 198-222): zuerst `self._stopping = True`, `self.links.reset()`, am Ende `if self._cycle_task and not self._cycle_task.done(): self._cycle_task.cancel()`. `links.py` → `validate_after_repair` `finally` (Z. 218-222) leert `_cycle_task` auch beim Cancel. `reset()` (Z. 85-88) setzt `following=False`, `leader=None`.
  - **Treiber:** `Suite `tests/test_engine.py` fahren (Voraussetzungen), Zeile `ok    test_async_stop_cancels_validate_no_escalation` suchen`
  - **Assert:** Zeile `ok    test_async_stop_cancels_validate_no_escalation`. Test (test_engine.py:326) belegt nach `async_stop` im VERIFY: `e2.state is not GState.ESCALATED`, `e2._following is False`, `e2._stopping is True`, `not e2._busy()`, und nach `async_block_till_done` weiterhin nicht ESCALATED (keine späte Mutation).
  - **Cleanup:** —

- [ ] **B2.3 — Leader-Stop eskaliert den Follower nicht** · `P0`
  - **Prüft:** Wird der Leader mitten im Recover-Cycle gecancelt (Reload/Unload), feuert sein `finally` KEIN „done(failed)" an die Gruppe — der Follower bleibt haltend statt fälschlich zu eskalieren.
  - **Files:** `engine.py` → `_run_recovery_cycle` `finally` (Z. 476-481): `if not self._stopping: self.links.notify_done(self.state == GState.COOLDOWN)` — beim Stop also übersprungen. `links.py` → `notify_done` (Z. 118-133) ruft sonst `partner.links.on_partner_repair_done`.
  - **Treiber:** `Suite `tests/test_engine.py` fahren (Voraussetzungen), Zeile `ok    test_leader_stop_does_not_escalate_follower` suchen`
  - **Assert:** Zeile `ok    test_leader_stop_does_not_escalate_follower`. Test (test_engine.py:349) belegt: Leader in `recover()` blockiert, Follower `_following True`/`RECOVERING`; nach `e1.async_stop()` → `e2.state is not GState.ESCALATED` und `e2._following is True` (nie benachrichtigt → hält weiter).
  - **Cleanup:** —

- [ ] **B2.4 — Live-Happy-Path: Follower folgt, eigener Cycle = 0, Erfolg via Linked-Repair** · `P1`
  - **Prüft:** Zwei verlinkte Guards: Leader geht in Recovery, Follower folgt (state RECOVERING, 0 eigene Versuche), und wird durch die geteilte Reparatur gesund (COOLDOWN wie der Leader), nicht durch einen eigenen Cycle.
  - **Treiber:**
    1. Follower (action_check, heilt sich nie selbst — Aktion schreibt nur Note): `f_entry, f_sub = N.create_guard({"source_type":"state_based","name":"LinkFollowX","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action_check","action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_1"}}],"behavior":{"debounce":2,"cooldown":3,"boot_window":4,"max_attempts":1}})`.
    2. Leader (action_check, heilt sich UND verlinkt auf Follower): `hub, leader_sub = N.create_guard({"source_type":"state_based","name":"LinkLeadX","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action_check","action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_1"}}],"behavior":{"debounce":2,"cooldown":3,"boot_window":4,"max_attempts":1},"linked_guards":[f_sub]})`.
    3. Beide Health gleichzeitig krank: `N.call("input_boolean","turn_off",entity_id="input_boolean.test_1")`; `N.wait(2)`.
    4. Leader-Aktion heilt test_1; Follower folgt → der Follower wird durch DIESELBE Health gesund; `N.wait(5)`.
  - **Assert:** `N.guard("linkleadx")` → `cooldown` (dann `ok`), Attr `recover_count == 1`. `N.guard("linkfollowx")` → `cooldown`/`ok`, Attr `recover_count == 1`, aber eigener `attempt` 0. Im `N.log()`: INFO-Marker `following (hold, verify after)` UND `healthy after linked-guard repair`. KEIN `recovery attempt 1/` für „LinkFollowX".
  - **Cleanup:** `N.delete_subentry(hub, leader_sub)`; `N.delete_subentry(f_entry, f_sub)`

### M1 — LinkCoordinator-Extraktion ist verhaltenserhaltend

- [ ] **M1.1 — links.py hat LinkCoordinator, state.py hat GState, engine re-exportiert** · `P0`
  - **Prüft:** Das Link-Runtime-Protokoll lebt in `LinkCoordinator` (links.py), `GState` in `state.py`; engine.py importiert beide und nutzt `self.links.*` statt Partner-Internas.
  - **Files:** `custom_components/necromancer/links.py` → `class LinkCoordinator` (Z. 63) mit `find_repairing_partner`/`notify_start`/`notify_done`/`on_partner_repair_start`/`on_partner_repair_done`/`validate_after_repair`/`reset`. `custom_components/necromancer/state.py` → `class GState(StrEnum)` (Z. 12). `engine.py`: `from .links import LinkCoordinator` (Z. 45), `from .state import GState` (Z. 48), `self.links = LinkCoordinator(self, linked_guards, engines)` (Z. 89).
  - **Treiber:**
    - `grep -n "class LinkCoordinator" custom_components/necromancer/links.py`
    - `grep -n "class GState" custom_components/necromancer/state.py`
    - `grep -n "from .state import GState\|from .links import LinkCoordinator\|self.links = LinkCoordinator" custom_components/necromancer/engine.py`
  - **Assert:** Alle drei greps liefern Treffer (jeweils ≥1). engine.py-grep zeigt alle drei Marker-Zeilen.
  - **Cleanup:** —

- [ ] **M1.2 — Kein Zugriff auf Partner-Privates; Peers über public `peer.links`** · `P0`
  - **Prüft:** Engines fassen keine fremden Privatfelder mehr an — der alte `partner._following` / `partner._on_partner_repair_*`-Zugriff ist weg; Peers werden über `partner.links.*` (public) erreicht.
  - **Files:** `links.py` → `find_repairing_partner` nutzt `partner.links.following` (Z. 100-103), `notify_start/done` rufen `partner.links.on_partner_repair_start/done` (Z. 116, 133). engine.py-Delegatoren (Z. 302-327) verweisen auf `self.links.*`.
  - **Treiber:**
    - `grep -rn "partner\._following\|partner\._on_partner_repair" custom_components/necromancer/links.py custom_components/necromancer/engine.py` → MUSS leer sein.
    - `grep -n "partner.links.\|\.links\.on_partner_repair\|\.links\.following" custom_components/necromancer/links.py`
  - **Assert:** Erster grep liefert KEINE Treffer (kein `partner._following`/`partner._on_partner_repair` mehr — Peers nur über `partner.links.*`). Der einzige verbleibende `_following`-Bezug in engine.py ist `self._following` (Z. 342, eigene Property im `_evaluate`) bzw. die Delegator-Property selbst (Z. 305/309 als `self.links.following`) — kein Fremdzugriff. Zweiter grep zeigt die public `partner.links.*`-Aufrufe (Z. 101/116/133).
  - **Cleanup:** —

- [ ] **M1.3 — Alle vier Suiten grün (72) = Verhalten unverändert** · `P0`
  - **Prüft:** Die Extraktion ist verhaltenserhaltend — die vollständige In-Process-Suite bleibt grün.
  - **Treiber:** `cd <ha-core> && for t in units poe engine integration; do PYTHONPATH=<ha-core>:<ha-core>/config python tests/test_$t.py 2>&1 | tail -1; done`
  - **Assert:** Genau diese vier Schlusszeilen: `18 passed, 0 failed` · `16 passed, 0 failed` · `30 passed, 0 failed` · `8/8 checks passed` → Summe 72. Kein `failed`/`FAIL`.
  - **Cleanup:** —

- [ ] **M1.4 — Live-Smoke: Linking-Verhalten nach Extraktion unverändert** · `P2`
  - **Prüft:** Der verlinkte Happy-Path verhält sich live identisch zu vor der Extraktion (Leader→cooldown, Follower folgt ohne Eigen-Cycle).
  - **Treiber:** B2.4 ausführen (siehe oben).
  - **Assert:** Identisch zu B2.4: beide Guards `cooldown`/`ok`, Follower 0 eigene Versuche, Log-Marker `following (hold, verify after)` + `healthy after linked-guard repair`.
  - **Cleanup:** wie B2.4

---

## Guard-Linking · PoE-Fabric · Pitfalls F1–F6/CC7 · Automatisierung

### P0 — Guard-Linking (LinkCoordinator)

> **Rolle = Erstellungsreihenfolge** (s. Voraussetzungen → Konventionen): Asserts rollen-agnostisch über beide Guards.

- [ ] **LINK-1 — Link-Checkboxen symmetrisch (Add + Reconfigure)** · `P1`
  - **Prüft:** Die Link-Auswahl wird beidseitig wirksam — eine einseitige Deklaration verhält sich zur Laufzeit wie eine volle Gruppe (Clique-Schließung).
  - **Files:** `links.py` → `link_components`/`group_of` (ungerichteter Union + Connected-Components, stale ids werden verworfen); `config_flow.py:849` → `group_of(...)` liefert die Section-Defaults; `config_flow.py:243/396` → `SECTION_LINK`/`CONF_LINKED_GUARDS`-Selector (zeigt nur recover-fähige andere Guards).
  - **Treiber:** Zwei Recover-Guards auf `input_boolean.test_5` anlegen, beim **zweiten** den ersten als `linked_guards` setzen: `s1=N.create_guard({...,"name":"LinkA",...})`; `s2=N.create_guard({...,"name":"LinkB","linked_guards":[s1[1]],...})`. Danach `N.list_subentries(N.hub_id())` lesen.
  - **Assert:** Beide Subentries existieren; im Reconfigure-Flow von **LinkA** ist LinkB als Partner vorausgewählt (symmetrisch via `group_of`), obwohl nur bei LinkB deklariert.
  - **Cleanup:** `N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-2 — Follower folgt, löst nicht selbst aus, verifiziert eigene Health** · `P0`
  - **Prüft:** Geht ein Gruppen-Partner in RECOVERING, *folgt* der andere (hold + danach Re-Verify gegen eigene Health) statt einen konkurrierenden Cycle zu starten → kein Doppel-Port-Cycle.
  - **Files:** `links.py:135` → `LinkCoordinator.on_partner_repair_start` (setzt `following=True`, `_set_state(RECOVERING)`); `links.py:185` → `validate_after_repair` (healthy → `_recover_success`); `engine.py:342` → `_evaluate` (`if self._following: emit; return`) und `engine.py:428` `_run_recovery_cycle` finally → `links.notify_done`.
  - **Treiber:** LinkA+LinkB wie LINK-1 auf `input_boolean.test_5`, beide `action_check` mit Heil-Aktion `input_boolean.turn_on test_5`. Health brechen: `N.call("input_boolean","turn_off",entity_id="input_boolean.test_5")`. `N.wait(debounce+boot_window+2)`. Dann `N.log()`.
  - **Assert:** (rollen-agnostisch, s. Konventionen) Über **beide** Guards: genau einmal `"linked guard is repairing — following (hold, verify after)"` **und** `"healthy after linked-guard repair"` (beim Follower); beide `N.guard(...)` → `cooldown`/`ok`, je `recover_count=1`; **genau eine** `"recovery attempt 1/"`-Zeile insgesamt (nur der Leader cyclet — kein Doppel-Cycle).
  - **Cleanup:** `N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-3 — Synchroner RECOVERING-Claim, Partner konkurrieren nie** · `P0`
  - **Prüft:** Brechen beide gleichzeitig durch den Debounce, beansprucht einer synchron die Leader-Rolle (`_set_state(RECOVERING)` vor dem Task), der zweite findet ihn via `find_repairing_partner` und folgt.
  - **Files:** `engine.py:405` → `_start_cycle` (synchroner `_set_state(GState.RECOVERING)` vor `async_create_task`); `engine.py:394` → `_debounce_done` (`if (leader := self._find_repairing_partner())`); `links.py:97` → `find_repairing_partner` (Partner in RECOVERING/VERIFY und **nicht** `following`, erreicht über `partner.links.following`).
  - **Treiber:** LinkA+LinkB mit **gleichem** kleinen `debounce` auf `input_boolean.test_5`. Health brechen, `N.wait(debounce+2)`, dann `N.log()`.
  - **Assert:** Genau ein Guard zeigt `"debounce elapsed, starting recovery"`; der andere `"already repairing — following instead"` (engine) oder `"linked guard is repairing — following (hold, verify after)"` (links). Nur **ein** Recovery-Driver-Aufruf insgesamt.
  - **Cleanup:** `N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-4 — Follower-Erfolg → COOLDOWN + Event; Follower-Erfolg-Notify standardmäßig still** · `P1`
  - **Prüft:** Ein erfolgreich „mitgeheilter" Follower durchläuft denselben Erfolgspfad (COOLDOWN, `recover_count++`) und feuert weiter das `necromancer_guard_repair`-Event — aber **kein** `recovery_success`-Notify (Push), außer der Guard hat `behavior.notify_follower_success` an (Checkbox in der Verknüpfte-Guards-Section). Misserfolg (`linked_repair_failed`) meldet immer.
  - **Files:** `links.py:185` → `validate_after_repair` (healthy → `_recover_success(via_link=True)`); `engine.py` → `_recover_success(via_link)` (Notify nur wenn `not via_link or behavior.notify_follower_success`); `config_flow_helpers/schemas.py` → `_link_section` (BooleanSelector `notify_follower_success`), `_build_data` (speichert Flag in behavior); `links.py:106`/`:118` → `notify_start`/`notify_done` (`EVENT_GUARD_REPAIR`).
  - **Treiber:** LINK-2-Setup (Default: Flag aus). Variante B: Follower mit `notify_follower_success=true` rekonfigurieren.
  - **Assert:** Default: beide Status-Sensoren `cooldown`→`ok`, beide `recover_count=1`, `necromancer_guard_repair` pro Guard gefeuert, aber Follower-`recovery_success`-Notify **fehlt** (nur Leader meldet). Variante B: Follower meldet auch `recovery_success`. Automatisiert: `test_engine.py::test_follower_success_notify_gated`.
  - **Cleanup:** `N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-5 — Leader scheitert + Follower noch krank → Follower eskaliert (kein Kaskaden-Recovery)** · `P1`
  - **Prüft:** Heilt der Leader die geteilte Ursache nicht und der Follower ist weiter unhealthy, folgt der Follower der Eskalation statt eine konkurrierende (die Gruppe re-triggernde) Recovery zu starten.
  - **Files:** `links.py:185-217` → `validate_after_repair` (still unhealthy + `leader_success=False` → `_set_state(ESCALATED)` + `_notify("linked_repair_failed")`).
  - **Treiber:** LinkA+LinkB, beide Aktion schreibt nur `input_text.test_note` (heilt NICHT). Health brechen, `N.wait(debounce+boot_window*max_attempts+2)`, `N.log()`.
  - **Assert:** Follower-Log `"linked repair failed and still unhealthy — escalating"`; `N.guard("linkb")` → `escalated`, `recover_count=0`, Follower-Driver-`calls=0` (nie eigene Recovery).
  - **Cleanup:** `N.call("input_boolean","turn_on",entity_id="input_boolean.test_5"); N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-6 — CC7: Auto-aus → Follower folgt NICHT, eskaliert lokal** · `P0`
  - **Prüft:** Ein Guard mit deaktivierter Auto-Reparatur nimmt nie an einer Gruppen-Reparatur teil; ist sein eigenes Gerät betroffen, eskaliert er (Alarm) statt still zu folgen.
  - **Files:** `links.py:147-160` → `on_partner_repair_start` (`if not eng.auto: if health==UNHEALTHY and state!=ESCALATED → WARNING + _set_state(ESCALATED) + _notify("no_auto_recovery", reason="auto_off")`).
  - **Treiber:** LinkA+LinkB linked. Bei einem (hier LinkB) Auto-Reparatur ausschalten **und verifizieren**: `N.call("switch","turn_off",entity_id="switch.linkb_auto_reparatur")`; prüfe `N.st("switch.linkb_auto_reparatur")["state"] == "off"` (sonst läuft der Guard mit Auto-an → Szenario ungültig). Dann Health brechen, `N.wait(debounce+2)`, `N.log()`.
  - **Assert:** `N.guard("linkb")` → `escalated`; im Log für LinkB `"auto-recovery is off"` (als Follower `"linked guard repairing but auto-recovery is off — escalating"`, oder — falls LinkB selbst zuerst auslöst — `"still unhealthy but auto-recovery is off"`); **kein** `"recovery attempt 1/"` für LinkB.
  - **Cleanup:** `N.call("switch","turn_on",entity_id="switch.linkb_auto_reparatur"); N.delete_subentry(*s2); N.delete_subentry(*s1)`

- [ ] **LINK-7 — Auflösen: Abwahl trennt beidseitig, Clique-Schließung** · `P1`
  - **Prüft:** Einen Partner abwählen entfernt die Kante in beiden Richtungen; transitive Gruppen (A-B, B-C) bleiben zusammen, bis jemand alle Kanten desselben Linktyps löst.
  - **Files:** `links.py:25` → `link_components` (Connected-Components), `links.py:58` → `group_of` (Gruppe ohne sich selbst); `config_flow.py:1036-1049` → Reconfigure schreibt den `linked_guards`-Diff beidseitig in die Partner-Subentries zurück.
  - **Treiber:** A,B,C anlegen, A↔B und B↔C linken. Im Reconfigure von B den Partner A abwählen, speichern. `N.list_subentries(N.hub_id())` + Reconfigure-Defaults von A lesen.
  - **Assert:** A hat B nicht mehr als Partner (beidseitig getrennt); B↔C bleibt. (Gruppe wird über `link_components` neu berechnet.)
  - **Cleanup:** alle drei `N.delete_subentry(...)`

- [ ] **LINK-8 — Teardown race-safe: Stop eskaliert Follower nicht** · `P1`
  - **Prüft:** Wird der Leader während eines laufenden Cycles gestoppt/entladen, meldet die abgebrochene Cycle-`finally` **keinen** (gescheiterten) Repair an die Gruppe — Follower bleiben hängend, eskalieren nicht.
  - **Files:** `engine.py:198-222` → `async_stop` (`_stopping=True`, `links.reset()`, `_cycle_task.cancel()`); `engine.py:476-481` → `_run_recovery_cycle` finally (`if not self._stopping: links.notify_done(...)`); `links.py:176`/`:218-222` → `on_partner_repair_done`/`validate_after_repair` (`if eng._busy() or eng._stopping: return`, `_cycle_task=None` im finally).
  - **Treiber:** Primär durch Engine-Unit-Test gespiegelt — Live über Reload während eines blockierenden `recover()` schwer reproduzierbar. Live-Smoke: LinkA+LinkB, Health brechen, sofort `POST /api/config/config_entries/entry/<hub>/reload`, danach `N.log()`.
  - **Assert:** `N.log()` zeigt für den Follower **kein** `"escalating"` aus der Teardown-Phase; `N.g("/api/config")["state"]=="RUNNING"`, 0 Tracebacks. (Abgedeckt durch `test_engine.py::test_leader_stop_does_not_escalate_follower`.)
  - **Cleanup:** `N.delete_subentry(*s2); N.delete_subentry(*s1)`

### P0 — PoE-Fabric = einzige PoE-Autorität (H1b)

- [ ] **POE-1 — `resolve_with_reason`: 1 / 0 / >1 Match** · `P0`
  - **Prüft:** Genau ein Live-Match → Port (+ Cache-Refresh); 0 Live → last-known Cache; mehrdeutig (>1) → verweigert mit Grund; jeder gemeldete Port-id-Wert per DEBUG auditierbar.
  - **Files:** `poe.py:151` → `resolve_with_reason` (`len(live)==1` → `_learn`+return; `>1` → `f"'{identifier}' matches {len(live)} ports"`; cache-Fallback; sonst `f"no port matches '{identifier}'"`); DEBUG-Trace `poe.py:163` `"PoE %s:   port %r reports id %r"`.
  - **Treiber:** Abgedeckt durch `test_poe.py::test_resolve_live_single`, `test_resolve_ambiguous`, `test_resolve_last_known`, `test_resolve_none`. Live-Smoke: Port mit `id_entity` anlegen, `N.setstate(id_entity,"aa:bb")`, einen `poe_port`-Guard mit `expected_id="aa:bb"` → `N.guard(...)` `target`-Attribut prüfen.
  - **Assert:** Status-Sensor-`target` nennt das gelöste Port-Label; bei Mehrdeutigkeit ERROR-Log `"matches 2 ports"` und `can_recover` blockt (Guard → escalated).
  - **Cleanup:** `N.remove_port("<label>"); N.delete_subentry(...)`

- [ ] **POE-2 — Stale-Cache-Drop bei umgekabeltem Port (B1)** · `P0`
  - **Prüft:** Liegt der last-known Port jetzt auf einer **anderen** Live-id, wird der gecachte Eintrag verworfen und die Auflösung verweigert (kein Reboot des falschen Geräts).
  - **Files:** `poe.py:177-198` → `resolve_with_reason` (Cache-Fallback: `occupant = _norm(self._port_id(port))`; `occupant is None` → last-known WARNING + return; sonst `"now serves %r — dropping stale cache"` + `_cache.pop(target, None)` + refuse).
  - **Treiber:** Abgedeckt durch `test_poe.py::test_resolve_last_known_skips_occupied_port` (cache `{"aa:aa":"P1"}`, P1 meldet jetzt fremde id → `f.cache.get("aa:aa") is None`).
  - **Assert:** `test_resolve_last_known_skips_occupied_port` grün; im Log `"dropping stale cache"`.
  - **Cleanup:** —

- [ ] **POE-3 — Coalescing statt Per-Port-Lock: Driver + Service teilen EINEN Cycle** · `P0`
  - **Prüft:** Mehrere gleichzeitige Aufrufer für **denselben** Port (poe_port-Driver **und** `necromancer.repair_poe_port`) laufen in genau **einen** Power-Cycle zusammen (`asyncio.shield` auf den In-Flight-Task) — kein Doppel-Cycle.
  - **Files:** `poe.py:231-257` → `repair` (`self._inflight[label]`; bei laufendem Task `"already recovering — joining in-flight cycle"` + `await asyncio.shield(task)`; sonst Task synchron registrieren), `_run_cycle`/`_cycle`. **Kein** `asyncio.Lock` mehr.
  - **Treiber:** Abgedeckt durch `test_poe.py::test_concurrent_callers_coalesce` und `test_driver_and_service_coalesce` (verbreitertes Cycle-Fenster über Stubs, zwei parallele Aufrufer → ein Cycle). Live: `N.call("necromancer","repair_poe_port",id="aa:bb")` während ein poe_port-Guard cyclet.
  - **Assert:** Beide Tests grün; Log `"already recovering — joining in-flight cycle"`; der Actuator wird genau einmal off/on geschaltet.
  - **Cleanup:** —
  - *Hinweis: ersetzt die OBSOLETEN Test-Namen `test_per_port_lock_serialises`/`test_driver_and_service_share_lock` (gelöscht).*

- [ ] **POE-4 — Service `repair_poe_port` heilt eigenständig + Status-Event** · `P1`
  - **Prüft:** `necromancer.repair_poe_port(id)` löst auf, cyclet und feuert `necromancer_poe_port` (good/recovering/failed) pro Port.
  - **Files:** `poe.py:231` → `repair`; `poe.py:259-266` → `_run_cycle` (`_set_status` PORT_RECOVERING→good/failed); `poe.py:222-228` → `_set_status` feuert `EVENT_PORT_STATUS = f"{DOMAIN}_poe_port"` (**definiert in `poe.py:44`, nicht const.py**); Service-Registrierung in `__init__.py:134-140` (`_repair_poe_port`).
  - **Treiber:** Port via `N.add_port({...})`, dann `N.call("necromancer","repair_poe_port",id="<expected_id>")`. `N.log()`.
  - **Assert:** Log `"PoE port"` mit Statuswechsel; Actuator-Entität wurde off/on geschaltet; Service-Status 200.
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **POE-5 — `poe_port`-Driver = dünner Fabric-Adapter (kein Per-Guard-Cache)** · `P1`
  - **Prüft:** Der `poe_port`-Driver delegiert resolve+cycle vollständig an `hass.data[DOMAIN]["fabric"]`; er hält keinen eigenen Cache.
  - **Files:** `drivers/poe_port.py:29` → `_fabric()` (`hass.data.get(DOMAIN, {}).get("fabric")`), `can_recover`→`fabric.resolve_with_reason`, `recover`→`fabric.repair`, `config_errors`→`fabric.port_count==0`.
  - **Treiber:** Abgedeckt durch `test_poe.py::test_driver_recover_cycles_via_fabric`, `test_driver_can_recover_and_target`, `test_driver_blocks_on_no_match`, `test_driver_no_ports_config_error`.
  - **Assert:** Diese vier Tests grün; ein `poe_port`-Guard ohne konfigurierte Ports → ERROR `"no ports configured"` und `escalated`.
  - **Cleanup:** —

- [ ] **POE-6 — Platzhalter-ids werden nie gelernt (kein „moved port"-Sturm)** · `P0`
  - **Prüft:** `-`/leer/`unknown`/`unavailable`/`none` → `_norm`=None → nie gelernt, matchen nie einen Guard → keine fälschlichen Re-Cabling-WARNINGs.
  - **Files:** `poe.py:48` → `_PLACEHOLDER_IDS`, `poe.py:51` → `_norm` (collapse to None), `poe.py:120-125` → `_relearn` (nur bei `pid` truthy → `_learn`), `resolve_with_reason` (`target=_norm(identifier)`).
  - **Treiber:** Abgedeckt durch `test_poe.py::test_placeholder_ids_are_never_learned`. Live: Port-id-Entity auf `"-"` setzen, `POST .../entry/<hub>/reload`, `N.log()`.
  - **Assert:** `test_placeholder_ids_are_never_learned` grün; **0** `"moved port"`-WARNINGs nach Reload.
  - **Cleanup:** —

- [ ] **POE-7 — Re-Cabling-WARNING nur bei echtem Wechsel einer realen id** · `P2`
  - **Prüft:** Wandert eine **reale** id Port A→B, folgt der Cache und es feuert **eine** WARNING `"moved port"`; Platzhalter lösen nie eine aus.
  - **Files:** `poe.py:109-118` → `_learn` (`prev is None` → INFO `"learned"`; sonst WARNING `"%r moved port %r -> %r"`).
  - **Treiber:** Abgedeckt durch `test_poe.py::test_relearn_recable_updates_cache`. Live schwer provozierbar (echte MAC umstecken) → nur Smoke.
  - **Assert:** `test_relearn_recable_updates_cache` grün; bei echtem Umstecken genau eine `"moved port"`-WARNING.
  - **Cleanup:** —

### P0 — Pitfall-Fixes F1–F6 + CC7

- [ ] **F1 — Doppelter Guard-Name beim Submit abgelehnt** · `P0`
  - **Prüft:** Ein bereits vergebener Guard-Name wird beim Submit geblockt (Fehler `duplicate_name`), nicht nur als Warnung.
  - **Files:** `config_flow.py:804` → `_name_taken`; `config_flow.py:890-892` → `elif self._name_taken(...): errors[CONF_NAME]="duplicate_name"`.
  - **Treiber:** Guard `DupX` anlegen, dann zweiten Flow mit demselben `name="DupX"` treiben; die letzte `_post_flow`-Antwort prüfen.
  - **Assert:** Antwort enthält `errors == {"name": "duplicate_name"}`, **kein** `create_entry`; `list_subentries` zählt nur **einen** `DupX`.
  - **Cleanup:** `N.delete_subentry(<entry>, <sub des ersten DupX>)`

- [ ] **F2 — Template-Health referenziert eigene Entity → Feedback-Loop-WARNING** · `P0`
  - **Prüft:** Eine (Template-)Health, die eine guard-eigene Entity referenziert, erzeugt eine WARNING (kein Crash). Feuert erst nach Reload/Neustart (Entities sind beim Erst-Load noch nicht registriert).
  - **Files:** `engine.py:182-196` → `_check_config` (`own = {e.entity_id ... e.platform==DOMAIN and e.unique_id.startswith(self._subentry_id)}`; `loop = own ∩ health.referenced_entities()` → WARNING `"references its own entit(ies) ... feedback loop"`).
  - **Treiber:** `template_based`-Guard anlegen, dessen Template `sensor.<slug>_status` o. ä. referenziert; danach `POST /api/config/config_entries/entry/<hub>/reload`; `N.log()`.
  - **Assert:** Log enthält `"feedback loop"` (gleiche Zeile nennt auch `"references its own entit"`); `N.g("/api/config")["state"]=="RUNNING"`, 0 Tracebacks. (Abgedeckt durch `test_integration.py::test_health_self_reference_warns`, das auf `"feedback loop" in cap.text()` prüft.)
  - **Cleanup:** `N.delete_subentry(...)`

- [ ] **F4 — Reason-Konstanten englisch & konsistent** · `P2`
  - **Prüft:** Recovery-Reason-Strings sind einheitlich englische Konstanten.
  - **Files:** `const.py:36-37` → `REASON_OBSERVE = "observe"` / `REASON_AUTO_OFF = "auto_off"`; `policies/base.py:29` gibt `REASON_AUTO_OFF` zurück, `policies/notify.py:19` `REASON_OBSERVE`; `engine.py:378` (`_debounce_done`) nutzt `REASON_OBSERVE`.
  - **Treiber:** — (rein statisch)
  - **Assert:** `grep` in `const.py` zeigt `REASON_AUTO_OFF` und `REASON_OBSERVE`; keine deutschen Reason-Strings im Code.
  - **Cleanup:** —

- [ ] **F6 — Leere Aktion(en) beim Submit abgelehnt** · `P0`
  - **Prüft:** `action`/`off_action`/`on_action` ohne Inhalt werden beim Submit geblockt (`action_required`).
  - **Files:** `config_flow.py:967` → `errors[CONF_ACTION]="action_required"`; `config_flow.py:988`/`:990` → `off_action`/`on_action`.
  - **Treiber:** `action`-Strategie-Guard treiben, im Action-Step leere Aktion `[]` posten; letzte `_post_flow`-Antwort prüfen.
  - **Assert:** Antwort enthält `errors` mit `action_required`, **kein** `create_entry`.
  - **Cleanup:** —

- [ ] **CC7 — „bei aus bleibt aus": deaktivierte Auto-Reparatur eskaliert, handelt nie** · `P0`
  - **Prüft:** Auto-Reparatur aus → Guard eskaliert beim Health-Bruch, startet **keine** Recovery und folgt auch **keiner** Gruppen-Reparatur (s. LINK-6).
  - **Files:** `engine.py:376-391` → `_debounce_done` (`policy.should_attempt(auto_enabled=self.auto)` → not allowed → `_notify("no_auto_recovery", reason)` + `_set_state(ESCALATED)`); `policies/base.py:29` liefert `REASON_AUTO_OFF`; `links.py:147-160` → `on_partner_repair_start` (`if not eng.auto: ... ESCALATED`).
  - **Treiber:** Recover-Guard `CC7x` auf `input_boolean.test_5`, `N.call("switch","turn_off",entity_id="switch.cc7x_auto_reparatur")`. Health brechen, `N.wait(debounce+2)`.
  - **Assert:** `N.guard("cc7x")` → `escalated`, `recover_count=0`, Driver nie aufgerufen; Notify-Key `no_auto_recovery` (de: „Problem erkannt, Auto-Reparatur ist deaktiviert."). Im Log `"auto-recovery is off"`.
  - **Cleanup:** `N.call("input_boolean","turn_on",entity_id="input_boolean.test_5"); N.delete_subentry(...)`

### Automatisiert statt manuell

- [ ] **AUTO-1 — Automatisierte Suiten laufen grün (18/16/30/7)** · `P0`
  - **Prüft:** Die vier Real-HA-core-Suiten (`tests.common.async_test_home_assistant`) sind grün und decken PoE resolve/cycle/coalescing/Platzhalter, Engine-State-Machine + Persistenz, Health-Registry-Events inkl. Template-Blind-Erkennung (B3), Linking-Koordination ab.
  - **Files:** `tests/test_units.py` (18), `test_poe.py` (16), `test_engine.py` (30), `test_integration.py` (7 Test-Funktionen / 12 `ok(...)`-Checks). Health-Tests u. a. `test_health_self_reference_warns`, `test_health_template_all_missing_is_blind`, `test_health_template_partial_missing_warns_only`. Linking-Tests u. a. `test_engine.py::test_linked_follower_recovers_with_leader`, `test_linked_follower_escalates_when_leader_fails`, `test_linked_auto_off_follower_escalates`, `test_leader_stop_does_not_escalate_follower`, `test_debounce_arbitration_second_follows`.
  - **Treiber:** Aus `<ha-core>`: `PYTHONPATH=<ha-core>:<ha-core>/config python -m pytest tests -q` (in-process, kein laufender Server nötig).
  - **Assert:** `test_units` 18, `test_poe` 16, `test_engine` 30 passed; `test_integration` grün (7 Test-Funktionen → `12/12 checks passed`). Gesamt **kein** FAIL/ERROR.
  - **Cleanup:** —
  - *Hinweis: Doc-Zähler 10/15/8/„51" sind STALE → korrigiert auf 18/16/30/7.*

- [ ] **AUTO-2 — Gates grün (ruff/format)** · `P1`
  - **Prüft:** Lint-/Format-Gates bestehen für das Necromancer-Paket.
  - **Treiber:** Aus `<ha-core>`: `uv run ruff check custom_components/necromancer` und `uv run ruff format --check custom_components/necromancer` (ruff findet die repo-eigene `pyproject.toml` über den Ziel-Pfad — **nie** aus `repo/` ausführen).
  - **Assert:** `ruff check` „All checks passed!"; `ruff format --check` ohne Änderungsvorschlag.
  - **Cleanup:** —

---

## Health-Quellen (state/template) · 7 Strategien + Health-Check-Semantik

### Health-Quellen: state_based vs template_based

- [ ] **HQ1 — Source-Step zeigt Radio state/template** · `P0`
  - **Prüft:** Der erste Schritt der Gerät-hinzufügen-Subentry bietet die Zustandsquelle als List-Radio `state_based`/`template_based`.
  - **Files:** `config_flow.py` → `_source_schema` (Z. 283-294, `options=[SOURCE_STATE, SOURCE_TEMPLATE]`, `translation_key="source_type"`) · `const.py` Z. 54-55 (`SOURCE_STATE="state_based"`, `SOURCE_TEMPLATE="template_based"`).
  - **Treiber:** Flow direkt starten (POST-only): `import requests; r=requests.post(N.BASE+"/api/config/config_entries/subentries/flow", headers=N.H, json={"handler":[N.hub_id(),"device"]}, timeout=15).json(); fid=r["flow_id"]`.
  - **Assert:** `r["step_id"]=="user"` und im `data_schema` hat das Feld `source_type` ein `select`-Selector mit options `["state_based","template_based"]`.
  - **Cleanup:** — (Flow nie abgeschlossen).

- [ ] **HQ2 — state_based: Device-Step zeigt Section „state_check"** · `P0`
  - **Prüft:** Bei `state_based` enthält der Device-Step die Section `state_check` mit Entität + Attribut + on/off-Werten, KEIN Template.
  - **Files:** `config_flow.py` → `_health_section` (Z. 302-321), `_watch_fields` (Z. 218-233), `SECTION_STATE="state_check"` (Z. 240).
  - **Treiber:** Flow wie HQ1 starten (`fid=r["flow_id"]`), dann `r=requests.post(N.BASE+f"/api/config/config_entries/subentries/flow/{fid}", headers=N.H, json={"source_type":"state_based"}, timeout=15).json()`.
  - **Assert:** `r["step_id"]=="device"`; `data_schema` enthält ein Feld `state_check` (section) mit Sub-Feldern `entity_id`,`on_value`,`off_value`; kein `template_check`/`template`.
  - **Cleanup:** —

- [ ] **HQ3 — template_based: Device-Step zeigt Section „template_check"** · `P0`
  - **Prüft:** Bei `template_based` enthält der Device-Step die Section `template_check` (TemplateSelector), KEINE Entität/on-off.
  - **Files:** `config_flow.py` → `_health_section` Z. 304-312 (`SECTION_TEMPLATE`, `TemplateSelector()`), `SECTION_TEMPLATE="template_check"` (Z. 241).
  - **Treiber:** Flow wie HQ1 starten (`fid=r["flow_id"]`), dann `r=requests.post(N.BASE+f"/api/config/config_entries/subentries/flow/{fid}", headers=N.H, json={"source_type":"template_based"}, timeout=15).json()`.
  - **Assert:** `r["step_id"]=="device"`; `data_schema` enthält `template_check` mit Sub-Feld `template` (selector `template`); kein `state_check`/`entity_id`.
  - **Cleanup:** —

- [ ] **HQ4 — state_based end-to-end: Guard reagiert auf Health-Entity** · `P0`
  - **Prüft:** Ein angelegter state_based-Guard wird über `watched_entities` event-getrieben und wechselt bei Health=off in SUSPECT → nach debounce in Recovery.
  - **Files:** `health/entity_state.py` → `watched_entities` (Z. 54-56), `evaluate` (Z. 58-81).
  - **Treiber:** `N.setstate("input_boolean.test_1","on")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"HQstate","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action","action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"hit"}}],"behavior":{"debounce":2,"cooldown":3}})`; `N.guard("hqstate")` → erwartet `ok`; `N.setstate("input_boolean.test_1","off"); N.wait(1)`.
  - **Assert:** `N.guard("hqstate")[0]=="suspect"` (innerhalb debounce); nach `N.wait(3)` enthält `N.log()` `"HQstate debounce elapsed, starting recovery"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **HQ5 — template_based + Tracking re-evaluiert bei Referenz-Änderung** · `P0`
  - **Prüft:** Template `{{ is_state('input_boolean.test_2','on') }}` wird via `async_track_template_result` getrackt; Ändern der referenzierten Entity re-evaluiert Health. `watched_entities==[]`.
  - **Files:** `health/template.py` → `async_setup` (Z. 61-72), `watched_entities` (Z. 39-41), `evaluate` (Z. 50-59).
  - **Treiber:** `N.setstate("input_boolean.test_2","on")`; `eid,sub=N.create_guard({"source_type":"template_based","name":"HQtmpl","health":{"template":"{{ is_state('input_boolean.test_2','on') }}"},"mode":"recover","strategy":"action","action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}],"behavior":{"debounce":2,"cooldown":3}})`; `N.guard("hqtmpl")` → `ok`; `N.setstate("input_boolean.test_2","off"); N.wait(1)`.
  - **Assert:** `N.guard("hqtmpl")[0]=="suspect"` (Template re-evaluierte ohne eigenes watched_entities-Abo).
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_2","on")`.

- [ ] **HQ-CHK — template_based + Health-Check: VERIFY greift, recovered** · `P0`
  - **Prüft:** Ein Template-Guard mit `*_check`-Strategie geht nach `recover()` in VERIFY; heilt die Aktion die Template-Bedingung, re-evaluiert das Template → Health=OK → COOLDOWN (Template ist prüfbar, anders als ein Trigger).
  - **Files:** `health/template.py` → `evaluate` (Z. 50-59, on-demand für VERIFY); `engine.py` → `_run_recovery_cycle` Z. 467-472 (`_set_state(VERIFY)`→`_wait_health_ok`→`_recover_success`), `_wait_health_ok` Z. 483-493.
  - **Treiber:** `N.setstate("input_boolean.test_5","off")`; `eid,sub=N.create_guard({"source_type":"template_based","name":"HQtcheck","health":{"template":"{{ is_state('input_boolean.test_5','on') }}"},"mode":"recover","strategy":"action_check","action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_5"}}],"behavior":{"debounce":1,"boot_window":10,"cooldown":3,"max_attempts":2}})`; `N.wait(4)`.
  - **Assert:** `N.log()` enthält `"HQtcheck recovered after 1 attempt(s)"`; `N.guard("hqtcheck")[0]` in `("cooldown","ok")`; `attrs["recover_count"]>=1`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_5","off")`.

- [ ] **HQ6 — Template-Verdicts: kein Fehlalarm bei unklarem Ergebnis** · `P0`
  - **Prüft:** `result_as_boolean` + UNKNOWN-Set: `{{ true }}`→OK · `{{ false }}`→UNHEALTHY · `{{ states('sensor.does_not_exist') }}`/leer/`none`→UNKNOWN (kein SUSPECT).
  - **Files:** `health/template.py` → `evaluate` Z. 50-59, `_UNKNOWN_RESULTS={"","none","unknown","unavailable"}` (Z. 29).
  - **Treiber:** Drei kurzlebige notify-Guards anlegen (`mode="notify"`, `behavior={"debounce":2}`): a) `health.template="{{ true }}"`, b) `"{{ false }}"`, c) `"{{ states('sensor.does_not_exist') }}"`. Nach Anlegen je `N.wait(1)`.
  - **Assert:** a) `N.guard(slug)[0]=="ok"`; b) nach `N.wait(3)` Log `"<name> problem detected (notify-only)"`; c) bleibt `ok` (UNKNOWN ⇒ KEIN `"problem detected"` für c im Log).
  - **Cleanup:** alle drei `N.delete_subentry(eid,sub)`.

- [ ] **HQ-STATE-UNK — state_based: unavailable/unknown → UNKNOWN, kein Recover** · `P1`
  - **Prüft:** Eine state_based-Health, deren Entity `unavailable`/`unknown` meldet (und nicht explizit als `off_value` gelistet), liefert UNKNOWN statt UNHEALTHY → kein Fehlalarm, kein Recovery.
  - **Files:** `health/entity_state.py` → `evaluate` Z. 75-76 (`actual in (STATE_UNAVAILABLE, STATE_UNKNOWN) → UNKNOWN`), Z. 69-73 (expliziter `off_value` würde gewinnen).
  - **Treiber:** `N.setstate("input_boolean.test_3","on")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"HQunk","health":{"entity_id":"input_boolean.test_3","on_value":["on"],"off_value":["off"]},"mode":"notify","behavior":{"debounce":2}})`; `N.guard("hqunk")` → `ok`; `N.setstate("input_boolean.test_3","unavailable"); N.wait(3)`.
  - **Assert:** `N.guard("hqunk")[0]=="ok"` (bleibt ok); `N.log()` enthält KEIN `"HQunk problem detected (notify-only)"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_3","on")`.

- [ ] **HQ7 — Kaputtes Jinja im Flow abgelehnt** · `P0`
  - **Prüft:** Ungültiges Template (`{{ 1 + }}`) wird vom TemplateSelector validiert → Flow-Error, kein Submit.
  - **Files:** `config_flow.py` → `_health_section` Z. 308-311 (`selector.TemplateSelector()` validiert serverseitig).
  - **Treiber:** Flow starten (`fid=r["flow_id"]`), `{"source_type":"template_based"}`, dann device-Step posten mit `{"name":"HQbad","mode":"notify","assigned_device":{},"template_check":{"template":"{{ 1 + }}"}}`.
  - **Assert:** Antwort hat `errors` (z. B. `{"template_check":...}` oder `base`) bzw. `type!="create_entry"` und bleibt `step_id=="device"`.
  - **Cleanup:** — (kein Subentry erzeugt).

- [ ] **HQ8 — F2: Template referenziert eigene Entity → Feedback-Loop-WARNING** · `P1`
  - **Prüft:** Health-Template, das auf den eigenen Status-Sensor zeigt, löst nach Reload eine WARNING aus (kein Crash, HA bleibt RUNNING). Hinweis: feuert NUR nach Reload, nicht beim Erst-Load.
  - **Files:** `engine.py` Z. 191-192 (`"%s: health references its own entit(ies) %s — feedback loop"`), `health/template.py` → `referenced_entities` (Z. 43-48).
  - **Treiber:** `eid,sub=N.create_guard({"source_type":"template_based","name":"HQloop","health":{"template":"{{ is_state('sensor.hqloop_status','ok') }}"},"mode":"notify","behavior":{"debounce":2}})`; Reload erzwingen: `N.call("homeassistant","reload_config_entry",entry_id=eid)`; `N.wait(3)`.
  - **Assert:** `N.log()` enthält `"references its own entit(ies)"` UND `"feedback loop"`; `N.g("/api/config")["state"]=="RUNNING"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`.

### Strategien (7) + Health-Check-Semantik

- [ ] **ST1 — Strategie-Radio zeigt genau 8 (notify + 7), kein Mode-Feld im Device-Step** · `P0`
  - **Prüft:** Das Mode-Feld (Auto-Reparatur/Nur-benachrichtigen) ist aus dem Device-Step **entfernt**; die Wahl liegt jetzt als erste Option (`notify`) im Strategie-Step, gefolgt von den 7 Recovery-Strategien.
  - **Files:** `config_flow_helpers/schemas.py` → `_device_schema` (kein `CONF_MODE` mehr), `_strategy_schema` (`options=[MODE_NOTIFY, *_STRATEGIES]`), `_build_data` (`notify_only = strategy == MODE_NOTIFY`); `config_flow.py` → `async_step_strategy`-Dispatch (`MODE_NOTIFY: async_step_notify`).
  - **Treiber:** Flow starten (`fid=r["flow_id"]`) → `{"source_type":"state_based"}` → device-Step posten mit `{"name":"STseven","assigned_device":{},"state_check":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]}}` (KEIN `mode`).
  - **Assert:** Device-Step-Schema hat **kein** `mode`-Feld; `r["step_id"]=="strategy"`; das `strategy`-select hat options `["notify","switch","switch_check","action","action_check","actions","actions_check","poe_port"]` (8 Einträge, genau diese Reihenfolge). `notify` wählen → `step_id=="notify"`.
  - **Cleanup:** — (Flow nicht abgeschlossen).

- [ ] **ST2 — switch: off→delay→on Power-Cycle** · `P0`
  - **Prüft:** Strategie `switch` baut `switch_cycle`-Driver (homeassistant.turn_off → off_on_delay → turn_on). Ohne Health-Check ⇒ sofort recover_success.
  - **Files:** `config_flow.py` → `_build_driver` Z. 534-538 (`switch_cycle`), `drivers/switch_cycle.py` → `recover` (Z. 29-42).
  - **Treiber:** `N.setstate("switch.test_template_switch","on")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"STswitch","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"switch","switch_entity":"switch.test_template_switch","off_on_delay":1,"behavior":{"debounce":1,"cooldown":3}})`; `N.setstate("input_boolean.test_1","off"); N.wait(4)`.
  - **Assert:** `N.log()` enthält `"STswitch recovery attempt 1/"` und `"STswitch recovered after 1 attempt(s)"`; danach `N.guard("stswitch")[0]` in `("cooldown","ok")`; `attrs["recover_count"]>=1`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST3 — action (ohne Check): eine Sequenz, fire-and-forget** · `P0`
  - **Prüft:** Strategie `action` baut `action_call`-Driver; ohne Health-Check führt EIN recover() sofort zu recover_success ohne VERIFY.
  - **Files:** `config_flow.py` → `_build_driver` Z. 525-526 (`action_call`), `engine.py` Z. 464-466 (`if not health_check: _recover_success()`).
  - **Treiber:** `eid,sub=N.create_guard({"source_type":"state_based","name":"STact","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action","action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"fired"}}],"behavior":{"debounce":1,"cooldown":3}})`; `N.setstate("input_boolean.test_1","off"); N.wait(3)`.
  - **Assert:** `N.st("input_text.test_note")["state"]=="fired"`; `N.log()` enthält `"STact recovered after 1 attempt(s)"` (kein VERIFY-Zustand, da Check aus).
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST-RAISE — action wirft (OHNE Check) → kein Falsch-Erfolg → ESCALATED** · `P0`
  - **Prüft:** Wenn die Recovery-Aktion zur Laufzeit wirft (z. B. fehlender Service), wird das als FEHLGESCHLAGENER Versuch gewertet (nie recover_success), retry bis `max_attempts`, dann ESCALATED — auch ohne Health-Check. `recover_count` bleibt 0.
  - **Files:** `engine.py` → `_run_recovery_cycle` Z. 451-460 (BLE001-Pfad: `LOGGER.exception("Recovery driver failed for %s")`, retry/`_escalate`), `_escalate` Z. 522-528 (`"could not be recovered after"`).
  - **Treiber:** `N.setstate("input_boolean.test_1","on")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"STraise","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action","action":[{"service":"nonexistent.boom","data":{}}],"behavior":{"debounce":1,"cooldown":3}})`; `N.setstate("input_boolean.test_1","off"); N.wait(4)`.
  - **Assert:** `N.guard("straise")[0]=="escalated"`; `attrs.get("recover_count",0)==0`; `N.log()` enthält `"STraise could not be recovered after"` (Pfad über recover-raise ODER recovery_blocked — die Invariante ist „kein Erfolg, recover_count==0, terminal ESCALATED").
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST4 — actions: getrennte Aus-/Ein-Aktion + Delay** · `P0`
  - **Prüft:** Strategie `actions` baut `action_cycle`-Driver mit `off_action`/`on_action`/`off_on_delay`.
  - **Files:** `config_flow.py` → `_build_driver` Z. 527-533 (`action_cycle`), `drivers/action_cycle.py`.
  - **Treiber:** `eid,sub=N.create_guard({"source_type":"state_based","name":"STacts","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"actions","off_action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"OFF"}}],"on_action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"ON"}}],"off_on_delay":1,"behavior":{"debounce":1,"cooldown":3}})`; `N.setstate("input_boolean.test_1","off"); N.wait(4)`.
  - **Assert:** `N.st("input_text.test_note")["state"]=="ON"` (on_action lief zuletzt); `N.log()` enthält `"STacts recovered after 1 attempt(s)"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST5 — poe_port: Resolver findet Port per expected_id** · `P0`
  - **Prüft:** Strategie `poe_port` baut dünnen Adapter; Driver delegiert resolve+cycle an die Fabric, findet Port über `expected_id` in der flachen Liste.
  - **Files:** `config_flow.py` → `_build_driver` Z. 523-524 (`poe_port`,`expected_id`); `drivers/poe_port.py` → `can_recover` Z. 33-41 (`fabric.resolve_with_reason`), `target_info` Z. 52-56, `config_errors` Z. 58-65.
  - **Treiber:** Port anlegen: `N.add_port({"label":"STport","actuator":"input_boolean.sim_poe_port","id_static":"st-mac-1","status_entity":"input_boolean.sim_device_power","status_on":["on"],"status_off":["off"],"off_on_delay":1})`; `N.setstate("input_boolean.sim_device_power","on")`; Guard: `eid,sub=N.create_guard({"source_type":"state_based","name":"STpoe","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"poe_port","expected_id":"st-mac-1","behavior":{"debounce":1,"boot_window":5,"cooldown":3,"max_attempts":2}})`; `N.setstate("input_boolean.test_1","on")`.
  - **Assert:** Guard kommt sauber hoch: `N.guard("stpoe")[0]=="ok"`; `N.log()` enthält für STpoe KEIN `"no ports configured"`, KEIN `"no port matches 'st-mac-1'"` und KEIN `"matches"` (resolve fand `st-mac-1`).
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.remove_port("STport")`.

- [ ] **ST6 — *_check: VERIFY wartet auf Health=OK (Heal-Trick → recovered)** · `P0`
  - **Prüft:** Mit Health-Check geht die Engine nach recover() in VERIFY und wartet bis boot_window auf Health=OK; heilt die Aktion die Health, folgt COOLDOWN.
  - **Files:** `engine.py` → `_run_recovery_cycle` Z. 467-472 (`_set_state(VERIFY)`, `_wait_health_ok`→`_recover_success`), `_wait_health_ok` Z. 483-493.
  - **Treiber:** `N.setstate("input_boolean.test_5","off")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"STcheck","health":{"entity_id":"input_boolean.test_5","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action_check","action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_5"}}],"behavior":{"debounce":1,"boot_window":10,"cooldown":3,"max_attempts":2}})`; `N.wait(4)`.
  - **Assert:** `N.log()` enthält `"STcheck recovery attempt 1/2"` und `"STcheck recovered after 1 attempt(s)"`; `N.guard("stcheck")[0]` in `("cooldown","ok")`; `attrs["recover_count"]>=1`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_5","off")`.

- [ ] **ST7 — *_check: Aktion heilt nicht → max_attempts → ESCALATED** · `P0`
  - **Prüft:** Mit Health-Check, wenn die Aktion die Health NICHT heilt, läuft VERIFY ins Timeout, retry bis max_attempts, dann ESCALATED (terminaler ERROR, kein Traceback).
  - **Files:** `engine.py` Z. 473-475 (`attempt>=max → _escalate`), `_escalate` Z. 522-528 (`"could not be recovered after"`).
  - **Treiber:** `N.setstate("input_boolean.test_1","off")`; `eid,sub=N.create_guard({"source_type":"state_based","name":"STfail","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action_check","action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"noheal"}}],"behavior":{"debounce":1,"boot_window":3,"cooldown":3,"max_attempts":2}})`; `N.wait(12)`.
  - **Assert:** `N.guard("stfail")[0]=="escalated"`, `attrs["attempt"]==2`, `attrs.get("recover_count",0)==0`; `N.log()` enthält `"STfail could not be recovered after 2 attempt(s)"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST8 — boot_window/max_attempts nur bei *_check sichtbar** · `P0`
  - **Prüft:** Die Behavior-Section zeigt `boot_window`+`max_attempts` nur für Check-Strategien (und poe_port); bei Nicht-Check sind beide ausgeblendet.
  - **Files:** `config_flow.py` → `_behavior_section` Z. 416-446 (`if check: boot_window/max_attempts`), `_CHECK_STRATEGIES` Z. 114-117, `_poe_schema` ruft `_behavior_section(check=True)` Z. 666.
  - **Treiber:** Zwei Flows je bis zum Strategie-Submit treiben (state_based, mode recover; `fid=r["flow_id"]` je Flow): Flow A wählt `strategy=action`, Flow B wählt `strategy=action_check`; jeweils das nächste Form (`step_id=="action"`) inspizieren.
  - **Assert:** In Flow A (`action`) hat die `behavior`-Section NUR `debounce`,`cooldown` (kein `boot_window`/`max_attempts`). In Flow B (`action_check`) hat sie zusätzlich `boot_window` UND `max_attempts`.
  - **Cleanup:** — (Flows nicht abgeschlossen).

- [ ] **ST9 — Reconfigure-Vorauswahl der Strategie via _current_strategy** · `P1`
  - **Prüft:** Beim Reconfigure ist das Strategie-Radio mit der gespeicherten Strategie vorbelegt (driver-type + health_check-Flag).
  - **Files:** `config_flow.py` → `_current_strategy` (Z. 580-590), `async_step_strategy` Z. 929-933 (default aus `_current_strategy(self._reconfig_data())`).
  - **Treiber:** Guard `STrc` als `actions_check` anlegen (`strategy="actions_check"`, off/on-action + `behavior` mit boot_window/max_attempts). Reconfigure-Flow starten: `r=requests.post(N.BASE+"/api/config/config_entries/subentries/flow", headers=N.H, json={"handler":[eid,"device"],"subentry_id":sub}, timeout=15).json(); fid=r["flow_id"]`; Source-Step mit `{"source_type":"state_based"}` quittieren; device-Step durchreichen bis `strategy`.
  - **Assert:** Das `strategy`-Feld im Reconfigure-Strategie-Step hat `default=="actions_check"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`.

- [ ] **ST10 — Vorbedingung fehlt: switch_cycle ohne Switch → recovery_blocked → ESCALATED** · `P1`
  - **Prüft:** `can_recover` des switch_cycle-Drivers blockt, wenn die Switch-Entity fehlt → `recovery_blocked` → ESCALATED (kein recover()).
  - **Files:** `drivers/switch_cycle.py` → `can_recover` (Z. 23-27); `engine.py` Z. 446-450 (`if not ok: _escalate("recovery_blocked")`).
  - **Treiber:** `eid,sub=N.create_guard({"source_type":"state_based","name":"STnoswitch","health":{"entity_id":"input_boolean.test_1","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"switch","switch_entity":"switch.does_not_exist","off_on_delay":1,"behavior":{"debounce":1,"cooldown":3}})`; `N.setstate("input_boolean.test_1","off"); N.wait(3)`.
  - **Assert:** `N.guard("stnoswitch")[0]=="escalated"`; `N.log()` enthält `"STnoswitch recovery blocked:"`.
  - **Cleanup:** `N.delete_subentry(eid,sub)`; `N.setstate("input_boolean.test_1","on")`.

- [ ] **ST11 — action ohne Aktion im Flow abgelehnt (action_required)** · `P1`
  - **Prüft:** Ein `action`/`action_check`-Guard ohne Aktion wird beim Submit abgelehnt (kann nur eskalieren) — F6.
  - **Files:** `config_flow.py` → `async_step_action` Z. 962-979 (`if not flat.get(CONF_ACTION): errors[CONF_ACTION]="action_required"`); `async_step_actions` Z. 985-995 (off+on je `action_required`).
  - **Treiber:** Flow bis zum `action`-Step treiben (state_based, mode recover, strategy `action`; `fid=r["flow_id"]`), dann posten mit leerer Aktion: `{"action":[], "behavior":{"debounce":1,"cooldown":3}, "notification":{}, "linked_guards":{}}`.
  - **Assert:** Antwort hat `errors["action"]=="action_required"`, `type!="create_entry"`, bleibt `step_id=="action"`.
  - **Cleanup:** — (kein Subentry).

- [ ] **RL1 — Reload-Geräte-Integration: Checkbox nur bei zugewiesenem Gerät + Reload nach Repair** · `P1`
  - **Prüft:** Die `reload`-Section (Checkbox „Integration neu laden" + Delay) erscheint in den Recover-Steps **nur wenn im Device-Step ein Gerät gesetzt** wurde; ist sie an, lädt die Engine nach `driver.recover()` (vor VERIFY) die Config-Entry des zugewiesenen Geräts neu (mit Delay).
  - **Files:** `config_flow_helpers/schemas.py` → `_reload_section` (SECTION_RELOAD, BooleanSelector + `_seconds_selector`), als `reload_block`-Parameter **vor** der Notification-Section in `_switch_schema`/`_action_schema`/`_actions_schema`/`_poe_schema` eingefügt; `_build_data` (speichert `behavior.reload_entry`/`reload_delay` nur bei gesetztem `device_id`); `config_flow.py` → `_reload_block()` (gibt die Section nur zurück, wenn `self._step1[CONF_DEVICE_ID]`), an die 4 Recover-Steps via `reload_block=`; `engine.py` → `_maybe_reload_device_entry` (nach `recover()`, vor VERIFY: `dr` → `device.primary_config_entry`/`config_entries` → `hass.config_entries.async_reload`, best-effort).
  - **Treiber:** Recover-Guard MIT zugewiesenem Gerät anlegen, Reload-Checkbox an, kleiner Delay; Health brechen, Repair abwarten.
  - **Assert:** Schema des Recover-Steps enthält die `reload`-Section nur bei gesetztem Gerät (ohne Gerät fehlt sie), und zwar **vor** der Notification-Section; nach dem Repair erscheint im Log `"reloading the assigned device's integration (entry …)"` und die Geräte-Integration wurde neu geladen. Automatisiert: `test_units.py::test_build_data_reload_entry`, `test_engine.py::test_reload_device_entry_on_repair`.
  - **Cleanup:** Subentry löschen.

---

## Auto-Reparatur · Notify-als-Aktion · Corner Cases/Robustheit

### P0 — Auto-Reparatur (Switch statt Config-Feld)

- [ ] **AR1 — Kein auto_restart-Feld im Wizard** · `P1`
  - **Prüft:** Die „Verhalten"-Section enthält KEIN `auto_restart`-Feld mehr; Auto wird nur über den Laufzeit-Switch gesteuert.
  - **Files:** `config_flow.py` → `_behavior_section` (Zeile 416–446) baut `debounce`/`cooldown`/`boot_window`/`max_attempts`, aber KEIN `CONF_AUTO_RESTART` (siehe Kommentar Zeile 444–445); `const.py:128` → `CONF_AUTO_RESTART` existiert nur für Persistenz/Default `DEFAULT_AUTO_RESTART=True` (Zeile 142).
  - **Treiber:** `grep -n "auto_restart\|CONF_AUTO_RESTART" config_flow.py` → keine `vol.Optional/Required(CONF_AUTO_RESTART …)` in einem Step-/Section-Schema; Treffer nur im Kommentar.
  - **Assert:** Kein Schema-Feld `auto_restart` in `switch`/`action`/`actions`/`poe_port`/`notify`-Step.
  - **Cleanup:** —

- [ ] **AR2 — Switch-Default an, Toggle persistiert (überlebt Neustart)** · `P0`
  - **Prüft:** Guard startet mit `auto=True` (`DEFAULT_AUTO_RESTART`); `switch.<slug>_auto_reparatur` schreibt durch in den Store und überlebt Neustart.
  - **Files:** `switch.py:49` `async_turn_off` ruft `self._engine.set_auto(False)`; `engine.py:286` `set_auto` ruft `self._save()`; `engine.py:122` `_apply_persisted` restored `auto`; `engine.py:138` `snapshot()` schreibt `"auto"`; `__init__.py:104` Store-Key `f"{DOMAIN}.{entry.entry_id}"` (entry_id = Hub-Entry = `N.hub_id()`), je Subentry ein Eintrag mit `"auto"`.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"AutoPersist", health:{entity_id:"input_boolean.test_1", on_value:["on"], off_value:["off"]}, mode:"recover", strategy:"switch", switch_entity:"switch.test_template_switch", behavior:{debounce:5, cooldown:5}})` → `N.st("switch.autopersist_auto_reparatur")["state"]` == `"on"` → `N.call("switch","turn_off", entity_id="switch.autopersist_auto_reparatur")` → `N.wait(7)` (> `SAVE_DELAY=5`) → Store-Datei `<ha-core>/config/.storage/necromancer.<N.hub_id()>` lesen.
  - **Assert:** Vor Restart `N.st("switch.autopersist_auto_reparatur")["state"]=="off"`; in der Store-Datei steht unter `data.<subentry_id>` ein Objekt mit `"auto": false`. (Optional Restart-Variante per Runbook-Restart → Switch kommt als `off` hoch.)
  - **Cleanup:** `N.delete_subentry(entry, sub)`

- [ ] **AR3 — Auto aus → ESCALATED ohne Reparaturversuch + Notify `no_auto_recovery`** · `P0`
  - **Prüft:** Bei deaktivierter Auto-Reparatur eskaliert der Guard nach Debounce SOFORT (kein `recover()`), feuert `no_auto_recovery`-Notify, `recover_count` bleibt 0.
  - **Files:** `engine.py:368` `_debounce_done`: `policy.should_attempt(auto_enabled=self.auto)` (Zeile 376) → bei `not allowed` und `reason != REASON_OBSERVE` → `_notify("no_auto_recovery", reason=reason)` (Zeile 387–389) + `_set_state(GState.ESCALATED)` (Zeile 390); `policies/base.py:29` liefert `REASON_AUTO_OFF`.
  - **Treiber:** Guard wie AR2 (Name `AutoOff`, `behavior:{debounce:5, cooldown:5}`). `N.call("switch","turn_off", entity_id="switch.autooff_auto_reparatur")` → `N.call("input_boolean","turn_off", entity_id="input_boolean.test_1")` → `N.wait(8)` → `N.guard("autooff")`.
  - **Assert:** `N.guard("autooff")[0] == "escalated"`; `attrs["recover_count"] == 0`; `N.log()` enthält `"still unhealthy but auto-recovery is off"`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

### P0 — Notify als Aktion (ActionSelector + Variablen + de-Meldungen)

- [ ] **NA1 — ActionSelector in Section „Benachrichtigung" (optional)** · `P1`
  - **Prüft:** Notify ist eine optionale Aktions-Sequenz (ActionSelector) in der Section `notification`, KEINE Notify-Ziel-Liste.
  - **Files:** `config_flow.py:368` `_notification_section` → `vol.Optional(CONF_NOTIFY_ACTION …): selector.ActionSelector()` (Zeile 377–380), Section-Name `SECTION_NOTIFY="notification"` (Zeile 245); `const.py:135` `CONF_NOTIFY_ACTION="notify_action"`.
  - **Treiber:** `grep -n "ActionSelector" config_flow.py` (mind. die Notify-Section + Strategy-Action-Felder); kein `EntitySelector(domain="notify")` o. ä.
  - **Assert:** `_notification_section` baut genau ein optionales Feld `notify_action` als `ActionSelector`.
  - **Cleanup:** —

- [ ] **NA2 — `{{ message }}`/`{{ name }}`/`{{ event_text }}`/`{{ event }}` als Variablen verfügbar** · `P0`
  - **Prüft:** Die Notify-Aktion bekommt `message` (= „Name: Text"), `name`, `event_text` (Text OHNE Name), `event` (Notify-Key) + Event-Params (`attempt`, `max`, `attempts` [plural-korrekt], `reason`) als Variablen.
  - **Files:** `notify.py` → `_resolve(lang, name, key, params)` liefert `(message, event_text)` (message = `f"{name}: {event_text}"`, baut plural-`attempts`); `variables = {"message", "name", "event_text", "event", **params}` → `async_run(...)`.
  - **Treiber:** Guard `NotifyVar` (`strategy:"switch"`, `switch_entity:"switch.test_template_switch"`, Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5}`) mit `notify_action` = Aktion, die `input_text.test_note` setzt: `notify_action:[{"action":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"{{ event }}|{{ message }}"}}]`. Health brechen (`input_boolean.turn_off test_1`), Debounce ablaufen lassen (`N.wait(7)`).
  - **Assert:** `N.st("input_text.test_note")["state"]` enthält Event-Key + lokalisierte Meldung, z. B. beginnt mit `"recovery_attempt|NotifyVar: Reparaturversuch 1 von 2."` (de-Sprache). (Bei Auto-aus-Variante stattdessen `no_auto_recovery|NotifyVar: Problem erkannt, Auto-Reparatur ist deaktiviert.`)
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

- [ ] **NA3 — Lokalisierte de-Meldungen aus `NOTIFY_MESSAGES`** · `P0`
  - **Prüft:** Bei `language=de` rendert `{{ message }}` die deutschen Texte für `recovery_attempt/success/failed/blocked/no_auto_recovery/problem_detected`.
  - **Files:** `const.py` `NOTIFY_MESSAGES` `de`-Block (Texte OHNE Name-Präfix = `event_text`; z. B. `recovery_attempt`=`"Reparaturversuch {attempt} von {max}."`, `recovery_success`=`"Reparatur erfolgreich."`, `recovery_failed`=`"Reparatur fehlgeschlagen nach {attempts}."`, `no_auto_recovery`=`"Problem erkannt, Auto-Reparatur ist deaktiviert."`); `notify.py` → `_resolve` Sprachauswahl `hass.config.language` mit en-Fallback.
  - **Treiber:** Wie NA2; einmal Auto-aus erzwingen (→ `no_auto_recovery`), einmal heilbare `*_check`-Recovery (→ `recovery_success`, vgl. CC8). `input_text.test_note` jeweils prüfen.
  - **Assert:** `test_note` enthält exakt `"Problem erkannt, Auto-Reparatur ist deaktiviert."` bzw. `"Reparatur erfolgreich."` (deutsche Strings aus `NOTIFY_MESSAGES["de"]`, NICHT englisch).
  - **Cleanup:** `N.delete_subentry(entry, sub)` + Health zurücksetzen.

- [ ] **NA4 — Fehlender Notify-Service → gefangen, kein Crash** · `P0`
  - **Prüft:** Eine Notify-Aktion mit nicht existierendem Service wird gefangen (geloggt), der Guard läuft normal weiter, kein Traceback bricht die State-Machine.
  - **Files:** `notify.py:45` `_run` fängt `vol.Invalid` (`"Notify action invalid for …"` Zeile 49) bzw. `Exception` (`LOGGER.exception("Notify action failed for …")` Zeile 51); detached via `hass.async_create_task` (Zeile 53).
  - **Treiber:** Guard `NotifyMiss` (`strategy:"switch"`, `switch_entity:"switch.test_template_switch"`, Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5}`) mit `notify_action:[{"action":"notify.does_not_exist","data":{"message":"{{ message }}"}}]`. Health brechen + `N.wait(7)`.
  - **Assert:** `N.log()` enthält `"Notify action invalid for NotifyMiss"` ODER `"Notify action failed for NotifyMiss"`; `N.g("/api/config")["state"] == "RUNNING"`; `N.guard("notifymiss")[0]` ist ein gültiger State (z. B. `suspect`/`recovering`/`escalated`), nicht `None`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + Health zurücksetzen.

- [ ] **NA5 — Variablen-Hinweis in Section-`description` (de), keine `{{ }}`-Klammern als ICU** · `P1`
  - **Prüft:** Der Variablen-Hinweis steht in der `notification`-Section-`description` (nicht `data_description`), und de.json verwendet KEINE rohen `{{ }}` (ICU-Falle), sondern die Umschreibung „in doppelten geschweiften Klammern".
  - **Files:** `translations/de.json` `notification.description` an Zeilen 196, 229, 264, 297, 320 = `"Optionale Aktion bei Problemen und Reparaturen. Verfügbare Jinja-Variablen (in doppelten geschweiften Klammern): message (die fertige, lokalisierte Meldung), name, event."`.
  - **Treiber:** `grep -n "notification" translations/de.json` → jeder Section-Treffer hat `description`, keine literalen `{{`/`}}`.
  - **Assert:** Datei-Inhalt enthält Phrase `"in doppelten geschweiften Klammern"` und KEIN `{{` in den Notify-Beschreibungen.
  - **Cleanup:** —

### P0 — Corner Cases / Robustheit

- [ ] **CC1 — Kaputtes Jinja im Health-Template wird abgelehnt** · `P0`
  - **Prüft:** Ein syntaktisch defektes Template (`{{ 1 + }}`, unclosed) wird vom `TemplateSelector` validiert und der Device-Step lehnt ab (kein `create_entry`).
  - **Files:** `config_flow.py:304` `_health_section` (SOURCE_TEMPLATE) nutzt `selector.TemplateSelector()` (Zeile 310, serverseitige Validierung) in Section `template_check` (`SECTION_TEMPLATE`, Zeile 241).
  - **Treiber:** Subentry-Flow manuell bis `device`-Step treiben und `template_check.template = "{{ 1 + }}"` posten (statt `N.create_guard`, das nur valide Templates kennt): `requests.post(.../subentries/flow, {"handler":[hub,"device"]})` → `_post_flow(fid,{"source_type":"template_based"})` → `_post_flow(fid,{"name":"BadJinja","mode":"recover","assigned_device":{},"template_check":{"template":"{{ 1 + }}"}})`.
  - **Assert:** Antwort enthält `errors` (z. B. `errors["template_check"]`/`base`) bzw. bleibt `step_id=="device"`; KEIN `type=="create_entry"`.
  - **Cleanup:** — (kein Subentry angelegt)

- [ ] **CC2 — Template-Verdicts: UNKNOWN macht keinen Fehlalarm** · `P0`
  - **Prüft:** `true`/`42`→OK · `false`/`'banana'`/`is_state→False`→UNHEALTHY · `states(missing)`/`none`/leer→UNKNOWN (kein Recover, kein SUSPECT).
  - **Files:** `health/template.py:29` `_UNKNOWN_RESULTS={"","none","unknown","unavailable"}`; `evaluate()` (Zeile 50): `TemplateError`→UNKNOWN (Zeile 54), `None`/leer/none-String→UNKNOWN (Zeile 55–58), sonst `result_as_boolean` (Zeile 59).
  - **Treiber:** Guard `TplUnknown` mit `source_type:"template_based"`, `health:{template:"{{ states('sensor.does_not_exist') }}"}`, `strategy:"switch"`, `switch_entity:"switch.test_template_switch"`, `behavior:{debounce:5, cooldown:5}`. `N.wait(8)` → `N.guard("tplunknown")`.
  - **Assert:** `N.guard("tplunknown")[0] == "ok"` (UNKNOWN bleibt OK, kein `suspect`); `binary_sensor.tplunknown_gesundheit` ist NICHT `off`. Gegenprobe: Reconfigure auf `{{ false }}` → nach Debounce `suspect`/`escalated`.
  - **Cleanup:** `N.delete_subentry(entry, sub)`

- [ ] **CC3 — Health-Entität unavailable/unknown (state_based) → UNKNOWN, kein Recover** · `P0`
  - **Prüft:** Eine state_based-Health-Entität in `unavailable`/`unknown` ergibt UNKNOWN (kein Fehlalarm), solange `unavailable` nicht explizit in `off_value` steht.
  - **Files:** `health/entity_state.py:75` ambivalente States (`unavailable`/`unknown`) → UNKNOWN; Zeile 72: explizites `off_value` gewinnt (auch über unavailable).
  - **Treiber:** Guard `StateUnknown` mit `health:{entity_id:"binary_sensor.test_reachable", on_value:["on"], off_value:["off"]}`, `strategy:"switch"`, `switch_entity:"switch.test_template_switch"`, `behavior:{debounce:5, cooldown:5}`. `N.setstate("binary_sensor.test_reachable","unavailable")` → `N.wait(8)` → `N.guard("stateunknown")`.
  - **Assert:** `N.guard("stateunknown")[0] == "ok"` (nicht `suspect`); kein `"StateUnknown unhealthy, waiting"`-Log für diesen Guard.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.setstate("binary_sensor.test_reachable","on")`

- [ ] **CC4 — Switch fehlt (switch_cycle) → `can_recover` blockt → ESCALATED `recovery_blocked`** · `P0`
  - **Prüft:** Fehlende Switch-Entity wird in `can_recover` erkannt → Engine eskaliert mit `recovery_blocked`, kein blindes Schalten.
  - **Files:** `drivers/switch_cycle.py:23` `can_recover` → `LOGGER.error("Switch entity %s not found")` (Zeile 25) + `return False, …` (Zeile 26); `engine.py:447` `not ok` → `LOGGER.warning("%s recovery blocked: %s")` (Zeile 448) + `_escalate("recovery_blocked", reason=reason)` (Zeile 449).
  - **Treiber:** Guard `SwMissing` mit `strategy:"switch"`, `switch_entity:"switch.ganz_sicher_weg"`, Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5}`. Health brechen (`input_boolean.turn_off test_1`) → `N.wait(8)` → `N.guard("swmissing")`.
  - **Assert:** `N.guard("swmissing")[0] == "escalated"`; `N.log()` enthält `"Switch entity switch.ganz_sicher_weg not found"` und `"recovery blocked"`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

- [ ] **CC5 — poe_port: kein/mehrdeutiger Match → blockt → ESCALATED `recovery_blocked`** · `P0`
  - **Prüft:** Lässt sich `expected_id` nicht auf genau einen Port auflösen, blockt `can_recover` über die Fabric → Eskalation; eine leere Portliste ergänzt beim Start zusätzlich einen `config_errors`-Log.
  - **Files:** `drivers/poe_port.py:33` `can_recover` → `fabric.resolve_with_reason` → `port is None` → `LOGGER.error("PoE %s: %s")` (Zeile 39) + `return False, reason`; `poe.py:198` Laufzeit-Reason `"no port matches '<id>'"`; `drivers/poe_port.py:58` `config_errors` „no ports configured" wenn `port_count==0` (Startup-Check via `engine._check_config`).
  - **Treiber:** Guard `PoeNomatch` mit `strategy:"poe_port"`, `expected_id:"zz:zz:zz:zz:zz:zz"` (kein realer Port), Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5, boot_window:5, max_attempts:2}`. Health brechen → `N.wait(8)` → `N.guard("poenomatch")`.
  - **Assert:** `N.guard("poenomatch")[0] == "escalated"`; `N.log()` enthält `"PoE zz:zz:zz:zz:zz:zz"` und `"recovery blocked"`. (Bei leerer Portliste enthält das Log zusätzlich aus dem Startup-Check `"no ports configured"`; das ist NICHT der Laufzeit-Reason.)
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

- [ ] **CC6 — Action-Service fehlt OHNE Health-Check → kein falscher Erfolg → Retry → ESCALATED** · `P0`
  - **Prüft:** `can_recover` validiert nur die Struktur (kein Service-Existenz-Check), also läuft `recover()` an, wirft beim unbekannten Service (`ServiceNotFound`) und wird als fehlgeschlagener Versuch behandelt — NICHT `recover_success` — und bis `max_attempts` retried, dann `recovery_failed`.
  - **Files:** `drivers/action_call.py` `can_recover` validiert via `async_validate` (nur Schema, keine Service-Existenz); `engine.py:452` `try: await self.driver.recover()` → `except Exception` → `LOGGER.exception("Recovery driver failed for %s")` (Zeile 456) → Retry/`_escalate()` (Zeile 457–460).
  - **Treiber:** Guard `ActMissing` mit `strategy:"action"`, `action:[{"action":"script.gibt_es_nicht"}]`, Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5}` (action ohne check → `max_attempts` Default 2). Health brechen → `N.wait(10)` → `N.guard("actmissing")`.
  - **Assert:** `N.guard("actmissing")[0] == "escalated"`; `attrs["recover_count"] == 0`; `N.log()` enthält `"Recovery driver failed for ActMissing"` (mind. 1×) und am Ende `"ActMissing could not be recovered"`. KEIN `"recovered after"` für diesen Guard.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

- [ ] **CC7 — Action-Service heilt nicht MIT Health-Check → Verify schlägt fehl → Retry/Escalate** · `P0`
  - **Prüft:** Bei `action_check` und nicht heilender Aktion bleibt Health unhealthy → VERIFY-Timeout → Retry bis `max_attempts` → ESCALATED.
  - **Files:** `engine.py:467` `_set_state(VERIFY)` → `_wait_health_ok(boot_window)` (Zeile 468) → False → bei `attempt >= max_attempts` `_escalate()` (Zeile 473–474).
  - **Treiber:** Guard `ActCheckMiss` mit `strategy:"action_check"`, `action:[{"action":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}]` (heilt Health NICHT), Health `input_boolean.test_1`, `behavior:{debounce:5, cooldown:5, boot_window:5, max_attempts:2}`. Health brechen → `N.wait(5 + 2*5 + 4)` → `N.guard("actcheckmiss")`.
  - **Assert:** `N.guard("actcheckmiss")[0] == "escalated"`; `attrs` zeigt `attempt==2`, `recover_count==0`; `N.log()` enthält `"could not be recovered after 2"`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_1")`

- [ ] **CC8 — Heilbare `*_check`-Recovery → VERIFY greift → COOLDOWN (kein Fehlalarm-Loop)** · `P1`
  - **Prüft:** Eine `*_check`-Aktion, die die Health-Entität wieder gesund schaltet, durchläuft VERIFY→COOLDOWN sauber (`recover_count=1`); der Heil-Trick aus dem Runbook.
  - **Files:** `engine.py:468` `_wait_health_ok` True → `_recover_success()` (Zeile 471) → `LOGGER.info("%s recovered after %s attempt(s)…")` (Zeile 498–503) + `COOLDOWN` (Zeile 505).
  - **Treiber:** Guard `HealOK`, Health `input_boolean.test_5` (on=gesund), `strategy:"action_check"`, `action:[{"action":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_5"}}]`, `behavior:{debounce:5, cooldown:30, boot_window:10, max_attempts:2}`. `N.call("input_boolean","turn_off", entity_id="input_boolean.test_5")` → `N.wait(11)` → `N.guard("healok")`.
  - **Assert:** `N.guard("healok")[0] == "cooldown"`; `attrs["recover_count"] == 1`; `N.log()` enthält `"recovered after 1 attempt(s)"`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_5")`

- [ ] **CC9 — Recovery-Aktion schaltet Health AUS → Loop bounded durch max_attempts** · `P1`
  - **Prüft:** Eine kontraproduktive `*_check`-Aktion (macht Health unhealthy) führt nicht zur Endlosschleife — sie ist durch `max_attempts`→ESCALATED begrenzt.
  - **Files:** `engine.py:473` `attempt >= max_attempts` → `_escalate()`; VERIFY-Pfad (Zeile 467–474).
  - **Treiber:** Guard `HealLoop`, Health `input_boolean.test_6`, `strategy:"action_check"`, `action:[{"action":"input_boolean.turn_off","data":{"entity_id":"input_boolean.test_6"}}]` (hält Health unten), `behavior:{debounce:5, cooldown:5, boot_window:5, max_attempts:2}`. `N.call("input_boolean","turn_off", entity_id="input_boolean.test_6")` → `N.wait(5 + 2*5 + 5)` → `N.guard("healloop")`.
  - **Assert:** `N.guard("healloop")[0] == "escalated"` mit `attrs["attempt"]==2` (terminale Grenze, kein Dauer-Cycle); `N.log()` enthält `"could not be recovered after 2"`.
  - **Cleanup:** `N.delete_subentry(entry, sub)` + `N.call("input_boolean","turn_on", entity_id="input_boolean.test_6")`

- [ ] **CC10 — Leere Aktion(en) beim Submit abgelehnt (F6)** · `P1`
  - **Prüft:** Strategie `action`/`actions` ohne Inhalt wird beim Submit mit `action_required` abgelehnt (nicht erst zur Laufzeit).
  - **Files:** `config_flow.py:967` `errors[CONF_ACTION]="action_required"` (action-Step); `:988`/`:990` `errors[CONF_OFF_ACTION]`/`[CONF_ON_ACTION]="action_required"` (actions-Step).
  - **Treiber:** Subentry-Flow bis Strategie-Step treiben, `strategy:"action"`, dann `action`-Step mit `action: []` (leer) posten.
  - **Assert:** Antwort enthält `errors["action"] == "action_required"`; KEIN `create_entry`.
  - **Cleanup:** — (kein Subentry)

---

## Sections & Flatten · Entity-Exclusion · PoE Options-Flow

### Sections & Flatten

> **Helper für `.storage`-Reads** (mehrfach genutzt): Die Config-Entry-REST-API liefert **kein** `options`/`data`/`subentries`-Feld (`as_json_fragment` in `homeassistant/config_entries.py` Z.654-678 enthält nur Metadaten + `num_subentries`). Ports/Driver flach prüfen daher über die Storage-Datei (wie `N.hub_id()`):
> ```python
> import json
> def _ports():  # flache Portliste aus dem Storage
>     ce=json.load(open("<ha-core>/config/.storage/core.config_entries"))
>     e=[e for e in ce["data"]["entries"] if e["domain"]=="necromancer"][0]
>     return e.get("options",{}).get("ports",[])
> def _subs():   # Subentry-data (inkl. driver/health) aus dem Storage
>     ce=json.load(open("<ha-core>/config/.storage/core.config_entries"))
>     return [e for e in ce["data"]["entries"] if e["domain"]=="necromancer"][0]["subentries"]
> ```
> Storage wird verzögert geschrieben → vor dem Read **`N.wait(2)`**. Sofort/robust beobachtbar ist außerdem `N.remove_port(label)` (findet das Label nur, wenn der Port flach unter Top-Level-`label` gespeichert wurde).

- [ ] **SF1 — Sektionen serverseitig ausgeklappt** · `P1`
  - **Prüft:** Nicht-collapsed Sektionen melden dem Frontend `expanded:true` (Default `collapsed=False`); nur `linked_guards` ist collapsed.
  - **Files:** `config_flow.py` → `_section` (Z.252-254): `section(vol.Schema(fields), {"collapsed": collapsed})` mit `collapsed: bool = False`; `_link_section` (Z.385-405) ist die EINZIGE Sektion mit `collapsed=True`. Serverseitige Übersetzung in `homeassistant/helpers/config_validation.py` Z.1189-1197: Section → `{"type":"expandable","expanded": not collapsed}`.
  - **Treiber:** Flow bis Step `switch` treiben (testkit-intern): `hub=N.hub_id()`; `r=N._post_flow`-Kette ist nur in `create_guard` gekapselt — hier manuell: POST `/api/config/config_entries/subentries/flow` mit `{"handler":[hub,"device"]}` → `fid`; `N._post_flow(fid,{"source_type":"state_based"})` (→ `device`); `N._post_flow(fid,{"name":"SecX","mode":"recover","assigned_device":{},"state_check":{"entity_id":"binary_sensor.test_reachable","on_value":["on"],"off_value":["off"]}})` (→ `strategy`); `N._post_flow(fid,{"strategy":"switch"})` (→ `switch`). Im zurückgegebenen `data_schema` die Felder mit `name=="behavior"` / `name=="notification"` suchen.
  - **Assert:** Im `switch`-Schema hat das Feld `behavior` `"type":"expandable"` und `"expanded": true`; das Feld `notification` ebenfalls `"expanded": true`; ein evtl. vorhandenes `linked_guards`-Feld (nur wenn ein ANDERER Recover-Guard existiert) trägt `"expanded": false`.
  - **Cleanup:** Flow ohne Save verwerfen: `requests.delete(f"http://localhost:8123/api/config/config_entries/subentries/flow/{fid}",headers=N.H)`.

- [ ] **SF2 — _flatten_sections hebt verschachtelte Werte hoch (Device-Create)** · `P1`
  - **Prüft:** Submit-Form `{section:{feld:…}}` wird vor Verwendung flachgezogen, sodass der Guard real entsteht (Health- + Switch-Sektion verarbeitet).
  - **Files:** `config_flow.py` → `_flatten_sections` (Z.257-265) `out.update(value)` für jedes dict; aufgerufen in `async_step_device` (Z.886), `_build_data` (Z.542-543), `async_step_add_port` (Z.1291).
  - **Treiber:** `hub,sub=N.create_guard({"source_type":"state_based","name":"FlatDev","health":{"entity_id":"binary_sensor.test_reachable","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"switch","switch_entity":"switch.test_template_switch","behavior":{"debounce":5,"cooldown":5}})` — `create_guard` schickt `state_check` UND `assigned_device` als verschachtelte Sektionen, die Switch-Step-Sektionen `behavior`/`notification` ebenso.
  - **Assert:** `N.st("sensor.flatdev_status")` ist nicht `None` (Guard entstand → Sektionen wurden geflattet/verarbeitet). Der Switch-Wert kam aus der `power`-losen Flat-Form: `N.guard("flatdev")[1]["target"] == "switch.test_template_switch"` (Status-Sensor-Attr `target`=`driver.target_info()`). Health beobachtbar: `N.setstate("binary_sensor.test_reachable","off")`; `N.wait(1)`; `N.st("binary_sensor.flatdev_gesundheit")["state"]=="off"`. (Es gibt **kein** `health`-Attribut am Status-Sensor — Attrs sind nur `attempt/recover_count/last_recover/last_seen/target/auto_restart`.)
  - **Cleanup:** `N.delete_subentry(hub,sub)`; `N.setstate("binary_sensor.test_reachable","on")`.

- [ ] **SF3 — _flatten_sections beim Port-Add (Options-Flow)** · `P1`
  - **Prüft:** Die 4 Port-Sektionen (`power`/`identity`/`status`/`timing`) werden beim Add flachgezogen und FLACH persistiert.
  - **Files:** `config_flow.py` → `async_step_add_port` (Z.1287-1302) ruft `_flatten_sections(user_input)` (Z.1291); `_port_schema` (Z.678-753) baut die 4 Sektionen.
  - **Treiber:** `N.add_port({"label":"FlatPort","actuator":"input_boolean.sim_poe_port","status_entity":"binary_sensor.test_reachable","status_on":["on"],"status_off":["off"],"off_on_delay":2,"off_timeout":10,"on_timeout":20})`.
  - **Assert:** Robust: `N.remove_port("FlatPort")` würde ihn finden (Label flach gespeichert) — siehe Cleanup. Flach-Struktur konkret via Storage: `N.wait(2)`; im `_ports()`-Helper existiert ein Dict mit `label=="FlatPort"`, dessen Keys `actuator`/`status_entity`/`off_on_delay`/`off_timeout`/`on_timeout` **auf Top-Level** liegen (KEINE Subdicts `power`/`status`/`timing`).
  - **Cleanup:** `N.remove_port("FlatPort")`.

### Entity-Selektor-Exclusion

- [ ] **EX1 — Necromancer-eigene Entities aus Health-Picker ausgeschlossen** · `P1`
  - **Prüft:** `switch.<slug>_auto_reparatur` & Co. tauchen im Health-Entity-Selektor NICHT auf (`exclude_entities`).
  - **Files:** `config_flow.py` → `_own_entities` (Z.268-271, filtert `e.platform == DOMAIN`); `_entity_selector` (Z.274-280) setzt `cfg["exclude_entities"]=exclude`; verbaut in `_health_section` (Z.318), `_switch_fields` (Z.453), `_port_schema` Actuator/Id/Status (Z.694/703/720). Aufruf mit `exclude=_own_entities(self.hass)` in `async_step_device` (Z.909), `async_step_switch` (Z.954), `async_step_add_port` (Z.1301). `EntitySelector.serialize` führt `exclude_entities` mit (`homeassistant/helpers/selector.py` Z.999).
  - **Treiber:** Mind. 1 Guard sicherstellen: `hub,sub=N.create_guard({"source_type":"state_based","name":"ExcludeMe","health":{"entity_id":"binary_sensor.test_reachable","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"switch","switch_entity":"switch.test_template_switch","behavior":{"debounce":5,"cooldown":5}})`. Device-Step-Schema holen: Subentry-Flow starten (`{"handler":[N.hub_id(),"device"]}`→`fid`), `N._post_flow(fid,{"source_type":"state_based"})`→Step `device`. Im `data_schema` das Feld `state_check` (`type==expandable`) → dessen `schema` → Feld `entity_id` → `selector.entity.exclude_entities` lesen.
  - **Assert:** `switch.excludeme_auto_reparatur`, `sensor.excludeme_status`, `binary_sensor.excludeme_gesundheit`, `button.excludeme_reparieren` sind in `exclude_entities` enthalten.
  - **Cleanup:** Flow verwerfen (`requests.delete(.../subentries/flow/{fid},headers=N.H)`); `N.delete_subentry(hub,sub)`.

- [ ] **EX2 — Exclusion auch im Port-Formular (Actuator/Id/Status)** · `P1`
  - **Prüft:** Eigene Entities sind auch im PoE-Port-Add-Formular gefiltert.
  - **Files:** `config_flow.py` → `_port_schema` (Z.694 Actuator, Z.703 id_entity, Z.720 status_entity) je `_entity_selector(exclude,…)`; `async_step_add_port` übergibt `exclude=_own_entities(self.hass)` (Z.1301).
  - **Treiber:** Mit existierendem Guard `ExcludeMe`: `_entry,fid,r=N._opt_start()` (Menu); `r=N._opt_post(fid,{"next_step_id":"add_port"})` (Step `add_port`); im `data_schema` die expandable-Felder `power`/`identity`/`status` → deren `schema` → Felder `actuator`/`id_entity`/`status_entity`.
  - **Assert:** In `actuator`, `id_entity`, `status_entity` enthält `selector.entity.exclude_entities` den Eintrag `switch.excludeme_auto_reparatur`.
  - **Cleanup:** Options-Flow ohne Save verwerfen: `requests.delete(f"http://localhost:8123/api/config/config_entries/options/flow/{fid}",headers=N.H)`; `ExcludeMe`-Guard löschen.

### Multiselect-Werte (Health + Port-Status)

- [ ] **MS1 — Health on/off als Listen: booting∈on→OK, error∈off→UNHEALTHY** · `P1`
  - **Prüft:** Mehrwertige `on_value`/`off_value`-Listen werden korrekt zu Verdikten gemappt.
  - **Files:** `config_flow.py` → `_HEALTH_VALUE_SELECTOR=_LiveStateSelector(...,multiple=True)` (Z.194/215), `_watch_fields` (Z.225-233) baut `on_value`/`off_value` als Listen; Auswertung in `health/entity_state.py` → `evaluate`: `off`-Treffer→`UNHEALTHY`, `on`-Treffer→`OK`, sonst `UNKNOWN`.
  - **Treiber:** `hub,sub=N.create_guard({"source_type":"state_based","name":"MultiSel","health":{"entity_id":"input_select.test_state","on_value":["online","booting"],"off_value":["offline","error"]},"mode":"notify","behavior":{"debounce":0}})`. Dann `N.call("input_select","select_option",entity_id="input_select.test_state",option="booting")`; `N.wait(1)`; `N.st("binary_sensor.multisel_gesundheit")`. Danach `N.call("input_select","select_option",entity_id="input_select.test_state",option="error")`; `N.wait(1)`; erneut lesen.
  - **Assert:** `N.st("binary_sensor.multisel_gesundheit")["state"]=="on"` bei `booting` (booting∈on→OK→connectivity-`is_on`); `=="off"` bei `error` (error∈off→UNHEALTHY). (Der Status-Sensor hat **kein** `health`-Attribut; nur das Gesundheit-Binary-Sensor-State ist die Quelle.)
  - **Cleanup:** `N.delete_subentry(hub,sub)`; `N.call("input_select","select_option",entity_id="input_select.test_state",option="online")`.

- [ ] **MS2 — Port-Status status_on/status_off als Listen** · `P1`
  - **Prüft:** `status_on`/`status_off` werden als Listen gespeichert (`_STATUS_VALUE_SELECTOR` multiple).
  - **Files:** `config_flow.py` → `_STATUS_VALUE_SELECTOR=_LiveStateSelector(CONF_STATUS_ENTITY,CONF_STATUS_ATTRIBUTE)` (Z.675), `_port_schema` (Z.725-732) `status_on`/`status_off` default `_as_list(...) or ["on"]/["off"]`.
  - **Treiber:** `N.add_port({"label":"MultiStat","actuator":"input_boolean.sim_poe_port","status_entity":"input_select.test_state","status_on":["online","booting"],"status_off":["offline","error"],"off_on_delay":2,"off_timeout":10,"on_timeout":20})`.
  - **Assert:** `N.wait(2)`; im `_ports()`-Helper hat der Port `MultiStat` `status_on==["online","booting"]` und `status_off==["offline","error"]` (2-elementige Listen, FLACH). Zusätzlich findbar: `N.remove_port("MultiStat")`→`{"removed":True}`.
  - **Cleanup:** `N.remove_port("MultiStat")`.

### Jede Step-Beschreibung vorhanden

- [ ] **DESC1 — Alle Subentry-Steps haben eine Beschreibung** · `P1`
  - **Prüft:** user/reconfigure/device/strategy/switch/action/actions/poe_port/notify tragen je `description` (verifiziert in `strings.json` UND `translations/de.json`).
  - **Files:** `strings.json` + `translations/de.json` → `config_subentries.device.step.<step>.description`.
  - **Treiber:** Aus `custom_components/necromancer`:
    `python3 -c "import json;[print(f,[k for k in ['user','reconfigure','device','strategy','switch','action','actions','poe_port','notify'] if not json.load(open(f))['config_subentries']['device']['step'].get(k,{}).get('description')]) for f in ['strings.json','translations/de.json']]"`
  - **Assert:** Für `strings.json` und `translations/de.json` jeweils leere Liste `[]`.
  - **Cleanup:** —

- [ ] **DESC2 — Alle Options-Steps + add_port-Sektionen haben Beschreibungen** · `P1`
  - **Prüft:** init/add_port/edit_port/delete_port/import_ports/export_ports/export_result und die 4 Port-Sektionen tragen `description`.
  - **Files:** `strings.json`/`translations/de.json` → `options.step.<step>.description` und `options.step.add_port.sections.{power,identity,status,timing}.description`.
  - **Treiber:**
    `python3 -c "import json;s=json.load(open('strings.json'));o=s['options']['step'];print([k for k in ['init','add_port','edit_port','delete_port','import_ports','export_ports','export_result'] if not o.get(k,{}).get('description')],[k for k in ['power','identity','status','timing'] if not o['add_port']['sections'].get(k,{}).get('description')])"` — gleich für `translations/de.json`.
  - **Assert:** Ausgabe `[] []` (für strings.json und de.json).
  - **Cleanup:** —

### PoE: flache Portliste / Options-Flow

- [ ] **POE1 — Options-Flow: Menü + Ports flach in entry.options** · `P1`
  - **Prüft:** Add→Save schreibt die Ports flach nach `entry.options[CONF_PORTS]`.
  - **Files:** `config_flow.py` → `NecromancerOptionsFlow.async_step_init` (Z.1261-1285, Menü add/edit/delete/import/export/save), `async_step_save` (Z.1395-1398) `async_create_entry(data={CONF_PORTS:self._ports})`.
  - **Treiber:** `N.add_port({"label":"OptPort","actuator":"input_boolean.sim_poe_port","status_entity":"binary_sensor.test_reachable"})`; dann `N.wait(2)`.
  - **Assert:** Im `_ports()`-Helper enthält die Liste ein Dict mit `label=="OptPort"`, dessen Felder (`actuator`,`status_entity`,`off_on_delay`,…) TOP-LEVEL liegen (nicht unter `power`/`timing`). (REST `/api/config/config_entries/entry/{id}` liefert KEIN `options` → Storage-Read nötig.)
  - **Cleanup:** `N.remove_port("OptPort")`.

- [ ] **POE2 — edit_port ersetzt (statt anhängt)** · `P1`
  - **Prüft:** Editieren eines Ports ersetzt den Eintrag am selben Index, erhöht die Portzahl nicht.
  - **Files:** `config_flow.py` → `async_step_edit_port` (Z.1304-1313) setzt `_edit_index`+`_editing=True`→`async_step_add_port`; `async_step_add_port` (Z.1292-1293) `if self._editing: self._ports[self._edit_index]=port` (Replace statt `append`).
  - **Treiber:** Port anlegen `N.add_port({"label":"EditMe","actuator":"input_boolean.sim_poe_port","status_entity":"binary_sensor.test_reachable","off_on_delay":2})`. Options-Flow manuell: `_entry,fid,r=N._opt_start()`; `r=N._opt_post(fid,{"next_step_id":"edit_port"})`; aus `r["data_schema"]` das `port`-Select nach Option mit `label=="EditMe"` durchsuchen und dessen `value` holen; `r=N._opt_post(fid,{"port":<value>})` (→ Step `add_port` mit vorbefüllten Sektionen); das **vollständige Sektions-Payload** posten (wie `N.add_port` es baut: `{"label":"EditMe","power":{"actuator":"input_boolean.sim_poe_port"},"identity":{},"status":{"status_entity":"binary_sensor.test_reachable","status_on":["on"],"status_off":["off"]},"timing":{"off_on_delay":5,"off_timeout":10,"on_timeout":20}}`) → `menu`; `N._opt_post(fid,{"next_step_id":"save"})` (→ `create_entry`); `N.wait(2)`.
  - **Assert:** Im `_ports()`-Helper genau EIN Eintrag mit `label=="EditMe"` und `off_on_delay==5` (ersetzt, nicht dupliziert). `N.remove_port("EditMe")`→`{"removed":True}`, danach `_ports()` enthält kein `EditMe` mehr.
  - **Cleanup:** `N.remove_port("EditMe")` (falls oben nicht schon entfernt).

- [ ] **POE3 — delete_port entfernt korrekt** · `P1`
  - **Prüft:** Delete entfernt genau den gewählten Port per Index.
  - **Files:** `config_flow.py` → `async_step_delete_port` (Z.1315-1325) `self._ports.pop(index)`; `N.remove_port` (testkit Z.220-233) treibt `delete_port`→`save`.
  - **Treiber:** `N.add_port({"label":"DelMe","actuator":"input_boolean.sim_poe_port","status_entity":"binary_sensor.test_reachable"})`; `N.remove_port("DelMe")`.
  - **Assert:** Erster `N.remove_port("DelMe")`→`{"removed":True}`; ein zweiter `N.remove_port("DelMe")`→`{"removed":False}` (Port ist weg).
  - **Cleanup:** — (Port bereits entfernt)

- [ ] **POE4 — poe_port-Guard: expected_id sucht die ganze flache Liste (keine Areas)** · `P1`
  - **Prüft:** Ein `poe_port`-Guard referenziert keine Area, nur `expected_id`; der Driver kommt bei vorhandenen Ports ohne `config_error` hoch.
  - **Files:** `config_flow.py` → `_build_driver` (Z.522-524) `{type:"poe_port",expected_id:…}` (KEIN Area-Feld); `_poe_schema` (Z.661-669) nur `expected_id`+behavior+notify. Driver `drivers/poe_port.py` `config_errors` (Z.58-65): Marker `poe_port '<id>': no ports configured` nur bei `port_count==0`; geloggt in `engine.py` Z.178-179 als `"%s: %s"` (Name + err).
  - **Treiber:** Port mit Static-Id anlegen: `N.add_port({"label":"P4","actuator":"input_boolean.sim_poe_port","status_entity":"binary_sensor.test_reachable","id_static":"dev-xyz"})`. Guard: `hub,sub=N.create_guard({"source_type":"state_based","name":"PoeG","health":{"entity_id":"binary_sensor.test_reachable","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"poe_port","expected_id":"dev-xyz","behavior":{"debounce":0,"cooldown":2,"boot_window":5,"max_attempts":1}})`. `N.wait(2)`.
  - **Assert:** `N.st("sensor.poeg_status")` ist nicht `None`. Driver-Form via Storage: im `_subs()`-Helper hat der Subentry `PoeG` `data["driver"]=={"type":"poe_port","expected_id":"dev-xyz"}` — KEIN Area-Key. Kein Config-Fehler: `N.log()` enthält NICHT `PoeG: poe_port 'dev-xyz': no ports configured` (Ports sind vorhanden).
  - **Cleanup:** `N.delete_subentry(hub,sub)`; `N.remove_port("P4")`.

DELETED CLAIMS (alle 3 bestätigt obsolet/fehlplatziert — NICHT wiederhergestellt):
1. "Reaktive Selektoren in Sections folgen entity_id/id_entity/status_entity" (REGRESSION.md Z.104) — die Live-Nachführung passiert nur im Browser (`ha-form-expandable` regeneriert den Context). Server liefert nur die statische `context`-Map (`_LiveStateSelector.serialize`/`_LiveAttributeSelector.serialize`, config_flow.py Z.173-177/198-205). Die reaktive Invariante ist per REST nicht beobachtbar → agent-untestbar. Gehört außerdem zum Selektor-/UX-Bereich.
2. "Self-/Cross-Device-Link blockiert (no_self_link)" (REGRESSION.md Z.110, offenes `[ ]`) — basiert auf DeviceSelector + `_is_own_device` (config_flow.py Z.794-799) mit `errors[CONF_DEVICE_ID]="no_self_link"` (Z.889), NICHT auf `exclude_entities`. Gehört in den Linking-/Device-Link-Bereich, nicht in die Entity-Exclusion.
3. "Per-Port asyncio.Lock: test_per_port_lock_serialises/test_driver_and_service_share_lock" (REGRESSION.md Z.39) — gehört in den PoE-Fabric-Bereich; zudem obsolet: Per-Port-Lock durch Coalescing (`_inflight`-Task + `asyncio.shield`, poe.py Z.67/244-257) ersetzt; die genannten Tests existieren nicht mehr (jetzt `test_concurrent_callers_coalesce`/`test_driver_and_service_coalesce`).

---

## Persistenz (Store) · Health-Robustheit · Config-Error-Logging

### P0 — Persistenz (Store)

> Store-Datei: `<ha-core>/config/.storage/necromancer.<entry_id>` (`entry_id` via `N.hub_id()`).
> Snapshot-Felder (engine.py `snapshot`, Z. 128–139): `state, attempt, recover_count, last_recover, last_seen, auto`.
> Restore-Regel (engine.py `_apply_persisted`, Z. 111–126): Stats (`recover_count`/`last_recover`/`last_seen`, Z. 119–121) + `auto` (Z. 122–123) IMMER; `state` NUR wenn `ESCALATED` (Z. 124–126); transiente States werden verworfen und aus Live-Health neu abgeleitet.
> Speicher ist verzögert (`SAVE_DELAY=5`, const.py Z. 16) → vor Restart `N.wait(7)` bzw. Unload flusht synchron (`async_unload_entry` → `store.async_save(serialize())`, __init__.py Z. 297–300).
> RESTART-Helfer (Code-/Store-Last neu laden): `pkill -9 -f "[h]omeassistant -c"; relaunch; poll /api/config==RUNNING`.

- [ ] **PERS-1 — ESCALATED überlebt Neustart, kein Re-Attempt** · `P0`
  - **Prüft:** Ein deterministisch-krankes Guard, das eskaliert ist, kommt nach Neustart wieder als `escalated` hoch und versucht KEINE neue Reparatur (`recover_count` bleibt 0).
  - **Files:** engine.py `_apply_persisted` Z. 124–126 (nur `ESCALATED` wird restored) + `snapshot` Z. 128–139.
  - **Treiber:** `N.create_guard({source_type:"template_based", name:"PersEsc", health:{template:"{{ false }}"}, mode:"recover", strategy:"action_check", action:[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}], behavior:{debounce:3,cooldown:5,boot_window:4,max_attempts:1}})` → `N.wait(12)` (debounce→1 Versuch→VERIFY-Timeout→escalated) → `N.guard("persesc")` muss `escalated` zeigen → `N.wait(7)` (Store-Flush) → RESTART → nach RUNNING: `N.guard("persesc")`.
  - **Assert:** Nach Restart `N.guard("persesc")[0] == "escalated"` UND `N.guard("persesc")[1]["recover_count"] == 0`; im `N.log()` NACH Restart kein neuer Marker `"PersEsc recovery attempt"`.
  - **Cleanup:** `N.delete_subentry(N.hub_id(), <sub>)` mit `<sub>` aus dem `create_guard`-Rückgabewert (bzw. Subentry-id aus `N.list_subentries(N.hub_id())` per Titel `"PersEsc"`).

- [ ] **PERS-2 — ESCALATED Auto-Clear bei gesunder Health nach Neustart** · `P0`
  - **Prüft:** Ein eskaliertes Guard, dessen Health beim Hochlauf wieder OK ist, wird via `_evaluate` von `ESCALATED → OK` geräumt (engine.py Z. 353–355).
  - **Files:** engine.py `_evaluate` Z. 353–355 (`state == ESCALATED and h == Health.OK → attempt=0; _set_state(OK)`).
  - **Treiber:** Guard wie PERS-1, aber state_based gegen schaltbare Health: `N.create_guard({source_type:"state_based", name:"PersClr", health:{entity_id:"input_boolean.test_1", on_value:["on"], off_value:["off"]}, mode:"recover", strategy:"action_check", action:[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}], behavior:{debounce:3,cooldown:5,boot_window:4,max_attempts:1}})` → `N.call("input_boolean","turn_off",entity_id="input_boolean.test_1")` → `N.wait(12)` → `N.guard("persclr")[0]=="escalated"` → `N.call("input_boolean","turn_on",entity_id="input_boolean.test_1")` (Health jetzt OK) → `N.wait(7)` → RESTART → nach RUNNING.
  - **Assert:** Nach Restart `N.guard("persclr")[0] == "ok"` (ESCALATED restored, erste `_evaluate` mit Health=OK räumt → OK).
  - **Cleanup:** Subentry `"PersClr"` löschen (`N.delete_subentry(N.hub_id(), <sub>)`) + `N.call("input_boolean","turn_on",entity_id="input_boolean.test_1")`.

- [ ] **PERS-3 — Stats (`recover_count`) überleben Neustart** · `P0`
  - **Prüft:** Nach einem erfolgreichen Recover ist `recover_count` im Snapshot persistiert und kommt nach Neustart unverändert hoch (engine.py `_recover_success` Z. 495–497, `snapshot` Z. 133).
  - **Files:** engine.py `_recover_success` Z. 496 (`self.recover_count += 1`) + `snapshot` Z. 133 (`"recover_count": self.recover_count`) + `_apply_persisted` Z. 119.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"PersStat", health:{entity_id:"input_boolean.test_5", on_value:["on"], off_value:["off"]}, mode:"recover", strategy:"action_check", action:[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_5"}}], behavior:{debounce:3,cooldown:4,boot_window:6,max_attempts:2}})` → `N.call("input_boolean","turn_off",entity_id="input_boolean.test_5")` (Health off → Recovery-Aktion schaltet test_5 wieder on → VERIFY grün → COOLDOWN) → `N.wait(10)` → `N.guard("persstat")[1]["recover_count"]` soll `1` sein → `N.wait(7)` (Flush) → RESTART.
  - **Assert:** Nach Restart `N.guard("persstat")[1]["recover_count"] == 1`.
  - **Cleanup:** Subentry `"PersStat"` löschen + `N.call("input_boolean","turn_on",entity_id="input_boolean.test_5")`.

- [ ] **PERS-4 — `auto`-Flag (Auto-Reparatur aus) überlebt Neustart** · `P0`
  - **Prüft:** Der Laufzeit-Switch „Auto-Reparatur" persistiert seinen Wert (engine.py `set_auto` Z. 286–290, `snapshot` Z. 138, restore Z. 122–123) und kommt nach Neustart als „aus" hoch.
  - **Files:** engine.py `set_auto` Z. 286–290 (setzt `self.auto` + `self._save()`) + `snapshot` Z. 138 + `_apply_persisted` Z. 122–123.
  - **Treiber:** beliebiges recover-Guard anlegen `N.create_guard({source_type:"state_based", name:"PersAuto", health:{entity_id:"input_boolean.test_2"}, mode:"recover", strategy:"switch", switch_entity:"switch.test_template_switch", behavior:{debounce:3,cooldown:5}})` → `N.call("switch","turn_off",entity_id="switch.persauto_auto_reparatur")` → `N.st("switch.persauto_auto_reparatur")["state"]=="off"` → `N.wait(7)` (Flush) → RESTART.
  - **Assert:** Nach Restart `N.st("switch.persauto_auto_reparatur")["state"] == "off"`.
  - **Cleanup:** Subentry `"PersAuto"` löschen.

- [ ] **PERS-5 — Transiente States NICHT restored** · `P0`
  - **Prüft:** Nur `ESCALATED` wird aus dem Store wiederhergestellt; SUSPECT/RECOVERING/VERIFY/COOLDOWN werden verworfen und der State aus Live-Health neu abgeleitet (engine.py `_apply_persisted` Z. 124 — `if data.get("state") == GState.ESCALATED.value`; sonst Default `OK` + erstes `_evaluate` in `async_start` Z. 162).
  - **Files:** engine.py `_apply_persisted` Z. 124 (nur ESCALATED-Branch) + `async_start` Z. 162 (`self._evaluate()`).
  - **Treiber:** Guard in COOLDOWN bringen: PERS-3-Guard reicht; direkt nach erfolgreichem Recover ist es `cooldown`. `N.guard("persstat")[0]=="cooldown"` prüfen → SOFORT `N.wait(7)` (Flush schreibt `state:"cooldown"` in den Store) → RESTART während Health gesund (test_5 = on).
  - **Assert:** Im rohen Store steht zwar evtl. `cooldown`, aber nach Restart `N.guard("persstat")[0] == "ok"` (transienter State verworfen, Live-Health=OK). Gegenprobe Marker: `N.log()` zeigt direkt nach Restart KEIN `"PersStat recovered after"` (kein neuer Recover-Lauf).
  - **Cleanup:** wie PERS-3.

- [ ] **PERS-6 — Store-Flush beim Reload/Unload (kein stale Store)** · `P0`
  - **Prüft:** `async_unload_entry` schreibt den Snapshot synchron vor dem Teardown (__init__.py Z. 297–300), damit ein sofortiger Reload (Reconfigure/Add-Port) keinen veralteten Store liest.
  - **Files:** __init__.py `async_unload_entry` Z. 295–300 (`store.async_save(serialize())` VOR `async_unload_platforms`/`engine.async_stop()`).
  - **Treiber:** PERS-3-Guard nach Recover (`recover_count==1`, COOLDOWN) → OHNE `N.wait(7)` einen Entry-Reload erzwingen über die Options/Add-Port (der Options-Update-Listener `_async_reload_entry` reloadet den Entry): `N.add_port({label:"flushport", actuator:"switch.test_template_switch", id_static:"flush:aa:bb", status_entity:"binary_sensor.test_reachable"})` → direkt `N.guard("persstat")[1]["recover_count"]`.
  - **Assert:** `recover_count == 1` direkt nach dem Reload (nicht 0) → Unload hat synchron geflusht.
  - **Cleanup:** Subentry `"PersStat"` löschen + `N.remove_port("flushport")`.

### P0 — Health-Robustheit (event-getrieben)

> Rename/Removal/Disabled werden über `async_track_entity_registry_updated_event` gefangen (engine.py `_handle_registry_event` Z. 224–247). Setup-Validierung läuft via `async_at_started` → `_check_config` (engine.py Z. 164–196).
> Marker sind ENGLISCH (Logs immer englisch). Registry-Mutationen brauchen den WS-/registry-Pfad; `N.setstate` allein triggert KEIN Registry-Event. Der Testkit hat `N.ws(commands)` für direkte WS-Aufrufe (`config/entity_registry/{remove,update}`).
> Hinweis: HR-2..5 mutieren die Entity-Registry. Verwende eine WEGWERF-Entität (z. B. einen extra angelegten `input_boolean`-Helfer), nicht die geteilten `input_boolean.test_*` (die andere Tests brauchen). Ist kein Wegwerf-Helfer verfügbar, bestätige NUR Marker + Codepfad (Files) und markiere den Live-Schritt als manuell.

- [ ] **HR-1 — Setup: fehlende Health-Entität → ERROR `does not exist`** · `P0`
  - **Prüft:** Ein Guard auf eine nicht existierende Entität loggt beim Start einen Config-Error (engine.py `_check_config` Z. 170–171).
  - **Files:** engine.py `_check_config` Z. 170–171 — `LOGGER.error("%s: health entity %s does not exist", ...)`.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"HrMissing", health:{entity_id:"binary_sensor.does_not_exist_xyz"}, mode:"recover", strategy:"switch", switch_entity:"switch.test_template_switch", behavior:{debounce:3,cooldown:5}})` → `N.wait(3)` → `N.log()`.
  - **Assert:** `N.log()` enthält `"HrMissing: health entity binary_sensor.does_not_exist_xyz does not exist"`.
  - **Cleanup:** Subentry `"HrMissing"` löschen.

- [ ] **HR-2 — Live-Remove der Health-Entität → ERROR `was removed`** · `P0`
  - **Prüft:** Wird die überwachte Entität zur Laufzeit aus der Registry gelöscht, loggt das Guard `was removed` (engine.py Z. 230–232, action `remove`).
  - **Files:** engine.py `_handle_registry_event` Z. 230–232 — `LOGGER.error("%s: health entity %s was removed", ...)`.
  - **Treiber:** Wegwerf-Helfer anlegen (UI/WS), Guard darauf legen → entity_registry_id ermitteln und Remove feuern: `N.ws([{"type":"config/entity_registry/remove","entity_id":"<eid>"}])` → `N.wait(3)` → `N.log()`. Kein Wegwerf-Helfer → nur Marker-/Codepfad bestätigen.
  - **Assert:** `N.log()` enthält `"<Name>: health entity <eid> was removed"` nach dem Remove-Event.
  - **Cleanup:** Subentry löschen.

- [ ] **HR-3 — Disabled → ERROR `is disabled — guard is blind`** · `P0`
  - **Prüft:** Wird die Health-Entität deaktiviert, loggt das Guard sowohl beim Setup (`_check_config` Z. 172–177) als auch live (Registry-Event Z. 240–245) einen ERROR.
  - **Files:** engine.py Z. 172–177 (Setup-Pfad) + Z. 240–245 (Live-`disabled_by`-Pfad), Marker `"is disabled — guard is blind"`.
  - **Treiber:** Guard auf Wegwerf-Helfer → live deaktivieren: `N.ws([{"type":"config/entity_registry/update","entity_id":"<eid>","disabled_by":"user"}])` → `N.wait(3)` → `N.log()`. Kein Wegwerf-Helfer → Marker-/Codepfad bestätigen.
  - **Assert:** `N.log()` enthält `"<Name>: health entity <eid> is disabled — guard is blind"`.
  - **Cleanup:** Entität re-enablen (`disabled_by:null`) + Subentry löschen.

- [ ] **HR-4 — Re-enabled → INFO `re-enabled`** · `P0`
  - **Prüft:** Wird eine zuvor deaktivierte Health-Entität wieder aktiviert, loggt das Guard `re-enabled` (engine.py Z. 246–247).
  - **Files:** engine.py `_handle_registry_event` Z. 240–247 — `else: LOGGER.info("%s: health entity %s re-enabled", ...)`.
  - **Treiber:** Anschluss an HR-3: `N.ws([{"type":"config/entity_registry/update","entity_id":"<eid>","disabled_by":None}])` → `N.wait(3)` → `N.log()`.
  - **Assert:** `N.log()` enthält `"<Name>: health entity <eid> re-enabled"`.
  - **Cleanup:** Subentry löschen.

- [ ] **HR-5 — Rename-Following: Config-`entity_id` wird aktualisiert** · `P0`
  - **Prüft:** Wird die Health-Entität umbenannt, loggt das Guard INFO `renamed old -> new` und der `_rename_handler` schreibt die neue id flach in `data.health.entity_id` der Subentry (engine.py Z. 236–239 + __init__.py `_rename_handler` Z. 89–97 → Reload, watcht neue id).
  - **Files:** engine.py Z. 236–239 (`LOGGER.info("Health entity for %s renamed %s -> %s", ...)`) + __init__.py `_rename_handler` Z. 89–97 (schreibt `CONF_ENTITY_ID` in die flache `health`-Dict). Hinweis: gespeicherte Health-Config ist FLACH (`data["health"]["entity_id"]`), nicht unter `state_check`.
  - **Treiber:** Guard auf Wegwerf-Helfer → umbenennen: `N.ws([{"type":"config/entity_registry/update","entity_id":"<old>","new_entity_id":"<old>_renamed"}])` → `N.wait(3)` → `N.log()` + `N.list_subentries(N.hub_id())` (Subentry-`data.health.entity_id` muss neue id sein).
  - **Assert:** `N.log()` enthält `"Health entity for <Name> renamed <old> -> <new>"` UND die Subentry-Daten tragen die neue `entity_id` unter `data.health.entity_id`.
  - **Cleanup:** Entität zurückbenennen + Subentry löschen.

- [ ] **HR-6 — Startup-Erkennung „off": beim Hochlauf schon unhealthy** · `P0`
  - **Prüft:** Ist die Health beim Start bereits unhealthy, erkennt das erste `_evaluate` in `async_start` das und geht in SUSPECT (engine.py `async_start` Z. 162 + `_evaluate` Z. 348–349 → `_enter_suspect`).
  - **Files:** engine.py `async_start` Z. 162 (`self._evaluate()`) + `_evaluate` Z. 348–349 + `_enter_suspect` Z. 360–365.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"HrBoot", health:{entity_id:"input_boolean.test_3", on_value:["on"], off_value:["off"]}, mode:"recover", strategy:"action_check", action:[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}], behavior:{debounce:20,cooldown:5,boot_window:4,max_attempts:1}})` → `N.call("input_boolean","turn_off",entity_id="input_boolean.test_3")` → RESTART (Health bleibt off) → nach RUNNING SCHNELL `N.guard("hrboot")`.
  - **Assert:** `N.guard("hrboot")[0] == "suspect"` kurz nach Restart (langes debounce=20s hält SUSPECT pollbar); im `N.log()` `"HrBoot unhealthy, waiting 20s (debounce)"`.
  - **Cleanup:** Subentry `"HrBoot"` + `N.call("input_boolean","turn_on",entity_id="input_boolean.test_3")`.

### P0 — Config-Error-Logging (System-Log ERROR, kein Notify)

> Driver-Config-Fehler kommen aus `driver.config_errors()` und werden in `_check_config` (engine.py Z. 178–179) als `"<Name>: <err>"` geloggt — via `async_at_started`, also erst wenn HA RUNNING ist.

- [ ] **CFG-1 — Valide Config → 0 Necromancer-ERRORs** · `P0`
  - **Prüft:** Bei ausschließlich validen Guards stehen keine necromancer-Config-Errors im Log.
  - **Treiber:** Eine saubere Guard-Garnitur sicherstellen (alle Health-/Switch-/Port-Refs existieren) → RESTART → nach RUNNING `N.log()`.
  - **Assert:** `N.log()` enthält KEINE Zeile mit `"does not exist"`, `"not found"`, `"no ports configured"` oder `"is disabled — guard is blind"` für ein necromancer-Guard. (Grep auf diese vier Marker = leer.)
  - **Cleanup:** —

- [ ] **CFG-2 — Switch fehlt (Setup) → ERROR `switch entity X not found`** · `P0`
  - **Prüft:** Ein `switch`/`switch_check`-Guard auf eine nicht existierende Switch-Entität loggt beim Start einen Config-Error (drivers/switch_cycle.py `config_errors` Z. 47–50).
  - **Files:** drivers/switch_cycle.py Z. 47–50 — `return [f"switch entity {self.switch_entity} not found"]`; geloggt in engine.py Z. 178–179.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"CfgSw", health:{entity_id:"input_boolean.test_4"}, mode:"recover", strategy:"switch", switch_entity:"switch.does_not_exist_xyz", behavior:{debounce:3,cooldown:5}})` → `N.wait(3)` → `N.log()`.
  - **Assert:** `N.log()` enthält `"CfgSw: switch entity switch.does_not_exist_xyz not found"`.
  - **Cleanup:** Subentry `"CfgSw"` löschen.

- [ ] **CFG-3 — poe_port ohne Ports → ERROR `no ports configured`** · `P0`
  - **Prüft:** Ein `poe_port`-Guard loggt einen Config-Error, wenn die Fabric keine Ports kennt (drivers/poe_port.py `config_errors` Z. 58–65 → `fabric.port_count == 0`).
  - **Files:** drivers/poe_port.py Z. 58–65 — Marker `"no ports configured — add ports in the integration's options"`.
  - **Treiber:** Sicherstellen, dass KEINE Ports konfiguriert sind (sonst zuerst alle via `N.remove_port(label)` entfernen) → `N.create_guard({source_type:"state_based", name:"CfgPoe", health:{entity_id:"input_boolean.sim_device_power"}, mode:"recover", strategy:"poe_port", expected_id:"aa:bb:cc:dd:ee:ff", behavior:{debounce:3,cooldown:5,boot_window:4,max_attempts:2}})` → `N.wait(3)` → `N.log()`.
  - **Assert:** `N.log()` enthält `"CfgPoe: poe_port 'aa:bb:cc:dd:ee:ff': no ports configured"`.
  - **Cleanup:** Subentry `"CfgPoe"` löschen.

- [ ] **CFG-4 — Action-Service fehlt: Laufzeit-ERROR, kein Pre-Check** · `P0`
  - **Prüft:** Für action/actions-Strategien gibt es bewusst keinen `can_recover`-Pre-Check; ein fehlender Service wirft erst beim Recover und wird als `Recovery driver failed` geloggt → retry/escalate, KEIN falscher Erfolg (engine.py `_run_recovery_cycle` Z. 451–460).
  - **Files:** engine.py Z. 451–460 — `except Exception … LOGGER.exception("Recovery driver failed for %s", self.name)`; KEIN `config_errors` für action-Driver.
  - **Treiber:** `N.create_guard({source_type:"state_based", name:"CfgAct", health:{entity_id:"input_boolean.test_6", on_value:["on"], off_value:["off"]}, mode:"recover", strategy:"action_check", action:[{"service":"nonexistent.service","data":{}}], behavior:{debounce:3,cooldown:5,boot_window:3,max_attempts:2}})` → `N.call("input_boolean","turn_off",entity_id="input_boolean.test_6")` → `N.wait(14)` → `N.guard("cfgact")` + `N.log()`.
  - **Assert:** `N.log()` enthält `"Recovery driver failed for CfgAct"` UND `N.guard("cfgact")[0] == "escalated"` (max_attempts erreicht), NICHT `cooldown`/`ok`.
  - **Cleanup:** Subentry `"CfgAct"` + `N.call("input_boolean","turn_on",entity_id="input_boolean.test_6")`.

- [ ] **CFG-5 — F2 Feedback-Loop-WARNING (Template referenziert eigene Entity)** · `P1`
  - **Prüft:** Ein Template-Health, das eine der EIGENEN Guard-Entities referenziert, erzeugt eine Feedback-Loop-WARNING — aber erst nach einem Reload/Neustart (`_check_config` via `async_at_started` läuft erst, wenn die eigenen Entities registriert sind), kein Crash (engine.py Z. 183–196).
  - **Files:** engine.py Z. 183–196 — `own.intersection(self.health.referenced_entities())` → `LOGGER.warning("%s: health references its own entit(ies) %s — feedback loop; …")`.
  - **Treiber:** `N.create_guard({source_type:"template_based", name:"CfgLoop", health:{template:"{{ is_state('sensor.cfgloop_status','ok') }}"}, mode:"recover", strategy:"action_check", action:[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"x"}}], behavior:{debounce:3,cooldown:5,boot_window:3,max_attempts:1}})` → erster Load: KEINE Warnung erwartet → RESTART (oder Reload) → `N.wait(3)` → `N.log()`.
  - **Assert:** Nach Reload `N.log()` enthält `"CfgLoop: health references its own entit(ies)"` und `"feedback loop"`; HA bleibt RUNNING (`N.g("/api/config")["state"]=="RUNNING"`), 0 Tracebacks.
  - **Cleanup:** Subentry `"CfgLoop"` löschen.

- [ ] **CFG-6 (B3) — Template-Health blind: fehlende/disabled referenzierte Entity** · `P1`
  - **Prüft:** `_check_config` validiert bei tracking-Sources (template) nicht nur `watched_entities` (= leer), sondern die tatsächlich gelesenen `referenced_entities()`. Eine einzelne fehlende/disabled Entity → **WARNING** (named); sind ALLE referenzierten Entities weg → **ERROR `guard is blind`** (state_based meldet das längst, template war bis B3 still blind).
  - **Files:** engine.py Z. 180–209 — `if not self.health.watched_entities:` → pro Entity `LOGGER.warning("%s: health template references %s, which does not exist"/"which is disabled")`; bei `len(blind)==len(referenced)` zusätzlich `LOGGER.error("%s: health template reads only missing/disabled entities %s — guard is blind")`. Hängt an `referenced_entities()` (template.py Z. 43–48 = `async_render_to_info().entities`) — beachtet daher nur Entities, die beim Rendern wirklich gelesen werden (Jinja-Kurzschluss bei `or` lässt die zweite Seite aus).
  - **Treiber:** Voll blind: `N.create_guard({source_type:"template_based", name:"CfgBlind", health:{template:"{{ is_state('binary_sensor.ghost_xyz','on') }}"}, mode:"notify", behavior:{debounce:3}})` → RESTART → `N.wait(3)` → `N.log()`. Teilweise (1 von 2 fehlt, kein false-blind): Template `"{{ is_state('<lebende Entity>','on') and states('binary_sensor.ghost_xyz') != 'never' }}"`.
  - **Assert:** Voll blind: `N.log()` enthält `"CfgBlind: health template reads only missing/disabled entities"` + `"guard is blind"` + `"binary_sensor.ghost_xyz"`. Teilweise: `"does not exist"` für die fehlende Entity, aber **kein** `"guard is blind"`. 0 Tracebacks.
  - **Automatisiert:** `test_integration.py::test_health_template_all_missing_is_blind` (ERROR-Pfad) + `::test_health_template_partial_missing_warns_only` (nur WARNING, kein false-blind).
  - **Cleanup:** Subentry `"CfgBlind"` löschen.

### Hinweis zum doc-internen Zählerstand

- [ ] **DOC-1 — Suite-Zählerstand im Regressions-Doc aktualisieren** · `P2`
  - **Prüft:** Der Header von REGRESSION.md nennt veraltete Testzahlen und veraltete „lock"-Formulierung.
  - **Files:** REGRESSION.md Z. 13 („51 automatisierte Tests grün") + Z. 55 („test_units (18) · test_poe (15) · test_engine (10) · test_integration (8) = 51 grün") + Z. 56 (Wort „lock"). Aktuell: `test_units=18 · test_poe=16 · test_engine=30 · test_integration=12-checks (7 Funktionen)`; PoE-Per-Port-`Lock` wurde ENTFERNT → durch **Coalescing** (`_inflight`-Task + `asyncio.shield`) ersetzt → „lock/Platzhalter" auf „Coalescing/Platzhalter" umtexten.
  - **Assert:** Header-Zeilen (Z. 13/55) auf die aktuellen Zahlen korrigiert; Z. 56 ersetzt „lock" durch „coalescing".
  - **Cleanup:** —

---

## Device-Link-Namen · State-Machine · Notify-i18n · Config-Flow/Reload · Kosmetik

### P0 — Device-Link-Namenslogik

> Hinweis: DLN1/DLN2 prüfen `LOGGER.debug`-Marker. Diese erscheinen in `N.log()` nur,
> weil die Dev-Config `custom_components.necromancer: debug` setzt (verifiziert in
> `config/configuration.yaml`). Bei abweichender Log-Stufe sind die Marker nicht sichtbar.

- [ ] **DLN1 — Verknüpfen hängt 4 Entities ans Zielgerät** · `P0`
  - **Prüft:** Ein Guard mit `assigned_device` erzeugt KEIN eigenes „Überwachtes Gerät", sondern hängt seine 4 Entities unter dem Subentry an das gewählte Zielgerät; dessen Name bleibt unangetastet.
  - **Files:** `__init__.py` → `_reconcile_devices` (Zeile 231–272: `standalone`/`linked_targets`-Split, stale-device-Remove `"Removing stale guard device %s"`); `config_flow.py` → `_device_schema` Zeile 341–349 (Section `SECTION_DEVICE="assigned_device"`, Feld `CONF_DEVICE_ID="device_id"`).
  - **Treiber:** Ziel-Device-id aus `N.g("/api/config/device_registry/list")` (irgendein Nicht-Necromancer-Gerät) holen. `N.create_guard` setzt `assigned_device={}` hart (Testkit Zeile 94) → ein verlinkter Guard ist NICHT direkt über `create_guard` baubar; stattdessen Subentry-Flow manuell treiben: `r=N._post_flow(fid,{"source_type":"state_based"})` → Device-Step mit `{"name":"LinkTgtX","mode":"recover","assigned_device":{"device_id":<id>},"state_check":{...}}` posten, dann Strategy/Switch wie sonst. Nach Reload `N.g("/api/config/device_registry/list")` und Entity-Registry filtern.
  - **Assert:** Zielgerät-Name unverändert; `sensor.linktgtx_status` existiert (`N.st(...)≠None`) und ist via Entity-Registry am Zielgerät (`device_id`==Ziel-id); KEIN zusätzliches Device mit identifier `(necromancer,<sid>)` im Registry; bei vorher existierendem Standalone erscheint `"Removing stale guard device"` in `N.log()`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **DLN2 — Auflösen setzt Device-Namen auf Guard-Namen (kein name_by_user-Override)** · `P0`
  - **Prüft:** Reconfigure von „Gerät zugewiesen" → „kein Gerät" flaggt `name_reset`; nach Reload trägt das wiederhergestellte Standalone-Device den Guard-Namen, `name_by_user=None`.
  - **Files:** `config_flow.py` → `_finish` (Zeile 1059–1062: `name_reset`-Set nur auf der Unlink-Transition); `__init__.py` → `_reconcile_devices` (Zeile 264–272: `dev_reg.async_update_device(..., name=engine.name, name_by_user=None)`).
  - **Treiber:** Guard mit `assigned_device` anlegen (s. DLN1), dann Reconfigure-Flow ohne `assigned_device` durchlaufen. `N.wait(3)`; `N.log()`.
  - **Assert:** `N.log()` enthält `"Resetting device name to <name> after unlink"` (DEBUG, exakt: `"Resetting device name to %s after unlink"`); im `device_registry/list` hat das `(necromancer,<sid>)`-Device `name_by_user==None` und `name==<guard-name>`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **DLN3 — Guard-Rename ändert Device-Namen NICHT (kein falsches name_reset)** · `P0`
  - **Prüft:** Reine Umbenennung (Device blieb unverändert zugewiesen/standalone) löst KEIN `name_reset` aus — `_finish` flaggt nur, wenn vorher device_id gesetzt war und jetzt leer.
  - **Files:** `config_flow.py` → `_finish` Zeile 1059 (`if subentry.data.get(CONF_DEVICE_ID) and not data.get(CONF_DEVICE_ID)`).
  - **Treiber:** Standalone-Guard `eid,sid=N.create_guard({...,"name":"RenA",...})`. Reconfigure-Flow nur mit neuem Namen `"RenB"`. `N.wait(3)`; `N.log()`.
  - **Assert:** Log enthält NICHT `"Resetting device name to"` für diesen Guard; `sensor.renb_status` existiert (`N.st(...)≠None`).
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **DLN4 — Self-/Cross-Link blockiert (`no_self_link`)** · `P0`
  - **Prüft:** Ein Necromancer-eigenes Gerät kann nicht als `assigned_device` gewählt werden — Device-Step lehnt mit `no_self_link` ab.
  - **Files:** `config_flow.py` → `_is_own_device` (Zeile 794–799) + `async_step_device` Zeile 888–889 (`errors[CONF_DEVICE_ID]="no_self_link"`); de.json `config_subentries.device.error.no_self_link`.
  - **Treiber:** Eigenes Guard-Device-id aus `device_registry/list` (identifier-domain `necromancer`) holen, Subentry-Flow bis Device-Step treiben und Device-Step mit `{"name":"SelfX","mode":"recover","assigned_device":{"device_id":<own_id>},"state_check":{...}}` posten.
  - **Assert:** Antwort `step_id=="device"` mit `errors=={"device_id":"no_self_link"}` (kein `create_entry`).
  - **Cleanup:** Flow nicht abgeschlossen → „—"

- [ ] **DLN5 — device.id stabil über Link→Unlink→Rename** · `P1`
  - **Prüft:** Die Subentry-/Device-Identität `(necromancer,<sid>)` bleibt dieselbe über Link, Unlink und Rename hinweg (kein neues Device-Objekt).
  - **Files:** `__init__.py` → `_reconcile_devices` (identifier `(DOMAIN, subentry_id)` bleibt Schlüssel; Device wird per `dev_reg.async_get_device(identifiers={(DOMAIN, subentry_id)})` gefunden, Zeile 268).
  - **Treiber:** Standalone-Guard anlegen → `<sid>` merken. Reconfigure mit `assigned_device` → reload. Reconfigure ohne → reload. Reconfigure Rename → reload. Jeweils `device_registry/list` nach `(necromancer,<sid>)` filtern.
  - **Assert:** `<sid>` (Subentry-id) identisch über alle Schritte; das Standalone-Device nach dem finalen Unlink trägt wieder denselben identifier `(necromancer,<sid>)`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

### P1 — State-Machine

- [ ] **SM1 — Happy Path OK→SUSPECT→RECOVERING→VERIFY→COOLDOWN→OK** · `P1`
  - **Prüft:** Voller Genesungszyklus mit `*_check`-Strategie; nach Erfolg `recover_count=1`.
  - **Files:** `engine.py` → `_evaluate`→`_enter_suspect`→`_debounce_done`→`_start_cycle`→`_run_recovery_cycle`→`_recover_success` (Zeile 335–510).
  - **Treiber:** `N.call("input_boolean","turn_on","entity_id","input_boolean.test_5")`. `eid,sid=N.create_guard({"source_type":"state_based","name":"SMHappy","health":{"entity_id":"input_boolean.test_5","on_value":["on"],"off_value":["off"]},"mode":"recover","strategy":"action_check","action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_5"}}],"behavior":{"debounce":1,"cooldown":3,"boot_window":10,"max_attempts":2}})`. Health brechen: `N.call("input_boolean","turn_off","entity_id","input_boolean.test_5")`. `N.wait(2)` (SUSPECT/RECOVERING/VERIFY zu schnell → in Log). `N.wait(2)`; `N.guard("smhappy")`.
  - **Assert:** `N.log()` enthält `"SMHappy unhealthy, waiting"`, `"SMHappy debounce elapsed, starting recovery"`, `"SMHappy recovered after"`; nach Cooldown `N.guard("smhappy")[0]=="ok"` und `attrs["recover_count"]==1`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **SM2 — Manueller Recover via Button umgeht Debounce + Auto-Gate** · `P1`
  - **Prüft:** `button.<slug>_reparieren` ruft `async_manual_recover` → `attempt=0` + sofortiger `_start_cycle`, ohne Debounce und ohne Auto-aus-Gate; Doppelpress während Cycle ignoriert (Busy-Guard `_busy()`).
  - **Files:** `engine.py` → `async_manual_recover` (Zeile 414–426, Busy-Guard `_busy()`); `button.py` → `RecoverButton.async_press` (Zeile 36–37).
  - **Treiber:** Guard wie SM1 (`"name":"SMManual"`, großer `"debounce":600`). `N.call("input_boolean","turn_off","entity_id","input_boolean.test_5")`; `N.wait(1)` → bleibt SUSPECT (Debounce nicht abgelaufen). `N.call("button","press","entity_id","button.smmanual_reparieren")`. `N.wait(2)`; `N.guard("smmanual")`.
  - **Assert:** `N.log()` enthält `"SMManual manual recovery requested"` und `"SMManual recovered after"`; `N.guard("smmanual")[0]` in `("cooldown","ok")`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **SM3 — Auto aus → ESCALATED, kein Recover-Versuch** · `P1`
  - **Prüft:** Mit deaktiviertem Auto-Switch eskaliert der Guard bei kranker Health im Debounce sofort (Policy-Gate `should_attempt`→`auto_off`), startet KEINEN Cycle, Notify `no_auto_recovery`.
  - **Files:** `engine.py` → `_debounce_done` Zeile 376–391; `policies/base.py` → `should_attempt` Zeile 26–30 (`return False, REASON_AUTO_OFF`).
  - **Treiber:** Guard wie SM1 (`"name":"SMAutoOff"`, `"debounce":1`). `N.call("switch","turn_off","entity_id","switch.smautooff_auto_reparatur")`; `N.wait(1)`. `N.call("input_boolean","turn_off","entity_id","input_boolean.test_5")`; `N.wait(3)`; `N.guard("smautooff")`.
  - **Assert:** `N.guard("smautooff")[0]=="escalated"`; `attrs["recover_count"]==0`; `N.log()` enthält `"SMAutoOff still unhealthy but auto-recovery is off (auto_off)"`; KEIN `"recovery attempt"` für SMAutoOff.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **SM4 — Max-Attempts → ESCALATED (Verify-Timeout, kein Traceback)** · `P1`
  - **Prüft:** Aktion heilt die Health NICHT → VERIFY läuft je Versuch ab → Retry bis `max_attempts` → `escalated`, `attempt==max`, `recover_count==0`; terminaler ERROR ohne Traceback (`_escalate` statt `LOGGER.exception`).
  - **Files:** `engine.py` → `_run_recovery_cycle` Zeile 467–475 (`if self.attempt>=self.max_attempts: self._escalate()`), `_wait_health_ok` Zeile 483–493, `_escalate` Zeile 522–528.
  - **Treiber:** Guard `"name":"SMMax"`, `"strategy":"action_check"`, Aktion schreibt NUR Notiz (heilt nicht): `"action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"poke"}}]`, `"behavior":{"debounce":1,"cooldown":3,"boot_window":2,"max_attempts":2}`. `N.call("input_boolean","turn_off","entity_id","input_boolean.test_5")`; `N.wait(8)`; `N.guard("smmax")`.
  - **Assert:** `N.guard("smmax")[0]=="escalated"`; `attrs["attempt"]==2`, `attrs["recover_count"]==0`; `N.log()` enthält `"SMMax could not be recovered after 2 attempt(s)"`; KEIN `"Traceback"` rund um SMMax.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **SM5 — COOLDOWN→SUSPECT (in Cooldown wieder krank)** · `P1`
  - **Prüft:** Wird die Health während COOLDOWN erneut unhealthy, geht der Guard über `_cooldown_done` zurück in SUSPECT (nicht direkt OK).
  - **Files:** `engine.py` → `_cooldown_done` Zeile 512–520 (`if self.health.evaluate()==Health.UNHEALTHY: self._enter_suspect()`).
  - **Treiber:** Guard wie SM1 (`"name":"SMCool"`, `"cooldown":6`, `"debounce":1`). Health brechen → heilen lassen (Aktion `input_boolean.turn_on test_5`) → in COOLDOWN erneut `N.call("input_boolean","turn_off","entity_id","input_boolean.test_5")`. `N.guard("smcool")` mehrfach pollen (COOLDOWN/SUSPECT sind langsam genug).
  - **Assert:** Beobachtete Folge in `N.guard`/`N.log`: `cooldown` → erneut `"SMCool unhealthy, waiting"` (SUSPECT) statt direktem `ok`.
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **SM6 — actions-Strategie: Aus-Aktion → Delay → Ein-Aktion** · `P1`
  - **Prüft:** `actions`-Strategie (ohne `_check`) führt getrennte off- und on-Sequenzen mit `off_on_delay` aus (Driver `action_cycle`); ohne Check sofortiger `_recover_success`.
  - **Treiber:** Guard `"source_type":"state_based","name":"SMActions"`, `"health":{"entity_id":"input_boolean.test_5","on_value":["on"],"off_value":["off"]}`, `"mode":"recover"`, `"strategy":"actions"`, `"off_action":[{"service":"input_boolean.turn_off","data":{"entity_id":"input_boolean.test_6"}}]`, `"on_action":[{"service":"input_boolean.turn_on","data":{"entity_id":"input_boolean.test_6"}}]`, `"off_on_delay":2`, `"behavior":{"debounce":1,"cooldown":3}` (ohne `_check` → kein boot_window/max_attempts). Health (`input_boolean.test_5`) brechen; `N.wait(5)`; `N.st("input_boolean.test_6")`.
  - **Assert:** `N.log()` enthält `"SMActions recovery attempt 1"`; `input_boolean.test_6` endet `state=="on"` (Ein-Aktion lief nach off+delay).
  - **Cleanup:** `N.delete_subentry(eid, sid)`

### P1 — Notify (i18n)

> Hinweis: Die de-/en-Texte stehen in `const.py` `NOTIFY_MESSAGES` und werden per
> `str.format` mit `{name}/{attempt}/{max}` gerendert. Die User-Notify-Aktion erhält
> `message/name/event/...` als Script-Variablen → in der Aktion `{{ message }}` (Jinja).

- [ ] **NOT1 — Logs Englisch, Notify-Meldung Deutsch (language=de)** · `P1`
  - **Prüft:** Bei `hass.config.language=="de"` rendert `async_notify` die de-Templates aus `NOTIFY_MESSAGES`, während die Log-Zeilen englisch bleiben.
  - **Files:** `notify.py` → `async_notify` Zeile 32–34 (`lang=...; messages=NOTIFY_MESSAGES.get(lang,...)`); `const.py` → `NOTIFY_MESSAGES["de"]` Zeile 159–168.
  - **Treiber:** Guard `"name":"NotiDe"`, `"mode":"recover"`, `"strategy":"action_check"` (heilt nicht: Aktion schreibt `input_text.test_note`), `"notify_action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"{{ message }}"}}]`, `"behavior":{"debounce":1,"cooldown":3,"boot_window":2,"max_attempts":1}`. Health brechen; `N.wait(6)`; `N.st("input_text.test_note")`.
  - **Assert:** `N.st("input_text.test_note")["state"]` enthält deutschen Text — final (max_attempts=1, escaliert) `"Reparatur fehlgeschlagen nach 1 Versuch."` (plural-korrekt), zwischenzeitlich auch `"Reparaturversuch 1 von 1."` möglich; `N.log()` bleibt englisch (`"recovery attempt"`/`"could not be recovered"`).
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **NOT2 — Notify-Aktion mit defektem Service → gefangen, kein Crash** · `P1`
  - **Prüft:** Eine Notify-Aktion mit nicht existierendem Service wird abgefangen (`Notify action failed`/`Notify action invalid`), der Guard läuft normal weiter (Notify detached via `hass.async_create_task`).
  - **Files:** `notify.py` → `_run` Zeile 45–53 (`except vol.Invalid` → `"Notify action invalid for %s"` / `except Exception` → `"Notify action failed for %s"`).
  - **Treiber:** Guard `"name":"NotiBad"`, `"notify_action":[{"service":"notify.does_not_exist","data":{"message":"{{ message }}"}}]`, `"strategy":"action_check"` (heilt: `input_boolean.turn_on test_5`), `"behavior":{"debounce":1,"cooldown":3,"boot_window":10,"max_attempts":2}`. Health brechen; `N.wait(5)`; `N.guard("notibad")`.
  - **Assert:** `N.log()` enthält `"Notify action"` (failed oder invalid) für NotiBad; Guard erreicht trotzdem `cooldown`/`ok` (`N.guard("notibad")[0]` in `("cooldown","ok")`); HA bleibt RUNNING (`N.g("/api/config")["state"]=="RUNNING"`).
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **NOT3 — Blockiert/Auto-aus = EINE Meldung (kein Doppel-Notify)** · `P1`
  - **Prüft:** Bei Auto-aus-Eskalation feuert genau EIN `no_auto_recovery`-Notify (über `_debounce_done`-Pfad), kein zusätzliches `recovery_attempt`.
  - **Files:** `engine.py` → `_debounce_done` Zeile 382–391 (genau ein `_notify("no_auto_recovery", reason=reason)`, dann `_set_state(GState.ESCALATED)`).
  - **Treiber:** Guard wie SM3, `notify_action` schreibt `{{ event }}` an `input_text.test_note`: `"notify_action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"{{ event }}"}}]`. Auto aus, Health brechen; `N.wait(4)`; `N.st("input_text.test_note")`; `N.log()`.
  - **Assert:** Notiz endet `=="no_auto_recovery"`; in `N.log()` für diesen Guard KEIN `"recovery attempt"` (Cycle nie gestartet).
  - **Cleanup:** `N.delete_subentry(eid, sid)`

- [ ] **NOT4 — Variablen `{{ message }}`/`{{ name }}`/`{{ event_text }}`/`{{ event }}` in der Aktion** · `P1`
  - **Prüft:** Die Notify-Aktion erhält die Variablen `message` (fertig lokalisiert), `name`, `event` plus Event-Params (attempt/max).
  - **Files:** `notify.py` → `variables={"message","name","event_text","event",**params}` + `actions.async_run` (Script-Variablen).
  - **Treiber:** Guard `"name":"NotiVars"`, `"notify_action":[{"service":"input_text.set_value","data":{"entity_id":"input_text.test_note","value":"{{ name }}|{{ event }}|{{ message }}"}}]`, heilbar (`action_check`, `input_boolean.turn_on test_5`), `"behavior":{"debounce":1,"cooldown":3,"boot_window":10,"max_attempts":2}`. Health brechen; `N.wait(4)`; `N.st("input_text.test_note")`.
  - **Assert:** Notiz beginnt mit `"NotiVars|"`; finaler `event` ist `recovery_success` (Heilung gelingt) → `"NotiVars|recovery_success|"`, danach der lokalisierte de-`message`-Text (`"Reparatur erfolgreich."`). (Zwischenzeitlich `recovery_attempt` möglich, wird aber überschrieben.)
  - **Cleanup:** `N.delete_subentry(eid, sid)`

### P1 — Config-Flow / Reload

- [ ] **CF1 — Hub: zweite Instanz → already_configured** · `P1`
  - **Prüft:** Der Service-Entry ist Singleton; ein zweiter User-Flow bricht mit `already_configured` ab.
  - **Files:** `config_flow.py` → `async_step_user` Zeile 765–770 (`if self._async_current_entries(): async_abort("already_configured")`); de.json `config.abort.already_configured`.
  - **Treiber:** Hub existiert bereits (`N.hub_id()`). Neuen User-Flow starten: `requests.post(N.BASE+"/api/config/config_entries/flow", headers=N.H, json={"handler":"necromancer"}).json()`.
  - **Assert:** Antwort enthält `"type":"abort"` und `"reason":"already_configured"`.
  - **Cleanup:** „—"

- [ ] **CF2 — Gerät hinzufügen/Reconfigure/Entfernen → Auto-Reload, andere Guards unberührt** · `P1`
  - **Prüft:** Subentry-Änderungen lösen `_async_reload_entry` aus; ein paralleler, unveränderter Guard behält Status/Stats (Store-Flush bei Unload).
  - **Files:** `__init__.py` → `_async_reload_entry` Zeile 275–279 (`async_reload`); `async_unload_entry` Store-Flush Zeile 291–300 (`store.async_save(serialize())`).
  - **Treiber:** Bystander-Guard `eidA,sidA=N.create_guard({...,"name":"CFBy",...})`; recover_count via Heilzyklus auf 1 bringen, in `ok` ruhen lassen. Dann zweiten Guard `eidB,sidB=N.create_guard({...,"name":"CFNew",...})` anlegen (löst Reload). `N.wait(3)`; `N.guard("cfby")`.
  - **Assert:** `N.guard("cfby")[0]=="ok"` und `attrs["recover_count"]==1` (überlebt Reload); `N.log()` ohne neue Errors für CFBy.
  - **Cleanup:** `N.delete_subentry(eidA,sidA)`; `N.delete_subentry(eidB,sidB)`

- [ ] **CF3 — Reconfigure-Defaults korrekt vorbefüllt** · `P1`
  - **Prüft:** Der Reconfigure-Flow lädt Source-Type, Name, Entität/Template, on/off-Listen, Strategie, Verhalten, Notify-Aktion und device_id korrekt vor.
  - **Files:** `config_flow.py` → `_source_type_of` (Z.297), `_health_defaults` (Z.603–613, inkl. `CONF_DEVICE_ID` Z.612), `_current_strategy` (Z.580–590, liest `CONF_HEALTH_CHECK`), `_switch_defaults`/`_action_defaults`/`_behavior_defaults` (Z.616–656).
  - **Treiber:** Guard `eid,sid=N.create_guard({"source_type":"state_based","name":"CFRe","mode":"recover","health":{"entity_id":"input_boolean.test_5"},"strategy":"switch_check","switch_entity":"switch.test_template_switch","behavior":{"debounce":1,"cooldown":3,"boot_window":10,"max_attempts":2}})`. Reconfigure-Subentry-Flow starten (`/api/config/config_entries/subentries/flow` mit `{"handler":[hub,"device"],"subentry_id":sid}`), die Steps NICHT submitten, sondern `data_schema`-Defaults inspizieren.
  - **Assert:** Source-Step Default == `state_based`; Device-Step suggested `name=="CFRe"`, on=`["on"]`/off=`["off"]`; Strategy-Step Default == `switch_check` (weil `health_check` gespeichert, `_build_data` Z.568); Switch-Step suggested `switch_entity=="switch.test_template_switch"`; Behavior-Werte == die gesetzten.
  - **Cleanup:** `N.delete_subentry(eid,sid)`

- [ ] **CF4 — Reconfigure Source-Wechsel state↔template** · `P1`
  - **Prüft:** Source-Step-Default folgt `_source_type_of`; nach Wechsel zeigt der Device-Step die passende Section (`state_check` ↔ `template_check`) und speichert die neue Source.
  - **Files:** `config_flow.py` → `_source` Zeile 867–878 (`default=_source_type_of(...)`), `async_step_device` Zeile 904–911 (`source_type=self._source_type`).
  - **Treiber:** state-Guard `eid,sid=N.create_guard({...,"name":"CFSrc",...})` anlegen. Reconfigure: Source-Step mit `{"source_type":"template_based"}` posten → Device-Step-Schema prüfen. Template `{{ is_state('input_boolean.test_5','on') }}` setzen, abschließen, reload.
  - **Assert:** Reconfigure-Source-Step Default initial `state_based`; nach `template_based`-Submit hat das Device-Step-Schema die `template_check`-Section (kein `state_check`); nach Abschluss `_source_type_of(subentry.data)=="template_based"`.
  - **Cleanup:** `N.delete_subentry(eid,sid)`

- [ ] **CF5 — F1 Doppelter Guard-Name beim Submit abgelehnt** · `P1`
  - **Prüft:** Zwei Guards mit gleichem (case/space-insensitivem) Namen → Device-Step lehnt mit `duplicate_name` ab.
  - **Files:** `config_flow.py` → `_name_taken` Zeile 804–815, `async_step_device` Zeile 890–892; de.json `config_subentries.device.error.duplicate_name`.
  - **Treiber:** `eid,sid=N.create_guard({...,"name":"DupGuard",...})`. Neuen Subentry-Flow bis Device-Step treiben, Device-Step mit `"name":" dupguard "` posten.
  - **Assert:** Antwort `step_id=="device"`, `errors=={"name":"duplicate_name"}` (kein create_entry).
  - **Cleanup:** `N.delete_subentry(eid,sid)`

- [ ] **CF6 — F6 Leere Aktion beim Submit abgelehnt** · `P1`
  - **Prüft:** `action`-Strategie ohne Aktionsinhalt → `action_required`.
  - **Files:** `config_flow.py` → `async_step_action` Zeile 958–979 (`if not flat.get(CONF_ACTION): errors[CONF_ACTION]="action_required"` Z.964–967); de.json `...error.action_required`.
  - **Treiber:** Flow bis Action-Step (`"strategy":"action"`); Action-Step mit leerer/fehlender `action` posten.
  - **Assert:** Antwort `step_id=="action"`, `errors=={"action":"action_required"}`.
  - **Cleanup:** Flow nicht abgeschlossen → „—"

### P2 — Kosmetik / Infra

- [ ] **KOS1 — Übersetzungen symmetrisch & jeder Step beschrieben** · `P2`
  - **Prüft:** `strings.json`, `translations/en.json` und `translations/de.json` haben dieselben Schlüssel; alle Subentry-Steps (user/reconfigure/device/strategy/switch/action/actions/poe_port/notify) tragen eine `description`.
  - **Files:** `strings.json`; `translations/{en,de}.json`.
  - **Treiber:** `.venv/bin/python3 -m script.translations develop --integration necromancer` (aus `<ha-core>`); dann JSON-Keys von strings vs de vs en vergleichen; je Step `config_subentries.device.step.<id>.description` prüfen.
  - **Assert:** Schlüsselmengen identisch (`strings==en==de`, verifiziert: alle drei gleich); alle 9 Device-Steps haben nicht-leere `description` (verifiziert: user/reconfigure/device/strategy/switch/action/actions/poe_port/notify).
  - **Cleanup:** „—"

- [ ] **KOS2 — Button heißt „Reparieren", Slug `_reparieren`** · `P2`
  - **Prüft:** Die deutsche Button-Übersetzung ist „Reparieren" → entity_id `button.<slug>_reparieren` (nicht `_recover`).
  - **Files:** `translations/de.json` → `entity.button.recover.name == "Reparieren"` (verifiziert); `button.py` → `_attr_translation_key="recover"` (Zeile 30).
  - **Treiber:** Recover-Guard `eid,sid=N.create_guard({...,"name":"KosBtn",...})` anlegen; `N.st("button.kosbtn_reparieren")`.
  - **Assert:** `N.st("button.kosbtn_reparieren")≠None`; `N.st("button.kosbtn_recover")==None`.
  - **Cleanup:** `N.delete_subentry(eid,sid)`

- [ ] **KOS3 — Status-Sensor lokalisiert alle 6 GState-Werte** · `P2`
  - **Prüft:** Die 6 Zustände ok/suspect/recovering/verify/cooldown/escalated haben de-Übersetzungen unter `entity.sensor.status.state`.
  - **Files:** `translations/de.json` → `entity.sensor.status.state` (alle 6 Keys, verifiziert); `state.py` → `GState` (Zeile 12–18).
  - **Treiber:** Datei-basiert.
  - **Assert:** Die 6 Keys `ok/suspect/recovering/verify/cooldown/escalated` existieren in de.json (verifiziert vorhanden).
  - **Cleanup:** „—"

### Nach Refactors zuerst prüfen

- **LinkCoordinator-Extraktion (M1) + `state.py`:** Linking lebt jetzt in `links.py` (`LinkCoordinator`, `engine.links`), `GState` in `state.py` (engine re-exportiert via `from .state import GState`). Peers über `peer.links` (public, z. B. `partner.links.following` in `find_repairing_partner` Z.100), NICHT `partner._following`. Treffer-Tests: DLN1–DLN5 (Device-Naming bleibt vom Refactor unberührt, aber `link_device_id`-Pfad bestätigen), SM2/SM4 (Busy-Guard/`_cycle_task` deckt auch den Follow-up-Verify ab — `async_manual_recover`/`on_partner_repair_done` belegen denselben `_cycle_task`-Slot, links.py Z.181 & Z.222).
- **Engine `_run_recovery_cycle` (kein falscher Erfolg bei recover()-Exception):** SM4 (Max-Attempts/Verify-Timeout, terminaler ERROR ohne Traceback; recover()-Exception-Pfad Z.453–460 ist separat und würde `LOGGER.exception` loggen).
- **F1/F6 Submit-Validierung:** CF5 (`duplicate_name`), CF6 (`action_required`) — wirklich Block, nicht nur Warnung.
- **Notify-als-Aktion (`{{ message }}`-Variablen via Script):** NOT1/NOT3/NOT4 (Variablen + EINE Meldung), NOT2 (defekter Service gefangen).
- **Reconfigure-Defaults/Source-Wechsel:** CF3 (alle Felder vorbefüllt), CF4 (state↔template).
- **Auto-Reload + Store-Flush:** CF2 (anderer Guard unberührt, recover_count überlebt Reload).

---

## Lücken / Ergänzungen (Completeness-Kritiker)

### Lücken

- [ ] **GAP-B1a — Stale-Cache via Re-Cabling-Simulation (Live)** · `P1`
  - **Prüft:** Wurde ein Gerät A umgesteckt und sitzt jetzt B auf dem alten Port, darf der Guard für A NICHT den Port zyklen (sonst Reboot des unschuldigen B); der stale Cache-Eintrag wird verworfen.
  - **Files:** `poe.py` → `resolve_with_reason` Zeile 177-198 (occupant-Check: `occupant is None` ⇒ last-known erlaubt; sonst `pop(target)` + WARNING `"now serves … — dropping stale cache"`).
  - **Treiber:** Port mit `id_entity=sensor.test_device_info`, `id_attribute="mac"` via `N.add_port({...})` anlegen; `N.setstate("sensor.test_device_info","x",mac="aa:aa")` (A lernen) → `N.wait(1)`; dann `N.setstate("sensor.test_device_info","x",mac="bb:bb")` (B sitzt jetzt drauf) → `N.wait(1)`; danach `N.call("necromancer","repair_poe_port",id="aa:aa")`.
  - **Assert:** `N.log()` enthält `"now serves 'bb:bb' — dropping stale cache"` UND `"cannot repair 'aa:aa'"`; KEIN `"cutting power"` für diesen Port nach dem repair-Aufruf.
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **GAP-B1b — last-known greift nur bei leerem Port** · `P1`
  - **Prüft:** Meldet der gecachte Port aktuell *nichts* (Placeholder), bleibt der last-known-Fallback gültig und liefert den Port zurück.
  - **Files:** `poe.py` → `resolve_with_reason` Zeile 183-190 (`occupant is None` ⇒ WARNING `"not in any port's neighbour data — last-known port"`, return port).
  - **Treiber:** `N.add_port({... id_entity:"sensor.test_device_info", id_attribute:"mac"})`; `N.setstate(...,mac="aa:aa")`→`N.wait(1)`; dann `N.setstate("sensor.test_device_info","x")` (mac-Attr weg ⇒ Port leer)→`N.wait(1)`; `N.call("necromancer","repair_poe_port",id="aa:aa")`.
  - **Assert:** `N.log()` enthält `"last-known port"` UND einen Cycle-Marker `"cutting power"`; der Cache-Eintrag `aa:aa` bleibt erhalten.
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **GAP-B1c — Unit-Test test_resolve_last_known_skips_occupied_port existiert** · `P2`
  - **Prüft:** Der neue PoE-Unit-Test für B1 ist vorhanden und im Lauf grün (Regressionsanker für die Stale-Cache-Logik).
  - **Files:** `tests/test_poe.py` → `test_resolve_last_known_skips_occupied_port` (Zeile ~164: asserts `p is None`, `"no port matches"`, `f.cache.get("aa:aa") is None`).
  - **Treiber:** `uv run python` aus `<ha-core>` mit `PYTHONPATH=<ha-core>:<ha-core>/config` → `python tests/test_poe.py`.
  - **Assert:** Ausgabe enthält `ok    test_resolve_last_known_skips_occupied_port` und Schlusszeile `16 passed, 0 failed`.
  - **Cleanup:** —

- [ ] **GAP-B2a — Reload mitten im Recovery-Zyklus eskaliert Follower NICHT (Datei-Marker)** · `P0`
  - **Prüft:** Wird der Leader-Engine mid-cycle gestoppt (Reload/Unload), darf sein `finally` KEIN failed-`notify_done` an die Gruppe feuern (sonst Eskalation der Follower aus halbem Zyklus).
  - **Files:** `engine.py` → `_run_recovery_cycle` `finally` Zeile 476-481 (`if not self._stopping: self.links.notify_done(...)`); `async_stop` Zeile 203-204 setzt `_stopping=True` + `links.reset()` VOR dem Cancel; `links.py` → `validate_after_repair` `finally` Zeile 218-222 (cycle-slot wird auch bei Cancel geleert).
  - **Treiber:** rein datei-basiert bestätigen (Live zu kurz/zu flüchtig).
  - **Assert:** `_stopping = True` steht in `async_stop` VOR `if self._cycle_task … cancel()`; `notify_done` ist durch `if not self._stopping` geschützt.
  - **Cleanup:** —

- [ ] **GAP-B2b — async_stop resettet Link-Zustand** · `P1`
  - **Prüft:** Beim Teardown wird Follower-State (`following`/`leader`) zurückgesetzt, damit ein neu geladener Guard nicht als „hängender Follower" startet.
  - **Files:** `engine.py` → `async_stop` Zeile 204 `self.links.reset()`; `links.py` → `LinkCoordinator.reset` Zeile 85-88 (`following=False; leader=None`).
  - **Treiber:** Engine-Suite ist der Anker — `python tests/test_engine.py`; relevante Fälle `test_async_stop_cancels_validate_no_escalation`, `test_leader_stop_does_not_escalate_follower`.
  - **Assert:** Ausgabe enthält `ok    test_async_stop_cancels_validate_no_escalation` und `ok    test_leader_stop_does_not_escalate_follower`; `30 passed, 0 failed`.
  - **Cleanup:** —

- [ ] **GAP-M1a — GState aus state.py ausgelagert, engine re-exportiert weiterhin** · `P0`
  - **Prüft:** Nach dem M1-Refactor ist `GState` in `state.py` und sowohl `from .engine import GState` als auch `from .state import GState` funktionieren (sensor.py + Tests hängen an `engine.GState`).
  - **Files:** `state.py` → `class GState(StrEnum)` (6 Werte); `engine.py` Zeile 48 `from .state import GState` (macht `engine.GState` verfügbar); `sensor.py` Zeile 10 `from .engine import DeviceEngine, GState`.
  - **Treiber:** `uv run python -c "import sys; sys.path.insert(0,'repo'); from custom_components.necromancer.engine import GState as A; from custom_components.necromancer.state import GState as B; print(A is B, [s.value for s in A])"` (aus `<ha-core>`, PYTHONPATH gesetzt).
  - **Assert:** Ausgabe `True ['ok', 'suspect', 'recovering', 'verify', 'cooldown', 'escalated']`.
  - **Cleanup:** —

- [ ] **GAP-M1b — Status-Sensor lädt + ENUM-Optionen korrekt (Live)** · `P0`
  - **Prüft:** Nach dem GState-Move lädt die Sensor-Plattform weiter; der Status-Sensor existiert und seine ENUM-`options` decken alle 6 States ab.
  - **Treiber:** Guard anlegen `eid,sub = N.create_guard({...minimal recover...})` → `N.wait(2)`; dann `N.st("sensor.<slug>_status")`.
  - **Assert:** `st["state"] == "ok"`; `st["attributes"]["options"] == ["ok","suspect","recovering","verify","cooldown","escalated"]`; `st["attributes"]["device_class"] == "enum"`.
  - **Cleanup:** `N.delete_subentry(eid, sub)`

- [ ] **GAP-M1c — Peer-Zugriff nur über peer.links (kein partner._following)** · `P1`
  - **Prüft:** Der LinkCoordinator erreicht Partner ausschließlich über die öffentliche `peer.links`-Fassade, nicht über alte private Attribute (`partner._following`/`partner._on_partner_repair_*`).
  - **Files:** `links.py` → `find_repairing_partner` Zeile 100-101 (`partner.links.following`), `notify_start`/`notify_done` Zeile 116/133 (`partner.links.on_partner_repair_…`). Bestätigen: in `links.py` taucht KEIN `partner._following` / `partner._on_partner_repair` auf.
  - **Treiber:** `grep -nE "partner\._(following|on_partner)" custom_components/necromancer/links.py` → muss leer sein.
  - **Assert:** grep liefert 0 Treffer; `partner.links.following` und `partner.links.on_partner_repair_start` sind vorhanden.
  - **Cleanup:** —

- [ ] **GAP-PE1 — PoE-Cache in den Store persistiert (_poe_cache)** · `P1`
  - **Prüft:** Der gelernte id→Port-Cache wird unter `_poe_cache` serialisiert und beim Setup wieder in die Fabric geseedet (überlebt Reload/Neustart).
  - **Files:** `__init__.py` → `_serialize` Zeile 116-119 (`data["_poe_cache"] = fabric.cache`); `fabric.set_ports(ports, cache=stored.get("_poe_cache"))` Zeile 128; `poe.py` → `set_ports` `cache`-Param Zeile 71-75.
  - **Treiber:** Port mit dynamischer id anlegen, Gerät lernen lassen (`N.setstate(..., mac="aa:bb")`→`N.wait(1)`); dann Storage-Datei lesen: `N.g` gibt es nicht für Files → bash `grep -l _poe_cache <ha-core>/config/.storage/necromancer.*` nach `N.wait(6)` (SAVE_DELAY=5).
  - **Assert:** Storage-JSON enthält Key `"_poe_cache"` mit `"aa:bb"` → Port-Label.
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **GAP-PE2 — Placeholder-Ids werden nie gelernt (kein WARNING-Storm)** · `P2`
  - **Prüft:** Ports ohne angeschlossenes Gerät melden Platzhalter (`-`/`unknown`/leer); die Fabric lernt daraus nichts und ein Platzhalter-Identifier resolved auf nichts.
  - **Files:** `poe.py` → `_PLACEHOLDER_IDS` Zeile 48, `_norm` Zeile 51-56, `_relearn` Zeile 120-125; Unit-Test `tests/test_poe.py::test_placeholder_ids_are_never_learned`.
  - **Treiber:** `python tests/test_poe.py` (Unit-Anker) ODER live: `N.add_port({...id_entity:"sensor.test_device_info"})` ohne mac-Attr → `N.setstate("sensor.test_device_info","-")` → `N.wait(1)` → `N.call("necromancer","repair_poe_port",id="-")`.
  - **Assert:** Unit-Lauf zeigt `ok    test_placeholder_ids_are_never_learned`; live: `N.log()` enthält `"no port matches '-'"`, KEIN „learned"/„moved" WARNING.
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **GAP-CC1 — HA-Restart mid-cycle: transienter State wird aus Live-Health neu abgeleitet** · `P1`
  - **Prüft:** Nach Neustart werden transiente States (RECOVERING/VERIFY/SUSPECT) NICHT aus dem Store restauriert; nur ESCALATED bleibt terminal, Stats+`auto` bleiben.
  - **Files:** `engine.py` → `_apply_persisted` Zeile 111-126 (nur `state == "escalated"` wird gesetzt; transient ⇒ `async_start`/`_evaluate` leitet neu ab); Unit-Anker `test_engine.py::test_persistence_escalated_stays` / `_autoclears`.
  - **Treiber:** `python tests/test_engine.py`.
  - **Assert:** `ok    test_persistence_escalated_stays`, `ok    test_persistence_escalated_autoclears`, `ok    test_snapshot_roundtrip`.
  - **Cleanup:** —

- [ ] **GAP-CC2 — Store-Flush vor Teardown (kein staler Store nach Reload)** · `P1`
  - **Prüft:** `async_unload_entry` schreibt den serialisierten State synchron weg, BEVOR Engines gestoppt werden, damit ein Reload (Rename/Reconfigure) keinen veralteten Store liest.
  - **Files:** `__init__.py` → `async_unload_entry` Zeile 296-305 (`store.async_save(serialize())` vor `engine.async_stop()`); `_save` nutzt `async_delay_save` (SAVE_DELAY) Zeile 121-122.
  - **Treiber:** datei-basiert bestätigen (Reihenfolge der Aufrufe in `async_unload_entry`).
  - **Assert:** Im `async_unload_entry` steht `await store.async_save(serialize())` vor der Engine-Stop-Schleife `for engine in entry.runtime_data.values(): await engine.async_stop()`.
  - **Cleanup:** —

- [ ] **GAP-CC3 — Storage-Migration-Gerüst (STORAGE_VERSION=1, keine Migration nötig)** · `P2`
  - **Prüft:** Es gibt (noch) keinen `async_migrate`-Pfad; STORAGE_VERSION ist 1 und `async_load() or {}` toleriert ein leeres/fehlendes Store-File. Lücke dokumentieren, falls später Version steigt.
  - **Files:** `const.py` → `STORAGE_VERSION = 1`; `__init__.py` Zeile 104-105 (`Store(hass, STORAGE_VERSION, …)`, `async_load() or {}`). Bestätigen: KEIN `async_migrate_func`/migrator registriert.
  - **Treiber:** `grep -rn "migrate\|STORAGE_VERSION" custom_components/necromancer/` .
  - **Assert:** STORAGE_VERSION == 1; kein `migrate`-Treffer ⇒ bei einem künftigen Bump MUSS ein Migrator + Test ergänzt werden (Lücke notieren).
  - **Cleanup:** —

- [ ] **GAP-RD1 — repair_poe_port-Service nur einmal registriert (Reload-sicher)** · `P2`
  - **Prüft:** Der Service `necromancer.repair_poe_port` wird über `has_service` geschützt nur einmal registriert; ein Reload re-registriert nicht und die Fabric bleibt Domain-Singleton.
  - **Files:** `__init__.py` → Zeile 132-142 (`if not hass.services.has_service(...)`); Fabric-Singleton Zeile 111-113 (`domain_data.get("fabric") or PoeFabric(hass)`).
  - **Treiber:** Live: `N.g("/api/services")` und nach Service `necromancer`/`repair_poe_port` suchen; Reload erzwingen (Port-Options-Change via `N.add_port`/`N.remove_port`) → erneut prüfen.
  - **Assert:** Service `repair_poe_port` ist genau einmal vorhanden, vor und nach Reload identisch (keine Exception im `N.log()` über doppelte Registrierung).
  - **Cleanup:** `N.remove_port("<label>")`

- [ ] **GAP-LK1 — notify-only-Guard fällt aus allen Link-Gruppen (Closure schließt ihn aus)** · `P1`
  - **Prüft:** Ein zu notify-only rekonfigurierter Guard ist kein Link-Ziel mehr — `_is_recover` filtert ihn aus `device_ids`+`declared_links`, sodass `link_components` ihn nicht in eine Gruppe zieht.
  - **Files:** `__init__.py` → `_is_recover` Zeile 148-152 + `device_ids`/`declared_links` Zeile 154-160; `links.py` → `link_components` (stale ids via `valid` gedroppt).
  - **Treiber:** Zwei recover-Guards verlinken (`linked_guards` im zweiten Spec), bestätigen dass beide verlinkt sind (`N.guard(slug)` attrs/Log `linked=`), dann einen auf notify-only umkonfigurieren (oder als notify anlegen) → Reload.
  - **Assert:** Im Setup-Log `Guard … linked=` zeigt für den notify-only-Guard `linked=none`; der Partner zeigt den notify-only-Guard NICHT mehr in seiner Gruppe.
  - **Cleanup:** `N.delete_subentry(...)` für beide.

- [ ] **GAP-RC1 — recover→notify-only entfernt Switch+Button-Waisen** · `P1`
  - **Prüft:** Wird ein Guard von recover auf notify-only umgestellt, werden seine Steuer-Entities (`switch._auto_reparatur`, `button._reparieren`) aus der Registry entfernt (keine Orphans).
  - **Files:** `__init__.py` → `_reconcile_entities` Zeile 210-228 (entfernt `switch/auto_restart` + `button/recover` für `not engine.allows_recovery`).
  - **Treiber:** recover-Guard anlegen → `N.st("switch.<slug>_auto_reparatur")` ist gesetzt; via Reconfigure auf notify-only umstellen → Reload → erneut `N.st(...)` für Switch und Button.
  - **Assert:** `N.st("switch.<slug>_auto_reparatur") is None` UND `N.st("button.<slug>_reparieren") is None` nach der Umstellung; `N.log()` enthält `"Removing"` … `"(notify-only guard"`.
  - **Cleanup:** `N.delete_subentry(...)`

- [ ] **GAP-CFG1 — Config-Error-Logging beim Start (fehlende Health-Entity)** · `P1`
  - **Prüft:** `_check_config` läuft erst nach „HA started" und loggt fehlende/disabled Health-Entities als ERROR (Boot-Race vermieden).
  - **Files:** `engine.py` → `_check_config` Zeile 164-196 (`async_at_started` Hook Zeile 155; ERROR „health entity … does not exist" / „is disabled — guard is blind"); Integration-Anker `test_integration.py::test_health_disable_logs_blind`.
  - **Treiber:** `python tests/test_integration.py` (Anker) ODER live: Guard mit nicht existierender Health-Entity anlegen → `N.wait(2)` → `N.log()`.
  - **Assert:** Integration: `ok  health:disable_logs_blind`; live: `N.log()` enthält `"does not exist"` (kein Traceback).
  - **Cleanup:** `N.delete_subentry(...)`

- [ ] **GAP-CC4 — _await_status: bereits-im-Zielzustand-Port (kein Timeout-Warten)** · `P2`
  - **Prüft:** Meldet die Status-Entity beim Power-On bereits den Online-Wert, kehrt `_await_status` sofort `True` zurück (kein unnötiges Timeout/Race auf das State-Event).
  - **Files:** `poe.py` → `_await_status` Zeile 294-337 (`if current() in targets: return True` Zeile 312-313, vor dem Event-Abonnement).
  - **Treiber:** Anker `tests/test_poe.py::test_repair_cycles_and_fires_status` deckt den Pfad; Lauf bestätigen.
  - **Assert:** `ok    test_repair_cycles_and_fires_status` im PoE-Lauf; `f.status("PX") == "good"`.
  - **Cleanup:** —

- [ ] **GAP-CC5 — Ambiguer Resolve verweigert (>1 Live-Match)** · `P2`
  - **Prüft:** Melden zwei Ports dieselbe id, rät die Fabric NICHT, sondern verweigert mit `"matches N ports"` (kein Cycle des falschen Ports).
  - **Files:** `poe.py` → `resolve_with_reason` Zeile 172-176 (`len(live) > 1` ⇒ `None, "matches N ports"`); Unit `test_poe.py::test_resolve_ambiguous`.
  - **Treiber:** `python tests/test_poe.py`.
  - **Assert:** `ok    test_resolve_ambiguous`.
  - **Cleanup:** —

- [ ] **GAP-CC6 — Coalescing ersetzt per-Port-Lock (richtige Test-Namen)** · `P1`
  - **Prüft:** Der per-Port asyncio.Lock ist entfernt; gleichzeitige Repair-Aufrufe coalescen auf genau einen Cycle (`_inflight` + `asyncio.shield`). Veraltete Testnamen existieren NICHT mehr.
  - **Files:** `poe.py` → `repair` Zeile 231-257 (`self._inflight`, `asyncio.shield(task)`), KEIN `asyncio.Lock`; Tests `test_concurrent_callers_coalesce` + `test_driver_and_service_coalesce` (NICHT `*_per_port_lock_*`).
  - **Treiber:** `grep -n "asyncio.Lock\|per_port_lock\|share_lock" custom_components/necromancer/poe.py tests/test_poe.py` → leer; dann `python tests/test_poe.py`.
  - **Assert:** grep 0 Treffer; Lauf zeigt `ok    test_concurrent_callers_coalesce` + `ok    test_driver_and_service_coalesce`, `cycles == 1`/`max_conc == 1`.
  - **Cleanup:** —

- [ ] **GAP-SUITE — Aktuelle Suite-Zählungen stimmen (Doc-Drift gegen Code)** · `P2`
  - **Prüft:** Die vier Suiten melden die aktuellen Counts (units=18, poe=16, engine=30, integration=8-Checks) — nicht die veralteten 10/15/8/„51".
  - **Treiber:** je `python tests/test_units.py`, `…/test_poe.py`, `…/test_engine.py`, `…/test_integration.py` (aus `<ha-core>`, PYTHONPATH gesetzt).
  - **Assert:** Schlusszeilen `18 passed`, `16 passed`, `30 passed`, `8/8 checks passed` (jeweils 0 failed).
  - **Cleanup:** —
