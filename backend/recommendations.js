// Doner Bros — suggests a drink and fries when the cart has neither, only from the live menu that
// menu-tool.getOrderableMenu reads through the menu service. Each kind is offered once per chat: the
// server can't tell whether a customer said no, so once offered it is never offered again.

const MAX_SUGGESTIONS = 2;

// Categories are matched by slug, the stable key in menu_categories. Names and labels are checked as
// well because a deal's "1 Fries" may link to no item, and "Doner Box with Fries" already has fries.
const ADD_ONS = [
  { kind: "drink", slug: "drinks", mentioned: /\b(drinks?|water)\b/i, reason: "goes well with the order and there's no drink yet" },
  { kind: "fries", slug: "fries", mentioned: /\bfries\b/i, reason: "goes well with the order and there are no fries yet" },
];

function isSuggestable(item) {
  return (
    item && typeof item.id === "string" && typeof item.name === "string" &&
    Number.isInteger(item.pricePaisa) && item.pricePaisa > 0 && item.isAvailable !== false
  );
}

function categoryItems(categories, slug) {
  const category = categories.find((c) => c.slug === slug);
  return category && Array.isArray(category.items) ? category.items : null;
}

function cartHas(addOn, cartItems, categories) {
  const inCategory = new Set((categoryItems(categories, addOn.slug) || []).map((item) => item.id));
  return cartItems.some((item) => {
    const texts = [item.name, ...(item.contains || [])];
    const ids = [item.id, ...(item.containsItemIds || [])];
    return ids.some((id) => inCategory.has(id)) || texts.some((text) => addOn.mentioned.test(text));
  });
}

// Returns [{ itemId, name, pricePaisa, reason }] and records the kinds offered in state.
function suggestItems(state, menu) {
  if (!Array.isArray(state.items) || state.items.length === 0) return [];
  const categories = menu && Array.isArray(menu.categories) ? menu.categories : [];
  const byId = new Map(categories.flatMap((c) => (Array.isArray(c.items) ? c.items : [])).map((item) => [item.id, item]));
  const cartItems = state.items.map((line) => byId.get(line.item_id)).filter(Boolean);
  if (ADD_ONS.some((addOn) => cartHas(addOn, cartItems, categories))) return [];

  const cartIds = new Set(state.items.map((line) => line.item_id));
  const offered = state.suggestionsOffered || (state.suggestionsOffered = []);
  const suggestions = [];
  for (const { kind, slug, reason } of ADD_ONS) {
    if (suggestions.length >= MAX_SUGGESTIONS || offered.includes(kind)) continue;
    const items = categoryItems(categories, slug);
    // Said out loud, so a renamed category can't quietly switch suggestions off again.
    if (!items) console.warn(`Suggestions: the menu has no "${slug}" category.`);
    const item = (items || []).find((candidate) => isSuggestable(candidate) && !cartIds.has(candidate.id));
    if (!item) continue;
    offered.push(kind);
    suggestions.push({ itemId: item.id, name: item.name, pricePaisa: item.pricePaisa, reason });
  }
  return suggestions;
}

module.exports = { MAX_SUGGESTIONS, suggestItems };
