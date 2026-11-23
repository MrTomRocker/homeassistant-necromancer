// Necromancer cards: shared base for the four
// elements (guard card, guards card, PoE card, sidebar panel).
//
// Re-exports the shared pure logic (necromancer-core.js) and the shared DOM
// actions (necromancer-actions.js) and the shared 24 h timeline
// (necromancer-timeline.js), plus what only the cards need: their own texts,
// the design tokens (compact sizes), the timeline look, a
// popover and the "Sure?" confirm helper. Nothing here touches the DOM at
// import time (the module also loads under node --test).

// Loaded with this module's own query (`?v=<version>`), so the shared modules
// are the same instances the rest of the page uses (design §10).
const Q = new URL(import.meta.url).search;
const core = await import(`./necromancer-core.js${Q}`);
const actions = await import(`./necromancer-actions.js${Q}`);
const tl = await import(`./necromancer-timeline.js${Q}`);

export { core, actions, tl };

/** The page-wide timeline store (one batched history query for all Necromancer elements). */
export const timeline = tl.timeline;

/** What a collapsed row / compact card shows in its detail slot. */
export const ROW_DETAILS = actions.ROW_DETAILS;

/**
 * The row detail of a config: `row_detail` ("text" | "timeline", default
 * "text"; "" is what the form editor writes for its default entry); an older
 * config's `show_timeline: true` still reads as "timeline" (an explicit
 * `row_detail` wins). Pure.
 */
export function rowDetail(config) {
  const c = config || {};
  if (ROW_DETAILS.includes(c.row_detail)) return c.row_detail;
  return c.show_timeline === true ? "timeline" : "text";
}

/**
 * Whether a list setting has rows for "Row shows" to act on: Display "List",
 * or "Cards" with the folded quiet group (its rows; the setting then says
 * so). Cards without the group have no row at all. One rule for the guards
 * card's editor and the panel's gear, so both show the setting alike. Pure.
 */
export function rowDetailShown(config) {
  const c = config || {};
  return c.display !== "cards" || c.collapse_ok === true;
}

/** True when collapsed rows draw the 24 h strip (row_detail "timeline"). */
export function timelineOn(config) {
  return rowDetail(config) === "timeline";
}

/**
 * Validate the options the Necromancer elements share (throws): `row_detail`
 * and the old `show_timeline`. The old per-action `actions` modes are ignored
 * (the buttons follow one fixed rule now, design §16).
 */
export function checkSharedOptions(config) {
  const c = config || {};
  if (c.row_detail != null && c.row_detail !== "" && !ROW_DETAILS.includes(c.row_detail)) throw new Error("row_detail must be text or timeline");
  if (c.show_timeline != null && typeof c.show_timeline !== "boolean") throw new Error("show_timeline must be true or false");
}

/**
 * A config with `row_detail` written out, the old `show_timeline` and the old
 * `actions` dropped. What the elements keep internally and hand on.
 */
export function withRowDetail(config) {
  const out = { ...(config || {}) };
  out.row_detail = rowDetail(config);
  delete out.show_timeline;
  delete out.actions;
  return out;
}

/**
 * HA form-editor pieces for the shared options (the "Row shows" select). The
 * cards use HA's own form (`getConfigForm`, the supported editor), which shows
 * an unset select empty, so every select names its default in its helper text.
 */
/** The user's language for an editor HA builds without one ("de" or "en"). */
export function docLang() {
  const l = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang || "" : "";
  return /^de\b/i.test(l) ? "de" : "en";
}

export function defaultSelect(options) {
  return { select: { mode: "dropdown", options } };
}

export function rowDetailField(lang) {
  return {
    name: "row_detail",
    selector: defaultSelect(ROW_DETAILS.map((v) => ({ value: v, label: t(lang, `ui.row_detail.${v}`) }))),
  };
}

/** Label of a shared form field (row_detail), else undefined. */
export function sharedFormLabel(name, lang) {
  if (name === "row_detail") return t(lang, "ui.row_detail");
  return undefined;
}


export const TAGS = {
  guard: "necromancer-guard-card",
  guards: "necromancer-guards-card",
  poe: "necromancer-poe-card",
  panel: "necromancer-panel",
};

export const CONFIRM_MS = 3000;
export const esc = core.escapeHtml;

// Texts the shared core does not have (card-only UI); everything else comes
// from core.t. Same keys in both languages.
const UI_I18N = {
  en: {
    "ui.expand": "Show details",
    "ui.collapse": "Hide details",
    "ui.quiet_show": "Show",
    "ui.quiet_hide": "Hide",
    "ui.all_quiet": "All quiet",
    "ui.clear_filter": "Show all",
    "ui.poe_title": "PoE ports",
    "ui.poe_admin": "Only administrators can see the PoE ports.",
    "ui.poe_error": "Could not load the PoE ports.",
    "ui.loading": "Loading …",
    "ui.close": "Close",
    "ui.connected": "Connected",
    "ui.switch": "Switch",
    "ui.status": "Status",
    "ui.port": "Port {n}",
    "ui.ports_one": "{n} port",
    "ui.ports": "{n} ports",
    "ui.restart_short": "Restart",
    "ui.wake_confirm": "Wake all?",
    "ui.done": "Done",
    "ui.counts_label": "Guards per state",
    "ui.settings_saved": "Settings saved",
    "ui.search_label": "Search guards by name",
    "ui.ctx.escalated": "Since {time}",
    "ui.ctx.suspect": "Problem since {time}",
    "ui.ctx.blind": "No health signal since {time}",
    "ui.ctx.recovering": "Repair running since {time}",
    "ui.ctx.verify": "Checking the repair since {time}",
    "ui.ctx.cooldown": "Repaired at {time}",
    "ui.ctx.auto_off": "Auto-recovery off",
    "ui.ctx.notify_only": "Notify only",
    "ui.ctx.repairs_one": "1 repair",
    "ui.ctx.repairs": "{n} repairs",
    "ui.ctx.last": "last {time}",
    "ui.ctx.fails": "{n} failed",
    "ui.ctx.no_repairs": "No repairs so far",
    "ui.ctx.last_hb": "Last heartbeat at {time}",
    "ui.ctx.every": "expected every {period}",
    "ui.row_detail": "Row shows",
    "ui.row_detail.text": "Text",
    "ui.row_detail.timeline": "Timeline",
    "ui.row_detail_quiet": "Cards: only the rows of the folded quiet group",
    // A complete word, not "Problem, waiting …": that ellipsis read as a cut-off label.
    "ui.status.suspect": "Problem, confirming",
    "ui.rec.auto_off_sub": "Off — problems are only reported",
    "ui.rec.auto_on": "On",
    "ui.counts": "{ok} repaired · {fail} failed",
    "ui.rec.tap_again": "Tap again to turn it off.",
    "ui.rec.open": "Open",
    "ui.timeline_cards": "Show 24 h timeline",
  },
  de: {
    "ui.expand": "Details zeigen",
    "ui.collapse": "Details ausblenden",
    "ui.quiet_show": "Zeigen",
    "ui.quiet_hide": "Ausblenden",
    "ui.all_quiet": "Alles ruhig",
    "ui.clear_filter": "Alle zeigen",
    "ui.poe_title": "PoE-Ports",
    "ui.poe_admin": "Nur Administratoren sehen die PoE-Ports.",
    "ui.poe_error": "PoE-Ports konnten nicht geladen werden.",
    "ui.loading": "Lade …",
    "ui.close": "Schließen",
    "ui.connected": "Angeschlossen",
    "ui.switch": "Switch",
    "ui.status": "Status",
    "ui.port": "Port {n}",
    "ui.ports_one": "{n} Port",
    "ui.ports": "{n} Ports",
    "ui.restart_short": "Neustart",
    "ui.wake_confirm": "Alle wecken?",
    "ui.done": "Erledigt",
    "ui.counts_label": "Guards je Zustand",
    "ui.settings_saved": "Einstellungen gespeichert",
    "ui.search_label": "Guards nach Name suchen",
    "ui.ctx.escalated": "Seit {time}",
    "ui.ctx.suspect": "Problem seit {time}",
    "ui.ctx.blind": "Kein Gesundheitssignal seit {time}",
    "ui.ctx.recovering": "Reparatur läuft seit {time}",
    "ui.ctx.verify": "Prüfung läuft seit {time}",
    "ui.ctx.cooldown": "Repariert um {time}",
    "ui.ctx.auto_off": "Auto-Reparatur aus",
    "ui.ctx.notify_only": "Nur Benachrichtigung",
    "ui.ctx.repairs_one": "1 Reparatur",
    "ui.ctx.repairs": "{n} Reparaturen",
    "ui.ctx.last": "zuletzt {time}",
    "ui.ctx.fails": "{n} fehlgeschlagen",
    "ui.ctx.no_repairs": "Noch keine Reparatur",
    "ui.ctx.last_hb": "Letzter Heartbeat um {time}",
    "ui.ctx.every": "erwartet alle {period}",
    "ui.row_detail": "Zeile zeigt",
    "ui.row_detail.text": "Text",
    "ui.row_detail.timeline": "Zeitverlauf",
    "ui.row_detail_quiet": "Karten: nur die Zeilen der eingeklappten ruhigen Gruppe",
    "ui.status.suspect": "Problem, wird bestätigt",
    "ui.rec.auto_off_sub": "Aus — Probleme werden nur gemeldet",
    "ui.rec.auto_on": "An",
    "ui.counts": "{ok} repariert · {fail} fehlgeschlagen",
    "ui.rec.tap_again": "Nochmal tippen zum Ausschalten.",
    "ui.rec.open": "Öffnen",
    "ui.timeline_cards": "Zeitverlauf anzeigen",
  },
};

/** core.t plus the cards' own keys and the timeline's ("tl.*"). */
export function t(lang, key, vars = {}) {
  if (key.startsWith("tl.")) return tl.tlText(lang, key, vars);
  const l = core.langOf(lang);
  const own = (UI_I18N[l] && UI_I18N[l][key]) ?? UI_I18N.en[key];
  if (own == null) return core.t(lang, key, vars);
  let s = own;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/**
 * The quiet context of a list row (design: the wide row's free column must not
 * stay empty): what the value pill means for a heartbeat guard, since when the
 * guard is in a problem state, whether it can repair at all, and how often it
 * has repaired. Absolute clock times only, so nothing in here ticks. Pure.
 * `opts`: {now, timeZone, timeFormat, autoOn, lastHeartbeat (the last ping's
 * time), period (s), hasEvent, since (when the guard really entered its
 * state, see stateSince; default last_changed)}. A heartbeat guard's row names the clock time
 * of the last ping (the value pill says "1 h ago"); the expected period only
 * when no event message already says it.
 */
export function contextLine(info, statusObj, lang, opts = {}) {
  const so = statusObj || {};
  const a = so.attributes || {};
  const state = so.state;
  const now = opts.now ?? Date.now();
  const clock = (v) => core.formatClock(v, now, lang, opts.timeZone, opts.timeFormat);
  const parts = [];
  if (info && info.type === "heartbeat") {
    const last = opts.lastHeartbeat ? clock(opts.lastHeartbeat) : "";
    if (last) parts.push(t(lang, "ui.ctx.last_hb", { time: last }));
    if (!opts.hasEvent && Number(opts.period) > 0) {
      const every = t(lang, "ui.ctx.every", { period: core.formatDuration(Number(opts.period), lang) });
      parts.push(parts.length ? every : every.charAt(0).toUpperCase() + every.slice(1));
    }
  }
  // Escalated reads "Since 11:19 AM": the status line or badge right beside it
  // already says "Escalated". The other states name what has been going on.
  const sinceKey = {
    escalated: "ui.ctx.escalated",
    suspect: "ui.ctx.suspect",
    blind: "ui.ctx.blind",
    recovering: "ui.ctx.recovering",
    verify: "ui.ctx.verify",
    cooldown: "ui.ctx.cooldown",
  }[state];
  const since = sinceKey && clock(opts.since || so.last_changed || so.last_updated);
  if (since && !(info && info.type === "heartbeat")) parts.push(t(lang, sinceKey, { time: since }));
  if (info && info.driverType === "notify" && info.type !== "heartbeat") parts.push(t(lang, "ui.ctx.notify_only"));
  else if (info && info.autoEntity && opts.autoOn === false) parts.push(t(lang, "ui.ctx.auto_off"));
  const n = Number(a.recover_count) || 0;
  const fails = Number(a.fail_count) || 0;
  if (n > 0) {
    let rep = t(lang, n === 1 ? "ui.ctx.repairs_one" : "ui.ctx.repairs", { n });
    const last = a.last_recover ? clock(a.last_recover) : "";
    if (last) rep += ` (${t(lang, "ui.ctx.last", { time: last })})`;
    parts.push(rep);
  } else if (info && info.canRecover && (state === "ok" || state === "snoozed")) {
    parts.push(t(lang, "ui.ctx.no_repairs"));
  }
  if (fails > 0) parts.push(t(lang, "ui.ctx.fails", { n: fails }));
  return parts.join(" · ");
}

/**
 * The status words of a guard on the cards: core.statusLine, except that "Problem,
 * waiting …" (suspect) reads as a complete label ("Problem, confirming"): with
 * its trailing ellipsis the badge looked cut off although it had room. Pure.
 */
export function statusText(info, state, attrs, lang, opts = {}) {
  const s = core.statusLine(info, state, attrs, lang, opts);
  return state === "suspect" && s === core.t(lang, "status.suspect") ? t(lang, "ui.status.suspect") : s;
}

/**
 * When a guard really entered its current state (a Date, or null): HA's
 * `last_changed` starts again at every restart, so an escalation from 12:11
 * would read "for 14 min". The status sensor's own `state_since` wins (the
 * engine persists it with the state, so it survives a restart): then text and
 * timeline mode, collapsed and opened rows all say the same without a history
 * query. Older backends: an escalated guard's `escalated_at`, else the start
 * of the current run in the 24 h points when they are loaded (`entry`, see
 * tl.runStart), when that is older. Pure.
 */
export function stateSince(statusObj, entry) {
  const so = statusObj || {};
  const a = so.attributes || {};
  const own = core.toDate(a.state_since);
  if (own) return own;
  let since = core.toDate(so.last_changed || so.last_updated);
  if (so.state === "escalated") {
    const esc = core.toDate(a.escalated_at);
    if (esc) return esc;
  }
  if (entry && entry.loaded) {
    const t0 = tl.runStart(entry.points, so.state);
    if (t0 != null && (!since || t0 < since.getTime())) since = new Date(t0);
  }
  return since;
}

/**
 * A row's detail text without a leading word that repeats the status line
 * right above it: status "Escalated" + "Escalated · 2 attempts · 2 h ago" ->
 * "2 attempts · 2 h ago". Only a whole first part (up to " · ") that equals
 * the status (case-insensitive) is dropped, and never the only part. Pure.
 */
export function dropLeadingState(text, status) {
  const s = String(text ?? "");
  const st = String(status ?? "").trim().toLowerCase();
  const at = s.indexOf(" · ");
  if (!st || at < 0) return s;
  return s.slice(0, at).trim().toLowerCase() === st ? s.slice(at + 3) : s;
}

// The heartbeat detail's period clause, as the backend words it (instance
// language, TTS-friendly units: "expected every 60 minutes").
const PERIOD_CLAUSE = /,\s*(?:expected every|erwartet alle)\s+[^,.]+(?=\.?\s*$)/i;

/**
 * A heartbeat guard's reason without its "expected every 60 minutes" clause,
 * for a card whose value caption already says "expected every 1 h" (one card,
 * one wording). Anything that does not end in that clause stays as is. Pure.
 */
export function withoutPeriodClause(text) {
  const s = String(text ?? "");
  return s.replace(PERIOD_CLAUSE, "");
}

// The backend's period clause with its number and unit ("expected every 60
// minutes" / "erwartet alle 60 Minuten"); group 1 is the lead-in.
const PERIOD_VALUE = /((?:expected every|erwartet alle)\s+)(\d+(?:[.,]\d+)?\s*[A-Za-zÄÖÜäöü]+)/i;

/**
 * A heartbeat reason with its period in the cards' own duration format
 * ("expected every 60 minutes" -> "expected every 1 h"), so a list does not
 * mix "every 60 minutes" in one row with "every 1 h" in the next. The clause
 * keeps the language it came in (the instance language of the backend text).
 * `period` in seconds; without one (or another text) nothing changes. Pure.
 */
export function withPeriodFormatted(text, period) {
  const s = String(text ?? "");
  const p = Number(period);
  if (!(p > 0)) return s;
  return s.replace(PERIOD_VALUE, (_m, lead) => `${lead}${core.formatDuration(p, /^erwartet/i.test(lead) ? "de" : "en")}`);
}

/**
 * Event text that wraps only between its parts: a number stays with its noun
 * ("2 attempts", "4 h ago") and the " · " separator with the part before it,
 * so a narrow tray breaks "2 attempts ·" / "4 h ago", never "2" / "attempts"
 * (nor "4 h" / "ago").
 * Free text (a blocked reason) still wraps between its words. Pure.
 */
export function glueEventText(text) {
  return String(text ?? "")
    .replace(/(\d) (?=\S)/g, "$1\u00a0")
    // "150 d ago" / "vor 150 Tg." stay one piece ("Last escalation 150 d" /
    // "ago" read oddly in a two-line tray).
    .replace(/(\d\u00a0\S+) (ago)\b/g, "$1\u00a0$2")
    .replace(/\b(vor) (?=\d)/g, "$1\u00a0")
    .replace(/ · /g, "\u00a0· ");
}

// An event older than this no longer reads as news (design: a week).
export const OLD_EVENT_SECONDS = 7 * 86400;

/**
 * The last event as a calm note when it is old news: a red "Escalated · 150 d
 * ago" on a guard that is fine again reads like a live problem, so a bad/warn
 * event older than a week on a guard that is not escalated gets the muted
 * tone. A fresh event, a success and any event while escalated keep theirs.
 */
export function quietOldEvent(ev, state) {
  if (!ev || ev.tone === "good" || state === "escalated") return ev;
  if (!(Number(ev.age) > OLD_EVENT_SECONDS)) return ev;
  return { ...ev, tone: "idle" };
}

/** Language of a hass object (profile language first). */
export function langFrom(hass) {
  return core.langOf((hass && hass.locale && hass.locale.language) || (hass && hass.language));
}

/**
 * Re-apply properties set before the element was upgraded: HA may hand `hass`
 * to an element before this module defined it, which leaves an own property
 * hiding the class setter.
 */
export function upgradeProperties(el, props) {
  for (const prop of props) {
    if (Object.prototype.hasOwnProperty.call(el, prop)) {
      const value = el[prop];
      delete el[prop];
      el[prop] = value;
    }
  }
}

/** Shallow compare of two signature arrays. */
export function sameSig(a, b) {
  return Boolean(a) && Boolean(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Design tokens and shared CSS
// ---------------------------------------------------------------------------

// Strong fills mix the state colour with a little black so white text stays
// readable on orange and grey; theme variables still drive the hue.
//
// Sizes (compact, wider than tall): pills 36 px high / 13.5 px text, icon
// bubble 48 px, main value 24 px.
//
// Tinted pills (not filled) draw their text in the pill colour pulled 50 %
// toward the text colour: plain violet/orange on its own pale tint was ~3:1
// (a pale "Wake all"), the mix stays >= 4.5:1 on light and dark themes and keeps
// the hue.
export const BASE_STYLE = `
  :host {
    --ui-radius: var(--necro-radius, 24px);
    --ui-text: var(--primary-text-color, #212121);
    --ui-text2: var(--secondary-text-color, #727272);
    --ui-on: var(--text-primary-color, #fff);
    --ui-surface: var(--ha-card-background, var(--card-background-color, #fff));
    --ui-soft: color-mix(in srgb, var(--ui-text) 6%, transparent);
    --ui-soft2: color-mix(in srgb, var(--ui-text) 10%, transparent);
    --ui-accent: var(--primary-color, #03a9f4);
    --ui-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --ui-pill-h: 36px;
    display: block;
  }
  button { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
  button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--ui-accent) 70%, transparent); outline-offset: 2px;
  }
  .pill {
    --pill: var(--ui-accent);
    height: var(--ui-pill-h); border-radius: calc(var(--ui-pill-h) / 2); border: none; padding: 0 14px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 7px; white-space: nowrap;
    font-size: 13.5px; font-weight: 700; letter-spacing: 0.01em;
    color: color-mix(in srgb, var(--pill) 50%, var(--ui-text));
    background: color-mix(in srgb, var(--pill) 16%, transparent); --mdc-icon-size: 19px;
    transition: transform 0.25s var(--ui-spring), background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
  }
  .pill:hover { background: color-mix(in srgb, var(--pill) 28%, transparent); }
  .pill:active { transform: scale(0.92); }
  .pill.strong, .pill.confirm {
    background: color-mix(in srgb, var(--pill) 88%, #000); color: var(--ui-on);
    box-shadow: 0 4px 14px color-mix(in srgb, var(--pill) 35%, transparent);
  }
  .pill.strong:hover { background: color-mix(in srgb, var(--pill) 78%, #000); }
  .pill.confirm { animation: a-wiggle 0.4s var(--ui-spring); }
  .pill.neutral { --pill: var(--ui-text); background: var(--ui-soft); color: var(--ui-text); }
  .pill.neutral:hover { background: var(--ui-soft2); }
  .pill.round { width: var(--ui-pill-h); padding: 0; }
  .pill[aria-disabled="true"] { opacity: 0.55; cursor: progress; }
  .pill[aria-pressed="true"] { background: color-mix(in srgb, var(--pill) 88%, #000); color: var(--ui-on); }
  @keyframes a-wiggle { 0% { transform: scale(0.9); } 60% { transform: scale(1.06); } 100% { transform: scale(1); } }

  .pop {
    position: fixed; z-index: 20; min-width: 220px; max-width: 300px; box-sizing: border-box;
    padding: 8px; border-radius: 22px;
    background: var(--ui-surface); color: var(--ui-text);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--ui-soft);
    transform-origin: top right;
    animation: a-pop 0.28s var(--ui-spring);
  }
  .pop[hidden] { display: none; }
  @keyframes a-pop { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: none; } }
  .pop button {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; min-height: 44px;
    border: none; border-radius: 16px; background: none; cursor: pointer; text-align: left;
    font-size: 14px; font-weight: 500; color: var(--ui-text); --mdc-icon-size: 20px;
    transition: background 0.15s ease, transform 0.2s var(--ui-spring);
  }
  .pop button:active { transform: scale(0.97); }
  .pop button ha-icon {
    flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
    background: var(--ui-soft); color: var(--ui-text2);
  }
  .pop button:hover { background: var(--ui-soft); }
  .pop .sep { height: 1px; margin: 4px 10px; background: var(--ui-line, color-mix(in srgb, var(--primary-text-color, #000) 12%, transparent)); }
  .pop button.confirm { background: color-mix(in srgb, var(--nc, var(--ui-accent)) 88%, #000); color: var(--ui-on); }
  .pop button.confirm ha-icon { background: rgba(255, 255, 255, 0.2); color: inherit; }
  .pop .head { padding: 8px 12px 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--ui-text2); }

  /* 24 h timeline: the shared CSS, these tokens. The empty
     track uses the 10 % tint (6 % vanished on dark themes). */
  :host {
    --tl-track: var(--ui-soft2);
    --tl-text: var(--ui-text);
    --tl-text2: var(--ui-text2);
    --tl-h: 12px;
    --tl-h-thin: 6px;
  }
  ${tl.TIMELINE_CSS}
  .tl-axis { opacity: 1; }

  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;

// ---------------------------------------------------------------------------
// Popover: one floating menu per element, anchored to a `[data-anchor]` button
// ---------------------------------------------------------------------------

export class Pop {
  /**
   * `host` is the custom element, `el` the `.pop` div in its shadow root. Item
   * clicks bubble to the host's own delegated click handler.
   */
  constructor(host, el) {
    this.host = host;
    this.el = el;
    this.state = null; // {kind, anchor, render}
    this.html = null;
    this._onDoc = (ev) => this._outside(ev);
    this._onKey = (ev) => this._key(ev);
    // A scroll or resize moves the menu with its trigger; only a trigger that
    // left the viewport closes it. (Closing on any scroll lost the menu to a
    // 2 px nudge: a click retry that scrolled the item into view, a touch
    // jitter, a live re-render of a card above.)
    this._onScroll = () => this._follow();
  }

  get kind() {
    return this.state && this.state.kind;
  }

  get anchor() {
    return this.state && this.state.anchor;
  }

  _anchorEl() {
    return this.state ? this.host.shadowRoot.querySelector(`[data-anchor="${this.state.anchor}"]`) : null;
  }

  open(kind, anchor, render) {
    const wasOpen = Boolean(this.state);
    this.state = { kind, anchor, render };
    this.html = null;
    this.refresh();
    this._sync();
    const first = this.el.querySelector('[role="menuitem"]');
    if (first && first.focus) first.focus();
    if (wasOpen) return;
    document.addEventListener("pointerdown", this._onDoc, true);
    document.addEventListener("keydown", this._onKey, true);
    window.addEventListener("scroll", this._onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this._onScroll, { passive: true });
  }

  /** Re-render the items (only when they changed) and re-position. */
  refresh() {
    if (!this.state) return;
    const a = this._anchorEl();
    if (!a) {
      this.close();
      return;
    }
    const html = this.state.render();
    if (html !== this.html) {
      this.html = html;
      const active = this.host.shadowRoot.activeElement;
      const key = active && this.el.contains(active) ? active.getAttribute("data-key") : null;
      this.el.innerHTML = html;
      if (key) {
        const again = this.el.querySelector(`[data-key="${key}"]`);
        if (again) again.focus();
      }
    }
    this.el.hidden = false;
    this._place(a);
  }

  /** Follow the trigger (scroll, resize); close once it is out of view. */
  _follow() {
    if (!this.state) return;
    const a = this._anchorEl();
    const r = a && a.getBoundingClientRect();
    if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > window.innerHeight) {
      this.close();
      return;
    }
    this._place(a, r);
  }

  _place(a, rect) {
    const r = rect || a.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  close({ focusAnchor = false } = {}) {
    if (!this.state) return;
    const a = focusAnchor ? this._anchorEl() : null;
    this.state = null;
    this.html = null;
    this.el.hidden = true;
    this.el.innerHTML = "";
    this._sync();
    if (a && a.focus) a.focus();
    document.removeEventListener("pointerdown", this._onDoc, true);
    document.removeEventListener("keydown", this._onKey, true);
    window.removeEventListener("scroll", this._onScroll, { capture: true });
    window.removeEventListener("resize", this._onScroll);
  }

  /** aria-expanded on every trigger of this element. */
  _sync() {
    for (const el of this.host.shadowRoot.querySelectorAll("[data-anchor]")) {
      el.setAttribute("aria-expanded", String(Boolean(this.state && this.state.anchor === el.dataset.anchor)));
    }
  }

  _outside(ev) {
    const path = ev.composedPath();
    const a = this._anchorEl();
    if (path.includes(this.el) || (a && path.includes(a))) return;
    this.close();
  }

  _key(ev) {
    if (!this.state) return;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      this.close({ focusAnchor: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
    if (!this.host.shadowRoot.activeElement) return;
    const items = [...this.el.querySelectorAll('[role="menuitem"]')];
    if (!items.length) return;
    ev.preventDefault();
    const i = items.indexOf(this.host.shadowRoot.activeElement);
    let next;
    if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = items.length - 1;
    else if (ev.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % items.length;
    else next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
    items[next].focus();
  }
}

// ---------------------------------------------------------------------------
// "Sure?" confirm: the first tap arms an id for 3 s, the second one runs it
// ---------------------------------------------------------------------------

export class Confirm {
  constructor(onChange) {
    this.id = null;
    this.timer = null;
    this.onChange = onChange;
  }

  is(id) {
    return this.id === id;
  }

  /** True when `id` was armed (run it now); else arms it and returns false. */
  check(id) {
    if (this.id === id) {
      this.clear();
      return true;
    }
    this.clear();
    this.id = id;
    this.timer = setTimeout(() => {
      this.id = null;
      this.timer = null;
      this.onChange();
    }, CONFIRM_MS);
    this.onChange();
    return false;
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.id = null;
    this.timer = null;
  }
}

/** Snooze-duration menu items (design §16.3), for a guard or for all guards. */
export function snoozeItems(lang, action, title) {
  return (
    `<div class="head">${esc(title)}</div>` +
    core.SNOOZE_DURATIONS.map(
      (s) =>
        `<button role="menuitem" data-key="s${s}" data-action="${action}" data-seconds="${s}"><ha-icon icon="mdi:timer-sand"></ha-icon>${esc(t(lang, `snooze.${s}`))}</button>`,
    ).join("")
  );
}

/** Timezone for clock times (server zone unless the profile says "local"). */
export const timeZoneOf = core.hassTimeZone;
