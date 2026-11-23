// Guard card (necromancer-guard-card), design §4/§5, compact and wider than
// tall: a 24 px card with a state-coloured gradient behind the header, a
// round icon bubble (48 px), the status as a badge, the main value (24 px),
// round chips top right and one tray row with the last event on the left and
// the pill buttons on the right (they wrap below only when the card is narrow).
//
// Options on top of §5: `expandable: true` lets a compact row open into
// the full card in place (the guards card uses it), `embedded: true` drops the
// card's own shadow/border so it sits inside another card as an inner bubble.
//
// The 24 h state timeline (shared necromancer-timeline.js): the full card
// shows the "Last 24 h" section (strip, axis, last transitions) above the
// detail text and the pills only with `timeline: true` (default false: no
// section, no history query, no store subscription). A compact card or a
// collapsed row shows ONE detail in its free slot, chosen by `row_detail`:
// "text" (default: the last event, else the quiet context line; no history
// query at all) or "timeline" (a thin strip; one batched query for all rows).
// An opened row (compact + expandable, the guards card and the panel) always
// shows the section: it asks for that one guard's history (cached in the
// page-wide store, live points afterwards). The old `show_timeline: true`
// still reads as `row_detail: timeline` (it does not switch on `timeline`).
//
// Main value (core.mainValue with `rich`): a state guard on a numeric entity
// shows its value ("200 W") with the caption "Healthy for 19 min"; the caption
// sits next to the value on the same baseline and wraps below only when the
// card is too narrow (flat card). The value line spans under the chips when
// they fit on one line, so the chips do not squeeze it into wrapping. Every
// "for N min" counts from when the guard really entered its state (stateSince:
// the status sensor's `state_since`, else `escalated_at`, else the 24 h
// history, else HA's last_changed), so value, transition chips and the event
// text agree after an HA restart.
//
// The full card lists the newest transitions; on a narrow card (< 600 px)
// only two, plus a "+N" that shows the rest (one chip row less).
//
// Buttons (core.actionsFor, design §16): the state's main pill and snooze,
// the rest in the ⋮ menu. A narrow row shows only the main pill, as a round
// icon button, and its menu takes snooze. `show_actions: false`: no buttons,
// and chips and the recovery popup only inform.
//
// The compact row is also the guards card's list row: on a wide container
// (>= 900 px) it becomes a column grid (icon + name/state | value | detail
// (text, capped at ~70ch, or the 24 h strip) | pill + chips + menu), on a
// narrow one the header line plus the detail (text or strip) on a second line
// under the name, so "Text" and "Timeline" are a real choice at any width.

// Loaded with this module's own query, so `?v=` reaches the shared base and
// the sibling modules too (one version, one instance of each per page).
const Q = new URL(import.meta.url).search;
const { BASE_STYLE, Confirm, Pop, TAGS, actions, checkSharedOptions, contextLine, core, defaultSelect, docLang, dropLeadingState, esc, glueEventText, langFrom, quietOldEvent, rowDetailField, sameSig, sharedFormLabel, snoozeItems, stateSince, statusText, t, timeZoneOf, timeline, tl, withPeriodFormatted, withRowDetail, withoutPeriodClause } = await import(`./necromancer-base.js${Q}`);

const { REC_STYLE, RecoveryDialog } = await import(`./necromancer-recovery.js${Q}`);

const { loadGuardRecovery, runAction, toast } = actions;
const { CONFIRM_ACTIONS, TONE_COLORS } = core;

// Marks a ticking text in the markup: the structure is diffed without it, and a
// tick only rewrites the text of the `[data-tick]` elements.
const SLOT = "\u0001";
const SLOT_RE = /\u0001(\w+)\u0001/g;

// Actions whose plain service call gets a "done" toast (the shared helper
// already toasts snooze, check and url).
const DONE_TOAST = new Set(["revive", "reset", "unsnooze", "ping", "auto"]);


/** "4 repaired · 1 failed" from the status attributes, "" when both are zero. */
export function countsText(attrs, lang) {
  const ok = Number(attrs && attrs.recover_count) || 0;
  const fail = Number(attrs && attrs.fail_count) || 0;
  if (!ok && !fail) return "";
  return t(lang, "ui.counts", { ok, fail });
}

// An escalation younger than this keeps the strong bubble inside lists/grids.
const HOT_SECONDS = 3600;

const STYLE = `
  ${BASE_STYLE}
  ${REC_STYLE}
  ha-card {
    height: 100%; box-sizing: border-box; overflow: hidden; position: relative;
    container-type: inline-size; display: flex; flex-direction: column;
    border-radius: var(--ui-radius);
    --nc-soft: color-mix(in srgb, var(--nc) 16%, transparent);
    --nc-strong: color-mix(in srgb, var(--nc) 88%, #000);
  }
  ha-card.embedded {
    box-shadow: none; border: none;
    background-color: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
    --tint: 0.6;
  }
  /* Full layout: the state glow sits on the card itself (fixed 230 px high),
     so it fades out softly instead of ending at the hero's bottom edge when
     the timeline or the tray follow. Only the image: the theme keeps the
     card colour. */
  ha-card.full {
    background-image:
      radial-gradient(130% 230px at 0% 0%, color-mix(in srgb, var(--nc) calc(28% * var(--tint, 1)), transparent) 0%,
        color-mix(in srgb, var(--nc) calc(9% * var(--tint, 1)), transparent) 45%, transparent 75%);
  }

  /* ---- full layout: hero (bubble, text, chips), timeline, tray ---- */
  /* A grid: name and badge beside the chips, the value line under both, so
     the chips do not squeeze "200 W  Healthy for 19 min" into wrapping (the
     chips' height is already there next to name + badge). Also when a narrow
     card's chips wrap into a block ("many"): the row grows a little, but the
     value keeps its full width instead of "for 2 h 1…". */
  .hero {
    position: relative; display: grid; align-items: start; align-content: start; column-gap: 12px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    grid-template-areas: "b n c f" "b s c f" "b v v v";
    padding: 14px 14px 10px; flex: 1;
  }
  .hero > .bubble { grid-area: b; }
  .hero > .text { display: contents; }
  .hero .name { grid-area: n; }
  .hero .badge { grid-area: s; justify-self: start; }
  .hero .vline { grid-area: v; }
  .hero > .chips { grid-area: c; }
  .hero > .fold { grid-area: f; }
  .bubble {
    position: relative; flex: none; width: 48px; height: 48px; border-radius: 50%; border: none; padding: 0;
    display: grid; place-items: center; cursor: pointer;
    background: color-mix(in srgb, var(--nc) 22%, var(--ui-surface)); color: var(--nc);
    box-shadow: 0 4px 14px color-mix(in srgb, var(--nc) 28%, transparent);
    --mdc-icon-size: 26px; transition: transform 0.3s var(--ui-spring);
  }
  .bubble:active { transform: scale(0.9); }
  /* Strong fill only for an escalation that still needs a first look: in a
     grid of cards the fresh ones stand out, older ones keep the red icon. */
  .hot .bubble { background: var(--nc-strong); color: var(--ui-on); }
  .busy .bubble::after {
    content: ""; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
    animation: a-ring 2.2s ease-out infinite;
  }
  .busy .bubble ha-icon { animation: a-breathe 2.2s ease-in-out infinite; }
  @keyframes a-ring {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--nc) 55%, transparent); }
    100% { box-shadow: 0 0 0 12px transparent; }
  }
  @keyframes a-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.86); opacity: 0.7; } }
  .text { min-width: 0; }
  .name {
    font-size: 15.5px; font-weight: 800; line-height: 1.25; color: var(--ui-text); letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
  }
  /* Full card: a long name gets a second line rather than an ellipsis. */
  .hero .name { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; max-width: 100%; box-sizing: border-box;
    margin-top: 4px; padding: 2px 9px 2px 7px; border-radius: 999px;
    background: var(--nc-soft); color: color-mix(in srgb, var(--nt) 80%, var(--ui-text));
    font-size: 12px; font-weight: 700; line-height: 1.4;
  }
  .badge span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--nc); }
  /* Main value and its caption on one baseline ("200 W  Healthy for 19 min");
     the caption wraps below only when both do not fit (keeps the card flat). */
  .vline { margin-top: 6px; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 0; min-width: 0; }
  .value {
    flex: 0 1 auto; min-width: 0; max-width: 100%; font-size: 24px; font-weight: 800; line-height: 1.1; letter-spacing: -0.015em;
    color: var(--ui-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  button.value { border: none; background: none; padding: 0; margin: 0; cursor: pointer; text-align: left; border-radius: 6px; }
  button.value:hover { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px;
    text-decoration-color: color-mix(in srgb, var(--ui-text) 25%, transparent); }
  .value.late { color: ${TONE_COLORS.bad}; }
  .caption { flex: 0 1 auto; min-width: 0; max-width: 100%; font-size: 12.5px; font-weight: 600; line-height: 1.4; color: var(--ui-text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Chips top right, at most three per line (the text keeps its width); a wide
     card lets them spread. Widths in container units (cqi = the card): a
     percentage would resolve against the chips' own auto grid column and
     wrap them one per line. */
  .chips { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 114px; }
  /* The user's own chips (\`chips\`) after a thin rule. */
  .chip.own.first { margin-left: 9px; }
  .chip.own.first::before { content: ""; position: absolute; left: -8px; top: 7px; bottom: 7px; width: 1px; background: color-mix(in srgb, var(--ui-text) 22%, transparent); }
  .chip {
    position: relative; width: 34px; height: 34px; border-radius: 50%; border: none; padding: 0;
    display: grid; place-items: center; cursor: pointer;
    /* Pulled toward the text colour: grey "idle" stays visible on dark themes. */
    color: color-mix(in srgb, var(--chip) 78%, var(--ui-text));
    background: color-mix(in srgb, var(--chip) 18%, var(--ui-surface));
    box-shadow: 0 2px 6px color-mix(in srgb, var(--chip) 16%, transparent);
    --mdc-icon-size: 18px; transition: transform 0.25s var(--ui-spring), background 0.2s ease;
  }
  .chip:hover { background: color-mix(in srgb, var(--chip) 28%, var(--ui-surface)); }
  .chip:active { transform: scale(0.86); }
  .chip.count { grid-template-rows: auto auto; align-content: center; gap: 0; --mdc-icon-size: 11px; }
  .chip.count span { font-size: 11.5px; font-weight: 900; line-height: 1; }
  .chip.confirm { background: color-mix(in srgb, var(--chip) 88%, #000); color: var(--ui-on); animation: a-wiggle 0.4s var(--ui-spring); }
  /* "Auto off" with its word (full card): an orange pill-shaped chip, text in
     the pill colour pulled toward the text colour (>= 4.5:1 like the pills). */
  .chip.wide {
    width: auto; padding: 0 11px 0 9px; border-radius: 17px; grid-auto-flow: column; gap: 5px;
    font-size: 12.5px; font-weight: 800; white-space: nowrap; color: color-mix(in srgb, var(--chip) 50%, var(--ui-text));
  }
  .chip.wide.confirm { color: var(--ui-on); }
  /* The actor chip in the neutral tone: the text colour on a light tint, like
     the neutral pills (not the disabled grey, not a dark disc). */
  .chip.actor:not(.confirm) { background: color-mix(in srgb, var(--chip) 9%, var(--ui-surface)); color: color-mix(in srgb, var(--chip) 85%, var(--ui-text)); }
  .chip.actor:not(.confirm):hover { background: color-mix(in srgb, var(--chip) 16%, var(--ui-surface)); }
  .chips.haswide { max-width: max(114px, 46cqi); }
  /* "+N" bubble: only on a narrow card with more than five chips (see below). */
  .chip.more { display: none; font-size: 12px; font-weight: 900; color: var(--ui-text2); background: var(--ui-soft2); box-shadow: none; }
  .fold {
    flex: none; width: 32px; height: 32px; margin: -2px -4px 0 0; border-radius: 50%; border: none; padding: 0;
    display: grid; place-items: center; cursor: pointer; background: var(--ui-soft); color: var(--ui-text2);
    --mdc-icon-size: 20px; transition: transform 0.25s var(--ui-spring);
  }
  .fold:active { transform: scale(0.88); }

  /* 24 h timeline: between the hero and the tray (full card with
     timeline: true, and every opened row). */
  .tlsec { padding: 0 14px 10px; }
  /* Narrow card: two transitions and a "+N" (one chip row less); from 600 px
     all of them fit on one line. */
  .tlsec:not(.all) .tl-log li.tl-x { display: none; }
  .tlsec:not(.all) .tl-log li.tl-more { display: inline-flex; }

  /* One tray row: the last event left, the pills right. The event keeps
     ~170 px; when the pills do not fit beside it they wrap onto their own
     line instead of cutting the text. */
  .tray {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0 8px 8px; min-height: 44px;
    box-sizing: border-box; padding: 4px 4px 4px 6px; border-radius: 22px; background: var(--ui-soft);
  }
  .tray.noev { background: none; min-height: 0; padding: 0 4px; margin: 0 10px 10px; }
  .ev { flex: 1 1 170px; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .evicon {
    flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    color: var(--tone); background: color-mix(in srgb, var(--tone) 18%, transparent); --mdc-icon-size: 17px;
  }
  .event { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.3; color: var(--ui-text);
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere;
    text-wrap: balance; }
  /* No event: the quiet context line ("No repairs so far") in its place. */
  /* The quiet line yields to the pills (truncates to two lines) before they
     wrap: the card stays one tray high. */
  .ev.quiet { flex: 1 1 90px; }
  .evtxt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .counts { font-size: 12px; font-weight: 600; line-height: 1.3; color: var(--ui-text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ev.quiet .evicon { color: var(--ui-text2); background: color-mix(in srgb, var(--ui-text2) 12%, transparent); }
  .ev.quiet .event { color: var(--ui-text2); }
  /* An event older than the current state ("Last escalation 150 d ago") is
     history, not news: secondary text like the quiet line. */
  .ev.past .event { color: var(--ui-text2); }
  .actions { flex: none; display: flex; gap: 4px; margin-left: auto; }
  .pill.accent { --pill: var(--nc); }
  /* Grey states: grey is the state signal, not the button colour (a grey
     filled pill reads as disabled), so their pills use the theme accent. */
  .muted .pill.accent { --pill: var(--ui-accent); }

  /* ---- compact layout: one bubble row (also the guards card's list row) ---- */
  .row {
    display: grid; align-items: center; column-gap: 10px; row-gap: 3px;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    grid-template-areas: "b t v h m";
    padding: 6px 8px 6px 6px; min-height: 52px;
    box-sizing: border-box; flex: 1; border-radius: var(--ui-radius);
    background: linear-gradient(90deg, color-mix(in srgb, var(--nc) calc(20% * var(--tint, 1)), transparent), transparent 70%);
    --ui-pill-h: 34px;
  }
  /* Narrow row with a timeline: the strip gets its own line under the whole
     row (bubble column to the end), so every row's "-24 h ... now" has the
     same width and the strips line up from row to row. */
  .row.tl { grid-template-areas: "b t v h m" "b s s s s"; }
  /* Narrow row with row_detail "text": the last event (or the context) as a
     muted line under the name, like the strip above, so the option shows at
     card, column and phone width too. */
  .row.tx { grid-template-areas: "b t v h m" "b e e e e"; }
  /* The main pill as a round icon button in the narrow row. */
  .row.pin { grid-template-columns: auto minmax(0, 1fr) auto auto auto auto; grid-template-areas: "b t v a h m"; }
  .row.pin.tl { grid-template-areas: "b t v a h m" "b s s s s s"; }
  .row.pin.tx { grid-template-areas: "b t v a h m" "b e e e e e"; }
  .row.tx > .bubble, .row.tl > .bubble { align-self: start; margin-top: 1px; }
  .row.tx .revent { display: flex; gap: 6px; margin-top: -1px; }
  .row.tx .revent .evicon { width: 18px; height: 18px; --mdc-icon-size: 12px; }
  .row.tx .revent .rev { font-size: 12.5px; }
  .row.pin .ract { display: flex; }
  .row.pin .ract .pill { width: var(--ui-pill-h); padding: 0; }
  .row.pin .ract .pill .label { display: none; }
  /* Armed ("Sure?"): the word shows, the icon button widens for it. */
  .row.pin .ract .pill.confirm { width: auto; padding: 0 12px; }
  .row.pin .ract .pill.confirm .label { display: inline; }
  /* A narrow row shows the main pill only; its menu takes snooze. */
  .row .ract .pill.second { display: none; }
  .row.tap { cursor: pointer; }
  .row > .bubble { grid-area: b; width: 40px; height: 40px; --mdc-icon-size: 22px; box-shadow: none; }
  .embedded .row { min-height: 56px; }
  .embedded .row > .bubble { width: 44px; height: 44px; --mdc-icon-size: 24px; }
  .rtext { grid-area: t; min-width: 0; }
  .rstrip { grid-area: s; min-width: 0; align-self: start; }
  .rval { grid-area: v; min-width: 0; display: flex; }
  .rhealth { grid-area: h; display: flex; justify-content: flex-end; gap: 5px; }
  .rmore { grid-area: m; display: flex; }
  .ract { grid-area: a; display: none; gap: 4px; justify-content: flex-end; min-width: 0; }
  /* Last event in the wide row's free column (timeline off): one line. */
  .revent { grid-area: e; display: none; align-items: center; gap: 8px; min-width: 0; }
  .revent .evicon { width: 26px; height: 26px; --mdc-icon-size: 15px; }
  .revent .rev { flex: 0 1 auto; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.3; color: var(--ui-text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* No event: the context is the column's only text, a little quieter. */
  .revent.noev .evicon { background: color-mix(in srgb, var(--ui-text2) 12%, transparent); }
  .revent .rev.quiet { font-weight: 500; opacity: 0.92; }
  /* After the event: the context, muted, only where there is room (>= 1200 px). */
  .revent .rctx { display: none; flex: 1 1 0; min-width: 0; font-size: 12.5px; font-weight: 500; line-height: 1.3;
    color: var(--ui-text2); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .revent .rctx::before { content: "·"; margin: 0 8px 0 2px; }
  /* Timeline on: the event (or context) as a muted line under the strip, only
     on a very wide row (>= 1200 px); otherwise it lives in the strip's tooltip
     and aria-description. */
  .rnote { display: none; margin-top: 5px; font-size: 12px; font-weight: 500; line-height: 1.3; color: var(--ui-text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ract .pill { max-width: 100%; }
  .ract .pill .label { overflow: hidden; text-overflow: ellipsis; }
  /* One line with an ellipsis (full name in the tooltip): every row keeps the
     same height, also in the narrow panel. */
  .row .name { font-size: 14.5px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    line-height: 1.25; }
  .status { font-size: 12px; font-weight: 700; line-height: 1.35; color: var(--nt);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .status .dot { width: 7px; height: 7px; }
  /* The text is a flex item: the ellipsis has to sit on it (a flex container
     clips its text without one, "Problem, waitir" in a narrow strip row). */
  .status > span:not(.dot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .status:has(.until) { flex-wrap: wrap; white-space: normal; column-gap: 4px; row-gap: 0; }
  .status .until { white-space: nowrap; }
  /* The row's value inside the status line: only a narrow row shows it (its
     own column goes to the name there), as a small pill like the wide one. */
  .status > .sval { display: none; flex: none; overflow: visible; font-size: 12px; font-weight: 800; line-height: 1.35;
    color: var(--ui-text); padding: 0 7px; border-radius: 999px; background: var(--ui-soft); }
  .status > .sval.late { color: ${TONE_COLORS.bad}; }
  .cvalue { flex: none; font-size: 14px; font-weight: 800; color: var(--ui-text); white-space: nowrap;
    padding: 5px 11px; border-radius: 999px; background: var(--ui-soft); overflow: hidden; text-overflow: ellipsis; max-width: 100%; box-sizing: border-box; }
  .cvalue.late { color: ${TONE_COLORS.bad}; }
  .row .chip { width: 34px; height: 34px; box-shadow: none; }

  /* From 460 px the chips form one row (no 3 x 2 block that makes the card
     tall); six chips fit into the share either way. */
  @container (min-width: 460px) {
    .chips { max-width: 60cqi; }
  }
  @container (min-width: 600px) {
    .chips { max-width: 44cqi; }
    .tlsec .tl-log li.tl-x { display: inline-flex; }
    .tlsec .tl-log li.tl-more { display: none; }
  }

  /* Wide list row: columns name/state | value | 24 h | actions, no empty gap in
     the middle (the name column takes a share, the value starts right after).
     The action columns share one width per list, so value and strip line up
     from row to row whatever the pill says. */
  @container (min-width: 900px) {
    /* Name and value columns are as wide as the longest name / value of the
       list (the guards card measures them into --nc-name-w / --nc-val-w), so
       the value follows the names closely and lines up from row to row; the
       free width goes to the last event (timeline off) or the 24 h strip. */
    .row, .row.pin {
      column-gap: 16px; padding: 6px 10px 6px 6px;
      /* The event column takes all the free width (the text itself stops at
         ~70ch, see .revent); the strip (row_detail timeline) takes it too.
         The action and chip columns are as wide as the widest pill and the
         most chips of the list (--nc-act-w / --nc-chip-w, measured by the
         guards card), so no row keeps empty room the event text could use;
         a lone card falls back to the old fixed widths. */
      grid-template-columns: 44px min(max(170px, var(--nc-name-w, 240px)), 34%)
        min(max(88px, var(--nc-val-w, 128px)), 16%) minmax(0, 1fr)
        min(var(--nc-act-w, 240px), 300px) min(max(34px, var(--nc-chip-w, 112px)), 151px) 34px;
      grid-template-areas: "b t v e a h m";
    }
    .row.tl, .row.pin.tl { grid-template-areas: "b t v s a h m"; }
    .row.tx, .row.pin.tx { grid-template-areas: "b t v e a h m"; }
    .row.tx > .bubble, .row.tl > .bubble { align-self: center; margin-top: 0; }
    .row.tx .revent { gap: 8px; margin-top: 0; }
    .row.tx .revent .evicon { width: 26px; height: 26px; --mdc-icon-size: 15px; }
    .row.tx .revent .rev { font-size: 13px; }
    .row.pin .ract .pill { width: auto; padding: 0 14px; }
    .row.pin .ract .pill .label { display: inline; }
    .row .ract .pill.second { display: inline-flex; }
    .revent { display: flex; max-width: 70ch; }
    .row.tl .revent { display: none; }
    .rstrip { align-self: center; }
    .rstrip .tl-strip.thin { height: 8px; }
    .ract { display: flex; }
  }
  @container (min-width: 1200px) {
    .revent .rctx { display: block; }
    .rnote { display: block; }
  }
  /* Out of view: a strip still loading stops shimmering (no work off screen). */
  .off .tl-strip.skel, .off .tl-log.skel-line { animation-play-state: paused; }

  @container (max-width: 520px) {
    .cvalue { font-size: 13px; padding: 4px 9px; }
    .actions .pill:not(.round) + .pill:not(.round) { width: var(--ui-pill-h); padding: 0; }
    .actions .pill:not(.round) + .pill:not(.round):not(.confirm) .label { display: none; }
  }
  /* A narrow row (phone): the value moves from its own column into the
     status line ("Escalated  for 7 h 33 min"), so the name keeps its width
     beside the chips and the orange auto-off chip (double tap: on) stays.
     Measured at 390 px: name column ~71 px with the value pill, ~150 px
     without; the status line wraps the value onto its own line when both
     do not fit (nothing is cut). */
  @container (max-width: 430px) {
    .row { grid-template-columns: auto minmax(0, 1fr) auto auto; grid-template-areas: "b t h m"; }
    .row.tl { grid-template-areas: "b t h m" "b s s s"; }
    .row.tx { grid-template-areas: "b t h m" "b e e e"; }
    .row.pin { grid-template-columns: auto minmax(0, 1fr) auto auto auto; grid-template-areas: "b t a h m"; }
    .row.pin.tl { grid-template-areas: "b t a h m" "b s s s s"; }
    .row.pin.tx { grid-template-areas: "b t a h m" "b e e e e"; }
    .row > .rval { display: none; }
    .row .status { flex-wrap: wrap; white-space: normal; column-gap: 6px; row-gap: 1px; }
    .row .status > span:not(.dot):not(.sval) { white-space: nowrap; }
    .row .status > .sval { display: inline-block; white-space: nowrap; }
    /* Cap the inline chips at five plus a "+N" bubble, so a sixth/seventh
       chip never adds a line; the bubble shows them all. */
    .chips:not(.all) .chip:nth-child(n+6):not(.more) { display: none; }
    .chips:not(.all) .chip.more { display: grid; }
    /* Keep the main value on phones (design §5: compact = icon, name, status,
       main value, health chip, menu), just smaller. */
    .cvalue { font-size: 12.5px; padding: 3px 8px; }
    .actions .pill:not(.round) { padding: 0 12px; }
  }
  /* A narrow card (a dashboard column in edit mode, a side bar) moves three or
     more chips under the value; one or two (~74 px) stay top right down to
     280 px, as on a phone, instead of adding a row for two icons. */
  @container (max-width: 340px) {
    .hero:not(.few) { grid-template-areas: "b n n f" "b s s f" "b v v v" "c c c c"; }
    .hero:not(.few) > .chips { max-width: none; width: 100%; box-sizing: border-box; justify-content: flex-start; padding-left: 60px; margin-top: 8px; }
    .actions .pill:not(.round):not(.confirm) { width: var(--ui-pill-h); padding: 0; }
    .actions .pill:not(.round):not(.confirm) .label { display: none; }
  }
  @container (max-width: 280px) {
    .hero.few { grid-template-areas: "b n n f" "b s s f" "b v v v" "c c c c"; }
    .hero.few > .chips { max-width: none; width: 100%; box-sizing: border-box; justify-content: flex-start; padding-left: 0; margin-top: 8px; }
  }
  @container (max-width: 320px) {
    .hero:not(.few) > .chips { padding-left: 0; }
    .ev { flex-basis: 100%; }
    /* The status words go (the bubble and the dot carry the state); the
       value stays in their place. */
    .row .status > :not(.dot):not(.sval) { display: none; }
    .row .chip:not(.health) { display: none; }
    .value { font-size: 22px; }
  }

  .warning { padding: 16px; color: var(--error-color, #e53935); font-weight: 600; }
`;

export class NecromancerGuardCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._sig = null;
    this._visible = true;
    this._stale = false;
    this._running = new Set();
    this._expanded = false;
    this._chipsAll = false;
    this._tlAll = false;
    this._html = null;
    this._ticks = {};
    this._ages = [];
    this._tick = null;
    this._io = null;
    this._ctx = null;
    this._tlUnsub = null;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><ha-card></ha-card><div class="pop" hidden role="menu"></div><dialog class="rec"></dialog>`;
    this._card = root.querySelector("ha-card");
    this._pop = new Pop(this, root.querySelector(".pop"));
    // The recovery popup behind the actor chip; `_recWs` is the live answer of
    // necromancer/guard/recovery (PoE only: null while loading, {error}).
    this._recWs = null;
    this._recSeq = 0;
    this._recState = undefined;
    this._detachTimer = null;
    this._rec = new RecoveryDialog(this, root.querySelector("dialog.rec"), () => this._recModel());
    this._rec.onClose = () => {
      if (this._confirm.id && this._confirm.id.startsWith("rec-")) this._confirm.clear();
      this._recWs = null;
      this._recSeq++;
      this._recExpanded(false);
    };
    this._confirm = new Confirm(() => this._render());
    root.addEventListener("click", (ev) => this._click(ev));
    root.addEventListener("keydown", (ev) => {
      // The compact row itself is a button-like target when expandable.
      if ((ev.key === "Enter" || ev.key === " ") && ev.target && ev.target.dataset && ev.target.dataset.action === "row") {
        ev.preventDefault();
        this._toggleExpand();
      }
    });
  }

  // ------------------------------------------------------------ card API

  setConfig(config) {
    if (!config || typeof config.entity !== "string" || !config.entity.includes(".")) {
      throw new Error(t("en", "error.entity"));
    }
    const layout = config.layout || "full";
    if (!["full", "compact"].includes(layout)) throw new Error("layout must be full or compact");
    // true/false; the older "auto", "none" and lists still read as on/off.
    const raw = config.show_actions ?? true;
    if (!(typeof raw === "boolean" || raw === "auto" || raw === "none" || Array.isArray(raw))) {
      throw new Error("show_actions must be true or false");
    }
    const show = core.actionsShown(raw);
    if (config.chips != null && !Array.isArray(config.chips)) throw new Error("chips must be a list of entity ids");
    if (config.timeline != null && typeof config.timeline !== "boolean") throw new Error("timeline must be true or false");
    checkSharedOptions(config);
    const prev = this._config;
    // `row_detail` written out (an old `show_timeline: true` becomes "timeline").
    this._config = withRowDetail({ show_counters: false, show_footer: true, ...config, layout, show_actions: show });
    if (!prev || prev.entity !== config.entity) {
      this._expanded = false;
      this._tlAll = false;
    }
    this._sig = null;
    this._syncTimeline();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // Live points for every tracked guard (the first element per hass does it);
    // a row that was opened once keeps its cached history up to date.
    if (this._showsTimeline || timeline.entry(this._config.entity)) timeline.sync(hass);
    if (sameSig(this._sig, this._signature())) return;
    if (!this._visible) {
      this._stale = true;
      return;
    }
    this._render();
  }

  get hass() {
    return this._hass;
  }

  get _layout() {
    return this._config && this._config.layout === "compact" && !this._expanded ? "compact" : "full";
  }

  /**
   * Whether the 24 h timeline is shown (and history asked for): a collapsed
   * row or compact card with row_detail "timeline" (thin strip), an opened
   * row always (section), a full card only with `timeline: true` (section).
   */
  get _showsTimeline() {
    if (!this._config) return false;
    if (this._layout === "compact") return this._config.row_detail === "timeline";
    return this._config.layout === "compact" || this._config.timeline === true;
  }

  // Sizes in 50 px units: hero ~100 px + tray ~52 px (a full card without the
  // timeline is ~155 px wide, up to ~215 px at 390 px) + the timeline section
  // ~95 px (strip, axis, one or two lines of transitions; ~250 px in all).
  getCardSize() {
    if (!this._config || this._layout === "compact") return 1;
    const tray = this._config.show_footer || this._config.show_actions ? 1 : 0;
    return (this._showsTimeline ? 4 : 2) + tray;
  }

  getGridOptions() {
    if (this._config && this._config.layout === "compact") {
      // No fixed row count here either: a compact row is one grid row (56 px)
      // only without its detail line; with the last event or the strip under
      // the name it is taller, and a fixed `rows: 1` let it overlap the next
      // card in a sections view.
      return { columns: 12, min_columns: 6, min_rows: 1 };
    }
    // No fixed row count: content height varies (chips, a wrapped tray, the
    // transitions); the minimum keeps hero + tray (3 rows = 184 px) and with
    // the timeline hero + timeline + tray (4 rows = 248 px) uncut.
    return { columns: 12, min_columns: 6, min_rows: this._showsTimeline ? 4 : 3 };
  }

  static getStubConfig(hass) {
    // The layout written out: HA's dropdown shows an unset select empty.
    return { entity: core.findFirstGuard(hass) || "sensor.my_guard_status", layout: "full" };
  }

  /**
   * The editor: HA's own form from this schema (the supported way, HA draws
   * it). HA calls it once without arguments; `langArg` is for the tests. The
   * detail option follows the layout through the form's `visible` conditions:
   * "Show 24 h timeline" for the full card (also with no layout set), "Row
   * shows" for the compact one. An unset select shows empty in HA's form, so
   * each one names its default in the helper text.
   */
  static getConfigForm(langArg) {
    const lang = langArg || docLang();
    const de = lang === "de";
    const L = (en, deText) => (de ? deText : en);
    const labels = {
      entity: L("Guard", "Guard"),
      name: L("Name", "Name"),
      icon: L("Icon", "Symbol"),
      layout: L("Layout", "Layout"),
      timeline: L("Show 24 h timeline", "Zeitverlauf anzeigen"),
      show_counters: L("Show counters", "Zähler zeigen"),
      show_footer: L("Show last event", "Letztes Ereignis zeigen"),
      show_actions: L("Show actions", "Aktionen anzeigen"),
    };
    const helpers = {
      entity: L("The guard's status sensor.", "Der Status-Sensor des Guards."),
      name: L("Default: the guard's name.", "Standard: der Name des Guards."),
      icon: L("Default: by guard type.", "Standard: nach Guard-Typ."),
      layout: L("Full (default): one card. Compact: one row.", "Voll (Standard): eine Karte. Kompakt: eine Zeile."),
      timeline: L("Last 24 h: state strip, time axis and the latest changes. Default: off.", "Letzte 24 h: Zustandsstreifen, Zeitachse und die letzten Wechsel. Standard: aus."),
      row_detail: L("Under the name: the last event (default) or a thin 24 h strip.", "Unter dem Namen: das letzte Ereignis (Standard) oder ein schmaler 24-h-Streifen."),
      show_counters: L("Successful and failed repairs, under the card.", "Erfolgreiche und fehlgeschlagene Reparaturen, unten auf der Karte."),
      show_actions: L(
        "The state's main button and Snooze, the rest in the ⋮ menu. Off: nothing on the card can be triggered (e.g. a wall tablet).",
        "Der Hauptknopf des Zustands und Snooze, der Rest im ⋮-Menü. Aus: Auf der Karte lässt sich nichts auslösen (z. B. Wandtablet).",
      ),
    };
    const compact = { field: "layout", value: "compact" };
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { filter: { domain: "sensor", integration: core.DOMAIN, device_class: "enum" } } } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "name", selector: { text: {} } },
            { name: "icon", selector: { icon: {} } },
          ],
        },
        {
          name: "layout",
          selector: defaultSelect([
            { value: "full", label: L("Full", "Voll") },
            { value: "compact", label: L("Compact", "Kompakt") },
          ]),
        },
        // `default` is what HA's switch shows for an unset option.
        { name: "timeline", default: false, selector: { boolean: {} }, visible: { ...compact, operator: "not_eq" } },
        { ...rowDetailField(lang), visible: compact },
        { name: "show_counters", default: false, selector: { boolean: {} } },
        { name: "show_footer", default: true, selector: { boolean: {} } },
        { name: "show_actions", default: true, selector: { boolean: {} } },
      ],
      computeLabel: (item) => labels[item.name] ?? sharedFormLabel(item.name, lang),
      computeHelper: (item) => helpers[item.name],
    };
  }

  /** Subscribe to history loads only while the timeline is shown (else nothing). */
  _syncTimeline() {
    const on = this.isConnected && this._showsTimeline;
    if (on && !this._tlUnsub) {
      this._tlUnsub = timeline.subscribe((ids) => {
        if (!this._config || !ids.has(this._config.entity)) return;
        this._sig = null;
        if (this._visible) {
          this._render();
          return;
        }
        // Off screen: no full render, but the strip drops its shimmer and
        // shows the loaded history right away (cheap: one style write).
        this._stale = true;
        tl.paintStrips(this._card, timeline, Date.now(), langFrom(this._hass));
      });
    } else if (!on && this._tlUnsub) {
      this._tlUnsub();
      this._tlUnsub = null;
    }
  }

  connectedCallback() {
    if (!this._io && typeof IntersectionObserver !== "undefined") {
      this._io = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible === this._visible) return;
        this._visible = visible;
        this._card.classList.toggle("off", !visible);
        if (visible && this._stale) this._render();
        this._schedule();
      });
      this._io.observe(this);
    }
    this._syncTimeline();
    this._schedule();
    // Moved within the page (a list re-sorted while the popup was open): the
    // removal took it out of the top layer, so open it modal again.
    if (this._detachTimer) {
      clearTimeout(this._detachTimer);
      this._detachTimer = null;
      this._rec.reattach();
    }
  }

  disconnectedCallback() {
    if (this._io) this._io.disconnect();
    this._io = null;
    if (this._tlUnsub) this._tlUnsub();
    this._tlUnsub = null;
    clearTimeout(this._tick);
    this._tick = null;
    this._confirm.clear();
    this._pop.close();
    // A move comes straight back (connectedCallback); a real removal closes it.
    if (this._rec.isOpen) {
      clearTimeout(this._detachTimer);
      this._detachTimer = setTimeout(() => {
        this._detachTimer = null;
        this._rec.close();
      }, 0);
    }
  }

  // ------------------------------------------------------------ rendering

  /** Everything a render depends on; identity of HA's state objects is enough. */
  _signature() {
    const h = this._hass;
    if (!h || !h.states) return null;
    const info = core.guardInfo(h.states[this._config.entity]);
    const ids = core.relevantEntities({ ...info, statusEntity: this._config.entity }, this._config);
    const loc = h.locale || {};
    return [
      loc.language,
      loc.time_format,
      loc.time_zone,
      h.config && h.config.time_zone,
      h.language,
      loc.number_format,
      h.user && h.user.is_admin,
      this._showsTimeline ? timeline.version(this._config.entity) : 0,
      ...ids.map((id) => h.states[id]),
      // The watched entity feeds the main value ("200 W").
      info.sourceEntity && !this._config.value_entity ? h.states[info.sourceEntity] : null,
      // The actor chip's tooltip names the target.
      info.targetEntity ? h.states[info.targetEntity] : null,
      // An open recovery popup also shows the PoE port's live state.
      ...this._recEntities().map((id) => h.states[id]),
    ];
  }

  _render() {
    if (!this._config || !this._hass || !this._hass.states) return;
    this._stale = false;
    this._sig = this._signature();
    const hass = this._hass;
    const cfg = this._config;
    const lang = langFrom(hass);
    const status = hass.states[cfg.entity];
    this._card.classList.toggle("embedded", Boolean(cfg.embedded));
    this._card.classList.toggle("full", this._layout === "full");
    if (!status) {
      const html = `<div class="warning">${esc(t(lang, "error.not_found", { entity: cfg.entity }))}</div>`;
      if (html !== this._html) this._card.innerHTML = html;
      this._html = html;
      this._ticks = {};
      this._ages = [];
      this._ctx = null;
      this._pop.close();
      return;
    }
    const info = core.guardInfo(status);
    const state = status.state;
    const attrs = status.attributes || {};
    const now = Date.now();
    const autoSo = info.autoEntity ? hass.states[info.autoEntity] : null;
    const autoOn = autoSo ? autoSo.state !== "off" : true;
    const compact = this._layout === "compact";
    // The main pill and the snooze pill (design §16); a narrow row shows only
    // the main one and its menu takes snooze.
    const acts = core.actionsFor(info, state, attrs, {
      isAdmin: Boolean(hass.user && hass.user.is_admin),
      show: cfg.show_actions,
    });
    let ev = cfg.show_footer ? core.footerEvent(info, hass.states, attrs, now, lang, { past: true }) : null;
    // Timeline off (a collapsed row with row_detail "text", a full card
    // without `timeline: true`): no store call at all (no query, no markup).
    // An opened row always asks (one id, cached).
    const tlOn = this._showsTimeline;
    if (tlOn) timeline.want(hass, cfg.entity);
    const tlEntry = tlOn ? timeline.entry(cfg.entity) : null;
    // When the guard really entered its state (not HA's restart-reset
    // last_changed): value, context and "hot" all count from it. A cached
    // history (row opened once) also helps a collapsed row.
    const since = stateSince(status, tlEntry || timeline.entry(cfg.entity));
    const mv = core.mainValue(info, hass, cfg, now, lang, { rich: true, since });
    this._ctx = { info, state, attrs, lang, autoOn, acts };
    this._ages = [mv.age, ev && ev.age];
    const ticks = {};
    const slot = (key, text) => {
      ticks[key] = String(text);
      return `${SLOT}${key}${SLOT}`;
    };

    this._card.style.setProperty("--nc", core.stateColor(state));
    this._card.style.setProperty("--nt", core.stateTextColor(state));
    this._card.classList.toggle("busy", core.isBusy(state));
    this._card.classList.toggle("muted", core.isMutedState(state) && state !== "snoozed");
    // Embedded in a list or grid, only a fresh escalation (< 1 h) keeps the
    // strong red bubble, so the newest one stands out among old ones.
    const age = core.ageSeconds(since, now);
    const hot = state === "escalated" && (!cfg.embedded || age == null || age < HOT_SECONDS);
    this._card.classList.toggle("hot", hot);
    const name = esc(cfg.name || info.name);
    const icon = esc(cfg.icon || core.defaultIcon(info));
    const timeFormat = (hass.locale || {}).time_format;
    const timeZone = timeZoneOf(hass);
    const statusLine = statusText(info, state, attrs, lang, { now, timeFormat, timeZone });
    let line = esc(statusLine);
    let lineHtml = `<span>${line}</span>`;
    if (compact && state === "snoozed") {
      // Narrow row: the short end ("until Mon 03:58") as its own unbreakable
      // part, which moves to a second line instead of being cut off.
      const until = core.formatUntil(attrs.snooze_until, now, lang, timeZone, timeFormat);
      if (until) {
        line = esc(`${t(lang, "status.snoozed_open")} ${until}`);
        lineHtml = `<span>${esc(t(lang, "status.snoozed_open"))}</span><span class="until">${esc(until)}</span>`;
      }
    }
    const valueCls = mv.late ? "late" : "";
    const bubble = `<button class="bubble" data-action="details" title="${esc(t(lang, "action.details"))}" aria-label="${esc(t(lang, "action.details"))}"><ha-icon icon="${icon}"></ha-icon></button>`;
    // The quiet context (what the value means, since when, repairs): the
    // detail text when there is no event. The full card's value caption
    // already names a heartbeat's period.
    const hb = info.lastHeartbeatEntity ? hass.states[info.lastHeartbeatEntity] : null;
    // Glued like the event text below: a clock time keeps its AM/PM ("3:22 PM"
    // never breaks into "3:22" / "PM" in a narrow tray), a count its noun.
    const ctx = glueEventText(contextLine(info, status, lang, {
      now,
      timeZone,
      timeFormat,
      autoOn,
      // The full card's value already says when the last ping came.
      lastHeartbeat: compact ? hb && hb.state : null,
      period: hb && hb.attributes && hb.attributes.period,
      hasEvent: Boolean(ev) || !compact,
      since,
    }));

    // One card, one wording: the full heartbeat card's caption already says
    // "expected every 1 h", so the reason drops its "expected every 60
    // minutes"; elsewhere (rows) the period reads in the same duration format
    // ("expected every 1 h") as the context lines around it. The detail text
    // drops a first word that repeats the status badge or line right above it
    // ("Escalated" + "Escalated · 2 attempts" -> "2 attempts"), in every
    // layout. A number stays with its noun when the text wraps, and an old
    // failure on a guard that is fine again is a muted note, not a red alarm.
    if (ev) {
      let text = ev.text;
      if (!compact && mv.kind === "heartbeat" && /·/.test(mv.caption || "")) text = withoutPeriodClause(text);
      else text = withPeriodFormatted(text, hb && hb.attributes && hb.attributes.period);
      text = glueEventText(dropLeadingState(text, statusLine));
      ev = quietOldEvent({ ...ev, text }, state);
    }

    let html;
    if (compact) {
      const more = acts.menu.length || acts.second
        ? `<button class="pill round neutral" data-action="menu" data-anchor="more" aria-haspopup="menu" aria-label="${esc(t(lang, "action.more"))}" title="${esc(t(lang, "action.more"))}"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>`
        : "";
      // The wide row (CSS) shows the main and the snooze pill with labels; a
      // narrow row only the main one, as a round icon button (snooze then
      // goes into the menu, see _menuHtml).
      const pinned = Boolean(acts.main);
      const primary = `${acts.main ? this._pill(acts.main, lang, autoOn, true) : ""}${acts.second ? this._pill(acts.second, lang, autoOn, false) : ""}`;
      // "tx": the text detail, which a narrow row shows on its second line.
      const textLine = !tlOn && Boolean(ev || ctx);
      const rowCls = `row${cfg.expandable ? " tap" : ""}${tlOn ? " tl" : ""}${textLine ? " tx" : ""}${pinned ? " pin" : ""}`;
      const tap = cfg.expandable
        ? ` class="${rowCls}" data-action="row" tabindex="0" role="button" aria-expanded="false" aria-label="${name} – ${esc(t(lang, "ui.expand"))}"`
        : ` class="${rowCls}"`;
      // The row's detail slot (row_detail): the last event, else the quiet
      // context, so a row without an event does not leave a gap; or the strip,
      // which then carries the event in its tooltip/description and, on a very
      // wide row, as a muted line under it.
      const note = ev ? ev.text : ctx;
      const noteKey = ev ? "event" : "ctx";
      html = `
        <div${tap}>
          ${bubble}
          <div class="rtext">
            <div class="name" title="${name}"${cfg.expandable ? "" : ` data-action="details"`}>${name}</div>
            <div class="status" title="${line}"><span class="dot"></span>${lineHtml}<span class="sval ${valueCls}" title="${esc(mv.title)}" data-tick="value">${slot("value", mv.value)}</span></div>
          </div>
          ${tlOn ? `<div class="rstrip">${tl.stripHtml(cfg.entity, tlEntry, lang, { thin: true, desc: note ? slot(noteKey, note) : "", descKey: noteKey })}${note ? `<div class="rnote" data-tick="${noteKey}">${slot(noteKey, note)}</div>` : ""}</div>` : ""}
          <div class="rval"><div class="cvalue ${valueCls}" title="${esc(mv.title)}" data-tick="value">${slot("value", mv.value)}</div></div>
          ${textLine ? this._rowEvent(ev, ctx, slot) : ""}
          ${primary ? `<div class="ract">${primary}</div>` : ""}
          <div class="rhealth">${this._rowChips(info, state, lang)}</div>
          ${more ? `<div class="rmore">${more}</div>` : ""}
        </div>`;
    } else {
      const fold =
        cfg.expandable && cfg.layout === "compact"
          ? `<button class="fold" data-action="row" aria-expanded="true" title="${esc(t(lang, "ui.collapse"))}" aria-label="${esc(t(lang, "ui.collapse"))}"><ha-icon icon="mdi:chevron-up"></ha-icon></button>`
          : "";
      // The value opens what it shows (the watched entity, the value entity,
      // the last-heartbeat sensor); the caption sits beside it.
      const valueInner = slot("value", mv.value);
      const value = mv.entity
        ? `<button class="value ${valueCls}" title="${esc(mv.title)}" data-action="more-info" data-entity="${esc(mv.entity)}" data-tick="value">${valueInner}</button>`
        : `<div class="value ${valueCls}" title="${esc(mv.title)}" data-tick="value">${valueInner}</div>`;
      const caption = mv.caption ? `<span class="caption" data-tick="caption" title="${slot("caption", mv.caption)}">${slot("caption", mv.caption)}</span>` : "";
      const chips = this._chips(info, state, attrs, lang);
      // More than three chips wrap into a block on a narrow card ("many": a
      // hook for themes and tests; the value line spans under them either way);
      // one or two ("few") stay top right on a narrow card too.
      html = `
        <div class="hero${this._chipCount > 3 ? " many" : this._chipCount <= 2 ? " few" : ""}">
          ${bubble}
          <div class="text">
            <div class="name" data-action="details">${name}</div>
            <div class="badge" title="${line}"><span class="dot"></span><span>${line}</span></div>
            <div class="vline">${value}${caption}</div>
          </div>
          ${chips}
          ${fold}
        </div>
        ${tlOn ? `<div class="tlsec${this._tlAll ? " all" : ""}">${tl.sectionHtml(cfg.entity, tlEntry, now, lang, { timeZone, timeFormat, n: 4, few: 2, all: this._tlAll })}</div>` : ""}
        ${this._footer(ev, cfg.show_footer ? ctx : "", acts, lang, autoOn, slot, cfg.show_counters ? countsText(attrs, lang) : "")}`;
    }
    if (html !== this._html) {
      this._html = html;
      const focus = this._focusKey();
      this._card.innerHTML = html.replace(SLOT_RE, (_m, key) => esc(ticks[key]));
      this._restoreFocus(focus);
    } else {
      for (const [key, text] of Object.entries(ticks)) {
        if (this._ticks[key] === text) continue;
        for (const el of this._card.querySelectorAll(`[data-tick="${key}"]`)) {
          el.textContent = text;
          if (key === "event" || key === "caption") el.setAttribute("title", text);
        }
        for (const el of this._card.querySelectorAll(`[data-tick-desc="${key}"]`)) {
          el.setAttribute("aria-description", text);
          el.setAttribute("title", `${text}\n${t(this._ctx.lang, "tl.hint")}`);
        }
      }
    }
    this._ticks = ticks;
    // The strip's gradient lives outside the markup diff (its "now" end moves).
    if (tlOn) tl.paintStrips(this._card, timeline, now, lang);
    this._pop.refresh();
    if (this._rec.isOpen) this._recRefresh();
    this._schedule();
  }

  /** The wide row's event column: event (or context) plus the muted context. */
  _rowEvent(ev, ctx, slot) {
    const tone = ev ? TONE_COLORS[ev.tone] || TONE_COLORS.idle : "var(--ui-text2)";
    const icon = ev ? ev.icon : "mdi:information-outline";
    const main = ev
      ? `<span class="rev" data-tick="event" title="${slot("event", ev.text)}">${slot("event", ev.text)}</span>`
      : `<span class="rev quiet" title="${esc(ctx)}">${esc(ctx)}</span>`;
    const more = ev && ctx ? `<span class="rctx" title="${esc(ctx)}">${esc(ctx)}</span>` : "";
    return `<div class="revent${ev ? "" : " noev"}"><span class="evicon" style="--tone:${tone}"><ha-icon icon="${esc(icon)}"></ha-icon></span>${main}${more}</div>`;
  }

  _focusKey() {
    const active = this.shadowRoot.activeElement;
    if (!active || !active.dataset || !active.dataset.action || !this._card.contains(active)) return null;
    const d = active.dataset;
    let sel = `[data-action="${d.action}"]`;
    if (d.entity) sel += `[data-entity="${d.entity}"]`;
    return sel;
  }

  _restoreFocus(sel) {
    if (!sel) return;
    try {
      const el = this._card.querySelector(sel);
      if (el && el.focus) el.focus();
    } catch (_err) {
      // odd entity id in the selector: losing focus beats a broken render
    }
  }

  _chip({ tone, color, icon, title, action, entity = "", cls = "", extra = "", attrs = "" }) {
    const c = color || TONE_COLORS[tone] || TONE_COLORS.idle;
    return `<button class="chip ${cls}" style="--chip:${c}" data-action="${action}" data-entity="${esc(entity)}" title="${esc(title)}" aria-label="${esc(title)}"${attrs}><ha-icon icon="${esc(icon)}"></ha-icon>${extra}</button>`;
  }

  _healthChip(info, lang) {
    const so = info.healthEntity ? this._hass.states[info.healthEntity] : null;
    const tone = core.healthTone(so);
    const icon = { good: "mdi:heart-pulse", bad: "mdi:heart-broken" }[tone] || "mdi:heart-outline";
    const health = t(lang, `health.${{ good: "ok", bad: "unhealthy" }[tone] || "unknown"}`);
    return this._chip({
      tone,
      icon,
      cls: "health",
      title: `${t(lang, "chip.health")}: ${health}`,
      action: info.healthEntity ? "more-info" : "details",
      entity: info.healthEntity || "",
    });
  }

  _chips(info, state, attrs, lang) {
    const cfg = this._config;
    const states = this._hass.states;
    const out = [this._healthChip(info, lang)];
    // The actor chip opens the recovery popup (every driver type); the
    // auto-off chip says its state in words here ("Auto off").
    out.push(this._actorChip(info, state, lang));
    const autoOff = this._autoOffChip(info, lang, true);
    if (autoOff) out.push(autoOff);
    // Snoozed needs no chip: the status says it ("Snoozed until …") and Wake up
    // is the main pill.
    // The user's own chips after a thin rule: they are not Necromancer's. One
    // on the entity the actor chip already stands for would only repeat it.
    let own = 0;
    for (const spec of core.chipSpecs(cfg)) {
      if (spec.entity === info.targetEntity) continue;
      const so = states[spec.entity];
      const title = spec.name || (so && so.attributes && so.attributes.friendly_name) || spec.entity;
      out.push(
        this._chip({
          tone: core.entityTone(so),
          color: core.chipColor(spec.color) || undefined,
          icon: spec.icon || core.entityIcon(so, spec.entity),
          title,
          action: "more-info",
          entity: spec.entity,
          cls: `own${own++ === 0 ? " first" : ""}`,
        }),
      );
    }
    // More than five: a "+N" bubble at the end (shown only on narrow cards,
    // where the CSS hides the sixth chip onwards).
    if (out.length > 5) {
      const n = out.length - 5;
      out.push(
        `<button class="chip more" data-action="chips-all" title="${esc(t(lang, "ui.expand"))}" aria-label="${esc(`+${n} – ${t(lang, "ui.expand")}`)}">+${n}</button>`,
      );
    }
    this._chipCount = out.length;
    return `<div class="chips${this._chipsAll ? " all" : ""}${autoOff ? " haswide" : ""}">${out.join("")}</div>`;
  }

  /**
   * The actor chip: what this guard repairs ("Recovery: Pool plug" as its
   * tooltip), in the neutral text tone (grey read as "disabled"), blue while a
   * repair runs. A notify-only guard's bell is neutral too: it is a working
   * button (the popup says "Notify only — no repair"), not a disabled one.
   * Opens the recovery popup.
   */
  _actorChip(info, state, lang) {
    const target = core.recoveryTarget(info, this._hass, lang);
    // The target's own icon when it has one (a port, a pump), else the type's.
    const tso = info.targetEntity ? this._hass.states[info.targetEntity] : null;
    const own = tso && tso.attributes && tso.attributes.icon;
    return this._chip({
      tone: info.canRecover && core.isBusy(state) ? "active" : "neutral",
      icon: info.canRecover ? own || core.actorIcon(info.driverType) : target.icon,
      title: core.actorTitle(info, this._hass, lang),
      action: "recovery",
      cls: "actor",
      attrs: ` data-anchor="rec" aria-haspopup="dialog" aria-expanded="${this._rec.isOpen}"`,
    });
  }

  _autoIsOff(info) {
    const auto = info.canRecover && info.autoEntity ? this._hass.states[info.autoEntity] : null;
    return Boolean(auto) && auto.state === "off";
  }

  /**
   * Auto-recovery off: an orange chip (a warning, not the grey of "disabled");
   * `wide` (full card) with the words "Auto off", else the icon alone with
   * its tooltip. A double tap turns it on again.
   */
  _autoOffChip(info, lang, wide) {
    if (!this._autoIsOff(info)) return "";
    const armed = this._confirm.is("auto-chip");
    const word = armed ? t(lang, "action.sure") : t(lang, "chip.auto_off_short");
    // "Show actions" off: information only (the popup says the rest).
    const live = this._config.show_actions;
    return this._chip({
      tone: "warn",
      icon: "mdi:robot-off",
      title: live ? t(lang, armed ? "chip.auto_confirm" : "chip.auto_off") : t(lang, "chip.auto_off_short"),
      action: live ? "auto-chip" : "recovery",
      cls: `autooff${wide ? " wide" : ""}${armed ? " confirm" : ""}`,
      extra: wide ? `<span aria-hidden="true">${esc(word)}</span>` : "",
    });
  }

  /** A compact row's chips, in the full card's order: health, actor, auto off (icon). */
  _rowChips(info, state, lang) {
    return `${this._healthChip(info, lang)}${this._actorChip(info, state, lang)}${this._autoOffChip(info, lang, false)}`;
  }

  // ------------------------------------------------------------ recovery popup

  /** Entities an open popup shows besides the guard's own (the PoE port's). */
  _recEntities() {
    const w = this._rec && this._rec.isOpen ? this._recWs : null;
    const p = w && !w.error ? w.port : null;
    return p ? [p.actuator, p.status_entity, p.id_entity].filter(Boolean) : [];
  }

  /** What the popup draws now (core.recoveryModel plus the UI state). */
  _recModel() {
    const { info, lang } = this._ctx;
    const model = core.recoveryModel(info, this._recWs, this._hass, lang, { now: Date.now() });
    return {
      model,
      lang,
      ui: {
        name: this._config.name || info.name,
        autoArmed: this._confirm.is("rec-auto"),
        repairArmed: this._confirm.is("rec-repair"),
        running: this._running.has("revive"),
        readOnly: !this._config.show_actions,
      },
    };
  }

  _recRefresh() {
    const so = this._hass.states[this._config.entity];
    // Ask the fabric again when the guard's state moved (a repair started or
    // ended): match, port and last restart may have changed.
    if (so && this._recState !== undefined && so.state !== this._recState) this._recLoad();
    this._recState = so ? so.state : null;
    this._rec.el.style.setProperty("--nc", core.isMutedState(this._ctx.state) ? "var(--ui-accent)" : core.stateColor(this._ctx.state));
    this._rec.refresh();
  }

  /** The live PoE resolution (read-only WS); only a PoE guard needs it. */
  async _recLoad() {
    const { info } = this._ctx;
    if (!(info.canRecover && info.driverType === "poe_port")) return;
    const seq = ++this._recSeq;
    let res;
    try {
      res = await loadGuardRecovery(this._hass, this._config.entity);
    } catch (err) {
      res = { error: (err && (err.code || err.message)) || "error" };
    }
    if (seq !== this._recSeq || !this._rec.isOpen) return;
    this._recWs = res || { error: "empty" };
    this._sig = null;
    this._render();
  }

  _openRecovery() {
    if (!this._ctx) return;
    this._pop.close();
    this._recWs = null;
    this._recState = this._ctx.state;
    this._rec.el.style.setProperty("--nc", core.isMutedState(this._ctx.state) ? "var(--ui-accent)" : core.stateColor(this._ctx.state));
    this._rec.open('[data-anchor="rec"]');
    this._recExpanded(true);
    this._recLoad();
  }

  _recExpanded(open) {
    const chip = this._card.querySelector('[data-anchor="rec"]');
    if (chip) chip.setAttribute("aria-expanded", String(open));
  }

  _footer(ev, ctx, acts, lang, autoOn, slot, counts = "") {
    const showActs = acts.actions.length > 0;
    if (!ev && !ctx && !showActs && !counts) return "";
    // Counters (`show_counters`) as words under the event ("4 repaired · 1
    // failed"): a "4" in a chip said nothing.
    const cnt = counts ? `<div class="counts">${esc(counts)}</div>` : "";
    // The detail text: the last event, else the quiet context ("No repairs so
    // far"); with neither, the pills stand alone (§4 footer, no bell, no dash).
    let event = "";
    if (ev) {
      event = `<div class="ev${ev.past ? " past" : ""}"><div class="evicon" style="--tone:${TONE_COLORS[ev.tone] || TONE_COLORS.idle}"><ha-icon icon="${esc(ev.icon)}"></ha-icon></div>
         <div class="evtxt"><div class="event" data-tick="event" title="${slot("event", ev.text)}">${slot("event", ev.text)}</div>${cnt}</div></div>`;
    } else if (ctx || cnt) {
      event = `<div class="ev quiet"><div class="evicon"><ha-icon icon="mdi:information-outline"></ha-icon></div>
         <div class="evtxt">${ctx ? `<div class="event" title="${esc(ctx)}">${esc(ctx)}</div>` : ""}${cnt}</div></div>`;
    }
    const pills = `${acts.main ? this._pill(acts.main, lang, autoOn, true) : ""}${acts.second ? this._pill(acts.second, lang, autoOn, false) : ""}`;
    const more = acts.menu.length
      ? `<button class="pill round neutral" data-action="menu" data-anchor="more" aria-haspopup="menu" aria-label="${esc(t(lang, "action.more"))}" title="${esc(t(lang, "action.more"))}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>`
      : "";
    const acts_ = showActs ? `<div class="actions">${pills}${more}</div>` : "";
    return `<div class="tray ${event ? "" : "noev"}">${event}${acts_}</div>`;
  }

  _pill(id, lang, autoOn, first) {
    const armed = this._confirm.is(id);
    const label = armed ? t(lang, "action.sure") : core.actionLabel(id, lang, autoOn);
    const tip = armed ? t(lang, "action.sure") : core.actionLabel(id, lang, autoOn);
    // The first pill is the state's main move: a strong fill in the state colour.
    const cls = `pill accent ${first ? "strong" : "second"} ${armed ? "confirm" : ""}`;
    const extra = id === "snooze" ? ` data-anchor="pill-snooze" aria-haspopup="menu"` : "";
    const busy = this._running.has(id) ? ` aria-disabled="true"` : "";
    return `<button class="${cls}" data-action="${id}"${extra}${busy} title="${esc(tip)}" aria-label="${esc(tip)}"><ha-icon icon="${core.actionIcon(id, autoOn)}"></ha-icon><span class="label">${esc(label)}</span></button>`;
  }

  // ------------------------------------------------------------ popover

  _menuHtml() {
    const { lang, autoOn, acts, state } = this._ctx;
    // Snooze is a pill; only where its pill is hidden (a narrow row) the menu
    // takes it, in its canonical place.
    // A full card always shows its pills (they wrap); a compact row hides the
    // snooze pill below the wide layout (CSS), then the menu has it.
    const pill = acts.second && this._layout === "compact" ? this._card.querySelector(`.pill.second[data-action="${acts.second}"]`) : null;
    const hidden = Boolean(acts.second) && this._layout === "compact" && (!pill || pill.offsetParent == null || (typeof getComputedStyle === "function" && getComputedStyle(pill).display === "none"));
    const ids = hidden ? core.ACTION_ORDER.filter((id) => id === acts.second || acts.menu.includes(id)) : acts.menu;
    const ordered = [...ids.filter((id) => !core.MENU_TAIL.has(id)), ...ids.filter((id) => core.MENU_TAIL.has(id))];
    let sep = false;
    return ordered
      .map((id, i) => {
        const armed = this._confirm.is(id);
        // Revive on a snoozed guard also ends the snooze: say so.
        const base = id === "revive" && state === "snoozed" ? t(lang, "action.revive_wake") : core.actionLabel(id, lang, autoOn);
        const label = armed ? t(lang, "action.sure") : base;
        const line = !sep && i > 0 && core.MENU_TAIL.has(id) ? '<div class="sep" role="separator"></div>' : "";
        if (core.MENU_TAIL.has(id)) sep = true;
        return `${line}<button role="menuitem" data-key="${id}" class="${armed ? "confirm" : ""}" data-action="${id}" data-from="menu"><ha-icon icon="${core.actionIcon(id, autoOn)}"></ha-icon>${esc(label)}</button>`;
      })
      .join("");
  }

  _openMenu(kind, anchor) {
    const render = kind === "snooze" ? () => snoozeItems(this._ctx.lang, "snooze-for", t(this._ctx.lang, "action.snooze")) : () => this._menuHtml();
    this._pop.el.style.setProperty("--nc", core.stateColor(this._ctx.state));
    this._pop.open(kind, anchor, render);
  }

  // ------------------------------------------------------------ actions

  _toggleExpand() {
    if (!this._config || !this._config.expandable || this._config.layout !== "compact") return;
    this._expanded = !this._expanded;
    this._pop.close();
    this._html = null;
    // Opened: this guard's history (one query, cached); closed with
    // row_detail "text": no more subscription.
    this._syncTimeline();
    this._render();
    // Keep the keyboard on the toggle that replaced the one just used.
    const again = this._card.querySelector('[data-action="row"]');
    if (again && again.focus) again.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent("necromancer-expanded", { detail: { entity: this._config.entity, expanded: this._expanded }, bubbles: true, composed: true }));
  }

  _click(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el || !this._ctx) return;
    if (el.getAttribute("aria-disabled") === "true") return;
    ev.stopPropagation();
    const id = el.dataset.action;
    const { info } = this._ctx;
    // "Show actions" off: nothing on this card changes anything (stale markup
    // or a keyboard user cannot get around it either).
    if (!this._config.show_actions && ["rec-auto", "rec-repair", "auto-chip", "unsnooze", "snooze", "snooze-for", "menu"].includes(id)) return;
    switch (id) {
      case "row":
        this._toggleExpand();
        return;
      case "chips-all":
        this._chipsAll = true;
        this._render();
        return;
      case "tl-more":
        this._tlAll = true;
        this._render();
        return;
      case "details":
        this._pop.close();
        runAction(this, this._hass, info, "details");
        return;
      case "more-info":
        runAction(this, this._hass, info, "more-info", { entityId: el.dataset.entity });
        return;
      case "recovery":
        if (this._rec.isOpen) this._rec.close();
        else this._openRecovery();
        return;
      case "rec-close":
        this._rec.close();
        return;
      case "rec-link":
        // HA's own more-info on top: ours closes first (no stacked modals).
        this._rec.close();
        runAction(this, this._hass, info, "more-info", { entityId: el.dataset.entity });
        return;
      case "rec-auto": {
        // Off asks "Sure?" first (problems are then only reported); on is direct.
        const on = this._ctx.autoOn;
        if (on && !this._confirm.check("rec-auto")) return;
        this._confirm.clear();
        this._run("auto", { autoOn: on });
        return;
      }
      case "rec-repair":
        if (!this._confirm.check("rec-repair")) return;
        this._run("revive");
        return;
      case "menu":
        if (this._pop.state) this._pop.close();
        else this._openMenu("menu", el.dataset.anchor);
        return;
      case "snooze":
        if (this._pop.kind === "snooze" && this._pop.anchor === el.dataset.anchor) {
          this._pop.close();
          return;
        }
        // From the menu, the duration list replaces it at the same anchor.
        this._openMenu("snooze", el.dataset.from === "menu" ? this._pop.anchor : el.dataset.anchor);
        return;
      case "snooze-for":
        this._pop.close({ focusAnchor: true });
        this._run("snooze", { duration: Number(el.dataset.seconds) });
        return;
      case "auto-chip":
        if (!this._confirm.check("auto-chip")) {
          toast(this, t(this._ctx.lang, "chip.auto_confirm"));
          return;
        }
        this._run("auto", { autoOn: false });
        return;
      case "url":
      case "check":
      case "edit":
        this._pop.close();
        if (id === "edit") runAction(this, this._hass, info, "edit");
        else this._run(id);
        return;
      default:
        if (el.dataset.from !== "menu") this._pop.close();
        if (CONFIRM_ACTIONS.has(id) && !this._confirm.check(id)) return;
        this._pop.close({ focusAnchor: el.dataset.from === "menu" });
        this._run(id, { autoOn: this._ctx.autoOn });
    }
  }

  /** Run an action through the shared helper; its pill is busy meanwhile. */
  async _run(id, opts = {}) {
    const { info, lang, autoOn } = this._ctx;
    const name = this._config.name || info.name;
    this._running.add(id);
    this._render();
    try {
      const res = await runAction(this, this._hass, info, id, { lang, name, ...opts });
      if (res && DONE_TOAST.has(id)) {
        toast(this, core.t(lang, "toast.done", { name, action: core.actionLabel(id, lang, autoOn) }));
      }
      return res;
    } finally {
      this._running.delete(id);
      this._render();
    }
  }

  // ------------------------------------------------------------ ticking

  /** Relative times tick while visible, on the youngest age's next boundary. */
  _schedule() {
    clearTimeout(this._tick);
    this._tick = null;
    let delay = core.nextTickMs(this._ages);
    // A visible timeline repaints at least once a minute.
    if (this._showsTimeline) delay = delay == null ? tl.REPAINT_MS : Math.min(delay, tl.REPAINT_MS);
    if (!this.isConnected || !this._visible || !this._config || delay == null) return;
    this._tick = setTimeout(() => {
      this._tick = null;
      this._render();
    }, delay);
  }
}

if (!customElements.get(TAGS.guard)) customElements.define(TAGS.guard, NecromancerGuardCard);
