// Guards card (necromancer-guards-card), design §6: every guard (or
// a filtered set) with problems first, quiet guards folded into one group, a
// header with count bubbles (tap = narrow the list for now), a search field and
// the bulk actions (only when unfiltered).
//
// Rows are guard cards in `layout: compact` that open into the full
// card in place. Options: `display: list | cards` (cards = the panel's
// masonry of full cards for everything that is not quiet; `timeline: true`
// gives those full cards the 24 h section, default off like the guard card's
// own option), `show_header: false`
// and `bulk: false` (the panel draws its own header), `row_detail` (what a
// collapsed row shows: "timeline" = the thin 24 h strip, default, one batched
// query for the visible rows; "text" = the last event, no history query at
// all; the old `show_timeline` reads as either), `show_actions` (false: no
// buttons and no bulk actions either), and `setView()` for a host that
// narrows the list from outside. An opened row always shows the 24 h section
// and the text (one query for that guard, cached).
//
// Wide lists: the rows take the card's full width; from ~900 px of row width
// each row is a column grid (name/state | value | last event or 24 h strip |
// actions, see the guard card). The name and value columns are as wide as the
// longest name and value in the list (measured here into --nc-name-w and
// --nc-val-w, which the row cards inherit), so the columns line up from row
// to row and the value sits right after the names instead of floating in an
// empty middle.
//
// Speed (design §6 "Leistung"): discovery is memoised on the entity registry,
// the order and the counts only move when a guard's status object changes,
// the folded quiet group creates no cards at all, each row card re-renders only
// on its own entities, and nothing happens while the card is out of view.

// Loaded with this module's own query, so `?v=` reaches the shared base and
// the sibling modules too (one version, one instance of each per page).
const Q = new URL(import.meta.url).search;
const { BASE_STYLE, Confirm, Pop, TAGS, actions, checkSharedOptions, core, defaultSelect, docLang, esc, langFrom, rowDetail, rowDetailField, sameSig, sharedFormLabel, snoozeItems, t, withRowDetail } = await import(`./necromancer-base.js${Q}`);
await import(`./necromancer-guard-card.js${Q}`);

const { runAction } = actions;

const STYLE = `
  ${BASE_STYLE}
  ha-card {
    border-radius: var(--ui-radius); overflow: hidden; box-sizing: border-box;
    container-type: inline-size;
  }
  :host([bare]) ha-card { background: none; box-shadow: none; border: none; overflow: visible; }

  /* ---- header: state gradient and bubbles in the compact sizes ---- */
  .head {
    padding: 14px 14px 10px;
    background: radial-gradient(130% 180px at 0% 0%, color-mix(in srgb, var(--hc) 24%, transparent),
      transparent 70%);
  }
  .head[hidden] { display: none; }
  .top { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
  .hb {
    flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--hc) 88%, #000); color: var(--ui-on); --mdc-icon-size: 24px;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--hc) 32%, transparent);
  }
  .ttl { flex: 1 1 160px; min-width: 0; }
  .title { font-size: 18px; font-weight: 800; line-height: 1.25; letter-spacing: -0.015em; color: var(--ui-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 12.5px; font-weight: 600; line-height: 1.35; color: var(--ui-text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search {
    flex: 1 1 220px; max-width: 340px; display: flex; align-items: center; gap: 8px; height: 40px;
    padding: 0 4px 0 12px; border-radius: 20px; background: var(--ui-soft); box-sizing: border-box;
    color: var(--ui-text2); --mdc-icon-size: 19px;
  }
  .search:focus-within { background: var(--ui-soft2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent) 45%, transparent); }
  .search input {
    flex: 1; min-width: 0; height: 100%; border: none; background: none; outline: none;
    font: inherit; font-size: 14px; color: var(--ui-text);
  }
  .search input::-webkit-search-cancel-button, .search input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }
  .search input::placeholder { color: var(--ui-text2); }
  .search .x { width: 32px; height: 32px; border-radius: 50%; border: none; background: none; cursor: pointer;
    display: grid; place-items: center; color: var(--ui-text2); padding: 0; --mdc-icon-size: 18px; }
  .search .x[hidden] { display: none; }
  /* Counts and bulk actions share one line when there is room (bulk right),
     the bulk pills wrap below on a narrow card. */
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 10px; }
  .bar[hidden] { display: none; }
  .counts { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .counts:empty { display: none; }
  .cnt {
    --c: var(--ui-accent);
    display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 12px 0 4px;
    border-radius: 17px; border: none; cursor: pointer;
    background: color-mix(in srgb, var(--c) 15%, transparent); color: var(--ui-text);
    font-size: 13px; font-weight: 700; white-space: nowrap;
    transition: transform 0.25s var(--ui-spring), background 0.2s ease;
  }
  .cnt b {
    min-width: 26px; height: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 13px;
    display: grid; place-items: center; font-size: 13px; font-weight: 800;
    background: color-mix(in srgb, var(--c) 88%, #000); color: var(--ui-on);
  }
  .cnt:hover { background: color-mix(in srgb, var(--c) 26%, transparent); }
  .cnt:active { transform: scale(0.92); }
  .cnt[aria-pressed="true"] { background: color-mix(in srgb, var(--c) 88%, #000); color: var(--ui-on); }
  .cnt[aria-pressed="true"] b { background: rgba(255, 255, 255, 0.25); }
  .bulk { display: flex; flex-wrap: wrap; gap: 6px; }
  .bulk:empty { display: none; }
  .bulk .pill { --ui-pill-h: 34px; }
  .pill.snz { --pill: ${core.SNOOZE_COLOR}; }

  /* ---- body: the rows use the card's full width ---- */
  .body { padding: 2px 10px 10px; }
  :host([bare]) .body { padding: 0; }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .masonry { display: flex; gap: 12px; align-items: flex-start; }
  .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .list:empty, .masonry:empty { display: none; }
  .quiet { margin-top: 8px; }
  .quiet[hidden] { display: none; }
  .qhead {
    display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 4px 6px;
    border: none; border-radius: 22px; cursor: pointer; background: none; color: var(--ui-text2);
    font-size: 13.5px; font-weight: 800; letter-spacing: 0.02em; box-sizing: border-box;
  }
  .qhead:hover { background: var(--ui-soft); }
  .qhead .qdot {
    flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; --mdc-icon-size: 18px;
    background: color-mix(in srgb, ${core.stateColor("ok")} 20%, transparent); color: ${core.stateColor("ok")};
  }
  .qhead .line { flex: 1; min-width: 12px; height: 2px; border-radius: 1px; background: var(--ui-soft2); }
  .qhead .qtog { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 5px 12px; border-radius: 16px;
    background: var(--ui-soft); color: var(--ui-text); --mdc-icon-size: 18px; }
  .qhead ha-icon.chev { transition: transform 0.3s var(--ui-spring); }
  .qhead[aria-expanded="true"] ha-icon.chev { transform: rotate(180deg); }
  .qlist { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .qlist:empty { display: none; }
  .cards .qlist { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 8px; align-items: start; }
  .empty { padding: 24px 16px; text-align: center; color: var(--ui-text2); font-weight: 600; display: grid; gap: 12px; justify-items: center; }
  .empty[hidden] { display: none; }
  .empty ha-icon { --mdc-icon-size: 40px; color: color-mix(in srgb, var(--ui-text2) 60%, transparent); }

  /* Wide card: the bulk pills move to the right end of the counts line. */
  @container (min-width: 700px) {
    .bulk { margin-left: auto; }
  }
  /* Phone: the search takes its own full line under the title. */
  @container (max-width: 520px) {
    .head { padding: 12px 12px 8px; }
    .search { max-width: none; flex-basis: 100%; }
    .body { padding: 2px 8px 8px; }
  }
`;

const SHOWN_STATES = [...core.GUARD_STATES, "unavailable"];

/**
 * Problems-first order, but the escalated block newest first (by when the
 * guard escalated: its `escalated_at`, which survives an HA restart, else
 * last_changed): a fresh escalation leads instead of hiding among old ones
 * that were already seen. Other modes and states keep the shared order.
 */
export function newestEscalationsFirst(order, hass, sort) {
  if (sort !== "problems") return order;
  const so = (id) => hass.states[id];
  const escalated = order.filter((id) => so(id) && so(id).state === "escalated");
  if (escalated.length < 2) return order;
  const at = (id) => {
    const s = so(id);
    const d = core.toDate((s.attributes || {}).escalated_at) || core.toDate(s.last_changed);
    return d ? d.getTime() : 0;
  };
  const sorted = escalated.map((id, i) => ({ id, i, t: at(id) })).sort((x, y) => y.t - x.t || x.i - y.i);
  let k = 0;
  return order.map((id) => (so(id) && so(id).state === "escalated" ? sorted[k++].id : id));
}

/**
 * Config of one row card (a compact guard card that opens in place, or a full
 * card in the `cards` display): the list options it shares with the guards
 * card. `row_detail` is always written out ("text" = the row asks for no
 * history), `timeline: true` on a full card only when the guards card asks
 * for it (`timeline: true`, default off like the guard card's own option;
 * the `cards` display used to force it).
 */
export function rowConfig(cfg, id, compact) {
  const ve = cfg.value_entities && cfg.value_entities[id];
  const out = {
    entity: id,
    layout: compact ? "compact" : "full",
    expandable: compact,
    embedded: true,
    show_counters: Boolean(cfg.show_counters),
    show_footer: cfg.show_footer !== false,
    show_actions: core.actionsShown(cfg.show_actions),
    row_detail: rowDetail(cfg),
  };
  if (!compact && cfg.timeline === true) out.timeline = true;
  if (typeof ve === "string" && ve) out.value_entity = ve;
  return out;
}

/** Validate a guards card config and fill in the defaults (throws on errors). */
export function normalizeConfig(config) {
  // "" is the form editor's default entry (see defaultSelect): the default.
  const c = { ...(config || {}) };
  for (const k of ["sort", "display", "row_detail"]) if (c[k] === "") delete c[k];
  if (c.sort != null && !core.SORT_MODES.includes(c.sort)) {
    throw new Error(`sort must be one of ${core.SORT_MODES.join(", ")}`);
  }
  if (c.filter != null && (typeof c.filter !== "object" || Array.isArray(c.filter))) {
    throw new Error("filter must be a mapping (states, types, area, label)");
  }
  if (c.entities != null && !Array.isArray(c.entities)) throw new Error("entities must be a list");
  if (c.value_entities != null && (typeof c.value_entities !== "object" || Array.isArray(c.value_entities))) {
    throw new Error("value_entities must map status sensors to value entities");
  }
  if (c.display != null && !["list", "cards"].includes(c.display)) throw new Error("display must be list or cards");
  if (c.timeline != null && typeof c.timeline !== "boolean") throw new Error("timeline must be true or false");
  checkSharedOptions(c);
  // A list's rows show the 24 h strip unless told otherwise (design §16: one
  // batched history query, ~40 ms for 67 guards); an old explicit
  // `show_timeline: false` keeps the text.
  if (c.row_detail == null || c.row_detail === "") c.row_detail = c.show_timeline === false ? "text" : "timeline";
  if (c.show_actions != null) c.show_actions = core.actionsShown(c.show_actions);
  return withRowDetail({
    sort: "problems",
    collapse_ok: false,
    show_counters: false,
    show_footer: true,
    show_actions: true,
    display: "list",
    show_header: true,
    bulk: true,
    ...c,
  });
}

const FORM_LABELS = {
  title: { en: "Title", de: "Titel" },
  sort: { en: "Sort order", de: "Sortierung" },
  display: { en: "Display", de: "Darstellung" },
  collapse_ok: { en: "Fold quiet guards into a group", de: "Ruhige Guards zusammenklappen" },
  show_counters: { en: "Show counters", de: "Zähler zeigen" },
  show_footer: { en: "Show last event", de: "Letztes Ereignis zeigen" },
  timeline: { en: "Show 24 h timeline", de: "Zeitverlauf anzeigen" },
  show_actions: { en: "Show actions", de: "Aktionen anzeigen" },
  bulk: { en: "Bulk actions (only without filter)", de: "Sammelaktionen (nur ohne Filter)" },
};

const FORM_HELPERS = {
  title: { en: "Default: All guards.", de: "Standard: Alle Guards." },
  sort: { en: "Default: problems first, then name.", de: "Standard: Probleme zuerst, dann Name." },
  display: { en: "List (default): one row per guard. Cards: a full card per guard.", de: "Liste (Standard): eine Zeile je Guard. Karten: eine volle Karte je Guard." },
  row_detail: {
    en: "Under each name: a thin 24 h strip (default) or the last event. With Cards: only the rows of the folded quiet group.",
    de: "Unter jedem Namen: ein schmaler 24-h-Streifen (Standard) oder das letzte Ereignis. Bei Karten: nur die Zeilen der zugeklappten ruhigen Gruppe.",
  },
  timeline: {
    en: "Cards: the last 24 h (strip, time axis, latest changes) on every full card. Default: off.",
    de: "Karten: die letzten 24 h (Streifen, Zeitachse, letzte Wechsel) auf jeder vollen Karte. Standard: aus.",
  },
  show_actions: {
    en: "Each guard's main button and Snooze, the rest in its ⋮ menu. Off: nothing can be triggered.",
    de: "Je Guard der Hauptknopf und Snooze, der Rest im ⋮-Menü. Aus: Nichts lässt sich auslösen.",
  },
  bulk: { en: "Filter, a fixed list of guards and the value per guard: in the YAML editor, see the docs.", de: "Filter, feste Guard-Liste und Wert je Guard: im YAML-Editor, siehe Doku." },
};

const SORT_LABELS = {
  problems: { en: "Problems first", de: "Probleme zuerst" },
  name: { en: "Name", de: "Name" },
  state: { en: "State", de: "Zustand" },
  last_activity: { en: "Last activity", de: "Letzte Aktivität" },
};

/**
 * Schema for HA's form editor (`getConfigForm`, the supported way: HA draws
 * the form). Keys the form does not show (filter, entities, value_entities)
 * stay in the YAML untouched. The form's `visible` conditions: "Show 24 h
 * timeline" only with Display "Cards"; "Row shows" only where there are rows
 * (Display "List", or "Cards" with the folded quiet group). An unset select
 * shows empty in HA's form, so each helper names its default.
 */
export function configForm(lang) {
  const l = lang === "de" ? "de" : "en";
  const cards = { field: "display", value: "cards" };
  return {
    schema: [
      { name: "title", selector: { text: {} } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "sort", selector: defaultSelect(core.SORT_MODES.map((m) => ({ value: m, label: (SORT_LABELS[m] || { [l]: m })[l] || m }))) },
          {
            name: "display",
            selector: defaultSelect([
              { value: "list", label: l === "de" ? "Liste" : "List" },
              { value: "cards", label: l === "de" ? "Karten" : "Cards" },
            ]),
          },
        ],
      },
      { ...rowDetailField(l), visible: { condition: "or", conditions: [{ ...cards, operator: "not_eq" }, { field: "collapse_ok", value: true }] } },
      { name: "timeline", default: false, selector: { boolean: {} }, visible: cards },
      { name: "collapse_ok", default: false, selector: { boolean: {} } },
      { name: "show_counters", default: false, selector: { boolean: {} } },
      { name: "show_footer", default: true, selector: { boolean: {} } },
      { name: "show_actions", default: true, selector: { boolean: {} } },
      { name: "bulk", default: true, selector: { boolean: {} } },
    ],
    computeLabel: (item) => {
      const lab = FORM_LABELS[item.name];
      return lab ? lab[l] : sharedFormLabel(item.name, l);
    },
    computeHelper: (item) => (FORM_HELPERS[item.name] ? FORM_HELPERS[item.name][l] : undefined),
  };
}

export class NecromancerGuardsCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._discover = core.createGuardDiscovery();
    this._view = { state: null, search: "" };
    this._quietOpen = false;
    this._visible = true;
    this._stale = false;
    this._sig = null;
    this._cards = new Map(); // status entity -> {el, key}
    this._layoutKey = { main: "", quiet: "" };
    this._cols = 1;
    this._counts = null;
    this._io = null;
    this._ro = null;
    this._htmlCache = {};
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="top">
            <div class="hb" aria-hidden="true"><ha-icon icon="mdi:skull-crossbones"></ha-icon></div>
            <div class="ttl"><div class="title"></div><div class="sub"></div></div>
            <label class="search">
              <ha-icon icon="mdi:magnify"></ha-icon>
              <input type="search" autocomplete="off" spellcheck="false" />
              <button class="x" data-action="clear-search" hidden><ha-icon icon="mdi:close"></ha-icon></button>
            </label>
          </div>
          <div class="bar">
            <div class="counts" role="group"></div>
            <div class="bulk"></div>
          </div>
        </div>
        <div class="body">
          <div class="main list"></div>
          <div class="quiet" hidden>
            <button class="qhead" data-action="quiet" aria-expanded="false"></button>
            <div class="qlist"></div>
          </div>
          <div class="empty" hidden></div>
        </div>
      </ha-card>
      <div class="pop" hidden role="menu"></div>`;
    const $ = (s) => root.querySelector(s);
    this._el = {
      card: $("ha-card"),
      head: $(".head"),
      title: $(".title"),
      sub: $(".sub"),
      input: $("input"),
      x: $(".x"),
      bar: $(".bar"),
      counts: $(".counts"),
      bulk: $(".bulk"),
      body: $(".body"),
      main: $(".main"),
      quiet: $(".quiet"),
      qhead: $(".qhead"),
      qlist: $(".qlist"),
      empty: $(".empty"),
    };
    this._pop = new Pop(this, $(".pop"));
    this._confirm = new Confirm(() => this._update(true));
    root.addEventListener("click", (ev) => this._click(ev));
    this._el.input.addEventListener("input", () => {
      this._view = { ...this._view, search: this._el.input.value };
      this._update(true);
    });
  }

  // ------------------------------------------------------------ card API

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._el.body.classList.toggle("cards", this._config.display === "cards");
    this._el.main.className = `main ${this._config.display === "cards" ? "masonry" : "list"}`;
    this._layoutKey = { main: "", quiet: "" };
    // Row configs follow the card's: rebuilt on the next sync.
    for (const entry of this._cards.values()) entry.key = null;
    this._update(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._visible) {
      this._stale = true;
      return;
    }
    this._update(false);
  }

  get hass() {
    return this._hass;
  }

  /** Narrow the list from outside (the panel's counts and search). */
  setView(view = {}) {
    this._view = { state: view.state || null, search: view.search || "" };
    if (this._el.input.value !== this._view.search) this._el.input.value = this._view.search;
    this._update(true);
  }

  get view() {
    return { ...this._view };
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  static getStubConfig() {
    // The selects written out: HA's dropdown shows an unset select empty.
    return { sort: "problems", display: "list", row_detail: "timeline" };
  }

  /** The editor: HA's own form from this schema (HA calls it without arguments). */
  static getConfigForm() {
    return configForm(docLang());
  }

  connectedCallback() {
    if (!this._io && typeof IntersectionObserver !== "undefined") {
      this._io = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible === this._visible) return;
        this._visible = visible;
        if (visible && this._stale) {
          this._stale = false;
          this._update(false);
        }
      });
      this._io.observe(this);
    }
    if (!this._ro && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._relayout());
      this._ro.observe(this._el.body);
    }
  }

  disconnectedCallback() {
    if (this._io) this._io.disconnect();
    if (this._ro) this._ro.disconnect();
    if (this._measureRaf) cancelAnimationFrame(this._measureRaf);
    this._measureRaf = null;
    this._io = null;
    this._ro = null;
    this._pop.close();
    this._confirm.clear();
  }

  // ------------------------------------------------------------ update

  _update(force) {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !hass.states || !cfg) return;
    const lang = langFrom(hass);
    const ids = this._discover(hass);
    const base = core.filterGuards(ids, hass, cfg);
    // Whether any guard exists at all: an empty filtered list ("only
    // problems") then means "all fine", not "add a guard".
    this._anyGuard = ids.length > 0;
    const sig = [
      lang,
      hass.user && hass.user.is_admin,
      ...base.map((id) => hass.states[id]),
      base.length,
      this._anyGuard,
    ];
    if (force || !sameSig(sig, this._sig)) {
      this._sig = sig;
      this._rebuild(base, lang);
      this._measureDue = true;
    }
    for (const { el } of this._cards.values()) el.hass = hass;
    if (this._measureDue) this._scheduleMeasure();
  }

  _scheduleMeasure() {
    this._measureDue = false;
    if (this._measureRaf || typeof requestAnimationFrame === "undefined") return;
    this._measureRaf = requestAnimationFrame(() => {
      this._measureRaf = null;
      this._measureColumns();
    });
  }

  /**
   * Width of the longest name/status line and of the widest value of the
   * compact rows, measured on a canvas (no layout read), into two CSS
   * variables the rows' wide grid uses. Values tick, so they get some slack.
   */
  _measureColumns() {
    if (!this.isConnected) return;
    const rows = [];
    for (const { el } of this._cards.values()) {
      const row = el.shadowRoot && el.shadowRoot.querySelector(".row");
      if (row) rows.push(row);
    }
    if (!rows.length) return;
    if (!this._ctx2d) {
      const c = document.createElement("canvas");
      this._ctx2d = c.getContext && c.getContext("2d");
      if (!this._ctx2d) return;
    }
    const ctx = this._ctx2d;
    const fontOf = (el) => {
      const cs = getComputedStyle(el);
      return `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    };
    // Each font from the first row that has the element (a busy guard on top
    // has no pill).
    const fonts = {};
    for (const [k, sel] of [["name", ".name"], ["status", ".status"], ["value", ".cvalue"], ["pill", ".ract .pill"]]) {
      for (const row of rows) {
        const el = row.querySelector(sel);
        if (el) {
          fonts[k] = fontOf(el);
          break;
        }
      }
    }
    const width = (font, text) => {
      if (!font || !text) return 0;
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    let nameW = 0;
    let valW = 0;
    let actW = 0;
    let chips = 0;
    for (const row of rows) {
      // The main and the snooze pill: each padding 2 x 14, icon 19 and gap 7
      // around its label, 4 px between them (the snooze pills line up right).
      const labels = [...row.querySelectorAll(".ract .pill .label")];
      if (labels.length) actW = Math.max(actW, labels.reduce((w, l) => w + width(fonts.pill, l.textContent.trim()) + 54, 0) + 4 * (labels.length - 1));
      else if (row.querySelector(".ract .pill")) actW = Math.max(actW, 34);
      const health = row.querySelector(".rhealth");
      if (health) chips = Math.max(chips, health.children.length);
      const name = row.querySelector(".name");
      const status = row.querySelector(".status");
      const value = row.querySelector(".cvalue");
      nameW = Math.max(nameW, width(fonts.name, name && name.textContent.trim()));
      // The status line has a dot (7 px) and a gap (6 px) before its text.
      nameW = Math.max(nameW, width(fonts.status, status && status.textContent.trim()) + 13);
      valW = Math.max(valW, width(fonts.value, value && value.textContent.trim()));
    }
    const nw = `${Math.ceil(nameW) + 6}px`;
    const vw = `${Math.ceil(valW) + 22 + 14}px`; // pill padding + room for a ticking digit
    // Slack for "Sure?" and a bolder confirm state; chips are 34 px with 5 px gaps.
    // No row with a pill (show_actions false, or all busy): no button column.
    const aw = `${actW ? Math.ceil(actW) + 4 : 0}px`;
    const cw = `${Math.max(1, chips) * 39 - 5}px`;
    const st = this._el.body.style;
    for (const [k, v] of [["--nc-name-w", nw], ["--nc-val-w", vw], ["--nc-act-w", aw], ["--nc-chip-w", cw]]) {
      if (st.getPropertyValue(k) !== v) st.setProperty(k, v);
    }
  }

  _rebuild(base, lang) {
    const hass = this._hass;
    const cfg = this._config;
    const view = this._view;
    const counts = core.countByState(base, hass);
    this._counts = counts;
    this._renderHead(counts, lang);

    const narrowed = Boolean(view.state || view.search);
    const shown = narrowed ? core.filterGuards(base, hass, {}, view) : base;
    const order = newestEscalationsFirst(core.sortGuards(shown, hass, cfg.sort, lang), hass, cfg.sort);
    // Fold the quiet ones, except when the user asked for them (search, chip).
    const fold = cfg.collapse_ok && !narrowed;
    const main = fold ? order.filter((id) => !core.isQuiet(hass.states[id] && hass.states[id].state)) : order;
    const quiet = fold ? order.filter((id) => core.isQuiet(hass.states[id] && hass.states[id].state)) : [];
    const quietShown = this._quietOpen ? quiet : [];

    this._syncCards(main, quietShown);

    // Quiet group header.
    this._el.quiet.hidden = quiet.length === 0;
    if (quiet.length) {
      const html = `<span class="qdot"><ha-icon icon="mdi:check-all"></ha-icon></span>
        <span>${esc(t(lang, "group.quiet", { n: quiet.length }))}</span><span class="line"></span>
        <span class="qtog">${esc(t(lang, this._quietOpen ? "ui.quiet_hide" : "ui.quiet_show"))}<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></span>`;
      this._setHtml("qhead", this._el.qhead, html);
      this._el.qhead.setAttribute("aria-expanded", String(this._quietOpen));
    }

    // Empty states.
    let empty = "";
    if (!base.length && this._anyGuard && !core.isUnfiltered(this._config)) {
      empty = `<ha-icon icon="mdi:check-circle-outline"></ha-icon><div>${esc(t(lang, "panel.filter_clear"))}</div>`;
    } else if (!base.length) {
      empty = `<ha-icon icon="mdi:shield-search"></ha-icon><div>${esc(t(lang, "panel.empty"))}</div>`;
    } else if (!shown.length) {
      empty = `<ha-icon icon="mdi:magnify-close"></ha-icon><div>${esc(t(lang, "panel.no_match"))}</div>
        <button class="pill neutral" data-action="clear-view"><ha-icon icon="mdi:filter-remove"></ha-icon><span>${esc(t(lang, "ui.clear_filter"))}</span></button>`;
    }
    this._el.empty.hidden = !empty;
    this._setHtml("empty", this._el.empty, empty);
    this._pop.refresh();
  }

  _setHtml(key, el, html) {
    if (this._htmlCache[key] === html) return;
    this._htmlCache[key] = html;
    el.innerHTML = html;
  }

  _renderHead(counts, lang) {
    const cfg = this._config;
    const el = this._el;
    el.head.hidden = cfg.show_header === false;
    if (cfg.show_header === false) return;
    const worst = core.ATTENTION_STATES.find((s) => counts[s] > 0);
    el.head.style.setProperty("--hc", core.stateColor(worst || "ok"));
    const title = cfg.title || core.t(lang, "panel.title");
    if (el.title.textContent !== title) el.title.textContent = title;
    const total = core.t(lang, counts.total === 1 ? "count.total_one" : "count.total", { n: counts.total });
    const sub = counts.attention ? `${total} · ${core.t(lang, "count.problems", { n: counts.attention })}` : `${total} · ${t(lang, "ui.all_quiet")}`;
    if (el.sub.textContent !== sub) el.sub.textContent = sub;
    const ph = core.t(lang, "search.placeholder");
    if (el.input.placeholder !== ph) {
      el.input.placeholder = ph;
      el.input.setAttribute("aria-label", t(lang, "ui.search_label"));
      el.x.setAttribute("aria-label", t(lang, "ui.clear_filter"));
      el.counts.setAttribute("aria-label", t(lang, "ui.counts_label"));
    }
    el.x.hidden = !this._view.search;

    const chips = SHOWN_STATES.filter((s) => counts[s] > 0)
      .map((s) => {
        const c = core.stateColor(s);
        const on = this._view.state === s;
        return `<button class="cnt" style="--c:${c}" data-action="state" data-state="${s}" aria-pressed="${on}"><b>${esc(counts[s])}</b>${esc(core.t(lang, `state.${s}`))}</button>`;
      })
      .join("");
    this._setHtml("counts", el.counts, chips);

    // Bulk actions hit every guard, visible or not: only when the card shows
    // all of them (no filter, no fixed list, no narrowing from the header).
    let bulk = "";
    if (cfg.bulk !== false && cfg.show_actions !== false && core.isUnfiltered(cfg) && !this._view.state && !this._view.search && counts.total) {
      bulk += `<button class="pill snz strong" data-action="snooze-all" data-anchor="bulk-snooze" aria-haspopup="menu"><ha-icon icon="mdi:sleep"></ha-icon><span>${esc(core.t(lang, "action.snooze_all"))}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button>`;
      if (counts.snoozed > 0) {
        const armed = this._confirm.is("unsnooze_all");
        bulk += `<button class="pill snz ${armed ? "confirm" : ""}" data-action="unsnooze-all"><ha-icon icon="mdi:alarm"></ha-icon><span>${esc(armed ? t(lang, "ui.wake_confirm") : core.t(lang, "action.unsnooze_all"))}</span></button>`;
      }
    }
    this._setHtml("bulk", el.bulk, bulk);
    el.bar.hidden = !chips && !bulk;
  }

  // ------------------------------------------------------------ row cards

  _card(id, compact) {
    const conf = rowConfig(this._config, id, compact);
    const key = JSON.stringify(conf);
    let entry = this._cards.get(id);
    if (!entry) {
      entry = { el: document.createElement(TAGS.guard), key: null };
      this._cards.set(id, entry);
    }
    if (entry.key !== key) {
      entry.key = key;
      entry.el.setConfig(conf);
      if (this._hass) entry.el.hass = this._hass;
    }
    return entry.el;
  }

  _syncCards(main, quiet) {
    const cards = this._config.display === "cards";
    const keep = new Set([...main, ...quiet]);
    for (const [id, entry] of this._cards) {
      if (!keep.has(id)) {
        entry.el.remove();
        this._cards.delete(id);
      }
    }
    const mainEls = main.map((id) => this._card(id, !cards));
    const quietEls = quiet.map((id) => this._card(id, true));
    this._mainEls = mainEls;
    this._placeMain();
    const qkey = quiet.join("|");
    if (qkey !== this._layoutKey.quiet) {
      this._layoutKey.quiet = qkey;
      this._el.qlist.append(...quietEls);
    }
  }

  /** Number of masonry columns for the body's width (cards display only). */
  _columnCount() {
    const w = this._el.body.clientWidth || 0;
    return Math.max(1, Math.min(4, Math.floor((w + 12) / 372)));
  }

  _placeMain() {
    const els = this._mainEls || [];
    const ids = els.map((e) => e._config && e._config.entity).join("|");
    if (this._config.display !== "cards") {
      if (ids === this._layoutKey.main) return;
      this._layoutKey.main = ids;
      this._el.main.append(...els);
      return;
    }
    // Masonry: round-robin into columns keeps the reading order left to right,
    // while each column stacks cards of different heights without gaps.
    const n = this._columnCount();
    const key = `${n}:${ids}`;
    if (key === this._layoutKey.main) return;
    this._layoutKey.main = key;
    let cols = [...this._el.main.children];
    if (cols.length !== n) {
      this._el.main.innerHTML = "";
      cols = Array.from({ length: n }, () => {
        const c = document.createElement("div");
        c.className = "col";
        this._el.main.appendChild(c);
        return c;
      });
    }
    if (!els.length) {
      this._el.main.innerHTML = "";
      return;
    }
    cols.forEach((col, i) => col.append(...els.filter((_e, j) => j % n === i)));
  }

  _relayout() {
    if (this._config && this._config.display === "cards" && this._columnCount() !== this._cols) {
      this._cols = this._columnCount();
      this._placeMain();
    }
  }

  // ------------------------------------------------------------ actions

  _click(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const lang = langFrom(this._hass);
    switch (el.dataset.action) {
      case "state": {
        const s = el.dataset.state;
        this._view = { ...this._view, state: this._view.state === s ? null : s };
        this._update(true);
        return;
      }
      case "clear-search":
        this._el.input.value = "";
        this._view = { ...this._view, search: "" };
        this._update(true);
        this._el.input.focus();
        return;
      case "clear-view":
        this.setView({});
        this.dispatchEvent(new CustomEvent("necromancer-view", { detail: {}, bubbles: true, composed: true }));
        return;
      case "quiet":
        this._quietOpen = !this._quietOpen;
        this._update(true);
        return;
      case "snooze-all":
        if (this._pop.state) this._pop.close();
        else this._pop.open("snooze", el.dataset.anchor, () => snoozeItems(lang, "snooze-all-for", core.t(lang, "action.snooze_all")));
        return;
      case "snooze-all-for":
        this._pop.close({ focusAnchor: true });
        runAction(this, this._hass, null, "snooze_all", { duration: Number(el.dataset.seconds), lang });
        return;
      case "unsnooze-all":
        if (!this._confirm.check("unsnooze_all")) return;
        runAction(this, this._hass, null, "unsnooze_all", { lang });
        this._update(true);
        return;
      default:
    }
  }
}

if (!customElements.get(TAGS.guards)) customElements.define(TAGS.guards, NecromancerGuardsCard);
