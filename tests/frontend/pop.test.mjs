// The popover (necromancer-base.js Pop) and a scroll while it is open.
//
// Root cause of the "Copy URL" smoke miss (round 2): the menu closed on ANY
// scroll event and emptied itself. In the chained smoke the ping's toast was
// still up when the ⋮ menu opened; Playwright's click on the "Copy URL" item
// retried with a small scroll-into-view, the scroll closed the menu, and the
// item never came back (30 s timeout). Standalone runs had no toast, so no
// scroll. The same 2 px nudge comes from a touch jitter or a live re-render of
// a card above. Now the menu follows its trigger and closes only when the
// trigger leaves the viewport. This test replays the sequence on a fake DOM.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

let Pop;
const listeners = { window: new Map(), document: new Map() };
const on = (where) => (type, fn) => listeners[where].set(type, fn);
const off = (where) => (type) => listeners[where].delete(type);

before(async () => {
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { get: () => undefined, define: () => {} };
  globalThis.window = { innerWidth: 1280, innerHeight: 900, addEventListener: on("window"), removeEventListener: off("window") };
  globalThis.document = { addEventListener: on("document"), removeEventListener: off("document") };
  ({ Pop } = await import("../../custom_components/necromancer/frontend/necromancer-base.js?v=test"));
});

function fixture() {
  const rect = { top: 400, bottom: 436, left: 1000, right: 1036, width: 36, height: 36 };
  const item = { getAttribute: () => "url", focus() {} };
  const anchor = { dataset: { anchor: "more" }, setAttribute() {}, getBoundingClientRect: () => ({ ...rect }) };
  const el = {
    hidden: true,
    style: {},
    offsetWidth: 220,
    offsetHeight: 190,
    _html: "",
    set innerHTML(v) {
      this._html = v;
    },
    get innerHTML() {
      return this._html;
    },
    querySelector: (sel) => (sel.includes("menuitem") && el._html ? item : null),
    querySelectorAll: () => [],
    contains: () => false,
  };
  const host = {
    shadowRoot: {
      activeElement: null,
      querySelector: (sel) => (sel === '[data-anchor="more"]' ? anchor : null),
      querySelectorAll: (sel) => (sel === "[data-anchor]" ? [anchor] : []),
    },
  };
  const pop = new Pop(host, el);
  return { pop, el, rect };
}

describe("popover: scroll while open", () => {
  test("a small scroll keeps the menu (and its items) and moves it with the trigger", () => {
    const { pop, el, rect } = fixture();
    pop.open("menu", "more", () => '<button role="menuitem" data-action="url">Copy URL</button>');
    assert.equal(el.style.top, "444px");
    // The 2 px nudge of a click retry / touch jitter / re-render above.
    rect.top -= 2;
    rect.bottom -= 2;
    listeners.window.get("scroll")();
    assert.ok(pop.state, "still open");
    assert.ok(el.innerHTML.includes('data-action="url"'), "the item is still there");
    assert.equal(el.style.top, "442px", "follows the trigger");
    listeners.window.get("resize")();
    assert.ok(pop.state, "a resize repositions too");
    pop.close();
  });

  test("the menu closes once its trigger scrolled out of the viewport", () => {
    const { pop, el, rect } = fixture();
    pop.open("menu", "more", () => '<button role="menuitem" data-action="url">Copy URL</button>');
    rect.top = -60;
    rect.bottom = -24;
    listeners.window.get("scroll")();
    assert.equal(pop.state, null);
    assert.equal(el.hidden, true);
    assert.equal(listeners.window.has("scroll"), false, "listeners removed");
  });

  test("a trigger that vanished (re-render without it) closes the menu", () => {
    const { pop } = fixture();
    pop.open("menu", "more", () => "<button role=\"menuitem\">x</button>");
    pop.host.shadowRoot.querySelector = () => null;
    listeners.window.get("scroll")();
    assert.equal(pop.state, null);
  });
});
