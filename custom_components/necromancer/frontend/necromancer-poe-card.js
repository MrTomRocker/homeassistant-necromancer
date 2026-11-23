// PoE card (necromancer-poe-card), design §7, in the cards' compact
// sizes: one bubble row per configured port with
// its switch, power and link state, what is connected (the live or fixed id),
// which guard(s) use it, the last restart and its result, and a "Restart port"
// pill (second tap confirms). Admins get "Edit ports", which leads to the
// integration page (the port list stays in the options flow).
//
// Id mapping (core.poePortRows with `mapping`): the "Connected" fact says
// where the port's id comes from ("live · from <entity>", tap = its more-info,
// green dot, a hollow grey dot when the entity reports nothing (the "Nothing
// connected" line says that already); "Fixed id"; or, for a port with both a
// fixed id and an id entity, "conflict · fixed <id> and <entity>" in red), ids
// in mono with MACs as AA:BB:…; an empty port that the fabric's cache still
// remembers reads "Nothing connected · expected: … (last known)" (no extra
// "Offline" tag then: the header's status already says it). Every guard on
// the port says whether its expected id matches: "matches", "ambiguous · also
// on Port 25", "last known", "now on Port 5", or, when the cache points here
// but the port reports another id, the expected id plus what the port reports
// ("expected: A4:… · port reports B8:…", "· now on Port 5" when the expected
// id is live elsewhere; the fabric would refuse to restart by it). Ids in mono.
//
// Layout follows the card's own width (container queries, not the viewport):
//   narrow  (< 600 px): one row per port, header line (bubble, name + status,
//                       restart pill) over a soft info tray, one fact per line;
//   medium  (>= 600):   same, the tray as two columns (wider than tall);
//   wide    (>= 900):   a list with column headings, one line per port:
//                       bubble | port + status | switch | connected | used by |
//                       last restart | restart pill (fixed width, so the rows
//                       line up like the guards card's list rows).
//
// Data: the read-only WS command `necromancer/poe/ports` (admin only). Live
// values come from `hass` (core.poePortRows), so the rows follow state changes
// without a new call; the payload itself (fabric status, last restart) is
// reloaded on the `necromancer_poe_port` event, after a restart and every 30 s
// while the card is visible.

// Loaded with this module's own query, so `?v=` reaches the shared base and
// the sibling modules too (one version, one instance of each per page).
const Q = new URL(import.meta.url).search;
const { BASE_STYLE, Confirm, TAGS, actions, core, docLang, esc, langFrom, sameSig, t } = await import(`./necromancer-base.js${Q}`);

const { loadPoePorts, navigate, runAction, moreInfo } = actions;
const { TONE_COLORS } = core;
const REFRESH_MS = 30000;
const POE_EVENT = "necromancer_poe_port";

// Column template of the wide list (heading row and port rows share it).
// Fixed outer columns (bubble, restart pill) keep the rows aligned; the five
// text columns share the rest with sensible minimums, so no empty middle gap.
export const WIDE_COLS = "40px minmax(140px, 1fr) minmax(0, 0.9fr) minmax(0, 1.3fr) minmax(0, 1.3fr) minmax(0, 0.75fr) 150px";

// Own texts (column heading of the first column).
const POE_I18N = { en: { port: "Port" }, de: { port: "Port" } };

const STYLE = `
  ${BASE_STYLE}
  /* The state glow sits on the card itself (fixed height, like the guard
     card), so it fades out softly behind the first rows instead of ending at
     the header's bottom edge. Only the image: the theme keeps the card colour. */
  ha-card {
    border-radius: var(--ui-radius); overflow: hidden; container: ncpoe / inline-size;
    background-image: radial-gradient(130% 200px at 0% 0%, color-mix(in srgb, var(--hc) 24%, transparent) 0%,
      color-mix(in srgb, var(--hc) 8%, transparent) 45%, transparent 75%);
  }
  :host([bare]) ha-card { background: none; box-shadow: none; border: none; }
  .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; }
  /* Inside the panel (bare): the panel's hero already carries the state
     colour, so no second band here, only the bubble. */
  :host([bare]) .head { padding: 2px 2px 10px; }
  .hb {
    flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--hc) 88%, #000); color: var(--ui-on); --mdc-icon-size: 22px;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--hc) 32%, transparent);
  }
  .ttl { flex: 1 1 140px; min-width: 0; }
  .title { font-size: 17px; font-weight: 800; line-height: 1.25; letter-spacing: -0.015em; color: var(--ui-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 12.5px; font-weight: 600; color: var(--ui-text2); }
  .ports { display: grid; gap: 8px; padding: 0 10px 10px; }
  :host([bare]) .ports { padding: 0; }
  .cols { display: none; }

  /* One row per port: header line (bubble, name + status, restart pill), then
     a soft info tray. The pill is tonal by default and only gets the strong
     fill when the port is in trouble. */
  .port {
    --ui-pill-h: 34px;
    display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; grid-template-areas: "b t p" "i i i";
    align-items: center; gap: 8px 12px; padding: 10px 10px 10px 12px; min-width: 0;
    border-radius: 20px; background-color: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
    background-image: linear-gradient(110deg, color-mix(in srgb, var(--tc) 16%, transparent), transparent 50%);
  }
  .pb {
    grid-area: b; position: relative; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--tc) 22%, var(--ui-surface)); color: var(--tc); --mdc-icon-size: 22px;
  }
  .pb.busy::after { content: ""; position: absolute; inset: 0; border-radius: 50%; animation: a-ring 2.2s ease-out infinite; }
  @keyframes a-ring {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tc) 55%, transparent); }
    100% { box-shadow: 0 0 0 12px transparent; }
  }
  .ptext { grid-area: t; min-width: 0; }
  .plabel { font-size: 14.5px; font-weight: 800; color: var(--ui-text); line-height: 1.3; letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pstatus { display: flex; align-items: center; gap: 6px; margin-top: 1px; font-size: 12px; font-weight: 700;
    line-height: 1.35; color: var(--st); min-width: 0; }
  .pstatus .d { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--tc); }
  .pstatus span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .port > .pill { grid-area: p; }
  .pill.go { --pill: var(--warning-color, #fb8c00); }
  .pill.go:not(.strong):not(.confirm) { color: color-mix(in srgb, var(--pill) 70%, var(--ui-text)); }

  /* The tray is a grid (icon | key | value) and every fact a subgrid row, so
     the values line up and a wrapped tag stays in the value column. */
  .info {
    grid-area: i; display: grid; grid-template-columns: 16px max-content minmax(0, 1fr); gap: 5px 8px;
    padding: 8px 10px; border-radius: 14px; background: var(--ui-soft); min-width: 0;
  }
  .cell {
    grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center;
    font-size: 12.5px; line-height: 1.4; color: var(--ui-text); min-width: 0;
  }
  .cell > ha-icon { --mdc-icon-size: 16px; color: var(--ui-text2); }
  .cell .k { color: var(--ui-text2); font-weight: 600; padding-right: 6px; }
  .cw { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
  .cv, .cx { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; max-width: 100%; }
  .v { font-weight: 700; overflow-wrap: anywhere; }
  button.v { border: none; background: none; padding: 0; cursor: pointer; text-align: left; font: inherit; font-weight: 700;
    color: var(--ui-text); text-decoration: underline dotted color-mix(in srgb, var(--ui-text) 40%, transparent); text-underline-offset: 3px; }
  .v.mono { font-family: var(--code-font-family, ui-monospace, monospace); font-size: 12px; }
  .muted { color: var(--ui-text2); font-weight: 500; }
  .tag {
    display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 6px; border-radius: 11px;
    border: none; font: inherit; font-size: 11.5px; font-weight: 700; color: var(--ui-text); --mdc-icon-size: 13px;
    background: color-mix(in srgb, var(--t) 16%, transparent); cursor: pointer; white-space: nowrap;
    transition: transform 0.2s var(--ui-spring);
  }
  .tag ha-icon { color: var(--t); }
  .tag:active { transform: scale(0.92); }
  .gchip {
    display: inline-flex; align-items: center; gap: 6px; height: 26px; max-width: 100%; box-sizing: border-box;
    padding: 0 10px 0 5px; border-radius: 13px; border: none;
    font-size: 12px; font-weight: 700; cursor: pointer; color: var(--ui-text);
    background: color-mix(in srgb, var(--gc) 18%, transparent); transition: transform 0.2s var(--ui-spring);
  }
  .gchip:active { transform: scale(0.92); }
  .gchip .d { flex: none; width: 15px; height: 15px; border-radius: 50%; background: var(--gc); }
  .gchip .n { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cell.last .cx::before { content: "· "; color: var(--ui-text2); }
  /* Where the id comes from: a small line under the id (a live source with a
     green dot, its entity a link to more-info), "Fixed id" plain. */
  .src { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%;
    font-size: 11.5px; font-weight: 600; color: var(--ui-text2); }
  /* The dot sits in the text, so it stays with "live" when the entity wraps.
     Green while the entity reports an id, a hollow grey ring while it is
     empty (live, but nothing there), red for a conflict. */
  .src.live > span::before, .src.conflict > span::before { content: ""; display: inline-block; box-sizing: border-box;
    width: 7px; height: 7px; margin-right: 5px; vertical-align: 0; border-radius: 50%; background: ${TONE_COLORS.good}; }
  .src.live.empty > span::before { background: none; border: 1.5px solid var(--ui-text2); }
  .src.conflict { color: ${core.toneTextColor("bad")}; }
  .src.conflict > span::before { background: ${TONE_COLORS.bad}; }
  .src .mono { font-family: var(--code-font-family, ui-monospace, monospace); font-size: 11px; font-weight: 700; }
  .src > span { min-width: 0; }
  .src button { border: none; background: none; padding: 0; margin: 0; cursor: pointer; font: inherit; color: inherit;
    font-family: var(--code-font-family, ui-monospace, monospace); font-size: 11px;
    text-decoration: underline dotted color-mix(in srgb, var(--ui-text) 40%, transparent); text-underline-offset: 3px; }
  .src button:hover { color: var(--ui-text); }
  .v.empty { font-weight: 600; color: var(--ui-text2); }
  .v.empty .mono, .rel .mono { font-family: var(--code-font-family, ui-monospace, monospace); font-weight: 700; color: var(--ui-text); }
  .v.empty .mono { font-size: 12px; }
  /* Guards: one line each, the chip and how its expected id relates to the
     port (tone + icon + words, never colour alone). */
  .cv.guards { display: grid; justify-items: start; gap: 4px; }
  .gl { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 8px; min-width: 0; max-width: 100%; }
  .rel { display: inline-flex; align-items: flex-start; gap: 4px; min-width: 0; max-width: 100%;
    font-size: 11.5px; font-weight: 700; line-height: 1.35; color: var(--rt); --mdc-icon-size: 14px; }
  .rel ha-icon { flex: none; color: var(--rc); margin-top: 1px; }
  .rel > span { min-width: 0; }
  .rel .mono { font-size: 11px; overflow-wrap: anywhere; }
  .ok { color: ${TONE_COLORS.good}; }
  .bad { color: ${TONE_COLORS.bad}; }

  /* Very narrow card: the restart pill keeps only its icon, the keys shrink. */
  @container ncpoe (max-width: 340px) {
    .pill.go:not(.confirm) { width: var(--ui-pill-h); padding: 0; }
    .pill.go:not(.confirm) .label { display: none; }
    .cell .k { padding-right: 0; }
  }
  /* Medium: the tray as two columns, so a port row stays wider than tall. */
  @container ncpoe (min-width: 600px) {
    .info { grid-template-columns: 16px max-content minmax(0, 1fr) 28px max-content minmax(0, 1fr); column-gap: 8px; }
    .cell { grid-column: span 3; }
    .cell:nth-child(even) > ha-icon { justify-self: end; }
  }
  /* Wide: a real list, one line per port under light column headings. The
     tray dissolves into the row (display: contents), each fact gets its own
     column: main value on top, its tag below. The keys stay for screen
     readers only (the headings are aria-hidden). */
  @container ncpoe (min-width: 900px) {
    .ports { gap: 6px; padding: 0 12px 12px; }
    .cols, .port { grid-template-columns: ${WIDE_COLS}; grid-template-areas: none; column-gap: 14px; }
    .cols {
      display: grid; align-items: end; padding: 2px 12px 0 14px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-text2);
    }
    .cols span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .port { padding: 8px 12px 8px 14px; min-height: 44px;
      background-image: linear-gradient(90deg, color-mix(in srgb, var(--tc) 16%, transparent), transparent 260px); }
    .pb, .ptext, .cell, .port > .pill { grid-area: auto; grid-row: 1; }
    .pb { grid-column: 1; }
    .ptext { grid-column: 2; }
    .cell.sw { grid-column: 3; }
    .cell.id { grid-column: 4; }
    .cell.used { grid-column: 5; }
    .cell.last { grid-column: 6; }
    .port > .pill { grid-column: 7; width: 100%; }
    .info { display: contents; }
    .cell { display: block; grid-template-columns: none; }
    .cw { display: grid; align-content: center; justify-items: start; gap: 3px; }
    .cell > ha-icon { display: none; }
    .cell.last .cx::before { content: none; }
    .cell .k { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .cv { flex-wrap: nowrap; }
    .cell.used .cv, .cell.id .cv { flex-wrap: wrap; }
    .cell.id .cv > .v.empty { white-space: normal; }
    /* The id is key info: it may wrap, never ellipsis. Names carry a title. */
    .cell.id .cv > .v { white-space: normal; overflow-wrap: anywhere; }
    .cv > .v, .cv > .muted { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; overflow-wrap: normal; }
    .cv > .muted { flex: 0 1 auto; }
    .cv > .v { flex: 0 1 auto; }
  }
  .msg { padding: 6px 16px 18px; color: var(--ui-text2); font-weight: 600; display: flex; gap: 10px; align-items: center; }
  .msg ha-icon { --mdc-icon-size: 22px; }
  .msg.err { color: var(--error-color, #e53935); }
`;

/** "Port 23" for a bare number, the configured label otherwise. */
export function portName(label, lang) {
  const l = String(label ?? "").trim();
  return /^\d+$/.test(l) ? t(lang, "ui.port", { n: l }) : String(label ?? "");
}

/** The column headings of the wide list, in column order (bubble and pill
 *  columns have none). */
export function columnHeads(lang) {
  const l = core.langOf(lang);
  return [
    "",
    (POE_I18N[l] || POE_I18N.en).port,
    core.t(lang, "poe.switch"),
    t(lang, "ui.connected"),
    core.t(lang, "poe.used_by"),
    core.t(lang, "poe.last_cycle"),
    "",
  ];
}

/** Heading row of the wide list (hidden below 900 px; aria-hidden, the cells
 *  carry their own keys for screen readers). */
export function colsHtml(lang) {
  return `<div class="cols" aria-hidden="true">${columnHeads(lang).map((h) => `<span${h ? ` title="${esc(h)}"` : ""}>${esc(h)}</span>`).join("")}</div>`;
}

/** True when the port or a guard on it needs a hand: the restart pill gets
 *  the strong fill only then (four loud pills would drown the one that matters). */
export function portNeedsHand(r) {
  return r.status.tone === "bad" || r.guards.some((g) => core.needsAttention(g.state) && g.state !== "blind");
}

// Placeholder for a value that a translated sentence carries but the card
// renders as markup (a mono id, a link): the sentence is split around it.
const MARK = "\u0001";

/** `text` (with one MARK) as escaped markup, `html` where the MARK was. */
function around(text, html) {
  const at = text.indexOf(MARK);
  if (at < 0) return esc(text);
  return `${esc(text.slice(0, at))}${html}${esc(text.slice(at + MARK.length))}`;
}

const mono = (id) => `<span class="mono">${esc(id)}</span>`;

// How a guard's expected id relates to its port: tone + icon of the badge.
const RELATION = {
  live: { tone: "good", icon: "mdi:check-circle" },
  ambiguous: { tone: "warn", icon: "mdi:call-split" },
  last_known: { tone: "idle", icon: "mdi:history" },
  mismatch: { tone: "bad", icon: "mdi:alert-circle" },
  elsewhere: { tone: "idle", icon: "mdi:swap-horizontal" },
};

/** Origin of the port's id (rows without `mapping` fall back to idSource). */
function originOf(r) {
  if (r.idOrigin) return r.idOrigin;
  const kind = { entity: "live", static: "fixed", conflict: "conflict" }[r.idSource] || "none";
  return { kind, entity: r.idEntity || null, attribute: null, entityName: null };
}

/** The "Connected" main value: the id (mono), the misconfiguration, or an
 *  empty port with the id the cache still expects there. */
export function idMainHtml(r, lang) {
  if (r.idSource === "conflict") {
    const msg = core.t(lang, "poe.id_conflict");
    return `<span class="v bad" title="${esc(msg)}">${esc(msg)}</span>`;
  }
  if (r.idValue) {
    const shown = r.idDisplay || r.idValue;
    const raw = String(r.idValue).trim();
    const title = raw && raw !== shown ? `${shown} (${raw})` : shown;
    return `<span class="v mono" title="${esc(title)}">${esc(shown)}</span>`;
  }
  const expected = r.emptyExpected || [];
  if (expected.length) {
    const first = around(core.t(lang, "poe.empty_expected", { id: MARK }), mono(expected[0]));
    const more = expected.slice(1).map((id) => ` · ${mono(id)}`).join("");
    return `<span class="v empty" title="${esc(r.emptyLabel || "")}">${first}${more}</span>`;
  }
  return `<span class="muted">${esc(core.t(lang, "poe.id_none"))}</span>`;
}

/** Where the id comes from: "live · from <entity>" (a link to its more-info;
 *  a hollow dot while it reports nothing), "Fixed id", "No id source",
 *  or for a misconfigured port "conflict · fixed <id> and <entity>". */
export function idOriginHtml(r, i, lang) {
  const o = originOf(r);
  const link = () => {
    const source = `${o.entity}${o.attribute ? `.${o.attribute}` : ""}`;
    // The entity's name reads better than its long id ("Port 18 Nachbarn ·
    // mac"); the id stays in the tooltip.
    const shown = o.entityName ? `${o.entityName}${o.attribute ? ` · ${o.attribute}` : ""}` : source;
    const title = o.entityName ? `${o.entityName} (${source})` : source;
    return `<button data-action="more-info" data-entity="${esc(o.entity)}" data-key="src${i}" title="${esc(title)}">${esc(shown).replace(/([._])/g, "$1<wbr>")}</button>`;
  };
  if (o.kind === "conflict") {
    const fixed = o.staticId || r.idStatic;
    if (!fixed || !o.entity) return "";
    const text = core.t(lang, "poe.id_conflict_from", { id: MARK, source: "\u0002" });
    const [head, rest] = text.split(MARK);
    const [mid, tail] = (rest || "").split("\u0002");
    return `<span class="src conflict"><span>${esc(head)}${mono(fixed)}${esc(mid || "")}${link()}${esc(tail || "")}</span></span>`;
  }
  if (o.kind === "live" && o.entity) {
    const empty = o.empty === true || (o.empty == null && !r.idValue);
    return `<span class="src live${empty ? " empty" : ""}"><span>${around(core.t(lang, "poe.id_live_from", { source: MARK }), link())}</span></span>`;
  }
  if (o.kind === "fixed") return `<span class="src"><span>${esc(core.t(lang, "poe.id_static"))}</span></span>`;
  return `<span class="src"><span>${esc(core.t(lang, "poe.id_source_none"))}</span></span>`;
}

/** One guard on the port: its chip plus how its expected id relates to the
 *  port ("matches", "ambiguous · also on Port 25", "last known", "expected:
 *  A4:… · port reports B8:…"). */
export function guardLineHtml(g, r, i, lang) {
  const chip = `<button class="gchip" style="--gc:${core.stateColor(g.state)}" data-action="more-info" data-entity="${esc(g.statusEntity || "")}" data-key="g${i}-${esc(g.statusEntity || "")}" title="${esc(`${g.name}: ${core.t(lang, `state.${g.state}`)}`)}"><span class="d"></span><span class="n">${esc(g.name)}</span></button>`;
  const relation = g.relation || g.match || "live";
  const look = RELATION[relation];
  if (!look) return `<span class="gl">${chip}</span>`;
  const word = g.relationLabel || core.t(lang, `poe.rel.${relation}`);
  // The expected id where it is not already on screen: a mismatch (the port
  // shows another id), a guard whose id is now elsewhere, or a second id an
  // empty port expects (the "Connected" line names only the first).
  const expected = g.expectedDisplay || (g.expectedId ? String(g.expectedId).trim() : "");
  const showId =
    expected &&
    (relation === "mismatch" || relation === "elsewhere" || (relation === "last_known" && (r.emptyExpected || [])[0] !== expected));
  const idPart = showId ? `${around(core.t(lang, "poe.expected", { id: MARK }), mono(expected))} · ` : "";
  const plain = `${showId ? `${core.t(lang, "poe.expected", { id: expected })} · ` : ""}${word}`;
  // A mismatch names what the port reports instead, that id in mono too.
  const others = g.otherPorts || [];
  const wordHtml =
    relation === "mismatch" && g.reportedDisplay
      ? `${around(core.t(lang, "poe.rel.reports", { id: MARK }), mono(g.reportedDisplay))}${others.length ? esc(` · ${core.t(lang, "poe.rel.now_on", { ports: others.join(", ") })}`) : ""}`
      : esc(word);
  const rel = `<span class="rel" style="--rc:${TONE_COLORS[look.tone]}; --rt:${core.toneTextColor(look.tone)}" title="${esc(`${g.name}: ${plain}`)}"><ha-icon icon="${look.icon}"></ha-icon><span>${idPart}${wordHtml}</span></span>`;
  return `<span class="gl">${chip}${rel}</span>`;
}

/** One fact of a port: icon + key (narrow), main value and an optional tag. */
function cellHtml(cls, icon, key, main, extra = "", cvCls = "") {
  return `<div class="cell ${cls}"><ha-icon icon="${icon}"></ha-icon><span class="k">${esc(key)}</span><span class="cw"><span class="cv${cvCls ? ` ${cvCls}` : ""}">${main}</span>${extra ? `<span class="cx">${extra}</span>` : ""}</span></div>`;
}

/**
 * Markup of one port row (all three layouts; CSS picks the arrangement).
 * `armed` = the restart waits for its second tap, `running` = a restart from
 * this card is in flight.
 */
export function portRowHtml(r, i, lang, { armed = false, running: own = false, now = Date.now() } = {}) {
  const tc = TONE_COLORS[r.tone] || TONE_COLORS.idle;
  const name = portName(r.label, lang);

  // Switch: the actuator's name (tap = its more-info) plus its power state;
  // the one status line in the header already says what that means.
  let sw;
  let swTag = "";
  if (r.actuator) {
    const on = r.power === "on";
    const tone = r.power == null ? "idle" : on ? "good" : "bad";
    const power = r.power == null ? core.t(lang, "state.unavailable") : core.t(lang, on ? "poe.power_on" : "poe.power_off");
    // The device only when the switch's name does not already say it
    // ("PoE-Switch-Serverschrank Port 18" needs no "· PoE-Switch-Serverschrank").
    const said = r.switchDevice && String(r.switch || "").toLowerCase().startsWith(String(r.switchDevice).toLowerCase());
    const dev = r.switchDevice && r.switchDevice !== r.switch && !said ? `<span class="muted" title="${esc(r.switchDevice)}">· ${esc(r.switchDevice)}</span>` : "";
    sw = `<button class="v" data-action="more-info" data-entity="${esc(r.actuator)}" data-key="act${i}" title="${esc(`${r.switch} (${r.actuator})`)}">${esc(r.switch)}</button>${dev}`;
    swTag = `<button class="tag" style="--t:${TONE_COLORS[tone]}" data-action="more-info" data-entity="${esc(r.actuator)}" data-key="pw${i}"><ha-icon icon="${on ? "mdi:flash" : "mdi:flash-off"}"></ha-icon>${esc(power)}</button>`;
  } else sw = `<span class="muted">–</span>`;

  // Connected: the id (or the empty port's expected id) with the device's
  // online tag on one line, where the id comes from on the line below.
  let idHtml = idMainHtml(r, lang);
  const idTag = idOriginHtml(r, i, lang);
  // An empty port that a guard still expects already says "Nothing connected":
  // an "Offline" tag beside it would only repeat the header's status.
  if (r.online != null && !(r.online === false && !r.idValue && (r.emptyExpected || []).length)) {
    idHtml += `<button class="tag" style="--t:${TONE_COLORS[r.online ? "good" : "bad"]}" data-action="more-info" data-entity="${esc(r.statusEntity || "")}" data-key="st${i}" title="${esc(t(lang, "ui.status"))}"><ha-icon icon="${r.online ? "mdi:lan-connect" : "mdi:lan-disconnect"}"></ha-icon>${esc(core.t(lang, r.online ? "poe.online" : "poe.offline"))}</button>`;
  }

  const guards = r.guards.length
    ? r.guards.map((g) => guardLineHtml(g, r, i, lang)).join("")
    : `<span class="muted">${esc(core.t(lang, "poe.unused"))}</span>`;

  let last;
  let lastTag = "";
  if (r.lastCycle) {
    const when = core.formatRelative(r.lastCycle.at, now, lang);
    last = `<span class="v">${esc(when)}</span>`;
    lastTag = `<span class="${r.lastCycle.ok ? "ok" : "bad"}">${esc(core.t(lang, r.lastCycle.ok ? "poe.last_ok" : "poe.last_failed"))}</span>`;
  } else last = `<span class="muted">${esc(core.t(lang, "poe.never"))}</span>`;

  // Restart: tonal on a healthy port, strong only when it needs a hand.
  const running = own || r.busy;
  const trouble = portNeedsHand(r);
  const label = running ? core.t(lang, "poe.status.recovering") : armed ? core.t(lang, "action.sure") : t(lang, "ui.restart_short");
  const full = core.t(lang, "action.repair_poe_port");
  const disabled = !r.canRepair || running;
  const cls = armed ? "confirm" : trouble ? "strong" : "";
  const btn = `<button class="pill go ${cls}" data-action="restart" data-i="${i}" data-key="rs${i}" title="${esc(full)}" aria-label="${esc(armed ? core.t(lang, "action.sure") : `${full}: ${name}`)}"${disabled ? ` aria-disabled="true"` : ""}><ha-icon icon="mdi:restart"></ha-icon><span class="label">${esc(label)}</span></button>`;

  return `
    <div class="port" style="--tc:${tc}; --st:${core.toneTextColor(r.status.tone)}">
      <div class="pb ${r.busy ? "busy" : ""}" aria-hidden="true"><ha-icon icon="mdi:ethernet"></ha-icon></div>
      <div class="ptext">
        <div class="plabel" title="${esc(name)}">${esc(name)}</div>
        <div class="pstatus"><span class="d"></span><span>${esc(r.status.label)}</span></div>
      </div>
      ${btn}
      <div class="info">
        ${cellHtml("sw", "mdi:switch", core.t(lang, "poe.switch"), sw, swTag)}
        ${cellHtml("id", "mdi:link-variant", t(lang, "ui.connected"), idHtml, idTag)}
        ${cellHtml("used", "mdi:shield-check", core.t(lang, "poe.used_by"), guards, "", r.guards.length ? "guards" : "")}
        ${cellHtml("last", "mdi:history", core.t(lang, "poe.last_cycle"), last, lastTag)}
      </div>
    </div>`;
}

/**
 * Whether a port `label` is one the card option `ports` names: the whole label
 * or its port part ("Port 5" matches "Port 5 · Chime", not "Port 50"),
 * ignoring case. Pure.
 */
export function portMatches(label, wanted) {
  const w = String(wanted ?? "").trim().toLowerCase();
  if (!w) return false;
  // The label as configured and as shown ("5" shows as "Port 5" / "Port 5").
  const names = [String(label ?? ""), portName(label, "en"), portName(label, "de")].map((x) => x.trim().toLowerCase()).filter(Boolean);
  return names.some((l) => l === w || l.startsWith(`${w} `));
}

export class NecromancerPoeCard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._payload = null;
    this._error = null;
    this._loading = false;
    this._loadedOnce = false;
    this._sig = null;
    this._visible = true;
    this._running = new Set();
    this._timer = null;
    this._unsub = null;
    this._io = null;
    this._html = null;
    this._rows = [];
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><ha-card></ha-card>`;
    this._card = root.querySelector("ha-card");
    this._confirm = new Confirm(() => this._render(true));
    root.addEventListener("click", (ev) => this._click(ev));
  }

  setConfig(config) {
    const c = { ...(config || {}) };
    if (c.ports != null && !(Array.isArray(c.ports) && c.ports.every((x) => typeof x === "string" || typeof x === "number"))) {
      throw new Error("ports must be a list of port names");
    }
    this._config = c;
    this._sig = null;
    this._render(true);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first || (!this._loadedOnce && !this._loading)) this._load();
    this._render(false);
  }

  get hass() {
    return this._hass;
  }

  /** The loaded ports (the panel shows the PoE tab only when there are any). */
  get ports() {
    return this._payload ? this._payload.ports || [] : null;
  }

  getCardSize() {
    return 2 + 2 * ((this.ports && this.ports.length) || 1);
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  static getStubConfig() {
    return {};
  }

  /** The editor: HA's own form (the title); the port selection is YAML only. */
  static getConfigForm() {
    const de = docLang() === "de";
    return {
      schema: [{ name: "title", selector: { text: {} } }],
      computeLabel: (item) => (item.name === "title" ? (de ? "Titel" : "Title") : undefined),
      computeHelper: (item) =>
        item.name === "title"
          ? de
            ? "Standard: PoE-Ports. Nur bestimmte Ports: im YAML-Editor `ports:` mit ihren Namen, z. B. „Port 5“."
            : "Default: PoE ports. Only some ports: `ports:` with their names in the YAML editor, e.g. “Port 5”."
          : undefined,
    };
  }

  connectedCallback() {
    if (!this._io && typeof IntersectionObserver !== "undefined") {
      this._io = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible === this._visible) return;
        this._visible = visible;
        if (visible) this._load();
        this._arm();
      });
      this._io.observe(this);
    }
    this._subscribe();
    this._arm();
  }

  disconnectedCallback() {
    if (this._io) this._io.disconnect();
    this._io = null;
    clearInterval(this._timer);
    this._timer = null;
    this._confirm.clear();
    if (this._unsub) {
      const u = this._unsub;
      this._unsub = null;
      Promise.resolve(u).then((fn) => typeof fn === "function" && fn()).catch(() => {});
    }
  }

  _isAdmin() {
    return Boolean(this._hass && this._hass.user && this._hass.user.is_admin);
  }

  /** Periodic reload only while connected and visible. */
  _arm() {
    clearInterval(this._timer);
    this._timer = null;
    if (!this.isConnected || !this._visible || !this._isAdmin()) return;
    this._timer = setInterval(() => this._load(), REFRESH_MS);
  }

  _subscribe() {
    const conn = this._hass && this._hass.connection;
    if (this._unsub || !conn || !this._isAdmin() || !this.isConnected) return;
    try {
      this._unsub = conn.subscribeEvents(() => this._load(), POE_EVENT);
      Promise.resolve(this._unsub).catch(() => {
        this._unsub = null;
      });
    } catch (_err) {
      this._unsub = null;
    }
  }

  async _load() {
    if (!this._hass || this._loading) return;
    if (!this._isAdmin()) {
      this._loadedOnce = true;
      this._render(true);
      return;
    }
    this._subscribe();
    if (!this._timer) this._arm();
    this._loading = true;
    try {
      this._payload = await loadPoePorts(this._hass);
      this._error = null;
    } catch (_err) {
      this._error = "ui.poe_error";
    } finally {
      this._loading = false;
      this._loadedOnce = true;
    }
    this._render(true);
    this.dispatchEvent(new CustomEvent("necromancer-poe-loaded", { detail: { count: (this.ports || []).length }, bubbles: true, composed: true }));
  }

  /** Inputs of a render: the payload plus every entity a tile reads. */
  _signature() {
    const h = this._hass;
    const ids = new Set();
    for (const p of this.ports || []) {
      for (const k of ["actuator", "id_entity", "status_entity"]) if (p[k]) ids.add(p[k]);
      for (const g of p.guards || []) if (g.status_entity) ids.add(g.status_entity);
    }
    return [this._payload, this._error, langFrom(h), h && h.user && h.user.is_admin, ...[...ids].map((id) => h.states[id])];
  }

  _render(force) {
    const h = this._hass;
    if (!h || !h.states) return;
    const sig = this._signature();
    if (!force && sameSig(sig, this._sig)) return;
    this._sig = sig;
    const lang = langFrom(h);
    const admin = this._isAdmin();
    const all = this._payload ? core.poePortRows(this._payload, h, lang, { mapping: true }) : [];
    const rows = Array.isArray(this._config.ports) ? all.filter((r) => this._config.ports.some((w) => portMatches(r.label, w))) : all;
    this._rows = rows;
    const failing = rows.some((r) => r.status.tone === "bad");
    const busy = rows.some((r) => r.busy);
    this._card.style.setProperty("--hc", busy ? TONE_COLORS.active : failing ? TONE_COLORS.bad : TONE_COLORS.good);

    const title = this._config.title || t(lang, "ui.poe_title");
    const edit =
      admin && this._payload
        ? `<button class="pill neutral" data-action="edit"><ha-icon icon="mdi:pencil"></ha-icon><span>${esc(core.t(lang, "action.edit_ports"))}</span></button>`
        : "";
    let body;
    if (!admin) body = `<div class="msg"><ha-icon icon="mdi:shield-lock"></ha-icon>${esc(t(lang, "ui.poe_admin"))}</div>`;
    else if (this._error && !this._payload) body = `<div class="msg err"><ha-icon icon="mdi:alert-circle"></ha-icon>${esc(t(lang, this._error))}</div>`;
    else if (!this._payload) body = `<div class="msg"><ha-icon icon="mdi:timer-sand"></ha-icon>${esc(t(lang, "ui.loading"))}</div>`;
    else if (!rows.length) body = `<div class="msg"><ha-icon icon="mdi:ethernet-off"></ha-icon>${esc(core.t(lang, "poe.empty"))}</div>`;
    else body = `<div class="ports">${colsHtml(lang)}${rows.map((r, i) => this._row(r, i, lang)).join("")}</div>`;

    const html = `
      <div class="head">
        <div class="hb" aria-hidden="true"><ha-icon icon="mdi:ethernet"></ha-icon></div>
        <div class="ttl"><div class="title">${esc(title)}</div><div class="sub">${this._payload ? esc(t(lang, rows.length === 1 ? "ui.ports_one" : "ui.ports", { n: rows.length })) : ""}</div></div>
        ${edit}
      </div>
      ${body}`;
    if (html !== this._html) {
      this._html = html;
      const active = this.shadowRoot.activeElement;
      const key = active && active.dataset ? active.dataset.key : null;
      this._card.innerHTML = html;
      if (key) {
        const again = this._card.querySelector(`[data-key="${key}"]`);
        if (again) again.focus();
      }
    }
  }

  _portName(r, lang) {
    return portName(r.label, lang);
  }

  _row(r, i, lang) {
    const key = `restart:${i}`;
    return portRowHtml(r, i, lang, { armed: this._confirm.is(key), running: this._running.has(key), now: Date.now() });
  }

  _click(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el || el.getAttribute("aria-disabled") === "true") return;
    ev.stopPropagation();
    switch (el.dataset.action) {
      case "more-info":
        if (el.dataset.entity) moreInfo(this, el.dataset.entity);
        return;
      case "edit": {
        const entry = this._payload && this._payload.entry_id;
        navigate(`${core.EDIT_PATH}${entry ? `?config_entry=${encodeURIComponent(entry)}` : ""}`);
        return;
      }
      case "restart": {
        const i = Number(el.dataset.i);
        const row = this._rows[i];
        if (!row || !row.canRepair) return;
        const key = `restart:${i}`;
        if (!this._confirm.check(key)) return;
        this._restart(key, row);
        return;
      }
      default:
    }
  }

  async _restart(key, row) {
    this._running.add(key);
    this._render(true);
    try {
      const lang = langFrom(this._hass);
      await runAction(this, this._hass, null, "repair_poe_port", { id: row.repairId, port: this._portName(row, lang), lang });
    } finally {
      this._running.delete(key);
      await this._load();
    }
  }
}

if (!customElements.get(TAGS.poe)) customElements.define(TAGS.poe, NecromancerPoeCard);
