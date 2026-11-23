// Necromancer frontend core: pure functions shared by the cards.
//
// No DOM, no HTMLElement, no window at import time: everything here takes plain
// objects (state objects as HA hands them to cards) and returns plain values, so
// it runs unchanged under `node --test` (tests/frontend/).

export const DOMAIN = "necromancer";

// ---------------------------------------------------------------------------
// Version: every module of the cards must come from one release
// ---------------------------------------------------------------------------
//
// frontend.py loads the bundle as `necromancer.js?v=<version>` and the static
// path is served without cache headers, so a module imported *without* the
// query is a different URL: the browser may keep an old copy of it next to a
// new bundle, and it is a second module instance (own state, own constants).
// Every module therefore imports its siblings with the query it was loaded with:
//
//   const Q = new URL(import.meta.url).search;            // "?v=0.5.0" or ""
//   const core = await import(`../../necromancer-core.js${Q}`);
//   const actions = await import(`../../necromancer-actions.js${Q}`);
//   await import(`./x-guard-card.js${Q}`);                // own sub-modules too
//
// Static `import ... from "./x.js"` cannot carry a query: use dynamic imports
// for anything shared. Once the core is loaded, `core.VERSION_QUERY` is the same
// string, and `versioned(path, import.meta.url)` builds such a URL.

/** The `?v=` this core was loaded with ("" when loaded bare, e.g. in tests). */
export const VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "";
  } catch (_err) {
    return "";
  }
})();

/** "?v=<version>" (URL-encoded) or "" -- append it to sibling module imports. */
export const VERSION_QUERY = VERSION ? `?v=${encodeURIComponent(VERSION)}` : "";

/**
 * Absolute URL of `path` relative to `base` (pass `import.meta.url`), carrying
 * this core's version: `await import(core.versioned("./b-panel.js", import.meta.url))`.
 */
export function versioned(path, base) {
  const url = new URL(path, base);
  if (VERSION) url.searchParams.set("v", VERSION);
  return url.href;
}
export const EDIT_PATH = "/config/integrations/integration/necromancer";

// Snooze durations offered by the card, in seconds (design §16.3).
export const SNOOZE_DURATIONS = [1800, 3600, 14400, 86400];

// Actions that need a second tap ("Sure?") before they run.
export const CONFIRM_ACTIONS = new Set(["revive", "ping"]);

// Canonical order of all actions (design §5 action table); the menu follows it.
export const ACTION_ORDER = [
  "revive",
  "reset",
  "snooze",
  "unsnooze",
  "ping",
  "auto",
  "check",
  "url",
  "edit",
  "details",
];

// Engine driver keys -> user-facing strategy names, in case an older backend (or
// a hand-written state in a test) still reports the internal one.
const DRIVER_ALIASES = {
  switch_cycle: "switch",
  action_call: "action",
  action_cycle: "actions",
  poe_port: "poe_port",
  noop: "notify",
};

const UNAVAILABLE = new Set(["unavailable", "unknown", "", null, undefined]);

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

export const I18N = {
  en: {
    "status.ok": "Healthy",
    "status.suspect": "Problem, waiting …",
    "status.blind": "Health unknown",
    "status.recovering": "Recovering …",
    "status.verify": "Verifying …",
    "status.cooldown": "Recovered",
    "status.escalated": "Escalated",
    "status.snoozed": "Snoozed until {time}",
    "status.snoozed_open": "Snoozed",
    "status.until": "until {time}",
    "status.unavailable": "Unavailable",
    "hb.suspect": "Heartbeat overdue",
    "hb.suspect_fail": "Failure reported",
    "hb.blind": "Waiting for first heartbeat",
    "hb.recovering": "Repairing …",
    "hb.verify": "Waiting for heartbeat …",
    "value.last_heartbeat": "Last heartbeat",
    "value.expected_every": "expected every {period}",
    "value.never": "Never",
    "value.for": "for {duration}",
    "value.for_hint": "Time in this state, counted from its last change (a restart or reload of Home Assistant starts it again)",
    "value.state_for": "{state} for {duration}",
    "event.recovered": "Recovery succeeded",
    "event.escalated": "Escalated",
    "event.blocked": "Recovery blocked",
    "event.attempts_one": "{n} attempt",
    "event.attempts_other": "{n} attempts",
    "rel.now": "just now",
    "rel.past": "{v} ago",
    "rel.future": "in {v}",
    "unit.s": "s",
    "unit.min": "min",
    "unit.h": "h",
    "unit.d": "d",
    "action.revive": "Revive",
    "action.revive_wake": "Revive (ends the snooze)",
    "action.reset": "Reset",
    "action.snooze": "Snooze",
    "action.unsnooze": "Wake up",
    "action.ping": "Heartbeat",
    "action.auto_on": "Turn auto-recovery on",
    "action.auto_off": "Turn auto-recovery off",
    "action.check": "Check now",
    "action.url": "Copy heartbeat URL",
    "action.edit": "Edit",
    "action.details": "Details",
    "action.more": "Actions",
    "action.sure": "Sure?",
    "snooze.1800": "30 minutes",
    "snooze.3600": "1 hour",
    "snooze.14400": "4 hours",
    "snooze.86400": "1 day",
    "chip.health": "Health",
    "chip.actor": "Recovery",
    "chip.auto_off": "Auto-recovery is off – tap to turn it on",
    "chip.auto_confirm": "Tap again to turn auto-recovery on",
    "chip.snoozed": "Snoozed – tap to wake up",
    "chip.recovered": "Recoveries",
    "chip.failed": "Failures",
    "chip.count": "{title}: {n}",
    "health.ok": "Healthy",
    "health.unhealthy": "Unhealthy",
    "health.unknown": "Unknown",
    "toast.health": "{name}: {health}",
    "toast.copied": "Heartbeat URL copied",
    "toast.copy_failed": "Could not copy the heartbeat URL",
    "toast.no_url": "No heartbeat URL available",
    "toast.snoozed": "{name} snoozed for {duration}",
    "toast.done": "{name}: {action}",
    "error.entity": "Entity required: set `entity` to a Necromancer status sensor",
    "error.not_found": "Entity not found: {entity}",
    // Short state names (count chips, filters, sort groups).
    "state.ok": "Healthy",
    "state.suspect": "Suspect",
    "state.blind": "Blind",
    "state.recovering": "Recovering",
    "state.verify": "Verifying",
    "state.cooldown": "Recovered",
    "state.escalated": "Escalated",
    "state.snoozed": "Snoozed",
    "state.unavailable": "Unavailable",
    "type.heartbeat": "Heartbeat",
    "type.recovery": "Recovery",
    "type.notify": "Notify only",
    "count.total": "{n} guards",
    "count.total_one": "{n} guard",
    "count.problems": "{n} need attention",
    "count.problems_one": "{n} needs attention",
    "sort.problems": "Problems first, then name",
    "sort.name": "Name",
    "sort.state": "State",
    "sort.last_activity": "Last activity",
    "action.snooze_all": "Maintenance mode",
    "action.unsnooze_all": "Wake all",
    "action.repair_poe_port": "Restart port",
    "action.edit_ports": "Edit ports",
    "action.settings": "Settings",
    "action.menu": "Menu",
    "toast.snoozed_all": "All guards snoozed for {duration}",
    "toast.unsnoozed_all": "All guards woken up",
    "toast.poe_restart": "Restarting PoE port {port} …",
    "toast.settings_failed": "Could not save the settings",
    "tab.guards": "Guards",
    "tab.heartbeat": "Heartbeat",
    "tab.poe": "PoE",
    "panel.title": "Necromancer",
    "panel.empty": "No guards yet. Add one under Settings → Devices & services → Necromancer.",
    "panel.no_match": "No guard matches.",
    "panel.filter_clear": "All clear — no guard matches right now.",
    "settings.title": "Settings",
    "settings.show_counters": "Show counters (recoveries, failures)",
    "settings.show_actions": "Show actions",
    "settings.show_footer": "Show the last event",
    "settings.collapse_ok": "Collapse quiet guards",
    "settings.sort": "Sort",
    "settings.start_tab": "Start tab",
    "search.placeholder": "Search …",
    "group.quiet": "Quiet ({n})",
    "poe.status.good": "Ready",
    "poe.status.recovering": "Restarting …",
    "poe.status.failed": "Restart failed",
    "poe.status.off": "Powered off",
    "poe.status.offline": "Device offline",
    "poe.status.unknown": "Switch unavailable",
    "poe.switch": "Switch",
    "poe.id_static": "Static label",
    "poe.id_none": "Nothing connected",
    "poe.id_conflict": "Misconfigured: static label and id entity",
    "poe.used_by": "Used by",
    "poe.unused": "No guard",
    "poe.last_cycle": "Last restart",
    "poe.last_ok": "succeeded",
    "poe.last_failed": "failed",
    "poe.never": "Never",
    "poe.last_known": "last known",
    "poe.ambiguous": "ambiguous",
    "poe.power_on": "Power on",
    "poe.power_off": "Power off",
    "poe.online": "Online",
    "poe.offline": "Offline",
    "poe.empty": "No PoE ports configured.",
    "poe.id_live_from": "live · from {source}",
    "poe.id_live": "live",
    "poe.id_source_none": "No id source",
    "poe.rel.live": "matches",
    "poe.rel.last_known": "last known",
    "poe.rel.ambiguous": "ambiguous",
    "poe.rel.mismatch": "port reports another id",
    "poe.rel.elsewhere": "now on another port",
    "poe.rel.also_on": "also on {ports}",
    "poe.rel.reports": "port reports {id}",
    "poe.rel.now_on": "now on {ports}",
    "poe.port_n": "Port {n}",
    "poe.expected": "expected: {id}",
    "poe.empty_expected": "Nothing connected · expected: {id} (last known)",
    "poe.id_conflict_from": "conflict · label {id} and {source}",
    "chip.auto_off_short": "Auto off",
    "event.last_escalation": "Last escalation {when}",
    "event.last_blocked": "Last blocked repair {when}",
    "rec.title": "Recovery",
    "rec.chip_title": "Recovery: {target}",
    "rec.kind.switch": "Switch",
    "rec.kind.poe_port": "PoE port",
    "rec.kind.script": "Script",
    "rec.kind.action": "Action",
    "rec.kind.actions": "Off/on actions",
    "rec.kind.notify": "Notify only",
    "rec.notify_only": "Notify only — no repair",
    "rec.action": "Action",
    "rec.action_steps_one": "Action (1 step)",
    "rec.action_steps_other": "Action ({n} steps)",
    "rec.actions_steps_one": "Off/on actions (1 step)",
    "rec.actions_steps_other": "Off/on actions ({n} steps)",
    "rec.poe_on": "{port} on {switch}",
    "rec.poe_for": "PoE port for {id}",
    "rec.poe_none": "No port found",
    "rec.poe_ambiguous": "{ports}",
    "rec.or": "or",
    "rec.device": "Device",
    "rec.found.last_known": "last known port · nothing connected now",
    "rec.found.ambiguous": "ambiguous · id on several ports",
    "rec.found.mismatch": "port now reports {id} · repair blocked",
    "rec.found.mismatch_plain": "port reports another id · repair blocked",
    "rec.found.none": "no port reports this id · repair blocked",
    "rec.loading": "Looking up the port …",
    "rec.error": "Port lookup not available",
    "rec.port_status": "Port status",
    "rec.status_hidden": "Status not visible",
    "rec.last_repair": "Last repair",
    "rec.repairs": "Repairs",
    "rec.counts": "{ok} succeeded · {failed} failed",
    "rec.auto": "Auto-recovery",
    "rec.auto_off_confirm": "Turn auto-recovery off? Problems are then only reported.",
    "rec.repair_now": "Repair now",
    "rec.busy": "A repair is running …",
    "rec.snoozed": "Snoozed — wake it up first",
    "rec.port_busy": "The port is restarting …",
    "rec.blocked": "No unique port — a repair would be blocked",
    "rec.unavailable": "Guard unavailable",
  },
  de: {
    "status.ok": "Gesund",
    "status.suspect": "Problem, wird bestätigt …",
    "status.blind": "Zustand unbekannt",
    "status.recovering": "Reparatur läuft …",
    "status.verify": "Prüfung läuft …",
    "status.cooldown": "Repariert",
    "status.escalated": "Eskaliert",
    "status.snoozed": "Schlummert bis {time}",
    "status.snoozed_open": "Schlummert",
    "status.until": "bis {time}",
    "status.unavailable": "Nicht verfügbar",
    "hb.suspect": "Lebenszeichen überfällig",
    "hb.suspect_fail": "Fehler gemeldet",
    "hb.blind": "Wartet auf das erste Lebenszeichen",
    "hb.recovering": "Reparatur läuft …",
    "hb.verify": "Wartet auf Lebenszeichen …",
    "value.last_heartbeat": "Letztes Lebenszeichen",
    "value.expected_every": "erwartet alle {period}",
    "value.never": "Noch nie",
    "value.for": "seit {duration}",
    "value.for_hint": "Zeit in diesem Zustand, gezählt ab der letzten Änderung (ein Neustart oder Neuladen von Home Assistant setzt sie zurück)",
    "value.state_for": "{state} seit {duration}",
    "event.recovered": "Reparatur erfolgreich",
    "event.escalated": "Eskaliert",
    "event.blocked": "Reparatur blockiert",
    "event.attempts_one": "{n} Versuch",
    "event.attempts_other": "{n} Versuche",
    "rel.now": "gerade eben",
    "rel.past": "vor {v}",
    "rel.future": "in {v}",
    "unit.s": "Sek.",
    "unit.min": "Min.",
    "unit.h": "Std.",
    "unit.d": "Tg.",
    "action.revive": "Reparieren",
    "action.revive_wake": "Reparieren (beendet das Schlummern)",
    "action.reset": "Zurücksetzen",
    "action.snooze": "Schlummern",
    "action.unsnooze": "Aufwecken",
    "action.ping": "Lebenszeichen setzen",
    "action.auto_on": "Auto-Reparatur einschalten",
    "action.auto_off": "Auto-Reparatur ausschalten",
    "action.check": "Jetzt prüfen",
    "action.url": "Lebenszeichen-URL kopieren",
    "action.edit": "Bearbeiten",
    "action.details": "Details",
    "action.more": "Aktionen",
    "action.sure": "Sicher?",
    "snooze.1800": "30 Minuten",
    "snooze.3600": "1 Stunde",
    "snooze.14400": "4 Stunden",
    "snooze.86400": "1 Tag",
    "chip.health": "Health",
    "chip.actor": "Reparatur",
    "chip.auto_off": "Auto-Reparatur ist aus — tippen zum Einschalten",
    "chip.auto_confirm": "Nochmal tippen, um die Auto-Reparatur einzuschalten",
    "chip.snoozed": "Schlummert — tippen zum Aufwecken",
    "chip.recovered": "Reparaturen",
    "chip.failed": "Fehlschläge",
    "chip.count": "{title}: {n}",
    "health.ok": "Gesund",
    "health.unhealthy": "Gestört",
    "health.unknown": "Unbekannt",
    "toast.health": "{name}: {health}",
    "toast.copied": "Lebenszeichen-URL kopiert",
    "toast.copy_failed": "Lebenszeichen-URL konnte nicht kopiert werden",
    "toast.no_url": "Keine Lebenszeichen-URL verfügbar",
    "toast.snoozed": "{name} schlummert für {duration}",
    "toast.done": "{name}: {action}",
    "error.entity": "Entität fehlt: `entity` muss ein Necromancer-Status-Sensor sein",
    "error.not_found": "Entität nicht gefunden: {entity}",
    "state.ok": "Gesund",
    "state.suspect": "Verdacht",
    "state.blind": "Blind",
    "state.recovering": "Reparatur läuft",
    "state.verify": "Prüfung",
    "state.cooldown": "Repariert",
    "state.escalated": "Eskaliert",
    "state.snoozed": "Schlummert",
    "state.unavailable": "Nicht verfügbar",
    "type.heartbeat": "Lebenszeichen",
    "type.recovery": "Reparatur",
    "type.notify": "Nur benachrichtigen",
    "count.total": "{n} Guards",
    "count.total_one": "{n} Guard",
    "count.problems": "{n} brauchen Aufmerksamkeit",
    "count.problems_one": "{n} braucht Aufmerksamkeit",
    "sort.problems": "Probleme zuerst, dann Name",
    "sort.name": "Name",
    "sort.state": "Zustand",
    "sort.last_activity": "Letzte Aktivität",
    "action.snooze_all": "Wartungsmodus",
    "action.unsnooze_all": "Alle aufwecken",
    "action.repair_poe_port": "Port neu starten",
    "action.edit_ports": "Ports bearbeiten",
    "action.settings": "Einstellungen",
    "action.menu": "Menü",
    "toast.snoozed_all": "Alle Guards schlummern für {duration}",
    "toast.unsnoozed_all": "Alle Guards aufgeweckt",
    "toast.poe_restart": "PoE-Port {port} wird neu gestartet …",
    "toast.settings_failed": "Einstellungen konnten nicht gespeichert werden",
    "tab.guards": "Guards",
    "tab.heartbeat": "Lebenszeichen",
    "tab.poe": "PoE",
    "panel.title": "Necromancer",
    "panel.empty": "Noch keine Guards. Anlegen unter Einstellungen → Geräte & Dienste → Necromancer.",
    "panel.no_match": "Kein Guard passt.",
    "panel.filter_clear": "Alles in Ordnung — gerade passt kein Guard.",
    "settings.title": "Einstellungen",
    "settings.show_counters": "Zähler anzeigen (Reparaturen, Fehlschläge)",
    "settings.show_actions": "Aktionen anzeigen",
    "settings.show_footer": "Letztes Ereignis anzeigen",
    "settings.collapse_ok": "Ruhige Guards einklappen",
    "settings.sort": "Sortierung",
    "settings.start_tab": "Start-Reiter",
    "search.placeholder": "Suchen …",
    "group.quiet": "Ruhig ({n})",
    "poe.status.good": "Bereit",
    "poe.status.recovering": "Startet neu …",
    "poe.status.failed": "Neustart fehlgeschlagen",
    "poe.status.off": "Ausgeschaltet",
    "poe.status.offline": "Gerät offline",
    "poe.status.unknown": "Schalter nicht verfügbar",
    "poe.switch": "Schalter",
    "poe.id_static": "Statisches Label",
    "poe.id_none": "Nichts angeschlossen",
    "poe.id_conflict": "Falsch konfiguriert: Statisches Label und Kennungs-Entität",
    "poe.used_by": "Genutzt von",
    "poe.unused": "Kein Guard",
    "poe.last_cycle": "Letzter Neustart",
    "poe.last_ok": "erfolgreich",
    "poe.last_failed": "fehlgeschlagen",
    "poe.never": "Noch nie",
    "poe.last_known": "zuletzt bekannt",
    "poe.ambiguous": "mehrdeutig",
    "poe.power_on": "Strom an",
    "poe.power_off": "Strom aus",
    "poe.online": "Online",
    "poe.offline": "Offline",
    "poe.empty": "Keine PoE-Ports eingerichtet.",
    "poe.id_live_from": "live über {source}",
    "poe.id_live": "live",
    "poe.id_source_none": "Keine Kennungsquelle",
    "poe.rel.live": "passt",
    "poe.rel.last_known": "zuletzt bekannt",
    "poe.rel.ambiguous": "mehrdeutig",
    "poe.rel.mismatch": "Port meldet eine andere Kennung",
    "poe.rel.elsewhere": "jetzt an einem anderen Port",
    "poe.rel.also_on": "auch an {ports}",
    "poe.rel.reports": "Port meldet {id}",
    "poe.rel.now_on": "jetzt an {ports}",
    "poe.port_n": "Port {n}",
    "poe.expected": "erwartet: {id}",
    "poe.empty_expected": "Nichts angeschlossen · erwartet: {id} (zuletzt bekannt)",
    "poe.id_conflict_from": "Konflikt · Label {id} und {source}",
    "chip.auto_off_short": "Auto aus",
    "event.last_escalation": "Letzte Eskalation {when}",
    "event.last_blocked": "Letzte blockierte Reparatur {when}",
    "rec.title": "Reparatur",
    "rec.chip_title": "Reparatur: {target}",
    "rec.kind.switch": "Schalter",
    "rec.kind.poe_port": "PoE-Port",
    "rec.kind.script": "Skript",
    "rec.kind.action": "Aktion",
    "rec.kind.actions": "Aus-/Ein-Aktionen",
    "rec.kind.notify": "Nur benachrichtigen",
    "rec.notify_only": "Nur benachrichtigen — keine Reparatur",
    "rec.action": "Aktion",
    "rec.action_steps_one": "Aktion (1 Schritt)",
    "rec.action_steps_other": "Aktion ({n} Schritte)",
    "rec.actions_steps_one": "Aus-/Ein-Aktionen (1 Schritt)",
    "rec.actions_steps_other": "Aus-/Ein-Aktionen ({n} Schritte)",
    "rec.poe_on": "{port} an {switch}",
    "rec.poe_for": "PoE-Port für {id}",
    "rec.poe_none": "Kein Port gefunden",
    "rec.poe_ambiguous": "{ports}",
    "rec.or": "oder",
    "rec.device": "Gerät",
    "rec.found.last_known": "zuletzt bekannter Port · gerade nichts angeschlossen",
    "rec.found.ambiguous": "mehrdeutig · Kennung an mehreren Ports",
    "rec.found.mismatch": "Port meldet jetzt {id} · Reparatur blockiert",
    "rec.found.mismatch_plain": "Port meldet eine andere Kennung · Reparatur blockiert",
    "rec.found.none": "kein Port meldet diese Kennung · Reparatur blockiert",
    "rec.loading": "Port wird gesucht …",
    "rec.error": "Port-Abfrage nicht verfügbar",
    "rec.port_status": "Port-Status",
    "rec.status_hidden": "Status nicht sichtbar",
    "rec.last_repair": "Letzte Reparatur",
    "rec.repairs": "Reparaturen",
    "rec.counts": "{ok} erfolgreich · {failed} fehlgeschlagen",
    "rec.auto": "Auto-Reparatur",
    "rec.auto_off_confirm": "Auto-Reparatur ausschalten? Probleme werden dann nur gemeldet.",
    "rec.repair_now": "Jetzt reparieren",
    "rec.busy": "Eine Reparatur läuft …",
    "rec.snoozed": "Schlummert — erst aufwecken",
    "rec.port_busy": "Der Port startet neu …",
    "rec.blocked": "Kein eindeutiger Port — eine Reparatur würde blockiert werden",
    "rec.unavailable": "Guard nicht verfügbar",
  },
};

/** Normalise an HA language ("de-DE", "en_GB") to a table key, falling back to en. */
export function langOf(lang) {
  const base = String(lang || "en")
    .toLowerCase()
    .split(/[-_]/)[0];
  return I18N[base] ? base : "en";
}

/** Translate `key` with `{placeholders}`; unknown keys fall back to en, then the key. */
export function t(lang, key, vars = {}) {
  const table = I18N[langOf(lang)];
  let s = table[key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  // An abbreviation at the end of a value ("30 Min.") meets the sentence's
  // own full stop: one is enough.
  return vars && Object.keys(vars).length ? s.replace(/\.\.(?!\.)/g, ".") : s;
}

/** HTML-escape for text and attribute values built into templates. */
export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---------------------------------------------------------------------------
// Guard detection
// ---------------------------------------------------------------------------

/**
 * Everything the card needs to know about a guard, read from its status sensor
 * alone (design §5 "Typ-Erkennung"): no naming conventions, no registry walks.
 */
export function guardInfo(stateObj) {
  const a = (stateObj && stateObj.attributes) || {};
  const reviveEntity = a.revive_entity || null;
  const rawDriver = a.driver_type || null;
  let driverType = rawDriver ? DRIVER_ALIASES[rawDriver] || rawDriver : null;
  if (!driverType && !reviveEntity && stateObj) driverType = "notify";
  const isHeartbeat = a.health_type === "heartbeat";
  // Notify-only guards have no revive button (and driver type "notify"); a
  // heartbeat guard may still carry a recovery, so `canRecover` is separate.
  const canRecover = Boolean(reviveEntity) && driverType !== "notify";
  const type = isHeartbeat ? "heartbeat" : canRecover ? "recovery" : "notify";
  return {
    type,
    canRecover,
    driverType,
    // `targetEntity` is the static target of any strategy (switch or the one
    // script), `scriptEntity` the script alone.
    targetEntity: a.driver_entity || null,
    scriptEntity: driverType === "action" ? a.driver_entity || null : null,
    // Action steps (off + on for `actions`), a PoE guard's expected id: static
    // config, null where they do not apply.
    driverSteps: a.driver_steps != null && a.driver_steps !== "" && Number.isFinite(Number(a.driver_steps)) ? Number(a.driver_steps) : null,
    expectedId: a.driver_port_expected_id || null,
    statusEntity: (stateObj && stateObj.entity_id) || null,
    healthEntity: a.health_entity || null,
    autoEntity: a.auto_recovery_entity || null,
    reviveEntity,
    eventEntity: a.recovery_event_entity || null,
    lastHeartbeatEntity: a.last_heartbeat_entity || null,
    // The entity a state-based guard watches (and the attribute it judges, null
    // = the state); null for template and heartbeat guards.
    sourceEntity: a.source_entity || null,
    sourceAttribute: a.source_attribute || null,
    name: a.guard_name || a.friendly_name || (stateObj && stateObj.entity_id) || "",
  };
}

/**
 * The first guard's status sensor, for the card picker's stub config: from the
 * entity registry (platform + translation key), else any state that carries the
 * status sensor's attributes. Sorted so the pick is stable.
 */
export function findFirstGuard(hass) {
  const entities = (hass && hass.entities) || {};
  const fromRegistry = Object.keys(entities)
    .filter((id) => entities[id] && entities[id].platform === DOMAIN && entities[id].translation_key === "status")
    .sort();
  if (fromRegistry.length) return fromRegistry[0];
  const states = (hass && hass.states) || {};
  const fromStates = Object.keys(states)
    .filter((id) => {
      const a = states[id] && states[id].attributes;
      return id.startsWith("sensor.") && a && "guard_name" in a && "health_type" in a;
    })
    .sort();
  return fromStates[0] || null;
}

/** Default big icon per guard type (overridden by the `icon` option). */
export function defaultIcon(info) {
  if (info.type === "heartbeat") return "mdi:heart-flash";
  if (info.type === "notify") return "mdi:bell-outline";
  return "mdi:medical-bag";
}

/** Icon of the actor chip (design §4 "Status-Chips"). */
export function actorIcon(driverType) {
  switch (driverType) {
    case "poe_port":
      return "mdi:ethernet";
    case "switch":
      return "mdi:power-plug";
    case "action":
      return "mdi:script-text-play";
    case "actions":
      return "mdi:toggle-switch";
    default:
      return "mdi:wrench";
  }
}

/** Every entity the card reads; a change to any of them triggers a re-render. */
export function relevantEntities(info, config = {}) {
  const ids = [
    info.statusEntity,
    info.healthEntity,
    info.autoEntity,
    info.eventEntity,
    info.lastHeartbeatEntity,
    config.value_entity,
    ...chipEntities(config),
  ];
  return [...new Set(ids.filter(Boolean))];
}

/**
 * The `chips` option normalised to `{entity, icon, name, color}` (a string is
 * just the entity). Entries without an entity are dropped here, together with
 * their spec, so icon and name always stay with their own entity.
 */
export function chipSpecs(config = {}) {
  return (Array.isArray(config.chips) ? config.chips : [])
    .map((c) => (typeof c === "string" ? { entity: c } : c && typeof c === "object" ? c : {}))
    .filter((c) => typeof c.entity === "string" && c.entity)
    .map((c) => ({ entity: c.entity, icon: c.icon || null, name: c.name || null, color: c.color || null }));
}

/** The entity ids of the `chips` option. */
export function chipEntities(config = {}) {
  return chipSpecs(config).map((c) => c.entity);
}

// ---------------------------------------------------------------------------
// Colours and status line
// ---------------------------------------------------------------------------

// The snooze accent (design §4: snoozed = violet), one value for the state
// colour and the snooze chip/tone so a snoozed guard reads the same everywhere.
// HA's --purple-color lets a theme retune it.
export const SNOOZE_COLOR = "var(--purple-color, #8e24aa)";

// Grey for *text* in a quiet or unknown state. --disabled-color is for marks
// only (dots, icons, LEDs): as text it is ~2:1 on a card. HA's
// --secondary-text-color is >= 4.5:1 on its card background in both the light
// (#727272 on #fff) and the dark theme (#9b9b9b on #1c1c1c).
export const SECONDARY_TEXT_COLOR = "var(--secondary-text-color, #727272)";

const STATE_COLORS = {
  ok: "var(--success-color, #43a047)",
  suspect: "var(--warning-color, #fb8c00)",
  blind: "var(--disabled-color, #9e9e9e)",
  recovering: "var(--warning-color, #fb8c00)",
  verify: "var(--info-color, #1e88e5)",
  cooldown: "#26a69a",
  escalated: "var(--error-color, #e53935)",
  snoozed: SNOOZE_COLOR,
};

/**
 * Tone -> CSS colour for marks (icons, chips, dots, tints). For text in a tone
 * use `toneTextColor`: `idle` text must not be drawn in the disabled grey.
 */
export const TONE_COLORS = {
  good: "var(--success-color, #43a047)",
  bad: "var(--error-color, #e53935)",
  warn: "var(--warning-color, #fb8c00)",
  active: "var(--info-color, #1e88e5)",
  idle: "var(--disabled-color, #9e9e9e)",
  snooze: SNOOZE_COLOR,
  // A mark that is neither good nor bad nor off (the recovery actor): the
  // theme's text colour, not the disabled grey that reads as "unavailable".
  neutral: "var(--primary-text-color, #212121)",
};

// Tones and states whose text falls back to the secondary text colour: grey
// (idle/unknown) and violet (snooze) are both below 4.5:1 as text on one of
// the two themes, so they colour only the mark next to the text.
const MUTED_TEXT_TONES = new Set(["idle", "snooze"]);
const MUTED_STATES = new Set(["blind", "snoozed", "unavailable", "unknown"]);

/** CSS colour (HA variable with fallback) for a guard state: icon, dot, chip, tint. */
export function stateColor(state) {
  return STATE_COLORS[state] || STATE_COLORS.blind;
}

/** True for the states drawn muted: blind, snoozed, unavailable/unknown. */
export function isMutedState(state) {
  return MUTED_STATES.has(state) || !(state in STATE_COLORS);
}

/**
 * CSS colour for the *text* of a state (status line, compact value, state
 * label): the state colour, except blind/snoozed/unavailable, which use
 * --secondary-text-color (readable in light and dark) while their dot or icon
 * keeps `stateColor` (grey, violet).
 */
export function stateTextColor(state) {
  return isMutedState(state) ? SECONDARY_TEXT_COLOR : stateColor(state);
}

/** CSS colour for text in a tone (`idle` and `snooze` -> secondary text colour). */
export function toneTextColor(tone) {
  if (!tone || MUTED_TEXT_TONES.has(tone) || !TONE_COLORS[tone]) return SECONDARY_TEXT_COLOR;
  return TONE_COLORS[tone];
}

/** States whose icon pulses slowly (something is happening right now). */
export function isBusy(state) {
  return state === "recovering" || state === "verify";
}

/**
 * Clock time for "Snoozed until 14:30"; adds the weekday when not today.
 * `timeFormat` is HA's profile setting (`hass.locale.time_format`): "12", "24",
 * or anything else for the language's own convention.
 */
export function formatClock(value, now, lang, timeZone, timeFormat) {
  const d = toDate(value);
  if (!d) return "";
  let cycle = { 12: "h12", 24: "h23" }[timeFormat];
  cycle = cycle || new Intl.DateTimeFormat(langOf(lang), { hour: "numeric" }).resolvedOptions().hourCycle;
  const h24 = cycle === "h23" || cycle === "h24";
  // "14:30" / "08:05" on a 24 h clock, "2:30 PM" on a 12 h one.
  const opts = { hour: h24 ? "2-digit" : "numeric", minute: "2-digit", hourCycle: h24 ? "h23" : "h12" };
  if (timeZone) opts.timeZone = timeZone;
  const day = (x) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(x);
  const n = toDate(now) || new Date();
  if (day(d) !== day(n)) opts.weekday = "short";
  return new Intl.DateTimeFormat(langOf(lang), opts).format(d);
}

/**
 * The time zone the cards show clock times in, from the user's profile: the
 * server's zone (HA's default, `hass.locale.time_zone` "server") or, with
 * "local", the browser's (undefined = Intl's default).
 */
export function hassTimeZone(hass) {
  const loc = (hass && hass.locale) || {};
  if (loc.time_zone === "local") return undefined;
  return (hass && hass.config && hass.config.time_zone) || undefined;
}

/**
 * Short snooze end for narrow rows: "until 03:58" today, "until Mon 03:58"
 * within a week, "until Nov 30" beyond (de: "bis 03:58", "bis Mo 03:58",
 * "bis 30. Nov."). Same clock rules as `formatClock`; the weekday loses its
 * dot ("Mo." -> "Mo"). "" when `value` is absent or invalid.
 */
export function formatUntil(value, now, lang, timeZone, timeFormat) {
  const d = toDate(value);
  if (!d) return "";
  const n = toDate(now) || new Date();
  const l = langOf(lang);
  const zone = timeZone ? { timeZone } : {};
  const dayKey = (x) => new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(x);
  let when;
  if (d.getTime() - n.getTime() > 6 * 86400000) {
    when = new Intl.DateTimeFormat(l, { ...zone, month: "short", day: "numeric" }).format(d);
  } else {
    // Clock only (today's date pinned as "now"), then the weekday in front.
    const clock = formatClock(d, d, l, timeZone, timeFormat);
    if (dayKey(d) === dayKey(n)) when = clock;
    else {
      const wd = new Intl.DateTimeFormat(l, { ...zone, weekday: "short" }).format(d).replace(/\.$/, "");
      when = `${wd} ${clock}`;
    }
  }
  return t(lang, "status.until", { time: when });
}

/**
 * The "● status" line under the name, worded per guard type (design §4 table).
 * `opts.now` / `opts.timeZone` / `opts.timeFormat` only matter for the snooze end.
 */
export function statusLine(info, state, attrs = {}, lang = "en", opts = {}) {
  if (!(state in STATE_COLORS)) return t(lang, "status.unavailable");
  if (state === "snoozed") {
    const time = formatClock(attrs.snooze_until, opts.now, lang, opts.timeZone, opts.timeFormat);
    return time ? t(lang, "status.snoozed", { time }) : t(lang, "status.snoozed_open");
  }
  if (info.type === "heartbeat") {
    if (state === "suspect" && attrs.last_status === "fail") return t(lang, "hb.suspect_fail");
    if (["suspect", "blind", "recovering", "verify"].includes(state)) return t(lang, `hb.${state}`);
  }
  return t(lang, `status.${state}`);
}

// ---------------------------------------------------------------------------
// Time formatting (compact, deterministic; no Intl.RelativeTimeFormat on purpose)
// ---------------------------------------------------------------------------

/** Date from a Date, epoch ms or ISO string; null when absent or invalid. */
export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== "string" || UNAVAILABLE.has(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compact duration: "45 s", "5 min", "1 h 30 min", "3 d 4 h" (at most two units).
 * `opts.seconds: false` drops the seconds from a minute on ("1 min", not
 * "1 min 5 s"), for a value that only ticks once a minute.
 */
export function formatDuration(seconds, lang = "en", opts = {}) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "–";
  let s = Math.max(0, Math.floor(Number(seconds)));
  if (opts.seconds === false && s >= 60) s -= s % 60;
  const units = [
    ["d", 86400],
    ["h", 3600],
    ["min", 60],
    ["s", 1],
  ];
  const parts = [];
  for (const [u, size] of units) {
    const n = Math.floor(s / size);
    if (n > 0 || (parts.length === 0 && u === "s")) {
      parts.push(`${n} ${t(lang, `unit.${u}`)}`);
      s -= n * size;
    } else if (parts.length) {
      break; // the second unit must be adjacent: "1 d 5 min" reads oddly
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** Single-unit age for relative times: "2 s", "6 min", "6 h", "3 d". */
function shortSpan(seconds, lang) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s} ${t(lang, "unit.s")}`;
  if (s < 3600) return `${Math.floor(s / 60)} ${t(lang, "unit.min")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} ${t(lang, "unit.h")}`;
  return `${Math.floor(s / 86400)} ${t(lang, "unit.d")}`;
}

/**
 * Relative time: "2 s ago" / "vor 2 s", "in 5 min", "just now" within a second
 * (and for small clock skew into the future). Invalid input gives "–".
 */
export function formatRelative(value, now, lang = "en") {
  const d = toDate(value);
  const n = toDate(now);
  if (!d || !n) return "–";
  const diff = (n.getTime() - d.getTime()) / 1000;
  if (diff > -5 && diff < 1) return t(lang, "rel.now");
  if (diff >= 1) return t(lang, "rel.past", { v: shortSpan(diff, lang) });
  return t(lang, "rel.future", { v: shortSpan(-diff, lang) });
}

/**
 * Milliseconds until the next shown age changes its text: ages under a minute
 * show seconds, older ones whole minutes (or coarser), so the tick lands on the
 * youngest age's next boundary. Null when there is nothing to tick.
 */
export function nextTickMs(ages) {
  let best = null;
  for (const age of ages || []) {
    if (age == null || !Number.isFinite(age) || age < 0) continue;
    const ms = age * 1000;
    const step = ms < 60000 ? 1000 : 60000;
    const wait = step - (ms % step);
    if (best === null || wait < best) best = wait;
  }
  return best === null ? null : Math.max(250, Math.ceil(best) + 20);
}

/** Seconds since `value` (null when unknown) — the card ticks faster when small. */
export function ageSeconds(value, now) {
  const d = toDate(value);
  const n = toDate(now);
  return d && n ? (n.getTime() - d.getTime()) / 1000 : null;
}

// ---------------------------------------------------------------------------
// Main value and footer
// ---------------------------------------------------------------------------

function formatState(stateObj, hass, lang) {
  if (!stateObj || UNAVAILABLE.has(stateObj.state)) return "–";
  const unit = stateObj.attributes && stateObj.attributes.unit_of_measurement;
  let v = stateObj.state;
  const num = Number(v);
  if (v.trim() !== "" && Number.isFinite(num)) {
    const reg = hass && hass.entities && hass.entities[stateObj.entity_id];
    const precision = reg && Number.isInteger(reg.display_precision) ? reg.display_precision : null;
    const fmt =
      precision == null
        ? { maximumFractionDigits: 2 }
        : { minimumFractionDigits: precision, maximumFractionDigits: precision };
    v = new Intl.NumberFormat(langOf(lang), fmt).format(num);
  }
  return unit ? `${v} ${unit}` : v;
}

// Languages HA writes "50 %" in (blankBeforePercent in HA's frontend); the
// rest write "50%". Before "°" there is never a blank.
const PERCENT_BLANK = new Set(["cs", "de", "fi", "fr", "sk", "sv"]);

/**
 * The locale HA formats numbers in, from the user's `number_format` profile
 * setting: false = "none" (the raw string), undefined = the browser's.
 */
function numberLocale(hass, lang) {
  const loc = (hass && hass.locale) || {};
  const language = loc.language || langOf(lang);
  switch (loc.number_format) {
    case "none":
      return false;
    case "system":
      return undefined;
    case "comma_decimal":
      return ["en-US", "en"];
    case "decimal_comma":
      return ["de", "es", "it"];
    case "space_comma":
      return ["fr", "sv", "cs"];
    default:
      return language;
  }
}

/** Is `v` a plain number ("200", "-3.5", 4) and not "", "on" or "0x1f"? */
function numeric(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string" || v.trim() === "") return false;
  return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v);
}

/**
 * An entity's state (or one of its attributes) as HA shows it, split for the
 * cards: `{text, number, unit}`. `text` is "200 W" / "1.234,5 W" / "50 %"
 * (de) / "21,5°"; `number` is null for a non-numeric or unavailable value
 * ("on", "running", "unavailable" -> text as is, "–" when unavailable). Like
 * HA: the entity's `display_precision` wins, else a numeric string keeps its
 * own decimals ("529.0" -> "529.0") unless a whole `step` and a whole value
 * say otherwise (input_number "200.0" -> "200"); an attribute has no unit.
 */
export function entityValue(stateObj, hass, lang = "en", attribute = null) {
  if (!stateObj) return { text: "–", number: null, unit: null };
  const attrs = stateObj.attributes || {};
  const raw = attribute ? attrs[attribute] : stateObj.state;
  if (raw == null || (!attribute && UNAVAILABLE.has(raw))) return { text: "–", number: null, unit: null };
  const unit = attribute ? null : attrs.unit_of_measurement || null;
  if (!numeric(raw)) {
    const text = String(raw);
    return { text: unit && text ? `${text} ${unit}` : text || "–", number: null, unit };
  }
  const num = Number(raw);
  const locale = numberLocale(hass, lang);
  let v;
  if (locale === false) v = String(raw).trim();
  else {
    const reg = hass && hass.entities && hass.entities[stateObj.entity_id];
    const precision = !attribute && reg && Number.isInteger(reg.display_precision) ? reg.display_precision : null;
    let fmt;
    if (precision != null) fmt = { minimumFractionDigits: precision, maximumFractionDigits: precision };
    // Like HA: an input_number/number with a whole step and a whole value
    // shows no decimals ("200.0" -> "200").
    else if (!attribute && attrs.step != null && Number.isInteger(Number(attrs.step)) && Number.isInteger(num)) {
      fmt = { maximumFractionDigits: 0 };
    } else if (typeof raw === "string") {
      const m = raw.trim().match(/\.(\d+)$/);
      const digits = m ? m[1].length : 0;
      fmt = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    } else fmt = { maximumFractionDigits: 2 };
    v = new Intl.NumberFormat(locale, fmt).format(num);
  }
  if (!unit) return { text: v, number: num, unit: null };
  const language = ((hass && hass.locale && hass.locale.language) || langOf(lang)).split(/[-_]/)[0];
  const blank = unit === "°" ? "" : unit === "%" ? (PERCENT_BLANK.has(language) ? " " : "") : " ";
  return { text: `${v}${blank}${unit}`, number: num, unit };
}

/**
 * The big bold value plus its faint caption (design §4 "Hauptwert").
 * Returns `{value, caption, late, age}`: `late` paints it red, `age` (seconds
 * since the shown time, or null) lets the card tick faster while it is fresh.
 *
 * `opts.rich` (opt-in; the cards) adds the guard's own value: without a
 * `value_entity`, a state-based guard whose watched entity (`source_entity`,
 * or its `source_attribute`) is numeric shows that value ("200 W") with the
 * caption "<State> for <duration>" ("Healthy for 19 min" / "Gesund seit 19
 * min"); on/off, text and unavailable values and template guards keep "for 19
 * min", heartbeat guards "1 h ago". Numbers are formatted like HA (see
 * entityValue), also for `value_entity`. The result then also carries `kind`
 * ("custom" | "heartbeat" | "source" | "duration"), `entity` (what a click on
 * the value opens, or null), `number` / `unit` (null unless numeric),
 * `stateWord` (the short state name, "source" only) and `duration` (the time
 * in state as text, "source" and "duration"; null otherwise). With `rich`,
 * `opts.since` (Date, ISO string or epoch ms) is when the guard really entered
 * its state (the cards take it from `escalated_at` or the 24 h history):
 * HA's `last_changed` starts again at every restart, so a card would say "for
 * 14 min" next to an escalation chip from 12:11. Ignored when unknown.
 */
export function mainValue(info, hass, config = {}, now = Date.now(), lang = "en", opts = {}) {
  const states = (hass && hass.states) || {};
  const status = states[info.statusEntity];
  const state = status ? status.state : "unavailable";
  if (opts && opts.rich) return richMainValue(info, hass, config, now, lang, status, state, opts.since);
  if (config.value_entity) {
    const so = states[config.value_entity];
    const caption =
      config.value_name ||
      (so && so.attributes && so.attributes.friendly_name) ||
      config.value_entity;
    return { value: formatState(so, hass, lang), caption, title: caption, late: false, age: null };
  }
  if (info.type === "heartbeat") {
    const hb = states[info.lastHeartbeatEntity];
    const ha = (hb && hb.attributes) || {};
    const last = hb ? toDate(hb.state) : null;
    const due = toDate(ha.next_due);
    const failed = Boolean(status && status.attributes && status.attributes.last_status === "fail");
    // Without a deadline (sensor disabled or unavailable) the status still
    // knows: a heartbeat guard is only SUSPECT when overdue or failed.
    const overdue = due !== null ? toDate(now).getTime() > due.getTime() : state === "suspect";
    const late = state === "escalated" || failed || overdue;
    let caption = t(lang, "value.last_heartbeat");
    if (Number(ha.period) > 0) {
      caption += ` · ${t(lang, "value.expected_every", { period: formatDuration(ha.period, lang) })}`;
    }
    // "Never" only when the sensor itself says so (state unknown = no ping
    // yet); a disabled (absent) or unavailable sensor does not know: "–".
    let value = "–";
    if (last) value = formatRelative(last, now, lang);
    else if (hb && hb.state === "unknown") value = t(lang, "value.never");
    return { value, caption, title: caption, late, age: last ? ageSeconds(last, now) : null };
  }
  // Design §4: the time in the current state ("for 3 d"), no caption. HA resets
  // last_changed on a restart or reload, which the tooltip says.
  const since = status && (status.last_changed || status.last_updated);
  const age = ageSeconds(since, now);
  return {
    value: age == null ? "–" : t(lang, "value.for", { duration: formatDuration(Math.max(0, age), lang, { seconds: false }) }),
    caption: "",
    title: t(lang, "value.for_hint"),
    late: false,
    age,
  };
}

function richMainValue(info, hass, config, now, lang, status, state, sinceOpt) {
  const states = (hass && hass.states) || {};
  const extra = { number: null, unit: null, stateWord: null, duration: null };
  if (config.value_entity) {
    const so = states[config.value_entity];
    const caption =
      config.value_name ||
      (so && so.attributes && so.attributes.friendly_name) ||
      config.value_entity;
    const v = entityValue(so, hass, lang);
    return { value: v.text, caption, title: caption, late: false, age: null, kind: "custom", entity: config.value_entity, ...extra, number: v.number, unit: v.unit };
  }
  if (info.type === "heartbeat") {
    const mv = mainValue(info, hass, config, now, lang);
    return { ...mv, kind: "heartbeat", entity: info.lastHeartbeatEntity || null, ...extra };
  }
  const since = (sinceOpt != null && toDate(sinceOpt)) || (status && (status.last_changed || status.last_updated));
  const age = ageSeconds(since, now);
  const duration = age == null ? null : formatDuration(Math.max(0, age), lang, { seconds: false });
  const src = info.sourceEntity ? states[info.sourceEntity] : null;
  const known = status && state in STATE_COLORS;
  const v = src && known ? entityValue(src, hass, lang, info.sourceAttribute) : null;
  if (v && v.number !== null) {
    const stateWord = t(lang, `state.${state}`);
    const caption = duration ? t(lang, "value.state_for", { state: stateWord, duration }) : stateWord;
    const name = (src.attributes && src.attributes.friendly_name) || info.sourceEntity;
    const title = `${info.sourceAttribute ? `${name} · ${info.sourceAttribute}` : name}\n${t(lang, "value.for_hint")}`;
    return { value: v.text, caption, title, late: false, age, kind: "source", entity: info.sourceEntity, number: v.number, unit: v.unit, stateWord, duration };
  }
  return {
    value: duration == null ? "–" : t(lang, "value.for", { duration }),
    caption: "",
    title: t(lang, "value.for_hint"),
    late: false,
    age,
    kind: "duration",
    entity: null,
    ...extra,
    duration,
  };
}

/**
 * The footer's last event (design §4 "Fußzeile"). Returns `{icon, tone, text, age}`,
 * or null when there is nothing to report: then the card hides the event slot
 * (no bell, no dash) and the action pills stand alone.
 *
 * `opts.past` (opt-in; the cards): an escalation or blocked repair from
 * before the guard entered its current state (and the guard is not escalated
 * now) is history, not news: worded "Last escalation 150 d ago · 2 attempts" /
 * "Letzte Eskalation vor 150 Tg. · 2 Versuche" in the muted `idle` tone, with
 * `past: true`. The state start is `attrs.state_since`, else the status
 * sensor's `last_changed`.
 */
export function footerEvent(info, states = {}, attrs = {}, now = Date.now(), lang = "en", opts = {}) {
  const status = states[info.statusEntity];
  const state = status ? status.state : null;
  const ev = info.eventEntity ? states[info.eventEntity] : null;
  const evAttrs = (ev && ev.attributes) || {};
  const at = ev ? toDate(ev.state) : null;
  const type = evAttrs.event_type;
  // An escalation through the policy gate (auto-recovery off, notify-only) fires
  // no event, so the event entity still holds an older one (restored across
  // restarts too). While escalated with a reason, any event from before the
  // guard entered the state is stale and must not hide that reason. A real
  // give-up/block fires right after the state write, so it is never older
  // (the slack covers the two writes' timestamps).
  const entered = status ? toDate(status.last_changed) : null;
  const staleForEscalation =
    state === "escalated" &&
    Boolean(attrs.health_detail) &&
    (type === "recovered" || (at && entered && at.getTime() < entered.getTime() - 2000));
  if (at && type && !staleForEscalation) {
    const when = formatRelative(at, now, lang);
    const age = ageSeconds(at, now);
    if (opts && opts.past && state !== "escalated" && (type === "escalated" || type === "blocked")) {
      const start = toDate(attrs.state_since) || entered;
      if (start && at.getTime() < start.getTime() - 2000) return pastEvent(type, evAttrs, when, age, lang);
    }
    if (type === "recovered") {
      return { icon: "mdi:check-circle", tone: "good", text: `${t(lang, "event.recovered")} · ${when}`, age };
    }
    if (type === "escalated") {
      const parts = [t(lang, "event.escalated")];
      const n = Number(evAttrs.attempt);
      if (n > 0) parts.push(t(lang, n === 1 ? "event.attempts_one" : "event.attempts_other", { n }));
      parts.push(when);
      return { icon: "mdi:close-octagon", tone: "bad", text: parts.join(" · "), age };
    }
    if (type === "blocked") {
      const reason = evAttrs.reason ? `: ${evAttrs.reason}` : "";
      return { icon: "mdi:cancel", tone: "bad", text: `${t(lang, "event.blocked")}${reason} · ${when}`, age };
    }
  }
  if (state === "escalated" && attrs.health_detail) {
    return { icon: "mdi:alert", tone: "warn", text: String(attrs.health_detail), age: null };
  }
  return null;
}

/** An escalation / blocked repair from before the current state, as history. */
function pastEvent(type, evAttrs, when, age, lang) {
  if (type === "blocked") {
    return { icon: "mdi:cancel", tone: "idle", text: t(lang, "event.last_blocked", { when }), age, past: true };
  }
  const parts = [t(lang, "event.last_escalation", { when })];
  const n = Number(evAttrs.attempt);
  if (n > 0) parts.push(t(lang, n === 1 ? "event.attempts_one" : "event.attempts_other", { n }));
  return { icon: "mdi:close-octagon", tone: "idle", text: parts.join(" · "), age, past: true };
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** Tone of the health chip: green on, red off, grey unknown. */
export function healthTone(stateObj) {
  if (!stateObj) return "idle";
  if (stateObj.state === "on") return "good";
  if (stateObj.state === "off") return "bad";
  return "idle";
}

// Binary sensor classes whose "on" reports a problem (HA shows them as alerts).
const ON_IS_BAD = new Set([
  "battery",
  "carbon_monoxide",
  "cold",
  "gas",
  "heat",
  "moisture",
  "problem",
  "safety",
  "smoke",
  "tamper",
]);

/**
 * Tone of an extra chip from its entity state, after the chip colour rule
 * (green good, red faulty, blue active, grey unknown/idle): `on` is good, or
 * bad for a problem-type binary sensor; any other state is idle.
 */
export function entityTone(stateObj) {
  if (!stateObj || UNAVAILABLE.has(stateObj.state)) return "idle";
  const a = stateObj.attributes || {};
  const isBinary = String(stateObj.entity_id || "").startsWith("binary_sensor.");
  if (stateObj.state === "on") return isBinary && ON_IS_BAD.has(a.device_class) ? "bad" : "good";
  return "idle";
}

/**
 * CSS colour of a configured chip `color`: a tone name (good, bad, warn,
 * active, idle, snooze), an HA colour name ("red", "light-blue" ->
 * `var(--red-color, red)`) or a hex colour; anything else is ignored (null).
 */
export function chipColor(color) {
  if (typeof color !== "string") return null;
  const c = color.trim().toLowerCase();
  if (TONE_COLORS[c]) return TONE_COLORS[c];
  if (/^#[0-9a-f]{3,8}$/.test(c)) return c;
  if (/^[a-z]+(-[a-z]+)*$/.test(c)) return `var(--${c}-color, ${c.replace(/-/g, "")})`;
  return null;
}

/** Fallback icon for an extra chip whose entity has none. */
export function entityIcon(stateObj, entityId = "") {
  const icon = stateObj && stateObj.attributes && stateObj.attributes.icon;
  if (icon) return icon;
  const domain = String(entityId).split(".")[0];
  return (
    {
      switch: stateObj && stateObj.state === "off" ? "mdi:toggle-switch-off" : "mdi:toggle-switch",
      binary_sensor: "mdi:checkbox-marked-circle-outline",
      light: "mdi:lightbulb",
      sensor: "mdi:eye",
      button: "mdi:gesture-tap-button",
    }[domain] || "mdi:circle-outline"
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Actions shown as pills: at most two, always in the same places (design §16):
// the state's main move on the left, snooze on the right while it applies.
// Everything else (and never snooze) is in the ⋮ menu; a narrow row shows only
// the main pill and moves snooze into its menu. Auto-recovery is not an
// action here: its chip and the recovery popup handle it.
const BUSY_STATES = new Set(["recovering", "verify"]);
/** The menu's rare entries, after a separator. */
export const MENU_TAIL = new Set(["url", "edit", "details"]);

/** Whether the card option `show_actions` is on (true, "auto", a list) or off (false, "none"). */
export function actionsShown(value) {
  return !(value === false || value === "none");
}

/**
 * The main pill of a guard in `state` (design §16): busy -> none; snoozed ->
 * wake up; escalated -> heartbeat ping (the job, not the guard, needs a sign
 * of life) or reset; a problem -> revive (a repairing guard), ping
 * (heartbeat) or check; healthy -> ping (heartbeat) or check.
 */
function mainAction(info, state, on) {
  if (BUSY_STATES.has(state)) return null;
  const hb = info.type === "heartbeat";
  let pick;
  if (state === "snoozed") pick = ["unsnooze"];
  else if (state === "escalated") pick = hb ? ["ping", "reset"] : ["reset"];
  else if (state === "suspect" || state === "blind") pick = info.canRecover ? ["revive", "ping", "check"] : ["ping", "check"];
  else pick = ["ping", "check"];
  return pick.find((id) => on.includes(id)) || null;
}

/**
 * Which actions a guard offers in `state` and where they go. Returns
 * `{actions, main, second, menu}`: `actions` all that apply (canonical order),
 * `main` the state's main pill (or null), `second` the snooze pill while
 * snooze applies (or null), `menu` the rest in canonical order with the rare
 * entries (MENU_TAIL) last; snooze is never in it (a narrow row adds it).
 * `opts.show` false/"none" -> nothing at all; unknown or unavailable -> only
 * the menu's details (and edit for admins).
 */
export function actionsFor(info, state, attrs = {}, opts = {}) {
  const { isAdmin = false, show = true } = opts;
  if (!actionsShown(show)) return { actions: [], main: null, second: null, menu: [] };
  if (state === "unavailable" || state === "unknown" || !state) {
    const menu = isAdmin ? ["edit", "details"] : ["details"];
    return { actions: menu, main: null, second: null, menu };
  }
  const actions = applicableActions(info, state, isAdmin).filter((id) => id !== "auto");
  const main = mainAction(info, state, actions);
  const second = actions.includes("snooze") ? "snooze" : null;
  const rest = actions.filter((id) => id !== main && id !== "snooze" && id !== "unsnooze");
  const menu = [...rest.filter((id) => !MENU_TAIL.has(id)), ...rest.filter((id) => MENU_TAIL.has(id))];
  return { actions, main, second, menu };
}

/** The actions that apply to a guard in `state`, in canonical order. */
function applicableActions(info, state, isAdmin) {
  const busy = isBusy(state);
  const snoozed = state === "snoozed";
  const hb = info.type === "heartbeat";
  const on = {
    revive: info.canRecover && !busy,
    reset: state === "escalated",
    snooze: !snoozed && !busy,
    unsnooze: snoozed,
    ping: hb && !snoozed,
    auto: info.canRecover && Boolean(info.autoEntity),
    check: true,
    url: hb && isAdmin,
    edit: isAdmin,
    details: true,
  };
  return ACTION_ORDER.filter((id) => on[id]);
}


/** Icon of an action button. */
export function actionIcon(id, autoOn) {
  return (
    {
      revive: "mdi:flash",
      reset: "mdi:restore",
      snooze: "mdi:sleep",
      unsnooze: "mdi:alarm",
      ping: "mdi:heart-plus",
      auto: autoOn ? "mdi:robot-off" : "mdi:robot",
      check: "mdi:magnify",
      url: "mdi:link-variant",
      edit: "mdi:pencil",
      details: "mdi:information-outline",
    }[id] || "mdi:dots-horizontal"
  );
}

/** Label of an action button. */
export function actionLabel(id, lang, autoOn) {
  if (id === "auto") return t(lang, autoOn ? "action.auto_off" : "action.auto_on");
  return t(lang, `action.${id}`);
}

/**
 * The service call behind an action, as `[domain, service, data, target]`, or
 * null for actions that are not a plain call (snooze menu, url, edit, details).
 */
export function serviceFor(id, info, { autoOn = false, duration } = {}) {
  const target = { entity_id: info.statusEntity };
  switch (id) {
    case "revive":
      return ["button", "press", {}, { entity_id: info.reviveEntity }];
    case "reset":
      return [DOMAIN, "reset", {}, target];
    case "snooze":
      return duration ? [DOMAIN, "snooze", { duration }, target] : null;
    case "unsnooze":
      return [DOMAIN, "unsnooze", {}, target];
    case "ping":
      return [DOMAIN, "heartbeat_ping", {}, target];
    case "auto":
      return ["switch", autoOn ? "turn_off" : "turn_on", {}, { entity_id: info.autoEntity }];
    case "check":
      return [DOMAIN, "check_health", { guard: info.statusEntity }, undefined];
    default:
      return null;
  }
}

/** Absolute ping URL from the `heartbeat_url` response; never logged or shown. */
export function resolvePingUrl(response, origin) {
  const r = response || {};
  if (r.url) return r.url;
  if (r.path && origin) return `${String(origin).replace(/\/$/, "")}${r.path}`;
  return null;
}

// ---------------------------------------------------------------------------
// Guard lists: discovery, filter, sort, counts (guards card, PoE card, panel)
// ---------------------------------------------------------------------------

/** Every guard state, in the order the count chips show them. */
export const GUARD_STATES = ["escalated", "suspect", "recovering", "verify", "blind", "snoozed", "cooldown", "ok"];
export const GUARD_TYPES = ["heartbeat", "recovery", "notify"];
/** Sort modes of the guards card (design §6); `problems` is the decided default (§16.4). */
export const SORT_MODES = ["problems", "name", "state", "last_activity"];

// Severity, most urgent first. ok and cooldown share a rank: both are quiet.
const STATE_RANK = {
  escalated: 0,
  suspect: 1,
  recovering: 2,
  verify: 3,
  blind: 4,
  unavailable: 5,
  snoozed: 6,
  cooldown: 7,
  ok: 7,
};

/** A status state as the lists see it: anything unknown counts as unavailable. */
export function normalizeState(state) {
  return state in STATE_RANK ? state : "unavailable";
}

/** Sort rank of a state (0 = most urgent). */
export function stateRank(state) {
  return STATE_RANK[normalizeState(state)];
}

/**
 * "Needs attention" -- the one definition every card, count, headline and the
 * problems-first sort use (design §6 "Kopfzeile"): a guard that is failing or
 * not known to be fine. escalated, suspect, recovering and verify are an open
 * problem; blind has never confirmed its health (e.g. waiting for the first
 * heartbeat); unavailable (also unknown or a missing state) means the guard's
 * status sensor exists but the guard is not running -- its entry failed to
 * load -- so nothing protects that device. (A dormant guard, device disabled,
 * has disabled entities and is not listed at all.)
 * Not counted: ok and cooldown (quiet: the problem is solved) and snoozed (the
 * user muted it on purpose; it has its own group). Most urgent first.
 */
export const ATTENTION_STATES = Object.freeze(["escalated", "suspect", "recovering", "verify", "blind", "unavailable"]);
const ATTENTION = new Set(ATTENTION_STATES);

/** True when a guard in `state` needs attention (see ATTENTION_STATES). */
export function needsAttention(state) {
  return ATTENTION.has(normalizeState(state));
}

/** How many of the guards `ids` need attention ("3 need attention"). */
export function attentionCount(ids, hass) {
  const all = (hass && hass.states) || {};
  let n = 0;
  for (const id of ids || []) if (needsAttention(all[id] && all[id].state)) n += 1;
  return n;
}

/** Alias of `needsAttention`, kept for the sort and older callers. */
export function isProblem(state) {
  return needsAttention(state);
}

/** Quiet guards: the ones the guards card collapses into one group. */
export function isQuiet(state) {
  const s = normalizeState(state);
  return s === "ok" || s === "cooldown";
}

/** A registry entry of a guard's status sensor (design §6 "Leistung"). */
export function isGuardEntry(entry) {
  return Boolean(entry) && entry.platform === DOMAIN && entry.translation_key === "status";
}

/**
 * Status sensors of all guards, sorted by entity id. From the entity registry
 * (`hass.entities`); only without a registry (tests, very old frontends) from
 * the states that carry the status attributes.
 */
export function discoverGuards(hass) {
  const entities = (hass && hass.entities) || {};
  const keys = Object.keys(entities);
  if (keys.length) return keys.filter((id) => isGuardEntry(entities[id])).sort();
  const states = (hass && hass.states) || {};
  return Object.keys(states)
    .filter((id) => {
      const a = states[id] && states[id].attributes;
      return id.startsWith("sensor.") && a && "guard_name" in a && "health_type" in a;
    })
    .sort();
}

/**
 * `discoverGuards` memoised on the identity of `hass.entities`: HA hands out a
 * new object only when the entity registry changes, so a state update costs
 * nothing (design §6: no scan over all states on every update).
 */
export function createGuardDiscovery() {
  let seen = null;
  let ids = [];
  return (hass) => {
    const entities = hass && hass.entities;
    if (entities && entities === seen && Object.keys(entities).length) return ids;
    seen = entities || null;
    ids = discoverGuards(hass);
    return ids;
  };
}

/** Display name of a guard from its status sensor. */
export function guardName(id, hass) {
  const so = hass && hass.states && hass.states[id];
  const a = (so && so.attributes) || {};
  return String(a.guard_name || a.friendly_name || id);
}

/** Area id of a guard: its status entity's own area, else its device's. */
export function guardArea(id, hass) {
  const e = hass && hass.entities && hass.entities[id];
  if (!e) return null;
  if (e.area_id) return e.area_id;
  const d = e.device_id && hass.devices ? hass.devices[e.device_id] : null;
  return (d && d.area_id) || null;
}

/** Label ids of a guard: its status entity's plus its device's. */
export function guardLabels(id, hass) {
  const e = hass && hass.entities && hass.entities[id];
  if (!e) return [];
  const d = e.device_id && hass.devices ? hass.devices[e.device_id] : null;
  return [...new Set([...(e.labels || []), ...((d && d.labels) || [])])];
}

/** A config value that may be one item or a list, as a clean list of strings. */
export function toList(value) {
  if (value == null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v != null && v !== "").map(String);
}

const fold = (s) => String(s).trim().toLowerCase();

/** `name` matches one of `wanted` by id or (case-insensitive) display name. */
function matchesNamed(idValue, displayName, wanted) {
  return wanted.some((w) => fold(w) === fold(idValue) || (displayName != null && fold(w) === fold(displayName)));
}

/** The explicit `entities` list of a card config (strings or `{entity}` objects). */
export function configEntities(config = {}) {
  const list = Array.isArray(config && config.entities) ? config.entities : [];
  const ids = list.map((e) => (typeof e === "string" ? e : e && e.entity)).filter((e) => typeof e === "string" && e);
  return [...new Set(ids)];
}

/**
 * Guards a card shows (design §6 "Konfiguration"): the explicit `entities`
 * list, else every discovered guard, narrowed by `filter.states`, `filter.types`
 * (heartbeat | recovery | notify), `filter.area` (id or name, the entity's or
 * its device's) and `filter.label` (id, or name via `hass.labels`). Every filter
 * key takes one value or a list; values within a key are OR, keys are AND.
 *
 * `view` is the temporary narrowing of the header (not the config): `state`
 * (a count chip) and `search` (name or entity id contains it).
 */
export function filterGuards(ids, hass, config = {}, view = {}) {
  const explicit = configEntities(config);
  const list = explicit.length ? explicit : ids || [];
  const f = (config && config.filter) || {};
  const states = toList(f.states).map(normalizeState);
  const types = toList(f.types);
  const areas = toList(f.area ?? f.areas);
  const labels = toList(f.label ?? f.labels);
  const viewState = view.state ? normalizeState(view.state) : null;
  const q = view.search ? fold(view.search) : "";
  const all = (hass && hass.states) || {};
  return list.filter((id) => {
    const so = all[id];
    const state = normalizeState(so && so.state);
    if (states.length && !states.includes(state)) return false;
    if (viewState && state !== viewState) return false;
    if (types.length && !types.includes(guardInfo(so).type)) return false;
    if (areas.length) {
      const area = guardArea(id, hass);
      const entry = area && hass.areas ? hass.areas[area] : null;
      if (!area || !matchesNamed(area, entry && entry.name, areas)) return false;
    }
    if (labels.length) {
      const own = guardLabels(id, hass);
      const names = (hass && hass.labels) || {};
      const hit = own.some((l) => {
        const entry = names[l];
        return matchesNamed(l, entry && (entry.name || entry), labels);
      });
      if (!hit) return false;
    }
    if (q && !fold(guardName(id, hass)).includes(q) && !fold(id).includes(q)) return false;
    return true;
  });
}

/**
 * True when a card config shows all guards: no explicit list and no filter.
 * Bulk actions (`snooze_all` / `unsnooze_all`) only then (design §6, decided):
 * they act on every guard, visible or not.
 */
export function isUnfiltered(config = {}) {
  if (!config) return true;
  if (configEntities(config).length) return false;
  const f = config.filter;
  if (!f || typeof f !== "object") return true;
  return ["states", "types", "area", "areas", "label", "labels"].every((k) => toList(f[k]).length === 0);
}

/**
 * Most recent activity of a guard in epoch ms (state change, last recovery or
 * failure, last heartbeat), or null when nothing is known.
 */
export function lastActivity(id, hass) {
  const all = (hass && hass.states) || {};
  const so = all[id];
  if (!so) return null;
  const a = so.attributes || {};
  const hb = a.last_heartbeat_entity ? all[a.last_heartbeat_entity] : null;
  let best = null;
  for (const v of [so.last_changed, a.last_recover, a.last_fail, hb && hb.state]) {
    const d = toDate(v);
    if (d && (best === null || d.getTime() > best)) best = d.getTime();
  }
  return best;
}

/**
 * Guards in display order. `problems` (default, decided): guards that need
 * attention first, most urgent state first, then by name; all others (quiet
 * and snoozed) by name. `name`: by name. `state`: by state rank, then name.
 * `last_activity`: newest first, then name. Names compare numerically
 * ("Bulk 2" before "Bulk 10") and stably (entity id breaks ties).
 */
export function sortGuards(ids, hass, mode = "problems", lang = "en") {
  const collator = new Intl.Collator(langOf(lang), { sensitivity: "base", numeric: true });
  const all = (hass && hass.states) || {};
  const rows = (ids || []).map((id) => {
    const state = normalizeState(all[id] && all[id].state);
    return {
      id,
      name: guardName(id, hass),
      rank: stateRank(state),
      problem: isProblem(state),
      act: mode === "last_activity" ? lastActivity(id, hass) : null,
    };
  });
  const byName = (a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let cmp;
  if (mode === "name") cmp = byName;
  else if (mode === "state") cmp = (a, b) => a.rank - b.rank || byName(a, b);
  else if (mode === "last_activity") cmp = (a, b) => (b.act ?? -Infinity) - (a.act ?? -Infinity) || byName(a, b);
  else cmp = (a, b) => Number(b.problem) - Number(a.problem) || (a.problem ? a.rank - b.rank : 0) || byName(a, b);
  return rows.sort(cmp).map((r) => r.id);
}

/**
 * Count of guards per state, plus `total` and `attention` (= `problems`, kept
 * as an alias): guards that need attention, as `attentionCount` counts them.
 * Unknown states count as `unavailable`.
 */
export function countByState(ids, hass) {
  const counts = { total: 0, attention: 0, problems: 0, unavailable: 0 };
  for (const s of GUARD_STATES) counts[s] = 0;
  const all = (hass && hass.states) || {};
  for (const id of ids || []) {
    const state = normalizeState(all[id] && all[id].state);
    counts[state] += 1;
    counts.total += 1;
    if (needsAttention(state)) counts.attention += 1;
  }
  counts.problems = counts.attention;
  return counts;
}

// ---------------------------------------------------------------------------
// PoE ports (from the WS command necromancer/poe/ports)
// ---------------------------------------------------------------------------

// Values a port reports when nothing is connected (same set as core/poe.py).
const NO_ID = new Set(["", "-", "unknown", "unavailable", "none"]);

/** A port id as the fabric compares it, or null for "nothing connected". */
export function normalizePortId(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return NO_ID.has(s) ? null : s;
}

/**
 * A port id for display: a MAC in any usual spelling ("3c22fb123456",
 * "3c-22-fb-12-34-56", "3c22.fb12.3456") as "3C:22:FB:12:34:56", any other id
 * trimmed as is; null for "nothing connected". Display only: the fabric
 * compares normalizePortId, which does not merge MAC spellings.
 */
export function formatPortId(value) {
  if (normalizePortId(value) === null) return null;
  const s = String(value).trim();
  const hex = /^[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i.test(s) || /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(s) || /^[0-9a-f]{12}$/i.test(s);
  if (!hex) return s;
  const digits = s.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return digits.match(/.{2}/g).join(":");
}

/**
 * How each guard on a port relates to it, from the live ids of all ports
 * (`norms`: port index -> normalised id). `live` = only this port reports the
 * guard's id now, `ambiguous` = several do, `last_known` = no port does and
 * this one reports nothing (the fabric's cache points here), `mismatch` = the
 * cache points here but the port now reports another id (the fabric would
 * refuse the restart), `elsewhere` = the id turned up live on another port
 * since the payload was read (until the next load moves the guard there).
 */
function guardRelation(expectedNorm, index, norms) {
  const hits = expectedNorm ? norms.reduce((acc, n, i) => (n === expectedNorm ? [...acc, i] : acc), []) : [];
  if (hits.includes(index)) return hits.length > 1 ? "ambiguous" : "live";
  if (norms[index]) return "mismatch";
  return hits.length ? "elsewhere" : "last_known";
}

/** "Port 23" for a bare number, the configured label otherwise. */
export function portDisplayName(label, lang = "en") {
  const l = String(label ?? "").trim();
  return /^\d+$/.test(l) ? t(lang, "poe.port_n", { n: l }) : String(label ?? "");
}

/**
 * The words of a guard's relation to its port: the relation itself, plus
 * where else the id shows up ("ambiguous · also on Port 25", "now on Port 5")
 * and, for a mismatch, what the port reports instead ("port reports
 * B8:27:EB:…", "· now on Port 5" when the expected id is live elsewhere).
 */
function relationWords(relation, others, reported, lang) {
  const ports = others.join(", ");
  if (relation === "ambiguous") return others.length ? `${t(lang, "poe.rel.ambiguous")} · ${t(lang, "poe.rel.also_on", { ports })}` : t(lang, "poe.rel.ambiguous");
  if (relation === "elsewhere") return others.length ? t(lang, "poe.rel.now_on", { ports }) : t(lang, "poe.rel.elsewhere");
  if (relation === "mismatch") {
    const head = reported ? t(lang, "poe.rel.reports", { id: reported }) : t(lang, "poe.rel.mismatch");
    return others.length ? `${head} · ${t(lang, "poe.rel.now_on", { ports })}` : head;
  }
  return t(lang, `poe.rel.${relation}`);
}

/** Name of the device an entity belongs to (user's name first), or null. */
function deviceName(hass, entityId) {
  const e = entityId && hass && hass.entities ? hass.entities[entityId] : null;
  const d = e && e.device_id && hass.devices ? hass.devices[e.device_id] : null;
  return d ? d.name_by_user || d.name || null : null;
}

function readValue(hass, entityId, attribute) {
  const so = entityId && hass && hass.states ? hass.states[entityId] : null;
  if (!so) return undefined; // unknown here: fall back to the payload's snapshot
  const v = attribute ? (so.attributes || {})[attribute] : so.state;
  return v == null ? null : String(v);
}

/**
 * One status for a PoE port, so a row never says "Ready" next to a red
 * "Power off" (design §7): the fabric's own status wins (a restart running or
 * failed), then the actuator (port powered off, or switch entity unknown),
 * then the connected device's status entity. Returns `{key, tone}`; `tone` is
 * the status line's tone ("idle" = neutral text): only a powered port with
 * nothing wrong is "Ready".
 */
function poeStatus(fabric, power, hasActuator, online) {
  if (fabric === "recovering") return { key: "poe.status.recovering", tone: "active" };
  if (fabric === "failed") return { key: "poe.status.failed", tone: "bad" };
  if (power === "off") return { key: "poe.status.off", tone: "bad" };
  if (hasActuator && power !== "on") return { key: "poe.status.unknown", tone: "idle" };
  if (online === false) return { key: "poe.status.offline", tone: "bad" };
  return { key: "poe.status.good", tone: "idle" };
}

/**
 * Row model of the PoE card from the `necromancer/poe/ports` payload. Live
 * values (actuator, id entity, status entity, guard states) come from `hass`
 * when it has them, so the rows follow state changes without a new WS call;
 * the payload's snapshot fills in otherwise.
 *
 * Row: `{label, actuator, switch (the actuator's friendly name, for the §7
 * "Switch" line; null without an actuator), power ("on"|"off"|null), idSource
 * ("entity"|"static"|"none"|"conflict"), idEntity, idValue, statusEntity,
 * statusState, online (true|false|null by status_on/status_off), fabric
 * ("good"|"recovering"|"failed"), busy, status ({key, tone, label}: the one
 * status line, see poeStatus), tone (the row's mark: status.tone, but "good"
 * for a ready port whose device reports online), lastCycle ({at, ok}|null),
 * guards [{name, statusEntity, state, expectedId, match}], repairId (the id
 * `repair_poe_port` takes, or null), canRepair}`. `lang` words status.label.
 *
 * `opts.mapping` (opt-in; the PoE card) adds where the id comes from and how
 * each guard's expected id relates to the port, re-derived from the live ids
 * of all ports: row `idNorm` (fabric-normalised, null = nothing connected),
 * `idDisplay` (formatPortId), `idOrigin` `{kind: "live"|"fixed"|"conflict"|
 * "none", entity, attribute, entityName, empty, staticId, label}` ("live ·
 * from sensor.sw_p3.mac", also when the entity reports nothing: `empty` is
 * true then and the "Nothing connected" line says the rest; "Fixed id", or for
 * a conflict "conflict · fixed 123 and sensor.sw_p3.mac"), `empty` (an id entity that reports
 * nothing), `emptyExpected` (display ids the cache still expects on an empty
 * port; `emptyLabel` words the first: "Nothing connected · expected: AA:… (last
 * known)") and `mismatch` (a guard points here by cache but the port reports
 * another id); per guard `expectedNorm`, `expectedDisplay`, `relation`
 * ("live"|"ambiguous"|"last_known"|"mismatch"|"elsewhere", see
 * guardRelation), `otherPorts` (names of the other ports that report the
 * expected id now: "Port 25"), `reportedDisplay` (a mismatch: the id this
 * port reports instead) and `relationLabel` ("ambiguous · also on Port 25",
 * "port reports B8:27:EB:… · now on Port 5", "matches", …).
 */
export function poePortRows(payload, hass, lang = "en", opts = {}) {
  const ports = Array.isArray(payload) ? payload : (payload && payload.ports) || [];
  const all = (hass && hass.states) || {};
  const rows = ports.map((p) => {
    const idSource = p.id_source || (p.id_static ? "static" : p.id_entity ? "entity" : "none");
    let idValue = p.id ?? null;
    if (idSource === "static") idValue = p.id_static ?? idValue;
    else if (idSource === "entity") {
      const live = readValue(hass, p.id_entity, p.id_attribute);
      if (live !== undefined) idValue = live;
    } else idValue = null;
    let statusState = readValue(hass, p.status_entity, p.status_attribute);
    if (statusState === undefined) statusState = p.status_state ?? null;
    const on = toList(p.status_on);
    const off = toList(p.status_off);
    const online = statusState == null ? null : on.includes(statusState) ? true : off.includes(statusState) ? false : null;
    const act = p.actuator ? all[p.actuator] : null;
    const actState = act ? act.state : p.actuator_state ?? null;
    const power = actState === "on" || actState === "off" ? actState : null;
    const fabric = p.fabric_status || "good";
    const busy = fabric === "recovering";
    const guards = (p.guards || []).map((g) => {
      const so = g.status_entity ? all[g.status_entity] : null;
      return {
        name: (so && so.attributes && so.attributes.guard_name) || g.name || g.status_entity || "",
        statusEntity: g.status_entity || null,
        state: normalizeState(so && so.state),
        expectedId: g.expected_id || null,
        match: g.match || "live",
      };
    });
    const liveId = normalizePortId(idValue);
    // repair_poe_port resolves by id: the id the port reports now, else the id a
    // guard expects here (its last-known port, e.g. while the device is down).
    const fallback = guards.find((g) => normalizePortId(g.expectedId));
    const repairId = idSource === "conflict" ? null : liveId ? String(idValue).trim() : fallback ? fallback.expectedId : null;
    const last = p.last_cycle && toDate(p.last_cycle.time) ? { at: toDate(p.last_cycle.time), ok: Boolean(p.last_cycle.ok) } : null;
    const st = poeStatus(fabric, power, Boolean(p.actuator), online);
    const status = { key: st.key, tone: st.tone, label: t(lang, st.key) };
    const tone = st.key === "poe.status.good" && online === true ? "good" : st.tone;
    const actAttrs = (act && act.attributes) || {};
    return {
      label: String(p.label ?? ""),
      actuator: p.actuator || null,
      switch: p.actuator ? String(actAttrs.friendly_name || p.actuator_name || p.actuator) : null,
      switchDevice: deviceName(hass, p.actuator),
      power,
      idSource,
      idEntity: p.id_entity || null,
      idStatic: p.id_static == null || p.id_static === "" ? null : String(p.id_static),
      idValue: liveId ? String(idValue) : null,
      statusEntity: p.status_entity || null,
      statusState,
      online,
      fabric,
      busy,
      status,
      tone,
      lastCycle: last,
      guards,
      repairId,
      canRepair: Boolean(repairId) && !busy,
    };
  });
  if (!(opts && opts.mapping)) return rows;
  const norms = rows.map((r) => (r.idSource === "conflict" ? null : normalizePortId(r.idValue)));
  const names = rows.map((r) => portDisplayName(r.label, lang));
  return rows.map((r, i) => withMapping(r, ports[i], i, norms, hass, lang, names));
}

function withMapping(row, p, index, norms, hass, lang, names = []) {
  const idNorm = norms[index];
  const attribute = p.id_attribute || null;
  const so = row.idEntity && hass && hass.states ? hass.states[row.idEntity] : null;
  const entityName = (so && so.attributes && so.attributes.friendly_name) || null;
  const kind = { entity: "live", static: "fixed", conflict: "conflict" }[row.idSource] || "none";
  const source = row.idEntity ? `${row.idEntity}${attribute ? `.${attribute}` : ""}` : "";
  const staticId = kind === "conflict" ? formatPortId(row.idStatic) || row.idStatic : null;
  let label;
  // An empty live port says "live · from …" too (hollow dot via `empty`): its
  // "Nothing connected" line already says that nothing reports an id.
  if (kind === "live") label = t(lang, "poe.id_live_from", { source });
  else if (kind === "conflict") label = t(lang, "poe.id_conflict_from", { id: staticId || "–", source: source || "–" });
  else label = t(lang, kind === "fixed" ? "poe.id_static" : "poe.id_source_none");
  const guards = row.guards.map((g, gi) => {
    const pg = (p.guards || [])[gi] || {};
    const expectedNorm = pg.expected_norm !== undefined ? pg.expected_norm || null : normalizePortId(g.expectedId);
    const relation = guardRelation(expectedNorm, index, norms);
    // The other ports that report the expected id now, and what this port
    // reports instead (a mismatch only).
    const otherPorts = expectedNorm ? norms.flatMap((n, i) => (i !== index && n === expectedNorm ? [names[i] || portDisplayName(row.label, lang)] : [])) : [];
    const reportedDisplay = relation === "mismatch" ? formatPortId(row.idValue) : null;
    return {
      ...g,
      expectedNorm,
      expectedDisplay: formatPortId(g.expectedId),
      relation,
      otherPorts,
      reportedDisplay,
      relationLabel: relationWords(relation, otherPorts, reportedDisplay, lang),
    };
  });
  // Nothing connected: an id entity (or no id source) that reports no id.
  const empty = !idNorm && (kind === "live" || kind === "none");
  const emptyExpected = empty
    ? [...new Set(guards.filter((g) => g.relation === "last_known" && g.expectedDisplay).map((g) => g.expectedDisplay))]
    : [];
  return {
    ...row,
    guards,
    idNorm,
    idDisplay: kind === "conflict" ? null : formatPortId(row.idValue),
    idOrigin: { kind, entity: row.idEntity, attribute, entityName, empty: kind === "live" && !idNorm, staticId, label },
    empty,
    emptyExpected,
    emptyLabel: emptyExpected.length ? t(lang, "poe.empty_expected", { id: emptyExpected[0] }) : null,
    mismatch: guards.some((g) => g.relation === "mismatch"),
  };
}

// ---------------------------------------------------------------------------
// Recovery popup (opt-in; the cards' actor chip)
// ---------------------------------------------------------------------------
//
// What a guard repairs and how that looks now. The static part comes from the
// status sensor (`driver_type`, `driver_entity`, `driver_steps`,
// `driver_port_expected_id`, the counters); the live PoE part (which port the
// expected id is on now, the match, the port's status and last restart) from
// the read-only WS command `necromancer/guard/recovery` (`ws` below; any user
// who may read the guard). Nothing here switches anything: the target is a
// link to HA's own more-info, the repair is the guard's Revive.

function friendlyName(hass, entityId) {
  const so = entityId && hass && hass.states ? hass.states[entityId] : null;
  return (so && so.attributes && so.attributes.friendly_name) || null;
}

/** "Port 5 or Port 6" ("Port 5, Port 6 or Port 7") from labels. */
function portList(labels, lang) {
  const names = (labels || []).map((l) => portDisplayName(l, lang));
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${t(lang, "rec.or")} ${names[names.length - 1]}`;
}

/** Lower-case word tokens ("Port 3 · Doorbell" -> ["port", "3", "doorbell"]). */
function nameTokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether `name` already says `part` (its words in a row): "Port 3 Doorbell
 * PoE" says "Port 3 · Doorbell", "USW Port 5 PoE" says "Port 5".
 */
export function nameContains(name, part) {
  const n = nameTokens(name);
  const p = nameTokens(part);
  if (!p.length || p.length > n.length) return false;
  for (let i = 0; i + p.length <= n.length; i++) if (p.every((x, j) => n[i + j] === x)) return true;
  return false;
}

/**
 * The recovery target of a guard in words, with the entity to open and the
 * kind: `{kind, kindLabel, icon, label, entity}`. Works from the status sensor
 * alone (`ws` null); for a PoE guard `ws` adds the port ("Port 5 on USW-24";
 * the switch's name alone when it already names the port: "Port 3 Doorbell
 * PoE", not "Port 3 · Doorbell on Port 3 Doorbell PoE", with `sub` "Port 3 ·
 * Doorbell" for a muted line under it; without it "PoE port for AA:BB:…").
 * `kind` is `switch`, `poe_port`,
 * `script` (an action that runs exactly one script), `action`, `actions` or
 * `notify`. `entity` is null when there is nothing to open (several steps, no
 * port found).
 */
export function recoveryTarget(info, hass, lang = "en", ws = null) {
  const type = info.canRecover ? info.driverType || "action" : "notify";
  const w = ws && !ws.error ? ws : null;
  const steps = w && w.steps != null ? Number(w.steps) : info.driverSteps;
  const stepWords = (key) =>
    steps == null || !Number.isFinite(steps) ? t(lang, key === "rec.action_steps" ? "rec.action" : "rec.kind.actions") : t(lang, `${key}_${steps === 1 ? "one" : "other"}`, { n: steps });
  const out = (kind, label, entity) => ({ kind, kindLabel: t(lang, `rec.kind.${kind}`), icon: kind === "script" ? actorIcon("action") : actorIcon(kind === "notify" ? null : kind), label, entity: entity || null });
  if (type === "notify") return { ...out("notify", t(lang, "rec.notify_only"), null), icon: "mdi:bell-outline" };
  if (type === "switch") {
    const entity = (w && w.target_entity) || info.targetEntity;
    return out("switch", friendlyName(hass, entity) || (w && w.target_name) || entity || t(lang, "rec.kind.switch"), entity);
  }
  if (type === "action") {
    const script = (w && w.script_entity) || info.scriptEntity;
    if (script) return out("script", friendlyName(hass, script) || (w && w.target_name) || script, script);
    return out("action", stepWords("rec.action_steps"), null);
  }
  if (type === "actions") return out("actions", stepWords("rec.actions_steps"), null);
  if (type === "poe_port") {
    const id = formatPortId((w && w.expected_id) || info.expectedId) || (w && w.expected_id) || info.expectedId || "–";
    if (!w) return out("poe_port", t(lang, "rec.poe_for", { id }), null);
    if (w.match === "ambiguous") return out("poe_port", t(lang, "rec.poe_ambiguous", { ports: portList(w.port_labels, lang) }), null);
    if (!w.port_label) return out("poe_port", t(lang, "rec.poe_none"), null);
    const port = portDisplayName(w.port_label, lang);
    const sw = deviceName(hass, w.actuator) || friendlyName(hass, w.actuator) || w.actuator_name || w.actuator;
    if (!sw) return out("poe_port", port, w.actuator);
    // The switch's name alone: the port as a muted line under it ("Port 3"),
    // so the popup always says which port, whatever the switch is called.
    if (nameContains(sw, port)) return { ...out("poe_port", String(sw), w.actuator), sub: port };
    return out("poe_port", t(lang, "rec.poe_on", { port, switch: sw }), w.actuator);
  }
  return out("action", t(lang, "rec.action"), null);
}

/** Tooltip of the actor chip: "Recovery: Pool plug" / "Reparatur: Poolpumpe". */
export function actorTitle(info, hass, lang = "en", ws = null) {
  return t(lang, "rec.chip_title", { target: recoveryTarget(info, hass, lang, ws).label });
}

/**
 * How a PoE guard's device was found, from the WS answer: `{value, tone}` or
 * null without a PoE answer. Reuses the PoE card's words: "live · from
 * sensor.sw_p5.mac", "Fixed id", and for the cases the fabric would refuse
 * "· repair blocked".
 */
function foundBy(ws, lang) {
  const port = ws.port || {};
  switch (ws.match) {
    case "live": {
      if (port.id_source === "static") return { value: t(lang, "poe.id_static"), tone: "good" };
      const source = port.id_entity ? `${port.id_entity}${port.id_attribute ? `.${port.id_attribute}` : ""}` : "";
      return { value: source ? t(lang, "poe.id_live_from", { source }) : t(lang, "poe.id_live"), tone: "good" };
    }
    case "last_known":
      return { value: t(lang, "rec.found.last_known"), tone: "warn" };
    case "ambiguous":
      // The ports are in the target line above ("Port 5 or Port 25"): only the reason here.
      return { value: t(lang, "rec.found.ambiguous"), tone: "bad" };
    case "mismatch": {
      const id = formatPortId(port.id);
      return { value: id ? t(lang, "rec.found.mismatch", { id }) : t(lang, "rec.found.mismatch_plain"), tone: "bad" };
    }
    case "none":
      return { value: t(lang, "rec.found.none"), tone: "bad" };
    default:
      return null;
  }
}

/** "3 d ago · succeeded" for a time + result; tone good/bad. */
function whenResult(at, ok, now, lang) {
  return { value: `${formatRelative(at, now, lang)} · ${t(lang, ok ? "poe.last_ok" : "poe.last_failed")}`, tone: ok ? "good" : "bad" };
}

/**
 * Model of the recovery popup for one guard. `info` is guardInfo(status),
 * `ws` the `necromancer/guard/recovery` answer (null while loading, `{error}`
 * when the call failed; only a PoE guard needs it), `hass` for names, states
 * and the counters. `opts.now` (ms) for relative times.
 *
 * Returns `{type, canRecover, title, target (recoveryTarget), tooltip,
 * notice, loading, rows, auto, repair}`:
 * - `rows` `[{id, icon, label, value, tone, entity}]` in order: `target` (kind
 *   label, target words, link entity or null), PoE `device` (the expected id,
 *   `sub` = how it was found, tone good/warn/bad), PoE `port_status` (the PoE
 *   card's one status: "Restarting …", "Powered off", "Ready", …), PoE
 *   `last_restart` (this HA run), `last_repair` (the newer of `last_recover`
 *   / `last_fail`, else "Never"), `repairs` ("3 succeeded · 1 failed"). A
 *   notify-only guard has no rows but `notice` ("Notify only — no repair").
 * - `auto` `{entity, on, confirmOff}` (null when the guard cannot recover or has
 *   no auto switch): the switch row; turning it off asks `confirmOff` first.
 * - `repair` `{action: "revive", label, enabled, reason}` (null when the guard
 *   cannot recover): the same action as Revive (`serviceFor("revive", info)`,
 *   confirmed via CONFIRM_ACTIONS), disabled with a reason while a repair or a
 *   port restart runs, while snoozed, while unavailable, or when the PoE id
 *   has no unique port (the fabric would block it).
 * - `tone` of a row is a TONE_COLORS key; `neutral` for the target itself.
 * No direct power toggle anywhere: the only entity a row offers is a link.
 */
export function recoveryModel(info, ws, hass, lang = "en", opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const status = info.statusEntity && hass && hass.states ? hass.states[info.statusEntity] : null;
  const state = status ? status.state : null;
  const attrs = (status && status.attributes) || {};
  const isPoe = info.driverType === "poe_port" && info.canRecover;
  const w = ws && !ws.error ? ws : null;
  const target = recoveryTarget(info, hass, lang, ws);
  const base = {
    type: info.canRecover ? info.driverType : "notify",
    canRecover: info.canRecover,
    title: t(lang, "rec.title"),
    target,
    tooltip: t(lang, "rec.chip_title", { target: target.label }),
    notice: null,
    loading: false,
    rows: [],
    auto: null,
    repair: null,
  };
  if (!info.canRecover) return { ...base, notice: t(lang, "rec.notify_only") };

  const rows = [{ id: "target", icon: target.icon, label: target.kindLabel, value: target.label, tone: "neutral", entity: target.entity }];
  // The port under a link that names only the switch: a muted line.
  if (target.sub) Object.assign(rows[0], { sub: target.sub, subTone: "idle" });
  let portBusy = false;
  let blocked = false;
  if (isPoe) {
    const expected = formatPortId((w && w.expected_id) || info.expectedId);
    if (!ws) {
      rows.push({ id: "device", icon: "mdi:lan-pending", label: t(lang, "rec.device"), value: expected || "–", sub: t(lang, "rec.loading"), tone: "idle", entity: null });
    } else if (!w) {
      rows.push({ id: "device", icon: "mdi:lan-disconnect", label: t(lang, "rec.device"), value: expected || "–", sub: t(lang, "rec.error"), tone: "idle", entity: null });
    } else {
      const found = foundBy(w, lang);
      rows.push({ id: "device", icon: "mdi:lan-connect", label: t(lang, "rec.device"), value: expected || "–", sub: found ? found.value : null, tone: found ? found.tone : "idle", entity: null });
      blocked = ["ambiguous", "mismatch", "none"].includes(w.match);
      if (w.port) {
        const [row] = poePortRows([w.port], hass, lang);
        portBusy = row.busy;
        // A non-admin who may not read the port's status entity (or its switch,
        // with no "online" from the status) cannot be told "Ready": what the
        // fabric itself says (restarting, failed) and a visible "off" or
        // "offline" stand, anything else is "Status not visible".
        const hidden = Array.isArray(w.hidden) ? w.hidden : [];
        const unseen = row.status.key === "poe.status.good" && (hidden.includes("port.status_entity") || (hidden.includes("port.actuator") && row.online !== true));
        rows.push(
          unseen
            ? { id: "port_status", icon: "mdi:eye-off-outline", label: t(lang, "rec.port_status"), value: t(lang, "rec.status_hidden"), tone: "idle", entity: null }
            : { id: "port_status", icon: "mdi:ethernet", label: t(lang, "rec.port_status"), value: row.status.label, tone: row.tone, entity: null },
        );
        const lc = w.last_cycle && toDate(w.last_cycle.time);
        if (lc) {
          const r = whenResult(lc, Boolean(w.last_cycle.ok), now, lang);
          rows.push({ id: "last_restart", icon: "mdi:restart", label: t(lang, "poe.last_cycle"), value: r.value, tone: r.tone, entity: null });
        }
      }
    }
    base.loading = !ws;
  }

  const okAt = toDate(attrs.last_recover);
  const failAt = toDate(attrs.last_fail);
  let last = { value: t(lang, "poe.never"), tone: "idle" };
  if (okAt || failAt) {
    const ok = Boolean(okAt) && (!failAt || okAt.getTime() >= failAt.getTime());
    last = whenResult(ok ? okAt : failAt, ok, now, lang);
  }
  rows.push({ id: "last_repair", icon: "mdi:history", label: t(lang, "rec.last_repair"), value: last.value, tone: last.tone, entity: null });
  const okN = Number(attrs.recover_count) || 0;
  const failN = Number(attrs.fail_count) || 0;
  rows.push({ id: "repairs", icon: "mdi:counter", label: t(lang, "rec.repairs"), value: t(lang, "rec.counts", { ok: okN, failed: failN }), tone: failN > 0 ? "warn" : "idle", entity: null });

  const autoSo = info.autoEntity && hass && hass.states ? hass.states[info.autoEntity] : null;
  const auto = info.autoEntity
    ? { entity: info.autoEntity, on: autoSo ? autoSo.state !== "off" : true, label: t(lang, "rec.auto"), confirmOff: t(lang, "rec.auto_off_confirm") }
    : null;

  let reason = null;
  if (!state || state === "unavailable" || state === "unknown") reason = "rec.unavailable";
  else if (isBusy(state)) reason = "rec.busy";
  else if (portBusy) reason = "rec.port_busy";
  else if (state === "snoozed") reason = "rec.snoozed";
  else if (blocked) reason = "rec.blocked";
  const repair = info.reviveEntity
    ? { action: "revive", label: t(lang, "rec.repair_now"), enabled: !reason, reason: reason ? t(lang, reason) : null, reasonKey: reason }
    : null;
  return { ...base, rows, auto, repair };
}
