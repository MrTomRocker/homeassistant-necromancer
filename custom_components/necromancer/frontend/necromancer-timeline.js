// Necromancer frontend: the optional 24 h state timeline of the cards and the
// panel. Three parts:
//
//   1. TimelineStore: 24 h of status states per guard. ONE batched
//      `history/history_during_period` query for every guard that asks within a
//      short window (a list of 200 guards = one query), then live points from
//      the state objects HA hands to the cards anyway (no subscription per
//      guard). No recorder or no permission: live points only, never an error.
//   2. Pure helpers (no DOM, run under node --test): history parsing, cleaning,
//      24 h segments, a minimum visible width for short incidents, and the
//      gradient stops with SOFT transitions between adjacent states.
//   3. Markup + CSS: a rounded track painted with one CSS linear-gradient
//      (state colours from the HA theme variables), a thin variant for rows, the
//      "Last 24 h" section with a light time axis and the last transitions, and a
//      shimmer while the history loads (none under prefers-reduced-motion).
//
// The strip's gradient changes every minute (the "now" end moves) while its
// markup stays the same: the markup carries `data-tl="<entity id>"` and
// `paintStrips(root, store, now, lang)` sets the gradient and the aria label on
// those elements after each render, so a card's markup diff never sees it.
//
// A card that does not show the timeline must not call into the store at all:
// no `want`, no `subscribe`, no markup (then nothing is queried).
//
// Shared modules are imported with this module's own query (`?v=<version>`,
// see the header of necromancer-core.js), so one page holds one core instance.

const Q = new URL(import.meta.url).search;
const core = await import(`./necromancer-core.js${Q}`);

const esc = core.escapeHtml;

export const DAY_MS = 86400000;

/** "unavailable"/"unknown" blips shorter than this (HA restarts) are noise. */
export const SHORT_GAP_S = 15;

/** A segment never gets narrower than this share of the track (in %), so a
 *  five-minute escalation inside 24 h stays visible. */
export const MIN_SEG_PCT = 0.7;

/** Half-width (in % of the track) of the soft blend between two states. */
export const BLEND_PCT = 0.9;

/** On a strip of known width (px): segments are at least this wide, a run of
 *  neighbours each narrower than MERGE_PX becomes one segment (no "barcode"),
 *  and a state change blends over at least BLEND_PX on either side (a lone
 *  short incident becomes one soft peak, see gradientStops). */
export const MIN_SEG_PX = 4;
export const MERGE_PX = 12;
export const BLEND_PX = 5;

/** A sliver (really narrower than MIN_SEG_PX) with another sliver this close
 *  (px, edge to edge) is part of a cluster and is absorbed (see absorbSlivers). */
export const NEAR_PX = 36;

/** Ids per history query (the WebSocket message stays small). */
const CHUNK = 150;

/** Bound per guard: a flapping guard keeps at most this many points. */
const MAX_POINTS = 400;

// ---------------------------------------------------------------------------
// Texts (en/de); everything else comes from core.t
// ---------------------------------------------------------------------------

const TL_I18N = {
  en: {
    "tl.title": "Last 24 h",
    "tl.hint": "State over the last 24 hours, newest on the right",
    "tl.aria": "State over the last 24 hours: {summary}",
    "tl.aria_loading": "State over the last 24 hours: loading",
    "tl.no_changes": "No change in 24 h",
    "tl.live_only": "No history available: changes since this page was opened",
    "tl.now": "now",
    "tl.start": "−24 h",
    "tl.mid": "−12 h",
    "tl.setting": "Show 24 h timeline",
    "tl.option": "24 h timeline",
    "tl.more": "Show {n} more changes",
  },
  de: {
    "tl.title": "Letzte 24 h",
    "tl.hint": "Zustand der letzten 24 Stunden, rechts das Neueste",
    "tl.aria": "Zustand der letzten 24 Stunden: {summary}",
    "tl.aria_loading": "Zustand der letzten 24 Stunden: wird geladen",
    "tl.no_changes": "Keine Änderung in 24 h",
    "tl.live_only": "Kein Verlauf verfügbar: Änderungen seit dem Öffnen der Seite",
    "tl.now": "jetzt",
    "tl.start": "−24 h",
    "tl.mid": "−12 h",
    "tl.setting": "Zeitverlauf anzeigen",
    "tl.option": "Zeitverlauf (24 h)",
    "tl.more": "{n} weitere Wechsel zeigen",
  },
};

/** Timeline texts ("tl.*"), anything else via core.t. */
export function tlText(lang, key, vars = {}) {
  const l = core.langOf(lang);
  const own = (TL_I18N[l] && TL_I18N[l][key]) ?? TL_I18N.en[key];
  if (own == null) return core.t(lang, key, vars);
  let s = own;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Points `[{s, t}]` (state, epoch ms) from the rows `history_during_period`
 * returns with `minimal_response` (`s`, `lc`/`lu` in epoch seconds).
 */
export function historyPoints(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((p) => ({ s: p && p.s, t: Math.round(Number(p && (p.lc ?? p.lu)) * 1000) }))
    .filter((p) => typeof p.s === "string" && Number.isFinite(p.t));
}

/**
 * History first, then the live points newer than the last history point (a
 * live point repeating the state before it adds nothing).
 */
export function mergePoints(hist, live) {
  const out = [...hist];
  const lastT = hist.length ? hist[hist.length - 1].t : -Infinity;
  for (const p of live || []) {
    if (p.t <= lastT) continue;
    if (out.length && out[out.length - 1].s === p.s) continue;
    out.push(p);
  }
  return out;
}

/** Points cleaned for display: restart blips dropped, repeats merged. */
export function cleanPoints(points) {
  const out = [];
  const pts = points || [];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const next = pts[i + 1];
    const blip = (p.s === "unavailable" || p.s === "unknown") && next && (next.t - p.t) / 1000 < SHORT_GAP_S;
    if (blip) continue;
    if (out.length && out[out.length - 1].s === p.s) continue;
    out.push(p);
  }
  return out;
}

/** Segments `{s, from, to}` (ms) clipped to the window `[now - span, now]`. */
export function segments(points, now, span = DAY_MS) {
  const start = now - span;
  const pts = cleanPoints(points);
  const segs = [];
  for (let i = 0; i < pts.length; i += 1) {
    const from = Math.max(pts[i].t, start);
    const to = Math.min(i + 1 < pts.length ? pts[i + 1].t : now, now);
    if (to <= start || to <= from) continue;
    segs.push({ s: pts[i].s, from, to });
  }
  return segs;
}

/**
 * A run of two or more neighbouring segments that are each narrower than
 * `mergePct` (% of the window) becomes one segment in the state that held
 * longest inside the run; a single short segment (a lone incident) stays.
 * Neighbours that end up in the same state are joined. On a thin strip this
 * turns a flapping hour into one calm block instead of coloured flecks. The
 * last segment is the current state: it never joins a run (a fresh "suspect"
 * after a flapping hour must not turn green at the strip's end).
 */
export function mergeBursts(segs, mergePct, span = DAY_MS) {
  if (!(mergePct > 0) || !segs || segs.length < 2) return segs || [];
  const pct = (g) => ((g.to - g.from) / span) * 100;
  const lastIdx = segs.length - 1;
  const out = [];
  const push = (g) => {
    const last = out[out.length - 1];
    if (last && last.s === g.s) last.to = g.to;
    else out.push({ ...g });
  };
  let i = 0;
  while (i < segs.length) {
    let j = i;
    if (i < lastIdx && pct(segs[i]) < mergePct) {
      while (j + 1 < lastIdx && pct(segs[j + 1]) < mergePct) j += 1;
    }
    if (j === i) {
      push(segs[i]);
      i += 1;
      continue;
    }
    const per = new Map();
    for (let k = i; k <= j; k += 1) per.set(segs[k].s, (per.get(segs[k].s) || 0) + (segs[k].to - segs[k].from));
    let best = null;
    for (const [st, ms] of per) if (best == null || ms > per.get(best)) best = st;
    push({ s: best, from: segs[i].from, to: segs[j].to });
    i = j + 1;
  }
  return out;
}

/** The states of one repair run (yellow/blue on the track). */
const REPAIR_RUN = new Set(["suspect", "recovering", "verify", "cooldown"]);

/**
 * A segment narrower than `minPct` (% of the window) inside a repair run (it
 * and a neighbour both in REPAIR_RUN, e.g. a one-minute "verify" between two
 * half-hour "recovering" blocks) takes that neighbour's state: on a thin strip
 * the run reads as one calm block instead of a row of blue specks. A short
 * incident of another kind (an escalation inside "ok") is left alone; the
 * soft peak in gradientStops keeps it visible. Neighbours in the same state
 * are joined.
 */
export function absorbRepairBlips(segs, minPct, span = DAY_MS) {
  if (!(minPct > 0) || !segs || segs.length < 2) return segs || [];
  const pct = (g) => ((g.to - g.from) / span) * 100;
  const norm = (g) => core.normalizeState(g.s);
  const work = segs.map((g) => ({ ...g }));
  for (let i = 0; i < work.length - 1; i += 1) {
    // The last segment (the current state) keeps its own colour.
    const g = work[i];
    if (pct(g) >= minPct || !REPAIR_RUN.has(norm(g))) continue;
    const cands = [work[i - 1], work[i + 1]].filter((n) => n && REPAIR_RUN.has(norm(n)) && n.s !== g.s);
    if (!cands.length) continue;
    const best = cands.reduce((a, b) => (pct(b) > pct(a) ? b : a));
    g.s = best.s;
  }
  const out = [];
  for (const g of work) {
    const last = out[out.length - 1];
    if (last && last.s === g.s) last.to = g.to;
    else out.push(g);
  }
  return out;
}

/**
 * Slivers (segments narrower than `sliverPct` % of the window, e.g. a
 * 15-second snooze or a 9-second "suspect") that have another sliver within
 * `nearPct` % are a cluster: each takes the state of its wider neighbour, so
 * the strip's end does not turn into a bundle of thin coloured stripes (each
 * would be widened to the minimum width and blended on both sides). A lone
 * sliver stays: a short incident between long calm stretches must remain
 * visible. The last segment (the current state) is never absorbed. Neighbours
 * that end up in the same state are joined.
 */
export function absorbSlivers(segs, sliverPct, nearPct, span = DAY_MS) {
  if (!(sliverPct > 0) || !segs || segs.length < 3) return segs || [];
  const pct = (g) => ((g.to - g.from) / span) * 100;
  const thin = segs.map((g) => pct(g) < sliverPct);
  const gapPct = (a, b) => ((segs[b].from - segs[a].to) / span) * 100;
  const clustered = thin.map((isThin, i) => {
    if (!isThin) return false;
    for (let j = i - 1; j >= 0 && gapPct(j, i) <= nearPct; j -= 1) if (thin[j]) return true;
    for (let j = i + 1; j < segs.length && gapPct(i, j) <= nearPct; j += 1) if (thin[j]) return true;
    return false;
  });
  const work = segs.map((g) => ({ ...g }));
  for (let i = 0; i < work.length - 1; i += 1) {
    if (!clustered[i]) continue;
    // The wider of the nearest solid (non-sliver) segments on either side: a
    // sliver between two slivers (2 min "ok" between two snoozes) must not
    // take a neighbouring sliver's state.
    let l = i - 1;
    while (l >= 0 && thin[l]) l -= 1;
    let r = i + 1;
    while (r < segs.length && thin[r]) r += 1;
    const sides = [l, r].filter((j) => j >= 0 && j < segs.length);
    if (!sides.length) continue;
    const pick = sides.reduce((a, b) => (pct(segs[b]) > pct(segs[a]) ? b : a));
    work[i].s = segs[pick].s;
  }
  const out = [];
  for (const g of work) {
    const last = out[out.length - 1];
    if (last && last.s === g.s) last.to = g.to;
    else out.push(g);
  }
  return out;
}

/**
 * Segments laid out on the track in percent `{s, x0, x1}`: the window starts at
 * 0, "now" is 100. Segments narrower than `minPct` are widened to it, and the
 * wide ones give up the room in proportion, so short incidents stay visible and
 * the layout still ends at "now". Time before the first known point stays empty.
 */
export function layoutSegments(segs, now, span = DAY_MS, minPct = MIN_SEG_PCT) {
  if (!segs.length) return [];
  const start = now - span;
  const raw = segs.map((g) => ((g.to - g.from) / span) * 100);
  let deficit = 0;
  let wide = 0;
  for (const w of raw) {
    if (w < minPct) deficit += minPct - w;
    else wide += w;
  }
  const factor = deficit > 0 && wide > deficit ? (wide - deficit) / wide : 1;
  const widths = raw.map((w) => (deficit > 0 && wide > deficit ? (w < minPct ? minPct : w * factor) : w));
  let x = Math.max(0, ((segs[0].from - start) / span) * 100);
  return segs.map((g, i) => {
    const x0 = x;
    x = Math.min(100, x0 + widths[i]);
    return { s: g.s, x0, x1: x };
  });
}

/** CSS colour of a state on the track ("unavailable" = a faint neutral). */
export function segColor(state) {
  const n = core.normalizeState(state);
  if (n === "unavailable") return "var(--tl-off, color-mix(in srgb, var(--primary-text-color, #212121) 22%, transparent))";
  return core.stateColor(n);
}

/**
 * Gradient stops `[{color, at}]` (at in %) for laid-out segments: each state is
 * solid in its middle and blends into its neighbour. The blend reaches `blend`
 * % into each side of a boundary, but never past the middle of a segment, and
 * each side is measured on its own: a short incident (narrower than two
 * blends) has no solid part, it is one soft peak in its middle, and its long
 * neighbours do the whole fade towards it. So a few minutes of "escalated"
 * read as a soft glow on the track, never as a hard fleck. The empty time
 * before the first point fades in from transparent. A narrow last segment
 * (the current state, at least the minimum width) is solid from its start:
 * the strip always ends in the colour of "now".
 */
export function gradientStops(layout, blend = BLEND_PCT) {
  if (!layout.length) return [];
  const stops = [];
  const half = (g) => (g.x1 - g.x0) / 2;
  const first = layout[0];
  if (first.x0 > 0) {
    stops.push({ color: "transparent", at: 0 }, { color: "transparent", at: first.x0 - Math.min(blend, first.x0) });
    stops.push({ color: segColor(first.s), at: first.x0 + Math.min(blend, half(first)) });
  } else {
    stops.push({ color: segColor(first.s), at: 0 });
  }
  for (let i = 0; i + 1 < layout.length; i += 1) {
    const a = layout[i];
    const b = layout[i + 1];
    // A narrow last segment (no solid part of its own) starts solid.
    const lastB = i + 2 === layout.length && half(b) < blend;
    stops.push(
      { color: segColor(a.s), at: a.x1 - Math.min(blend, half(a)) },
      { color: segColor(b.s), at: lastB ? b.x0 : b.x0 + Math.min(blend, half(b)) },
    );
  }
  stops.push({ color: segColor(layout[layout.length - 1].s), at: 100 });
  // Rounding must never make a stop go backwards (CSS would clamp it anyway).
  let last = 0;
  for (const st of stops) {
    st.at = Math.max(last, Math.min(100, Math.round(st.at * 100) / 100));
    last = st.at;
  }
  return stops;
}

/**
 * The whole strip as one CSS `linear-gradient(...)`, "" when nothing is known.
 * `opts.widthPx` (the strip's width): short bursts are merged, the minimum
 * segment width and the blend are kept in pixels, so a thin list strip reads
 * as calm blocks with soft edges instead of a barcode.
 */
export function gradientCss(points, now, span = DAY_MS, opts = {}) {
  const w = Number(opts.widthPx) || 0;
  let segs = segments(points || [], now, span);
  let minPct = MIN_SEG_PCT;
  let blend = BLEND_PCT;
  if (w > 0) {
    segs = absorbSlivers(segs, (MIN_SEG_PX / w) * 100, (NEAR_PX / w) * 100, span);
    segs = mergeBursts(segs, (MERGE_PX / w) * 100, span);
    segs = absorbRepairBlips(segs, (MERGE_PX / w) * 100, span);
    minPct = Math.max(MIN_SEG_PCT, (MIN_SEG_PX / w) * 100);
    blend = Math.max(BLEND_PCT, (BLEND_PX / w) * 100);
  }
  const stops = gradientStops(layoutSegments(segs, now, span, minPct), blend);
  if (!stops.length) return "";
  return `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${s.at}%`).join(", ")})`;
}

/** The newest `n` transitions inside the window, newest first: `[{s, t}]`. */
export function recentTransitions(points, now, n = 4, span = DAY_MS) {
  const start = now - span;
  return cleanPoints(points || [])
    .filter((p) => p.t >= start)
    .slice(-n)
    .reverse();
}

/**
 * When the current run of `state` began (epoch ms), from the points: the
 * newest point when it holds `state` (repeats and restart blips cleaned, so
 * an HA restart does not start the run again), else null (the points do not
 * know the current state yet). The cards take it for "for 2 h" instead of
 * HA's `last_changed`, which a restart resets.
 */
export function runStart(points, state) {
  const pts = cleanPoints(points || []);
  const last = pts[pts.length - 1];
  return last && last.s === state ? last.t : null;
}

/**
 * Time per state in the window, longest first: "Healthy 20 h 5 min, Escalated
 * 3 h 55 min" (at most `max` states). For the strip's aria label.
 */
export function summaryText(points, now, lang, span = DAY_MS, max = 3) {
  const per = new Map();
  for (const g of segments(points || [], now, span)) {
    const s = core.normalizeState(g.s);
    per.set(s, (per.get(s) || 0) + (g.to - g.from));
  }
  if (!per.size) return tlText(lang, "tl.no_changes");
  return [...per.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([s, ms]) => `${core.t(lang, `state.${s}`)} ${core.formatDuration(ms / 1000, lang, { seconds: false })}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TimelineStore {
  /**
   * `opts.delay`: quiet time in ms after the last `want` before the batched
   * query goes out (every new id restarts it, so cards that render a little
   * later still join the same query); in a browser the query then waits for
   * an idle moment, so a dashboard that is still building its cards sends one
   * query, not one per card that came late; `opts.maxWait`: the query never
   * waits longer than this after the first id; `opts.now`: clock (tests).
   */
  constructor(opts = {}) {
    this.delay = opts.delay ?? 120;
    this.maxWait = Math.max(opts.maxWait ?? 1000, this.delay);
    this.idle = null;
    this.firstAt = 0;
    this.now = opts.now || (() => Date.now());
    this.data = new Map(); // id -> {points, loaded, history, lastSo, ver}
    this.queue = new Set();
    this.timer = null;
    this.pendingHass = null;
    this.listeners = new Set();
    this.lastHass = null;
  }

  /** `{points, loaded, history, ver}` of a tracked id, or null. */
  entry(id) {
    return this.data.get(id) || null;
  }

  /** Changes on every new point or history load (for render signatures). */
  version(id) {
    const e = this.data.get(id);
    return e ? e.ver : 0;
  }

  /** `fn(ids: Set)` after points of `ids` changed through a history load. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(ids) {
    for (const fn of [...this.listeners]) {
      try {
        fn(ids);
      } catch (_err) {
        // one broken listener must not stop the others
      }
    }
  }

  /** Ask for the history of `id` (batched); live points start right away. */
  want(hass, id) {
    if (!id || this.data.has(id)) return;
    this.data.set(id, { points: [], loaded: false, history: false, lastSo: null, ver: 0 });
    this.observe(id, hass && hass.states ? hass.states[id] : null);
    this.queue.add(id);
    this.pendingHass = hass;
    const t = Date.now();
    if (!this.timer && this.idle == null) this.firstAt = t;
    clearTimeout(this.timer);
    const left = () => this.firstAt + this.maxWait - Date.now();
    const wait = Math.max(0, Math.min(this.delay, left()));
    this.timer = setTimeout(() => {
      this.timer = null;
      const rest = left();
      if (typeof requestIdleCallback !== "function" || rest <= 0) {
        this.flush();
        return;
      }
      if (this.idle != null) return;
      this.idle = requestIdleCallback(() => {
        this.idle = null;
        this.flush();
      }, { timeout: rest });
    }, wait);
  }

  /** Run the queued history query now (the timer calls this; tests too). */
  async flush(hass = this.pendingHass) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.idle != null && typeof cancelIdleCallback === "function") cancelIdleCallback(this.idle);
    this.idle = null;
    const ids = [...this.queue];
    this.queue.clear();
    if (!ids.length) return;
    const start = new Date(this.now() - DAY_MS).toISOString();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      let res = null;
      try {
        if (hass && typeof hass.callWS === "function") {
          res = await hass.callWS({
            type: "history/history_during_period",
            start_time: start,
            entity_ids: chunk,
            minimal_response: true,
            no_attributes: true,
            significant_changes_only: false,
          });
        }
      } catch (_err) {
        res = null; // recorder off or no permission: live points only, no error
      }
      for (const id of chunk) {
        const e = this.data.get(id);
        if (!e) continue;
        const hist = historyPoints(res && res[id]);
        e.points = mergePoints(hist, e.points);
        e.history = Boolean(res);
        e.loaded = true;
        e.ver += 1;
      }
      this._notify(new Set(chunk));
    }
  }

  /** Append the state when it changed (idempotent across cards). */
  observe(id, so) {
    const e = this.data.get(id);
    if (!e || !so || so === e.lastSo) return false;
    e.lastSo = so;
    const at = core.toDate(so.last_changed);
    const tms = at ? at.getTime() : this.now();
    const last = e.points[e.points.length - 1];
    if (last && (last.s === so.state || tms < last.t)) return false;
    e.points.push({ s: so.state, t: tms });
    // Bounded: older than 24 h only the newest one (the starting state) counts.
    const cutoff = this.now() - DAY_MS;
    const firstIn = e.points.findIndex((p) => p.t >= cutoff);
    if (firstIn > 1) e.points.splice(0, firstIn - 1);
    if (e.points.length > MAX_POINTS) e.points.splice(0, e.points.length - MAX_POINTS);
    e.ver += 1;
    return true;
  }

  /** Feed every tracked guard from a new hass (the first caller per hass does the work). */
  sync(hass) {
    if (!hass || hass === this.lastHass || !hass.states) return;
    this.lastHass = hass;
    for (const [id, e] of this.data) {
      const so = hass.states[id];
      if (so && so !== e.lastSo) this.observe(id, so);
    }
  }
}

/** The page-wide store (one batched query for every element on the page). */
export const timeline = new TimelineStore();

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/**
 * A strip placeholder: `paintStrips` fills it after each render. `opts.thin`
 * for list rows and compact cards; shimmers until the history has loaded.
 * `opts.desc`: text the strip stands in for (a list row's last event, which
 * the strip replaces): it leads the tooltip and becomes the strip's
 * aria-description. `opts.descKey` marks it for a card that ticks that text
 * (`data-tick-desc`).
 */
export function stripHtml(id, entry, lang, opts = {}) {
  const loaded = Boolean(entry && entry.loaded);
  const cls = `tl-strip${opts.thin ? " thin" : ""}${loaded ? "" : " skel"}${opts.cls ? ` ${opts.cls}` : ""}`;
  const hint = tlText(lang, "tl.hint");
  const desc = opts.desc ? String(opts.desc) : "";
  const title = desc ? `${desc}\n${hint}` : hint;
  const extra = desc
    ? ` aria-description="${esc(desc)}"${opts.descKey ? ` data-tick-desc="${esc(opts.descKey)}"` : ""}`
    : "";
  return `<span class="${cls}" data-tl="${esc(id)}" role="img" title="${esc(title)}" aria-label="${esc(tlText(lang, "tl.aria_loading"))}"${extra}></span>`;
}

/**
 * The full-card section: title, strip, a light time axis and the newest `n`
 * transitions (clock time, coloured dot, state). Clock times are absolute, so
 * nothing in here ticks; only the strip is repainted.
 *
 * `opts.few` (optional): the transitions after the first `few` get the class
 * `tl-x` and a last item holds a "+N" button (`data-action="tl-more"`), so a
 * card can keep the list to one line on a narrow card (its CSS hides
 * `.tl-x` and shows `.tl-more` there); `opts.all` drops the fold again.
 */
export function sectionHtml(id, entry, now, lang, opts = {}) {
  const n = opts.n ?? 4;
  const few = Number(opts.few) > 0 && !opts.all ? Math.floor(Number(opts.few)) : 0;
  const loaded = Boolean(entry && entry.loaded);
  let log;
  if (!loaded) {
    log = `<div class="tl-log skel-line" aria-hidden="true"></div>`;
  } else {
    const rows = recentTransitions(entry.points, now, n);
    let items = rows
      .map((p, i) => {
        const s = core.normalizeState(p.s);
        const time = core.formatClock(p.t, now, lang, opts.timeZone, opts.timeFormat);
        const cls = few && i >= few ? ` class="tl-x"` : "";
        return `<li${cls}><span class="tl-dot" style="--tl-c:${segColor(s)}"></span><time>${esc(time)}</time><span class="tl-st">${esc(core.t(lang, `state.${s}`))}</span></li>`;
      })
      .join("");
    if (few && rows.length > few) {
      const k = rows.length - few;
      const label = tlText(lang, "tl.more", { n: k });
      items += `<li class="tl-more"><button type="button" data-action="tl-more" title="${esc(label)}" aria-label="${esc(label)}">+${k}</button></li>`;
    }
    log = items ? `<ol class="tl-log">${items}</ol>` : `<div class="tl-none">${esc(tlText(lang, "tl.no_changes"))}</div>`;
    if (!entry.history) log += `<div class="tl-none tl-live">${esc(tlText(lang, "tl.live_only"))}</div>`;
  }
  return `<div class="tl" aria-busy="${loaded ? "false" : "true"}">
      <div class="tl-head"><span class="tl-title">${esc(tlText(lang, "tl.title"))}</span></div>
      ${stripHtml(id, entry, lang)}
      <div class="tl-axis" aria-hidden="true"><span>${esc(tlText(lang, "tl.start"))}</span><span>${esc(tlText(lang, "tl.mid"))}</span><span>${esc(tlText(lang, "tl.now"))}</span></div>
      ${log}
    </div>`;
}

/**
 * Paint every `[data-tl]` strip under `root` from the store: gradient and aria
 * label. Cheap; call it after each render and on a slow tick (the "now" end
 * moves). A strip whose history has not loaded keeps its shimmer.
 */
export function paintStrips(root, store, now, lang) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const el of root.querySelectorAll("[data-tl]")) {
    paintStrip(el, store, now, lang);
  }
}

// Strip widths without forcing a layout: one shared ResizeObserver reports
// each painted strip's width; a changed width repaints that strip (the first
// report comes right after the strip is laid out).
const widths = new WeakMap(); // strip element -> {w, store, lang}
let sizer = null;

function watchWidth(el, store, lang) {
  if (typeof ResizeObserver === "undefined") return 0;
  let rec = widths.get(el);
  if (!rec) {
    rec = { w: 0, store, lang };
    widths.set(el, rec);
    if (!sizer) {
      sizer = new ResizeObserver((entries) => {
        for (const en of entries) {
          const target = en.target;
          const r = widths.get(target);
          if (!target.isConnected || !r) {
            sizer.unobserve(target);
            widths.delete(target);
            continue;
          }
          const w = Math.round(en.contentRect.width);
          if (Math.abs(w - r.w) < 1) continue;
          r.w = w;
          paintStrip(target, r.store, r.store.now(), r.lang);
        }
      });
    }
    sizer.observe(el);
  }
  rec.store = store;
  rec.lang = lang;
  return rec.w;
}

/** Paint one strip (see paintStrips); the width comes from the observer. */
export function paintStrip(el, store, now, lang) {
  const e = store.entry(el.getAttribute("data-tl"));
  if (!e || !e.loaded) return;
  el.classList.remove("skel");
  const widthPx = watchWidth(el, store, lang);
  const bg = gradientCss(e.points, now, DAY_MS, { widthPx });
  if (el.style) el.style.backgroundImage = bg || "none";
  el.setAttribute("aria-label", tlText(lang, "tl.aria", { summary: summaryText(e.points, now, lang) }));
}

/** How often a visible strip is repainted (its "now" end moves). */
export const REPAINT_MS = 60000;

// ---------------------------------------------------------------------------
// CSS (themable through --tl-* variables; the cards map their tokens)
// ---------------------------------------------------------------------------

export const TIMELINE_CSS = `
  .tl { display: grid; gap: 6px; min-width: 0; }
  .tl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .tl-title {
    font-size: 11.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--tl-text2, var(--secondary-text-color, #727272));
  }
  .tl-strip {
    position: relative; display: block; box-sizing: border-box; width: 100%; min-width: 0;
    height: var(--tl-h, 12px); border-radius: var(--tl-radius, 999px); overflow: hidden;
    background-color: var(--tl-track, color-mix(in srgb, var(--primary-text-color, #212121) 8%, transparent));
    background-repeat: no-repeat;
  }
  /* A soft top light: the strip reads as one rounded, slightly raised pill. */
  .tl-strip::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0) 65%);
  }
  .tl-strip.thin { height: var(--tl-h-thin, 6px); }
  .tl-strip.thin::after { display: none; }
  .tl-strip.skel, .tl-log.skel-line {
    background-image: linear-gradient(90deg, transparent 0%,
      color-mix(in srgb, var(--primary-text-color, #212121) 10%, transparent) 50%, transparent 100%);
    background-size: 200% 100%; animation: tl-shimmer 1.4s ease-in-out infinite;
  }
  .tl-log.skel-line {
    height: 12px; width: 60%; border-radius: 6px;
    background-color: var(--tl-track, color-mix(in srgb, var(--primary-text-color, #212121) 8%, transparent));
  }
  @keyframes tl-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  .tl-axis {
    display: flex; justify-content: space-between; margin-top: -2px;
    font-size: 10.5px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums;
    color: var(--tl-text2, var(--secondary-text-color, #727272)); opacity: 0.85;
  }
  .tl-log {
    display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 0; padding: 0; list-style: none;
  }
  .tl-log li {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; border-radius: 999px;
    background: var(--tl-track, color-mix(in srgb, var(--primary-text-color, #212121) 6%, transparent));
    font-size: 12px; line-height: 1.35; color: var(--tl-text, var(--primary-text-color, #212121)); white-space: nowrap;
  }
  .tl-log time { font-weight: 700; font-variant-numeric: tabular-nums; }
  .tl-log .tl-st { color: var(--tl-text2, var(--secondary-text-color, #727272)); }
  .tl-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tl-c); }
  .tl-log li.tl-more { display: none; padding: 0; background: none; }
  .tl-more button {
    height: 25px; min-width: 34px; padding: 0 9px; border: none; border-radius: 999px; cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 800; color: var(--tl-text2, var(--secondary-text-color, #727272));
    background: var(--tl-track, color-mix(in srgb, var(--primary-text-color, #212121) 6%, transparent));
  }
  .tl-none { font-size: 12px; line-height: 1.35; color: var(--tl-text2, var(--secondary-text-color, #727272)); }
  @media (prefers-reduced-motion: reduce) {
    .tl-strip.skel, .tl-log.skel-line { animation: none; }
  }
`;
