// Tests for the shared 24 h state timeline (necromancer-timeline.js): history
// parsing, cleaning, segments clipped to 24 h, the minimum visible width, the
// soft gradient stops, en/de texts, the batched store (one query for many
// guards, live points, recorder off) and the markup/painting helpers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  MIN_SEG_PCT,
  TIMELINE_CSS,
  TimelineStore,
  absorbRepairBlips,
  absorbSlivers,
  cleanPoints,
  gradientCss,
  gradientStops,
  historyPoints,
  layoutSegments,
  mergeBursts,
  mergePoints,
  paintStrips,
  recentTransitions,
  runStart,
  sectionHtml,
  segColor,
  segments,
  stripHtml,
  summaryText,
  timeline,
  tlText,
} from "../../custom_components/necromancer/frontend/necromancer-timeline.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const H = 3600e3;
const at = (hoursAgo) => NOW - hoursAgo * H;

describe("history and points", () => {
  test("historyPoints reads minimal_response rows (lc before lu, seconds -> ms)", () => {
    const rows = [
      { s: "ok", lu: (NOW - 30 * H) / 1000 },
      { s: "escalated", lc: (NOW - 2 * H) / 1000, lu: (NOW - 1 * H) / 1000 },
      { s: 5, lu: 1 },
      { s: "ok" },
      null,
    ];
    assert.deepEqual(historyPoints(rows), [
      { s: "ok", t: NOW - 30 * H },
      { s: "escalated", t: NOW - 2 * H },
    ]);
    assert.deepEqual(historyPoints(undefined), []);
  });

  test("mergePoints keeps only live points newer than the history", () => {
    const hist = [{ s: "ok", t: at(10) }, { s: "suspect", t: at(2) }];
    const live = [{ s: "ok", t: at(5) }, { s: "escalated", t: at(1) }];
    assert.deepEqual(mergePoints(hist, live), [...hist, { s: "escalated", t: at(1) }]);
    assert.deepEqual(mergePoints([], live), live);
  });

  test("cleanPoints drops restart blips and merges repeats", () => {
    const pts = [
      { s: "ok", t: at(10) },
      { s: "unavailable", t: at(5) },
      { s: "ok", t: at(5) + 5000 }, // 5 s blip: dropped, then a repeat of ok
      { s: "ok", t: at(4) },
      { s: "unavailable", t: at(3) }, // a real outage (1 h): kept
      { s: "escalated", t: at(2) },
    ];
    assert.deepEqual(
      cleanPoints(pts).map((p) => p.s),
      ["ok", "unavailable", "escalated"],
    );
  });
});

describe("segments and layout", () => {
  test("segments are clipped to the last 24 h and end at now", () => {
    const pts = [
      { s: "ok", t: at(30) },
      { s: "escalated", t: at(6) },
      { s: "ok", t: at(1) },
    ];
    const segs = segments(pts, NOW);
    assert.deepEqual(segs, [
      { s: "ok", from: at(24), to: at(6) },
      { s: "escalated", from: at(6), to: at(1) },
      { s: "ok", from: at(1), to: NOW },
    ]);
    // Everything older than the window: only the last state, from the start.
    assert.deepEqual(segments([{ s: "ok", t: at(48) }], NOW), [{ s: "ok", from: at(24), to: NOW }]);
    assert.deepEqual(segments([], NOW), []);
  });

  test("layout starts after the unknown time and ends at 100 %", () => {
    // Live only: the first known point is 6 h ago.
    const lay = layoutSegments(segments([{ s: "ok", t: at(6) }], NOW), NOW);
    assert.equal(lay.length, 1);
    assert.ok(Math.abs(lay[0].x0 - 75) < 1e-9);
    assert.ok(Math.abs(lay[0].x1 - 100) < 1e-9);
  });

  test("a short incident keeps a minimum visible width, the rest shrinks", () => {
    const pts = [
      { s: "ok", t: at(24) },
      { s: "escalated", t: at(12) },
      { s: "ok", t: at(12) + 60e3 }, // one minute
    ];
    const lay = layoutSegments(segments(pts, NOW), NOW);
    assert.equal(lay.length, 3);
    assert.ok(Math.abs(lay[1].x1 - lay[1].x0 - MIN_SEG_PCT) < 1e-9, "the one-minute escalation is widened");
    assert.ok(Math.abs(lay[2].x1 - 100) < 1e-6, "the layout still ends at now");
    for (let i = 1; i < lay.length; i += 1) assert.ok(Math.abs(lay[i].x0 - lay[i - 1].x1) < 1e-9, "contiguous");
  });
});

describe("gradient", () => {
  test("stops blend softly at every boundary and never go backwards", () => {
    const pts = [
      { s: "ok", t: at(24) },
      { s: "escalated", t: at(12) },
      { s: "ok", t: at(6) },
    ];
    const stops = gradientStops(layoutSegments(segments(pts, NOW), NOW));
    assert.equal(stops[0].at, 0);
    assert.equal(stops[stops.length - 1].at, 100);
    for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i].at >= stops[i - 1].at);
    // Around the boundary at 50 %: ok just before, escalated just after (a soft ramp).
    const ok = segColor("ok");
    const bad = segColor("escalated");
    const before = stops.find((s) => s.color === ok && s.at > 40 && s.at < 50);
    const after = stops.find((s) => s.color === bad && s.at > 50 && s.at < 60);
    assert.ok(before && after, JSON.stringify(stops));
    assert.ok(after.at - before.at > 0 && after.at - before.at <= 2, "the blend is narrow");
  });

  test("unknown time before the first point fades in from transparent", () => {
    const css = gradientCss([{ s: "ok", t: at(6) }], NOW);
    assert.match(css, /^linear-gradient\(90deg, transparent 0%, transparent 7\d(\.\d+)?%/);
    assert.ok(css.includes(segColor("ok")));
    assert.ok(css.endsWith("100%)"));
  });

  test("state colours come from the theme; unknown states are neutral", () => {
    assert.match(segColor("ok"), /--success-color/);
    assert.match(segColor("escalated"), /--error-color/);
    assert.match(segColor("unavailable"), /--tl-off/);
    assert.equal(segColor("whatever"), segColor("unavailable"));
    assert.equal(gradientCss([], NOW), "");
  });
});

describe("texts", () => {
  test("en and de have the same keys", () => {
    for (const key of ["tl.title", "tl.hint", "tl.no_changes", "tl.live_only", "tl.now", "tl.setting", "tl.option"]) {
      assert.notEqual(tlText("en", key), key, key);
      assert.notEqual(tlText("de", key), key, key);
    }
    assert.equal(tlText("en", "tl.title"), "Last 24 h");
    assert.equal(tlText("de-DE", "tl.title"), "Letzte 24 h");
    assert.equal(tlText("de", "tl.setting"), "Zeitverlauf anzeigen");
    assert.equal(tlText("fr", "tl.setting"), "Show 24 h timeline");
    // Anything else falls back to the core texts.
    assert.equal(tlText("de", "state.escalated"), "Eskaliert");
  });

  test("recent transitions newest first, summary longest first", () => {
    const pts = [
      { s: "ok", t: at(30) },
      { s: "escalated", t: at(4) },
      { s: "ok", t: at(1) },
    ];
    assert.deepEqual(
      recentTransitions(pts, NOW, 4).map((p) => p.s),
      ["ok", "escalated"],
    );
    assert.equal(summaryText(pts, NOW, "en"), "Healthy 21 h, Escalated 3 h");
    assert.equal(summaryText(pts, NOW, "de"), "Gesund 21 h, Eskaliert 3 h");
    assert.equal(summaryText([], NOW, "en"), "No change in 24 h");
  });
});

describe("store", () => {
  const so = (state, hoursAgo) => ({ state, last_changed: new Date(at(hoursAgo)).toISOString() });

  function fakeHass(states, history, fail = false) {
    return {
      states,
      calls: [],
      async callWS(msg) {
        this.calls.push(msg);
        if (fail) throw new Error("Unauthorized");
        return history;
      },
    };
  }

  test("one batched query for every wanted guard", async () => {
    const store = new TimelineStore({ delay: 5, now: () => NOW });
    const hass = fakeHass(
      { "sensor.a_status": so("ok", 1), "sensor.b_status": so("escalated", 2) },
      {
        "sensor.a_status": [{ s: "escalated", lu: at(30) / 1000 }, { s: "ok", lc: at(1) / 1000 }],
        "sensor.b_status": [{ s: "ok", lu: at(24) / 1000 }, { s: "escalated", lc: at(2) / 1000 }],
      },
    );
    const seen = [];
    store.subscribe((ids) => seen.push([...ids]));
    store.want(hass, "sensor.a_status");
    store.want(hass, "sensor.b_status");
    store.want(hass, "sensor.a_status"); // twice: still one id
    assert.equal(store.entry("sensor.a_status").loaded, false);
    await store.flush();
    assert.equal(hass.calls.length, 1);
    const msg = hass.calls[0];
    assert.equal(msg.type, "history/history_during_period");
    assert.deepEqual(msg.entity_ids, ["sensor.a_status", "sensor.b_status"]);
    assert.equal(msg.minimal_response, true);
    assert.equal(msg.no_attributes, true);
    assert.equal(msg.start_time, new Date(NOW - DAY_MS).toISOString());
    const a = store.entry("sensor.a_status");
    assert.equal(a.loaded, true);
    assert.equal(a.history, true);
    assert.deepEqual(
      a.points.map((p) => p.s),
      ["escalated", "ok"],
    );
    assert.deepEqual(seen, [["sensor.a_status", "sensor.b_status"]]);
    // Nothing more queued: a second flush sends nothing.
    await store.flush();
    assert.equal(hass.calls.length, 1);
  });

  test("the batching timer sends the query by itself", async () => {
    const store = new TimelineStore({ delay: 1, now: () => NOW });
    const hass = fakeHass({ "sensor.a_status": so("ok", 1) }, { "sensor.a_status": [] });
    store.want(hass, "sensor.a_status");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(hass.calls.length, 1);
    assert.equal(store.entry("sensor.a_status").loaded, true);
  });

  test("a card that asks a little later still joins the same query", async () => {
    const store = new TimelineStore({ delay: 30, maxWait: 400, now: () => NOW });
    const hass = fakeHass({ "sensor.a_status": so("ok", 1), "sensor.b_status": so("ok", 1) }, {});
    store.want(hass, "sensor.a_status");
    await new Promise((r) => setTimeout(r, 15));
    store.want(hass, "sensor.b_status");
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(hass.calls.length, 0, "the window restarts on each new id");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(hass.calls.length, 1);
    assert.deepEqual(hass.calls[0].entity_ids, ["sensor.a_status", "sensor.b_status"]);
  });

  test("a steady stream of ids never delays the query past maxWait", async () => {
    const store = new TimelineStore({ delay: 40, maxWait: 60, now: () => NOW });
    const hass = fakeHass({}, {});
    for (let i = 0; i < 8; i += 1) {
      store.want(hass, `sensor.g${i}_status`);
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(hass.calls.length >= 2, `query went out on time (${hass.calls.length})`);
    assert.equal(hass.calls.flatMap((c) => c.entity_ids).length, 8);
  });

  test("live points from hass updates, once per state object", async () => {
    const store = new TimelineStore({ delay: 5, now: () => NOW });
    const s1 = so("ok", 3);
    const hass = fakeHass({ "sensor.a_status": s1 }, { "sensor.a_status": [{ s: "ok", lu: at(24) / 1000 }] });
    store.want(hass, "sensor.a_status");
    await store.flush();
    const v = store.version("sensor.a_status");
    store.sync(hass); // same hass: nothing
    assert.equal(store.version("sensor.a_status"), v);
    const s2 = so("escalated", 0.5);
    const hass2 = { ...hass, states: { "sensor.a_status": s2 } };
    store.sync(hass2);
    store.sync(hass2);
    assert.equal(store.version("sensor.a_status"), v + 1);
    assert.deepEqual(
      store.entry("sensor.a_status").points.map((p) => p.s),
      ["ok", "escalated"],
    );
    // An attribute-only update (same state) adds no point.
    store.sync({ ...hass2, states: { "sensor.a_status": { ...s2 } } });
    assert.equal(store.entry("sensor.a_status").points.length, 2);
  });

  test("recorder off / no permission: live points only, no error", async () => {
    const store = new TimelineStore({ delay: 5, now: () => NOW });
    const hass = fakeHass({ "sensor.a_status": so("suspect", 0.2) }, null, true);
    store.want(hass, "sensor.a_status");
    await store.flush();
    const e = store.entry("sensor.a_status");
    assert.equal(e.loaded, true);
    assert.equal(e.history, false);
    assert.deepEqual(
      e.points.map((p) => p.s),
      ["suspect"],
    );
    assert.match(sectionHtml("sensor.a_status", e, NOW, "en"), /No history available/);
  });

  test("nothing is queried for guards nobody asked for", async () => {
    const store = new TimelineStore({ delay: 5, now: () => NOW });
    const hass = fakeHass({ "sensor.a_status": so("ok", 1) }, {});
    store.sync(hass);
    await store.flush(hass);
    assert.equal(hass.calls.length, 0);
    assert.equal(store.entry("sensor.a_status"), null);
    assert.ok(timeline instanceof TimelineStore, "a page-wide store is exported");
  });
});

describe("thin strips: no barcode", () => {
  const MIN = 60e3;
  test("mergeBursts: a run of short neighbours becomes one block in its longest state", () => {
    const segs = [
      { s: "ok", from: at(20), to: at(10) },
      { s: "escalated", from: at(10), to: at(10) + 4 * MIN },
      { s: "ok", from: at(10) + 4 * MIN, to: at(10) + 6 * MIN },
      { s: "escalated", from: at(10) + 6 * MIN, to: at(10) + 12 * MIN },
      { s: "ok", from: at(10) + 12 * MIN, to: NOW },
    ];
    // 1 % of 24 h = 14.4 min: the three middle segments are a burst.
    const out = mergeBursts(segs, 1);
    assert.deepEqual(
      out.map((g) => g.s),
      ["ok", "escalated", "ok"],
    );
    assert.equal(out[1].from, at(10));
    assert.equal(out[1].to, at(10) + 12 * MIN);
    assert.equal(out.at(-1).to, NOW);
  });

  test("mergeBursts keeps a lone short incident and joins same-state neighbours", () => {
    const lone = [
      { s: "ok", from: at(20), to: at(5) },
      { s: "escalated", from: at(5), to: at(5) + 3 * MIN },
      { s: "ok", from: at(5) + 3 * MIN, to: NOW },
    ];
    assert.deepEqual(mergeBursts(lone, 1), lone);
    // Burst dominated by "ok" between two "ok" blocks: one single block.
    const flap = [
      { s: "ok", from: at(20), to: at(5) },
      { s: "suspect", from: at(5), to: at(5) + 1 * MIN },
      { s: "ok", from: at(5) + 1 * MIN, to: at(5) + 9 * MIN },
      { s: "ok", from: at(5) + 9 * MIN, to: NOW },
    ];
    assert.deepEqual(
      mergeBursts(flap, 1).map((g) => [g.s, g.from, g.to]),
      [["ok", at(20), NOW]],
    );
    assert.deepEqual(mergeBursts([], 1), []);
    assert.equal(mergeBursts(lone, 0), lone, "no width known: unchanged");
  });

  test("gradientCss with the strip width: fewer colour changes, wider minimum", () => {
    const pts = [{ s: "ok", t: at(20) }];
    for (let i = 0; i < 12; i += 1) pts.push({ s: i % 2 ? "ok" : "escalated", t: at(6) + i * 2 * 60e3 });
    pts.push({ s: "ok", t: at(5) });
    const count = (css) => (css.match(/stateColor|var\(--|#[0-9a-f]{3,6}|rgb/gi) || []).length;
    const raw = gradientCss(pts, NOW);
    const thin = gradientCss(pts, NOW, DAY_MS, { widthPx: 300 });
    assert.match(thin, /^linear-gradient\(90deg/);
    assert.ok(count(thin) < count(raw), `${count(thin)} < ${count(raw)}`);
    // A lone 3 min incident on a 300 px strip is at least 3 px (1 %) wide.
    const lone = [{ s: "ok", t: at(20) }, { s: "escalated", t: at(3) }, { s: "ok", t: at(3) + 3 * 60e3 }];
    const lay = layoutSegments(segments(lone, NOW), NOW, DAY_MS, (3 / 300) * 100);
    const esc = lay.find((g) => g.s === "escalated");
    assert.ok(esc.x1 - esc.x0 >= 0.99, String(esc.x1 - esc.x0));
    assert.match(gradientCss(lone, NOW, DAY_MS, { widthPx: 300 }), /linear-gradient/);
  });

  test("a short incident is one soft peak: no solid fleck, the neighbours fade into it", () => {
    // 4 % wide escalation inside long ok runs, blend 3 %: narrower than two blends.
    const layout = [
      { s: "ok", x0: 0, x1: 48 },
      { s: "escalated", x0: 48, x1: 52 },
      { s: "ok", x0: 52, x1: 100 },
    ];
    const stops = gradientStops(layout, 3);
    const bad = stops.filter((st) => st.color === segColor("escalated"));
    assert.equal(bad.length, 2);
    assert.equal(bad[0].at, 50, "peak in the middle");
    assert.equal(bad[1].at, 50, "no solid part");
    const ok = stops.filter((st) => st.color === segColor("ok") && st.at > 0 && st.at < 100);
    assert.deepEqual(
      ok.map((st) => st.at),
      [45, 55],
      "the long neighbours fade over the full blend",
    );
    for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i].at >= stops[i - 1].at);
  });

  test("repair run: one-minute verify blips join the recovering block, a lone escalation stays", () => {
    const M = 60e3;
    const t0 = at(10);
    const segs = [
      { s: "ok", from: t0, to: t0 + 120 * M },
      { s: "recovering", from: t0 + 120 * M, to: t0 + 150 * M },
      { s: "verify", from: t0 + 150 * M, to: t0 + 151 * M },
      { s: "recovering", from: t0 + 151 * M, to: t0 + 181 * M },
      { s: "verify", from: t0 + 181 * M, to: t0 + 182 * M },
      { s: "escalated", from: t0 + 182 * M, to: t0 + 300 * M },
      { s: "ok", from: t0 + 300 * M, to: t0 + 420 * M },
      { s: "escalated", from: t0 + 420 * M, to: t0 + 422 * M },
      { s: "ok", from: t0 + 422 * M, to: t0 + 600 * M },
    ];
    const pct = (10 / 1000) * 100; // 10 px on a 1000 px strip
    const out = absorbRepairBlips(segs, pct);
    assert.deepEqual(
      out.map((g) => g.s),
      ["ok", "recovering", "escalated", "ok", "escalated", "ok"],
    );
    assert.equal(out[1].to - out[1].from, 62 * M, "the run keeps its full length");
    assert.equal(absorbRepairBlips(segs, 0), segs, "no width known: unchanged");
  });

  test("absorbSlivers: a cluster of slivers at the strip's end turns calm, a lone sliver stays", () => {
    const S = 1000;
    const t0 = at(6);
    // What a snooze-and-wake left on Demo Backup: a 15 s snooze, 19 min ok, a
    // 9 s suspect, then escalated; and a lone 15 s snooze much earlier.
    const segs = [
      { s: "ok", from: at(20), to: at(15) },
      { s: "snoozed", from: at(15), to: at(15) + 15 * S },
      { s: "ok", from: at(15) + 15 * S, to: t0 },
      { s: "snoozed", from: t0, to: t0 + 15 * S },
      { s: "ok", from: t0 + 15 * S, to: t0 + 19 * 60 * S },
      { s: "suspect", from: t0 + 19 * 60 * S, to: t0 + 19 * 60 * S + 9 * S },
      { s: "escalated", from: t0 + 19 * 60 * S + 9 * S, to: NOW },
    ];
    // 970 px strip: a sliver is < 4 px (~6 min), near = 36 px (~53 min).
    const out = absorbSlivers(segs, (4 / 970) * 100, (36 / 970) * 100);
    assert.deepEqual(
      out.map((g) => g.s),
      ["ok", "snoozed", "ok", "escalated"],
      "the clustered snooze joins the ok block, the suspect the escalation; the lone snooze stays",
    );
    assert.equal(out.at(-1).to, NOW);
    assert.equal(out[2].to, t0 + 19 * 60 * S, "ok runs up to where the suspect began");
    assert.equal(absorbSlivers(segs, 0, 1), segs, "no width known: unchanged");
    // A lone short escalation inside long ok runs is never touched.
    const lone = [
      { s: "ok", from: at(20), to: at(5) },
      { s: "escalated", from: at(5), to: at(5) + 60 * S },
      { s: "ok", from: at(5) + 60 * S, to: NOW },
    ];
    assert.deepEqual(absorbSlivers(lone, 1, 5), lone);
    // Snooze, 2 min ok, snooze again: the short ok between them does not turn
    // violet; the whole cluster becomes the long ok around it.
    const twice = [
      { s: "ok", from: at(20), to: at(2) },
      { s: "snoozed", from: at(2), to: at(2) + 15 * S },
      { s: "ok", from: at(2) + 15 * S, to: at(2) + 135 * S },
      { s: "snoozed", from: at(2) + 135 * S, to: at(2) + 150 * S },
      { s: "ok", from: at(2) + 150 * S, to: NOW },
    ];
    assert.deepEqual(
      absorbSlivers(twice, (4 / 700) * 100, (36 / 700) * 100).map((g) => [g.s, g.from, g.to]),
      [["ok", at(20), NOW]],
    );
  });

  test("a wide segment keeps a solid middle between its blends", () => {
    const stops = gradientStops(
      [
        { s: "ok", x0: 0, x1: 50 },
        { s: "escalated", x0: 50, x1: 100 },
      ],
      2,
    );
    assert.deepEqual(
      stops.map((st) => st.at),
      [0, 48, 52, 100],
    );
  });
});

describe("markup", () => {
  const entry = {
    loaded: true,
    history: true,
    points: [
      { s: "ok", t: at(30) },
      { s: "escalated", t: at(4) },
      { s: "ok", t: at(1) },
    ],
  };

  test("strip placeholder shimmers until loaded and never carries the gradient", () => {
    const loading = stripHtml("sensor.a_status", { loaded: false, points: [] }, "en", { thin: true });
    assert.match(loading, /class="tl-strip thin skel"/);
    assert.match(loading, /data-tl="sensor.a_status"/);
    assert.ok(!loading.includes("linear-gradient"));
    assert.match(stripHtml("sensor.a_status", entry, "de"), /class="tl-strip"/);
  });

  test("strip standing in for a row's last event: tooltip + aria-description", () => {
    const html = stripHtml("sensor.a_status", entry, "en", { thin: true, desc: "Escalated · 2 attempts <x>", descKey: "event" });
    assert.match(html, /aria-description="Escalated · 2 attempts &lt;x&gt;"/);
    assert.match(html, /data-tick-desc="event"/);
    assert.match(html, /title="Escalated · 2 attempts &lt;x&gt;\nState over the last 24 hours/);
    const de = stripHtml("sensor.a_status", entry, "de", { desc: "Repariert" });
    assert.match(de, /title="Repariert\nZustand der letzten 24 Stunden/);
    assert.ok(!de.includes("data-tick-desc"));
    assert.ok(!stripHtml("sensor.a_status", entry, "en").includes("aria-description"));
  });

  test("section: title, axis, the newest transitions (en/de)", () => {
    const en = sectionHtml("sensor.a_status", entry, NOW, "en", { timeZone: "UTC", timeFormat: "24" });
    assert.match(en, /Last 24 h/);
    assert.match(en, /−24 h/);
    assert.match(en, />now</);
    assert.match(en, /<time>11:00<\/time><span class="tl-st">Healthy</);
    assert.match(en, /<time>08:00<\/time><span class="tl-st">Escalated</);
    const de = sectionHtml("sensor.a_status", entry, NOW, "de", { timeZone: "UTC", timeFormat: "24" });
    assert.match(de, /Letzte 24 h/);
    assert.match(de, />jetzt</);
    assert.match(de, /Eskaliert/);
    const quiet = sectionHtml("sensor.a_status", { loaded: true, history: true, points: [{ s: "ok", t: at(48) }] }, NOW, "de");
    assert.match(quiet, /Keine Änderung in 24 h/);
    const loading = sectionHtml("sensor.a_status", { loaded: false, points: [] }, NOW, "en");
    assert.match(loading, /aria-busy="true"/);
    assert.match(loading, /skel/);
  });

  test("paintStrips sets the gradient and the aria label on loaded strips only", () => {
    const mk = (id) => {
      const classes = new Set(["tl-strip", "skel"]);
      const attrs = { "data-tl": id };
      return {
        style: {},
        classList: { remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
        getAttribute: (k) => attrs[k],
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        attrs,
      };
    };
    const a = mk("sensor.a_status");
    const b = mk("sensor.b_status");
    const store = new TimelineStore({ now: () => NOW });
    store.data.set("sensor.a_status", { ...entry, ver: 1 });
    store.data.set("sensor.b_status", { loaded: false, points: [], ver: 0 });
    paintStrips({ querySelectorAll: () => [a, b] }, store, NOW, "en");
    assert.match(a.style.backgroundImage, /^linear-gradient\(90deg/);
    assert.equal(a.classList.has("skel"), false);
    assert.match(a.attrs["aria-label"], /State over the last 24 hours: Healthy/);
    assert.equal(b.style.backgroundImage, undefined);
    assert.equal(b.classList.has("skel"), true);
  });

  test("CSS: rounded track, shimmer off under reduced motion", () => {
    assert.match(TIMELINE_CSS, /\.tl-strip \{[^}]*border-radius: var\(--tl-radius, 999px\)/);
    assert.match(TIMELINE_CSS, /prefers-reduced-motion: reduce\) \{\s*\.tl-strip\.skel, \.tl-log\.skel-line \{ animation: none; \}/);
  });
});

describe("the current state at the strip's end", () => {
  const M = 60e3;
  test("absorbSlivers and mergeBursts never take the last segment", () => {
    // A flapping stretch, then a fresh 3-minute "suspect" right now (Smoke A).
    const t0 = NOW - 40 * M;
    const segs = [
      { s: "ok", from: NOW - 10 * H, to: t0 },
      { s: "suspect", from: t0, to: t0 + M },
      { s: "ok", from: t0 + M, to: t0 + 2 * M },
      { s: "snoozed", from: t0 + 2 * M, to: t0 + 3 * M },
      { s: "ok", from: t0 + 3 * M, to: NOW - 3 * M },
      { s: "suspect", from: NOW - 3 * M, to: NOW },
    ];
    const pct = (px) => (px / 300) * 100;
    const a = absorbSlivers(segs, pct(4), pct(36));
    assert.equal(a[a.length - 1].s, "suspect");
    const m = mergeBursts(segs, pct(12));
    assert.equal(m[m.length - 1].s, "suspect");
    assert.equal(m[m.length - 1].from, NOW - 3 * M);
    const r = absorbRepairBlips([{ s: "recovering", from: NOW - 2 * H, to: NOW - M }, { s: "verify", from: NOW - M, to: NOW }], 2);
    assert.equal(r[r.length - 1].s, "verify");
  });

  test("gradientCss ends in the current state's colour, solid for at least MIN_SEG_PX", () => {
    const pts = [
      { s: "ok", t: NOW - 20 * H },
      { s: "suspect", t: NOW - 40 * M },
      { s: "ok", t: NOW - 39 * M },
      { s: "snoozed", t: NOW - 38 * M },
      { s: "ok", t: NOW - 37 * M },
      { s: "suspect", t: NOW - 3 * M },
    ];
    const css = gradientCss(pts, NOW, DAY_MS, { widthPx: 300 });
    const stops = [...css.matchAll(/(var\([^)]*\)[^,]*?|transparent) ([\d.]+)%/g)].map((x) => ({ c: x[1], at: Number(x[2]) }));
    const sus = segColor("suspect");
    const last = stops[stops.length - 1];
    assert.ok(last.c.startsWith(sus.slice(0, 20)), css);
    const solidFrom = stops.findIndex((st, i) => i > 0 && st.c.startsWith(sus.slice(0, 20)) && stops.slice(i).every((x) => x.c.startsWith(sus.slice(0, 20))));
    assert.ok(100 - stops[solidFrom].at >= (4 / 300) * 100 - 0.01, css);
  });

  test("runStart: the start of the current run, restarts and repeats ignored", () => {
    const pts = [
      { s: "ok", t: NOW - 20 * H },
      { s: "escalated", t: NOW - 90 * M },
      { s: "unavailable", t: NOW - 14 * M },
      { s: "escalated", t: NOW - 14 * M + 5000 },
      { s: "escalated", t: NOW - 10 * M },
    ];
    assert.equal(runStart(pts, "escalated"), NOW - 90 * M);
    assert.equal(runStart(pts, "ok"), null, "the points do not know this state yet");
    assert.equal(runStart([], "ok"), null);
  });
});

describe("sectionHtml: folded transitions", () => {
  const entry = { loaded: true, history: true, points: [
    { s: "ok", t: NOW - 5 * H }, { s: "suspect", t: NOW - 4 * H }, { s: "recovering", t: NOW - 3 * H },
    { s: "escalated", t: NOW - 2 * H }, { s: "ok", t: NOW - H },
  ] };
  test("few: the rest gets tl-x plus a +N button; all drops the fold", () => {
    const html = sectionHtml("sensor.x", entry, NOW, "en", { n: 4, few: 2, timeZone: "UTC" });
    assert.equal((html.match(/<li class="tl-x">/g) || []).length, 2);
    assert.match(html, /data-action="tl-more"[^>]*aria-label="Show 2 more changes"[^>]*>\+2</);
    const all = sectionHtml("sensor.x", entry, NOW, "en", { n: 4, few: 2, all: true, timeZone: "UTC" });
    assert.ok(!all.includes("tl-x") && !all.includes("tl-more\""));
    const de = sectionHtml("sensor.x", entry, NOW, "de", { n: 4, few: 2, timeZone: "UTC" });
    assert.match(de, /2 weitere Wechsel zeigen/);
    const none = sectionHtml("sensor.x", entry, NOW, "en", { n: 4, timeZone: "UTC" });
    assert.ok(!none.includes("tl-more\"") && !none.includes("tl-x"));
  });
});
