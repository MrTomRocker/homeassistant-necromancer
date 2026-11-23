// Recovery popup ("Recovery" / "Reparatur"), opened by the actor
// chip of a guard card (full card, compact card, list row, opened row, panel).
//
// It says what the guard repairs and how that looks now, for every driver type:
// the target as a link to HA's more-info (switch, the one script, the PoE
// switch), how a PoE device was found and its port's state (live from the
// read-only WS command `necromancer/guard/recovery`), the last repair and the
// counters, the auto-recovery switch (turning it off asks "Sure?" first) and
// "Repair now" (the guard's Revive, with the same "Sure?" confirm). There is
// no power toggle anywhere in it: the links open HA's own dialog.
//
// A native <dialog> opened with showModal(): it sits in the top layer (no card
// `overflow: hidden` or container clips it), keeps the keyboard inside, closes
// on Esc, and the rest of the page is inert meanwhile. Wide: anchored to the
// chip like the other popovers; below 600 px a bottom sheet over the full
// width. The model is core.recoveryModel (pure); this module only draws it.

const Q = new URL(import.meta.url).search;
const { core, esc, t } = await import(`./necromancer-base.js${Q}`);

const { TONE_COLORS } = core;

/** Below this viewport width the popup is a bottom sheet. */
export const SHEET_MAX_WIDTH = 600;
const WIDTH = 344;

export const REC_STYLE = `
  dialog.rec {
    position: fixed; inset: auto; margin: 0; padding: 0; border: none; background: none;
    max-width: none; max-height: none; overflow: visible; color: var(--ui-text);
  }
  dialog.rec::backdrop { background: rgba(0, 0, 0, 0.34); }
  dialog.rec.sheet::backdrop { background: rgba(0, 0, 0, 0.42); }
  dialog.rec:not([open]) { display: none; }
  .rbox {
    width: ${WIDTH}px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box;
    padding: 14px 14px 16px; border-radius: 26px; background: var(--ui-surface); color: var(--ui-text);
    box-shadow: 0 16px 44px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--ui-soft);
    transform-origin: top right; animation: a-pop 0.28s var(--ui-spring);
  }
  dialog.rec.sheet { inset: auto 0 0 0; width: 100%; }
  dialog.rec.sheet .rbox {
    width: 100%; max-width: none; max-height: 85vh; border-radius: 26px 26px 0 0;
    padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); animation: a-sheet 0.32s var(--ui-spring);
  }
  @keyframes a-sheet { from { transform: translateY(40%); opacity: 0.4; } to { transform: none; opacity: 1; } }
  .rhead { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .rbub {
    flex: none; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; --mdc-icon-size: 22px;
    color: var(--ui-text); background: var(--ui-soft2);
  }
  .rttl { flex: 1; min-width: 0; }
  .rttl h2:focus { outline: none; }
  .rttl h2 { margin: 0; font-size: 17px; font-weight: 900; line-height: 1.25; letter-spacing: -0.01em; }
  .rname { font-size: 12.5px; font-weight: 600; color: var(--ui-text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rnotice {
    display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; padding: 12px 14px; border-radius: 18px;
    background: var(--ui-soft); font-size: 14px; font-weight: 600; color: var(--ui-text2); --mdc-icon-size: 20px;
  }
  .rlist { display: grid; gap: 2px; margin: 4px 0 6px; }
  .rrow { display: flex; align-items: flex-start; gap: 12px; padding: 7px 6px; border-radius: 16px; }
  .ricon {
    flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; --mdc-icon-size: 18px;
    color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent);
  }
  .rtxt { flex: 1; min-width: 0; }
  .rlabel { font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ui-text2); line-height: 1.3; }
  .rval { font-size: 14.5px; font-weight: 700; line-height: 1.35; color: var(--tt, var(--ui-text)); overflow-wrap: anywhere; }
  /* The chevron follows the last word (also when the name wraps), not the
     far end of a wrapped line. */
  .rlink {
    display: inline-block; max-width: 100%; margin: 0 0 0 -6px; padding: 1px 4px 1px 6px; box-sizing: border-box;
    border: none; border-radius: 10px; background: none; cursor: pointer; text-align: left;
    font-size: 14.5px; font-weight: 800; line-height: 1.35; color: color-mix(in srgb, var(--ui-accent) 60%, var(--ui-text));
    text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, var(--ui-accent) 45%, transparent); --mdc-icon-size: 18px;
  }
  .rlink .rlt { overflow-wrap: anywhere; }
  .rlink .nw { white-space: nowrap; }
  .rlink ha-icon { display: inline-block; vertical-align: -4px; margin-left: 1px; }
  .rlink:hover { background: var(--ui-soft); }
  .rsub { margin-top: 1px; font-size: 12.5px; font-weight: 600; line-height: 1.35; color: var(--tt, var(--ui-text2)); overflow-wrap: anywhere; }
  .rsw {
    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; margin: 4px 0 0; padding: 6px 8px 6px 6px;
    box-sizing: border-box; border: none; border-radius: 18px; background: var(--ui-soft); cursor: pointer; text-align: left;
    color: var(--ui-text); font-size: 14.5px; font-weight: 700;
  }
  .rsw:hover { background: var(--ui-soft2); }
  .rsw .ricon { --tone: var(--ui-text2); }
  .rsw.off .ricon, .rsw.armed .ricon { --tone: ${TONE_COLORS.warn}; }
  .rsw.armed { background: color-mix(in srgb, ${TONE_COLORS.warn} 16%, transparent); }
  .rswt { flex: 1; min-width: 0; display: grid; }
  .rswt small { font-size: 12.5px; font-weight: 600; line-height: 1.35; color: var(--ui-text2); }
  .rsw.off small, .rsw.armed small { color: color-mix(in srgb, ${TONE_COLORS.warn} 55%, var(--ui-text)); }
  .sw { flex: none; width: 48px; height: 30px; border-radius: 15px; background: var(--ui-soft2); position: relative; transition: background 0.2s; }
  .sw::after { content: ""; position: absolute; top: 4px; left: 4px; width: 22px; height: 22px; border-radius: 50%;
    background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform 0.3s var(--ui-spring); }
  .rsw[aria-checked="true"] .sw { background: color-mix(in srgb, var(--ui-accent) 88%, #000); }
  .rsw[aria-checked="true"] .sw::after { transform: translateX(18px); }
  .rsw.armed .sw { background: color-mix(in srgb, ${TONE_COLORS.warn} 88%, #000); }
  .rfoot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 12px; margin-top: 12px; }
  .rreason { flex: 1 1 160px; min-width: 0; display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
    line-height: 1.35; color: var(--ui-text2); --mdc-icon-size: 16px; }
  .rreason ha-icon { flex: none; }
  /* One action colour in every popup (not the guard's state tone: red on an
     escalated guard, green on a healthy one). */
  .rrepair { --pill: var(--ui-accent); }
  .rrepair[aria-disabled="true"] { cursor: not-allowed; box-shadow: none; opacity: 0.5; }
  .rrepair[aria-disabled="true"]:active { transform: none; }
  @media (max-width: ${SHEET_MAX_WIDTH - 1}px) {
    .rfoot .rrepair { flex: 1 1 100%; }
  }
`;

// Text in a tone: the tone pulled toward the text colour (orange or green on
// the pale surface alone is below 4.5:1), grey tones as secondary text.
const toneText = (tone) => {
  if (!tone || tone === "neutral") return "var(--ui-text)";
  const c = core.toneTextColor(tone);
  return c === core.toneTextColor("idle") ? c : `color-mix(in srgb, ${c} 62%, var(--ui-text))`;
};
// Rows whose value is itself a verdict (drawn in its tone); the others keep
// the text colour and show their tone on the icon only.
const TONED_VALUES = new Set(["port_status"]);

// The link's words with the chevron glued to the last one.
const linkText = (value) => {
  const v = String(value ?? "");
  const i = v.lastIndexOf(" ");
  const head = i > 0 ? `${esc(v.slice(0, i))} ` : "";
  const last = i > 0 ? v.slice(i + 1) : v;
  return `<span class="rlt">${head}<span class="nw">${esc(last)}<ha-icon icon="mdi:chevron-right" aria-hidden="true"></ha-icon></span></span>`;
};

/** The order the first focus looks for: the target link, the switch, the repair, close. */
const FIRST_FOCUS = [".rlink", ".rsw", ".rrepair:not([aria-disabled])", "[data-action='rec-close']"];
const FOCUSABLE = "button, [href], input, [tabindex]:not([tabindex='-1'])";

/**
 * The popup's inner markup from a core.recoveryModel result. `ui`: {name (the
 * guard), autoArmed, repairArmed, running (the repair call is out)}. Pure.
 */
export function recoveryHtml(model, lang, ui = {}) {
  const head = `
    <div class="rhead">
      <span class="rbub" aria-hidden="true"><ha-icon icon="${esc(model.target.icon)}"></ha-icon></span>
      <div class="rttl"><h2 id="rec-title" tabindex="-1" data-key="title">${esc(model.title)}</h2>${ui.name ? `<div class="rname" title="${esc(ui.name)}">${esc(ui.name)}</div>` : ""}</div>
      <button class="pill neutral round" data-action="rec-close" data-key="close" aria-label="${esc(t(lang, "ui.close"))}" title="${esc(t(lang, "ui.close"))}"><ha-icon icon="mdi:close"></ha-icon></button>
    </div>`;
  if (model.notice) {
    return `${head}<div class="rnotice"><ha-icon icon="mdi:bell-outline" aria-hidden="true"></ha-icon><span>${esc(model.notice)}</span></div>`;
  }
  const rows = model.rows
    .map((r) => {
      const tone = TONE_COLORS[r.tone] || TONE_COLORS.idle;
      const value = r.entity
        ? `<button class="rlink" data-action="rec-link" data-entity="${esc(r.entity)}" data-key="link-${esc(r.id)}" title="${esc(`${t(lang, "ui.rec.open")}: ${r.entity}`)}">${linkText(r.value)}</button>`
        : `<div class="rval"${TONED_VALUES.has(r.id) ? ` style="--tt:${toneText(r.tone)}"` : ""}>${esc(r.value)}</div>`;
      // The PoE "how found" line is the row's verdict: drawn in its tone.
      const sub = r.sub ? `<div class="rsub" style="--tt:${toneText(r.subTone || r.tone)}">${esc(r.sub)}</div>` : "";
      return `<div class="rrow" data-row="${esc(r.id)}"><span class="ricon" style="--tone:${tone}" aria-hidden="true"><ha-icon icon="${esc(r.icon)}"></ha-icon></span><div class="rtxt"><div class="rlabel">${esc(r.label)}</div>${value}${sub}</div></div>`;
    })
    .join("");
  let auto = "";
  if (model.auto && ui.readOnly) {
    // "Show actions" off: the state as plain information, nothing to switch.
    const a = model.auto;
    auto = `<div class="rrow" data-row="auto"><span class="ricon" style="--tone:${a.on ? TONE_COLORS.idle : TONE_COLORS.warn}" aria-hidden="true"><ha-icon icon="${a.on ? "mdi:robot" : "mdi:robot-off"}"></ha-icon></span><div class="rtxt"><div class="rlabel">${esc(a.label)}</div><div class="rval">${esc(t(lang, a.on ? "ui.rec.auto_on" : "ui.rec.auto_off_sub"))}</div></div></div>`;
  } else if (model.auto) {
    const a = model.auto;
    const armed = Boolean(ui.autoArmed) && a.on;
    const sub = armed ? `${a.confirmOff} ${t(lang, "ui.rec.tap_again")}` : a.on ? "" : t(lang, "ui.rec.auto_off_sub");
    auto = `<button class="rsw${a.on ? "" : " off"}${armed ? " armed" : ""}" role="switch" aria-checked="${a.on}" data-action="rec-auto" data-key="auto">
      <span class="ricon" aria-hidden="true"><ha-icon icon="${a.on ? "mdi:robot" : "mdi:robot-off"}"></ha-icon></span>
      <span class="rswt"><span>${esc(armed ? t(lang, "action.sure") : a.label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</span><i class="sw" aria-hidden="true"></i></button>`;
  }
  let foot = "";
  if (model.repair && !ui.readOnly) {
    const r = model.repair;
    const busy = Boolean(ui.running);
    const enabled = r.enabled && !busy;
    const armed = enabled && Boolean(ui.repairArmed);
    const reason = !r.enabled && r.reason ? `<div class="rreason" id="rec-reason"><ha-icon icon="mdi:information-outline" aria-hidden="true"></ha-icon><span>${esc(r.reason)}</span></div>` : "";
    const dis = enabled ? "" : ` aria-disabled="true"${reason ? ` aria-describedby="rec-reason"` : ""}`;
    foot = `<div class="rfoot">${reason}<button class="pill strong rrepair${armed ? " confirm" : ""}" data-action="rec-repair" data-key="repair"${dis}><ha-icon icon="mdi:wrench"></ha-icon><span class="label">${esc(armed ? t(lang, "action.sure") : r.label)}</span></button></div>`;
  }
  return `${head}<div class="rlist">${rows}</div>${auto}${foot}`;
}

/**
 * Where the anchored popup goes: right-aligned under the chip, above it when
 * there is no room below, always inside the viewport (8 px margin). A 12 px
 * gap to the chip (with the dimmed backdrop) keeps it apart from the card it
 * partly covers. Pure.
 */
export function placeNear(rect, w, h, vw, vh) {
  const GAP = 12;
  const left = Math.max(8, Math.min(rect.right - w, vw - w - 8));
  const below = rect.bottom + GAP;
  let top = below;
  if (below + h > vh - 8) top = rect.top - h - GAP >= 8 ? rect.top - h - GAP : Math.max(8, vh - h - 8);
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * The popup of one guard card. `host` is the card (its shadow root holds the
 * <dialog>), `el` the dialog. `model()` returns {model, lang, ui} for a render.
 * Clicks inside bubble to the card's own delegated click handler.
 */
export class RecoveryDialog {
  constructor(host, el, model) {
    this.host = host;
    this.el = el;
    this.model = model;
    this.anchor = null; // selector of the chip that opened it
    this.html = null;
    this._onResize = () => this.place();
    // The close event is queued: after reattach() it arrives for a dialog that
    // is open again and must not empty it.
    el.addEventListener("close", () => {
      if (!this.el.open) this._closed();
    });
    // A click on the backdrop lands on the dialog itself (the box fills it).
    el.addEventListener("click", (ev) => {
      if (ev.target === el) this.close();
    });
    // Tab cycles inside the popup (a modal <dialog> alone lets one Tab stop
    // go to the browser's own UI). Any key or tap ends the automatic first
    // focus (see refresh()).
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab") this._trap(ev);
      else this._auto = false;
    });
    el.addEventListener("pointerdown", () => {
      this._auto = false;
    });
    this._auto = false;
  }

  _focusables() {
    return [...this.el.querySelectorAll(FOCUSABLE)].filter((x) => !x.hidden && x.getClientRects().length > 0);
  }

  _trap(ev) {
    this._auto = false;
    const list = this._focusables();
    if (!list.length) return;
    const active = this.host.shadowRoot.activeElement;
    const i = list.indexOf(active);
    let next = null;
    if (ev.shiftKey && i <= 0) next = list[list.length - 1];
    else if (!ev.shiftKey && (i === -1 || i === list.length - 1)) next = list[0];
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  }

  /** The first focus: the target link, else the switch, else close. */
  _focusFirst() {
    const first = FIRST_FOCUS.map((sel) => this.el.querySelector(sel)).find(Boolean);
    if (first && first.focus) first.focus();
  }

  get isOpen() {
    return Boolean(this.anchor);
  }

  open(anchorSel) {
    this.anchor = anchorSel;
    this.html = null;
    this.refresh();
    if (!this.el.open) {
      try {
        this.el.showModal();
      } catch (_err) {
        this.el.setAttribute("open", "");
      }
    }
    this.place();
    window.addEventListener("resize", this._onResize, { passive: true });
    // The first thing to do: the target link, else the switch, else close.
    // A PoE popup gets its link only with the WS answer: meanwhile the title
    // holds the focus (read out as the dialog's name), and the answer moves
    // it on to the link unless the user did something first.
    if (this._loading) {
      this._auto = true;
      const h = this.el.querySelector("#rec-title");
      if (h) h.focus();
    } else {
      this._auto = false;
      this._focusFirst();
    }
  }

  /** Re-render the content (only when it changed), keeping the focus. */
  refresh() {
    if (!this.anchor) return;
    const { model, lang, ui } = this.model();
    this._loading = Boolean(model.loading);
    const html = `<div class="rbox" role="document">${recoveryHtml(model, lang, ui)}</div>`;
    if (html === this.html) return;
    this.html = html;
    const active = this.host.shadowRoot.activeElement;
    const key = active && this.el.contains(active) ? active.getAttribute("data-key") : null;
    this.el.setAttribute("aria-labelledby", "rec-title");
    this.el.innerHTML = html;
    if (this._auto && !this._loading && this.el.open) {
      // The WS answer is in and the user has not moved yet: on to the link.
      this._auto = false;
      this._focusFirst();
    } else if (key) {
      const again = this.el.querySelector(`[data-key="${key}"]`);
      if (again) again.focus();
    }
    if (this.el.open) this.place();
  }

  place() {
    if (!this.anchor) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sheet = vw < SHEET_MAX_WIDTH;
    this.el.classList.toggle("sheet", sheet);
    if (sheet) {
      this.el.style.left = "";
      this.el.style.top = "";
      return;
    }
    const box = this.el.firstElementChild;
    const a = this.host.shadowRoot.querySelector(this.anchor);
    const r = a && a.getBoundingClientRect();
    if (!box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    // The chip scrolled out (or is gone after a re-render): centre it.
    const rect = r && (r.width || r.height) ? r : { top: vh / 2 - h / 2 - 8, bottom: vh / 2 - h / 2 - 8, right: vw / 2 + w / 2 };
    const { left, top } = placeNear(rect, w, h, vw, vh);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  close() {
    if (this.el.open) this.el.close();
    else this._closed();
  }

  _closed() {
    if (!this.anchor) return;
    const sel = this.anchor;
    this.anchor = null;
    this.html = null;
    this._auto = false;
    this.el.innerHTML = "";
    window.removeEventListener("resize", this._onResize);
    const a = this.host.shadowRoot.querySelector(sel);
    if (a && a.focus) a.focus({ preventScroll: true });
    if (typeof this.onClose === "function") this.onClose();
  }

  /** After the card was moved in the DOM (a list re-sorted): modal again. */
  reattach() {
    if (!this.anchor) return;
    if (this.el.open) {
      try {
        this.el.close();
      } catch (_err) {
        // not open after all
      }
    }
    const sel = this.anchor;
    this.anchor = null;
    this.open(sel);
  }
}
