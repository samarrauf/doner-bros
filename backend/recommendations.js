// Doner Bros — picks at most two add-on suggestions for the current cart, only from menu.json.
// Each kind of suggestion (a drink, a side, a main) is offered once per chat: the server can't
// tell whether a customer said no, so once offered it is never offered again.

const MAX_SUGGESTIONS = 2;
const MAIN_CATEGORIES = ["Doners & Wraps", "Plates", "Boxes"];

function kindOf(category) {
  if (MAIN_CATEGORIES.includes(category)) return "main";
  if (category === "Drinks") return "drink";
  if (category === "Sides") return "side";
  return null;
}

function isSuggestable(item) {
  return (
    item && typeof item.id === "string" && typeof item.name === "string" &&
    Number.isInteger(item.pricePaisa) && item.pricePaisa > 0 && item.availability !== "unavailable"
  );
}

// Bestsellers first; for an all-vegetarian cart, vegetarian items first. Otherwise menu order.
function pickFrom(candidates, preferVegetarian) {
  const score = (item) => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return (preferVegetarian && tags.includes("Vegetarian") ? 2 : 0) + (tags.includes("Bestseller") ? 1 : 0);
  };
  return candidates.reduce((best, item) => (best === null || score(item) > score(best) ? item : best), null);
}

// Returns [{ itemId, name, pricePaisa, reason }] and records the kinds offered in state.
function suggestItems(state, menu) {
  if (!Array.isArray(state.items) || state.items.length === 0) return [];
  const categories = menu && Array.isArray(menu.categories) ? menu.categories : [];
  const allItems = categories.flatMap((c) => (Array.isArray(c.items) ? c.items : [])).filter(isSuggestable);
  const byId = new Map(allItems.map((item) => [item.id, item]));

  const cartItems = state.items.map((line) => byId.get(line.itemId)).filter(Boolean);
  const cartKinds = new Set(cartItems.map((item) => kindOf(item.category)));
  const cartIds = new Set(state.items.map((line) => line.itemId));
  const cartMains = cartItems.filter((item) => kindOf(item.category) === "main");
  const vegetarianCart = cartMains.length > 0 && cartMains.every((item) => (item.tags || []).includes("Vegetarian"));

  const wanted = cartKinds.has("main")
    ? [["drink", "goes well with the order and there's no drink yet"], ["side", "a side to go with the order"]]
    : [["main", "the cart has no main dish yet"]];

  const offered = state.suggestionsOffered || (state.suggestionsOffered = []);
  const suggestions = [];
  for (const [kind, reason] of wanted) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (cartKinds.has(kind) || offered.includes(kind)) continue;
    const candidates = allItems.filter((item) => kindOf(item.category) === kind && !cartIds.has(item.id));
    const item = pickFrom(candidates, vegetarianCart);
    if (!item) continue;
    offered.push(kind);
    suggestions.push({ itemId: item.id, name: item.name, pricePaisa: item.pricePaisa, reason });
  }
  return suggestions;
}

module.exports = { MAX_SUGGESTIONS, suggestItems };
