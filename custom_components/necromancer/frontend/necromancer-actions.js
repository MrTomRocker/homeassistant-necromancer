// Necromancer frontend actions: the DOM side shared by every card and panel.
//
// Service calls for every guard action (design §5 action table), the bulk and
// PoE actions, toasts, more-info, navigation, the clipboard and the panel's
// per-user settings. Nothing here touches `window`, `document` or `navigator`
// at import time, so the module also loads under `node --test`.
//
// The heartbeat URL holds a guard's secret token: it goes to the clipboard and
// nowhere else, never into DOM text, a toast, the console or an error.

// The core is imported with this module's own query (`?v=<version>` in the
// bundle), so the bundle, this module and the core always come from one version.
const core = await import(`./necromancer-core.js${new URL(import.meta.url).search}`);
const { DOMAIN, EDIT_PATH, SORT_MODES, formatDuration, langOf, resolvePingUrl, serviceFor, t } = core;

/** Key of the panel settings in HA's per-user frontend storage (design §8). */
export const PANEL_SETTINGS_KEY = "necromancer_panel";
export const PANEL_TABS = ["guards", "heartbeat", "poe"];
/** What a collapsed guard row shows (cards' `row_detail`, panel setting). */
export const ROW_DETAILS = ["text", "timeline"];
/** How the panel lays out the guards: one list, or a masonry of full cards. */
export const PANEL_DISPLAYS = ["list", "cards"];
/**
 * Defaults of the panel's gear settings (design §8 table): the switches, the
 * sort and start tab, what a collapsed row shows (`row_detail`), list or cards
 * (`display`) and the 24 h section on the full cards (`timeline`). Rows show
 * the 24 h strip and the quiet guards are not folded by default (design §16).
 */
export const PANEL_DEFAULTS = Object.freeze({
  show_counters: false,
  show_actions: true,
  show_footer: true,
  collapse_ok: false,
  sort: "problems",
  start_tab: "guards",
  row_detail: "timeline",
  display: "list",
  timeline: false,
});

// Ids other parts of the code (and the design table) use for the same action.
const ALIASES = { heartbeat_ping: "ping", check_health: "check", heartbeat_url: "url" };

/** Fire a bubbling, composed DOM event (how cards talk to HA's frontend). */
export function fire(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** HA toast (`hass-notification`). */
export function toast(host, message, opts = {}) {
  fire(host, "hass-notification", { message, ...opts });
}

/** HA's more-info dialog for an entity. */
export function moreInfo(host, entityId) {
  fire(host, "hass-more-info", { entityId });
}

/** In-app navigation, the way HA's own links do it. */
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  fire(window, "location-changed", { replace });
}

/**
 * Copy text: the Clipboard API in a secure context, else a short-lived hidden
 * textarea with `execCommand("copy")` (HA on plain http).
 */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_err) {
      // fall through to the legacy path (e.g. lost user activation)
    }
  }
  const ta = document.createElement("textarea");
  // Set as a property, never as text content or an attribute, and removed at once.
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch (_err) {
    return false;
  } finally {
    ta.value = "";
    ta.remove();
  }
}

/**
 * One service call. `notifyOnError`: HA shows the service's own error text as
 * a toast. Returns the response, or null on an error (already reported by HA;
 * never logged, as a response may hold the heartbeat URL).
 */
async function callService(hass, call, returnResponse = false) {
  if (!call || !hass) return null;
  const [domain, service, data, target] = call;
  try {
    return await hass.callService(domain, service, data, target, true, returnResponse);
  } catch (_err) {
    return null;
  }
}

function langFor(hass, opts) {
  return opts.lang || langOf((hass && hass.locale && hass.locale.language) || (hass && hass.language));
}

/**
 * Run one action. `info` is `guardInfo()` of the guard (null for the bulk and
 * PoE actions). Confirmation ("Sure?") is the caller's business: this runs.
 *
 * Ids: revive, reset, snooze (`opts.duration` in seconds), unsnooze, ping
 * (alias heartbeat_ping), auto (`opts.autoOn`, else read from hass), check
 * (alias check_health; toasts the health), url (alias heartbeat_url; copies),
 * edit (`opts.path`), details, more-info (`opts.entityId`), snooze_all
 * (`opts.duration`), unsnooze_all, repair_poe_port (`opts.id`, `opts.port`).
 * `opts.lang` / `opts.name` word the toasts.
 *
 * Returns the service response (`{context, response}`), `true` for the
 * navigation actions, `{copied}` for url, or null when nothing ran or HA
 * reported an error.
 */
export async function runAction(host, hass, info, actionId, opts = {}) {
  const id = ALIASES[actionId] || actionId;
  const lang = langFor(hass, opts);
  const name = opts.name || (info && info.name) || "";
  switch (id) {
    case "details":
      if (!info || !info.statusEntity) return null;
      moreInfo(host, info.statusEntity);
      return true;
    case "more-info":
      if (!opts.entityId) return null;
      moreInfo(host, opts.entityId);
      return true;
    case "edit":
      navigate(opts.path || EDIT_PATH);
      return true;
    case "snooze": {
      const seconds = Number(opts.duration);
      if (!(seconds > 0)) return null;
      const res = await callService(hass, serviceFor("snooze", info, { duration: seconds }));
      if (res !== null) toast(host, t(lang, "toast.snoozed", { name, duration: formatDuration(seconds, lang) }));
      return res;
    }
    case "check": {
      const res = await callService(hass, serviceFor("check", info), true);
      const health = res && res.response && res.response.health;
      if (health) toast(host, t(lang, "toast.health", { name, health: t(lang, `health.${health}`) }));
      return res;
    }
    case "url":
      return copyPingUrl(host, hass, info, lang);
    case "auto": {
      let autoOn = opts.autoOn;
      if (autoOn === undefined) {
        const so = info && info.autoEntity && hass && hass.states ? hass.states[info.autoEntity] : null;
        autoOn = so ? so.state !== "off" : true;
      }
      return callService(hass, serviceFor("auto", info, { autoOn }));
    }
    case "snooze_all": {
      const seconds = Number(opts.duration);
      if (!(seconds > 0)) return null;
      const res = await callService(hass, [DOMAIN, "snooze_all", { duration: seconds }, undefined]);
      if (res !== null) toast(host, t(lang, "toast.snoozed_all", { duration: formatDuration(seconds, lang) }));
      return res;
    }
    case "unsnooze_all": {
      const res = await callService(hass, [DOMAIN, "unsnooze_all", {}, undefined]);
      if (res !== null) toast(host, t(lang, "toast.unsnoozed_all"));
      return res;
    }
    case "repair_poe_port": {
      if (!opts.id) return null;
      // The service blocks for the whole power cycle (up to minutes): say so now.
      toast(host, t(lang, "toast.poe_restart", { port: opts.port || opts.id }));
      return callService(hass, [DOMAIN, "repair_poe_port", { id: String(opts.id) }, undefined]);
    }
    default:
      // revive, reset, unsnooze, ping: plain calls
      return callService(hass, serviceFor(id, info, {}));
  }
}

/** Fetch the guard's heartbeat URL and copy it; only a toast says it worked. */
async function copyPingUrl(host, hass, info, lang) {
  if (!info || !info.statusEntity) return null;
  const res = await callService(hass, [DOMAIN, "heartbeat_url", { guard: info.statusEntity }, undefined], true);
  if (!res) return null; // HA already showed the error
  const url = resolvePingUrl(res.response, window.location.origin);
  if (!url) {
    toast(host, t(lang, "toast.no_url"));
    return { copied: false };
  }
  const ok = await copyText(url);
  toast(host, t(lang, ok ? "toast.copied" : "toast.copy_failed"));
  return { copied: ok };
}

// ---------------------------------------------------------------------------
// Panel settings (per HA user, on every device: frontend/*_user_data)
// ---------------------------------------------------------------------------

/**
 * Stored settings merged over the defaults; unknown keys and bad values
 * dropped (also the old per-action `actions`). An older stored
 * `show_timeline` reads as `row_detail`; only `row_detail` is written back.
 */
export function normalizePanelSettings(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = { ...PANEL_DEFAULTS };
  for (const k of ["show_counters", "show_actions", "show_footer", "collapse_ok"]) {
    if (typeof v[k] === "boolean") out[k] = v[k];
  }
  if (SORT_MODES.includes(v.sort)) out.sort = v.sort;
  if (PANEL_TABS.includes(v.start_tab)) out.start_tab = v.start_tab;
  if (ROW_DETAILS.includes(v.row_detail)) out.row_detail = v.row_detail;
  else if (typeof v.show_timeline === "boolean") out.row_detail = v.show_timeline ? "timeline" : "text";
  if (PANEL_DISPLAYS.includes(v.display)) out.display = v.display;
  out.timeline = v.timeline === true;
  return out;
}

/** The current user's panel settings (defaults when none are stored or on error). */
export async function loadPanelSettings(hass) {
  try {
    const res = await hass.callWS({ type: "frontend/get_user_data", key: PANEL_SETTINGS_KEY });
    return normalizePanelSettings(res && res.value);
  } catch (_err) {
    return { ...PANEL_DEFAULTS };
  }
}

/** Store the panel settings for the current user; returns what was stored. */
export async function savePanelSettings(hass, settings) {
  const value = normalizePanelSettings(settings);
  await hass.callWS({ type: "frontend/set_user_data", key: PANEL_SETTINGS_KEY, value });
  return value;
}

/** The PoE ports for the PoE card (admin only; `necromancer/poe/ports`). */
export async function loadPoePorts(hass) {
  return hass.callWS({ type: `${DOMAIN}/poe/ports` });
}

/**
 * One guard's recovery target and live PoE resolution for the recovery popup
 * (`necromancer/guard/recovery`, read-only). Any user who may read the guard's
 * status sensor; entities they may not read come back as null. Pass the result
 * to core.recoveryModel; on an error pass `{error}` so it says so.
 */
export async function loadGuardRecovery(hass, entityId) {
  return hass.callWS({ type: `${DOMAIN}/guard/recovery`, entity_id: entityId });
}
