// Necromancer sidebar panel (necromancer-panel), design §8: a thin shell over
// the Necromancer cards. A compact hero (wider than tall: state bubble and
// headline, the counts as small round bubbles, tap = show only that state, and
// the maintenance actions in one row when there is room), pill tabs Guards /
// Heartbeat / PoE (PoE only when ports exist), a search field, and the guards
// over the full width of the panel: by default the guards card's list, whose
// rows turn into aligned columns on a wide panel (name/state | value | 24 h |
// actions); a masonry of full cards on request. The gear opens the per-user
// settings (frontend/*_user_data, key PANEL_SETTINGS_KEY, cleaned by
// actions.normalizePanelSettings). Besides the switches, sort and start tab:
//   row_detail  what a collapsed row shows: "timeline" (default, the thin
//               24 h strip, one batched query) or "text" (the last event, no
//               history query at all); an opened row always shows both. An older
//               stored `show_timeline: true` reads as "timeline"; only
//               `row_detail` is written back.
//   display     list (default) or cards.
//   timeline    the 24 h section on the full cards of the "Cards" display
//               (default off, like the cards' own option); the gear shows
//               the switch only with "Cards".
// "Show actions" is the one switch for the buttons: the main and the snooze
// pill follow a fixed rule (core.actionsFor, design §16).

// Loaded with this module's own query, so `?v=` reaches the shared base and
// the sibling modules too (one version, one instance of each per page).
const Q = new URL(import.meta.url).search;
const { BASE_STYLE, Confirm, Pop, ROW_DETAILS, TAGS, actions, core, esc, langFrom, rowDetail, rowDetailShown, sameSig, snoozeItems, t, upgradeProperties } = await import(`./necromancer-base.js${Q}`);
await import(`./necromancer-guards-card.js${Q}`);
await import(`./necromancer-poe-card.js${Q}`);

const { PANEL_DEFAULTS, PANEL_DISPLAYS, PANEL_TABS, fire, loadPanelSettings, loadPoePorts, runAction, savePanelSettings, toast } = actions;
const BOOL_SETTINGS = ["show_counters", "show_actions", "show_footer", "collapse_ok"];
const HERO_STATES = [...core.GUARD_STATES, "unavailable"];

/**
 * Config of the guards card for a tab from the panel settings `s`: the panel
 * draws its own header and bulk actions, the card only the list (or the
 * masonry), the timeline option passes straight through.
 */
export function panelCardConfig(s, tab, opts = {}) {
  const conf = {
    display: s.display === "cards" ? "cards" : "list",
    show_header: false,
    bulk: false,
    sort: s.sort,
    collapse_ok: s.collapse_ok,
    show_counters: s.show_counters,
    show_footer: s.show_footer,
    show_actions: Boolean(s.show_actions),
    row_detail: rowDetail(s),
  };
  // The full cards' 24 h section: only the "Cards" display has full cards.
  if (conf.display === "cards" && s.timeline === true) conf.timeline = true;
  // With a Heartbeat tab, every guard is in exactly one tab: jobs there, the
  // rest here (`split`: the panel has heartbeat guards).
  if (tab === "heartbeat") conf.filter = { types: ["heartbeat"] };
  else if (tab === "guards" && opts.split) conf.filter = { types: ["recovery", "notify"] };
  return conf;
}

// Panel-only texts (the ui.* table in necromancer-base.js is shared by all four elements).
const PANEL_I18N = {
  en: {
    display: "Guard list",
    "display.list": "List",
    "display.cards": "Cards",
  },
  de: {
    display: "Guard-Liste",
    "display.list": "Liste",
    "display.cards": "Karten",
  },
};

function pt(lang, key, vars = {}) {
  const l = core.langOf(lang);
  let s = (PANEL_I18N[l] && PANEL_I18N[l][key]) ?? PANEL_I18N.en[key];
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const STYLE = `
  ${BASE_STYLE}
  :host {
    min-height: 100vh; box-sizing: border-box;
    background: var(--primary-background-color, #fafafa); color: var(--ui-text);
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, inherit));
  }
  .toolbar {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 4px;
    height: var(--header-height, 56px); padding: 0 8px; box-sizing: border-box;
    background: var(--app-header-background-color, var(--primary-background-color, #fafafa));
    color: var(--app-header-text-color, var(--ui-text));
    border-bottom: var(--app-header-border-bottom, none);
  }
  .toolbar .title { flex: 1; min-width: 0; margin-left: 8px; font-size: 20px; font-weight: 800; letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tbtn {
    width: 44px; height: 44px; border-radius: 50%; border: none; background: none; color: inherit; cursor: pointer;
    display: grid; place-items: center; padding: 0; --mdc-icon-size: 24px; transition: transform 0.25s var(--ui-spring), background 0.2s;
  }
  .tbtn:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .tbtn:active { transform: scale(0.88); }
  .tbtn[hidden] { display: none; }
  /* The whole width of the panel (no centred column): the list rows switch to
     their column grid from 900 px on, which a narrow column would never reach. */
  .content { padding: 8px 16px 32px; box-sizing: border-box; container-type: inline-size; }

  /* Hero: one row on a wide panel (identity | counts | maintenance), wrapping
     into lines on a narrow one. Sizes: 52 px state bubble, 22 px headline,
     46 px count bubbles. */
  .hero {
    position: relative; overflow: hidden; border-radius: var(--ui-radius); padding: 14px 18px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px;
    background:
      radial-gradient(120% 220% at 0% 0%, color-mix(in srgb, var(--hc) 34%, transparent), transparent 60%),
      radial-gradient(90% 160% at 100% 100%, color-mix(in srgb, var(--hc) 12%, transparent), transparent 60%),
      var(--ui-surface);
    box-shadow: var(--ha-card-box-shadow, 0 2px 10px rgba(0, 0, 0, 0.08));
    transition: background 0.4s ease;
  }
  .hid { flex: 1 1 220px; min-width: 0; display: flex; align-items: center; gap: 14px; }
  .hb {
    flex: none; width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--hc) 88%, #000); color: var(--ui-on); --mdc-icon-size: 28px;
    box-shadow: 0 6px 18px color-mix(in srgb, var(--hc) 38%, transparent);
  }
  .hero.alert .hb { animation: a-bob 3.2s ease-in-out infinite; }
  @keyframes a-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
  .htext { flex: 1; min-width: 0; }
  .headline { font-size: 22px; font-weight: 900; letter-spacing: -0.02em; line-height: 1.15; }
  .hsub { margin-top: 2px; font-size: 13px; font-weight: 600; color: var(--ui-text2); }
  .bulk { flex: none; display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .bulk:empty { display: none; }
  .pill.snz { --pill: ${core.SNOOZE_COLOR}; }
  /* Tinted pills on the hero get an opaque base: the state gradient behind
     them must not eat into the text contrast (a pale "Wake all"). */
  .hero .pill:not(.strong):not(.confirm):not([aria-pressed="true"]) {
    background: color-mix(in srgb, var(--pill) 14%, var(--ui-surface));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pill) 30%, transparent);
  }
  .hero .pill:not(.strong):not(.confirm):not([aria-pressed="true"]):hover { background: color-mix(in srgb, var(--pill) 24%, var(--ui-surface)); }
  /* The counts wrap instead of scrolling: no state may hide off-screen. */
  .bubbles { flex: 0 1 auto; display: flex; flex-wrap: wrap; gap: 8px 6px; padding: 2px; }
  .bub {
    --c: var(--ui-accent);
    flex: none; display: grid; justify-items: center; gap: 4px; padding: 0; border: none; background: none; cursor: pointer;
    color: var(--ui-text); font-size: 11.5px; font-weight: 700; min-width: 60px;
  }
  .bub .n {
    width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center;
    font-size: 19px; font-weight: 900; letter-spacing: -0.02em;
    background: color-mix(in srgb, var(--c) 18%, var(--ui-surface)); color: color-mix(in srgb, var(--c) 72%, var(--ui-text));
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c) 30%, transparent), 0 3px 10px color-mix(in srgb, var(--c) 20%, transparent);
    transition: transform 0.3s var(--ui-spring), background 0.2s, color 0.2s;
  }
  .bub:hover .n { transform: translateY(-2px) scale(1.04); }
  .bub:active .n { transform: scale(0.9); }
  /* Grey/violet counts sit on the state-tinted hero: a solid neutral fill and
     a clear ring keep them visible there in light and dark. */
  .bub.neutral .n {
    background: var(--secondary-background-color, color-mix(in srgb, var(--ui-text) 8%, var(--ui-surface)));
    color: var(--ui-text);
    box-shadow: inset 0 0 0 2.5px color-mix(in srgb, var(--c) 75%, transparent), 0 3px 10px rgba(0, 0, 0, 0.12);
  }
  .bub.hot .n { background: color-mix(in srgb, var(--c) 88%, #000); color: var(--ui-on); }
  .bub[aria-pressed="true"] .n { background: color-mix(in srgb, var(--c) 88%, #000); color: var(--ui-on);
    box-shadow: 0 0 0 3px var(--ui-surface), 0 0 0 5.5px color-mix(in srgb, var(--c) 70%, transparent); }
  .bub:focus-visible { outline: none; }
  .bub:focus-visible .n { outline: 3px solid color-mix(in srgb, var(--ui-accent) 70%, transparent); outline-offset: 3px; }

  .bar { display: flex; align-items: center; gap: 12px; margin: 14px 0 12px; flex-wrap: wrap; }
  .tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 24px; background: var(--ui-soft); }
  .tab {
    height: 38px; padding: 0 16px; border-radius: 19px; border: none; cursor: pointer; background: none;
    display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 800; color: var(--ui-text2);
    --mdc-icon-size: 19px; transition: transform 0.25s var(--ui-spring), background 0.2s, color 0.2s;
  }
  .tab:active { transform: scale(0.94); }
  .tab[aria-selected="true"] { background: var(--ui-surface); color: var(--ui-text); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); }
  .tab[hidden], .tabs[hidden] { display: none; }
  /* Attention count of a tab (also of the one not shown). */
  .tbadge { min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 10px; display: inline-grid; place-items: center;
    font-size: 12px; font-weight: 800; line-height: 1; color: #fff; background: var(--c); }
  .search {
    flex: 1 1 220px; max-width: 360px; margin-left: auto; display: flex; align-items: center; gap: 8px; height: 44px;
    padding: 0 5px 0 14px; border-radius: 22px; background: var(--ui-surface); box-sizing: border-box; color: var(--ui-text2);
    box-shadow: var(--ha-card-box-shadow, 0 2px 10px rgba(0, 0, 0, 0.08)); --mdc-icon-size: 20px;
  }
  .search[hidden] { display: none; }
  .search:focus-within { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent) 45%, transparent); }
  .search input { flex: 1; min-width: 0; height: 100%; border: none; background: none; outline: none; font: inherit; font-size: 14.5px; color: var(--ui-text); }
  .search input::placeholder { color: var(--ui-text2); }
  /* Our own clear button only (the browser adds one to type=search). */
  .search input::-webkit-search-cancel-button, .search input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }
  .search .x { width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--ui-soft); cursor: pointer;
    display: grid; place-items: center; color: var(--ui-text2); padding: 0; --mdc-icon-size: 18px; }
  .search .x[hidden] { display: none; }

  .sheet { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px;
    background: rgba(0, 0, 0, 0.42); animation: a-fade 0.2s ease; }
  .sheet[hidden] { display: none; }
  @keyframes a-fade { from { opacity: 0; } }
  .dlg {
    width: min(460px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
    border-radius: 28px; padding: 18px; background: var(--ui-surface); color: var(--ui-text);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35); animation: a-pop 0.32s var(--ui-spring);
  }
  .dhead { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .dhead .hb { width: 44px; height: 44px; --mdc-icon-size: 24px; --hc: var(--ui-accent); box-shadow: none; animation: none; }
  .dhead h2 { flex: 1; margin: 0; font-size: 19px; font-weight: 900; }
  .srow { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 6px 8px 6px 14px; box-sizing: border-box;
    border: none; border-radius: 20px; background: none; cursor: pointer; text-align: left; font-size: 14.5px; font-weight: 600; color: var(--ui-text); }
  .srow:hover { background: var(--ui-soft); }
  .srow span { flex: 1; }
  .srow ha-icon { flex: none; color: var(--ui-text2); --mdc-icon-size: 20px; }
  .sw { flex: none; width: 52px; height: 32px; border-radius: 16px; background: var(--ui-soft2); position: relative; transition: background 0.2s; }
  .sw::after { content: ""; position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; border-radius: 50%;
    background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform 0.3s var(--ui-spring); }
  [aria-checked="true"] .sw { background: color-mix(in srgb, var(--ui-accent) 88%, #000); }
  [aria-checked="true"] .sw::after { transform: translateX(20px); }
  .sgroup { margin: 14px 0 4px; padding: 0 8px; font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-text2); }
  .shint { margin: -2px 0 6px; padding: 0 8px; font-size: 12.5px; font-weight: 500; line-height: 1.35; color: var(--ui-text2); }
  .seg { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 4px 0; }
  .seg + .srow { margin-top: 6px; }
  .seg .pill { height: 36px; font-size: 13.5px; }
  .seg .pill[aria-pressed="true"] { background: color-mix(in srgb, var(--ui-accent) 88%, #000); color: var(--ui-on); }
  .dfoot { display: flex; justify-content: flex-end; margin-top: 16px; }

  .view > * { display: block; }
  @container (max-width: 600px) {
    .hero { padding: 12px 12px 12px 12px; gap: 10px 12px; border-radius: 22px; }
    .hid { gap: 12px; flex-basis: 100%; }
    .hb { width: 44px; height: 44px; --mdc-icon-size: 24px; }
    .headline { font-size: 19px; }
    .hsub { font-size: 12.5px; }
    .bubbles { gap: 8px 2px; }
    .bub { min-width: 56px; font-size: 11px; }
    .bub .n { width: 40px; height: 40px; font-size: 17px; }
    .bulk { margin-left: 0; }
    .bar { gap: 8px; margin: 12px 0 10px; }
    .tabs { width: 100%; box-sizing: border-box; }
    /* Each tab as wide as its content (a short "PoE" leaves room for a long
       "Heartbeat" with its badge), the rest shared out. */
    .tab { flex: 1 1 auto; justify-content: center; padding: 0 8px; gap: 5px; min-width: 0; }
    .tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tbadge { min-width: 18px; height: 18px; padding: 0 5px; font-size: 11px; }
    .search { max-width: none; margin-left: 0; }
  }
  @media (max-width: 600px) {
    .content { padding: 4px 8px 24px; }
  }
`;

export class NecromancerPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._discover = core.createGuardDiscovery();
    this._settings = { ...PANEL_DEFAULTS };
    this._settingsLoaded = false;
    this._settingsLoading = false;
    this._poeChecked = false;
    this._poeCount = 0;
    this._tab = null;
    this._view = { state: null, search: "" };
    this._sig = null;
    this._cache = {};
    this._cards = {};
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="toolbar">
        <button class="tbtn menu" data-action="menu" hidden><ha-icon icon="mdi:menu"></ha-icon></button>
        <div class="title"></div>
        <button class="tbtn gear" data-action="settings"><ha-icon icon="mdi:cog"></ha-icon></button>
      </div>
      <div class="content">
        <section class="hero">
          <div class="hid">
            <div class="hb" aria-hidden="true"><ha-icon icon="mdi:skull-crossbones"></ha-icon></div>
            <div class="htext"><div class="headline"></div><div class="hsub"></div></div>
          </div>
          <div class="bubbles" role="group"></div>
          <div class="bulk"></div>
        </section>
        <div class="bar">
          <div class="tabs" role="tablist"></div>
          <label class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input type="search" autocomplete="off" spellcheck="false" />
            <button class="x" data-action="clear-search" hidden><ha-icon icon="mdi:close"></ha-icon></button>
          </label>
        </div>
        <div class="view"></div>
      </div>
      <div class="pop" hidden role="menu"></div>
      <div class="sheet" hidden></div>`;
    const $ = (s) => root.querySelector(s);
    this._el = {
      menu: $(".menu"),
      gear: $(".gear"),
      title: $(".title"),
      hero: $(".hero"),
      headline: $(".headline"),
      hsub: $(".hsub"),
      bulk: $(".bulk"),
      bubbles: $(".bubbles"),
      tabs: $(".tabs"),
      search: $(".search"),
      input: $("input"),
      x: $(".x"),
      view: $(".view"),
      sheet: $(".sheet"),
    };
    this._pop = new Pop(this, $(".pop"));
    this._confirm = new Confirm(() => this._renderHero(true));
    root.addEventListener("click", (ev) => this._click(ev));
    root.addEventListener("keydown", (ev) => this._key(ev));
    this._el.input.addEventListener("input", () => {
      this._view = { ...this._view, search: this._el.input.value };
      this._applyView();
    });
    // A guards card's own "show all" resets the panel's narrowing too.
    this.addEventListener("necromancer-view", () => {
      this._view = { state: null, search: "" };
      this._el.input.value = "";
      this._renderHero(true);
      this._el.x.hidden = true;
    });
    this.addEventListener("necromancer-poe-loaded", (ev) => {
      const n = (ev.detail && ev.detail.count) || 0;
      if (n !== this._poeCount) {
        this._poeCount = n;
        this._renderTabs();
      }
    });
    upgradeProperties(this, ["hass", "narrow", "panel", "route"]);
  }

  // ------------------------------------------------------------ HA panel API

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    if (!this._settingsLoading && hass.callWS) {
      this._settingsLoading = true;
      loadPanelSettings(hass).then((s) => {
        this._settings = s;
        this._settingsLoaded = true;
        this._applySettings();
        if (!this._tab) this._selectTab(s.start_tab);
      });
    }
    if (!this._poeChecked && hass.callWS && hass.user && hass.user.is_admin) {
      this._poeChecked = true;
      loadPoePorts(hass)
        .then((res) => {
          this._poeCount = ((res && res.ports) || []).length;
          this._renderTabs();
          const start = this._settings.start_tab;
          if (this._settingsLoaded && (!this._tab || (start === "poe" && !this._userPicked))) this._selectTab(start);
        })
        .catch(() => {});
    }
    this._update();
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    this._narrow = Boolean(value);
    this._el.menu.hidden = !this._narrow;
  }

  get narrow() {
    return this._narrow;
  }

  set panel(value) {
    this._panel = value;
  }

  get panel() {
    return this._panel;
  }

  set route(value) {
    this._route = value;
  }

  get route() {
    return this._route;
  }

  // ------------------------------------------------------------ rendering

  _lang() {
    return langFrom(this._hass);
  }

  _update() {
    const hass = this._hass;
    if (!hass || !hass.states) return;
    const lang = this._lang();
    if (this._el.title.textContent !== core.t(lang, "panel.title")) {
      this._el.title.textContent = core.t(lang, "panel.title");
      this._el.menu.setAttribute("aria-label", core.t(lang, "action.menu"));
      this._el.gear.setAttribute("aria-label", core.t(lang, "action.settings"));
      this._el.gear.title = core.t(lang, "action.settings");
      this._el.input.placeholder = core.t(lang, "search.placeholder");
      this._el.input.setAttribute("aria-label", t(lang, "ui.search_label"));
      this._el.x.setAttribute("aria-label", t(lang, "ui.clear_filter"));
      this._el.bubbles.setAttribute("aria-label", t(lang, "ui.counts_label"));
      this._renderTabs();
    }
    if (!this._tab && this._settingsLoaded) this._selectTab(this._settings.start_tab);
    this._renderHero(false);
    const card = this._activeCard();
    if (card) card.hass = hass;
  }

  _renderHero(force) {
    const hass = this._hass;
    if (!hass || !hass.states) return;
    const lang = this._lang();
    const all = this._discover(hass);
    const hb = all.filter((id) => core.guardInfo(hass.states[id]).type === "heartbeat");
    const split = hb.length > 0;
    if (split !== this._split) {
      // Heartbeat guards appeared or went: the tabs and the guards tab's filter change.
      this._split = split;
      this._applySettings();
      if (!split && this._tab === "heartbeat") this._selectTab("guards");
    }
    const user = hass.user;
    const admin = !(user && user.is_admin === false);
    // The ids per tab: with a Heartbeat tab each guard is in one of them.
    const hbSet = new Set(hb);
    const tabIds = { guards: split ? all.filter((id) => !hbSet.has(id)) : all, heartbeat: hb };
    const ids = tabIds[this._tab] || all;
    const sig = [lang, this._view.state, this._tab, admin, ...all.map((id) => hass.states[id])];
    if (!force && sameSig(sig, this._sig)) return;
    this._sig = sig;
    // Per-tab attention counts for the tab badges (a problem in the other tab
    // stays visible).
    this._tabCounts = {
      guards: core.countByState(tabIds.guards, hass),
      heartbeat: core.countByState(tabIds.heartbeat, hass),
    };
    this._renderTabs();
    // Nothing in the start tab but jobs in the other one (a heartbeat-only
    // install): open the tab that has guards, unless the user chose a tab.
    if (!this._userPicked && this._tab === "guards" && split && !tabIds.guards.length) {
      this._selectTab("heartbeat");
      return;
    }
    const counts = core.countByState(ids, hass);
    const allCounts = core.countByState(all, hass);
    const worst = core.ATTENTION_STATES.find((s) => counts[s] > 0);
    this._el.hero.style.setProperty("--hc", core.stateColor(worst || "ok"));
    this._el.hero.classList.toggle("alert", counts.escalated > 0);
    const headline = counts.attention ? core.t(lang, counts.attention === 1 ? "count.problems_one" : "count.problems", { n: counts.attention }) : t(lang, "ui.all_quiet");
    if (this._el.headline.textContent !== headline) this._el.headline.textContent = headline;
    const sub = core.t(lang, counts.total === 1 ? "count.total_one" : "count.total", { n: counts.total });
    if (this._el.hsub.textContent !== sub) this._el.hsub.textContent = sub;

    // An active filter keeps its bubble (also with 0 in this tab), so it can be undone.
    const bubbles = HERO_STATES.filter((s) => counts[s] > 0 || s === "ok" || this._view.state === s)
      .map((s) => {
        const c = core.stateColor(s);
        const hot = counts[s] > 0 && core.needsAttention(s) && !core.isMutedState(s);
        const cls = hot ? "hot" : core.isMutedState(s) ? "neutral" : "";
        return `<button class="bub ${cls}" style="--c:${c}" data-action="state" data-state="${s}" aria-pressed="${this._view.state === s}" aria-label="${esc(`${counts[s]} ${core.t(lang, `state.${s}`)}`)}"><span class="n" aria-hidden="true">${esc(counts[s])}</span><span aria-hidden="true">${esc(core.t(lang, `state.${s}`))}</span></button>`;
      })
      .join("");
    this._set("bubbles", this._el.bubbles, bubbles);

    // Maintenance mode acts on every guard (so it follows all guards, not the
    // tab): admins only (others just watch), and not with "Show actions" off.
    let bulk = "";
    const showActs = !this._settings || this._settings.show_actions !== false;
    if (allCounts.total && admin && showActs) {
      bulk += `<button class="pill snz strong" data-action="snooze-all" data-anchor="bulk-snooze" aria-haspopup="menu"><ha-icon icon="mdi:sleep"></ha-icon><span>${esc(core.t(lang, "action.snooze_all"))}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button>`;
      if (allCounts.snoozed > 0) {
        const armed = this._confirm.is("unsnooze_all");
        bulk += `<button class="pill snz ${armed ? "confirm" : ""}" data-action="unsnooze-all"><ha-icon icon="mdi:alarm"></ha-icon><span>${esc(armed ? t(lang, "ui.wake_confirm") : core.t(lang, "action.unsnooze_all"))}</span></button>`;
      }
    }
    this._set("bulk", this._el.bulk, bulk);
    this._pop.refresh();
  }

  _set(key, el, html) {
    if (this._cache[key] === html) return;
    this._cache[key] = html;
    el.innerHTML = html;
  }

  _tabs() {
    return PANEL_TABS.filter((tab) => (tab !== "poe" || this._poeCount > 0) && (tab !== "heartbeat" || this._split));
  }

  _renderTabs() {
    const lang = this._lang();
    const icons = { guards: "mdi:shield-check", heartbeat: "mdi:heart-pulse", poe: "mdi:ethernet" };
    const tabs = this._tabs();
    // A single tab needs no tab bar.
    this._el.tabs.hidden = tabs.length < 2;
    const html = tabs
      .map((tab) => {
        // Badge: how many guards of that tab need attention, in the worst state's colour.
        const c = (this._tabCounts || {})[tab];
        const worst = c && core.ATTENTION_STATES.find((st) => c[st] > 0);
        const badge = c && c.attention ? `<b class="tbadge" style="--c:${core.stateColor(worst)}" aria-label="${esc(core.t(lang, c.attention === 1 ? "count.problems_one" : "count.problems", { n: c.attention }))}">${esc(c.attention)}</b>` : "";
        return `<button class="tab" role="tab" data-action="tab" data-tab="${tab}" aria-selected="${this._tab === tab}" tabindex="${this._tab === tab ? 0 : -1}"><ha-icon icon="${icons[tab]}"></ha-icon><span>${esc(core.t(lang, `tab.${tab}`))}</span>${badge}</button>`;
      })
      .join("");
    this._set("tabs", this._el.tabs, html);
    if (this._tab === "poe" && this._poeCount === 0 && this._poeChecked) this._selectTab("guards");
  }

  // ------------------------------------------------------------ tabs and cards

  _cardConfig(tab) {
    return panelCardConfig(this._settings, tab, { split: Boolean(this._split) });
  }

  _makeCard(tab) {
    if (this._cards[tab]) return this._cards[tab];
    const el = document.createElement(tab === "poe" ? TAGS.poe : TAGS.guards);
    el.setAttribute("bare", "");
    el.setConfig(tab === "poe" ? {} : this._cardConfig(tab));
    this._cards[tab] = el;
    return el;
  }

  _activeCard() {
    return this._tab ? this._cards[this._tab] : null;
  }

  _selectTab(tab) {
    let next = this._tabs().includes(tab) ? tab : "guards";
    if (next === "poe" && !this._poeCount) next = "guards";
    if (next === this._tab && this._el.view.firstChild) return;
    this._tab = next;
    const card = this._makeCard(next);
    // Only the active tab's card is in the page: the others get no updates.
    this._el.view.replaceChildren(card);
    this._el.search.hidden = next === "poe";
    if (this._hass) card.hass = this._hass;
    if (next !== "poe") card.setView(this._view);
    this._renderTabs();
    // The hero counts the open tab's guards.
    this._renderHero(true);
  }

  _applySettings() {
    for (const tab of ["guards", "heartbeat"]) {
      const card = this._cards[tab];
      if (!card) continue;
      card.setConfig(this._cardConfig(tab));
      card.setView(this._view);
    }
    if (this._el.sheet.hidden === false) this._renderSheet();
  }

  _applyView() {
    this._el.x.hidden = !this._view.search;
    const card = this._activeCard();
    if (card && card.setView) card.setView(this._view);
    this._renderHero(true);
  }

  // ------------------------------------------------------------ settings sheet

  _openSheet() {
    this._renderSheet();
    this._el.sheet.hidden = false;
    const first = this._el.sheet.querySelector("[data-action]");
    if (first) first.focus();
  }

  _closeSheet() {
    this._el.sheet.hidden = true;
    this._el.sheet.innerHTML = "";
    this._cache.sheet = null;
    this._el.gear.focus();
  }

  _renderSheet() {
    const lang = this._lang();
    const s = this._settings;
    const toggle = (k, label, icon = "") =>
      `<button class="srow" role="switch" aria-checked="${Boolean(s[k])}" data-action="toggle" data-key="${k}">${icon ? `<ha-icon icon="${icon}" aria-hidden="true"></ha-icon>` : ""}<span>${esc(label)}</span><i class="sw" aria-hidden="true"></i></button>`;
    const toggles = BOOL_SETTINGS.map((k) => toggle(k, core.t(lang, `settings.${k}`))).join("");
    const seg = (key, values, label) =>
      values
        .map(
          (v) =>
            `<button class="pill neutral" data-action="choose" data-key="${key}" data-value="${v}" aria-pressed="${s[key] === v}">${esc(label(v))}</button>`,
        )
        .join("");
    // "Row shows" only where there are rows: the list, or the cards' folded
    // quiet group (then it says so); full cards alone have none.
    const rows = rowDetailShown(s);
    const rowDetail = rows
      ? `<div class="sgroup">${esc(t(lang, "ui.row_detail"))}</div>
        ${s.display === "cards" ? `<div class="shint">${esc(t(lang, "ui.row_detail_quiet"))}</div>` : ""}
        <div class="seg" role="group">${seg("row_detail", ROW_DETAILS, (v) => t(lang, `ui.row_detail.${v}`))}</div>`
      : "";
    const html = `
      <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div class="dhead"><div class="hb" aria-hidden="true"><ha-icon icon="mdi:cog"></ha-icon></div>
          <h2 id="dlg-title">${esc(core.t(lang, "settings.title"))}</h2>
          <button class="pill neutral round" data-action="close-sheet" aria-label="${esc(t(lang, "ui.close"))}"><ha-icon icon="mdi:close"></ha-icon></button></div>
        ${toggles}
        <div class="sgroup">${esc(pt(lang, "display"))}</div>
        <div class="seg" role="group">${seg("display", PANEL_DISPLAYS, (v) => pt(lang, `display.${v}`))}</div>
        ${s.display === "cards" ? toggle("timeline", t(lang, "ui.timeline_cards"), "mdi:chart-timeline") : ""}
        ${rowDetail}
        <div class="sgroup">${esc(core.t(lang, "settings.sort"))}</div>
        <div class="seg" role="group">${seg("sort", core.SORT_MODES, (v) => core.t(lang, `sort.${v}`))}</div>
        <div class="sgroup">${esc(core.t(lang, "settings.start_tab"))}</div>
        <div class="seg" role="group">${seg("start_tab", this._tabs(), (v) => core.t(lang, `tab.${v}`))}</div>
        <div class="dfoot"><button class="pill strong" data-action="close-sheet"><ha-icon icon="mdi:check"></ha-icon><span>${esc(t(lang, "ui.done"))}</span></button></div>
      </div>`;
    const active = this.shadowRoot.activeElement;
    const focusSel = active && this._el.sheet.contains(active) && active.dataset
      ? `[data-action="${active.dataset.action}"]${active.dataset.key ? `[data-key="${active.dataset.key}"]` : ""}${active.dataset.value ? `[data-value="${active.dataset.value}"]` : ""}`
      : null;
    this._set("sheet", this._el.sheet, html);
    if (focusSel) {
      const again = this._el.sheet.querySelector(focusSel);
      if (again) again.focus();
    }
  }

  async _changeSetting(key, value) {
    this._settings = actions.normalizePanelSettings({ ...this._settings, [key]: value });
    this._applySettings();
    // "Show actions" also decides the hero's maintenance mode.
    this._renderHero(true);
    try {
      this._settings = await savePanelSettings(this._hass, this._settings);
    } catch (_err) {
      toast(this, core.t(this._lang(), "toast.settings_failed"));
    }
  }

  // ------------------------------------------------------------ events

  _key(ev) {
    if (this._el.sheet.hidden) {
      // Arrow keys move between the tabs (tablist pattern).
      const tab = ev.target && ev.target.dataset && ev.target.dataset.tab;
      if (!tab || !["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
      const tabs = this._tabs();
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      ev.preventDefault();
      this._userPicked = true;
      this._selectTab(next);
      const el = this._el.tabs.querySelector(`[data-tab="${next}"]`);
      if (el) el.focus();
      return;
    }
    if (ev.key === "Escape") {
      ev.stopPropagation();
      this._closeSheet();
    } else if (ev.key === "Tab") {
      // Keep the focus inside the modal settings dialog.
      const items = [...this._el.sheet.querySelectorAll("button")];
      if (!items.length) return;
      const i = items.indexOf(this.shadowRoot.activeElement);
      if (ev.shiftKey && i <= 0) {
        ev.preventDefault();
        items[items.length - 1].focus();
      } else if (!ev.shiftKey && i === items.length - 1) {
        ev.preventDefault();
        items[0].focus();
      }
    }
  }

  _click(ev) {
    if (ev.target === this._el.sheet) {
      this._closeSheet();
      return;
    }
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const lang = this._lang();
    switch (el.dataset.action) {
      case "menu":
        fire(this, "hass-toggle-menu");
        return;
      case "settings":
        this._openSheet();
        return;
      case "close-sheet":
        this._closeSheet();
        return;
      case "toggle": {
        const k = el.dataset.key;
        this._changeSetting(k, !this._settings[k]);
        return;
      }
      case "choose":
        this._changeSetting(el.dataset.key, el.dataset.value);
        return;
      case "tab":
        this._userPicked = true;
        this._selectTab(el.dataset.tab);
        return;
      case "state": {
        const s = el.dataset.state;
        this._view = { ...this._view, state: this._view.state === s ? null : s };
        if (this._tab === "poe") this._selectTab("guards");
        this._applyView();
        return;
      }
      case "clear-search":
        this._el.input.value = "";
        this._view = { ...this._view, search: "" };
        this._applyView();
        this._el.input.focus();
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
        this._renderHero(true);
        return;
      default:
    }
  }
}

if (!customElements.get(TAGS.panel)) customElements.define(TAGS.panel, NecromancerPanel);
