// Necromancer cards, served by the integration itself (frontend.py) and loaded on
// every page via frontend.add_extra_js_url; the sidebar panel loads the same
// module. Vanilla custom elements: no Lit, no build step (design §2).
//
// Look: soft state-coloured gradients, round icon bubbles, full pill buttons,
// round chips, spring-press and pulse micro-animations (all off under
// prefers-reduced-motion); compact and wider than tall, lists over the full
// width, an optional 24 h state timeline (necromancer-timeline.js).
//
// Elements (one file each, all in this folder):
//   necromancer-guard-card    necromancer-guard-card.js    design §4/§5
//   necromancer-guards-card   necromancer-guards-card.js   design §6
//   necromancer-poe-card      necromancer-poe-card.js      design §7
//   necromancer-panel         necromancer-panel.js         design §8
// Shared: necromancer-base.js (texts, tokens, helpers), necromancer-recovery.js
// (recovery popup), necromancer-core.js (pure logic), necromancer-actions.js (service calls,
// toasts, panel settings), necromancer-timeline.js (24 h history).

// Every module is imported with this module's own query: the `?v=<version>` of
// the entry URL then reaches all sub-modules. The static path is served without
// cache headers, and a bare URL could keep an old module in the browser cache
// next to a new one after an update (design §10).
const Q = new URL(import.meta.url).search;
const { TAGS, actions } = await import(`./necromancer-base.js${Q}`);
await import(`./necromancer-guard-card.js${Q}`);
await import(`./necromancer-guards-card.js${Q}`);
await import(`./necromancer-poe-card.js${Q}`);
await import(`./necromancer-panel.js${Q}`);

const DOCS = "https://github.com/MrTomRocker/homeassistant-necromancer";

window.customCards = window.customCards || [];
for (const [type, name, description] of [
  [TAGS.guard, "Necromancer Guard", "One guard: state, main value, chips, last event, actions and an optional 24 h timeline."],
  [TAGS.guards, "Necromancer Guards", "All or filtered guards, problems first, with counts, search and bulk actions."],
  [TAGS.poe, "Necromancer PoE ports", "PoE ports: what is connected, which guard uses it, last restart, restart button."],
]) {
  if (!window.customCards.some((c) => c.type === type)) {
    window.customCards.push({ type, name, description, preview: type !== TAGS.poe, documentationURL: DOCS });
  }
}

export { TAGS, actions };
